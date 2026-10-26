import {
  AdditiveBlending, ClampToEdgeWrapping, DoubleSide, LinearFilter, MeshBasicMaterial,
  NormalBlending, SRGBColorSpace, Sprite, SpriteMaterial, TextureLoader,
} from 'three';
import type { Texture } from 'three';

/**
 * Flipbook sprite sheets: the second way an effect can be drawn, beside `ParticleSystem`.
 *
 * A particle burst is a thousand identical dots and is at its best when the effect *is* a cloud —
 * dust, sparks, a jet. It is at its worst when the effect has a drawn shape, because a shape made
 * of dots is a shape the artist did not draw. These sheets are the other half of that: one hand-
 * authored explosion, played as frames, which costs a single quad-worth of fill instead of a
 * thousand and looks like art rather than like a scatter plot.
 *
 * The engine is a grid reader, not a format. Nothing here knows that the shipped sheets are 4x4;
 * `columns` and `rows` are per-sheet, so a 4x4 of 128x128 cells (which is what `fire` and
 * `lightning` are), a 4x4 of oblong ones and an 8x8 of anything all play through the same code.
 * Register a spec and it works — see `registerSpriteSheet`.
 *
 * Three decisions here are load-bearing:
 *
 * 1. **The frame window is a UV transform, not a shader.** `offset` and `repeat` on the texture
 *    move a 1/columns × 1/rows window across the sheet, and three folds that into the material's
 *    `uvTransform` uniform. So any geometry with a `uv` attribute — every three.js primitive has
 *    one — is a valid surface for a sheet with no custom material and no UV rewriting.
 * 2. **Every player gets its own texture, and they all share one upload.** `offset` lives on the
 *    Texture, so two effects playing at different frames cannot share one; but `Texture.clone()`
 *    shares the underlying `Source`, and three's texture cache is keyed on the source. Ten
 *    explosions therefore cost ten samplers and one 6MB GPU image, not ten of them.
 * 3. **No mipmaps.** A mipmap of a sheet blends *neighbouring cells* together as it shrinks, so a
 *    distant explosion would sample the frame before and after the one it is playing. Minification
 *    shimmer is the cheaper artefact, and these are drawn large and briefly.
 *
 * Nothing here bundles an asset, for the same reason `syntyRoster.ts` does not: the paths below are
 * ones the *server* answers, resolved through `ArcadeGameClient.assetUrl`. Baking four megabytes of
 * PNG into a bundle whose whole point is being small enough to deploy on its own is exactly the
 * trade the asset host exists to avoid.
 */

/** A sheet's grid and default playback. Cell size is derived from the image, never declared. */
export interface SpriteSheetSpec {
  /** Server path, resolved through `ArcadeGameClient.assetUrl`. Not a bundled import. */
  path: string;
  columns: number;
  rows: number;
  /**
   * Frames actually played, when the grid is larger than the animation.
   *
   * Defaults to `columns * rows`. Present for a sheet whose author padded the last row out to a
   * square — playing those blank cells reads as the effect hanging for a beat before it ends.
   */
  frameCount?: number;
  /** Frames per second. The whole sheet at this rate is one cycle. */
  fps?: number;
  /** True holds the effect on screen indefinitely; false stops on the last frame. */
  loop?: boolean;
  /**
   * False for painted art that should cover what is behind it rather than glow — a glob of goo
   * has dark shading, and additive blending turns dark into see-through. A caller's own
   * `additive` option still wins.
   */
  additive?: boolean;
  /**
   * False for a sheet drawn in its own colours. A caller's `colorHex` is then ignored, because
   * multiplying finished art by a tint only darkens it and drains its highlights.
   */
  tintable?: boolean;
}

const DEFAULT_FPS = 24;

/**
 * The sheets that ship with the SDK.
 *
 * Both are radial bursts on a 4x4 grid of square 128x128 cells: a bright point, through full
 * bloom, out to scattered embers. They are authored to be *played once* as an impact — looping
 * them reads as a pulse, which is right for a lingering fire but wrong for a hit — so `loop` is
 * left off here and turned on per use.
 *
 * The art inside each cell is wider than it is tall and is letterboxed into the square rather than
 * stretched to fill it, which is why `cellAspect` reads 1 for these: the transparent bands are
 * part of the cell. That is deliberate on both counts — squashing a radial burst into a square
 * turns it into an oval, and the padding doubles as a gutter that keeps bilinear filtering at a
 * cell edge from dragging in the neighbouring frame.
 */
