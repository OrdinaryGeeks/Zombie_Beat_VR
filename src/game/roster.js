/**
 * The band's roster, kept on this device: characters that keep their level, stat points and gear
 * between sessions, the coins the band shares, and the stash gear goes into.
 *
 * In Game Foundry the arcade server keeps the roster (`backend/Services/Arcade/CharacterRules.cs`
 * and `CharacterService.cs`). This export has no server, so the same rules live here, with the same
 * numbers: 3 points a level, training at 100 coins and 100 more each time, +4% damage / +5% health /
 * +6% armour / +3% XP a point, and the same shop prices. The suite checks the figures still match
 * the server's (`src/xrExport/__tests__/zombieBeatAddon.test.ts`).
 *
 * Pure: no three.js and no DOM. Storage is passed in (`localStorage` in the game), so the rules are
 * checked with a plain object.
 */

import { ROLES } from './rules.js';

export const POINTS_PER_LEVEL = 3;
export const MAX_CHARACTERS = 8;
export const MAX_TRAINED_POINTS = 40;
export const TRAIN_BASE_COST = 100;

/** What a point is worth, by the arcade's booster stat names. */
export const ATTRIBUTES = [
  { stat: 'damage', label: 'Power', perPointPct: 4, maxPoints: 50, icon: 'ICON_Inventory_Weapon', blurb: 'Every swing and every ultimate hits harder.' },
  { stat: 'health', label: 'Stamina', perPointPct: 5, maxPoints: 50, icon: 'ICON_Status_Health01', blurb: 'A deeper health pool to play through the horde.' },
  { stat: 'armor', label: 'Grit', perPointPct: 6, maxPoints: 50, icon: 'ICON_Status_Armor', blurb: 'The armour on your gear stops more.' },
  { stat: 'xp_gain', label: 'Showmanship', perPointPct: 3, maxPoints: 30, icon: 'ICON_Map_Star', blurb: 'More XP from every zombie you drop.' },
];

export const attributeRule = (stat) => ATTRIBUTES.find((a) => a.stat === stat) ?? null;

const RARITY_PRICE = { common: 1, uncommon: 1.5, rare: 2.5, epic: 4, legendary: 7, mythic: 12 };

/**
 * How much armour it takes to stop half of a hit, per character level. The server weighs armour
 * against its curve's character power; an export has no curve, so this stands in for it.
 */
export const ARMOR_PER_LEVEL = 25;
/** The most armour can ever stop. */
export const MITIGATION_CAP = 0.75;

// ── points ──────────────────────────────────────────────────────────────────────────────────────

export const pointsEarned = (c) => Math.max(0, c.level - 1) * POINTS_PER_LEVEL + Math.max(0, c.trained);
export const pointsSpent = (c) => Object.values(c.attributes).reduce((sum, v) => sum + Math.max(0, v), 0);
export const pointsUnspent = (c) => Math.max(0, pointsEarned(c) - pointsSpent(c));

/** The next trained point's price, or null at the ceiling. */
export const trainCost = (c) => (c.trained >= MAX_TRAINED_POINTS ? null : TRAIN_BASE_COST * (c.trained + 1));

/** The multiplier a stat's points add up to: 1 with none. */
export function boost(c, stat) {
  const rule = attributeRule(stat);
  const points = Math.min(c?.attributes?.[stat] ?? 0, rule?.maxPoints ?? 0);
  return 1 + ((rule?.perPointPct ?? 0) * Math.max(0, points)) / 100;
}

// ── the shop ────────────────────────────────────────────────────────────────────────────────────

/** Wearable gear is stock; currency, quest items and potions are not. */
export function isStock(item) {
  return Boolean(item) && item.slot && item.slot !== 'none'
    && ['weapon', 'armor', 'equipment'].includes(item.lootType);
}

