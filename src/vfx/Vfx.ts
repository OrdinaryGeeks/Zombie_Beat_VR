import {
  AdditiveBlending, CanvasTexture, ClampToEdgeWrapping, Color, Group, LinearFilter, NormalBlending,
  Quaternion, SRGBColorSpace, Sprite, SpriteMaterial, TextureLoader, Vector3,
} from 'three';
import type { Object3D, Texture } from 'three';
import { ParticleSystem } from './ParticleSystem.js';
import type { EmitterState, ParticleTuning } from './ParticleSystem.js';
import { SpriteSheetAnimator } from './SpriteSheet.js';

/**
 * Designed effects: the runtime half of the studio's VFX panel.
 *
 * An authored attack has always been able to say "particles, rising, orange". A *designed* effect
 * says something an attack could not: several releases at once, each aimed its own way and each
 * starting at its own moment, over a drawn flipbook, with sprites the author generated rather than
 * picked from a shipped set. It arrives inside the attack's tuning blob as `particle.vfx` and is
 * played by `VfxSystem` below.
 *
 * **This file mirrors `src/types/vfx.ts`, `src/components/generators/VfxTextureFactory.ts` and the
 * simulation in `src/components/generators/VfxSystemGenerator.ts`, and mirrors them deliberately.**
 * The game bundle cannot import from `src/` — that is the rule `vite.game.config.ts` exists to
 * enforce, so a game never drags React or MUI in — which is the same reason `types.ts` mirrors the
 * backend's enums rather than importing them. The generators here are kept structurally identical
 * to the studio's so a texture drawn in the panel is the texture drawn in game;
 * `__tests__/vfx.test.ts` asserts the two lists of generators still match.
 *
 * Two places where the runtime deliberately does *not* mirror the studio, both stated here so they
 * are not discovered as bugs:
 *
 * 1. **Releases are `ParticleSystem`s, not instanced quads.** The studio draws instanced quads so
 *    it can stretch a spark along its velocity and rotate each particle. In game, an attack's
 *    particles are pooled, run on a frame budget shared with everything else, and are almost never
 *    watched closely enough for per-particle rotation to be visible. Reusing the shipped, pooled,
 *    allocation-free system is worth losing that, and it means a designed effect gets the same
 *    burst gating and the same shader every other attack already uses.
 * 2. **A gradient is read as its first and last stop.** `ParticleSystem` lerps one colour to
 *    another across a particle's life. Middle stops are carried in the spec and ignored here.
 *
 * Everything else — how many releases, their directions, their delays, their textures, the
 * billboards — is played as authored.
 */

// ── The spec, mirrored ────────────────────────────────────────────────────────────────

export type VfxTextureSource = 'procedural' | 'imported' | 'asset';

export type VfxProceduralKind =
  | 'soft_glow' | 'flame' | 'smoke_puff' | 'spark_streak' | 'star'
  | 'ring' | 'shockwave' | 'bolt' | 'noise_cloud' | 'droplet';

export interface VfxTextureSpec {
  id: string;
  name: string;
  source: VfxTextureSource;
  kind: VfxProceduralKind;
  colorInnerHex: string;
  colorOuterHex: string;
  hardness: number;
  detail: number;
  points: number;
  seed: number;
  size: number;
  columns: number;
  rows: number;
  frameCount: number | null;
  fps: number;
  /** Never published — see `utils/vfxPublish.ts`. Declared so a stray one parses rather than throws. */
  dataUrl?: string | null;
  /** Resolved through the game client's `assetUrl`. The only publishable image reference. */
  assetPath: string | null;
}

export interface VfxColorStop {
  offset: number;
  color: string;
  alpha: number;
}

export type VfxEmitterShape = 'point' | 'sphere' | 'box' | 'disc' | 'ring' | 'cone' | 'line';

export type VfxDirectionMode =
  | 'directional' | 'omni' | 'multi_directional' | 'vortex' | 'inward';

export type VfxEmissionMode = 'burst' | 'continuous';

export interface VfxEmitterSpec {
  id: string;
  name: string;
  enabled: boolean;
  shape: VfxEmitterShape;
  radius: number;
  height: number;
  offset: [number, number, number];
  direction: [number, number, number];
  directionMode: VfxDirectionMode;
  spreadDegrees: number;
  arms: number;
  armSpinDegrees: number;
  swirl: number;
  emissionMode: VfxEmissionMode;
  particleCount: number;
  startDelaySeconds: number;
  burstSeconds: number;
  lifespanMin: number;
  lifespanMax: number;
  speedMin: number;
  speedMax: number;
  gravity: number;
  drag: number;
  sizeStart: number;
  sizeEnd: number;
  turbulence: number;
  additiveBlending: boolean;
  colorStops: VfxColorStop[];
  textureId: string | null;
  stretchWithVelocity: boolean;
}

