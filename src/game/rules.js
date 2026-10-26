/**
 * Zombie Beat's rules: the four roles, the beat, the band's score, the stage boundary, the bosses
 * and the Boss Hunt.
 *
 * Pure: numbers in, numbers out, so they can be checked with no scene (see
 * `src/xrExport/__tests__/zombieBeatAddon.test.ts` in Game Foundry). The in-app version of the
 * same game keeps a TypeScript copy in `game/games/zombie-beat/`; this export resolves its own
 * combat, so here the beat also decides how hard a hit lands.
 */

/** Where the props land under `public/`. Game Foundry's exporter copies them there. */
const PROP = {
  guitar: 'assets/props/Prop_Guitar_Electric_02.glb',
  drums: 'assets/props/Prop_Drum_Kit_02.glb',
  mic: 'assets/props/Prop_Microphone_BlackSilver_01.glb',
  classicGuitar: 'assets/props/Prop_Guitar_Electric_01.glb',
  classicDrums: 'assets/props/Prop_Drum_Kit_01.glb',
  classicMic: 'assets/props/Prop_Microphone_Vintage_01.glb',
  coin: 'assets/props/Prop_Coin_Encore_01.glb',
  trophy: 'assets/props/Prop_Trophy_Encore_01.glb',
};

/**
 * A turn about Z before an instrument is held. The classic guitar and mic lie along X, which is
 * how the hand, the grip and the flat-screen view were tuned; the Horizon ones stand up along Y.
 */
const STAND_TO_LIE = Math.PI / 2;

/**
 * The band. `attackKey` names the content attack the role plays through when the pack has it;
 * `wave` is the shape it is delivered in.
 *
 * - **cone:** a wide swing ahead, hitting everything in it.
 * - **ring:** a shockwave all round the drummer.
 * - **beam:** a sung note fired down the line, the longest reach.
 * - **spin:** a short-range spin that staggers.
 */
export const ROLES = [
  {
    key: 'guitarist', label: 'Guitarist', hotkey: 'Digit1', color: 0xff3d7f,
    blurb: 'Power chords: a wide cone of sound ahead of you.',
    attackKey: 'guitar_power_swing', prop: PROP.guitar, mount: 'hand', sizeM: 0.95, turnZ: STAND_TO_LIE,
    seat: { x: 0, z: 0 }, wave: 'cone', damage: 1,
  },
  {
    key: 'drummer', label: 'Drummer', hotkey: 'Digit2', color: 0xffb020,
    blurb: 'At the kit: every hit is a shockwave round the stage.',
    attackKey: 'drumstick_flurry', prop: PROP.drums, mount: 'stage', sizeM: 1.7, turnZ: 0,
    seat: { x: 0, z: 1.1 }, wave: 'ring', damage: 0.75,
  },
  {
    key: 'singer', label: 'Singer', hotkey: 'Digit3', color: 0x38e0ff,
    blurb: 'Sing a beam of notes down the line.',
    attackKey: 'mic_stand_swipe', prop: PROP.mic, mount: 'hand', sizeM: 0.3, turnZ: STAND_TO_LIE,
    seat: { x: 0, z: 0 }, wave: 'beam', damage: 1.3,
  },
  {
    key: 'dancer', label: 'Dancer', hotkey: 'Digit4', color: 0x9b6bff,
    blurb: 'No instrument: spin on the beat.',
    attackKey: null, prop: null, mount: 'none', sizeM: 0, turnZ: 0,
    seat: { x: 0, z: 0 }, wave: 'spin', damage: 0.85,
  },
];

export const DEFAULT_ROLE = 'guitarist';

export function roleByKey(key) {
  return ROLES.find((r) => r.key === key) ?? ROLES[0];
}

export function nextRole(key) {
  const index = ROLES.findIndex((r) => r.key === key);
  return ROLES[(index + 1) % ROLES.length].key;
}

/**
 * The classic instruments, sold at the merch stand. Worn in the main hand by the role they belong
 * to, one is what that role plays instead of its own. The keys are the loot items' keys.
 */