/** 60 for a common item level 1, compounding 25% per item level, rounded to 5. */
export function price(item) {
  const raw = 60 * (RARITY_PRICE[item.rarity] ?? 1) * Math.pow(1.25, Math.max(0, (item.itemLevel ?? 1) - 1));
  return Math.max(5, Math.round(raw / 5) * 5);
}

export const requiredLevel = (item) => Math.max(1, (item.itemLevel ?? 1) - 2);

/** Why an item cannot be bought right now, or an empty list when it can. */
export function whyNot(save, item) {
  const c = active(save);
  const reasons = [];
  if (!c) return ['Choose a character first.'];
  if (c.level < requiredLevel(item)) reasons.push(`Needs level ${requiredLevel(item)}.`);
  if ((save.stash[item.key] ?? 0) > 0) reasons.push('Already in the stash.');
  else if (save.coins < price(item)) reasons.push(`Costs ${price(item)}.`);
  return reasons;
}

// ── the save ────────────────────────────────────────────────────────────────────────────────────

export const SAVE_VERSION = 1;

export function newSave() {
  return { v: SAVE_VERSION, activeId: null, coins: 0, stash: {}, characters: [], handicap: 0 };
}

export const saveKey = (slug) => `${slug}:roster:v${SAVE_VERSION}`;

/** Reads the roster from `storage`, or a fresh one when there is none or it cannot be read. */
export function loadSave(storage, slug) {
  try {
    const raw = storage?.getItem(saveKey(slug));
    if (!raw) return newSave();
    const parsed = JSON.parse(raw);
    if (parsed?.v !== SAVE_VERSION || !Array.isArray(parsed.characters)) return newSave();
    return {
      v: SAVE_VERSION,
      activeId: typeof parsed.activeId === 'string' ? parsed.activeId : null,
      coins: Math.max(0, Number(parsed.coins) || 0),
      stash: typeof parsed.stash === 'object' && parsed.stash ? parsed.stash : {},
      characters: parsed.characters.filter((c) => c && typeof c.id === 'string').map(cleanCharacter),
      // The board handicap last chosen (`run.handicap`). Clamped to the game's table where it is used.
      handicap: Math.max(0, Math.floor(Number(parsed.handicap) || 0)),
    };
  } catch {
    return newSave();
  }
}

export function writeSave(storage, slug, save) {
  try {
    storage?.setItem(saveKey(slug), JSON.stringify(save));
    return true;
  } catch {
    return false;
  }
}

function cleanCharacter(c) {
  return {
    id: c.id,
    name: String(c.name ?? 'Band member').slice(0, 24),
    role: ROLES.some((r) => r.key === c.role) ? c.role : ROLES[0].key,
    level: Math.max(1, Math.floor(Number(c.level) || 1)),
    xp: Math.max(0, Number(c.xp) || 0),
    attributes: typeof c.attributes === 'object' && c.attributes ? { ...c.attributes } : {},
    trained: Math.max(0, Math.floor(Number(c.trained) || 0)),
    loadout: typeof c.loadout === 'object' && c.loadout ? { ...c.loadout } : {},
  };
}

export const active = (save) => save.characters.find((c) => c.id === save.activeId) ?? null;

// ── changing it: each returns an error sentence, or null when it worked ─────────────────────────

export function createCharacter(save, name, role, startLevel = 1, id = `c${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`) {
  const clean = String(name ?? '').trim();
  if (clean.length === 0 || clean.length > 24) return 'A name is 1 to 24 characters.';
  if (!ROLES.some((r) => r.key === role)) return 'Pick what they play.';
  if (save.characters.length >= MAX_CHARACTERS) return `A roster holds ${MAX_CHARACTERS} characters. Retire one first.`;
  save.characters.push({ id, name: clean, role, level: Math.max(1, startLevel), xp: 0, attributes: {}, trained: 0, loadout: {} });
  save.activeId = id;
  return null;
}

export function selectCharacter(save, id) {
  if (!save.characters.some((c) => c.id === id)) return 'No such character.';
  save.activeId = id;
  return null;
}

