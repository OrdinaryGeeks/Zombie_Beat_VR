import {
  Color, ConeGeometry, CylinderGeometry, DoubleSide, Mesh, MeshBasicMaterial, RingGeometry, SphereGeometry,
  BoxGeometry, Vector3, createSystem,
} from '@iwsdk/core';
import { Actor, Effect, LevelPiece, Pickup, Projectile } from '../components.js';
import { GAME } from '../content/game.js';
import { playAttackEffect } from '../cues.js';
import { createLootMesh, createProjectileModel } from '../models.js';
import {
  areFactionsHostile, factionOf, handicapStep, hitDamage, isAttackable, mitigate, rollLoot, stunSeconds,
} from '../rules.js';
import { emit, run } from '../state.js';
import { LevelSystem } from './LevelSystem.js';
import { PlayerSystem } from './PlayerSystem.js';

const FALLBACK_ATTACK = {
  key: 'fists', delivery: 'melee', maxRangeMeters: 2, areaRadiusMeters: 0, maxTargets: 1,
  cooldownSeconds: 0.6, scalerCoefficientPct: 100, projectileSpeedMetersPerSecond: 18,
  primitive: 'sphere', primitiveColorHex: '#f8fafc', primitiveScale: 1, stunPower: 0,
};

const flat = new Vector3();
const toTarget = new Vector3();
const tmp = new Vector3();

/** An attack row by key, or the bare-handed swing. */
export function attackOf(key) {
  return (key && GAME.attacks[key]) || FALLBACK_ATTACK;
}

/** A ray that stays: a ranged `linear` attack with `timerMode: 'lingering'` (`castRay`). */
export function isRay(attack) {
  return attack.shape === 'linear' && attack.timerMode === 'lingering' && attack.delivery !== 'melee';
}

/**
 * Every hit in the game goes through here: the player's swings and shots, the cast's, projectiles
 * in flight, deaths, and the loot a death drops.
 */