export type VfxBillboardFacing = 'camera' | 'ground' | 'direction';

export interface VfxBillboardSpec {
  id: string;
  name: string;
  enabled: boolean;
  textureId: string | null;
  facing: VfxBillboardFacing;
  startDelaySeconds: number;
  durationSeconds: number;
  loop: boolean;
  fps: number | null;
  sizeStart: number;
  sizeEnd: number;
  offset: [number, number, number];
  spinDegreesPerSecond: number;
  colorHex: string;
  opacity: number;
  additiveBlending: boolean;
}

export interface VfxSpec {
  version: number;
  id: string;
  name: string;
  description: string;
  scale: number;
  durationSeconds: number;
  emitters: VfxEmitterSpec[];
  billboards: VfxBillboardSpec[];
  textures: VfxTextureSpec[];
  updatedAt?: string;
}

/**
 * The generators this build can draw, in the studio's order.
 *
 * Exported so the mirror can be checked rather than assumed — a kind the studio can author and
 * this cannot draw is a texture that silently becomes a soft dot in game.
 */
export const VFX_PROCEDURAL_KINDS: VfxProceduralKind[] = [
  'soft_glow', 'flame', 'smoke_puff', 'spark_streak', 'star',
  'ring', 'shockwave', 'bolt', 'noise_cloud', 'droplet',
];

/**
 * Enough of a shape check to reject something that is not an effect.
 *
 * Deliberately not a schema: content written by a newer studio carries fields this build has never
 * heard of, and refusing it would make the format un-evolvable. Anything unrecognised is ignored
 * further down, which costs one detail of one effect rather than the level.
 */
export function isVfxSpec(value: unknown): value is VfxSpec {
  if (!value || typeof value !== 'object') return false;
  const spec = value as Partial<VfxSpec>;
  return Array.isArray(spec.emitters) && Array.isArray(spec.textures);
}

// ── Procedural textures, mirrored from the studio's factory ───────────────────────────

function rng(seed: number): () => number {
  let a = (seed >>> 0) || 1;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);

const scratchColor = new Color();

function rgba(hex: string, alpha: number): string {
  scratchColor.set(hex);
  const r = Math.round(scratchColor.r * 255);
  const g = Math.round(scratchColor.g * 255);
  const b = Math.round(scratchColor.b * 255);
  return `rgba(${r}, ${g}, ${b}, ${clamp01(alpha)})`;
}

/** Cells actually played. A padded grid plays its blanks otherwise, which reads as a stall. */
export function vfxTextureFrameCount(spec: VfxTextureSpec): number {
  const grid = Math.max(1, spec.columns) * Math.max(1, spec.rows);
  const declared = spec.frameCount ?? grid;
  return Math.min(grid, Math.max(1, declared));
}

