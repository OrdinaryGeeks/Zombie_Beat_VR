import {
  AnimationMixer, AssetManager, Box3, BoxGeometry, CapsuleGeometry, Color, Group, LoopOnce, Mesh,
  MeshStandardMaterial, SRGBColorSpace, TextureLoader, Vector3,
} from '@iwsdk/core';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { ASSETS } from './content/assets.js';
import { attachCues } from './cues.js';

/**
 * Turning content into things you can see: characters, props, loot and the level itself.
 *
 * Every path in `GAME` is relative to `public/`. A model that is missing — never exported, or
 * deleted since — draws as a coloured capsule or box instead of failing, so a level always loads.
 */

const textureCache = new Map();
const missing = new Set();

/** A URL for a `public/` path that works under any `base` the site is served from. */
export function assetUrl(path) {
  return `${import.meta.env.BASE_URL}${path.replace(/^\//, '')}`;
}

/** Loads a texture atlas page the way glTF UVs expect it: unflipped, sRGB. Cached per path. */
export function loadTexture(path) {
  if (!path) return null;
  if (!textureCache.has(path)) {
    const texture = new TextureLoader().load(assetUrl(path), undefined, undefined, () => {
      console.warn(`[models] Texture missing: ${path}`);
    });
    texture.colorSpace = SRGBColorSpace;
    texture.flipY = false;
    texture.anisotropy = 8;
    textureCache.set(path, texture);
  }
  return textureCache.get(path);
}

/** Binds one atlas page to every mesh under `root`. */
export function applyTexture(root, texture) {
  if (!texture) return;
  root.traverse((node) => {
    if (!node.isMesh) return;
    const materials = Array.isArray(node.material) ? node.material : [node.material];
    const next = materials.map((material) => {
      const copy = material?.isMeshStandardMaterial ? material.clone() : new MeshStandardMaterial();
      copy.map = texture;
      copy.color = new Color(0xffffff);
      copy.needsUpdate = true;
      return copy;
    });
    node.material = Array.isArray(node.material) ? next : next[0];
  });
}

async function loadGltf(path) {
  if (!path || missing.has(path)) return null;
  try {
    return await AssetManager.loadGLTF(assetUrl(path), path);
  } catch (err) {
    missing.add(path);
    console.warn(`[models] Could not load ${path}; drawing a placeholder instead.`, err);
    return null;
  }
}

/**
 * Uniformly scales `object` so its height is `height` metres, with its feet at y = 0.
 *
 * Matrices and skeletons are brought up to date first. A model fresh from the cache has never been
 * updated, and a skinned mesh's bounds are read through its bones: measured stale, a Synty zombie
 * comes out at 3 mm (and slipped under the guard below, drawn at its own size by luck) while a
 * Zombie Boss, whose mesh sits outside its `Root`, comes out at 2 cm and was blown up a hundredfold.
 */
function fitHeight(object, height) {
  object.updateMatrixWorld(true);
  object.traverse((node) => node.skeleton?.update());
  const box = new Box3().setFromObject(object);
  const size = box.getSize(new Vector3());
  if (!(size.y > 0.01)) return;
  const scale = height / size.y;
  object.scale.multiplyScalar(scale);
  object.position.y -= box.min.y * scale;
}

/** Scales `object` so its largest side is at most `maxSize` metres, keeping small props as made. */
function fitWithin(object, maxSize) {
  object.updateMatrixWorld(true);
  const box = new Box3().setFromObject(object);
  const size = box.getSize(new Vector3());
  const largest = Math.max(size.x, size.y, size.z);
  if (largest > maxSize || largest < 0.05) object.scale.multiplyScalar(maxSize / Math.max(largest, 0.01));
  const fitted = new Box3().setFromObject(object);
  object.position.y -= fitted.min.y;
}

const FACTION_COLOURS = { hostile: 0xdc2626, player: 0x2563eb, wild: 0x9333ea, passive: 0x16a34a, giver: 0xeab308 };

function placeholderCharacter(colour, height) {
  const radius = height * 0.18;
  const mesh = new Mesh(
    new CapsuleGeometry(radius, height - radius * 2, 4, 12),
    new MeshStandardMaterial({ color: colour, roughness: 0.6 }),
  );
  mesh.position.y = height / 2;
  return mesh;
}

/**
 * A character for an entity row. Returns a `Group` whose origin is at its feet, with
 * `userData.mixer` set when the model brought animations of its own.
 */