const BUILT_IN_SHEETS: Record<string, SpriteSheetSpec> = {
  fire: {
    path: 'SPRITESHEETS/firesprite4x4.png',
    columns: 4,
    rows: 4,
    fps: DEFAULT_FPS,
    loop: false,
  },
  lightning: {
    path: 'SPRITESHEETS/lightningsprite4x4.png',
    columns: 4,
    rows: 4,
    // Fourteen, not sixteen. The last two cells of this sheet are empty — the bolt has fully
    // dissipated by frame 13 — and playing them holds a blank quad on screen for a seventh of the
    // effect. Looped, that reads as a stutter between repeats rather than as a tail.
    frameCount: 14,
    fps: DEFAULT_FPS,
    loop: false,
  },
};

/** Built-ins plus whatever a game has registered. Keyed by id, not by path. */
const sheetSpecs = new Map<string, SpriteSheetSpec>(Object.entries(BUILT_IN_SHEETS));

/**
 * Adds a sheet under an id, or replaces one already there.
 *
 * The extension point the whole module is shaped around: a game with its own 4x4 of 128x128 frames
 * registers it here and every consumer below — materials, billboards, the attack runner's
 * primitives — can name it, with no change to any of them.
 */
export function registerSpriteSheet(id: string, spec: SpriteSheetSpec): void {
  sheetSpecs.set(id, spec);
}

/** The spec registered under `id`, or null. Null rather than throwing: a missing effect is not a
 * reason to take a level down, and the callers below fall back to drawing nothing. */
export function spriteSheetSpec(id: string): SpriteSheetSpec | null {
  return sheetSpecs.get(id) ?? null;
}

/** Every registered id, built-ins first. For a picker, and for preloading the lot. */
export function spriteSheetIds(): string[] {
  return [...sheetSpecs.keys()];
}

/**
 * Which built-in sheet suits a tint.
 *
 * Content authors an attack's colour long before it has any art, so the colour is the only signal
 * available for picking between the two shipped sheets without a migration. Blues and violets are
 * electrical and everything else — reds, oranges, yellows, greens, greys — reads closer to flame
 * than to lightning, so the split is a hue window rather than a nearest-colour match.
 *
 * Only ever a default. An explicit sheet id always wins.
 */
export function sheetIdForTint(colorHex: string): string {
  const hex = colorHex.replace('#', '');
  if (hex.length !== 6 && hex.length !== 3) return 'fire';

  const expand = hex.length === 3
    ? hex.split('').map(c => c + c).join('')
    : hex;
  const r = parseInt(expand.slice(0, 2), 16) / 255;
  const g = parseInt(expand.slice(2, 4), 16) / 255;
  const b = parseInt(expand.slice(4, 6), 16) / 255;
  if (!Number.isFinite(r + g + b)) return 'fire';

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const chroma = max - min;
  // Near-grey has no hue to read, and forcing one would make #808080 electric on a rounding error.
  if (chroma < 0.08) return 'fire';

  let hue: number;
  if (max === r) hue = ((g - b) / chroma) % 6;
  else if (max === g) hue = (b - r) / chroma + 2;
  else hue = (r - g) / chroma + 4;
  hue *= 60;
  if (hue < 0) hue += 360;

  return hue >= 185 && hue <= 295 ? 'lightning' : 'fire';
}

// ── Textures ──────────────────────────────────────────────────────────────────────────

/** One entry per URL for the life of the session, shared by every animator playing that sheet. */
const textureCache = new Map<string, Texture>();

/**
 * The shared source texture for a sheet URL. Never handed to a material directly — clone it.
 *
 * `flipY` is left at three's default (true) here, unlike `loadSyntyTexture`: these are not glTF
 * maps, they are sheets read against three's own primitive UVs, whose origin is the bottom left.
 * `frameOffset` below is written for that convention, and flipping the image would silently play
 * the sheet's rows bottom-up — an explosion that starts as embers and collapses into a spark.
 */