function drawCell(
  ctx: CanvasRenderingContext2D,
  spec: VfxTextureSpec,
  size: number,
  phase: number,
  random: () => number,
): void {
  const c = size / 2;
  const inner = spec.colorInnerHex;
  const outer = spec.colorOuterHex;
  const core = clamp01(spec.hardness) * 0.85;

  const radialFill = (radius: number, peak = 1) => {
    const grad = ctx.createRadialGradient(c, c, 0, c, c, Math.max(1, radius));
    grad.addColorStop(0, rgba(inner, peak));
    grad.addColorStop(Math.min(0.99, core), rgba(inner, peak * 0.75));
    grad.addColorStop(1, rgba(outer, 0));
    return grad;
  };

  switch (spec.kind) {
    case 'flame': {
      const rise = phase * size * 0.22;
      const width = size * (0.42 - phase * 0.16);
      const height = size * (0.78 - phase * 0.18);
      ctx.translate(0, -rise);
      ctx.beginPath();
      ctx.moveTo(c, c - height / 2);
      ctx.bezierCurveTo(c + width, c - height * 0.1, c + width * 0.7, c + height / 2, c, c + height / 2);
      ctx.bezierCurveTo(c - width * 0.7, c + height / 2, c - width, c - height * 0.1, c, c - height / 2);
      ctx.closePath();
      ctx.fillStyle = radialFill(height / 2, 1 - phase * 0.25);
      ctx.fill();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      break;
    }

    case 'smoke_puff': {
      const spread = size * (0.14 + phase * 0.12);
      for (let i = 0; i < 7; i++) {
        const angle = random() * Math.PI * 2;
        const dist = random() * spread;
        const r = size * (0.16 + random() * 0.16) * (1 + phase * 0.5);
        const x = c + Math.cos(angle) * dist;
        const y = c + Math.sin(angle) * dist;
        const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
        grad.addColorStop(0, rgba(inner, 0.5 * (1 - phase * 0.6)));
        grad.addColorStop(1, rgba(outer, 0));
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, size, size);
      }
      break;
    }

    case 'spark_streak': {
      const grad = ctx.createLinearGradient(0, c, size, c);
      grad.addColorStop(0, rgba(outer, 0));
      grad.addColorStop(0.5, rgba(inner, 1 - phase * 0.4));
      grad.addColorStop(1, rgba(outer, 0));
      ctx.fillStyle = grad;
      const thickness = size * (0.12 + core * 0.1) * (1 - phase * 0.4);
      ctx.beginPath();
      ctx.ellipse(c, c, c * 0.95, Math.max(1, thickness), 0, 0, Math.PI * 2);
      ctx.fill();
      break;
    }

    case 'star': {
      const spikes = Math.max(3, Math.round(spec.points));
      const outerR = c * (0.95 - phase * 0.15);
      const innerR = outerR * (0.16 + core * 0.3);
      ctx.beginPath();
      for (let i = 0; i < spikes * 2; i++) {
        const r = i % 2 === 0 ? outerR : innerR;
        const a = (i / (spikes * 2)) * Math.PI * 2 - Math.PI / 2;
        const x = c + Math.cos(a) * r;
        const y = c + Math.sin(a) * r;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.fillStyle = radialFill(outerR, 1 - phase * 0.3);
      ctx.fill();
      break;
    }

    case 'ring': {
      const r = c * 0.72;
      const width = Math.max(2, c * (0.28 - core * 0.2));
      ctx.strokeStyle = rgba(inner, 1 - phase * 0.3);
      ctx.lineWidth = width;
      ctx.beginPath();
      ctx.arc(c, c, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = rgba(outer, 0.25);
      ctx.lineWidth = width * 2.2;
      ctx.stroke();
      break;
    }

    case 'shockwave': {
      const r = c * (0.12 + phase * 0.86);
      const width = Math.max(1, c * 0.3 * (1 - phase) + 1);
      ctx.strokeStyle = rgba(inner, (1 - phase) * 0.9);
      ctx.lineWidth = width;
      ctx.beginPath();
      ctx.arc(c, c, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = rgba(outer, (1 - phase) * 0.35);
      ctx.lineWidth = width * 2.5;
      ctx.stroke();
      break;
    }

    case 'bolt': {
      const branches = Math.max(1, Math.round(spec.points / 2));
      ctx.lineCap = 'round';
      for (let b = 0; b < branches; b++) {
        const baseAngle = (b / branches) * Math.PI * 2 + phase * 0.6;
        let x = c;
        let y = c;
        ctx.beginPath();
        ctx.moveTo(x, y);
        for (let s = 1; s <= 7; s++) {
          const a = baseAngle + (random() - 0.5) * 1.1;
          const step = (c / 7) * (0.8 + random() * 0.5);
          x += Math.cos(a) * step;
          y += Math.sin(a) * step;
          ctx.lineTo(x, y);
        }
        ctx.strokeStyle = rgba(outer, 0.35 * (1 - phase));
        ctx.lineWidth = Math.max(2, size * 0.05);
        ctx.stroke();
        ctx.strokeStyle = rgba(inner, 1 - phase * 0.5);
        ctx.lineWidth = Math.max(1, size * 0.018);
        ctx.stroke();
      }
      break;
    }

    case 'noise_cloud': {
      const growth = 0.55 + phase * 0.45;
      for (let i = 0; i < 14; i++) {
        const angle = random() * Math.PI * 2;
        const dist = Math.pow(random(), 0.6) * c * 0.55 * growth;
        const r = c * (0.2 + random() * 0.3) * growth;
        const heat = clamp01(1 - dist / (c * 0.7) - phase * 0.5);
        const x = c + Math.cos(angle) * dist;
        const y = c + Math.sin(angle) * dist;
        const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
        grad.addColorStop(0, rgba(inner, 0.55 * heat + 0.12));
        grad.addColorStop(0.6, rgba(outer, 0.35 * (1 - phase)));
        grad.addColorStop(1, rgba(outer, 0));
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, size, size);
      }
      break;
    }

    case 'droplet': {
      const h = c * (0.9 - phase * 0.1);
      ctx.beginPath();
      ctx.moveTo(c, c - h);
      ctx.quadraticCurveTo(c + h * 0.62, c + h * 0.25, c, c + h * 0.75);
      ctx.quadraticCurveTo(c - h * 0.62, c + h * 0.25, c, c - h);
      ctx.closePath();
      ctx.fillStyle = radialFill(h * 0.8);
      ctx.fill();
      break;
    }

    default: {
      ctx.fillStyle = radialFill(c);
      ctx.fillRect(0, 0, size, size);
      break;
    }
  }
}

function applyDetail(ctx: CanvasRenderingContext2D, size: number, detail: number, random: () => number): void {
  if (detail <= 0) return;

  const image = ctx.getImageData(0, 0, size, size);
  const data = image.data;
  const strength = clamp01(detail);
  const block = 4;
  const cols = Math.ceil(size / block);
  const field = new Float32Array(cols * cols);
  for (let i = 0; i < field.length; i++) field[i] = 1 - random() * strength;

  for (let y = 0; y < size; y++) {
    const fy = Math.floor(y / block) * cols;
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4 + 3;
      data[idx] = data[idx] * field[fy + Math.floor(x / block)];
    }
  }
  ctx.putImageData(image, 0, 0);
}

