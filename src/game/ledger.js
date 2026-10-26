/**
 * A guest's stats, kept by the host.
 *
 * When Zombie Beat is played together the host is the only machine that decides anything: a guest's
 * health, level, XP, gold, weapon and bag live here, on the host, one ledger per guest, and the
 * guest is told what they are (`NetSystem`, message `you`). A guest's own `run` is a display of the
 * last thing the host said.
 *
 * Pure: the game's tuning is passed in, so these rules are checked with no scene
 * (`src/xrExport/__tests__/zombieBeatAddon.test.ts`). They mirror the template's own `run` (`gainXp`,
 * `addLoot`, `CombatSystem.damagePlayer`) so a guest progresses exactly as the host does.
 */

/**
 * A fresh guest: the game's starting player, as `state.js`'s `run` starts.
 * `player` is `GAME.player`.
 */
export function newLedger(player) {
  return {
    hp: player.maxHealth,
    maxHp: player.maxHealth,
    level: player.startLevel ?? 1,
    xp: 0,
    currencies: {},
    weapon: { name: 'Starting weapon', attackKey: player.attackKey ?? null, dps: player.dps },
    bag: {},
    deaths: 0,
  };
}

/**
 * A hit landing on a guest. Mitigated as the host's own hits are. A death puts them back to full
 * health and counts; respawning them is the caller's job.
 */
export function hurt(ledger, amount, mitigation = 0) {
  if (!(amount > 0)) return { died: false };
  const landed = amount * (1 - Math.min(0.9, Math.max(0, mitigation || 0)));
  ledger.hp = Math.max(0, ledger.hp - landed);
  if (ledger.hp > 0) return { died: false };
  ledger.deaths += 1;
  ledger.hp = ledger.maxHp;
  return { died: true };
}

/** XP for a guest, levelling them up as `run.gainXp` does. Returns how many levels they gained. */
export function gainXp(ledger, amount, xpToNext, healthPerLevel) {
  if (!(amount > 0)) return 0;
  ledger.xp += amount;
  let levels = 0;
  while (ledger.xp >= xpToNext(ledger.level)) {
    ledger.xp -= xpToNext(ledger.level);
    ledger.level += 1;
    ledger.maxHp = Math.round(ledger.maxHp * healthPerLevel);
    ledger.hp = ledger.maxHp;
    levels += 1;
  }
  return levels;
}

/**
 * A pickup for a guest, as `run.addLoot`: currency adds up, experience levels, a better weapon is
 * equipped, a potion heals; everything goes in the bag. Returns what happened, for the message.
 */
export function addLoot(ledger, item, quantity, xpToNext, healthPerLevel) {
  if (!item) return 'unknown';
  let outcome = 'bagged';
  if (item.lootType === 'currency') {
    const code = item.currencyCode || 'gold';
    ledger.currencies[code] = (ledger.currencies[code] ?? 0) + quantity;
    outcome = 'currency';
  } else if (item.lootType === 'experience') {
    gainXp(ledger, quantity * Math.max(1, item.itemLevel), xpToNext, healthPerLevel);
    outcome = 'experience';
  } else if (item.lootType === 'weapon' && item.dps > ledger.weapon.dps) {
    ledger.weapon = { name: item.name, attackKey: item.attackKey ?? ledger.weapon.attackKey, dps: item.dps };
    outcome = 'equipped';
  } else if (item.lootType === 'attribute_potion') {
    ledger.hp = Math.min(ledger.maxHp, ledger.hp + ledger.maxHp * 0.35 * quantity);
    outcome = 'healed';
  }
  ledger.bag[item.key] = (ledger.bag[item.key] ?? 0) + quantity;
  return outcome;
}

/** A kill's reward for whoever landed it: its XP and its currency, as `CombatSystem.kill` pays the host. */
export function creditKill(ledger, row, xpToNext, healthPerLevel) {
  const levels = gainXp(ledger, row.xpReward ?? 0, xpToNext, healthPerLevel);
  if (row.currencyReward > 0) ledger.currencies.gold = (ledger.currencies.gold ?? 0) + Math.round(row.currencyReward);
  return levels;
}

/**
 * Where a seat stands on the stage, relative to its role's seat: seat 0 on it, the rest spaced
 * round it, so two players of one role never stand inside each other (and a first-person host is
 * never standing inside a guest).
 */
export function seatSpot(seat, radius = 2.4, seats = 6) {
  if (!(seat > 0)) return { x: 0, z: 0 };
  const angle = ((seat - 1) / Math.max(1, seats - 1)) * Math.PI * 2;
  return { x: Math.sin(angle) * radius, z: Math.cos(angle) * radius };
}

/** What the host tells a guest about themselves. Small: it goes several times a second. */
export function youMessage(ledger, xpToNext) {
  return {
    t: 'you',
    hp: Math.round(ledger.hp),
    mhp: ledger.maxHp,
    lv: ledger.level,
    xp: Math.floor(ledger.xp),
    xpn: xpToNext(ledger.level),
    cur: ledger.currencies,
    w: ledger.weapon,
    bag: ledger.bag,
  };
}