export function loadSpriteSheetTexture(url: string): Texture {
  const cached = textureCache.get(url);
  if (cached) return cached;

  const texture = new TextureLoader().load(url);
  texture.colorSpace = SRGBColorSpace;
  texture.wrapS = ClampToEdgeWrapping;
  texture.wrapT = ClampToEdgeWrapping;
  // See the note at the top: mipmaps of a sheet blend adjacent frames into each other.
  texture.generateMipmaps = false;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;

  textureCache.set(url, texture);
  return texture;
}

/**
 * The UV window for one cell, in three's bottom-left-origin space.
 *
 * Exported because it is the one piece of arithmetic in this file that is easy to get wrong in a
 * way that looks *almost* right — an off-by-one row plays the sheet upside down, which reads as
 * bad art rather than as a bug — and it is worth being able to assert on directly.
 *
 * Frames run left to right, top row first, which is how sheets are drawn and read.
 */
export function frameOffset(index: number, columns: number, rows: number): [number, number] {
  const column = index % columns;
  const row = Math.floor(index / columns);
  return [column / columns, 1 - (row + 1) / rows];
}

// ── Playback ──────────────────────────────────────────────────────────────────────────

/**
 * One playing sheet: a private texture, a clock, and the frame window that follows from them.
 *
 * Constructed around a texture rather than a URL so it can be driven in a test — and so a caller
 * that already has the shared texture is not forced back through the cache to get a player for it.
 * Use `SpriteSheetLibrary` for the ordinary path, which does the cloning.
 */
export class SpriteSheetAnimator {
  readonly texture: Texture;
  readonly columns: number;
  readonly rows: number;
  readonly frameCount: number;

  /** Mutable so an effect can slow down or speed up without being rebuilt. */
  fps: number;
  loop: boolean;

  private elapsed = 0;
  /** Last frame written to the texture, so a frame that has not changed costs nothing. */
  private applied = -1;

  constructor(texture: Texture, spec: SpriteSheetSpec) {
    this.texture = texture;
    this.columns = Math.max(1, Math.floor(spec.columns));
    this.rows = Math.max(1, Math.floor(spec.rows));
    this.frameCount = Math.max(
      1,
      Math.min(this.columns * this.rows, Math.floor(spec.frameCount ?? this.columns * this.rows))
    );
    this.fps = spec.fps ?? DEFAULT_FPS;
    this.loop = spec.loop ?? false;

    // Set once. Only `offset` moves after this.
    this.texture.repeat.set(1 / this.columns, 1 / this.rows);
    this.applyFrame(0);
  }

  /** Seconds one full pass takes. Useful for matching an effect's length to an attack's. */
  get durationSeconds(): number {
    return this.frameCount / Math.max(0.0001, this.fps);
  }

  /** The frame currently on the texture. */
  get frame(): number {
    return Math.max(0, this.applied);
  }

  /** True once a non-looping sheet has played its last frame, which it then holds. */
  get finished(): boolean {
    return !this.loop && this.elapsed >= this.durationSeconds;
  }

  /**
   * Width over height of a single cell, or null before the image has arrived.
   *
   * Read off the image rather than declared, because a spec that carried its own cell size would
   * be a second answer to a question the file already answers — and the two would eventually
   * disagree. Null is not an error: `TextureLoader` returns a texture immediately and fills its
   * image in later, so every caller has to cope with not knowing yet.
   */
  get cellAspect(): number | null {
    const image = this.texture.image as { width?: number; height?: number } | null | undefined;
    if (!image?.width || !image.height) return null;
    return (image.width / this.columns) / (image.height / this.rows);
  }

  /** Advances the clock. A finished non-looping sheet stops here and holds its last frame. */
  update(dt: number): void {
    if (this.finished) return;
    this.elapsed += dt;
    this.applyFrame(this.frameAt(this.elapsed));
  }

  /**
   * Plays to a point in the sheet directly, `0` to `1`, ignoring fps.
   *
   * For an effect that has to be exactly as long as something else — an explosion that must finish
   * as its attack resolves, a charge-up that tracks a windup. Driving those off `update` means the
   * sheet and the thing it illustrates run on two clocks and drift apart at the ends.
   */
  seek(progress: number): void {
    const clamped = Math.max(0, Math.min(1, progress));
    this.elapsed = clamped * this.durationSeconds;
    this.applyFrame(this.frameAt(this.elapsed));
  }