/** Draws the whole sheet — every cell of the grid, in reading order. */
export function drawVfxTexture(spec: VfxTextureSpec): HTMLCanvasElement {
  const size = Math.max(8, Math.min(512, Math.round(spec.size)));
  const columns = Math.max(1, Math.min(16, Math.round(spec.columns)));
  const rows = Math.max(1, Math.min(16, Math.round(spec.rows)));
  const frames = vfxTextureFrameCount(spec);

  const canvas = document.createElement('canvas');
  canvas.width = size * columns;
  canvas.height = size * rows;

  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;

  for (let f = 0; f < frames; f++) {
    const x = (f % columns) * size;
    const y = Math.floor(f / columns) * size;
    const phase = frames === 1 ? 0 : f / (frames - 1);

    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, size, size);
    ctx.clip();
    ctx.translate(x, y);
    drawCell(ctx, spec, size, phase, rng(spec.seed + f * 7919));
    ctx.restore();
  }

  if (spec.detail > 0) {
    const scratch = document.createElement('canvas');
    scratch.width = size;
    scratch.height = size;
    const sctx = scratch.getContext('2d');

    if (sctx) {
      for (let f = 0; f < frames; f++) {
        const x = (f % columns) * size;
        const y = Math.floor(f / columns) * size;
        sctx.clearRect(0, 0, size, size);
        sctx.putImageData(ctx.getImageData(x, y, size, size), 0, 0);
        applyDetail(sctx, size, spec.detail, rng(spec.seed + f * 104729));
        ctx.clearRect(x, y, size, size);
        ctx.drawImage(scratch, x, y);
      }
    }
  }

  return canvas;
}

function signatureOf(spec: VfxTextureSpec): string {
  if (spec.source === 'asset' || spec.assetPath) return `asset:${spec.assetPath ?? ''}`;
  return [
    'proc', spec.kind, spec.colorInnerHex, spec.colorOuterHex, spec.hardness, spec.detail,
    spec.points, spec.seed, spec.size, spec.columns, spec.rows, spec.frameCount ?? 'all',
  ].join('|');
}

/**
 * Textures, cached for the process by what they draw rather than by which effect asked.
 *
 * Never disposed, for the same reason `ParticleSystem`'s soft dot is not: an effect that freed its
 * texture would blank every other effect sharing it, and a designed effect assigned to four
 * attacks is exactly that case.
 */
const textureCache = new Map<string, Texture>();

function configure(texture: Texture): Texture {
  texture.colorSpace = SRGBColorSpace;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  // A mipmap of a sheet blends neighbouring cells, so a distant effect samples the frames either
  // side of the one it is playing. Same reasoning as `SpriteSheet.ts`.
  texture.generateMipmaps = false;
  texture.wrapS = ClampToEdgeWrapping;
  texture.wrapT = ClampToEdgeWrapping;
  texture.needsUpdate = true;
  return texture;
}

