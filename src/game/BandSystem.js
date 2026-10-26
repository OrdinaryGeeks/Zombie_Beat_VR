import {
  AssetManager, CanvasTexture, Color, CylinderGeometry, DoubleSide, Group, InputComponent, Mesh,
  MeshBasicMaterial, PlaneGeometry, RingGeometry, SRGBColorSpace, TorusGeometry, Vector3, createSystem,
} from '@iwsdk/core';
import { Actor, Effect, LevelPiece } from '../components.js';
import { GAME } from '../content/game.js';
import { VFX } from '../content/vfx.js';
import { createPerformer } from '../cues.js';
import { assetUrl } from '../models.js';
import { CAST } from './cast.js';
import { areFactionsHostile, factionOf, hitDamage, isAttackable } from '../rules.js';
import { emit, on, run } from '../state.js';
import { CombatSystem, attackOf } from '../systems/CombatSystem.js';
import { PlayerSystem } from '../systems/PlayerSystem.js';
import { Groove } from './audio.js';
import { band, createInstrument } from './band.js';
import { SINGER_BOLT } from './lightning.js';
import { StageSystem } from './StageSystem.js';
import {
  BPM, GRADE_DAMAGE, ROLES, ULTIMATES, chargeUltimate, inLine, instrumentFor, nextRole, roleByKey, scorePress,
  ultimateDamage, ultimateReady,
} from './rules.js';
import { UltPanel } from './ultPanel.js';

/**
 * Extra turn on a kit, on top of facing its drummer. The prop's playing side is its -Z, so zero is
 * right for it; turn this if a different kit model disagrees.
 */
const KIT_TURN = 0;
/** How far in front of its drummer a kit stands, in metres. */
const KIT_DISTANCE = 1.1;
/** How far a drummer may look away from their kit before it turns to follow. Radians. */
const KIT_FOLLOW_AFTER = 1.0;
/** The key for this player's own kit; other players' and CPU bandmates' are their ids. */
const MY_KIT = '';
/** Under a beat, so a player can hit every beat at 112 bpm. */
const BAND_COOLDOWN = 0.38;

/** Where this player's cued effects come from: in the right grip, or where the instrument is drawn. */
const HAND_IN_GRIP = new Vector3(0, 0, 0);
const HAND_IN_VIEW = new Vector3(0.32, -0.32, -0.7);

const flat = new Vector3();
const huntFeet = new Vector3();
const kitFeet = new Vector3();
const look = new Vector3();
const hex = (colour) => `#${colour.toString(16).padStart(6, '0')}`;

/**
 * Who the player is in the band, what they hold, and what a press on the beat does.
 *
 * ## The attack
 *
 * The template's attack (click / F, the right trigger, a pinch) still arrives through
 * `PlayerSystem`; this system takes over what it does. The press is judged against the beat, and
 * the role decides the shape: the guitarist swings a wide cone, the drummer sends a shockwave all
 * round the kit, the singer fires a beam of notes, the dancer spins. On the beat it lands harder
 * (`GRADE_DAMAGE`), off it softer. Damage still comes from the weapon the player holds
 * (`run.weapon.dps`) and the content attack the role plays through, via `hitDamage`, so a better
 * instrument picked up from a zombie still matters.
 *
 * ## The ultimate
 *
 * The second button. On-beat presses fill a meter (`chargeUltimate`); once it is full the role's
 * ultimate (`ULTIMATES` in `rules.js`) lands several of its hits at once, harder again when the
 * press itself is on the beat. In a headset: point either hand at the floating ULTIMATE panel low
 * on the left and pull the trigger (or pinch), or pull the left trigger anywhere. On a flat
 * screen: E, or the ULTIMATE button. A guest's goes to the host like a swing (`band-ultimate`).
 *
 * ## The kit
 *
 * Every drummer, this player, another or a CPU bandmate, has a kit on the ground in front of them
 * that goes where they go and turns to follow them once they look well away from it.
 *
 * ## The instruments
 *
 * Each role's own, unless the active character wears that role's classic in the main hand
 * (`band.mainHand`, `instrumentFor`): then the classic. Watched every frame, so wearing or taking
 * one off at Band HQ swaps it. Other players and CPU bandmates play their role's own.
 *
 * ## Changing role
 *
 * Any time, without stopping: 1-4 or R on a keyboard, the role buttons bottom-left, or B / Y on a
 * controller. The horde keeps coming while you choose. Under the roster (`HqSystem`) the role is the
 * active character's instead, chosen at Band HQ, and those inputs do nothing.
 */
