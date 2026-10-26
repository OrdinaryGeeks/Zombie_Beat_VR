import { Types, createComponent } from '@iwsdk/core';

/**
 * The ECS components this game adds to IWSDK's own.
 *
 * Numbers that change every frame (hit points, cooldowns, AI state) live here so systems can query
 * for them. Things that are not numbers — the content row an actor was spawned from, its animation
 * mixer — ride on `entity.object3D.userData`, which is where three.js keeps per-object data anyway.
 */

/** Anything spawned for the current level. `LevelSystem` disposes all of them on a level change. */
export const LevelPiece = createComponent('gf.LevelPiece', {});

/** A character from `GAME.entities`: an enemy, an ally, a quest giver, a critter. */
export const Actor = createComponent('gf.Actor', {
  /** The `GAME.entities` key this actor was spawned from. */
  key: { type: Types.String, default: '' },
  hp: { type: Types.Float32, default: 100 },
  maxHp: { type: Types.Float32, default: 100 },
  /** Seconds until it may attack again. */
  cooldown: { type: Types.Float32, default: 0 },
  /** `idle` | `chase` | `attack` | `return` | `flee` | `follow` | `wander` | `dead`. */
  state: { type: Types.String, default: 'idle' },
  homeX: { type: Types.Float32, default: 0 },
  homeZ: { type: Types.Float32, default: 0 },
  /** Seconds left of a stun; it neither moves nor attacks while above zero. */
  stunned: { type: Types.Float32, default: 0 },
  /** Set once the player has walked up to it (find_entity objectives, escorts). */
  found: { type: Types.Boolean, default: false },
});

/** Something lying on the ground that the player collects by walking over it. */
export const Pickup = createComponent('gf.Pickup', {
  lootKey: { type: Types.String, default: '' },
  quantity: { type: Types.Int16, default: 1 },
  /** Seconds it has existed; drives the bob and spin. */
  age: { type: Types.Float32, default: 0 },
});

/** An attack in flight. Damage is decided when it is fired and applied when it lands. */
export const Projectile = createComponent('gf.Projectile', {
  /** `player` when the player fired it, otherwise the firing actor's faction. */
  owner: { type: Types.String, default: 'player' },
  damage: { type: Types.Float32, default: 10 },
  speed: { type: Types.Float32, default: 18 },
  radius: { type: Types.Float32, default: 0.4 },
  dirX: { type: Types.Float32, default: 0 },
  dirY: { type: Types.Float32, default: 0 },
  dirZ: { type: Types.Float32, default: -1 },
  /** Seconds left before it fizzles. */
  life: { type: Types.Float32, default: 2 },
  stunPower: { type: Types.Float32, default: 0 },
  /** Playing together: the remote player who fired it, so a kill is credited to them. '' = local. */
  by: { type: Types.String, default: '' },
});

/** A short-lived visual (a swing arc, an impact flash) that fades and removes itself. */
export const Effect = createComponent('gf.Effect', {
  life: { type: Types.Float32, default: 0.3 },
  maxLife: { type: Types.Float32, default: 0.3 },
  grow: { type: Types.Float32, default: 1 },
});

export const ALL_COMPONENTS = [LevelPiece, Actor, Pickup, Projectile, Effect];
