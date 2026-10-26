import {
  AnimationMixer, AssetManager, Box3, CanvasTexture, Group, LoopRepeat, Sprite, SpriteMaterial,
  SRGBColorSpace, Vector3,
} from '@iwsdk/core';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { attachCues } from '../cues.js';
import { applyTexture, assetUrl, loadTexture } from '../models.js';
import { createInstrument } from './band.js';
import { CAST } from './cast.js';
import { instrumentFor, roleByKey } from './rules.js';

/**
 * A band member's body drawn by this game rather than by the player behind it: another player in
 * the room (`NetSystem`), or a CPU bandmate (`BotSystem`).
 *
 * The body is the cast character for the avatar's seat (`cast.js`), so everyone in a band looks
 * different. Their instrument is in their right hand; standing still they play their role
 * (`play_<role>`, baked in by Game Foundry's exporter), moving they walk, and knocked down they lie
 * where they fell until they get up. Firing an ultimate they perform its take (`ult_<role>`, the
 * dancer's flair) while it lasts, as the hero does in Game Foundry (`ultimateTakeSeconds` in
 * `game/games/zombie-beat/ultimate.ts`).
 */

export const AVATAR_HEIGHT = 1.75;

/** A body for `id`, added to `scene`. Positions ease toward `target` / `targetRy` in `animateAvatar`. */
export function createAvatar(scene, { id, name, seat }) {
  const group = new Group();
  group.name = `band:${id}`;
  scene.add(group);
  const avatar = {
    id, name, seat, role: null,
    group, body: null, mixer: null, actions: {}, playing: null, prop: null, propRole: null,
    /** The ultimate take being performed, and the seconds it has left (see `performUltimate`). */
    ultTake: null, ultLeft: 0,
    target: new Vector3(), targetRy: 0, moving: false, placed: false, down: false, disposed: false,
    label: nameplate(name),
  };
  avatar.label.position.y = AVATAR_HEIGHT + 0.35;
  group.add(avatar.label);
  void dressBody(avatar);
  return avatar;
}

/** Puts the avatar straight onto a spot, rather than easing there from wherever it was. */
export function placeAvatar(avatar, position, ry = 0) {
  avatar.target.copy(position);
  avatar.targetRy = ry;
  avatar.group.position.copy(position);
  avatar.group.rotation.y = ry;
  avatar.placed = true;
}

export function setAvatarRole(avatar, role) {
  if (avatar.role === role) return;
  avatar.role = role;
  void dressInstrument(avatar);
}

/** Performs the role's ultimate take for `seconds`, if the cast was baked with one; otherwise nothing changes. */
export function performUltimate(avatar, role, seconds) {
  const name = `ult_${role}`;
  if (!avatar.actions[name] || seconds <= 0) return;
  avatar.ultTake = name;
  avatar.ultLeft = seconds;
  // From the top, even if the last one is still going.
  if (avatar.playing === avatar.actions[name]) avatar.playing.reset();
}

export function animateAvatar(avatar, delta, visible) {
  const k = Math.min(1, delta * 12);
  avatar.group.position.lerp(avatar.target, k);
  let diff = avatar.targetRy - avatar.group.rotation.y;
  diff = Math.atan2(Math.sin(diff), Math.cos(diff));
  avatar.group.rotation.y += diff * k;
  avatar.group.visible = visible && avatar.placed;
  // Knocked down: lying on their back until they get up.
  avatar.group.rotation.x += ((avatar.down ? -Math.PI / 2 : 0) - avatar.group.rotation.x) * Math.min(1, delta * 6);
  avatar.label.visible = !avatar.down;
  if (avatar.ultLeft > 0) {
    avatar.ultLeft -= delta;
    if (avatar.ultLeft <= 0 || avatar.down) avatar.ultTake = null;
  }
  if (!avatar.mixer || avatar.down) return;

  const want = avatar.ultTake ?? (avatar.moving ? 'walk' : avatar.role ? `play_${avatar.role}` : 'walk');
  const next = avatar.actions[want] ?? avatar.actions.walk ?? Object.values(avatar.actions)[0];
  if (next && next !== avatar.playing) {
    next.reset().play();
    if (avatar.playing) avatar.playing.crossFadeTo(next, 0.25, false);
    avatar.playing = next;
  }
  avatar.mixer.update(delta);
}

export function disposeAvatar(avatar) {
  avatar.disposed = true;
  avatar.group.removeFromParent();
  avatar.mixer?.stopAllAction();
}

/** The seat's character from the cast, with its baked clips. A cast that failed to export draws a nameplate alone. */
async function dressBody(avatar) {
  const member = CAST.length ? CAST[avatar.seat % CAST.length] : null;
  if (!member) return;
  try {
    const gltf = await AssetManager.loadGLTF(assetUrl(member.model), member.model);
    if (avatar.disposed) return;
    const body = cloneSkinned(gltf.scene);
    body.traverse((node) => {
      if (node.isMesh) {
        node.castShadow = true;
        node.frustumCulled = false;
      }
    });
    applyTexture(body, loadTexture(member.texture));
    const box = new Box3().setFromObject(body);
    const height = box.max.y - box.min.y;
    if (height > 0.01) {
      body.scale.multiplyScalar(AVATAR_HEIGHT / height);
      body.position.y -= box.min.y * (AVATAR_HEIGHT / height);
    }
    avatar.group.add(body);
    avatar.body = body;
    avatar.mixer = new AnimationMixer(body);
    for (const clip of gltf.animations ?? []) {
      const action = avatar.mixer.clipAction(clip);
      action.setLoop(LoopRepeat, Infinity);
      avatar.actions[clip.name] = action;
    }
    // The effects cued on a role's take go off as they play it (`../cues.js`).
    attachCues(body, member.model, gltf.animations, avatar.mixer);
    avatar.propRole = undefined;
    void dressInstrument(avatar);
  } catch (err) {
    console.warn(`[band] Could not load ${member.model} for ${avatar.name}; they are a nameplate for now.`, err);
  }
}

/** The guitar or the mic in their right hand; nothing for the drummer (the kit is on stage) or the dancer. */
async function dressInstrument(avatar) {
  const role = avatar.role ? roleByKey(avatar.role) : null;
  if (avatar.propRole === avatar.role && avatar.prop) return;
  avatar.prop?.removeFromParent();
  avatar.prop = null;
  avatar.propRole = avatar.role;
  const hand = avatar.body?.getObjectByName('Hand_R');
  if (!role || role.mount !== 'hand' || !hand) return;
  const wanted = avatar.role;
  // What they wear is not relayed, so a bandmate plays their role's own instrument.
  const prop = await createInstrument(instrumentFor(role.key, null), { held: true });
  if (avatar.role !== wanted || avatar.disposed) return;
  // Undoing the hand bone's own scale (these rigs are in centimetres).
  const scale = hand.getWorldScale(new Vector3()).x || 1;
  prop.scale.setScalar(1 / scale);
  hand.add(prop);
  avatar.prop = prop;
}

function nameplate(name) {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 64;
  const g = canvas.getContext('2d');
  g.fillStyle = 'rgba(12,8,24,0.7)';
  g.beginPath();
  g.roundRect(4, 8, 248, 48, 22);
  g.fill();
  g.fillStyle = '#f5f0ff';
  g.font = 'bold 30px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(String(name).slice(0, 16), 128, 33);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  const sprite = new Sprite(new SpriteMaterial({ map: texture, transparent: true, depthWrite: false }));
  sprite.scale.set(1, 0.25, 1);
  return sprite;
}