export class BandSystem extends createSystem({}) {
  init() {
    this.groove = new Groove(BPM);
    this.cooldown = 0;
    this.generation = 0;
    this.handProp = null;
    /** What this player's role is drawn as, and the main-hand key it was chosen from. */
    this.instrument = null;
    this.mainHandSeen = null;
    /** One kit entity per drummer, and each one's yaw. */
    this.kits = new Map();
    this.kitYaw = new Map();
    this.kitsLoading = new Set();
    this.kitGeneration = 0;
    /** Dancers' auras still ticking: this player's own, and on the host, guests'. */
    this.auras = [];
    this.lastNotReadyAt = -Infinity;
    this.ultPanel = new UltPanel(this.world, this.scene, this.camera);
    this.cleanupFuncs.push(() => this.ultPanel.dispose());
    /** This player's own performance, for the effects cued on their role's take (`../cues.js`). */
    this.performer = createPerformer();
    /** Each role's take, as the band's cast carries it: `{ file, seconds }`, or absent. */
    this.roleTakes = new Map();
    void this.loadRoleTakes();

    // Take over the player's attack. `PlayerSystem` calls this on every press.
    const combat = this.world.getSystem(CombatSystem);
    this.combat = combat;
    combat.playerAttack = () => this.attack();

    // A gesture the browser will start audio from: any key or click, or entering VR.
    const start = () => this.groove.start();
    window.addEventListener('keydown', start);
    window.addEventListener('pointerdown', start);
    this.renderer.xr.addEventListener('sessionstart', start);
    this.cleanupFuncs.push(() => {
      window.removeEventListener('keydown', start);
      window.removeEventListener('pointerdown', start);
    });

    this.buildPicker();
    this.buildPanel();
    this.buildBoard();
    this.buildUltButton();

    this.cleanupFuncs.push(
      // The level change disposes the kit with every other LevelPiece.
      on('level-loading', () => {
        // The level change disposes the kits with every other LevelPiece.
        this.kits.clear();
        this.kitYaw.clear();
        this.kitsLoading.clear();
        this.kitGeneration++;
        this.auras = [];
        band.staged = false;
      }),
      on('level-start', () => {
        void this.setRole(band.role, true);
        this.world.getSystem(StageSystem)?.goHome();
      }),
      on('band-breach', () => this.groove.breach()),
    );
  }

  // ── roles and props ─────────────────────────────────────────────────────────────────────────

  async setRole(key, force = false) {
    if (key === band.role && !force) return;
    band.role = key;
    const role = roleByKey(key);
    const mine = ++this.generation;
    this.drawPicker();

    this.handProp?.removeFromParent();
    this.handProp = null;

    this.mainHandSeen = band.mainHand;
    this.instrument = instrumentFor(key, band.mainHand);
    this.dropMyKit();

    if (role.mount !== 'hand' || !band.staged || !this.instrument) return;
    const prop = await createInstrument(this.instrument, { held: true });
    if (mine !== this.generation) return;
    this.handProp = prop;
    this.mountHandProp();
  }

  /**
   * In a headset the instrument is in the right hand. On a flat screen it sits in view, bottom
   * right, the way a first-person game shows what you are holding.
   */
  mountHandProp() {
    const prop = this.handProp;
    if (!prop) return;
    const grip = this.world.playerSpaceEntities?.gripSpaces?.right?.object3D;
    if (this.world.session && grip) {
      if (prop.parent !== grip) grip.add(prop);
      prop.position.set(0, 0, 0);
      prop.rotation.set(-Math.PI / 2, 0, 0);
      prop.scale.setScalar(1);
    } else {
      if (prop.parent !== this.camera) this.camera.add(prop);
      const role = roleByKey(band.role);
      prop.position.set(0.32, -0.32, -0.7);
      prop.rotation.set(0.2, -0.5, role.key === 'guitarist' ? -0.9 : 0);
      prop.scale.setScalar(role.key === 'guitarist' ? 0.7 : 1);
    }
  }

  /** Every drummer in the band, with where they stand and the way they face. */
  drummers() {
    const out = [];
    if (band.role === 'drummer') {
      this.world.getSystem(PlayerSystem).getFeet(kitFeet);
      this.camera.getWorldDirection(look);
      out.push({ id: MY_KIT, position: kitFeet.clone(), yaw: Math.atan2(look.x, look.z) });
    }
    for (const [id, role] of band.remoteRoles) {
      if (role !== 'drummer') continue;
      const body = this.bodyOf(id);
      if (!body || !body.group.visible) continue;
      out.push({ id, position: body.group.position, yaw: body.group.rotation.y });
    }
    return out;
  }

  /** Another player's or a CPU bandmate's avatar, by id. */
  bodyOf(id) {
    return this.world.net?.body?.(id) ?? null;
  }

  /** A kit in front of every drummer, carried with them. */
  syncKits() {
    const drummers = band.staged ? this.drummers() : [];
    const wanted = new Set(drummers.map((d) => d.id));
    for (const [id, kit] of this.kits) {
      if (wanted.has(id)) continue;
      kit.dispose({ disposeResources: false });
      this.kits.delete(id);
      this.kitYaw.delete(id);
    }
    for (const drummer of drummers) {
      const kit = this.kits.get(drummer.id);
      if (kit) {
        this.placeKit(kit.object3D, drummer);
        continue;
      }
      if (this.kitsLoading.has(drummer.id)) continue;
      this.kitsLoading.add(drummer.id);
      const mine = this.kitGeneration;
      const instrument = drummer.id === MY_KIT ? this.instrument : instrumentFor('drummer', null);
      if (!instrument) {
        this.kitsLoading.delete(drummer.id);
        continue;
      }
      void createInstrument(instrument).then((prop) => {
        this.kitsLoading.delete(drummer.id);
        if (mine !== this.kitGeneration || this.kits.has(drummer.id) || !band.staged) return;
        this.placeKit(prop, drummer);
        this.kits.set(drummer.id, this.world.createTransformEntity(prop).addComponent(LevelPiece));
      });
    }
  }