export const CLASSIC_INSTRUMENTS = [
  { item: 'classic_electric_guitar', role: 'guitarist', prop: PROP.classicGuitar, sizeM: 0.95, turnZ: 0 },
  { item: 'classic_drum_kit', role: 'drummer', prop: PROP.classicDrums, sizeM: 1.7, turnZ: 0 },
  { item: 'classic_vintage_mic', role: 'singer', prop: PROP.classicMic, sizeM: 0.3, turnZ: 0 },
];

/**
 * What a role plays, given the key of what is worn in the main hand: the role's classic when that
 * is it, the role's own otherwise, null for the dancer. `{ prop, sizeM, turnZ }`.
 */
export function instrumentFor(key, mainHand) {
  const role = roleByKey(key);
  if (!role.prop) return null;
  return CLASSIC_INSTRUMENTS.find((c) => c.item === mainHand && c.role === key) ?? role;
}

/** A drop of the game's currency worth this many or more is drawn as a trophy, not a coin. */
export const TROPHY_AT = 40;

/** The model a drop is drawn as, or null for the item's own. */
export function encoreDropModel(item, quantity) {
  if (item?.lootType !== 'currency') return null;
  return quantity >= TROPHY_AT ? PROP.trophy : PROP.coin;
}

export const PROP_PATHS = Object.values(PROP);

// ── the beat ─────────────────────────────────────────────────────────────────────────────────

export const BPM = 112;

/** Milliseconds either side of a beat. */
export const WINDOWS = { perfect: 70, good: 140 };

/** How much harder a hit lands for being on the beat. */
export const GRADE_DAMAGE = { perfect: 1.5, good: 1.15, miss: 0.6 };

export class BeatClock {
  constructor(bpm = BPM) {
    this.bpm = bpm;
    this.secondsPerBeat = 60 / bpm;
  }

  /** The beat `seconds` falls in, and how far through it (0 on the beat). */
  at(seconds) {
    const t = Math.max(0, seconds) / this.secondsPerBeat;
    const beat = Math.floor(t);
    return { beat, phase: t - beat };
  }

  /** A press at `seconds`, judged against the nearest beat. */
  judge(seconds) {
    const t = Math.max(0, seconds) / this.secondsPerBeat;
    const beat = Math.round(t);
    const offsetMs = (t - beat) * this.secondsPerBeat * 1000;
    const distance = Math.abs(offsetMs);
    const grade = distance <= WINDOWS.perfect ? 'perfect' : distance <= WINDOWS.good ? 'good' : 'miss';
    return { grade, offsetMs, beat };
  }
}

// ── the score ────────────────────────────────────────────────────────────────────────────────

export const FRESH_PERFORMANCE = Object.freeze({ combo: 0, best: 0, hype: 0.5 });

const HYPE_FOR = { perfect: 0.06, good: 0.03, miss: -0.05 };

/** What a zombie reaching the centre costs the crowd. */
export const BREACH_HYPE = -0.2;

const clamp01 = (v) => Math.min(1, Math.max(0, v));

export function scorePress(prev, grade) {
  const combo = grade === 'miss' ? 0 : prev.combo + 1;
  return { combo, best: Math.max(prev.best, combo), hype: clamp01(prev.hype + HYPE_FOR[grade]) };
}

export function scoreBreach(prev) {
  return { combo: 0, best: prev.best, hype: clamp01(prev.hype + BREACH_HYPE) };
}

// ── the ultimate ─────────────────────────────────────────────────────────────────────────────

/**
 * Each role's ultimate: the second button, charged by playing on the beat. Matches
 * `game/games/zombie-beat/ultimate.ts` in Game Foundry.
 *
 * `swings` is how many of the role's own on-beat hits one ultimate is worth (per tick for an aura).
 * The shapes, in metres:
 *
 * - **line:** everything within `widthM / 2` of a line `lengthM` long down the aim.
 * - **area:** everything within `radiusM` of the player.
 * - **aura:** everything within `radiusM` of the player, every `tickSeconds` for `seconds`.
 */
