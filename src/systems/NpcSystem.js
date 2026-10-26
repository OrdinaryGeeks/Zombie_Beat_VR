import { LoopOnce, LoopRepeat, Vector3, createSystem } from '@iwsdk/core';
import { Actor } from '../components.js';
import { GAME } from '../content/game.js';
import { VelocityTracker, dashFor, planDash } from '../dash.js';
import { areFactionsHostile, factionOf, hitDamage, isAttackable } from '../rules.js';
import { run } from '../state.js';
import { CombatSystem, attackOf, isRay } from './CombatSystem.js';
import { LevelSystem } from './LevelSystem.js';
import { PlayerSystem } from './PlayerSystem.js';

const feet = new Vector3();
const step = new Vector3();

/** How far an attack reaches, for closing in and for firing. */
function reachOf(attack) {
  return Math.max(1.2, attack.delivery === 'melee' ? attack.maxRangeMeters || 1.6 : attack.maxRangeMeters || 12);
}

/**
 * What the cast does on its own: hostiles notice you, chase and attack, and give up when led too far
 * from home; allies follow and fight beside you; critters flee; everyone else stands their ground
 * and turns to face you. `GAME.tuning` holds the distances and speeds.
 *
 * ## Playing together
 *
 * When a game plays together it sets `world.net` (see `src/net.js`). Then on the host "you" means
 * whichever player is nearest, so zombies go for whoever is closest; and on a guest
 * (`world.net.follower`) nobody thinks here at all: each actor eases to where the host last said
 * it was (`userData.netTarget`) and plays what the host said it was doing.
 */
