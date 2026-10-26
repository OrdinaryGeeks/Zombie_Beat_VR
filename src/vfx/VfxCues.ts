import { Quaternion, Vector3 } from 'three';
import type { Object3D } from 'three';
import { isVfxSpec } from './Vfx.js';
import type { VfxSpec } from './Vfx.js';
import type { EmitterState } from './ParticleSystem.js';

/**
 * Effects cued on a take's timeline, and the runner that fires them on a character's bones.
 *
 * A designed effect used to have one way into the game: an attack's tuning blob, fired from where
 * the attack left, in world space, and never attached to anybody. That is right for a fireball in
 * flight and wrong for everything that belongs to a *body* — the embers a hand trails through a
 * throw, the flash at the moment of release, the shockwave under a slam. Those are part of the
 * animation, and they have to start when it does, on the joint it moves.
 *
 * So the unit here is a **cue sheet**, keyed by take: "at 0.42s, fire `fireball` at `Hand_R`";
 * "from 0s, trail `embers` on `Hand_R`". It is authored in the Synty Character Studio against the
 * take playing on a real rig and stored beside the animation bank, and it belongs to the *take
 * key* rather than to a clip file — so a stock take and a published one are cued the same way,
 * and a take republished under the same key keeps its effects.
 *
 * Keyed by take is also what makes it automatic. Anything that plays the take — an attack's
 * `actionClipKey`, an accessory chain step, `playAction` in a module — goes through
 * `CharacterAnimator.playAction`, which starts the sheet. No module has to know cues exist.
 *
 * ## Two modes, because bodies do two things with effects
 *
 * - **`fire`** bursts once, from where the bone is at `atSeconds`, and then leaves it. A muzzle
 *   flash, an impact, a release. The effect finishes its own life in the world even if the hand
 *   moves on — which is what a flash *is*.
 * - **`follow`** opens at `atSeconds` and walks its spawn point with the bone every frame until
 *   `untilSeconds` or the take ends. An aura, a trail, a charging glow. Particles already in flight
 *   stay where they were born, so a swing leaves a trail rather than dragging a rigid ball of fire.
 *
 * ## This file mirrors `src/types/vfxCue.ts`
 *
 * The game cannot import from `src/`; see `Vfx.ts` for the rule and the reason. The pair is pinned
 * by `src/utils/__tests__/vfxCueRoundTrip.test.ts`, which sends a sheet from the studio's writer
 * into this file's reader.
 */

export type VfxCueMode = 'fire' | 'follow';

/**
 * Which way the effect's authored primary axis is pointed when it fires.
 *
 * `forward` is the character's facing — a fireball thrown from the hand goes where the thrower
 * looks. `up` is world up — an aura, a pillar, a charge. Deliberately not a bone's own axis: which
 * axis runs *along* a Synty bone differs from joint to joint, and a choice an author cannot predict
 * from the rig is not a choice.
 */
export type VfxCueAim = 'forward' | 'up';

export interface VfxCue {
  id: string;
  /** A published effect's id — see `VfxSpec.id`. */
  effectId: string;
  /** The joint it rides, by the rig's own name — `Hand_R`, `head`, `Pelvis`. */
  bone: string;
  mode: VfxCueMode;
  /** Seconds into the take. */
  atSeconds: number;
  /** `follow` only: when it stops following and lets its particles finish. Null runs to the take's end. */
  untilSeconds?: number | null;
  /** Metres from the bone, in the character's frame — +Z is the way the character faces. */
  offset: [number, number, number];
  aim: VfxCueAim;
}

export interface VfxCueSheet {
  /** The take key this sheet belongs to. Same namespace as `actionClipKey`. */
  take: string;
  cues: VfxCue[];
  savedAt: string;
}

// ── Reading what the studio saved ──────────────────────────────────────────────────────────

const finite = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

/**
 * A saved sheet, validated, or null when nothing in it can fire.
 *
 * Cues that name no effect or no bone are dropped rather than carried: a cue with no bone has
 * nowhere to fire from, and one with no effect has nothing to fire. Times are clamped to be
 * non-negative, since a cue "before the take starts" is a cue at its start.
 */
export function cueSheetFrom(raw: unknown): VfxCueSheet | null {
  const candidate = raw as Partial<VfxCueSheet> | null;
  if (!candidate || typeof candidate.take !== 'string' || !candidate.take) return null;

  const cues: VfxCue[] = [];
  for (const cue of Array.isArray(candidate.cues) ? candidate.cues : []) {
    if (!cue || typeof cue.effectId !== 'string' || !cue.effectId) continue;
    if (typeof cue.bone !== 'string' || !cue.bone) continue;

    const offset = Array.isArray(cue.offset) ? cue.offset : [0, 0, 0];
    const until = cue.untilSeconds;

    cues.push({
      id: typeof cue.id === 'string' && cue.id ? cue.id : `${cue.effectId}@${cue.bone}`,
      effectId: cue.effectId,
      bone: cue.bone,
      mode: cue.mode === 'follow' ? 'follow' : 'fire',
      atSeconds: Math.max(0, finite(cue.atSeconds, 0)),
      untilSeconds: typeof until === 'number' && Number.isFinite(until) ? Math.max(0, until) : null,
      offset: [finite(offset[0], 0), finite(offset[1], 0), finite(offset[2], 0)],
      aim: cue.aim === 'up' ? 'up' : 'forward'
    });
  }

  if (cues.length === 0) return null;
  return { take: candidate.take, cues, savedAt: typeof candidate.savedAt === 'string' ? candidate.savedAt : '' };
}