export const ULTIMATES = {
  guitarist: {
    label: 'Wall of Sound', blurb: 'A wide blast of power chords down the line ahead.',
    swings: 5, stunPower: 3, shape: { kind: 'line', lengthM: 14, widthM: 5 },
  },
  drummer: {
    label: 'Drop the Beat', blurb: 'One huge hit: a shockwave that floors everything around the kit.',
    swings: 4, stunPower: 6, shape: { kind: 'area', radiusM: 10 },
  },
  singer: {
    label: 'High Note', blurb: 'A long, piercing note through everything in front of you.',
    swings: 6, stunPower: 2, shape: { kind: 'line', lengthM: 22, widthM: 2 },
  },
  dancer: {
    label: 'Floor Fever', blurb: 'The floor lights up around you, hurting every zombie on it for three seconds.',
    swings: 1.2, stunPower: 2, shape: { kind: 'aura', radiusM: 4.5, seconds: 3, tickSeconds: 0.5 },
  },
};

/** What each judged press adds to the meter (0 to 1): ten perfect presses fill it, misses drain it. */
export const ULT_CHARGE = { perfect: 0.1, good: 0.05, miss: -0.05 };

/** How much harder the ultimate lands when its own press is on the beat. */
export const ULT_LANDING = { perfect: 1.5, good: 1.2, miss: 1 };

/**
 * The shortest time a full meter can take, which the host holds a guest's ultimates to: the guest's
 * meter is theirs, so the host cannot check it, only how often it is spent.
 */
export const ULT_MIN_GAP_SECONDS = 10 * (60 / BPM) * 0.9;

export function chargeUltimate(charge, grade) {
  return clamp01(charge + (ULT_CHARGE[grade] ?? ULT_CHARGE.miss));
}

export const ultimateReady = (charge) => charge >= 1 - 1e-9;

/** One ultimate's damage (per tick for an aura), from what one of the role's hits does off the beat. */
export function ultimateDamage(hit, roleKey, landing) {
  const ult = ULTIMATES[roleKey] ?? ULTIMATES.guitarist;
  return Math.max(0, hit) * ult.swings * (ULT_LANDING[landing] ?? 1);
}

/** Whether a target at (x, z) is in a line from (ox, oz) along the unit (dx, dz), `length` long and `width` wide. */
export function inLine(x, z, ox, oz, dx, dz, length, width) {
  const along = (x - ox) * dx + (z - oz) * dz;
  if (along < 0 || along > length) return false;
  const across = Math.abs((x - ox) * dz - (z - oz) * dx);
  return across <= width / 2;
}

// ── the stage ────────────────────────────────────────────────────────────────────────────────

/** How near the centre a zombie has to get to have made it. Metres. */
export const BREACH_RADIUS_M = 2.2;

/** Keeps (x, z) within `radius` of (cx, cz). The band is no longer held to the stage; kept for the rules' own use. */
export function clampToStage(x, z, cx, cz, radius) {
  const dx = x - cx;
  const dz = z - cz;
  const distance = Math.hypot(dx, dz);
  if (distance <= radius) return { x, z, clamped: false };
  if (radius <= 0 || distance === 0) return { x: cx, z: cz, clamped: true };
  const scale = radius / distance;
  return { x: cx + dx * scale, z: cz + dz * scale, clamped: true };
}

export function inCentre(x, z, cx, cz, radius) {
  return Math.hypot(x - cx, z - cz) <= radius;
}

/** Far enough that every zombie on the biggest level hunts the band from where it spawned. */
export function huntRangeFor(levels) {
  let farthest = 0;
  for (const level of levels) {
    for (const spawn of level.spawns ?? []) {
      farthest = Math.max(farthest, Math.hypot(spawn.x - level.playerStart.x, spawn.z - level.playerStart.z));
    }
  }
  return Math.ceil(farthest + 10);
}