/**
 * The GPU texture for one of an effect's textures.
 *
 * `resolveUrl` is the game client's `assetUrl` — the SDK has no business knowing whether a hosted
 * sheet comes from a dev server's public directory or a GCS proxy, the same argument
 * `SpriteSheetLibrary` is built on.
 */
export function vfxTexture(spec: VfxTextureSpec, resolveUrl: (path: string) => string): Texture {
  const key = signatureOf(spec);
  const cached = textureCache.get(key);
  if (cached) return cached;

  const texture = spec.assetPath
    ? new TextureLoader().load(resolveUrl(spec.assetPath))
    : new CanvasTexture(drawVfxTexture(spec));

  configure(texture);
  textureCache.set(key, texture);
  return texture;
}

// ── Playing one ───────────────────────────────────────────────────────────────────────

/**
 * What an attack's visual effect has to be able to do, whichever kind it is.
 *
 * `ParticleSystem` satisfies this structurally and `VfxSystem` implements it, so the attack runner
 * pools and drives the two identically. Without it the runner would carry a branch at every one of
 * the five places it touches an effect, and each of those branches would be a place a designed
 * effect could quietly stop being updated, retired or freed.
 */
export interface AttackEffect {
  /** Added to the scene root. Effects live in world space, never parented to a character. */
  readonly object3d: Object3D;
  /** True while emitting or still alive, so a pool knows when the slot is free. */
  readonly active: boolean;
  /** Opens the effect at `emitter`. `seconds` overrides the authored length where that means anything. */
  burst(emitter: EmitterState, seconds?: number): void;
  /** Closes emission early; anything in flight still finishes, so the effect fades out. */
  stop(): void;
  /** Closes and kills what is in flight. For a teardown, not an effect ending. */
  clear(): void;
  update(dt: number, elapsed: number): void;
  dispose(): void;
}

/** One release, resolved to a system that can be opened when its delay comes round. */
interface Release {
  spec: VfxEmitterSpec;
  system: ParticleSystem;
  /** The emitter this arm reads, rewritten in place each time the effect is fired. */
  state: EmitterState;
  /**
   * The release's aim in the effect's own space, before the effect is pointed anywhere.
   * A multi-directional release contributes one of these per arm.
   */
  localDirection: Vector3;
  localOffset: Vector3;
  /** True once this release has been opened for the current firing. */
  opened: boolean;
}

/** One flipbook quad, with its own clock inside the effect's. */
interface Billboard {
  spec: VfxBillboardSpec;
  sprite: Sprite;
  material: SpriteMaterial;
  animator: SpriteSheetAnimator;
  localOffset: Vector3;
}

const scratchVec = new Vector3();
const AXIS_UP = new Vector3(0, 1, 0);

/**
 * A designed effect, playing.
 *
 * Shaped to drop into the same pool slot a plain `ParticleSystem` occupies — `active`, `burst`,
 * `stop`, `clear`, `update`, `dispose`, and an `object3d` to add to the scene — so the attack
 * runner treats an attack with a designed effect exactly like one without, and neither path is a
 * special case of the other.
 *
 * Aiming: the effect is authored around its first release's direction, and `burst` rotates that
 * axis onto the direction the attack is actually firing in. So an effect designed as a jet along
 * +Z fires along whatever the caster is facing, and a nova designed around +Y still sweeps the
 * floor, without the author having to think about world axes at all.
 */
export class VfxSystem implements AttackEffect {
  readonly object3d: Group;

  private readonly spec: VfxSpec;
  private readonly releases: Release[] = [];
  private readonly billboards: Billboard[] = [];

  /** The effect's own clock, restarted by `burst`. Drives every delay in the spec. */
  private elapsed = 0;
  private firing = false;
  /** The aim `burst` was last given, so a re-arm mid-effect does not swing everything round. */
  private readonly aim = new Quaternion();