export async function createCharacter(entity, { colourKey }) {
  const root = new Group();
  root.name = entity.key;
  const gltf = await loadGltf(entity.model);
  if (gltf) {
    const body = cloneSkinned(gltf.scene);
    body.traverse((node) => {
      if (node.isMesh) {
        node.castShadow = true;
        // Skinned meshes animate outside their bind-pose bounds; culling them pops limbs away.
        node.frustumCulled = false;
      }
    });
    applyTexture(body, loadTexture(entity.texture));
    fitHeight(body, entity.height);
    root.add(body);

    if (gltf.animations?.length) {
      const mixer = new AnimationMixer(body);
      const clips = gltf.animations;
      // Game Foundry bakes these by name (`src/xrExport/bakeClips.ts`), so the exact name wins; the
      // patterns are for a model that brought clips of its own. One without them just swings and
      // falls the way it always did.
      const named = (name, pattern) => clips.find((c) => c.name === name) ?? clips.find((c) => pattern.test(c.name));
      const idle = named('idle', /idle/i) ?? clips[0];
      const walk = named('walk', /walk|run/i) ?? null;
      const attack = named('attack', /attack|punch|swing/i) ?? null;
      const death = named('death', /death|dying|die/i) ?? null;
      root.userData.mixer = mixer;
      root.userData.actions = {
        idle: mixer.clipAction(idle),
        walk: walk ? mixer.clipAction(walk) : null,
        attack: attack ? mixer.clipAction(attack) : null,
        death: death ? mixer.clipAction(death) : null,
      };
      // Every other take, by name: what an attack's `actionClipKey` plays in place of `attack`
      // (`NpcSystem.swing`). Once through, like the attack.
      root.userData.takes = {};
      for (const clip of clips) {
        if (['idle', 'walk', 'attack', 'death'].includes(clip.name)) continue;
        const take = mixer.clipAction(clip);
        take.setLoop(LoopOnce, 1);
        take.clampWhenFinished = true;
        root.userData.takes[clip.name] = take;
      }
      for (const once of [root.userData.actions.attack, root.userData.actions.death]) {
        if (!once) continue;
        once.setLoop(LoopOnce, 1);
        once.clampWhenFinished = true;
      }
      root.userData.actions.idle.play();
      // Effects cued on any of these takes fire as they play (`cues.js`).
      attachCues(body, entity.model, clips, mixer);
    }
  } else {
    root.add(placeholderCharacter(FACTION_COLOURS[colourKey] ?? 0x64748b, entity.height));
  }
  return root;
}

/** A prop or scenery piece, at most `maxSize` metres across. */
export async function createProp(prop, maxSize = 4) {
  const root = new Group();
  const gltf = await loadGltf(prop.model);
  if (gltf) {
    const body = gltf.scene.clone(true);
    applyTexture(body, loadTexture(prop.texture));
    fitWithin(body, maxSize);
    root.add(body);
  } else {
    const box = new Mesh(new BoxGeometry(0.8, 0.8, 0.8), new MeshStandardMaterial({ color: 0x78716c }));
    box.position.y = 0.4;
    root.add(box);
  }
  return root;
}

const RARITY_COLOURS = {
  common: 0xe5e7eb, uncommon: 0x22c55e, rare: 0x3b82f6, epic: 0xa855f7, legendary: 0xf59e0b, mythic: 0xef4444,
};

/**
 * A game's say in what a drop looks like: `(item, quantity) => path | null`. A path (under
 * `public/`) is drawn instead of the item's own model; null leaves the item to draw itself. Set by
 * a game's `install` — a coin for a small purse and a trophy for a big one, say.
 */
let dropModelFor = null;

export function setDropModel(resolve) {
  dropModelFor = resolve;
}

/**
 * A game's say in what a projectile looks like in flight: `(attack) => Object3D | null`. An object
 * is flown instead of the attack's primitive; null leaves the primitive. The object may carry
 * `userData.tick(delta)`, called every frame it flies, and `userData.dispose()`, called when it
 * lands or runs out of range — a flipbook needs both.
 */
let projectileModelFor = null;

export function setProjectileModel(resolve) {
  projectileModelFor = resolve;
}

/** The game's object for a projectile of `attack`, or null for the primitive. */
export function createProjectileModel(attack) {
  return projectileModelFor?.(attack) ?? null;
}

/**
 * A loot drop: the model the game picks for it (`setDropModel`), else the item's own, else a
 * glowing cube in its rarity colour. `quantity` is how many the drop is worth.
 */
export async function createLootMesh(item, quantity = 1) {
  const root = new Group();
  const gltf = await loadGltf(dropModelFor?.(item, quantity) ?? item.model);
  if (gltf) {
    const body = gltf.scene.clone(true);
    applyTexture(body, loadTexture(item.texture));
    fitWithin(body, 0.6);
    root.add(body);
  } else {
    const colour = RARITY_COLOURS[item.rarity] ?? 0xffffff;
    const cube = new Mesh(
      new BoxGeometry(0.3, 0.3, 0.3),
      new MeshStandardMaterial({ color: colour, emissive: colour, emissiveIntensity: 0.6 }),
    );
    cube.position.y = 0.3;
    root.add(cube);
  }
  return root;
}

/**
 * The level's own scene model (a baked Synty level), or null when the level has none.
 *
 * Baked levels name their atlas page per material (`userData.syntyTexture`); those pages were
 * exported beside the model, and a page that was not shows the material's fallback colour.
 */
export async function createLevelModel(scene) {
  if (!scene?.model) return null;
  const gltf = await loadGltf(scene.model);
  if (!gltf) return null;
  const root = gltf.scene;
  root.traverse((node) => {
    if (!node.isMesh) return;
    node.receiveShadow = true;
    const materials = Array.isArray(node.material) ? node.material : [node.material];
    for (const material of materials) {
      const page = material?.userData?.syntyTexture;
      const fallback = material?.userData?.fallbackColor;
      if (page && ASSETS.textures[page]) {
        material.map = loadTexture(ASSETS.textures[page]);
        if (material.userData.emissiveFromMap) material.emissiveMap = material.map;
        material.color = new Color(0xffffff);
      } else if (fallback) {
        material.color = new Color(fallback);
      }
      material.needsUpdate = true;
    }
  });
  return { root, spawn: root.userData?.gamefoundry?.spawn ?? null };
}