const trimBase = (apiBase: string): string => apiBase.trim().replace(/\/+$/, '');

/**
 * Every published effect, by id. Never throws — see `fetchCueSheets`.
 *
 * Only well-formed specs survive, through the same `isVfxSpec` an attack's blob goes through: a
 * half-written effect is dropped here rather than reaching a constructor that assumes the shape.
 */
export async function fetchPublishedEffects(
  apiBase = '',
  fetchImpl: typeof fetch = fetch
): Promise<Map<string, VfxSpec>> {
  const effects = new Map<string, VfxSpec>();
  try {
    const response = await fetchImpl(`${trimBase(apiBase)}/api/VfxBank/effects`);
    if (!response.ok) {
      if (response.status !== 404) console.warn(`[Vfx] Published effects unavailable (HTTP ${response.status}).`);
      return effects;
    }
    const body = await response.json();
    for (const spec of Array.isArray(body) ? body : []) {
      if (isVfxSpec(spec)) effects.set(spec.id, spec);
    }
  } catch (error) {
    console.warn('[Vfx] Published effects could not be read:', error);
  }
  return effects;
}

/**
 * Every saved cue sheet, by take key. Never throws.
 *
 * A backend that is down, a deployment that predates the endpoint, and a body that is not an array
 * all mean the same thing to a game: its takes animate and fire nothing, which is exactly what they
 * did before cues existed.
 */
export async function fetchCueSheets(
  apiBase = '',
  fetchImpl: typeof fetch = fetch
): Promise<Map<string, VfxCueSheet>> {
  const sheets = new Map<string, VfxCueSheet>();
  try {
    const response = await fetchImpl(`${trimBase(apiBase)}/api/VfxBank/cues`);
    if (!response.ok) {
      if (response.status !== 404) console.warn(`[Vfx] Cue sheets unavailable (HTTP ${response.status}).`);
      return sheets;
    }
    const body = await response.json();
    for (const raw of Array.isArray(body) ? body : []) {
      const sheet = cueSheetFrom(raw);
      if (sheet) sheets.set(sheet.take, sheet);
    }
  } catch (error) {
    console.warn('[Vfx] Cue sheets could not be read:', error);
  }
  return sheets;
}

// ── Running a sheet on one character ───────────────────────────────────────────────────────

/**
 * What the runner needs of an effect. `VfxSystem` is one; a test can be another.
 *
 * Structurally the shape `AttackEffect` already has, plus `follow` — so a cue effect is the same
 * pooled, world-space object an attack fires, and nothing about it is a special case.
 */
export interface CueEffect {
  readonly object3d: Object3D;
  readonly active: boolean;
  burst(emitter: EmitterState): void;
  follow(origin: Vector3): void;
  stop(): void;
  clear(): void;
  update(dt: number, elapsed: number): void;
  dispose(): void;
}

export interface VfxCueTrackOptions {
  /** The sheet for a take, or undefined when it has none. */
  sheetFor: (take: string) => VfxCueSheet | undefined;
  /** Builds the effect a cue names, or null when it is not published. Called once per cue. */
  createEffect: (effectId: string) => CueEffect | null;
  /** The rig whose bones cues ride. Re-read each frame, because a recast replaces it. */
  rig: () => Object3D | null;
}

interface CueInstance {
  cue: VfxCue;
  effect: CueEffect;
  fired: boolean;
  /** True once a `follow` cue has let go, so it lets go once. */
  released: boolean;
}

/**
 * Instances are keyed by take *and* cue. A cue's id is only unique within its sheet — two takes may
 * both have a `cue_1`, naming different effects — and sharing one instance between them would fire
 * the first take's effect for the second's cue.
 */
const instanceKey = (take: string, cue: VfxCue): string => `${take}|${cue.id}`;

const FORWARD = new Vector3(0, 0, 1);
const UP = new Vector3(0, 1, 0);

/**
 * One character's cues: which take is running, how far into it, and the effects it has fired.
 *
 * Effects are built the first time their cue fires and kept for the life of the character — a
 * throw thrown forty times is forty bursts of one `VfxSystem`, not forty constructions of it. Each
 * lives at the scene root in world space, the same rule every effect in the game keeps.
 */
export class VfxCueTrack {
  private readonly options: VfxCueTrackOptions;
  private readonly instances = new Map<string, CueInstance>();
  private sheet: VfxCueSheet | null = null;
  private clock = 0;
  private elapsed = 0;
  private running = false;