  /** Back to the first frame. What a pooled effect calls when it is fired again. */
  reset(): void {
    this.elapsed = 0;
    this.applied = -1;
    this.applyFrame(0);
  }

  /**
   * Releases this player's sampler.
   *
   * Safe while other animators are mid-play on the same sheet: they hold their own clones, and
   * three reference-counts the shared `Source`, so the image itself survives until the last one
   * goes. The cached source texture is never disposed — every future effect of this kind would
   * have to re-download it.
   */
  dispose(): void {
    this.texture.dispose();
  }

  private frameAt(elapsed: number): number {
    const raw = Math.floor(elapsed * this.fps);
    if (this.loop) return ((raw % this.frameCount) + this.frameCount) % this.frameCount;
    return Math.max(0, Math.min(this.frameCount - 1, raw));
  }

  private applyFrame(index: number): void {
    if (index === this.applied) return;
    this.applied = index;
    const [u, v] = frameOffset(index, this.columns, this.rows);
    this.texture.offset.set(u, v);
  }
}

// ── Building things to draw ───────────────────────────────────────────────────────────

/** The tint a sheet is drawn with: the caller's, unless the sheet keeps its own colours. */
function sheetColor(id: string, options: SpriteSheetVisualOptions): string {
  return spriteSheetSpec(id)?.tintable === false ? '#ffffff' : options.colorHex ?? '#ffffff';
}

/** The caller's choice of blending, then the sheet's, then additive. */
function sheetBlending(id: string, options: SpriteSheetVisualOptions) {
  return (options.additive ?? spriteSheetSpec(id)?.additive) === false ? NormalBlending : AdditiveBlending;
}

export interface SpriteSheetVisualOptions {
  /** Multiplied over the sheet, so an authored colour still tints shipped art. */
  colorHex?: string;
  /**
   * Additive blending. On by default: fire and lightning are light, and light adds.
   *
   * Turn it off for a sheet that is meant to be opaque — smoke, a decal, a splatter — where
   * additive would make it glow instead of covering what is behind it.
   */
  additive?: boolean;
  opacity?: number;
  /** Overrides the spec. */
  fps?: number;
  /** Overrides the spec. */
  loop?: boolean;
  /**
   * Off by default, and the reason effects layer correctly.
   *
   * A transparent quad that writes depth punches a hole in everything drawn after it, so two
   * overlapping explosions erase each other's far halves.
   */
  depthWrite?: boolean;
}

/** A material bound to a sheet, and the player that moves it. Tick the animator every frame. */
export interface SpriteSheetMaterial {
  material: MeshBasicMaterial;
  animator: SpriteSheetAnimator;
}

/**
 * A camera-facing quad playing a sheet, and the player that moves it.
 *
 * `Sprite` rather than a `Mesh` with a billboard constraint because these sheets are drawn art with
 * a front — a 2D explosion seen edge-on is a line. Three's sprite is always square to the camera,
 * so there is no angle from which the effect disappears.
 */
export interface SpriteSheetBillboard {
  sprite: Sprite;
  animator: SpriteSheetAnimator;
  /** Exposed so a caller can fade the effect out, which is the one thing `update` cannot know. */
  material: SpriteMaterial;
  /** Scales the sprite to `heightMeters`, keeping the cell's aspect. */
  setHeight(heightMeters: number): void;
  /**
   * Advances the flipbook, and settles the sprite's shape once the image has arrived.
   *
   * The second half is why this exists rather than callers ticking `animator` themselves.
   * `cellAspect` is unknown until the texture loads — see the note on that getter — so a sprite
   * sized before then is square, and for the shipped sheets that happens to be right while for an
   * oblong one it is a stretched explosion that never corrects itself. Re-applying the last
   * requested height on the frame the aspect first becomes known fixes it without making every
   * caller remember to.
   */
  update(dt: number): void;
  dispose(): void;
}