  /** Drops this player's kit, so the next frame stands the one they now play. */
  dropMyKit() {
    this.kits.get(MY_KIT)?.dispose({ disposeResources: false });
    this.kits.delete(MY_KIT);
    this.kitYaw.delete(MY_KIT);
    // A kit still loading was for the old instrument; the bump keeps it from landing.
    this.kitGeneration++;
    this.kitsLoading.clear();
  }

  /** Re-picks this player's instrument when what the character wears in the main hand changes. */
  watchMainHand() {
    if (band.mainHand === this.mainHandSeen) return;
    this.mainHandSeen = band.mainHand;
    if (instrumentFor(band.role, band.mainHand)?.prop === this.instrument?.prop) return;
    void this.setRole(band.role, true);
  }

  /**
   * Stands a kit on the ground in front of its drummer, its playing side towards them. The kit's
   * yaw follows the drummer's lazily, so looking round from the stool does not spin the kit.
   */
  placeKit(object, { id, position, yaw }) {
    let kitYaw = this.kitYaw.get(id) ?? yaw;
    const off = Math.atan2(Math.sin(yaw - kitYaw), Math.cos(yaw - kitYaw));
    if (Math.abs(off) > KIT_FOLLOW_AFTER) kitYaw += off - Math.sign(off) * KIT_FOLLOW_AFTER;
    this.kitYaw.set(id, kitYaw);
    object.position.set(
      position.x + Math.sin(kitYaw) * KIT_DISTANCE,
      position.y,
      position.z + Math.cos(kitYaw) * KIT_DISTANCE,
    );
    object.rotation.y = kitYaw + KIT_TURN;
  }

  // ── the attack ──────────────────────────────────────────────────────────────────────────────

  attack() {
    if (run.phase !== 'playing') return;
    // A trigger or pinch aimed at the ULTIMATE panel is the ultimate, not a swing.
    const rightTrigger = Boolean(this.input.gamepads.right?.getButtonDown(InputComponent.Trigger));
    if (this.world.session && this.ultPanel.aimed(rightTrigger ? 'right' : undefined)) {
      this.unleash();
      return;
    }
    if (this.cooldown > 0) return;
    this.cooldown = BAND_COOLDOWN;
    this.groove.start();

    const judgement = band.clock.judge(this.groove.now());
    band.performance = scorePress(band.performance, judgement.grade);
    band.ultCharge = chargeUltimate(band.ultCharge, judgement.grade);
    band.lastGrade = judgement.grade;
    band.lastGradeAt = band.beatTime;

    const role = roleByKey(band.role);
    const damage = this.damageFor(role.key, run.weapon, judgement.grade);
    const player = this.world.getSystem(PlayerSystem);
    const { origin, direction } = player.getAim();
    const feet = player.getFeet(new Vector3());

    // A guest playing together draws its swing but lands nothing here. The host owns the zombies
    // and this player's stats, so the swing goes to the host as an event (`NetSystem`), which works
    // out its damage from this player's weapon on the host and delivers it in the host's world.
    // Everyone's swing, the host's included, also goes to every other player, to be drawn there.
    const guest = Boolean(this.world.net?.follower);
    this.deliver(role.key, origin, feet, direction, guest ? 0 : damage, judgement.grade);
    emit('band-attack', { role: role.key, origin, feet, direction, grade: judgement.grade, attackKey: run.weapon.attackKey ?? null });
    this.groove.play(role.key, judgement.grade);
    this.perform(role.key);
  }

  /**
   * Plays this player's role take for its cued effects, the way a bandmate's body plays it.
   *
   * There is no body in first person, so the effects come from where the instrument is: the right
   * controller in a headset, the spot the instrument is drawn at on a flat screen. A press starts
   * the take unless it is already running, so cues authored seconds into it are reached, exactly as
   * the hero's swing does in Game Foundry.
   */
  perform(roleKey) {
    const take = this.roleTakes.get(roleKey);
    if (!take) return;
    const grip = this.world.playerSpaceEntities?.gripSpaces?.right?.object3D;
    if (this.world.session && grip) this.performer.mount(grip, HAND_IN_GRIP);
    else this.performer.mount(this.camera, HAND_IN_VIEW);
    this.performer.play(take.file, take.seconds);
  }

