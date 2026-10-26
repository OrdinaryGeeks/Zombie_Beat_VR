import { InputComponent, Vector3, createSystem } from '@iwsdk/core';
import { emit, on, run } from '../state.js';
import { CombatSystem } from './CombatSystem.js';
import { LevelSystem } from './LevelSystem.js';

/**
 * The player: where they are, what they press, and what happens when they die.
 *
 * Walking is IWSDK's locomotion (left stick, or WASD on a desktop); this system adds the rest.
 *
 * | | Headset | Desktop |
 * |---|---|---|
 * | Attack | right trigger, or pinch | left click (after the first click locks the mouse), or F |
 * | Look | your head | mouse |
 * | Turn | right stick | mouse |
 * | Jump | A | Space |
 */
export class PlayerSystem extends createSystem({}) {
  init() {
    this.yaw = 0;
    this.pitch = 0;
    this.pinches = 0;
    this.clicks = 0;
    this.feet = new Vector3();
    this.head = new Vector3();
    this.aimOrigin = new Vector3();
    this.aimDirection = new Vector3();

    const canvas = this.renderer.domElement;
    canvas.addEventListener('click', () => {
      if (run.phase !== 'playing' || this.world.session) return;
      if (document.pointerLockElement !== canvas) canvas.requestPointerLock?.();
      else this.clicks += 1;
    });
    document.addEventListener('mousemove', (event) => {
      if (document.pointerLockElement !== canvas || this.world.session) return;
      this.yaw -= event.movementX * 0.0025;
      this.pitch = Math.max(-1.3, Math.min(1.3, this.pitch - event.movementY * 0.0025));
    });

    // Hands have no trigger; a pinch arrives as a WebXR `selectstart` instead.
    this.renderer.xr.addEventListener('sessionstart', () => {
      this.renderer.xr.getSession()?.addEventListener('selectstart', (event) => {
        if (event.inputSource.hand) this.pinches += 1;
      });
    });

    this.cleanupFuncs.push(on('level-start', () => {
      this.yaw = 0;
      this.pitch = 0;
    }));
  }

  /** Where the player stands: under their head, at the rig's floor height. */
  getFeet(out = this.feet) {
    this.camera.getWorldPosition(this.head);
    return out.set(this.head.x, this.player.position.y, this.head.z);
  }

  /** Where attacks come from and point: the right controller in a headset, the eyes otherwise. */
  getAim() {
    const ray = this.world.playerSpaceEntities?.raySpaces?.right?.object3D;
    const controllerTracked = this.world.session && this.input.gamepads.right;
    const source = controllerTracked && ray ? ray : this.camera;
    source.getWorldPosition(this.aimOrigin);
    source.getWorldDirection(this.aimDirection);
    // A camera's world direction is already where it looks (-Z); a plain Object3D's is its +Z,
    // and ray spaces point down -Z, so only those need turning round.
    if (!source.isCamera) this.aimDirection.negate();
    return { origin: this.aimOrigin, direction: this.aimDirection };
  }

  update() {
    if (!this.world.session) {
      this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
    }
    if (run.phase !== 'playing') {
      this.pinches = 0;
      this.clicks = 0;
      return;
    }

    const right = this.input.gamepads.right;
    const keyboard = this.input.keyboard;
    const attack = Boolean(right?.getButtonDown(InputComponent.Trigger))
      || this.pinches > 0 || this.clicks > 0 || keyboard.getKeyDown('KeyF');
    this.pinches = 0;
    this.clicks = 0;
    if (attack) this.world.getSystem(CombatSystem)?.playerAttack();

    // A level built on a scene can have edges to fall off.
    const level = this.world.getSystem(LevelSystem);
    if (level && this.player.position.y < level.floor - 20) level.placePlayer();

    if (run.health <= 0) this.die();
  }

  die() {
    run.deaths += 1;
    run.health = run.maxHealth;
    emit('message', { text: 'You were defeated.', tone: 'bad' });
    emit('player-death', {});
    this.world.getSystem(LevelSystem)?.placePlayer();
  }
}
