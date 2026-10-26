import {
  AdditiveBlending, BufferAttribute, BufferGeometry, CanvasTexture, Color, NormalBlending,
  Points, ShaderMaterial, Vector3,
} from 'three';
import type { Texture } from 'three';

/**
 * Particle bursts for attacks.
 *
 * Descended from the studio's `ParticleSystemGenerator`, and deliberately not a copy of it: that
 * one is a decorative loop that runs forever, pre-warmed so it never appears to start. An attack
 * needs the opposite — a system that is *off*, turns on for a measured burst, and lets the
 * particles already in flight die naturally so the effect ends by fading rather than vanishing.
 *
 * Four differences from the studio version, each one a thing that made it unusable here:
 *
 * 1. **Emission gating.** `burst()` opens the emitter for a fixed time; particles spawn while it
 *    is open and are never respawned after it closes. The studio version respawns unconditionally
 *    on death, which is what makes it a loop.
 * 2. **A shader material, not `PointsMaterial`.** Per-particle size and alpha are the difference
 *    between a puff and a flat sheet of dots, and `PointsMaterial` supports neither — the studio
 *    spec authors `sizeEnd` and per-stop `alpha` and its generator silently ignores both.
 * 3. **No per-frame allocation.** The studio version calls `Color.clone()` once per particle per
 *    frame — at 1800 particles that is over a hundred thousand objects a second, on the frame
 *    budget of a game rather than a preview pane.
 * 4. **Pooled and reusable.** Attacks fire on a cooldown measured in seconds; building six
 *    thousand particles' worth of buffers on each one is a stutter you can see.
 *
 * The system is added to the scene root and positioned in world space, never parented to a
 * character: a Synty rig's armature carries a 0.01 scale and a quarter turn, and anything
 * inheriting that is either invisible or the size of a building.
 */

export interface ParticleTuning {
  particleCount: number;
  lifespanMin: number;
  lifespanMax: number;
  speedMin: number;
  speedMax: number;
  /** Negative lifts, positive drops. World units per second squared. */
  gravity: number;
  sizeStart: number;
  sizeEnd: number;
  colorStartHex: string;
  colorEndHex: string;
  turbulenceIntensity: number;
  additiveBlending: boolean;
  burstSeconds: number;
  /**
   * Fraction of velocity shed per second. Absent or 0 is vacuum, which is what every attack
   * behaviour authored before designed effects assumed.
   *
   * Here because the direction modes a designed effect can ask for — an inrush, a vortex — read
   * as machinery without it: particles converging at a constant speed arrive as a set of rails
   * rather than as something being drawn in.
   */
  drag?: number;
}

/**
 * Where and how particles are launched. Set by the attack behaviours each frame — the system
 * reads these live at spawn time, so moving the origin walks the emitter without disturbing
 * anything already in flight.
 */
export interface EmitterState {
  /** World-space spawn point. */
  origin: Vector3;
  /** Unit vector particles are biased along. */
  direction: Vector3;
  /**
   * How tightly particles hug `direction`. 1 is a straight jet, 0 is a sphere. Between the two,
   * a cone.
   */
  focus: number;
  /** Particles spawn somewhere on a disc of this radius around `origin`, in its ground plane. */
  spawnRadius: number;
  /** Vertical spread of the spawn disc, for a column rather than a sheet. */
  spawnHeight: number;
}

/** Reused across spawns so the hot path allocates nothing. */
const scratch = new Vector3();
const scratchTangent = new Vector3();
const scratchBitangent = new Vector3();

let sharedSprite: Texture | null = null;

/**
 * A soft radial dot, generated once for the process.
 *
 * Deliberately not disposed with the system: every burst in the game shares this one texture, and
 * freeing it when one attack ends would blank every other.
 */
function spriteTexture(): Texture {
  if (sharedSprite) return sharedSprite;

  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;

  const ctx = canvas.getContext('2d')!;
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.35, 'rgba(255,255,255,0.75)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);

  sharedSprite = new CanvasTexture(canvas);
  return sharedSprite;
}

/**
 * Size and alpha have to vary per particle, which fixed-function points cannot do.
 *
 * `gl_PointSize` is scaled by `1/-mvPosition.z` so a particle shrinks with distance like anything
 * else in the scene; without that a burst thirty metres away draws the same fat dots as one at
 * arm's length. Depth writing is off and depth testing on, so particles occlude behind geometry
 * but never against each other — with additive blending, sorting them would cost more than it
 * could possibly be worth.
 */