  private readonly origin = new Vector3();
  private readonly offset = new Vector3();
  private readonly facing = new Quaternion();
  private readonly emitter: EmitterState = {
    origin: new Vector3(),
    direction: new Vector3(0, 1, 0),
    focus: 0,
    spawnRadius: 0,
    spawnHeight: 0
  };

  constructor(options: VfxCueTrackOptions) {
    this.options = options;
  }

  /** The take currently running, or null. */
  get take(): string | null {
    return this.running ? this.sheet?.take ?? null : null;
  }

  /** Seconds into the running take. */
  get time(): number {
    return this.clock;
  }

  /**
   * Starts a take's cues from the top.
   *
   * A take with no sheet stops whatever the previous one was following and fires nothing. Effects
   * the previous take already fired are left to finish in the world: a flash that has gone off has
   * gone off, and cutting it short because the body moved on would read as the effect glitching.
   */
  start(take: string): void {
    this.stop();

    const sheet = this.options.sheetFor(take);
    this.sheet = sheet ?? null;
    this.clock = 0;
    this.running = Boolean(sheet);

    for (const instance of this.instances.values()) {
      instance.fired = false;
      instance.released = false;
    }
  }

  /** Lets go of everything being followed. Anything already fired finishes its own life. */
  stop(): void {
    if (this.running && this.sheet) {
      for (const cue of this.sheet.cues) {
        const instance = this.instances.get(instanceKey(this.sheet.take, cue));
        if (instance && cue.mode === 'follow' && instance.fired && !instance.released) {
          instance.effect.stop();
          instance.released = true;
        }
      }
    }
    this.running = false;
  }

  update(dt: number): void {
    this.elapsed += dt;

    if (this.running && this.sheet) {
      this.clock += dt;
      const rig = this.options.rig();

      for (const cue of this.sheet.cues) {
        if (this.clock < cue.atSeconds) continue;

        const instance = this.instanceFor(this.sheet.take, cue, rig);
        if (!instance) continue;

        if (!instance.fired) {
          if (!this.placeAt(cue, rig)) continue;
          instance.effect.burst(this.emitter);
          instance.fired = true;
          continue;
        }

        if (cue.mode !== 'follow' || instance.released) continue;

        const until = cue.untilSeconds;
        if (until !== null && until !== undefined && this.clock >= until) {
          instance.effect.stop();
          instance.released = true;
          continue;
        }

        if (this.placeAt(cue, rig)) instance.effect.follow(this.emitter.origin);
      }
    }

    // Every effect advances whether or not its take is still running, so a burst outlives the
    // animation that fired it — which is the whole difference between `fire` and `follow`.
    for (const instance of this.instances.values()) instance.effect.update(dt, this.elapsed);
  }

  /** Kills everything, including what is in flight. For a character being removed. */
  dispose(): void {
    for (const instance of this.instances.values()) {
      instance.effect.clear();
      instance.effect.object3d.removeFromParent();
      instance.effect.dispose();
    }
    this.instances.clear();
    this.running = false;
  }

  /**
   * The effect for a cue, built on first use and parked at the scene root.
   *
   * Null while the rig is not in a scene yet — an effect with nowhere to be drawn would fire into
   * nothing, and the cue is simply retried next frame rather than lost.
   */
  private instanceFor(take: string, cue: VfxCue, rig: Object3D | null): CueInstance | null {
    const key = instanceKey(take, cue);
    const existing = this.instances.get(key);
    if (existing) return existing;

    const root = rootOf(rig);
    if (!root) return null;

    const effect = this.options.createEffect(cue.effectId);
    if (!effect) return null;

    root.add(effect.object3d);
    const instance: CueInstance = { cue, effect, fired: false, released: false };
    this.instances.set(key, instance);
    return instance;
  }

  /**
   * Where a cue's effect goes this frame, written into the shared emitter state.
   *
   * The bone's world position, plus the offset turned by the character's facing — so "a hand's
   * width in front" stays in front of a character who turns. False when the bone cannot be found,
   * which is a rig that does not have it: nothing fires rather than something firing at the feet.
   */
  private placeAt(cue: VfxCue, rig: Object3D | null): boolean {
    if (!rig) return false;
    const bone = rig.getObjectByName(cue.bone);
    if (!bone) return false;

    bone.getWorldPosition(this.origin);
    rig.getWorldQuaternion(this.facing);
    this.offset.set(cue.offset[0], cue.offset[1], cue.offset[2]).applyQuaternion(this.facing);

    this.emitter.origin.copy(this.origin).add(this.offset);
    if (cue.aim === 'up') this.emitter.direction.copy(UP);
    else this.emitter.direction.copy(FORWARD).applyQuaternion(this.facing).normalize();

    return true;
  }
}

/** The top of `object`'s branch, or null when it is not attached to anything yet. */
const rootOf = (object: Object3D | null): Object3D | null => {
  if (!object || !object.parent) return null;
  let node = object;
  while (node.parent) node = node.parent;
  return node;
};