// ── bosses ───────────────────────────────────────────────────────────────────────────────────

/** Whether an entity is one of the zombie bosses, which arrive mid-night rather than at the start. */
export const isBoss = (entity) => entity?.archetype === 'boss';

/** The share of a night's goals a boss arrives inside: never in the opening, never at the curtain. */
export const BOSS_WINDOW = [0.25, 0.7];

/** How long a night runs when nothing says: the shortest `survive` goal, else this. */
export const DEFAULT_NIGHT_SECONDS = 150;

/**
 * The goals that end a night, whichever comes first: the smallest any-kill count (null when there
 * is none) and the shortest survive. The same reading as the arcade game's `nightGoals`.
 */
export function nightGoals(level) {
  const completion = level?.completion;
  const win = completion?.win ?? [];
  const kills = win.filter((c) => c.conditionType === 'kill_entities' && !c.targetKey && c.amount > 0).map((c) => c.amount);
  const survive = win.filter((c) => c.conditionType === 'survive')
    .map((c) => c.amount || completion.timeLimitSeconds || 0).filter((s) => s > 0);
  return {
    kills: kills.length > 0 ? Math.min(...kills) : null,
    seconds: survive.length > 0 ? Math.min(...survive) : DEFAULT_NIGHT_SECONDS,
  };
}

/**
 * When each of `count` bosses crashes the show: `{ kills, seconds }`, each at random inside
 * {@link BOSS_WINDOW} of the night's own goal, and it arrives at whichever is reached first. Both,
 * because a night ends on whichever of its goals comes first: cue on time alone and a quick band
 * wins on kills before any boss shows.
 */
export function bossTriggers(level, count, random = Math.random) {
  const goals = nightGoals(level);
  const [from, to] = BOSS_WINDOW;
  const share = () => from + (to - from) * random();
  return Array.from({ length: count }, () => ({
    kills: goals.kills === null ? Infinity : Math.max(1, Math.floor(goals.kills * share())),
    seconds: Math.round(goals.seconds * share()),
  }));
}

/** Whether a boss's cue has come. */
export const bossDue = (trigger, kills, seconds) => kills >= trigger.kills || seconds >= trigger.seconds;

// ── boss hunt ────────────────────────────────────────────────────────────────────────────────

/**
 * The boss keys a board's win conditions name, when every one of them is a kill of a boss; else
 * empty. `entities` is `GAME.entities`, by key. The same reading as the arcade game's `huntTargets`.
 */
export function huntTargets(level, entities) {
  const win = level?.completion?.win ?? [];
  if (win.length === 0) return [];
  const targets = win.map((c) =>
    c.conditionType === 'kill_entities' && c.targetKey && isBoss(entities?.[c.targetKey]) ? c.targetKey : null);
  return targets.every((key) => key !== null) ? [...new Set(targets)] : [];
}

/** Whether a board is a Boss Hunt (no stage; find one boss and kill it) rather than a night on the stage. */
export const isHuntBoard = (level, entities) => huntTargets(level, entities).length > 0;

/** Of the walk from the start to the farthest reachable ground, how far out a hunted boss may hide. */
export const HIDEOUT_SHARE = 0.6;

/**
 * Where a hunted boss hides: a random cell in the far reaches of the ground walkable from `from`.
 *
 * `grid` is `{ cols, rows, originX, originZ, cellSize }` and `walk(cx, cz)` says whether a cell can
 * be stood on. Distance is the walk, found by a flood from the start, so a spot behind a wall is
 * far and a spot on an island nobody can reach is never picked. A cell counts only when its eight
 * neighbours are walkable too, so a boss is never wedged against a wall. Null when nothing fits.
 */
