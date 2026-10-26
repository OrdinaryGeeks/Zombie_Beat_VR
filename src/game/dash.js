/**
 * The zombie dash: a zombie stares down a band member, then sprints through where it reckons they
 * will be and pulls up half a metre past it.
 *
 * Only the movement. The attack itself (reach, windup, cooldown, damage, the Standard Run take) is
 * the content pack's `zombie_dash` row; this names it as a dash so the template carries the body
 * along instead of swinging in place (`../dash.js`). The same numbers as Game Foundry's `zb:dash`
 * module, `game/games/zombie-beat/dashModule.ts`.
 */
export const DASH_ATTACK = 'zombie_dash';

export const ZOMBIE_DASH = {
  speed: 9,
  overshootMeters: 0.5,
  hitRadiusMeters: 0.9,
};