export class CombatSystem extends createSystem({
  actors: { required: [Actor] },
  projectiles: { required: [Projectile] },
  effects: { required: [Effect] },
  pickups: { required: [Pickup] },
}) {
  init() {
    this.playerCooldown = 0;
    /** Rays still standing (`castRay`). */
    this.rays = [];
    /** Drops are numbered so players in one room can agree which is which (`userData.netId`). */
    this.dropIds = 0;
  }

  // ── The player ──────────────────────────────────────────────────────────────────────────────

  playerAttack() {
    if (this.playerCooldown > 0) return;
    const attack = attackOf(run.weapon.attackKey);
    this.playerCooldown = Math.max(0.25, attack.cooldownSeconds || 0.6);
    const damage = hitDamage(run.weapon.dps, attack);
    const { origin, direction } = this.world.getSystem(PlayerSystem).getAim();

    if (attack.delivery === 'melee') {
      this.meleeFrom(origin, direction, attack, damage, 'player');
    } else {
      this.fireProjectile(origin, direction, attack, damage, 'player');
    }
  }

  damagePlayer(amount) {
    // Zero is a hit drawn for a guest (playing together), which the host lands for real.
    if (run.phase !== 'playing' || !(amount > 0)) return;
    run.health = Math.max(0, run.health - mitigate(amount, run.mitigation ?? GAME.player.mitigation));
    emit('player-hurt', { amount });
  }

  // ── The cast ────────────────────────────────────────────────────────────────────────────────

  /**
   * One actor attacks a point (the player, or another actor's position) with one of its attacks,
   * its first when none is named. A dash is not fired here: `NpcSystem` runs it, hitting through
   * `dashHit` as it goes.
   *
   * `drawOnly` fires it for the look alone, at no damage: a guest playing together drawing an attack
   * the host made (`actor-attack`, relayed by the game's net code). Every real one is announced.
   */
  actorAttack(entity, targetPosition, attack = attackOf(entity.object3D.userData.entity.attackKeys[0]), { drawOnly = false } = {}) {
    const row = entity.object3D.userData.entity;
    const damage = drawOnly ? 0 : hitDamage(row.dps, attack);
    if (!drawOnly) emit('actor-attack', { entity, attack, target: targetPosition });
    const origin = entity.object3D.position.clone();
    origin.y += row.height * 0.6;
    const direction = targetPosition.clone().sub(origin).normalize();
    const faction = factionOf(row.role);
    if (attack.delivery === 'melee') this.meleeFrom(origin, direction, attack, damage, faction, entity);
    else if (isRay(attack)) this.castRay(origin, direction, attack, damage, faction, entity);
    else this.fireProjectile(origin, direction, attack, damage, faction);
    return attack;
  }

  /**
   * One frame of a dash: everything hostile to `faction` within `radius` of the runner at `at`, not
   * already in `alreadyHit`, is hit once. Game Foundry's is `CombatSystem.stepDash`.
   */
  dashHit(at, radius, attack, damage, faction, attacker, alreadyHit) {
    if (faction !== 'player' && areFactionsHostile(faction, 'player')) {
      const playerFeet = this.world.getSystem(PlayerSystem).getFeet(tmp);
      if (!alreadyHit.has('player') && Math.hypot(playerFeet.x - at.x, playerFeet.z - at.z) <= radius + 0.3) {
        alreadyHit.add('player');
        this.damagePlayer(damage);
      }
      for (const other of this.world.net?.players() ?? []) {
        if (alreadyHit.has(other.id) || Math.hypot(other.position.x - at.x, other.position.z - at.z) > radius + 0.3) continue;
        alreadyHit.add(other.id);
        this.world.net.hitPlayer(other.id, damage);
      }
    }
    for (const entity of this.queries.actors.entities) {
      if (entity === attacker || alreadyHit.has(entity) || entity.getValue(Actor, 'state') === 'dead') continue;
      const row = entity.object3D.userData.entity;
      if (!isAttackable(row.role) || !areFactionsHostile(faction, factionOf(row.role))) continue;
      const p = entity.object3D.position;
      if (Math.hypot(p.x - at.x, p.z - at.z) > radius + 0.35) continue;
      alreadyHit.add(entity);
      this.damageActor(entity, damage, attack.stunPower);
    }
  }

  // ── Delivery ────────────────────────────────────────────────────────────────────────────────

  /**
   * A swing: everything hostile to `faction` within reach and inside a 120° arc ahead, nearest
   * first, up to the attack's target cap (0 = no cap). An area attack hits all round instead.
   */
  meleeFrom(origin, direction, attack, damage, faction, attacker = null, by = null) {
    const reach = Math.max(1.5, attack.maxRangeMeters || 2) + 0.4;
    const area = attack.areaRadiusMeters > 0;
    flat.set(direction.x, 0, direction.z).normalize();
    const targets = [];

    for (const entity of this.queries.actors.entities) {
      if (entity === attacker || entity.getValue(Actor, 'state') === 'dead') continue;
      const row = entity.object3D.userData.entity;
      if (!isAttackable(row.role) || !areFactionsHostile(faction, factionOf(row.role))) continue;
      toTarget.subVectors(entity.object3D.position, origin).setY(0);
      const distance = toTarget.length();
      if (distance > (area ? Math.max(reach, attack.areaRadiusMeters) : reach)) continue;
      if (!area && distance > 0.5 && toTarget.normalize().dot(flat) < 0.5) continue;
      targets.push({ entity, distance });
    }

    const playerFeet = this.world.getSystem(PlayerSystem).getFeet(tmp);
    if (faction !== 'player' && areFactionsHostile(faction, 'player')) {
      toTarget.subVectors(playerFeet, origin).setY(0);
      if (toTarget.length() <= reach) this.damagePlayer(damage);
      // Playing together: the other players are in reach of the same swing.
      for (const other of this.world.net?.players() ?? []) {
        toTarget.subVectors(other.position, origin).setY(0);
        if (toTarget.length() <= reach) this.world.net.hitPlayer(other.id, damage);
      }
    }

    targets.sort((a, b) => a.distance - b.distance);
    const cap = attack.maxTargets > 0 ? attack.maxTargets : targets.length;
    for (const { entity } of targets.slice(0, cap)) this.damageActor(entity, damage, attack.stunPower, by);

    const at = origin.clone().addScaledVector(flat, area ? 0 : reach * 0.6);
    // An attack with a designed effect plays that instead of the ring (`../cues.js`).
    if (!playAttackEffect(this.world.scene, attack, at, flat)) this.spawnEffect(at, attack, area ? attack.areaRadiusMeters || reach : 0.6);
  }

  /** `by`: when playing together, the remote player this is fired for (see `kill`). */
  fireProjectile(origin, direction, attack, damage, owner, by = null) {
    // The game's own look for this shot (`setProjectileModel`), else the attack's primitive.
    const mesh = createProjectileModel(attack) ?? new Mesh(
      this.geometryFor(attack.primitive, 0.15 * (attack.primitiveScale || 1)),
      new MeshBasicMaterial({ color: new Color(attack.primitiveColorHex || '#fde047') }),
    );
    mesh.position.copy(origin).addScaledVector(direction, 0.5);
    const speed = attack.projectileSpeedMetersPerSecond || 18;
    const range = Math.max(4, attack.maxRangeMeters || 20);
    this.world.createTransformEntity(mesh).addComponent(LevelPiece).addComponent(Projectile, {
      owner, damage, speed, radius: 0.5 + (attack.areaRadiusMeters || 0) * 0.5,
      dirX: direction.x, dirY: direction.y, dirZ: direction.z,
      life: range / speed, stunPower: attack.stunPower || 0, by: by ?? '',
    });
  }

  /**
   * A ray that stays (`isRay`): a beam from `origin` down the attack's whole reach toward where it
   * was aimed, pinned there however the caster moves after. It shows faintly through the windup —
   * the warning — and then, for `durationSeconds`, bites everything hostile standing in it every
   * `tickIntervalSeconds`, the player included. Game Foundry's is `isRay` in
   * `game/shell/AttackRunner.ts`; the two read the same row fields.
   */
  castRay(origin, direction, attack, damage, faction, attacker = null) {
    const dir = new Vector3(direction.x, 0, direction.z).normalize();
    const length = Math.max(1, attack.maxRangeMeters || 12);
    const width = Math.max(0.3, attack.widthMeters || 1);
    // Narrow at the mouth and widening along its reach, the way a scream spreads.
    const geometry = new CylinderGeometry(width * 0.15, width * 0.5, length, 16, 1, true)
      .rotateX(Math.PI / 2).translate(0, 0, length / 2);
    const mesh = new Mesh(geometry, new MeshBasicMaterial({
      color: new Color(attack.primitiveColorHex || '#a3e635'),
      transparent: true, opacity: 0.12, depthWrite: false, side: DoubleSide,
    }));
    mesh.position.copy(origin);
    mesh.lookAt(origin.x + dir.x, origin.y, origin.z + dir.z);
    const entity = this.world.createTransformEntity(mesh).addComponent(LevelPiece);
    this.rays.push({
      entity, start: origin.clone(), dir, length, width, damage, faction, attacker,
      stunPower: attack.stunPower || 0,
      windup: attack.windupSeconds || 0,
      life: Math.max(0.2, attack.durationSeconds || 1),
      interval: Math.max(0.1, attack.tickIntervalSeconds || 0.5),
      tickIn: 0,
    });
  }

  /** Advances every ray: the windup, then a bite on each interval, then gone. */
  stepRays(delta) {
    for (let i = this.rays.length - 1; i >= 0; i--) {
      const ray = this.rays[i];
      // The level it was cast in has gone, and took the beam's entity with it.
      if (!ray.entity.object3D) {
        this.rays.splice(i, 1);
        continue;
      }
      const material = ray.entity.object3D.material;
      if (ray.windup > 0) {
        ray.windup -= delta;
        continue;
      }
      ray.life -= delta;
      ray.tickIn -= delta;
      if (ray.tickIn <= 0) {
        ray.tickIn = ray.interval;
        this.rayHit(ray);
      }
      material.opacity = 0.45 + Math.sin(ray.life * 30) * 0.15;
      if (ray.life <= 0) {
        ray.entity.dispose();
        this.rays.splice(i, 1);
      }
    }
  }

  /** One bite of a ray: everything hostile to its caster within its half-width of the beam's line. */
  rayHit(ray) {
    if (ray.damage <= 0) return;
    const inBeam = (p, body) => {
      const along = (p.x - ray.start.x) * ray.dir.x + (p.z - ray.start.z) * ray.dir.z;
      if (along < 0 || along > ray.length) return false;
      const across = Math.abs((p.x - ray.start.x) * ray.dir.z - (p.z - ray.start.z) * ray.dir.x);
      return across <= ray.width * 0.5 + body;
    };
    if (ray.faction !== 'player' && areFactionsHostile(ray.faction, 'player')) {
      if (inBeam(this.world.getSystem(PlayerSystem).getFeet(tmp), 0.3)) this.damagePlayer(ray.damage);
      for (const other of this.world.net?.players() ?? []) {
        if (inBeam(other.position, 0.3)) this.world.net.hitPlayer(other.id, ray.damage);
      }
    }
    for (const entity of this.queries.actors.entities) {
      if (entity === ray.attacker || entity.getValue(Actor, 'state') === 'dead') continue;
      const row = entity.object3D.userData.entity;
      if (!isAttackable(row.role) || !areFactionsHostile(ray.faction, factionOf(row.role))) continue;
      if (inBeam(entity.object3D.position, 0.35)) this.damageActor(entity, ray.damage, ray.stunPower);
    }
  }

  damageActor(entity, damage, stunPower = 0, by = null) {
    // A swing a guest draws lands nothing here: the host owns every zombie's health, and a zombie
    // already at zero on a guest's screen must not be killed (and credited) a second time.
    if (!(damage > 0)) return;
    const hp = entity.getValue(Actor, 'hp') - damage;
    entity.setValue(Actor, 'hp', hp);
    const row = entity.object3D.userData.entity;
    if (hp <= 0) {
      this.kill(entity, by);
      return;
    }
    const stun = stunSeconds(stunPower, row.archetype);
    if (stun > 0) entity.setValue(Actor, 'stunned', stun);
    // Being hit is a reason to fight back, whatever its standing orders say.
    if (entity.getValue(Actor, 'state') === 'idle') entity.setValue(Actor, 'state', 'chase');
    entity.object3D.userData.lastHit = performance.now();
  }

  /**
   * `by` is the remote player whose hit this was, when playing together: the kill still counts for
   * the level (everyone's objectives), but its XP and currency go to them (`world.net.creditKill`).
   */
  kill(entity, by = null) {
    const row = entity.object3D.userData.entity;
    entity.setValue(Actor, 'state', 'dead');
    entity.setValue(Actor, 'hp', 0);
    entity.object3D.userData.deadFor = 0;

    run.kills[row.key] = (run.kills[row.key] ?? 0) + 1;
    run.lifetimeKills[row.key] = (run.lifetimeKills[row.key] ?? 0) + 1;
    run.totalKills += 1;
    if (by && this.world.net?.creditKill) {
      this.world.net.creditKill(by, row);
    } else {
      run.gainXp(row.xpReward);
      if (row.currencyReward > 0) {
        run.currencies.gold = (run.currencies.gold ?? 0) + Math.round(row.currencyReward);
      }
    }
    emit('kill', { key: row.key, name: row.name, by });

    if (row.lootTableKey) {
      const firstKill = !run.rolledTables.has(row.lootTableKey);
      run.rolledTables.add(row.lootTableKey);
      // A raised row (`rules.js` `raised`) carries its handicap; its step says what the loot is worth.
      const rewards = handicapStep(row.handicap ?? 0)?.rewards ?? 1;
      const drops = rollLoot(row.lootTableKey, run.playerLevel, { firstKill, rewards });
      drops.forEach((drop, i) => {
        const angle = (i / Math.max(1, drops.length)) * Math.PI * 2;
        const at = entity.object3D.position.clone().add(new Vector3(Math.cos(angle) * 0.8, 0, Math.sin(angle) * 0.8));
        void this.dropLoot(drop.lootKey, drop.quantity, at);
      });
    }
  }

  async dropLoot(lootKey, quantity, position) {
    const item = GAME.loot[lootKey];
    if (!item) return;
    const mesh = await createLootMesh(item, quantity);
    // The kill that ends a level still drops what it drops: the loot grace is for collecting it.
    if (!run.canCollect()) return;
    const level = this.world.getSystem(LevelSystem);
    mesh.position.set(position.x, level ? level.groundHeight(position.x, position.z, position.y) : position.y, position.z);
    mesh.userData.baseY = mesh.position.y;
    mesh.userData.netId = ++this.dropIds;
    this.world.createTransformEntity(mesh).addComponent(LevelPiece).addComponent(Pickup, { lootKey, quantity });
  }

  // ── Visuals ─────────────────────────────────────────────────────────────────────────────────

  geometryFor(primitive, size) {
    switch (primitive) {
      case 'box': return new BoxGeometry(size * 2, size * 2, size * 2);
      case 'cone': return new ConeGeometry(size, size * 2.5, 12).rotateX(-Math.PI / 2);
      case 'cylinder': return new CylinderGeometry(size, size, size * 2.5, 12).rotateX(Math.PI / 2);
      case 'ring':
      case 'disc': return new RingGeometry(size * 0.5, size, 24);
      default: return new SphereGeometry(size, 16, 12);
    }
  }

  spawnEffect(position, attack, radius) {
    const mesh = new Mesh(
      new RingGeometry(Math.max(0.05, radius * 0.6), Math.max(0.1, radius), 32).rotateX(-Math.PI / 2),
      new MeshBasicMaterial({ color: new Color(attack.primitiveColorHex || '#f8fafc'), transparent: true, opacity: 0.8, depthWrite: false }),
    );
    mesh.position.copy(position);
    this.world.createTransformEntity(mesh).addComponent(LevelPiece).addComponent(Effect, { life: 0.25, maxLife: 0.25, grow: 1.6 });
  }

  // ── Frame ───────────────────────────────────────────────────────────────────────────────────

  update(delta) {
    this.playerCooldown = Math.max(0, this.playerCooldown - delta);
    this.stepRays(delta);
    const playerFeet = this.world.getSystem(PlayerSystem)?.getFeet(new Vector3());

    for (const entity of [...this.queries.projectiles.entities]) {
      const object = entity.object3D;
      const speed = entity.getValue(Projectile, 'speed');
      object.position.x += entity.getValue(Projectile, 'dirX') * speed * delta;
      object.position.y += entity.getValue(Projectile, 'dirY') * speed * delta;
      object.position.z += entity.getValue(Projectile, 'dirZ') * speed * delta;
      object.userData.tick?.(delta);
      const life = entity.getValue(Projectile, 'life') - delta;
      entity.setValue(Projectile, 'life', life);
      if (this.projectileHit(entity, playerFeet) || life <= 0) {
        object.userData.dispose?.();
        entity.dispose();
      }
    }

    for (const entity of [...this.queries.effects.entities]) {
      const life = entity.getValue(Effect, 'life') - delta;
      entity.setValue(Effect, 'life', life);
      const t = 1 - Math.max(0, life) / entity.getValue(Effect, 'maxLife');
      entity.object3D.scale.setScalar(1 + t * (entity.getValue(Effect, 'grow') - 1));
      entity.object3D.material.opacity = 0.8 * (1 - t);
      if (life <= 0) entity.dispose();
    }

    for (const entity of [...this.queries.pickups.entities]) {
      const age = entity.getValue(Pickup, 'age') + delta;
      entity.setValue(Pickup, 'age', age);
      const object = entity.object3D;
      object.rotation.y += delta * 1.5;
      object.position.y = object.userData.baseY + 0.1 + Math.sin(age * 3) * 0.08;
      if (playerFeet && run.canCollect() && Math.hypot(object.position.x - playerFeet.x, object.position.z - playerFeet.z) < 1.4) {
        run.addLoot(entity.getValue(Pickup, 'lootKey'), entity.getValue(Pickup, 'quantity'));
        entity.dispose({ disposeResources: false });
        continue;
      }
      // Playing together: another player walking over it collects it, and the host says so.
      if (!run.canCollect() || !this.world.net?.pickup) continue;
      for (const other of this.world.net.players()) {
        // A CPU bandmate is fought over like a player but picks nothing up.
        if (other.collects === false) continue;
        if (Math.hypot(object.position.x - other.position.x, object.position.z - other.position.z) >= 1.4) continue;
        this.world.net.pickup(other.id, entity.getValue(Pickup, 'lootKey'), entity.getValue(Pickup, 'quantity'));
        entity.dispose({ disposeResources: false });
        break;
      }
    }
  }

  projectileHit(entity, playerFeet) {
    const owner = entity.getValue(Projectile, 'owner');
    const radius = entity.getValue(Projectile, 'radius');
    const position = entity.object3D.position;
    const damage = entity.getValue(Projectile, 'damage');

    if (owner !== 'player' && playerFeet && areFactionsHostile(owner, 'player')) {
      const head = playerFeet.y + 1.2;
      if (Math.hypot(position.x - playerFeet.x, position.z - playerFeet.z) < radius + 0.3
        && position.y > playerFeet.y - 0.2 && position.y < head + 0.6) {
        this.damagePlayer(damage);
        return true;
      }
      for (const other of this.world.net?.players() ?? []) {
        const feetAt = other.position;
        if (Math.hypot(position.x - feetAt.x, position.z - feetAt.z) < radius + 0.3
          && position.y > feetAt.y - 0.2 && position.y < feetAt.y + 1.8) {
          this.world.net.hitPlayer(other.id, damage);
          return true;
        }
      }
    }
    for (const target of this.queries.actors.entities) {
      if (target.getValue(Actor, 'state') === 'dead') continue;
      const row = target.object3D.userData.entity;
      if (!isAttackable(row.role) || !areFactionsHostile(owner, factionOf(row.role))) continue;
      const p = target.object3D.position;
      if (Math.hypot(position.x - p.x, position.z - p.z) < radius + 0.35
        && position.y > p.y - 0.2 && position.y < p.y + row.height + 0.2) {
        this.damageActor(target, damage, entity.getValue(Projectile, 'stunPower'), entity.getValue(Projectile, 'by') || null);
        return true;
      }
    }
    return false;
  }
}