  /**
   * Which take file each role plays, and how long it runs, from the band's cast: every member is
   * baked with `play_<role>` (`addon.json`), and `VFX.clips` names the file behind each cued one.
   * A role whose take carries no effects is left out, and its presses fire none.
   */
  async loadRoleTakes() {
    for (const role of ROLES) {
      const name = `play_${role.key}`;
      const member = CAST.find((m) => VFX.clips[m.model]?.[name]);
      if (!member) continue;
      try {
        const gltf = await AssetManager.loadGLTF(assetUrl(member.model), member.model);
        const clip = gltf.animations?.find((c) => c.name === name);
        if (clip) this.roleTakes.set(role.key, { file: VFX.clips[member.model][name], seconds: clip.duration });
      } catch (err) {
        console.warn(`[band] Could not read the ${role.key}'s take; their presses fire no effects.`, err);
      }
    }
  }

  /** How hard a swing lands: the weapon's dps through the role's attack, the beat and the role. */
  damageFor(roleKey, weapon, grade) {
    return this.hitFor(roleKey, weapon) * (GRADE_DAMAGE[grade] ?? GRADE_DAMAGE.miss);
  }

  /** One of the role's hits before the beat has its say. */
  hitFor(roleKey, weapon) {
    const role = roleByKey(roleKey);
    const base = attackOf(role.attackKey && GAME.attacks[role.attackKey] ? role.attackKey : weapon.attackKey);
    return hitDamage(weapon.dps, base) * role.damage;
  }

  // ── the ultimate ────────────────────────────────────────────────────────────────────────────

  /** Fires this player's ultimate, if the meter is full. */
  unleash() {
    if (run.phase !== 'playing') return;
    this.groove.start();
    const ult = ULTIMATES[band.role];
    if (!ultimateReady(band.ultCharge)) {
      // Said once in a while rather than per press.
      if (band.beatTime - this.lastNotReadyAt > 2) {
        this.lastNotReadyAt = band.beatTime;
        emit('message', { text: `${ult.label}: ${Math.floor(band.ultCharge * 100)}% — play on the beat to charge it`, tone: 'info' });
      }
      return;
    }

    const landing = band.clock.judge(this.groove.now()).grade;
    const player = this.world.getSystem(PlayerSystem);
    const { origin, direction } = player.getAim();
    const feet = player.getFeet(new Vector3());
    const guest = Boolean(this.world.net?.follower);
    const damage = ultimateDamage(this.hitFor(band.role, run.weapon), band.role, landing);
    this.deliverUltimate(band.role, origin.clone(), feet, direction.clone(), guest ? 0 : damage, landing, null,
      () => player.getFeet(new Vector3()));
    emit('band-ultimate', { role: band.role, origin, feet, direction, grade: landing });

    band.ultCharge = 0;
    band.ultAt = band.beatTime;
    band.lastGrade = landing;
    band.lastGradeAt = band.beatTime;
    this.groove.ultimate(band.role);
    emit('message', { text: `${ult.label}!${landing === 'perfect' ? ' Right on the beat!' : ''}`, tone: 'good' });
  }

  /**
   * One band member's ultimate: everything hostile in its shape takes `damage`. For this player,
   * and by the host for a guest's (`by` naming them, `follow` reading where they stand now, for an
   * aura that goes with them).
   */
  deliverUltimate(roleKey, origin, feet, direction, damage, grade, by = null, follow = () => feet) {
    const ult = ULTIMATES[roleKey];
    const role = roleByKey(roleKey);
    if (!ult) return;
    flat.set(direction.x, 0, direction.z);
    if (flat.lengthSq() < 1e-6) flat.set(0, 0, -1);
    flat.normalize();
    const forward = flat.clone();
    const shape = ult.shape;
    const area = (radius) => ({
      ...attackOf(null), maxRangeMeters: radius, areaRadiusMeters: radius, maxTargets: 0,
      stunPower: ult.stunPower, primitiveColorHex: hex(role.color),
    });

    if (shape.kind === 'line') {
      this.lineHit(feet, forward, shape.lengthM, shape.widthM, damage, ult.stunPower, by);
      this.beamBurst(feet, forward, shape.lengthM, shape.widthM, role.color);
    } else if (shape.kind === 'area') {
      if (damage > 0) this.combat.meleeFrom(feet, forward, area(shape.radiusM), damage, 'player', null, by);
      this.burst(feet, forward, role.color, 'ring', 2.2);
    } else {
      this.auras.push({ left: shape.seconds, tickIn: 0, every: shape.tickSeconds, attack: area(shape.radiusM), damage, by, follow, colour: role.color });
    }
    this.pillar(feet, role.color);
  }

  /** Everything hostile in a line along the ground, gathered first so a kill mid-loop changes nothing. */
  lineHit(from, forward, length, width, damage, stunPower, by) {
    if (damage <= 0) return;
    const hit = [];
    for (const entity of this.combat.queries.actors.entities) {
      if (entity.getValue(Actor, 'state') === 'dead') continue;
      const row = entity.object3D.userData.entity;
      if (!isAttackable(row.role) || !areFactionsHostile('player', factionOf(row.role))) continue;
      const p = entity.object3D.position;
      if (inLine(p.x, p.z, from.x, from.z, forward.x, forward.z, length, width)) hit.push(entity);
    }
    for (const entity of hit) this.combat.damageActor(entity, damage, stunPower, by);
  }