  constructor(spec: VfxSpec, resolveUrl: (path: string) => string) {
    this.spec = spec;
    this.object3d = new Group();
    this.object3d.name = `vfx:${spec.id}`;

    const scale = Math.max(0.01, spec.scale || 1);
    const textures = new Map(spec.textures.map((texture) => [texture.id, texture]));

    for (const emitter of spec.emitters) {
      if (!emitter.enabled) continue;

      const texture = emitter.textureId ? textures.get(emitter.textureId) ?? null : null;
      const map = texture ? vfxTexture(texture, resolveUrl) : undefined;

      // A multi-directional release is several systems, one per arm, sharing the count between
      // them. Modelling it as one system would mean a single launch direction, which is the one
      // thing the mode exists to escape.
      const arms = emitter.directionMode === 'multi_directional'
        ? Math.max(1, Math.round(emitter.arms))
        : 1;

      for (let arm = 0; arm < arms; arm++) {
        const tuning = vfxEmitterTuning(emitter, scale, arms);
        const system = new ParticleSystem(tuning, map);
        system.points.visible = false;
        this.object3d.add(system.points);

        this.releases.push({
          spec: emitter,
          system,
          state: {
            origin: new Vector3(),
            direction: new Vector3(0, 1, 0),
            focus: vfxFocus(emitter),
            spawnRadius: spawnRadiusFor(emitter) * scale,
            spawnHeight: spawnHeightFor(emitter) * scale,
          },
          localDirection: vfxArmDirection(emitter, arm, arms),
          localOffset: new Vector3(
            emitter.offset[0] * scale,
            emitter.offset[1] * scale,
            emitter.offset[2] * scale,
          ),
          opened: false,
        });
      }
    }

    for (const billboard of spec.billboards) {
      if (!billboard.enabled) continue;

      const sheet = billboard.textureId ? textures.get(billboard.textureId) ?? null : null;
      if (!sheet) continue;

      // `SpriteSheetAnimator` takes a texture rather than a registered id precisely so a caller
      // that already has one need not go back through the sheet registry — which a generated
      // texture could never be in, since it has no path.
      const animator = new SpriteSheetAnimator(vfxTexture(sheet, resolveUrl).clone(), {
        path: sheet.assetPath ?? '',
        columns: Math.max(1, sheet.columns),
        rows: Math.max(1, sheet.rows),
        frameCount: vfxTextureFrameCount(sheet),
        fps: billboard.fps ?? sheet.fps,
        loop: billboard.loop,
      });

      const material = new SpriteMaterial({
        map: animator.texture,
        color: new Color(billboard.colorHex),
        transparent: true,
        opacity: billboard.opacity,
        depthWrite: false,
        blending: billboard.additiveBlending ? AdditiveBlending : NormalBlending,
        toneMapped: false,
      });

      const sprite = new Sprite(material);
      sprite.visible = false;
      sprite.renderOrder = 3;
      this.object3d.add(sprite);

      this.billboards.push({
        spec: billboard,
        sprite,
        material,
        animator,
        localOffset: new Vector3(
          billboard.offset[0] * scale,
          billboard.offset[1] * scale,
          billboard.offset[2] * scale,
        ),
      });
    }
  }

  /** True while anything is emitting, still alive, or waiting for its delay to come round. */
  get active(): boolean {
    if (this.releases.some((release) => release.system.active)) return true;
    if (!this.firing) return false;
    return this.elapsed < this.totalSeconds();
  }

  /**
   * Fires the effect from `base`, restarting its timeline.
   *
   * The base emitter supplies world position and the direction the attack is travelling; the spec
   * supplies everything else. `seconds` is accepted for parity with `ParticleSystem.burst` and is
   * ignored — a designed effect's length is authored per release, and overriding it with one
   * number would flatten exactly the staggering that makes it read as an event.
   */
  burst(base: EmitterState, _seconds?: number): void {
    this.elapsed = 0;
    this.firing = true;

    // Point the effect: rotate its authored primary axis onto the attack's direction.
    scratchVec.copy(base.direction);
    if (scratchVec.lengthSq() < 1e-8) scratchVec.set(0, 1, 0);
    scratchVec.normalize();
    this.aim.setFromUnitVectors(this.primaryAxis(), scratchVec);


    for (const release of this.releases) {
      release.opened = false;
      release.system.clear();

      // World space, and the group is left at the identity — the same rule `ParticleSystem`
      // states for itself. Positioning the group instead would double-count the origin, and
      // rotating it would swing the particles already in flight with it, which is what makes a
      // moving emitter drag its own trail sideways.
      release.state.origin.copy(release.localOffset).applyQuaternion(this.aim).add(base.origin);
      release.state.direction.copy(release.localDirection).applyQuaternion(this.aim).normalize();
    }

    for (const billboard of this.billboards) {
      billboard.animator.reset();
      billboard.sprite.visible = false;
      billboard.sprite.position.copy(billboard.localOffset).applyQuaternion(this.aim).add(base.origin);
    }
  }

