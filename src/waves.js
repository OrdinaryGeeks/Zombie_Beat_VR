/**
 * When a level's enemies arrive: a wave plan, and a director that meters a queue out against it.
 *
 * A port of Game Foundry's `game/sdk/waves/` (`WavePlan.ts`, `WaveDirector.ts`) — the same curve,
 * the same numbers, the same rules — with no three.js and no IWSDK in it, so it can be read and
 * tested on its own. `WaveSystem` drives it with spawn indices; the director never looks inside one.
 *
 * - The fight opens small and grows: 3, 4, 5, 7, 9… up to `maxWaveSize`, with at most `concurrent`
 *   of a wave alive at once.
 * - A kill that leaves room under the wave's cap brings the next wave in straight away, with no
 *   lead-in — the player never has to hunt down a straggler before anything else will arrive.
 * - The between-waves pause belongs to a cleared field: that is the player's moment to pick up loot.
 * - `maxHoldSeconds` moves the fight on past a wave that is never cleared (an enemy stuck somewhere).
 */

/** The shipped curve. Matches `DEFAULT_WAVE_CURVE` in `game/sdk/waves/WavePlan.ts`. */
export const DEFAULT_WAVE_CURVE = {
  firstWaveSize: 3,
  sizeGrowth: 1,
  sizeMultiplier: 1.12,
  maxWaveSize: 12,
  firstWaveConcurrent: 3,
  concurrentGrowth: 1,
  maxConcurrent: 10,
  leadInSeconds: 4,
  betweenWavesSeconds: 8,
  spacingSeconds: 1.1,
  clearFraction: 0.75,
  maxHoldSeconds: 45,
};

const clamp = (value, low, high) => (Number.isFinite(value) ? Math.min(high, Math.max(low, value)) : low);

/** Forces a partial, possibly nonsensical curve into one `planWaves` can spend. */
export function normalizeCurve(curve = {}) {
  const merged = { ...DEFAULT_WAVE_CURVE, ...curve };
  const maxWaveSize = Math.round(clamp(merged.maxWaveSize, 1, 200));
  const maxConcurrent = Math.round(clamp(merged.maxConcurrent, 1, 200));
  return {
    firstWaveSize: Math.round(clamp(merged.firstWaveSize, 1, maxWaveSize)),
    sizeGrowth: clamp(merged.sizeGrowth, -50, 50),
    sizeMultiplier: clamp(merged.sizeMultiplier, 0.1, 10),
    maxWaveSize,
    firstWaveConcurrent: Math.round(clamp(merged.firstWaveConcurrent, 1, maxConcurrent)),
    concurrentGrowth: clamp(merged.concurrentGrowth, -50, 50),
    maxConcurrent,
    leadInSeconds: clamp(merged.leadInSeconds, 0, 600),
    betweenWavesSeconds: clamp(merged.betweenWavesSeconds, 0, 600),
    spacingSeconds: clamp(merged.spacingSeconds, 0, 60),
    clearFraction: clamp(merged.clearFraction, 0, 1),
    maxHoldSeconds: clamp(merged.maxHoldSeconds, 1, 3600),
  };
}

/** Spends `total` spawns against a curve. The last wave is trimmed, never padded. */
export function planWaves(curve, total) {
  const shape = normalizeCurve(curve);
  const budget = Math.max(0, Math.floor(total));
  const waves = [];
  let remaining = budget;
  let size = shape.firstWaveSize;
  let concurrent = shape.firstWaveConcurrent;
  while (remaining > 0) {
    const thisSize = Math.min(remaining, Math.max(1, Math.round(size)));
    waves.push({
      ordinal: waves.length + 1,
      size: thisSize,
      concurrent: Math.min(thisSize, Math.max(1, Math.round(concurrent))),
      leadInSeconds: waves.length === 0 ? shape.leadInSeconds : shape.betweenWavesSeconds,
      spacingSeconds: shape.spacingSeconds,
      clearFraction: shape.clearFraction,
      maxHoldSeconds: shape.maxHoldSeconds,
    });
    remaining -= thisSize;
    size = Math.min(shape.maxWaveSize, Math.max(1, size * shape.sizeMultiplier + shape.sizeGrowth));
    concurrent = Math.min(shape.maxConcurrent, Math.max(1, concurrent + shape.concurrentGrowth));
  }
  return waves;
}

/**
 * Meters a queue of anything out over time. `phase` is `idle` | `lead-in` | `releasing` |
 * `holding` | `done`. `onWaveStart(wave)` fires as a wave starts releasing, `onComplete()` once the
 * last item is out — a caller may `enqueue` more from inside it to keep the fight going.
 */
export class WaveDirector {
  constructor({ curve, onWaveStart, onComplete } = {}) {
    this.curve = normalizeCurve(curve);
    this.onWaveStart = onWaveStart;
    this.onComplete = onComplete;
    this.reset();
  }