  /** Ticks every aura still running: a hit and a ring wherever its dancer is now. */
  stepAuras(delta) {
    for (let i = this.auras.length - 1; i >= 0; i--) {
      const aura = this.auras[i];
      aura.left -= delta;
      aura.tickIn -= delta;
      if (aura.tickIn <= 0) {
        aura.tickIn = aura.every;
        const at = aura.follow();
        if (at) {
          if (aura.damage > 0) this.combat.meleeFrom(at, flat.set(0, 0, 1), aura.attack, aura.damage, 'player', null, aura.by);
          this.burst(at, flat.set(0, 0, 1), aura.colour, 'spin', 1.6);
        }
      }
      if (aura.left <= 0) this.auras.splice(i, 1);
    }
  }

  /** A long strip of light down the ground where a line ultimate went. */
  beamBurst(feet, forward, length, width, colour) {
    const mesh = new Mesh(
      new PlaneGeometry(width, length),
      new MeshBasicMaterial({ color: new Color(colour), transparent: true, opacity: 0.8, depthWrite: false, side: DoubleSide }),
    );
    mesh.rotation.order = 'YXZ';
    mesh.rotation.y = Math.atan2(forward.x, forward.z);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(feet.x, feet.y + 0.08, feet.z).addScaledVector(forward, length / 2);
    this.world.createTransformEntity(mesh).addComponent(LevelPiece).addComponent(Effect, { life: 0.7, maxLife: 0.7, grow: 1.1 });
  }

  /** A column of light on whoever fired an ultimate. */
  pillar(feet, colour) {
    const mesh = new Mesh(
      new CylinderGeometry(0.9, 1.3, 9, 24, 1, true),
      new MeshBasicMaterial({ color: new Color(colour), transparent: true, opacity: 0.6, depthWrite: false, side: DoubleSide }),
    );
    mesh.position.set(feet.x, feet.y + 4.5, feet.z);
    this.world.createTransformEntity(mesh).addComponent(LevelPiece).addComponent(Effect, { life: 0.9, maxLife: 0.9, grow: 1.6 });
  }

  /**
   * One band member's swing, in their role's shape: everything hostile in it takes `damage`.
   * Used for this player's own swing, and by the host for a guest's, with `by` naming the guest so
   * the kill is theirs.
   */
  deliver(roleKey, origin, feet, direction, damage, grade, by = null, weapon = run.weapon) {
    const role = roleByKey(roleKey);
    const base = attackOf(role.attackKey && GAME.attacks[role.attackKey] ? role.attackKey : weapon.attackKey);
    const colour = grade === 'miss' ? 0x777788 : role.color;
    const primitiveColorHex = hex(colour);

    switch (role.wave) {
      case 'cone':
        this.combat.meleeFrom(origin, direction,
          { ...base, maxRangeMeters: Math.max(base.maxRangeMeters || 2, 4.5), areaRadiusMeters: 0, maxTargets: 0, primitiveColorHex },
          damage, 'player', null, by);
        this.burst(feet, direction, colour, 'cone');
        break;
      case 'ring':
        // From wherever the drummer is: on the stool, or off the stage with the sticks.
        this.combat.meleeFrom(feet, direction,
          { ...base, areaRadiusMeters: 5, maxTargets: 0, primitiveColorHex },
          damage, 'player', null, by);
        this.burst(feet, direction, colour, 'ring');
        break;
      case 'beam':
        // Keyed as the singer's bolt so it flies as the lightning flipbook (`lightning.js`); the
        // sphere is only what an export without the sheet falls back to.
        this.combat.fireProjectile(origin, direction,
          { ...base, key: SINGER_BOLT, delivery: 'ranged_projectile', maxRangeMeters: 18, projectileSpeedMetersPerSecond: 26, areaRadiusMeters: 0.6, primitive: 'sphere', primitiveScale: 1.6, primitiveColorHex },
          damage, 'player', by);
        this.burst(feet, direction, colour, 'beam');
        break;
      case 'spin':
        this.combat.meleeFrom(feet, direction,
          { ...base, areaRadiusMeters: 3, maxTargets: 0, stunPower: Math.max(base.stunPower || 0, 30), primitiveColorHex },
          damage, 'player', null, by);
        this.burst(feet, direction, colour, 'spin');
        break;
    }
  }