export class NpcSystem extends createSystem({
  actors: { required: [Actor] },
}) {
  update(delta) {
    if (run.phase !== 'playing') return;
    const localFeet = this.world.getSystem(PlayerSystem).getFeet(feet);
    const level = this.world.getSystem(LevelSystem);
    const net = this.world.net;
    const combat = this.world.getSystem(CombatSystem);
    const actors = [...this.queries.actors.entities];
    const tuning = GAME.tuning;
    // Disposed after the loop: a disposed entity loses its object3D, and later actors in this
    // same pass still look at every body in `actors`.
    const finished = [];

    for (const entity of actors) {
      const object = entity.object3D;
      const row = object.userData.entity;
      object.userData.mixer?.update(delta);

      const state = entity.getValue(Actor, 'state');
      if (state === 'dead') {
        if (this.animateDeath(entity, delta)) finished.push(entity);
        continue;
      }

      if (net?.follower) {
        this.follow(object, delta);
        continue;
      }

      const player = this.nearestPlayer(object.position, localFeet, net);
      const cooldown = Math.max(0, entity.getValue(Actor, 'cooldown') - delta);
      entity.setValue(Actor, 'cooldown', cooldown);
      const stunned = entity.getValue(Actor, 'stunned');
      if (stunned > 0) {
        entity.setValue(Actor, 'stunned', Math.max(0, stunned - delta));
        // A stagger knocks a dash out of its run, the same as it interrupts anything else.
        if (object.userData.dash) this.endDash(object);
        this.animate(object, 0, delta);
        continue;
      }

      const faction = factionOf(row.role);
      const position = object.position;
      const toPlayer = Math.hypot(player.x - position.x, player.z - position.z);
      const homeX = entity.getValue(Actor, 'homeX');
      const homeZ = entity.getValue(Actor, 'homeZ');
      const fromHome = Math.hypot(position.x - homeX, position.z - homeZ);
      const speed = tuning.speed[row.archetype] ?? 2.5;
      let goal = null;
      let pace = speed;

      // Who is worth fighting: the player if hostile to them, else the nearest hostile actor.
      const target = this.pickTarget(entity, faction, player, toPlayer, actors);

      // A dash or a scream is a commitment: until it is over, the actor does that and nothing else.
      this.tickCooldowns(object, delta);
      if (object.userData.dash) {
        if (target) this.watch(object, target, delta);
        this.stepDash(entity, target, delta, level, actors, combat);
        continue;
      }
      if ((object.userData.rootedFor ?? 0) > 0) {
        object.userData.rootedFor -= delta;
        this.animate(object, 0, delta);
        continue;
      }

      if (target && state !== 'return') {
        const arsenal = this.arsenalOf(row);
        // Closes to the reach of its shortest move, so a zombie with a bite and a scream still
        // comes in to bite; anything that reaches further is fired on the way in.
        const closeTo = Math.min(...arsenal.map(reachOf));
        const distance = Math.hypot(target.x - position.x, target.z - position.z);
        this.watch(object, target, delta);
        if (fromHome > tuning.leashMeters && row.behavior !== 'hunt') {
          entity.setValue(Actor, 'state', 'return');
        } else {
          const close = distance <= closeTo * 0.9;
          entity.setValue(Actor, 'state', close ? 'attack' : 'chase');
          if (close) this.face(object, target);
          else goal = target;
          const used = cooldown <= 0 ? this.nextAttack(object, arsenal, distance) : null;
          if (used) {
            const dash = dashFor(used);
            if (dash) {
              this.startDash(object, used, dash, row);
              goal = null;
            } else {
              const lifted = target.clone();
              lifted.y += 1.2;
              combat.actorAttack(entity, lifted, used);
              this.swing(object, used);
              if (isRay(used)) {
                object.userData.rootedFor = (used.windupSeconds || 0) + (used.durationSeconds || 1);
                goal = null;
              }
            }
            // A short gap between any two moves; each move's own cooldown is what paces it.
            entity.setValue(Actor, 'cooldown', Math.max(0.4, Math.min(used.cooldownSeconds || 1.2, 1.5)));
          }
        }
      } else if (state === 'return') {
        goal = new Vector3(homeX, position.y, homeZ);
        if (fromHome < 1) entity.setValue(Actor, 'state', 'idle');
      } else if (faction === 'player' || (entity.getValue(Actor, 'found') && row.behavior === 'lost') || row.behavior === 'follow') {
        // Allies, summons, and anyone the player has found and is escorting.
        if (toPlayer > tuning.followMeters) goal = player;
      } else if (row.behavior === 'flee' || row.role === 'critter') {
        if (toPlayer < tuning.fleeMeters) {
          goal = position.clone().add(step.set(position.x - player.x, 0, position.z - player.z).setLength(4));
          pace = speed * 1.2;
        }
      } else if (row.behavior === 'wander' || row.behavior === 'patrol') {
        goal = this.wander(object, homeX, homeZ, delta);
        pace = speed * 0.45;
      } else if (toPlayer < tuning.noticeMeters) {
        this.face(object, player);
      }

      const moved = goal ? this.moveToward(object, goal, pace * delta, level, actors) : 0;
      this.animate(object, moved / Math.max(delta, 1e-4), delta);
    }

    for (const entity of finished) entity.dispose({ disposeResources: false });
  }

  /** The attacks an entity has, or the bare-handed swing for one with none. */
  arsenalOf(row) {
    return row.attackKeys.length > 0 ? row.attackKeys.map(attackOf) : [attackOf(null)];
  }

  tickCooldowns(object, delta) {
    const cooldowns = object.userData.cooldowns;
    if (!cooldowns) return;
    for (const key of Object.keys(cooldowns)) cooldowns[key] -= delta;
  }

  /**
   * The next of its attacks that is ready and in reach, taken in turn, or null. Rotated rather than
   * random, and each with its own cooldown, as Game Foundry's `CombatSystem.fireActorAttack` does:
   * a zombie with three moves works through them instead of rolling the same one twice running.
   */
  nextAttack(object, arsenal, distance) {
    const cooldowns = (object.userData.cooldowns ??= {});
    const start = object.userData.rotation ?? 0;
    for (let offset = 0; offset < arsenal.length; offset++) {
      const index = (start + offset) % arsenal.length;
      const attack = arsenal[index];
      if ((cooldowns[attack.key] ?? 0) > 0) continue;
      if (distance > reachOf(attack) * 0.9) continue;
      // Too close to be worth a run-up: the bite or the claw is the move from here.
      if (dashFor(attack) && distance < (attack.minRangeMeters || 0)) continue;
      cooldowns[attack.key] = attack.cooldownSeconds || 1.2;
      object.userData.rotation = index + 1;
      return attack;
    }
    return null;
  }

  /** How this actor sees its target moving. What a dash leads by. */
  watch(object, target, delta) {
    (object.userData.watching ??= new VelocityTracker()).observe(target, delta);
  }

  /** Starts a dash: the stare first (the attack's windup), with the run take already going. */
  startDash(object, attack, spec, row) {
    object.userData.dash = {
      attack, spec, damage: hitDamage(row.dps, attack), faction: factionOf(row.role),
      windup: attack.windupSeconds || 0, end: null, left: 0, alreadyHit: new Set(),
    };
    this.swing(object, attack, { loop: true });
  }

  /**
   * One frame of a dash. Through the windup it stands and faces its target; as the windup ends it
   * takes its aim once — where the target will be by the time it gets there, from how it has been
   * seen moving (`planDash`) — and runs to half a metre (the spec's overshoot) past that without
   * steering again, hitting everything hostile it passes. A target that changes direction during
   * the stare is not where the zombie committed to. Game Foundry's is `CombatSystem.stepDash`.
   */
  stepDash(entity, target, delta, level, actors, combat) {
    const object = entity.object3D;
    const dash = object.userData.dash;
    if (dash.windup > 0) {
      dash.windup -= delta;
      if (target) this.face(object, target);
      if (dash.windup > 0) return;
      if (!target) {
        this.endDash(object);
        return;
      }
      const velocity = object.userData.watching?.velocity ?? { x: 0, z: 0 };
      const path = planDash(object.position, target, velocity, dash.spec, dash.attack.maxRangeMeters || 8);
      dash.end = new Vector3(path.end.x, object.position.y, path.end.z);
      // A little slack over the clean run, for bodies in the way.
      dash.left = path.seconds + 0.3;
    }
    dash.left -= delta;
    this.moveToward(object, dash.end, dash.spec.speed * delta, level, actors);
    combat.dashHit(object.position, dash.spec.hitRadiusMeters, dash.attack, dash.damage, dash.faction, entity, dash.alreadyHit);
    const remaining = Math.hypot(dash.end.x - object.position.x, dash.end.z - object.position.z);
    if (remaining < 0.15 || dash.left <= 0) this.endDash(object);
  }

  /** Stops a dash where it is, and lets the run take go on the next frame. */
  endDash(object) {
    object.userData.dash = null;
    if (object.userData.swingUntil) object.userData.swingUntil = performance.now();
  }

  /** The local player's feet, or a remote player's when one is closer. */
  nearestPlayer(position, localFeet, net) {
    let best = localFeet;
    let bestDistance = Math.hypot(localFeet.x - position.x, localFeet.z - position.z);
    for (const other of net?.players() ?? []) {
      const distance = Math.hypot(other.position.x - position.x, other.position.z - position.z);
      if (distance < bestDistance) {
        best = other.position;
        bestDistance = distance;
      }
    }
    return best;
  }

  /** A guest's actor: eased to the host's last word on it, animated to match. */
  follow(object, delta) {
    const target = object.userData.netTarget;
    if (!target) {
      this.animate(object, 0, delta);
      return;
    }
    const k = Math.min(1, delta * 10);
    object.position.x += (target.x - object.position.x) * k;
    object.position.y += (target.y - object.position.y) * k;
    object.position.z += (target.z - object.position.z) * k;
    let diff = target.ry - object.rotation.y;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    object.rotation.y += diff * k;
    if (target.swings > (object.userData.swings ?? 0)) {
      // The host names the take its actor played; a run is the only one that cycles.
      const take = target.take ? { actionClipKey: target.take } : null;
      this.swing(object, take, { loop: target.dashing === true });
    }
    if (object.userData.swingUntil === Infinity && !target.dashing) object.userData.swingUntil = performance.now();
    object.userData.swings = target.swings;
    this.animate(object, target.moving ? 1 : 0, delta);
  }

  pickTarget(entity, faction, player, toPlayer, actors) {
    const row = entity.object3D.userData.entity;
    const aggro = row.behavior === 'hunt' ? GAME.tuning.huntMeters : GAME.tuning.aggroMeters;
    // Something hit recently fights back even beyond its notice range.
    const provoked = performance.now() - (entity.object3D.userData.lastHit ?? -1e9) < 8000;
    if (areFactionsHostile(faction, 'player') && (toPlayer < aggro || provoked)) return player;

    let best = null;
    let bestDistance = aggro;
    if (faction === 'passive') return null;
    for (const other of actors) {
      if (other === entity || other.getValue(Actor, 'state') === 'dead') continue;
      const otherRow = other.object3D.userData.entity;
      if (!isAttackable(otherRow.role) || !areFactionsHostile(faction, factionOf(otherRow.role))) continue;
      const d = entity.object3D.position.distanceTo(other.object3D.position);
      if (d < bestDistance) {
        best = other.object3D.position;
        bestDistance = d;
      }
    }
    return best;
  }

  moveToward(object, goal, distance, level, actors) {
    step.set(goal.x - object.position.x, 0, goal.z - object.position.z);
    const length = step.length();
    if (length < 0.05) return 0;
    step.multiplyScalar(Math.min(distance, length) / length);

    // Keep a little space between bodies so a crowd does not collapse into one spot.
    for (const other of actors) {
      const p = other.object3D.position;
      if (other.object3D === object) continue;
      const dx = object.position.x - p.x;
      const dz = object.position.z - p.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > 0.0001 && d2 < 0.64) {
        const push = (0.8 - Math.sqrt(d2)) * 0.5;
        step.x += (dx / Math.sqrt(d2)) * push;
        step.z += (dz / Math.sqrt(d2)) * push;
      }
    }

    object.position.x += step.x;
    object.position.z += step.z;
    // Reading the ground every frame for every actor is costly on a big scene; once every half
    // metre walked is plenty to follow stairs and slopes.
    object.userData.groundAge = (object.userData.groundAge ?? 1) + distance;
    if (object.userData.groundAge > 0.5 && level) {
      object.userData.groundAge = 0;
      object.userData.groundY = level.groundHeight(object.position.x, object.position.z, object.position.y);
    }
    if (object.userData.groundY !== undefined) {
      object.position.y += (object.userData.groundY - object.position.y) * 0.3;
    }
    this.face(object, goal);
    return Math.hypot(step.x, step.z);
  }

  wander(object, homeX, homeZ, delta) {
    const data = object.userData;
    data.wanderIn = (data.wanderIn ?? 0) - delta;
    if (!data.wanderGoal || data.wanderIn <= 0) {
      const angle = Math.random() * Math.PI * 2;
      const radius = Math.random() * GAME.tuning.wanderMeters;
      data.wanderGoal = new Vector3(homeX + Math.cos(angle) * radius, object.position.y, homeZ + Math.sin(angle) * radius);
      data.wanderIn = 3 + Math.random() * 4;
    }
    return data.wanderGoal;
  }

  face(object, target) {
    const yaw = Math.atan2(target.x - object.position.x, target.z - object.position.z);
    let diff = yaw - object.rotation.y;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    object.rotation.y += diff * 0.2;
  }

  /** What the legs are doing: the walk while moving, else the idle. */
  locomotion(object) {
    const actions = object.userData.actions;
    return (object.userData.walking && actions.walk) || actions.idle;
  }

  /**
   * The attack clip, once, cross-faded from the walk or idle and back when it ends. A cross-fade
   * rather than a second action on top: the mixer averages two full-weight actions, which would
   * play half an attack.
   */
  swing(object, attack = null, { loop = false } = {}) {
    // Counted whether or not there is a clip to play: it is what a host relays to its guests, with
    // the take's name so they play the same one.
    object.userData.swings = (object.userData.swings ?? 0) + 1;
    const named = attack?.actionClipKey ? object.userData.takes?.[attack.actionClipKey] : null;
    object.userData.take = named ? attack.actionClipKey : '';
    const take = named ?? object.userData.actions?.attack;
    if (!take) return;
    const from = object.userData.playing ?? this.locomotion(object);
    // A dash's run cycles until the run is over (`endDash`); everything else plays once.
    take.setLoop(loop ? LoopRepeat : LoopOnce, loop ? Infinity : 1);
    take.reset().play();
    if (from !== take) take.crossFadeFrom(from, 0.12, false);
    object.userData.playing = take;
    object.userData.swingUntil = loop ? Infinity : performance.now() + Math.max(0.3, take.getClip().duration - 0.2) * 1000;
  }

  /** Walk cycle from the model's own clips when it has them, else a simple bob. */
  animate(object, speed, delta) {
    const actions = object.userData.actions;
    const moving = speed > 0.2;
    if (object.userData.swingUntil && performance.now() > object.userData.swingUntil) {
      object.userData.swingUntil = 0;
      const back = this.locomotion(object);
      back.reset().play();
      (object.userData.playing ?? actions.attack).crossFadeTo(back, 0.2, false);
      object.userData.playing = null;
    }
    if (actions?.walk) {
      if (moving !== object.userData.walking) {
        object.userData.walking = moving;
        const from = moving ? actions.idle : actions.walk;
        const to = moving ? actions.walk : actions.idle;
        to.reset().play();
        from.crossFadeTo(to, 0.2, false);
      }
      return;
    }
    const body = object.children[0];
    if (!body) return;
    object.userData.phase = (object.userData.phase ?? 0) + delta * (moving ? 10 : 2);
    const base = body.userData.baseY ?? (body.userData.baseY = body.position.y);
    body.position.y = base + Math.abs(Math.sin(object.userData.phase)) * (moving ? 0.08 : 0.015);
  }

  /**
   * Plays its death clip when the model has one, otherwise falls over; then sinks out of sight.
   * True once it is ready to be removed.
   */
  animateDeath(entity, delta) {
    const object = entity.object3D;
    const first = object.userData.deadFor === undefined || object.userData.deadFor === 0;
    const t = (object.userData.deadFor = (object.userData.deadFor ?? 0) + delta);
    const death = object.userData.actions?.death;
    if (death) {
      // The mixer itself is stepped for every actor, the dead included, at the top of `update`.
      if (first) {
        object.userData.mixer.stopAllAction();
        death.reset().play();
      }
      const held = death.getClip().duration + 0.8;
      if (t > held) object.position.y -= delta * 0.6;
      return t > held + 1.8;
    }
    object.userData.mixer?.stopAllAction();
    object.rotation.x = -Math.min(1, t * 3) * (Math.PI / 2);
    if (t > 1.2) object.position.y -= delta * 0.6;
    return t > 3;
  }
}
