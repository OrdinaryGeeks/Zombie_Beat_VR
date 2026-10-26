import { createSystem } from '@iwsdk/core';
import { Actor } from '../components.js';
import { GAME } from '../content/game.js';
import { isWalkable } from '../navCollision.js';
import { emit, on, run } from '../state.js';
import { LevelSystem } from '../systems/LevelSystem.js';
import { band } from './band.js';
import { bossDue, bossTriggers, hidingRow, huntTargets, isBoss, pickHideout } from './rules.js';

/**
 * The zombie bosses: held back when a night starts, and let in one at a time at random moments.
 *
 * `LevelSystem` keeps every boss spawn out of the level (`holdBack`); this decides when each one
 * comes in (`release`): at a random kill count or a random time, whichever comes first, both inside
 * the night's own goals so a boss always shows before the night can end (`bossTriggers`). Only
 * whoever runs the zombies decides, alone or as the host. A guest never schedules anything:
 * `NetSystem` lets a held boss in the moment the host's snapshot names it, so the room sees one
 * boss, in one place, at one time.
 *
 * The schedule is made for the night the first time this machine is the one deciding, so a guest
 * promoted to host mid-night picks up the bosses still to come (any already due arrive at once).
 *
 * ## Boss Hunt
 *
 * On a hunt board (`band.hunt`) nothing is scheduled. One of the bosses the board names is picked
 * at random and let in at once, then moved to a hideout far across the level (`pickHideout`) with
 * its leash anchored there, and given a row that keeps it home (`hidingRow`) rather than hunting the
 * band from anywhere like the rest of the horde. The others stay held for good. Every machine
 * tracks it as `band.quarry`, which `BandSystem` shows as a distance.
 */
export class BossSystem extends createSystem({
  actors: { required: [Actor] },
}) {
  init() {
    this.levels = this.world.getSystem(LevelSystem);
    this.levels.holdBack = isBoss;
    /** `{ levelKey, queue: [{ at, index }] }` for the night being played, or null. */
    this.schedule = null;

    this.cleanupFuncs.push(
      on('level-loading', () => { this.schedule = null; }),
      on('actor-arrived', ({ entity, index }) => {
        if (!isBoss(entity)) return;
        if (!band.hunt) {
          emit('message', { text: `${entity.name} crashes the show!`, tone: 'bad' });
          return;
        }
        band.quarry = { key: entity.key, name: entity.name, object: this.actorAt(index)?.object3D ?? null };
        emit('message', { text: `${entity.name} is hiding somewhere out there. Find it.`, tone: 'bad' });
      }),
    );
  }

  update() {
    if (run.phase !== 'playing' || this.world.net?.follower) return;
    const levels = this.levels;
    if (this.schedule?.levelKey !== run.levelKey) {
      if (band.hunt) {
        this.schedule = { levelKey: run.levelKey, queue: [] };
        void this.hide();
        return;
      }
      // Only the bosses: the rest of what is held is the crowd `WaveSystem` lets in.
      const held = [...levels.held.entries()]
        .filter(([, spot]) => isBoss(GAME.entities[spot.placement.entity]))
        .map(([index]) => index);
      const triggers = bossTriggers(levels.level, held.length);
      this.schedule = { levelKey: run.levelKey, queue: held.map((index, i) => ({ index, ...triggers[i] })) };
      if (held.length > 0) {
        console.log(`[bosses] ${run.levelKey}: ${this.schedule.queue.map((b) => `${b.kills} kills or ${b.seconds}s`).join('; ')}.`);
      }
    }
    const due = this.schedule.queue.filter((b) => bossDue(b, run.totalKills, run.elapsed));
    if (due.length === 0) return;
    this.schedule.queue = this.schedule.queue.filter((b) => !due.includes(b));
    for (const boss of due) void levels.release(boss.index);
  }

  /** A hunt: one of the named bosses, in at once, in a hideout. */
  async hide() {
    const levels = this.levels;
    const level = levels.level;
    const wanted = new Set(huntTargets(level, GAME.entities));
    const pool = [...levels.held.entries()].filter(([, spot]) => wanted.has(spot.placement.entity));
    if (pool.length === 0) {
      console.warn(`[bosses] ${run.levelKey}: a hunt for ${[...wanted].join(', ')}, and none of them is on this board.`);
      return;
    }
    const [index] = pool[Math.floor(Math.random() * pool.length)];
    const levelKey = run.levelKey;
    const hideout = this.hideout(level);
    if (!(await levels.release(index)) || run.levelKey !== levelKey) return;
    const actor = this.actorAt(index);
    if (!actor) return;
    const object = actor.object3D;
    object.userData.entity = hidingRow(object.userData.entity);
    if (hideout) {
      object.position.set(hideout.x, levels.groundHeight(hideout.x, hideout.z, object.position.y), hideout.z);
      actor.setValue(Actor, 'homeX', hideout.x);
      actor.setValue(Actor, 'homeZ', hideout.z);
    }
    console.log(`[bosses] ${levelKey}: ${object.userData.entity.key} hides at ` +
      (hideout ? `(${hideout.x.toFixed(1)}, ${hideout.z.toFixed(1)})` : 'its spawn (no hideout found)') + '.');
  }

  /** Far from the start: the walk over the baked navigation, else out towards the level's rim. */
  hideout(level) {
    const { nav, start } = this.levels;
    if (nav) return pickHideout(nav, (cx, cz) => isWalkable(nav, cx, cz), start);
    const angle = Math.random() * Math.PI * 2;
    const r = (level?.ground?.radiusMeters ?? 60) * 0.8;
    return { x: start.x + Math.cos(angle) * r, z: start.z + Math.sin(angle) * r };
  }

  /** The actor let in for `level.spawns[index]`, if it is in. */
  actorAt(index) {
    for (const entity of this.queries.actors.entities) {
      if (entity.object3D?.userData.spawnIndex === index) return entity;
    }
    return null;
  }
}