  /** The visual for a press, through the template's own `Effect`: it grows, fades and removes itself. */
  burst(at, direction, colour, wave, scale = 1) {
    const material = () => new MeshBasicMaterial({ color: new Color(colour), transparent: true, opacity: 0.8, depthWrite: false, side: DoubleSide });
    let mesh;
    let life = 0.45;
    let grow = 4;
    if (wave === 'cone') {
      mesh = new Mesh(new RingGeometry(0.6, 0.8, 32, 1, -Math.PI / 3, (Math.PI * 2) / 3), material());
      mesh.rotation.x = -Math.PI / 2;
      flat.set(direction.x, 0, direction.z).normalize();
      // Laid flat by the X turn, the arc's centre (cos θ, sin θ) lands at (cos θ, 0, -sin θ).
      mesh.rotation.z = Math.atan2(-flat.z, flat.x);
      mesh.position.set(at.x, at.y + 1.1, at.z);
      grow = 6;
    } else if (wave === 'ring') {
      mesh = new Mesh(new TorusGeometry(0.8, 0.06, 8, 64), material());
      mesh.rotation.x = Math.PI / 2;
      mesh.position.set(at.x, at.y + 0.3, at.z);
      grow = 7;
      life = 0.6;
    } else if (wave === 'beam') {
      mesh = new Mesh(new RingGeometry(0.15, 0.3, 24), material());
      mesh.position.set(at.x, at.y + 1.5, at.z).addScaledVector(flat.set(direction.x, 0, direction.z).normalize(), 0.8);
      mesh.lookAt(mesh.position.x + flat.x, mesh.position.y, mesh.position.z + flat.z);
      grow = 3;
    } else {
      mesh = new Mesh(new RingGeometry(0.9, 1.05, 40), material());
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.set(at.x, at.y + 0.06, at.z);
      grow = 3;
    }
    this.world.createTransformEntity(mesh).addComponent(LevelPiece)
      .addComponent(Effect, { life: life * (scale > 1 ? 1.4 : 1), maxLife: life * (scale > 1 ? 1.4 : 1), grow: grow * scale });
  }

  // ── frame ───────────────────────────────────────────────────────────────────────────────────

  update(delta) {
    this.cooldown = Math.max(0, this.cooldown - delta);
    band.beatTime = this.groove.now();
    this.groove.pump(band.performance.hype);
    this.watchMainHand();

    if (run.phase === 'playing') {
      const keyboard = this.input.keyboard;
      // Under a roster the role is the character's, chosen at Band HQ.
      const free = !band.rosterLocked;
      if (free && keyboard.getKeyDown('KeyR')) void this.setRole(nextRole(band.role));
      if (free) for (const role of ROLES) if (keyboard.getKeyDown(role.hotkey)) void this.setRole(role.key);
      const pads = this.input.gamepads;
      if (free && (pads.right?.getButtonDown(InputComponent.B_Button) || pads.left?.getButtonDown(InputComponent.Y_Button))) {
        void this.setRole(nextRole(band.role));
      }
      if (keyboard.getKeyDown('KeyE') || pads.left?.getButtonDown(InputComponent.Trigger)) this.unleash();
      if (keyboard.getKeyDown('KeyT')
        || pads.right?.getButtonDown(InputComponent.Thumbstick) || pads.left?.getButtonDown(InputComponent.Thumbstick)) {
        this.world.getSystem(StageSystem)?.goHome();
      }
      this.syncKits();
      this.stepAuras(delta);
    }

    // A session starting or ending moves the instrument between the hand and the view.
    const immersive = Boolean(this.world.session);
    if (immersive !== this.wasImmersive) {
      this.wasImmersive = immersive;
      this.mountHandProp();
    }

    this.picker.hidden = run.phase !== 'playing';
    this.drawHome();
    this.drawPanel();
    this.drawBoard(immersive);
    this.drawUltButton();
    this.ultPanel.update(delta, immersive && run.phase === 'playing', this.ultLook());
  }

  // ── the ultimate's button and panel ─────────────────────────────────────────────────────────

  ultLook() {
    const ult = ULTIMATES[band.role];
    return { label: ult.label, fill: band.ultCharge, ready: ultimateReady(band.ultCharge), color: hex(roleByKey(band.role).color) };
  }

  /** For a flat screen: E, or this. */
  buildUltButton() {
    const button = document.createElement('button');
    button.type = 'button';
    Object.assign(button.style, {
      position: 'fixed', left: '50%', bottom: '18px', transform: 'translateX(-50%)', zIndex: '30',
      padding: '10px 22px', borderRadius: '999px', cursor: 'pointer',
      font: '700 14px system-ui, sans-serif', letterSpacing: '.08em',
    });
    button.addEventListener('click', (event) => {
      // Not a click on the canvas, so it neither attacks nor grabs the mouse.
      event.stopPropagation();
      this.unleash();
    });
    button.hidden = true;
    document.body.appendChild(button);
    this.ultButton = button;
    this.ultButtonKey = '';
    this.cleanupFuncs.push(() => button.remove());
  }

  drawUltButton() {
    this.ultButton.hidden = run.phase !== 'playing' || Boolean(this.world.session);
    if (this.ultButton.hidden) return;
    const { label, fill, ready, color } = this.ultLook();
    const pct = Math.floor(fill * 100);
    const key = `${label}|${ready}|${Math.floor(pct / 10)}`;
    if (key === this.ultButtonKey) return;
    this.ultButtonKey = key;
    this.ultButton.textContent = ready ? `E  ${label.toUpperCase()}` : `ULTIMATE ${pct}%`;
    this.ultButton.title = ULTIMATES[band.role].blurb;
    Object.assign(this.ultButton.style, {
      border: `2px solid ${color}`, color: ready ? '#0c0818' : '#f5f0ff',
      background: ready ? color : `linear-gradient(90deg, ${color}55 ${pct}%, rgba(12,8,24,0.7) ${pct}%)`,
      boxShadow: ready ? `0 0 18px ${color}` : 'none',
    });
  }