export function retireCharacter(save, id) {
  if (save.activeId === id) return 'Switch to another character before retiring this one.';
  const before = save.characters.length;
  save.characters = save.characters.filter((c) => c.id !== id);
  return save.characters.length === before ? 'No such character.' : null;
}

export function allocate(save, stat) {
  const c = active(save);
  const rule = attributeRule(stat);
  if (!c) return 'Choose a character first.';
  if (!rule) return `'${stat}' is not an attribute points can go into.`;
  if (pointsUnspent(c) < 1) return 'No points to spend.';
  if ((c.attributes[stat] ?? 0) + 1 > rule.maxPoints) return `That attribute stops at ${rule.maxPoints} points.`;
  c.attributes[stat] = (c.attributes[stat] ?? 0) + 1;
  return null;
}

export function train(save, stat) {
  const c = active(save);
  const rule = attributeRule(stat);
  if (!c) return 'Choose a character first.';
  if (!rule) return `'${stat}' is not an attribute that can be trained.`;
  const cost = trainCost(c);
  if (cost === null) return 'This character has trained as far as training goes.';
  if ((c.attributes[stat] ?? 0) + 1 > rule.maxPoints) return `That attribute stops at ${rule.maxPoints} points.`;
  if (save.coins < cost) return `Training costs ${cost}; you have ${Math.floor(save.coins)}.`;
  save.coins -= cost;
  c.attributes[stat] = (c.attributes[stat] ?? 0) + 1;
  c.trained += 1;
  return null;
}

export function buy(save, item) {
  if (!isStock(item)) return 'That is not for sale.';
  const reasons = whyNot(save, item);
  if (reasons.length) return `${item.name}: ${reasons.join(' ')}`;
  save.coins -= price(item);
  save.stash[item.key] = 1;
  return null;
}

/** Wears a stash item in its slot, taking off whatever was there. */
export function equip(save, item) {
  const c = active(save);
  if (!c) return 'Choose a character first.';
  if (!isStock(item) || !((save.stash[item.key] ?? 0) > 0)) return `${item?.name ?? 'That'} is not in the stash.`;
  c.loadout[item.slot] = item.key;
  return null;
}

export function unequip(save, item) {
  const c = active(save);
  if (!c) return 'Choose a character first.';
  if (c.loadout[item.slot] === item.key) delete c.loadout[item.slot];
  return null;
}

// ── what the active character plays with ────────────────────────────────────────────────────────

/**
 * The numbers the active character plays with, from the game's starting player (`GAME.player`),
 * its progression (`GAME.progression`) and what they wear.
 *
 * - Health grows `healthPerLevel` a level from the starting player's, then Stamina.
 * - The weapon is the main-hand item worn, else the starting one; Power on top.
 * - Armour is everything else worn, Grit on top, stopping `armour / (armour + 25 × level)` of a
 *   hit, capped at 75%. With nothing worn it is the starting player's own.
 */
export function characterStats(c, game) {
  const { player, progression, loot } = game;
  const levelGap = c.level - (player.startLevel ?? 1);
  const maxHealth = Math.round(player.maxHealth * Math.pow(progression.healthPerLevel, levelGap) * boost(c, 'health'));

  const worn = Object.values(c.loadout).map((key) => loot[key]).filter(Boolean);
  const weaponItem = worn.find((i) => i.lootType === 'weapon' && i.slot === 'main_hand') ?? null;
  const baseDps = weaponItem?.dps > 0 ? weaponItem.dps : player.dps;
  const dps = Math.round(baseDps * boost(c, 'damage') * 10) / 10;

  const armour = worn.filter((i) => i !== weaponItem).reduce((sum, i) => sum + (i.armorValue ?? 0), 0) * boost(c, 'armor');
  const mitigation = armour > 0
    ? Math.min(MITIGATION_CAP, armour / (armour + ARMOR_PER_LEVEL * c.level))
    : player.mitigation ?? 0;

  return {
    maxHealth,
    mitigation: Math.round(mitigation * 1000) / 1000,
    weapon: {
      name: weaponItem?.name ?? 'Starting weapon',
      attackKey: weaponItem?.attackKey ?? player.attackKey ?? null,
      dps,
    },
    xpMultiplier: boost(c, 'xp_gain'),
  };
}