  /**
   * Moves the effect's origin while it runs — for an effect carried by a bone.
   *
   * Only the *spawn point* moves. `ParticleSystem` reads its emitter state live each time it places
   * a particle, so rewriting the origin walks the release while every particle already in flight
   * stays where it was born — a hand swung through a continuous release leaves a trail rather than
   * dragging a rigid ball of fire round with it. Moving `object3d` instead would do the second,
   * which is the reason the group is never moved at all.
   *
   * The aim `burst` was given is kept: a follow moves an effect, it does not re-point it. Billboards
   * move with it, since a flipbook on a hand is expected to stay on the hand.
   */
  follow(origin: Vector3): void {
    for (const release of this.releases) {
      release.state.origin.copy(release.localOffset).applyQuaternion(this.aim).add(origin);
    }
    for (const billboard of this.billboards) {
      billboard.sprite.position.copy(billboard.localOffset).applyQuaternion(this.aim).add(origin);
    }
  }

  /** Closes every emitter early. Particles in flight still finish, so the effect fades out. */
  stop(): void {
    this.firing = false;
    for (const release of this.releases) release.system.stop();
  }

  /** Closes everything and kills what is in flight. For a teardown, not an effect ending. */
  clear(): void {
    this.firing = false;
    this.elapsed = 0;
    for (const release of this.releases) {
      release.system.clear();
      release.opened = false;
    }
    for (const billboard of this.billboards) {
      billboard.sprite.visible = false;
      billboard.animator.reset();
    }
  }

  update(dt: number, globalElapsed: number): void {
    if (this.firing) this.elapsed += dt;

    for (const release of this.releases) {
      const spec = release.spec;

      if (this.firing && !release.opened && this.elapsed >= spec.startDelaySeconds) {
        release.opened = true;
        // A continuous release runs to the end of the effect; a burst runs for its own window.
        const window = spec.emissionMode === 'continuous'
          ? Math.max(0.05, this.spec.durationSeconds - spec.startDelaySeconds)
          : Math.max(0.02, spec.burstSeconds);
        release.system.burst(release.state, window);
      }

      release.system.update(dt, globalElapsed);
    }

    for (const billboard of this.billboards) {
      const local = this.elapsed - billboard.spec.startDelaySeconds;
      const duration = Math.max(0.05, billboard.spec.durationSeconds);

      if (!this.firing || local < 0 || local > duration) {
        billboard.sprite.visible = false;
        continue;
      }

      billboard.sprite.visible = true;
      billboard.animator.update(dt);

      const t = local / duration;
      const size = billboard.spec.sizeStart + (billboard.spec.sizeEnd - billboard.spec.sizeStart) * t;
      const aspect = billboard.animator.cellAspect ?? 1;
      billboard.sprite.scale.set(size * aspect, size, 1);

      if (billboard.spec.spinDegreesPerSecond !== 0) {
        billboard.material.rotation = (local * billboard.spec.spinDegreesPerSecond * Math.PI) / 180;
      }
    }

    if (this.firing && this.elapsed >= this.totalSeconds()) this.firing = false;
  }

  dispose(): void {
    for (const release of this.releases) {
      this.object3d.remove(release.system.points);
      release.system.dispose();
    }
    for (const billboard of this.billboards) {
      this.object3d.remove(billboard.sprite);
      billboard.animator.dispose();
      billboard.material.dispose();
    }
    this.releases.length = 0;
    this.billboards.length = 0;
  }

  /** The axis the effect was authored around, which `burst` swings onto the attack's direction. */
  private primaryAxis(): Vector3 {
    const first = this.spec.emitters.find((emitter) => emitter.enabled);
    if (!first) return AXIS_UP;
    scratchVec.set(first.direction[0], first.direction[1], first.direction[2]);
    return scratchVec.lengthSq() < 1e-8 ? AXIS_UP : scratchVec.clone().normalize();
  }

  /** How long the whole effect runs: its authored timeline, or the last thing in it if longer. */
  private totalSeconds(): number {
    let total = Math.max(0.1, this.spec.durationSeconds);
    for (const emitter of this.spec.emitters) {
      total = Math.max(total, emitter.startDelaySeconds + emitter.burstSeconds + emitter.lifespanMax);
    }
    for (const billboard of this.spec.billboards) {
      total = Math.max(total, billboard.startDelaySeconds + billboard.durationSeconds);
    }
    return total;
  }
}

