import { flipbook } from './flipbook.js';

/**
 * The spitter's bile in flight: a glob of glowing goo played as a flipbook, instead of a ball.
 *
 * The same sheet and the same numbers as Game Foundry's `zb:spit` module: a 4x4 grid looped at
 * 24fps, drawn in its own colours over the scene rather than added to it, about 0.9 m tall. The
 * sheet travels in `addon.json`'s `sprites`; an export without it flies the plain ball.
 */
export const SPIT_ATTACK = 'toxic_bile_spit';
const SHEET = 'SPRITESHEETS/spitglob4x4.png';
/** The game's height for a projectile's sheet: 0.45 m reach × 0.9 scale × 2.2 for the cell's margin. */
const HEIGHT = 0.89;

/** `setProjectileModel`'s answer: the flipbook for a spit, null for every other shot. */
export function spitProjectileModel(attack) {
  if (attack?.key !== SPIT_ATTACK) return null;
  return flipbook(SHEET, { columns: 4, rows: 4, fps: 24, height: HEIGHT });
}