// ── names and boards ────────────────────────────────────────────────────────────────────────────

const STAGE_NAMES = {
  guitarist: ['Riff Raff', 'Axel Rot', 'Shred Ned', 'Fretty Kroger'],
  drummer: ['Bones Malone', 'Snare Bear', 'Kick Jagger', 'Tom Tom'],
  singer: ['Mic Decay', 'Lady Gravel', "Hollerin' Holly", 'Croon Raider'],
  dancer: ['Twitch', 'Shuffle Doom', 'Moonwalker', 'Spin Doctor'],
};

export function suggestName(role, taken, seed = 0) {
  const names = STAGE_NAMES[role] ?? ['New member'];
  const free = names.filter((n) => !taken.includes(n));
  const pool = free.length > 0 ? free : names;
  return pool[Math.abs(Math.floor(seed)) % pool.length];
}

/** How a board is pitched against a character. Advice only: every board is open. */
export function difficulty(characterLevel, recommendedLevel) {
  const gap = recommendedLevel - characterLevel;
  if (gap <= -3) return 'warm-up';
  if (gap <= 1) return 'even';
  if (gap <= 4) return 'tough';
  return 'deadly';
}

/**
 * What a board's handicap does, in a line for the board picker. `step` is `rules.js`'s
 * `handicapStep`, or null for a board played as written. Same text as `handicapLine` in Game
 * Foundry's `game/games/zombie-beat/roster.ts`.
 */
export function handicapLine(step) {
  if (!step || step.handicap <= 0) return 'Played as written. Raise it when the boards get too easy.';
  const x = (n) => `×${n.toFixed(2)}`;
  return `Zombies +${step.handicap} LV: ${x(step.hp)} health, ${x(step.dps)} damage · rewards ${x(step.rewards)}`;
}

export const DIFFICULTY_COLORS = { 'warm-up': '#7dffb0', even: '#ffe27d', tough: '#ffb347', deadly: '#ff5e7a' };
export const RARITY_COLORS = {
  common: '#cbd5e1', uncommon: '#7dffb0', rare: '#5ab8ff', epic: '#c08bff', legendary: '#ffb347', mythic: '#ff5e7a',
};

/** Each role's emblem, and the items' icons — Synty sprite names, as in the in-app game. */
export const ROLE_ICONS = {
  guitarist: 'ICON_Map_Lightning', drummer: 'ICON_Map_Target', singer: 'ICON_Map_Message', dancer: 'ICON_Map_Star',
};

const ITEM_ICONS = {
  shredder_electric_guitar: 'ICON_ZB_Guitar_Shredder',
  hardwood_drumsticks: 'ICON_ZB_Drumsticks',
  vintage_stage_microphone: 'ICON_ZB_Microphone_Vintage',
  concert_earplugs: 'ICON_ZB_Earplugs',
  band_setlist: 'ICON_ZB_Setlist',
  backstage_pass: 'ICON_ZB_Backstage_Pass',
  tour_energy_drink: 'ICON_ZB_Energy_Drink',
  classic_electric_guitar: 'ICON_ZB_Classic_Guitar',
  classic_drum_kit: 'ICON_ZB_Classic_Drum_Kit',
  classic_vintage_mic: 'ICON_ZB_Classic_Mic',
};

export function itemIcon(item) {
  if (ITEM_ICONS[item.key]) return ITEM_ICONS[item.key];
  if (item.lootType === 'weapon') return 'ICON_Inventory_Weapon';
  if (item.slot === 'head') return 'ICON_Inventory_Helmets';
  if (item.lootType === 'armor') return 'ICON_Inventory_Armor';
  return 'ICON_Inventory_Notes';
}
