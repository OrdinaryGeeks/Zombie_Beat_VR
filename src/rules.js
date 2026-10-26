/**
 * The game's rules, as plain functions with no three.js or IWSDK in them.
 *
 * In Game Foundry these decisions belonged to the arcade server: it resolved stats, rolled loot and
 * judged whether a level was won. This standalone copy has no server, so they live here instead —
 * small, pure, and the first place to look when you want the game to play differently.
 */

import { GAME } from './content/game.js';

// ── Friend or foe ───────────────────────────────────────────────────────────────────────────────

/** `player` | `hostile` | `wild` | `passive`. */
export function factionOf(role) {
  switch (role) {
    case 'ally':
    case 'summon':
      return 'player';
    case 'enemy':
      return 'hostile';
    case 'feral':
      return 'wild';
    default:
      return 'passive';
  }
}

export function areFactionsHostile(a, b) {
  if (a === 'passive' || b === 'passive') return false;
  return a !== b;
}

export function isHostileToPlayer(role) {
  return areFactionsHostile(factionOf(role), 'player');
}

/** Noncombatants cannot be hurt, so a stray swing never kills a quest giver. */
export function isAttackable(role) {
  return role !== 'noncombatant';
}

// ── Damage ──────────────────────────────────────────────────────────────────────────────────────

/**
 * One hit's damage from a damage-per-second figure and the attack delivering it.
 *
 * The attack's cooldown is how often it lands, so dps × cooldown is what one landing is worth;
 * `scalerCoefficientPct` then scales it the way the attack was authored.
 */
export function hitDamage(dps, attack) {
  const interval = Math.max(0.5, attack?.cooldownSeconds || 1);
  const pct = (attack?.scalerCoefficientPct ?? 100) / 100;
  return Math.max(1, dps * interval * pct);
}

/** Armour removes a fraction of what lands. */
export function mitigate(damage, mitigation) {
  return damage * (1 - Math.min(0.9, Math.max(0, mitigation || 0)));
}

/** Stun seconds for an attack landing on an archetype; bosses shrug most of it off. */
export function stunSeconds(stunPower, archetype, random = Math.random) {
  const resist = { minion: 1, standard: 0.8, elite: 0.5, boss: 0.25 }[archetype] ?? 0.8;
  const chance = Math.min(0.9, (0.05 + (stunPower || 0) * 0.15) * resist);
  return random() < chance ? 0.4 + (stunPower || 0) * 0.3 : 0;
}

// ── Loot ────────────────────────────────────────────────────────────────────────────────────────

/**
 * Rolls a loot table: `rollsMin..rollsMax` weighted picks, plus every entry with an independent
 * chance rolled on its own. Returns `[{ lootKey, quantity }]`.
 *
 * `firstKill` honours the table's guaranteed first-kill item.
 */
export function rollLoot(tableKey, playerLevel, { firstKill = false, rewards = 1, random = Math.random } = {}) {
  const table = GAME.lootTables[tableKey];
  if (!table) return [];
  const drops = [];
  const eligible = table.entries.filter(
    (e) => playerLevel >= (e.minPlayerLevel ?? 1) && playerLevel <= (e.maxPlayerLevel ?? 999) && GAME.loot[e.lootItemKey],
  );
  const quantityOf = (e) => {
    const min = e.quantityMin ?? 1;
    const max = Math.max(min, e.quantityMax ?? min);
    return min + Math.floor(random() * (max - min + 1));
  };

  if (firstKill && table.guaranteedFirstKillLootItemKey && GAME.loot[table.guaranteedFirstKillLootItemKey]) {
    drops.push({ lootKey: table.guaranteedFirstKillLootItemKey, quantity: 1 });
  }

  for (const entry of eligible) {
    if (entry.independentDropChancePct != null && random() * 100 < entry.independentDropChancePct) {
      drops.push({ lootKey: entry.lootItemKey, quantity: quantityOf(entry) });
    }
  }

  const weighted = eligible.filter((e) => e.independentDropChancePct == null && (e.weight ?? 1) > 0);
  const total = weighted.reduce((sum, e) => sum + (e.weight ?? 1), 0);
  const rollsMin = table.rollsMin ?? 1;
  const rolled = rollsMin + Math.floor(random() * (Math.max(rollsMin, table.rollsMax ?? rollsMin) - rollsMin + 1));
  const rolls = scaleCount(rolled, rewards, random);
  for (let i = 0; i < rolls && total > 0; i++) {
    let pick = random() * total;
    for (const entry of weighted) {
      pick -= entry.weight ?? 1;
      if (pick <= 0) {
        drops.push({ lootKey: entry.lootItemKey, quantity: quantityOf(entry) });
        break;
      }
    }
  }
  // A handicap's currency is bigger stacks, not more of them; the guarantee is left alone.
  const factor = Math.max(1, rewards || 1);
  const guaranteed = firstKill ? table.guaranteedFirstKillLootItemKey : null;
  return drops.map((drop, i) => (GAME.loot[drop.lootKey]?.lootType === 'currency' && !(i === 0 && drop.lootKey === guaranteed)
    ? { ...drop, quantity: Math.max(1, Math.round(drop.quantity * factor)) }
    : drop));
}

/**
 * `count` × `factor`, the fraction rolled as a chance of one more — so ×1.4 on one pick is a second
 * pick four times in ten. Matches `LootRollService.ScaleCount` in Game Foundry.
 */
export function scaleCount(count, factor, random = Math.random) {
  const scaled = count * Math.max(1, factor || 1);
  const whole = Math.floor(scaled);
  return whole + (random() < scaled - whole ? 1 : 0);
}

// ── Handicap ────────────────────────────────────────────────────────────────────────────────────