  /** Drops everything queued. A level teardown. */
  reset() {
    this.queue = [];
    this.waves = [];
    this.waveIndex = 0;
    this.releasedInWave = 0;
    this.timer = 0;
    this.alive = 0;
    this.completed = false;
    this.phase = 'idle';
  }

  get pending() {
    return this.queue.length;
  }

  /** Where the fight is, cheap enough to read every frame. `secondsToNext` is null off the clock. */
  get status() {
    const wave = this.waves[this.waveIndex] ?? null;
    const capped = this.phase === 'releasing' && this.alive >= (wave?.concurrent ?? 0);
    return {
      phase: this.phase,
      wave: wave?.ordinal ?? 0,
      waveCount: this.waves.length,
      leadInSeconds: wave?.leadInSeconds ?? 0,
      alive: this.alive,
      pending: this.queue.length,
      secondsToNext: this.phase === 'idle' || this.phase === 'done' || capped ? null : Math.max(0, this.timer),
    };
  }

  /** Loads a level's worth of spawns and plans waves over them. */
  setQueue(items) {
    this.queue = [...items];
    this.waves = planWaves(this.curve, this.queue.length);
    this.waveIndex = 0;
    this.releasedInWave = 0;
    this.completed = false;
    this.phase = this.waves.length === 0 ? 'done' : 'lead-in';
    this.timer = this.waves[0]?.leadInSeconds ?? 0;
  }

  /** Adds to the queue mid-fight, extending the plan from where it reached rather than restarting it. */
  enqueue(items) {
    const added = [...items];
    if (added.length === 0) return;
    this.queue.push(...added);

    const plannedAhead = this.waves.slice(this.waveIndex).reduce((sum, w) => sum + w.size, 0);
    const uncovered = this.queue.length - (plannedAhead - this.releasedInWave);
    if (uncovered > 0) {
      const last = this.waves[this.waves.length - 1];
      const tail = planWaves({ ...this.curve, firstWaveSize: last?.size ?? this.curve.firstWaveSize }, uncovered);
      for (const wave of tail) {
        this.waves.push({ ...wave, ordinal: this.waves.length + 1, leadInSeconds: this.curve.betweenWavesSeconds });
      }
    }
    if (this.phase === 'done') {
      // Finished on a wave's last release, the index still points at that spent wave: step past it.
      const spent = this.waves[this.waveIndex];
      if (spent && this.releasedInWave >= spent.size) {
        this.waveIndex += 1;
        this.releasedInWave = 0;
      }
      this.completed = false;
      this.phase = 'lead-in';
      this.timer = this.waves[this.waveIndex]?.leadInSeconds ?? 0;
    }
  }

  /** Advances one frame against `alive` living hostiles and returns what should spawn now. */
  update(delta, alive) {
    this.alive = Math.max(0, alive);
    if (this.phase === 'done' || this.phase === 'idle') return [];
    this.timer -= Number.isFinite(delta) ? Math.max(0, delta) : 0;

    const wave = this.waves[this.waveIndex];
    if (!wave) { this.finish(); return []; }

    if (this.phase === 'lead-in') {
      if (this.timer > 0) return [];
      this.phase = 'releasing';
      this.timer = 0;
      this.onWaveStart?.(wave);
    }

    if (this.phase === 'holding') {
      // Enough of the wave is dead, the hold has run out of patience, or a kill opened a slot.
      const cleared = this.alive <= Math.floor(wave.size * (1 - wave.clearFraction));
      const room = this.alive > 0 && this.alive < wave.concurrent;
      if (cleared || this.timer <= 0 || room) this.beginNextWave(this.alive > 0);
      return [];
    }

    const released = [];
    let headroom = Math.max(0, wave.concurrent - this.alive);
    while (this.releasedInWave < wave.size && this.queue.length > 0 && headroom > 0 && this.timer <= 0) {
      released.push(this.queue.shift());
      this.releasedInWave += 1;
      headroom -= 1;
      // Counted at once: spawning is asynchronous, and the next `alive` will not include it yet.
      this.alive += 1;
      this.timer = wave.spacingSeconds;
    }

    if (this.releasedInWave >= wave.size || this.queue.length === 0) {
      if (this.waveIndex >= this.waves.length - 1 && this.queue.length === 0) this.finish();
      else {
        this.phase = 'holding';
        this.timer = wave.maxHoldSeconds;
      }
    }
    return released;
  }

  /** `overlapping`: survivors are still up, so the next wave skips its lead-in. */
  beginNextWave(overlapping = false) {
    this.waveIndex += 1;
    this.releasedInWave = 0;
    const next = this.waves[this.waveIndex];
    if (!next || this.queue.length === 0) { this.finish(); return; }
    this.phase = 'lead-in';
    this.timer = overlapping ? 0 : next.leadInSeconds;
  }

  finish() {
    this.phase = 'done';
    this.timer = 0;
    if (this.completed) return;
    this.completed = true;
    this.onComplete?.();
  }
}