  // ── the role buttons ────────────────────────────────────────────────────────────────────────

  buildPicker() {
    const bar = document.createElement('div');
    Object.assign(bar.style, {
      position: 'fixed', left: '12px', bottom: '16px', zIndex: '30', display: 'flex',
      flexDirection: 'column', gap: '6px', font: '600 13px system-ui, sans-serif',
    });
    for (const role of ROLES) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.role = role.key;
      button.title = role.blurb;
      button.textContent = `${role.hotkey.slice(-1)}  ${role.label}`;
      button.addEventListener('click', (event) => {
        // Not a click on the canvas, so it neither attacks nor grabs the mouse.
        event.stopPropagation();
        void this.setRole(role.key);
      });
      bar.appendChild(button);
    }
    const home = document.createElement('button');
    home.type = 'button';
    home.textContent = 'T  Home';
    home.title = 'Back to your seat on the stage';
    home.addEventListener('click', (event) => {
      event.stopPropagation();
      this.world.getSystem(StageSystem)?.goHome();
    });
    bar.appendChild(home);
    this.homeButton = home;
    bar.hidden = true;
    document.body.appendChild(bar);
    this.picker = bar;
    this.drawPicker();
    this.cleanupFuncs.push(() => bar.remove());
  }

  /** The Home button lights up once this player is off the stage. */
  drawHome() {
    if (!this.homeButton || run.phase !== 'playing') return;
    // A hunt has no seat to go back to.
    this.homeButton.hidden = band.hunt;
    const away = !(this.world.getSystem(StageSystem)?.onStage() ?? true);
    if (this.homeButton.dataset.away === String(away)) return;
    this.homeButton.dataset.away = String(away);
    Object.assign(this.homeButton.style, {
      marginTop: '6px', padding: '7px 14px', borderRadius: '999px', cursor: 'pointer', textAlign: 'left', font: 'inherit',
      border: '1px solid #e2e8f0', color: away ? '#0c0818' : '#f5f0ff', background: away ? '#e2e8f0' : 'rgba(12,8,24,0.7)',
    });
  }

  drawPicker() {
    for (const button of this.picker?.querySelectorAll('button[data-role]') ?? []) {
      const role = roleByKey(button.dataset.role);
      const active = role.key === band.role;
      button.hidden = band.rosterLocked;
      Object.assign(button.style, {
        padding: '7px 14px', borderRadius: '999px', cursor: 'pointer', textAlign: 'left',
        border: `1px solid ${hex(role.color)}`, color: active ? '#0c0818' : '#f5f0ff',
        background: active ? hex(role.color) : 'rgba(12,8,24,0.7)', font: 'inherit',
      });
    }
  }

  // ── the score: a strip at the top of the screen, and a board in the headset ────────────────

  view() {
    const p = band.performance;
    const { beat, phase } = band.clock.at(band.beatTime);
    const recent = band.beatTime - band.lastGradeAt < 0.5 ? band.lastGrade : null;
    return { p, beat: beat % 4, onBeat: phase < 0.25, recent, role: roleByKey(band.role), hunt: this.huntLine() };
  }

  /** On a Boss Hunt: who is being hunted and how far off, in place of the breaches. Null otherwise. */
  huntLine() {
    if (!band.hunt) return null;
    const quarry = band.quarry;
    if (!quarry) return 'Boss Hunt';
    if ((run.kills[quarry.key] ?? 0) > 0) return `${quarry.name} is down`;
    if (!quarry.object) return `Hunt ${quarry.name}`;
    this.world.getSystem(PlayerSystem).getFeet(huntFeet);
    const metres = Math.round(Math.hypot(quarry.object.position.x - huntFeet.x, quarry.object.position.z - huntFeet.z));
    return `Hunt ${quarry.name} · ${metres} m`;
  }

  buildPanel() {
    const el = document.createElement('div');
    Object.assign(el.style, {
      position: 'fixed', top: '12px', left: '50%', transform: 'translateX(-50%)', zIndex: '30',
      padding: '8px 16px', borderRadius: '12px', background: 'rgba(12,8,24,0.72)',
      color: '#f5f0ff', font: '600 14px system-ui, sans-serif', textAlign: 'center',
      pointerEvents: 'none', minWidth: '260px',
    });
    el.hidden = true;
    document.body.appendChild(el);
    this.panel = el;
    this.panelKey = '';
    this.cleanupFuncs.push(() => el.remove());
  }

  drawPanel() {
    this.panel.hidden = run.phase !== 'playing';
    if (this.panel.hidden) return;
    const { p, beat, onBeat, recent, role, hunt } = this.view();
    const key = `${beat}|${onBeat}|${p.combo}|${Math.round(p.hype * 20)}|${recent}|${band.breaches}|${role.key}|${this.groove.started}|${Math.round(band.ultCharge * 20)}|${hunt}`;
    if (key === this.panelKey) return;
    this.panelKey = key;
    const colour = hex(role.color);
    const dots = [0, 1, 2, 3].map((i) => `<span style="display:inline-block;width:10px;height:10px;margin:0 3px;border-radius:50%;background:${i === beat && onBeat ? colour : 'rgba(255,255,255,.2)'}"></span>`).join('');
    const gradeColour = recent === 'perfect' ? '#7dffb0' : recent === 'good' ? '#ffe27d' : '#ff7d7d';
    this.panel.innerHTML = `
      <div style="letter-spacing:.12em;font-size:12px;opacity:.75">ZOMBIE BEAT · ${role.label.toUpperCase()}</div>
      <div style="margin:4px 0">${dots}</div>
      <div>Combo <b>${p.combo}</b> · best ${p.best} · ${hunt ? `<b style="color:#ff8080">${hunt}</b>` : `breaches <b style="color:#ff8080">${band.breaches}</b>`}</div>
      <div style="margin-top:5px;height:6px;border-radius:3px;background:rgba(255,255,255,.15);overflow:hidden">
        <div style="width:${Math.round(p.hype * 100)}%;height:100%;background:${colour}"></div></div>
      <div style="margin-top:3px;height:4px;border-radius:2px;background:rgba(255,255,255,.12);overflow:hidden">
        <div style="width:${Math.round(band.ultCharge * 100)}%;height:100%;background:${ultimateReady(band.ultCharge) ? '#fff' : colour}"></div></div>
      <div style="height:18px;margin-top:3px;color:${gradeColour}">${recent ? recent.toUpperCase() : ''}</div>
      ${this.groove.started ? '' : '<div style="font-size:12px;opacity:.7">Press any key to start the music</div>'}
      <div style="font-size:11px;opacity:.6">1–4 or R: change role${hunt ? '' : ' · T: home'} · click / F on the beat · E: ultimate</div>`;
  }

  buildBoard() {
    this.boardCanvas = document.createElement('canvas');
    this.boardCanvas.width = 512;
    this.boardCanvas.height = 160;
    this.boardTexture = new CanvasTexture(this.boardCanvas);
    this.boardTexture.colorSpace = SRGBColorSpace;
    this.board = new Mesh(
      new PlaneGeometry(0.6, 0.1875),
      new MeshBasicMaterial({ map: this.boardTexture, transparent: true, depthTest: false }),
    );
    // Above the template's own panel, which sits just below the gaze.
    this.board.position.set(0, 0.2, -1);
    this.board.rotation.x = 0.15;
    this.board.renderOrder = 1000;
    this.board.visible = false;
    this.boardGroup = new Group();
    this.boardGroup.add(this.board);
    this.camera.add(this.boardGroup);
    this.boardKey = '';
  }

  drawBoard(immersive) {
    this.board.visible = immersive && run.phase === 'playing';
    if (!this.board.visible) return;
    const { p, beat, recent, role, hunt } = this.view();
    const key = `${beat}|${p.combo}|${Math.round(p.hype * 20)}|${recent}|${band.breaches}|${role.key}|${Math.round(band.ultCharge * 20)}|${hunt}`;
    if (key === this.boardKey) return;
    this.boardKey = key;
    const g = this.boardCanvas.getContext('2d');
    const colour = hex(role.color);
    g.clearRect(0, 0, 512, 160);
    g.fillStyle = 'rgba(12,8,24,0.78)';
    g.beginPath();
    g.roundRect(4, 4, 504, 152, 22);
    g.fill();
    g.textAlign = 'center';
    g.font = 'bold 30px system-ui, sans-serif';
    g.fillStyle = colour;
    g.fillText(`${role.label.toUpperCase()}  ·  COMBO ${p.combo}`, 256, 44);
    for (let i = 0; i < 4; i++) {
      g.fillStyle = i === beat ? colour : 'rgba(255,255,255,0.25)';
      g.beginPath();
      g.arc(196 + i * 40, 76, 11, 0, Math.PI * 2);
      g.fill();
    }
    g.fillStyle = 'rgba(255,255,255,0.18)';
    g.fillRect(56, 98, 400, 12);
    g.fillStyle = colour;
    g.fillRect(56, 98, 400 * p.hype, 12);
    g.fillStyle = 'rgba(255,255,255,0.12)';
    g.fillRect(56, 114, 400, 5);
    g.fillStyle = ultimateReady(band.ultCharge) ? '#ffffff' : colour;
    g.fillRect(56, 114, 400 * band.ultCharge, 5);
    g.font = 'bold 22px system-ui, sans-serif';
    g.fillStyle = recent === 'perfect' ? '#7dffb0' : recent === 'good' ? '#ffe27d' : recent ? '#ff7d7d' : '#cbd5e1';
    g.fillText(recent ? recent.toUpperCase() : hunt ?? `breaches ${band.breaches}  ·  B/Y role  ·  stick click home`, 256, 142);
    this.boardTexture.needsUpdate = true;
  }
}
