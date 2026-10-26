/**
 * A dash attack: the attacker runs straight through where it expects its target to be, and pulls
 * up a little way past it.
 *
 * Content cannot say "this attack moves the attacker", so a game names its dashes by attack key
 * with `setDashAttack` (Zombie Beat's `zombie_dash`, in `src/game/dash.js`), and the attack row keeps
 * everything else: range, windup, cooldown, damage, and the take played while running
 * (`actionClipKey`). `NpcSystem` runs them. The same math as Game Foundry's `game/shell/Dash.ts`;
 * keep the two in step.
 */

/** Dash specs by attack key: `{ speed, overshootMeters, hitRadiusMeters }`. */
const DASHES = new Map();

/** Makes the attack `key` a dash. A game's add-on calls this from its `install`. */
export function setDashAttack(key, spec) {
  DASHES.set(key, spec);
}

/** The dash spec for an attack, or null for one that swings or shoots in place. */
export function dashFor(attack) {
  return (attack?.key && DASHES.get(attack.key)) || null;
}

/**
 * Where a dash goes: `aim` (where a target at `target` moving at `velocity` will be when a runner
 * from `from` reaches it, held inside `maxRange`), `end` (the spec's overshoot past that, on the same
 * line), and the `seconds` the run takes. Points are `{ x, z }`.
 */
export function planDash(from, target, velocity, spec, maxRange) {
  let aimX = target.x;
  let aimZ = target.z;
  for (let i = 0; i < 4; i++) {
    const t = Math.hypot(aimX - from.x, aimZ - from.z) / Math.max(0.1, spec.speed);
    aimX = target.x + velocity.x * t;
    aimZ = target.z + velocity.z * t;
  }
  const dx = aimX - from.x;
  const dz = aimZ - from.z;
  const length = Math.hypot(dx, dz);
  const reach = Math.min(length, Math.max(0, maxRange));
  // Already standing on it: any direction is as good as another, and the run is only the overshoot.
  const ux = length < 1e-3 ? 1 : dx / length;
  const uz = length < 1e-3 ? 0 : dz / length;
  const aim = { x: from.x + ux * reach, z: from.z + uz * reach };
  const end = { x: aim.x + ux * spec.overshootMeters, z: aim.z + uz * spec.overshootMeters };
  return { aim, end, seconds: (reach + spec.overshootMeters) / Math.max(0.1, spec.speed) };
}

/**
 * A running, smoothed estimate of how something is moving, from where it was seen each frame. A
 * jump of more than `teleport` metres in one frame is a new target rather than movement, and resets
 * it.
 */
export class VelocityTracker {
  constructor(smoothing = 0.25, teleport = 3) {
    this.smoothing = smoothing;
    this.teleport = teleport;
    this.velocity = { x: 0, z: 0 };
    this.seen = false;
    this.lastX = 0;
    this.lastZ = 0;
  }

  observe(at, dt) {
    if (dt <= 0) return;
    if (!this.seen || Math.hypot(at.x - this.lastX, at.z - this.lastZ) > this.teleport) {
      this.velocity.x = 0;
      this.velocity.z = 0;
    } else {
      this.velocity.x += ((at.x - this.lastX) / dt - this.velocity.x) * this.smoothing;
      this.velocity.z += ((at.z - this.lastZ) / dt - this.velocity.z) * this.smoothing;
    }
    this.lastX = at.x;
    this.lastZ = at.z;
    this.seen = true;
  }
}