const VERTEX_SHADER = `
  attribute float size;
  attribute float alpha;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vColor = color;
    vAlpha = alpha;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = size * (300.0 / -mvPosition.z);
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const FRAGMENT_SHADER = `
  uniform sampler2D map;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vec4 texel = texture2D(map, gl_PointCoord);
    if (texel.a < 0.01) discard;
    gl_FragColor = vec4(vColor, vAlpha * texel.a);
  }
`;

export class ParticleSystem {
  readonly points: Points;

  private readonly capacity: number;
  private readonly geometry: BufferGeometry;
  private readonly material: ShaderMaterial;

  private readonly positions: Float32Array;
  private readonly colors: Float32Array;
  private readonly sizes: Float32Array;
  private readonly alphas: Float32Array;
  private readonly velocities: Float32Array;
  private readonly ages: Float32Array;
  private readonly lifetimes: Float32Array;
  /** Per-particle phase, so turbulence does not move the whole cloud in lockstep. */
  private readonly seeds: Float32Array;

  private readonly colorStart = new Color();
  private readonly colorEnd = new Color();

  private tuning: ParticleTuning;
  private emitter: EmitterState | null = null;

  /** Seconds of emission left. Zero means closed; particles may still be finishing. */
  private emissionLeft = 0;
  /** Fractional particles owed from the last frame, so a low rate still emits smoothly. */
  private spawnDebt = 0;
  private liveCount = 0;

  /**
   * @param texture Overrides the shared soft dot — a designed effect's own sprite, which may be a
   *   flipbook grid. Not disposed with the system: like the built-in dot it is shared between
   *   every system drawing with it, and freeing it here would blank the others.
   */
  constructor(tuning: ParticleTuning, texture?: Texture) {
    this.tuning = tuning;
    this.capacity = Math.min(8000, Math.max(32, Math.floor(tuning.particleCount)));

    const n = this.capacity;

    // CPU-only state, never uploaded.
    this.velocities = new Float32Array(n * 3);
    this.ages = new Float32Array(n);
    this.lifetimes = new Float32Array(n);
    this.seeds = new Float32Array(n);

    /**
     * The attributes are built first and the working views taken back off them, rather than the
     * other way round.
     *
     * `BufferAttribute` keeps the array it is handed; `Float32BufferAttribute` quietly *copies* it
     * (`super(new Float32Array(array), …)`). Writing to the array you passed in therefore updates
     * memory the GPU never reads, and the symptom is not a warning or a glitch — it is every
     * particle sitting at the origin at size zero, so nothing draws at all and the system looks
     * like it was never switched on. Deriving the views from the attributes makes the mistake
     * unrepresentable rather than merely commented against.
     */
    const position = new BufferAttribute(new Float32Array(n * 3), 3);
    const color = new BufferAttribute(new Float32Array(n * 3), 3);
    const size = new BufferAttribute(new Float32Array(n), 1);
    const alpha = new BufferAttribute(new Float32Array(n), 1);

    this.geometry = new BufferGeometry();
    this.geometry.setAttribute('position', position);
    this.geometry.setAttribute('color', color);
    this.geometry.setAttribute('size', size);
    this.geometry.setAttribute('alpha', alpha);

    this.positions = position.array as Float32Array;
    this.colors = color.array as Float32Array;
    this.sizes = size.array as Float32Array;
    this.alphas = alpha.array as Float32Array;

    for (let i = 0; i < n; i++) {
      this.seeds[i] = Math.random() * Math.PI * 2;
      // Dead, not unborn: age past lifetime is what marks a slot free.
      this.ages[i] = 1;
      this.lifetimes[i] = 0;
    }

    this.material = new ShaderMaterial({
      uniforms: { map: { value: texture ?? spriteTexture() } },
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
      vertexColors: true,
      blending: tuning.additiveBlending ? AdditiveBlending : NormalBlending,
    });

    this.points = new Points(this.geometry, this.material);
    // The cloud leaves whatever bounding sphere its first frame implied — an expanding ring grows
    // by metres — and a culled attack is an attack that appears not to have happened.
    this.points.frustumCulled = false;
    this.points.visible = false;

    this.applyColors();
  }

  /**
   * What to add to the scene.
   *
   * The same object as `points`, under the name a caller uses when it does not care which kind of
   * effect it is holding — see `AttackEffect` in `Vfx.ts`. A designed effect is a group of several
   * systems and cannot offer `points` at all, and the attack runner should not have to branch on
   * which one it pooled.
   */
  get object3d(): Points {
    return this.points;
  }

  /** True while anything is emitting or still alive, so a pool knows when the slot is free. */
  get active(): boolean {
    return this.emissionLeft > 0 || this.liveCount > 0;
  }

  /**
   * Re-tunes an idle system so a pooled instance can serve a different attack.
   *
   * Only the colours, blending and motion change — the buffers are the expensive part and they
   * are sized by the pool's capacity, so a system asked for more particles than it holds simply
   * emits what it has rather than reallocating mid-fight.
   */
  retune(tuning: ParticleTuning): void {
    this.tuning = tuning;
    this.material.blending = tuning.additiveBlending ? AdditiveBlending : NormalBlending;
    this.applyColors();
  }

  private applyColors(): void {
    this.colorStart.set(this.tuning.colorStartHex);
    this.colorEnd.set(this.tuning.colorEndHex);
  }

  /**
   * Opens the emitter for `burstSeconds`, or for an explicit override.
   *
   * Calling this again while open extends the burst rather than restarting it, which is what a
   * lingering attack re-arming each tick wants.
   */
  burst(emitter: EmitterState, seconds = this.tuning.burstSeconds): void {
    this.emitter = emitter;
    this.emissionLeft = Math.max(this.emissionLeft, seconds);
    this.points.visible = true;
  }

  /** Closes the emitter early. Particles in flight still finish, so the effect fades out. */
  stop(): void {
    this.emissionLeft = 0;
  }

  /** Closes the emitter and kills everything in flight. For a hard teardown, not an effect end. */
  clear(): void {
    this.emissionLeft = 0;
    this.liveCount = 0;
    this.spawnDebt = 0;
    for (let i = 0; i < this.capacity; i++) {
      this.ages[i] = 1;
      this.lifetimes[i] = 0;
      this.alphas[i] = 0;
    }
    this.alphaAttribute.needsUpdate = true;
    this.points.visible = false;
  }

  private get positionAttribute() { return this.geometry.getAttribute('position'); }
  private get colorAttribute() { return this.geometry.getAttribute('color'); }
  private get sizeAttribute() { return this.geometry.getAttribute('size'); }
  private get alphaAttribute() { return this.geometry.getAttribute('alpha'); }

  update(dt: number, elapsed: number): void {
    if (!this.active) {
      if (this.points.visible) this.points.visible = false;
      return;
    }

    const t = this.tuning;

    // Emit. The whole capacity is spread across the burst, so a short burst is dense and a long
    // one is a steady stream, and neither runs out of particles early.
    if (this.emissionLeft > 0 && this.emitter) {
      const rate = this.capacity / Math.max(0.0001, t.burstSeconds);
      this.spawnDebt += rate * Math.min(dt, this.emissionLeft);
      const wanted = Math.floor(this.spawnDebt);
      this.spawnDebt -= wanted;

      let spawned = 0;
      for (let i = 0; i < this.capacity && spawned < wanted; i++) {
        if (this.ages[i] < this.lifetimes[i]) continue;
        this.spawn(i);
        spawned++;
      }
      this.emissionLeft = Math.max(0, this.emissionLeft - dt);
    }

    // Simulate.
    const positions = this.positions;
    const colors = this.colors;
    let live = 0;

    for (let i = 0; i < this.capacity; i++) {
      if (this.ages[i] >= this.lifetimes[i]) {
        // Zero-alpha rather than moved away: the vertex is still drawn, and a stale alpha would
        // leave a dead particle hanging in the air.
        if (this.alphas[i] !== 0) this.alphas[i] = 0;
        continue;
      }

      live++;
      this.ages[i] += dt;
      const life = Math.min(1, this.ages[i] / this.lifetimes[i]);

      const i3 = i * 3;
      this.velocities[i3 + 1] -= t.gravity * dt;

      if (t.drag) {
        // Explicit rather than exponential: one multiply, and at frame-scale dt the difference
        // from a true exponential decay is far below what anyone can see in a half-second burst.
        const kept = Math.max(0, 1 - t.drag * dt);
        this.velocities[i3] *= kept;
        this.velocities[i3 + 1] *= kept;
        this.velocities[i3 + 2] *= kept;
      }

      const turbulence = Math.sin(elapsed * 4 + this.seeds[i]) * t.turbulenceIntensity;
      positions[i3] += (this.velocities[i3] + turbulence) * dt;
      positions[i3 + 1] += this.velocities[i3 + 1] * dt;
      positions[i3 + 2] += (this.velocities[i3 + 2] + turbulence) * dt;

      // Lerped in place — no Color objects, no allocation.
      colors[i3] = this.colorStart.r + (this.colorEnd.r - this.colorStart.r) * life;
      colors[i3 + 1] = this.colorStart.g + (this.colorEnd.g - this.colorStart.g) * life;
      colors[i3 + 2] = this.colorStart.b + (this.colorEnd.b - this.colorStart.b) * life;

      this.sizes[i] = t.sizeStart + (t.sizeEnd - t.sizeStart) * life;
      // Fades in over the first tenth of life and out across the rest, so nothing pops into
      // existence at full brightness.
      this.alphas[i] = life < 0.1 ? life / 0.1 : 1 - (life - 0.1) / 0.9;
    }

    this.liveCount = live;

    this.positionAttribute.needsUpdate = true;
    this.colorAttribute.needsUpdate = true;
    this.sizeAttribute.needsUpdate = true;
    this.alphaAttribute.needsUpdate = true;

    if (!this.active) this.points.visible = false;
  }

  /** Places one particle. Reads the emitter live, so a moving origin trails. */
  private spawn(i: number): void {
    const e = this.emitter!;
    const t = this.tuning;
    const i3 = i * 3;

    // A basis around the launch direction, so spread is measured across it rather than in world
    // axes — otherwise a beam fired along Y spreads differently from one fired along X.
    basisFor(e.direction, scratchTangent, scratchBitangent);

    const angle = Math.random() * Math.PI * 2;
    // Square-rooted so the disc fills evenly instead of clumping at the middle.
    const radius = Math.sqrt(Math.random()) * e.spawnRadius;

    this.positions[i3] = e.origin.x + Math.cos(angle) * radius * scratchTangent.x
      + Math.sin(angle) * radius * scratchBitangent.x;
    this.positions[i3 + 1] = e.origin.y + (Math.random() - 0.5) * e.spawnHeight
      + Math.cos(angle) * radius * scratchTangent.y + Math.sin(angle) * radius * scratchBitangent.y;
    this.positions[i3 + 2] = e.origin.z + Math.cos(angle) * radius * scratchTangent.z
      + Math.sin(angle) * radius * scratchBitangent.z;

    // Blend between the launch direction and a random one by `focus`: 1 is a jet, 0 a sphere.
    scratch.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5);
    if (scratch.lengthSq() < 1e-6) scratch.set(0, 1, 0);
    scratch.normalize().lerp(e.direction, e.focus).normalize();

    const speed = t.speedMin + Math.random() * (t.speedMax - t.speedMin);
    this.velocities[i3] = scratch.x * speed;
    this.velocities[i3 + 1] = scratch.y * speed;
    this.velocities[i3 + 2] = scratch.z * speed;

    this.ages[i] = 0;
    this.lifetimes[i] = t.lifespanMin + Math.random() * (t.lifespanMax - t.lifespanMin);
    this.sizes[i] = t.sizeStart;
    this.alphas[i] = 0;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}

/** Two unit vectors perpendicular to `normal` and to each other. */
function basisFor(normal: Vector3, tangent: Vector3, bitangent: Vector3): void {
  // Any axis not parallel to the normal will do; picking by the smallest component guarantees it.
  if (Math.abs(normal.y) < 0.99) tangent.set(0, 1, 0);
  else tangent.set(1, 0, 0);

  bitangent.crossVectors(normal, tangent).normalize();
  tangent.crossVectors(bitangent, normal).normalize();
}

/** The tuning a behaviour falls back to when the content authored nothing. */
export const DEFAULT_PARTICLE_TUNING: ParticleTuning = {
  particleCount: 900,
  lifespanMin: 0.35,
  lifespanMax: 0.9,
  speedMin: 2,
  speedMax: 6,
  gravity: 0,
  sizeStart: 0.25,
  sizeEnd: 0.04,
  colorStartHex: '#7dd3fc',
  colorEndHex: '#1e3a8a',
  turbulenceIntensity: 0.25,
  additiveBlending: true,
  burstSeconds: 0.8,
};
