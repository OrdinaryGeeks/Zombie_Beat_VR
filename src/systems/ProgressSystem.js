import { InputComponent, Vector3, createSystem } from '@iwsdk/core';
import { Actor } from '../components.js';
import { GAME } from '../content/game.js';
import { judgeLevel, nextLevelKey, questComplete } from '../rules.js';
import { LOOT_GRACE_SECONDS, emit, on, run } from '../state.js';
import { LevelSystem } from './LevelSystem.js';
import { PlayerSystem } from './PlayerSystem.js';

const feet = new Vector3();

/** How close counts as "talking to" a quest giver or "finding" someone. */
const MEET_METRES = 3;
/** A trigger pulled this soon after the end is the fight's last swing, not a request to move on. */
const SKIP_AFTER = 1;

/**
 * Quests and level ends: offering quests when you walk up to their giver, counting objectives,
 * paying rewards, and judging the level's win and lose conditions against `run`.
 *
 * A level that ends gives the player `LOOT_GRACE_SECONDS` to collect what the fight dropped
 * (`run.lootGrace`, counted down on the HUD) before anything else happens. Enter, the right
 * trigger or the HUD's button ends it early.
 *
 * A level that ends moves on by itself — the retry, or the next level — unless a game's add-on set
 * `world.flow = { ownsMenu, onLevelEnd(level, status) }`, in which case that is called instead and
 * the add-on loads whatever comes next (`LevelSystem.load`).
 */
export class ProgressSystem extends createSystem({
  actors: { required: [Actor] },
}) {
  init() {
    this.judgeIn = 0;
    this.endIn = 0;
    this.board = { status: 'active', lines: [] };
    this.cleanupFuncs.push(on('level-start', ({ level }) => {
      this.board = judgeLevel(level, run);
      // Quests nobody gives are simply available in the levels they are scoped to.
      for (const quest of Object.values(GAME.quests)) {
        if (!quest.giver && this.inScope(quest, level.key)) this.accept(quest);
      }
    }));
  }

  inScope(quest, levelKey) {
    return quest.levels.length === 0 || quest.levels.includes(levelKey);
  }

  accept(quest) {
    if (run.quests[quest.key]) return;
    if (run.playerLevel < quest.minPlayerLevel) return;
    run.quests[quest.key] = {
      status: 'active',
      acceptedAt: run.elapsed,
      killsAtAccept: { ...run.lifetimeKills },
    };
    emit('message', { text: `Quest: ${quest.name}`, tone: 'info' });
  }

  /** Ends the loot grace now. Only whoever judges the level decides when it moves on. */
  skipLootGrace() {
    if ((run.phase !== 'won' && run.phase !== 'lost') || this.world.net?.follower) return;
    this.endIn = 0;
    run.lootGrace = 0;
  }

  update(delta) {
    if (run.lootGrace > 0) {
      run.lootGrace = Math.max(0, run.lootGrace - delta);
      const pad = this.input.gamepads.right;
      const waited = LOOT_GRACE_SECONDS - run.lootGrace >= SKIP_AFTER;
      if (this.input.keyboard.getKeyDown('Enter') || (waited && pad?.getButtonDown(InputComponent.Trigger))) this.skipLootGrace();
    }
    // A guest playing together: the host judges the level and says when it ends (`world.net`).
    if (this.world.net?.follower) return;
    if (run.phase === 'won' || run.phase === 'lost') {
      this.endIn -= delta;
      if (this.endIn <= 0) {
        run.lootGrace = 0;
        this.advance();
      }
      return;
    }
    if (run.phase !== 'playing') return;
    run.elapsed += delta;

    const player = this.world.getSystem(PlayerSystem).getFeet(feet);
    for (const entity of this.queries.actors.entities) {
      if (entity.getValue(Actor, 'state') === 'dead') continue;
      const position = entity.object3D.position;
      if (Math.hypot(position.x - player.x, position.z - player.z) > MEET_METRES) continue;
      const key = entity.getValue(Actor, 'key');
      if (!run.found.has(key)) {
        run.found.add(key);
        entity.setValue(Actor, 'found', true);
        emit('found', { key });
      }
      for (const quest of Object.values(GAME.quests)) {
        if (quest.giver === key && this.inScope(quest, run.levelKey)) this.accept(quest);
      }
    }

    for (const quest of Object.values(GAME.quests)) {
      const state = run.quests[quest.key];
      if (state?.status !== 'active') continue;
      if (questComplete(quest, run, state)) {
        state.status = 'completed';
        for (const reward of quest.rewards) run.addLoot(reward.lootItemKey, reward.quantity);
        emit('message', { text: `Quest complete: ${quest.name}`, tone: 'good' });
      } else if (quest.timeLimitSeconds > 0 && run.elapsed - state.acceptedAt > quest.timeLimitSeconds) {
        state.status = 'failed';
        emit('message', { text: `Quest failed: ${quest.name}`, tone: 'bad' });
      }
    }

    this.judgeIn -= delta;
    if (this.judgeIn > 0) return;
    this.judgeIn = 0.25;
    const level = this.world.getSystem(LevelSystem).level;
    if (!level) return;
    this.board = judgeLevel(level, run);
    if (this.board.status === 'won' || this.board.status === 'lost') {
      run.phase = this.board.status;
      run.lootGrace = LOOT_GRACE_SECONDS;
      this.endIn = LOOT_GRACE_SECONDS;
      emit('level-end', { level, status: this.board.status });
      emit('message', {
        text: this.board.status === 'won' ? `${level.name} complete!` : `${level.name} failed. Retrying...`,
        tone: this.board.status === 'won' ? 'good' : 'bad',
      });
    }
  }

  advance() {
    const levels = this.world.getSystem(LevelSystem);
    const level = levels.level;
    // A game with its own between-levels screen (`world.flow`, set by its add-on) decides what next.
    if (this.world.flow?.onLevelEnd) {
      if (run.phase === 'won') run.wonLevels.add(level.key);
      const status = run.phase;
      run.phase = 'menu';
      this.world.flow.onLevelEnd(level, status);
      return;
    }
    if (run.phase === 'lost') {
      void levels.load(level.key);
      return;
    }
    run.wonLevels.add(level.key);
    const next = nextLevelKey(level);
    if (next) void levels.load(next);
    else {
      run.phase = 'complete';
      emit('game-complete', {});
    }
  }
}
