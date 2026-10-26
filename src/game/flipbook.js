import {
  AdditiveBlending, ClampToEdgeWrapping, Color, LinearFilter, NormalBlending, SRGBColorSpace, Sprite, SpriteMaterial,
  TextureLoader,
} from '@iwsdk/core';
import { ASSETS } from '../content/assets.js';
import { assetUrl } from '../models.js';

/**
 * A sprite sheet played as a camera-facing flipbook, for `setProjectileModel`: the spitter's bile
 * (`spit.js`) and the singer's bolt (`lightning.js`).
 *
 * The export's copy of Game Foundry's `game/sdk/SpriteSheet.ts`, cut down to what a shot in flight
 * needs. Frames run left to right, top row first; a sheet travels in `addon.json`'s `sprites`, and
 * one the export does not carry flies the attack's plain primitive instead.
 */

/** One load per sheet, shared: every shot clones it, and a clone shares the image upload. */
const sheets = new Map();

function loadSheet(path) {
  if (sheets.has(path)) return sheets.get(path);
  const file = ASSETS.textures?.[path];
  if (!file) {
    sheets.set(path, null);
    return null;
  }
  const sheet = new TextureLoader().load(assetUrl(file), undefined, undefined, () => {
    console.warn(`[flipbook] Sprite sheet missing: ${file}`);
  });
  sheet.colorSpace = SRGBColorSpace;
  sheet.wrapS = sheet.wrapT = ClampToEdgeWrapping;
  // No mipmaps: a shrunken sheet blends each cell with its neighbours.
  sheet.generateMipmaps = false;
  sheet.minFilter = LinearFilter;
  sheet.magFilter = LinearFilter;
  sheets.set(path, sheet);
  return sheet;
}

/**
 * A looping flipbook of `path`, `height` metres tall, or null when the export has no such sheet.
 * `additive` for light (a bolt), off for painted art with dark shading (goo); `color` tints it.
 * Carries the `userData.tick` and `userData.dispose` that `setProjectileModel` asks for.
 */
export function flipbook(path, { columns, rows, frames = columns * rows, fps, height, additive = false, color = null }) {
  const base = loadSheet(path);
  if (!base) return null;

  const texture = base.clone();
  texture.repeat.set(1 / columns, 1 / rows);
  const material = new SpriteMaterial({
    map: texture, transparent: true, depthWrite: false, toneMapped: false,
    blending: additive ? AdditiveBlending : NormalBlending,
    ...(color === null ? {} : { color: new Color(color) }),
  });
  const sprite = new Sprite(material);
  sprite.scale.setScalar(height);

  // Rows read top to bottom, and a texture's v runs bottom to top.
  const show = (frame) => {
    texture.offset.set((frame % columns) / columns, 1 - (Math.floor(frame / columns) + 1) / rows);
  };
  let time = 0;
  show(0);
  sprite.userData.tick = (delta) => {
    time += delta;
    show(Math.floor(time * fps) % frames);
  };
  sprite.userData.dispose = () => {
    material.dispose();
    texture.dispose();
  };
  return sprite;
}