/**
 * Builds materials and billboards against a URL resolver.
 *
 * The resolver is a constructor argument for the same reason `InputRuntime` takes its catalog that
 * way: the SDK has no business knowing whether assets come from a dev server's public directory, a
 * deployed `wwwroot`, or a GCS proxy. Callers with a `ModelLoader` already have exactly the right
 * function to hand over — `models.assetUrl`.
 */
export class SpriteSheetLibrary {
  private readonly resolveUrl: (path: string) => string;

  constructor(resolveUrl: (path: string) => string) {
    this.resolveUrl = resolveUrl;
  }

  /** The absolute URL for a registered sheet, or null if nothing is registered under `id`. */
  urlFor(id: string): string | null {
    const spec = sheetSpecs.get(id);
    return spec ? this.resolveUrl(spec.path) : null;
  }

  /**
   * Starts the download for these sheets, or all of them.
   *
   * Worth calling as combat comes up rather than on the first hit. `TextureLoader` hands back a
   * texture with no image in it and fills that in when the bytes arrive, so a sheet used before it
   * has loaded draws as a white quad for a few frames — and the first explosion of a session is
   * exactly the one nobody wants to be a white square.
   */
  preload(ids: string[] = spriteSheetIds()): void {
    for (const id of ids) {
      const url = this.urlFor(id);
      if (url) loadSpriteSheetTexture(url);
    }
  }

  /**
   * A player for `id` with its own sampler, or null when nothing is registered under it.
   *
   * The clone is the point — see the note at the top of the file about why every player needs its
   * own texture and why that still costs one upload.
   */
  animator(id: string, options: Pick<SpriteSheetVisualOptions, 'fps' | 'loop'> = {}): SpriteSheetAnimator | null {
    const spec = sheetSpecs.get(id);
    if (!spec) return null;

    const shared = loadSpriteSheetTexture(this.resolveUrl(spec.path));
    return new SpriteSheetAnimator(shared.clone(), {
      ...spec,
      fps: options.fps ?? spec.fps,
      loop: options.loop ?? spec.loop,
    });
  }

  /**
   * A material for `id`, ready to put on any geometry that has UVs, or null when `id` is unknown.
   *
   * Unlit on purpose. An explosion lit by the scene is darker in shadow than in sun, which is
   * backwards — it *is* the light source — and it also means the same attack reads differently
   * depending on where in a level it lands.
   */
  material(id: string, options: SpriteSheetVisualOptions = {}): SpriteSheetMaterial | null {
    const animator = this.animator(id, options);
    if (!animator) return null;

    const material = new MeshBasicMaterial({
      map: animator.texture,
      color: sheetColor(id, options),
      transparent: true,
      opacity: options.opacity ?? 1,
      blending: sheetBlending(id, options),
      depthWrite: options.depthWrite ?? false,
      // Both sides, because a sheet on a ring or a disc is watched from above and below as the
      // camera swings, and a single-sided one vanishes halfway round.
      side: DoubleSide,
      toneMapped: false,
    });

    return { material, animator };
  }

  /** A camera-facing quad playing `id`, or null when `id` is unknown. */
  billboard(id: string, options: SpriteSheetVisualOptions = {}): SpriteSheetBillboard | null {
    const animator = this.animator(id, options);
    if (!animator) return null;

    const material = new SpriteMaterial({
      map: animator.texture,
      color: sheetColor(id, options),
      transparent: true,
      opacity: options.opacity ?? 1,
      blending: sheetBlending(id, options),
      depthWrite: options.depthWrite ?? false,
      toneMapped: false,
    });

    const sprite = new Sprite(material);

    let height = 1;
    /** Null until the image lands, and the reason `update` re-applies the size exactly once. */
    let sizedForAspect: number | null = null;

    const applySize = (): void => {
      const aspect = animator.cellAspect;
      sizedForAspect = aspect;
      sprite.scale.set(height * (aspect ?? 1), height, 1);
    };

    applySize();

    return {
      sprite,
      animator,
      material,
      setHeight(heightMeters: number): void {
        height = heightMeters;
        applySize();
      },
      update(dt: number): void {
        animator.update(dt);
        if (sizedForAspect === null && animator.cellAspect !== null) applySize();
      },
      dispose(): void {
        sprite.removeFromParent();
        material.dispose();
        animator.dispose();
      },
    };
  }
}
