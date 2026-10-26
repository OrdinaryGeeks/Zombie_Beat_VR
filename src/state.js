import { GAME } from './content/game.js';
import { xpToNext } from './rules.js';

/**
 * Everything about the current playthrough that is not a scene object: the player's health and
 * bag, quest progress, and the counters a level is judged on.
 *
 * One plain object shared by every system. `on`/`emit` is how systems tell each other what
 * happened (`kill`, `pickup`, `message`, ...) without importing one another.
 *
 * Two of them exist for a game played together, where only the host runs the world: a `message`
 * with `shared: true` is about the world rather than this player (a wave, a boss), so the host
 * passes it on to every guest; and `actor-attack` (`{ entity, attack, target }`) is every attack
 * an actor really makes, so the host can have each guest draw it too.
 */

const listeners = new Map();

export function on(type, fn) {
  if (!listeners.has(type)) listeners.set(type, new Set());
  listeners.get(type).add(fn);
  return () => listeners.get(type)?.delete(fn);
}

export function emit(type, detail = {}) {
  for (const fn of listeners.get(type) ?? []) {
    try {
      fn(detail);
    } catch (err) {
      console.error(`[game] A "${type}" listener threw:`, err);
    }
  }
}

/** How long `run.lootGrace` lasts. Matches `GameShell.LOOT_GRACE_SECONDS` in Game Foundry. */
export const LOOT_GRACE_SECONDS = 15;

export const run = {
  /** `menu` | `loading` | `playing` | `won` | `lost` | `complete`. */
  phase: 'menu',
  /**
   * Seconds left to pick up what the fight dropped, after a level is won or lost and before what
   * comes next. The fight is over (`phase` says so) but the ground can still be swept. See
   * `ProgressSystem`.
   */
  lootGrace: 0,
  levelKey: null,
  /**
   * Levels added to every hostile of the boards played from here on, 0 to `GAME.handicap.max`: their
   * hp, dps and what they pay rise as `rules.js`'s `raised` says. The player's choice, kept across
   * levels. Played together, the host's is the room's — only the host spawns the fight.
   * Matches `ShellFlow.handicap` in Game Foundry.
   */
  handicap: 0,
  /** Seconds since the level started. */
  elapsed: 0,

  maxHealth: GAME.player.maxHealth,
  health: GAME.player.maxHealth,
  /** The fraction of incoming damage armour removes. A game's add-on may change it (gear, a stat). */
  mitigation: GAME.player.mitigation,
  deaths: 0,

  playerLevel: GAME.player.startLevel,
  xp: 0,
  currencies: {},
  /** lootKey → quantity. */
  inventory: new Map(),
  /** What the player swings: the starting weapon until a better one is picked up. */
  weapon: { name: 'Starting weapon', attackKey: GAME.player.attackKey, dps: GAME.player.dps },

  /** entityKey → kills this level. */
  kills: {},
  totalKills: 0,
  /** entityKey → kills this whole run, for quests accepted on an earlier level. */
  lifetimeKills: {},
  /** Entity keys the player has walked up to. */
  found: new Set(),
  /** Levels won at least once this run. */
  wonLevels: new Set(),
  /** Loot tables that have dropped once already (for first-kill guarantees). */
  rolledTables: new Set(),

  /** questKey → { status: 'active' | 'completed' | 'failed', acceptedAt, killsAtAccept }. */
  quests: {},

  /** Whether loot can be dropped and picked up: while playing, and during the loot grace after. */
  canCollect() {
    return this.phase === 'playing' || ((this.phase === 'won' || this.phase === 'lost') && this.lootGrace > 0);
  },

  inventoryCount(lootKey) {
    return lootKey ? this.inventory.get(lootKey) ?? 0 : 0;
  },

  /** Kills counted toward a quest: only the ones since it was accepted. */
  killsSinceAccepted(questState) {
    const since = {};
    for (const [key, total] of Object.entries(this.lifetimeKills)) {
      since[key] = total - (questState?.killsAtAccept?.[key] ?? 0);
    }
    return since;
  },

  /** Resets the per-level counters; the bag, XP and finished quests carry over. */
  startLevel(levelKey) {
    this.levelKey = levelKey;
    this.elapsed = 0;
    this.kills = {};
    this.totalKills = 0;
    this.deaths = 0;
    this.found = new Set();
    this.health = this.maxHealth;
    this.lootGrace = 0;
    this.phase = 'playing';
    for (const [key, quest] of Object.entries(this.quests)) {
      // A level retry retries its quests too, rather than leaving them failed forever.
      if (quest.status !== 'completed') delete this.quests[key];
    }
  },

  gainXp(amount) {
    if (!(amount > 0)) return;
    this.xp += amount;
    while (this.xp >= xpToNext(this.playerLevel)) {
      this.xp -= xpToNext(this.playerLevel);
      this.playerLevel += 1;
      this.maxHealth = Math.round(this.maxHealth * GAME.progression.healthPerLevel);
      this.health = this.maxHealth;
      emit('message', { text: `Level up! You are level ${this.playerLevel}.`, tone: 'good' });
    }
  },

  addLoot(lootKey, quantity = 1) {
    const item = GAME.loot[lootKey];
    if (!item) return;
    if (item.lootType === 'currency') {
      const code = item.currencyCode || 'gold';
      this.currencies[code] = (this.currencies[code] ?? 0) + quantity;
    } else if (item.lootType === 'experience') {
      this.gainXp(quantity * Math.max(1, item.itemLevel));
    } else if (item.lootType === 'weapon' && item.dps > this.weapon.dps) {
      this.weapon = { name: item.name, attackKey: item.attackKey ?? this.weapon.attackKey, dps: item.dps };
      emit('message', { text: `Equipped ${item.name}`, tone: 'good' });
    } else if (item.lootType === 'attribute_potion') {
      this.health = Math.min(this.maxHealth, this.health + this.maxHealth * 0.35 * quantity);
    }
    this.inventory.set(lootKey, (this.inventory.get(lootKey) ?? 0) + quantity);
    emit('pickup', { lootKey, quantity });
  },
};
