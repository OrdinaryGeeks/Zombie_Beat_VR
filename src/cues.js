import { Group, Vector3, createSystem } from '@iwsdk/core';
import { VFX } from './content/vfx.js';

/**
 * Designed effects: the ones cued on animation takes, and the ones attacks fire.
 *
 * The effects are drawn by Game Foundry's own effect code, shipped unchanged in `src/vfx/` (Vite
 * reads its TypeScript as it is). They are found through a glob, so an export without that folder
 * still builds and plays — with no effects.
 *
 * ## Cues follow the clip, not the caller
 *
 * A cue sheet fires on a take. Here a take is a clip baked into a character model, played by
 * whoever animates that character — the NPC system, a game's own systems, a remote player's body.
 * Rather than ask each of them to report what it played, `attachCues` registers a character's
 * mixer once and `CueSystem` watches it: when a clip made from a cued take starts (or loops back
 * to its start), its sheet starts with it, and each effect fires on its bone at its moment.
 *
 * A body that leaves the scene lets go of what it was following, and its effects in flight finish
 * before they are freed — a zombie killed mid-burst does not leave its sparks hanging in the air.
 */

const RUNTIME = import.meta.glob(['./vfx/Vfx.ts', './vfx/VfxCues.ts'], { eager: true });
const Vfx = RUNTIME['./vfx/Vfx.ts'] ?? null;
const Cues = RUNTIME['./vfx/VfxCues.ts'] ?? null;

/** Seconds a removed body's effects are given to finish before they are freed. */
const LINGER_SECONDS = 6;

/** Most designed effects one attack keeps in flight at once; a busier swing reuses the oldest. */
const MAX_PER_ATTACK = 4;

const resolve = (path) => `${import.meta.env.BASE_URL}${(VFX.textures[path] ?? path).replace(/^\//, '')}`;

const effectFor = (id) => {
  const spec = VFX.effects[id];
  return Vfx && Vfx.isVfxSpec(spec) ? new Vfx.VfxSystem(spec, resolve) : null;
};

/** Sheets parsed once, by take file. */
const sheets = new Map();
const sheetFor = (file) => {
  if (!sheets.has(file)) sheets.set(file, Cues?.cueSheetFrom(VFX.cues[file]) ?? undefined);
  return sheets.get(file);
};

const watched = new Set();
const isInScene = (object) => {
  let node = object;
  while (node.parent) node = node.parent;
  return node.isScene === true;
};

/**
 * Watches a character's clips for cued takes. `model` is its `public/` path, as content names it;
 * `clips` the animations its GLB carried. A no-op for a model with no cued clips, which is most.
 */
export function attachCues(body, model, clips, mixer) {
  if (!Cues || !mixer || !clips?.length) return;
  const files = VFX.clips[model];
  if (!files) return;

  const watches = [];
  for (const clip of clips) {
    const file = files[clip.name];
    if (!file || !sheetFor(file)) continue;
    const track = new Cues.VfxCueTrack({ sheetFor, createEffect: effectFor, rig: () => body });
    watches.push({ clip, file, track, wasRunning: false, last: 0 });
  }
  if (watches.length > 0) watched.add({ body, mixer, watches, seen: false, gone: 0 });
}

const performers = new Set();
/** Turns a point's +Z, which cues treat as forward (a Synty body faces +Z), to look along -Z. */
const FACE_FORWARD = Math.PI;

/**
 * Cues for a performer with no body to play them on — the player, seen in first person.
 *
 * Every bone a cue names is taken to be one point, `point`, which the caller parents wherever the
 * performance happens (a controller, or a spot in front of the camera) with `mount`. Cues then fire
 * from there, aimed the way that point looks. `play` follows the game's rule for a take: it starts
 * the take's sheet unless the take is already running, and the take runs for `seconds`, so a press
 * every beat keeps one performance going and its cues are reached.
 */
export function createPerformer() {
  const point = new Group();
  point.name = 'performer';
  // The cue runner asks the rig for a bone by name; here every name is this one point.
  point.getObjectByName = () => point;

  const performer = {
    point,
    file: null,
    clock: 0,
    seconds: 0,
    running: false,
    track: Cues ? new Cues.VfxCueTrack({ sheetFor, createEffect: effectFor, rig: () => point }) : null,

    /** Parents the point at `position` (a Vector3) under `parent`, facing the way it does. */
    mount(parent, position) {
      if (point.parent !== parent) parent.add(point);
      point.position.copy(position);
      point.rotation.set(0, FACE_FORWARD, 0);
    },

    /** Starts the take from `file` unless it is running. False when it has no cues to play. */
    play(file, seconds) {
      if (!performer.track || !sheetFor(file)) return false;
      if (performer.running && performer.file === file) return true;
      performer.file = file;
      performer.clock = 0;
      performer.seconds = seconds;
      performer.running = true;
      performer.track.start(file);
      return true;
    },
  };
  performers.add(performer);
  return performer;
}

/** The pool behind `playAttackEffect`, by effect id. */
const attackPools = new Map();
const emitter = { origin: new Vector3(), direction: new Vector3(0, 0, 1), focus: 0, spawnRadius: 0, spawnHeight: 0 };

/**
 * Fires an attack's designed effect, when it has one, at `origin` pointing along `direction`.
 * True when it did, so a caller can skip its plain stand-in.
 */
export function playAttackEffect(scene, attack, origin, direction) {
  const id = attack?.vfx;
  if (!id || !Vfx || !VFX.effects[id]) return false;
  let pool = attackPools.get(id);
  if (!pool) attackPools.set(id, (pool = []));
  let system = pool.find((candidate) => !candidate.active);
  if (!system) {
    if (pool.length < MAX_PER_ATTACK) {
      system = effectFor(id);
      if (!system) return false;
    } else {
      // Every one is busy: the one fired longest ago starts over.
      system = pool.shift();
    }
    pool.push(system);
  }
  if (!system.object3d.parent) scene.add(system.object3d);
  emitter.origin.copy(origin);
  emitter.direction.copy(direction);
  system.burst(emitter);
  return true;
}

/** Steps every watched character's cues and every attack effect in flight. Register it last. */
export class CueSystem extends createSystem({}) {
  init() {
    this.elapsed = 0;
  }

  update(delta) {
    this.elapsed += delta;

    for (const entry of watched) {
      const present = isInScene(entry.body);
      if (present) entry.seen = true;

      for (const watch of entry.watches) {
        const action = present ? entry.mixer.existingAction(watch.clip) : null;
        const running = !!action && action.isRunning() && action.getEffectiveWeight() > 0.01;
        const time = action?.time ?? 0;
        // Started, restarted for another swing, or looped round: the sheet begins again.
        if (running && (!watch.wasRunning || time + 1e-3 < watch.last)) watch.track.start(watch.file);
        else if (!running && watch.wasRunning) watch.track.stop();
        watch.wasRunning = running;
        watch.last = time;
        watch.track.update(delta);
      }

      // Only once it has been in the scene: a body still being dressed is not gone yet.
      if (!present && entry.seen) {
        entry.gone += delta;
        if (entry.gone > LINGER_SECONDS) {
          for (const watch of entry.watches) watch.track.dispose();
          watched.delete(entry);
        }
      }
    }

    for (const performer of performers) {
      if (performer.running) {
        performer.clock += delta;
        if (performer.clock >= performer.seconds) {
          performer.running = false;
          performer.track.stop();
        }
      }
      performer.track?.update(delta);
    }

    for (const pool of attackPools.values()) {
      for (const system of pool) system.update(delta, this.elapsed);
    }
  }
}