/**
 * The step of `GAME.handicap` for raising a board's hostiles `handicap` levels, or null for a board
 * played as written. Matches `handicapStep` in Game Foundry's `game/sdk/types.ts`; the numbers are
 * the server's (`BalanceEngine.HandicapStep`), baked at export.
 */
export function handicapStep(handicap, table = GAME.handicap) {
  if (!table || !(handicap > 0)) return null;
  return table.steps?.find((s) => s.handicap === Math.min(handicap, table.max)) ?? null;
}

/**
 * An entity row as a handicapped board fields it: hp, dps and both rewards multiplied, its level
 * raised. A new object, so `GAME.entities` stays as exported. Anything not hostile to the player
 * comes back untouched — a handicap raises the fight, not the quest giver. Matches `Actor.handicap`
 * in Game Foundry's `game/shell/Actor.ts`.
 */
export function raised(entity, step) {
  if (!step || !(step.handicap > 0) || !areFactionsHostile(factionOf(entity.role), 'player')) return entity;
  return {
    ...entity,
    level: (entity.level ?? 1) + step.handicap,
    hp: entity.hp * step.hp,
    dps: entity.dps * step.dps,
    xpReward: entity.xpReward * step.rewards,
    currencyReward: entity.currencyReward * step.rewards,
    handicap: step.handicap,
  };
}

// ── Experience ──────────────────────────────────────────────────────────────────────────────────

/** XP needed to go from `level` to `level + 1`. Tune `GAME.progression` to change the curve. */
export function xpToNext(level) {
  const { xpBase, xpGrowth } = GAME.progression;
  return Math.round(xpBase * Math.pow(xpGrowth, Math.max(0, level - 1)));
}

// ── Quests ──────────────────────────────────────────────────────────────────────────────────────

/** How far one objective has got, from the run's counters. */
export function objectiveCount(objective, run, questState) {
  switch (objective.type) {
    case 'kill_entities':
      return (run.killsSinceAccepted(questState)[objective.target] ?? 0);
    case 'collect_loot':
      return run.inventoryCount(objective.target);
    case 'collect_currency':
      return run.currencies[objective.target] ?? Object.values(run.currencies).reduce((a, b) => a + b, 0);
    case 'find_entity':
      return run.found.has(objective.target) ? 1 : 0;
    case 'reach_level':
      return run.playerLevel;
    default:
      return 0;
  }
}

export function questComplete(quest, run, questState) {
  return quest.objectives
    .filter((o) => !o.optional)
    .every((o) => objectiveCount(o, run, questState) >= Math.max(1, o.amount));
}

// ── Level end ───────────────────────────────────────────────────────────────────────────────────

/**
 * Judges a level's board. Returns `{ status: 'active' | 'won' | 'lost', lines }`, where each line is
 * `{ side, description, current, target, met }` for the HUD.
 */
export function judgeLevel(level, run) {
  const completion = level.completion;
  if (!completion) return { status: 'active', lines: [] };

  const line = (side, condition) => {
    const target = Math.max(1, condition.amount || 1);
    let current = 0;
    switch (condition.conditionType) {
      case 'complete_quests': {
        const keys = condition.questKeys ?? [];
        current = keys.filter((k) => run.quests[k]?.status === 'completed').length;
        return { side, description: condition.description, current, target: Math.max(1, keys.length), met: current >= Math.max(1, keys.length) };
      }
      case 'kill_entities':
        current = condition.targetKey ? run.kills[condition.targetKey] ?? 0 : run.totalKills;
        break;
      case 'collect_loot':
        current = run.inventoryCount(condition.targetKey);
        break;
      case 'find_entity':
        current = run.found.has(condition.targetKey) ? 1 : 0;
        break;
      case 'survive': {
        const seconds = condition.amount || completion.timeLimitSeconds || 60;
        return { side, description: condition.description, current: Math.floor(run.elapsed), target: seconds, met: run.elapsed >= seconds };
      }
      case 'player_deaths':
        current = run.deaths;
        break;
      case 'quest_failed': {
        const keys = condition.questKeys ?? [];
        current = keys.filter((k) => run.quests[k]?.status === 'failed').length;
        return { side, description: condition.description, current, target: 1, met: current >= 1 };
      }
      default:
        break;
    }
    return { side, description: condition.description, current: Math.min(current, target), target, met: current >= target };
  };

  const win = completion.win.map((c) => line('win', c));
  const lose = completion.lose.map((c) => line('lose', c));
  const lines = [...win, ...lose];

  if (completion.timeLimitSeconds > 0) {
    const left = Math.max(0, completion.timeLimitSeconds - run.elapsed);
    lines.push({ side: 'lose', description: 'Time left', current: Math.ceil(left), target: completion.timeLimitSeconds, met: left <= 0 });
  }

  if (lose.some((l) => l.met)) return { status: 'lost', lines };
  const won = win.length > 0 && (completion.winWhen === 'any' ? win.some((l) => l.met) : win.every((l) => l.met));
  if (won) return { status: 'won', lines };
  if (completion.timeLimitSeconds > 0 && run.elapsed >= completion.timeLimitSeconds) return { status: 'lost', lines };
  return { status: 'active', lines };
}

/** Where a won level leads: its authored continuation, else the next level that waits on it. */
export function nextLevelKey(level) {
  if (level.next && GAME.levels.some((l) => l.key === level.next)) return level.next;
  const after = GAME.levels.filter((l) => l.ordinal > level.ordinal).sort((a, b) => a.ordinal - b.ordinal);
  return (after.find((l) => l.unlockAfterLevelKeys.includes(level.key)) ?? after[0])?.key ?? null;
}