export function pickHideout(grid, walk, from, random = Math.random) {
  const { cols, rows, originX, originZ, cellSize } = grid;
  const open = (cx, cz) => {
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) if (!walk(cx + dx, cz + dz)) return false;
    return true;
  };
  const sx = Math.floor((from.x - originX) / cellSize);
  const sz = Math.floor((from.z - originZ) / cellSize);
  if (!walk(sx, sz)) return null;

  const steps = new Int32Array(cols * rows).fill(-1);
  const queue = new Int32Array(cols * rows);
  let head = 0;
  let tail = 0;
  steps[sz * cols + sx] = 0;
  queue[tail++] = sz * cols + sx;
  let farthest = 0;
  while (head < tail) {
    const at = queue[head++];
    const cx = at % cols;
    const cz = (at - cx) / cols;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = cx + dx;
      const nz = cz + dz;
      if (nx < 0 || nz < 0 || nx >= cols || nz >= rows || !walk(nx, nz)) continue;
      const i = nz * cols + nx;
      if (steps[i] !== -1) continue;
      steps[i] = steps[at] + 1;
      farthest = steps[i];
      queue[tail++] = i;
    }
  }

  const floor = Math.ceil(farthest * HIDEOUT_SHARE);
  const candidates = [];
  for (let i = 0; i < tail; i++) {
    const cell = queue[i];
    const cx = cell % cols;
    if (steps[cell] >= floor && farthest > 0 && open(cx, (cell - cx) / cols)) candidates.push(cell);
  }
  if (candidates.length === 0) return null;
  const pick = candidates[Math.min(candidates.length - 1, Math.floor(random() * candidates.length))];
  const cx = pick % cols;
  const cz = (pick - cx) / cols;
  return { x: originX + (cx + 0.5) * cellSize, z: originZ + (cz + 0.5) * cellSize };
}

/**
 * A hunted boss's own copy of its entity row: it keeps to its hideout (the ordinary notice range
 * and leash) instead of hunting the band from across the level like the rest of the horde. The
 * key is the same, so its kill still counts for the board.
 */
export const hidingRow = (row) => ({ ...row, behavior: 'guard' });

// ── CPU bandmates ────────────────────────────────────────────────────────────────────────────

/** A band is six at most, players and CPU bandmates together: one seat (and one cast character) each. */
export const MAX_BAND = 6;

export const BOT_NAMES = ['Riff', 'Kick', 'Echo', 'Groove', 'Mosh', 'Encore'];

/** How many CPU bandmates fit beside `humans` players when `wanted` were asked for. */
export function botCount(wanted, humans) {
  return Math.max(0, Math.min(Math.floor(wanted) || 0, MAX_BAND - Math.max(1, humans)));
}

/**
 * The roles the CPU bandmates play: whatever nobody is playing yet, in the band's order, then
 * round again, so a solo guitarist gets a drummer, a singer and a dancer before a second guitar.
 */
export function botRoles(humanRoles, count) {
  const taken = new Set(humanRoles);
  const open = ROLES.map((r) => r.key).filter((key) => !taken.has(key));
  const order = open.length > 0 ? [...open, ...ROLES.map((r) => r.key).filter((k) => taken.has(k))] : ROLES.map((r) => r.key);
  return Array.from({ length: count }, (_, i) => order[i % order.length]);
}

/** The seats the CPU bandmates sit in: the lowest ones no player is in, so every body differs. */
export function botSeats(humanSeats, count) {
  const taken = new Set(humanSeats);
  const seats = [];
  for (let seat = 0; seats.length < count && seat < MAX_BAND * 2; seat++) {
    if (!taken.has(seat)) seats.push(seat);
  }
  return seats;
}

/** How close a role has to be to land its swing, in metres: the shapes `BandSystem.deliver` throws. */
export const WAVE_REACH = { cone: 4, ring: 4.5, beam: 14, spin: 2.6 };

/**
 * Whether a CPU bandmate swings on this beat. On the beat, never between, and each on every other
 * beat (alternating by index) so a full band keeps a rhythm rather than hitting as one.
 */
export function botSwingsOn(beat, phase, index, lastBeat) {
  return beat !== lastBeat && phase < 0.15 && (beat + index) % 2 === 0;
}
