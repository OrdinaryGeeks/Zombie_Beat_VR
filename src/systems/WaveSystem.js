import { createSystem } from '@iwsdk/core';
import { Actor } from '../components.js';
import { GAME } from '../content/game.js';
import { isHostileToPlayer } from '../rules.js';
import { emit, on, run } from '../state.js';
import { WaveDirector } from '../waves.js';
import { LevelSystem } from './LevelSystem.js';

/**
 * The crowd that makes a level a fight, let in over time instead of all at once. Game Foundry's
 * shell does the same with the same curve (`game/sdk/waves/`, driven by `GameShell.releaseWaves`).
 *
 * `LevelSystem` holds every hostile back at load (`waveHold`), except set dressing a level holds
 * one of (`spawnScope: once_per_level`) and anything a game holds back for itself (`holdBack`, a
 * game's bosses). This lets them in through `LevelSystem.release`, paced by `waves.js`:
 *
 * - A few at first, more each wave, never more alive at once than the wave allows.
 * - A kill that opens a slot brings the next one in — no hunting a straggler to keep things moving.
 * - A field cleared to nothing gets the between-waves pause, counted down on the HUD (`status`).
 * - While the level is still being played, a crowd that has all been let in goes round again with
 *   fresh indices (`LevelSystem.repeatSpot`), so a survival clock or a kill count is never left
 *   with nothing to fight. A level with no win or lose conditions simply runs out: "Area clear".
 *
 * Only whoever runs the zombies decides — alone, or the host. A guest never releases anything on
 * its own; it lets in whatever the host's snapshot names, which is how bosses already arrive.
 */
export class WaveSystem extends createSystem({
  actors: { required: [Actor] },
}) {
  init() {
    this.levels = this.world.getSystem(LevelSystem);
    this.levels.waveHold = (entity) => isHostileToPlayer(entity.role) && entity.spawnScope !== 'once_per_level';
    /** The crowd's spawn indices this level, in order: what each round of refills repeats. */
    this.crowd = [];
    this.rounds = 0;
    this.levelKey = null;
    this.director = new WaveDirector({
      onWaveStart: (wave) => emit('message', { text: `Wave ${wave.ordinal} — ${wave.size} incoming`, tone: 'bad', shared: true }),
      onComplete: () => this.refill(),
    });

    this.cleanupFuncs.push(
      on('level-loading', () => {
        this.director.reset();
        this.levelKey = null;
      }),
    );
  }

  /** Where the fight is, for the HUD. Null with no waves running. */
  get status() {
    return this.levelKey === run.levelKey ? this.director.status : null;
  }

  /** The level's crowd, sent round again while the level still has a verdict to reach. */
  refill() {
    const level = this.levels.level;
    const ends = Boolean(level?.completion && (level.completion.win?.length || level.completion.lose?.length || level.completion.timeLimitSeconds));
    if (run.phase === 'playing' && ends && this.crowd.length > 0) {
      this.rounds += 1;
      const stride = level.spawns.length;
      this.director.enqueue(this.crowd.map((index) => index + this.rounds * stride));
      return;
    }
    emit('message', { text: 'Area clear', tone: 'good', shared: true });
  }

  update(delta) {
    if (run.phase !== 'playing' || this.world.net?.follower) return;

    if (this.levelKey !== run.levelKey) {
      // The first frame of a level this machine runs (or the first since it became the host): the
      // crowd still held is what is left to send. Bosses and a game's own holds are not ours.
      this.levelKey = run.levelKey;
      this.rounds = 0;
      this.crowd = [...this.levels.held.entries()]
        .filter(([, spot]) => {
          const entity = GAME.entities[spot.placement.entity];
          return entity && this.levels.waveHold(entity) && !this.levels.holdBack?.(entity);
        })
        .map(([index]) => index)
        .sort((a, b) => a - b);
      this.director.setQueue(this.crowd);
      if (this.crowd.length > 0) {
        console.log(`[waves] ${run.levelKey}: ${this.crowd.length} hostile(s) over ${this.director.waves.length} wave(s).`);
      }
    }

    let alive = 0;
    for (const entity of this.queries.actors.entities) {
      if (entity.getValue(Actor, 'state') === 'dead') continue;
      if (isHostileToPlayer(entity.object3D?.userData.entity?.role)) alive += 1;
    }
    for (const index of this.director.update(delta, alive)) void this.levels.release(index);
  }
}
