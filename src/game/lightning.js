import { flipbook } from './flipbook.js';

/**
 * The singer's shot in flight: a crackling bolt played as a flipbook, instead of a ball.
 *
 * The shot is `BandSystem.deliver`'s for the `beam` wave, which tags its attack with
 * {@link SINGER_BOLT}; only the look changes, never its range, speed or damage. All 16 cells of
 * the 4x4 sheet play, the near-empty last row included, at 24fps — 0.67 s, about the shot's
 * 0.69 s flight (18 m at 26 m/s), so a bolt blooms and fades once on its way. Additive, because it
 * is light, and tinted the singer's colour (grey on a miss). The same sheet and numbers as Game
 * Foundry's `zb:beat` (`game/games/zombie-beat/beatModule.ts`, `SINGER_BOLT_SHEET`).
 */
export const SINGER_BOLT = 'zb_singer_bolt';
const SHEET = 'SPRITESHEETS/lightningsprite4x4.png';
/** About 1.2 m tall: the burst fills roughly two thirds of each cell. */
export const SINGER_BOLT_HEIGHT = 1.2;
export const SINGER_BOLT_FPS = 24;

/** `setProjectileModel`'s answer: the bolt for the singer's shot, null for every other shot. */
export function singerProjectileModel(attack) {
  if (attack?.key !== SINGER_BOLT) return null;
  return flipbook(SHEET, {
    columns: 4, rows: 4, frames: 16, fps: SINGER_BOLT_FPS, height: SINGER_BOLT_HEIGHT,
    additive: true, color: attack.primitiveColorHex ?? null,
  });
}