/**
 * One release's tuning, with its particle budget divided among however many arms it has.
 *
 * Exported for `__tests__/vfx.test.ts`. It and `vfxArmDirection` are the whole mapping from an
 * authored effect onto what actually runs, and neither can be reached through `VfxSystem` in a
 * node process — building one needs a canvas.
 */
export function vfxEmitterTuning(emitter: VfxEmitterSpec, scale: number, arms: number): ParticleTuning {
  const stops = emitter.colorStops ?? [];
  const first = stops[0];
  const last = stops[stops.length - 1];

  return {
    particleCount: Math.max(32, Math.round(emitter.particleCount / arms)),
    lifespanMin: emitter.lifespanMin,
    lifespanMax: Math.max(emitter.lifespanMin, emitter.lifespanMax),
    speedMin: emitter.speedMin * scale,
    speedMax: Math.max(emitter.speedMin, emitter.speedMax) * scale,
    gravity: emitter.gravity * scale,
    sizeStart: emitter.sizeStart * scale,
    sizeEnd: emitter.sizeEnd * scale,
    colorStartHex: first?.color ?? '#ffffff',
    colorEndHex: last?.color ?? first?.color ?? '#ffffff',
    turbulenceIntensity: emitter.turbulence,
    additiveBlending: emitter.additiveBlending,
    burstSeconds: Math.max(0.02, emitter.burstSeconds),
    drag: Math.max(0, emitter.drag ?? 0),
  };
}

/**
 * The spec's spread, as `ParticleSystem`'s focus.
 *
 * Focus blends between the launch direction and a random one — 1 is a jet, 0 a sphere — so a
 * half-angle in degrees maps onto it directly. Omni is 0 by definition; a vortex is treated as a
 * loose cone about its tangent, which is what its per-arm direction already points along.
 */
export function vfxFocus(emitter: VfxEmitterSpec): number {
  if (emitter.directionMode === 'omni') return 0;
  const spread = Math.max(0, Math.min(180, emitter.spreadDegrees));
  return Math.max(0, 1 - spread / 180);
}

/** The spawn disc's radius, in metres, for whichever shape the release uses. */
function spawnRadiusFor(emitter: VfxEmitterSpec): number {
  switch (emitter.shape) {
    case 'point':
    case 'line':
      return 0;
    default:
      return Math.max(0, emitter.radius);
  }
}

/** The spawn column's height, for the shapes that have one. */
function spawnHeightFor(emitter: VfxEmitterSpec): number {
  switch (emitter.shape) {
    case 'box':
    case 'cone':
    case 'line':
      return Math.max(0, emitter.height);
    case 'sphere':
      // A ball, approximated by a disc the same height as it is wide.
      return Math.max(0, emitter.radius * 2);
    default:
      return 0;
  }
}

/**
 * The direction one arm of a release launches along, in the effect's own space.
 *
 * For everything but a multi-directional fan this is simply the authored aim. For a fan, the arms
 * are spokes standing square to that aim, evenly spaced around it and rotated as a set by
 * `armSpinDegrees` — so aiming a fan up gives a nova sweeping the floor, and aiming it forward
 * gives spokes fanning across the screen.
 */
export function vfxArmDirection(emitter: VfxEmitterSpec, arm: number, arms: number): Vector3 {
  const aim = new Vector3(emitter.direction[0], emitter.direction[1], emitter.direction[2]);
  if (aim.lengthSq() < 1e-8) aim.set(0, 1, 0);
  aim.normalize();

  if (emitter.directionMode !== 'multi_directional' || arms <= 1) {
    if (emitter.directionMode === 'inward') return aim.multiplyScalar(-1);
    return aim;
  }

  const seed = Math.abs(aim.y) > 0.94 ? new Vector3(1, 0, 0) : new Vector3(0, 1, 0);
  const tangent = seed.clone().cross(aim).normalize();
  const bitangent = aim.clone().cross(tangent).normalize();

  const theta = (arm / arms) * Math.PI * 2 + (emitter.armSpinDegrees * Math.PI) / 180;
  return tangent.multiplyScalar(Math.cos(theta))
    .addScaledVector(bitangent, Math.sin(theta))
    .normalize();
}
