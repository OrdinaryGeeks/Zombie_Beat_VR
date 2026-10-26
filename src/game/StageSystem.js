import {
  AdditiveBlending, BoxGeometry, Color, ConeGeometry, CylinderGeometry, DoubleSide, Group,
  InstancedMesh, LocomotionSystem, Mesh, MeshBasicMaterial, MeshStandardMaterial, Object3D,
  PointLight, RingGeometry, Vector3, createSystem,
} from '@iwsdk/core';
import { Actor, LevelPiece } from '../components.js';
import { GAME } from '../content/game.js';
import { factionOf } from '../rules.js';
import { emit, on, run } from '../state.js';
import { LevelSystem } from '../systems/LevelSystem.js';
import { PlayerSystem } from '../systems/PlayerSystem.js';
import { band } from './band.js';
import { seatSpot } from './ledger.js';
import { BREACH_RADIUS_M, inCentre, isHuntBoard, roleByKey, scoreBreach } from './rules.js';

const FLOOR_RADIUS_M = 7.5;
const feet = new Vector3();
const moved = new Vector3();

/** How far from the centre still counts as on the stage, for the Home button's look. */
export const STAGE_RADIUS_M = FLOOR_RADIUS_M;

/**
 * The stage at the centre of every level, and the line the zombies are trying to cross.
 *
 * The centre is the level's start, where the band begins. Every zombie in this game `hunt`s, and
 * `index.js` stretches the hunt range over the whole level, so the horde walks in on the band from
 * wherever it spawned.
 *
 * The band may leave the stage; `goHome` puts a player back in their seat (T, the Home button, or a
 * thumbstick click in a headset). Zombies go for whichever player is nearest, so whoever wanders
 * off pulls part of the horde with them.
 *
 * A zombie inside the red centre ring has made it: the crowd's hype drops and the lights flash red.
 *
 * A Boss Hunt board builds none of this (`band.hunt`): the start is only where the band begins.
 */
export class StageSystem extends createSystem({
  actors: { required: [Actor] },
}) {
  init() {
    this.counted = new WeakSet();
    this.cleanupFuncs.push(on('level-start', () => this.build()));
  }

  build() {
    const level = this.world.getSystem(LevelSystem);
    band.resetLevel(level.start);
    this.counted = new WeakSet();
    // A Boss Hunt has no stage: the band starts here and goes looking (`BossSystem`).
    band.hunt = isHuntBoard(level.level, GAME.entities);
    band.quarry = null;
    this.stage = null;
    if (band.hunt) return;

    const group = new Group();
    group.name = 'zombie-beat:stage';
    group.position.copy(band.centre);

    // The dance floor: tiles out to the dancer's reach, lit in rings on the beat.
    this.cells = [];
    for (let ix = -8; ix <= 8; ix++) {
      for (let iz = -8; iz <= 8; iz++) {
        const x = ix + 0.5;
        const z = iz + 0.5;
        const r = Math.hypot(x, z);
        if (r <= FLOOR_RADIUS_M) this.cells.push({ x, z, ring: Math.floor(r / 1.5) });
      }
    }
    this.floor = new InstancedMesh(
      new BoxGeometry(0.94, 0.04, 0.94),
      new MeshStandardMaterial({ color: 0xffffff, roughness: 0.35, metalness: 0.1 }),
      this.cells.length,
    );
    const placer = new Object3D();
    this.cells.forEach((cell, i) => {
      placer.position.set(cell.x, 0.02, cell.z);
      placer.updateMatrix();
      this.floor.setMatrixAt(i, placer.matrix);
      this.floor.setColorAt(i, new Color(0x1a1530));
    });
    group.add(this.floor);

    this.edge = new Mesh(new RingGeometry(3.9, 4.1, 64),
      new MeshBasicMaterial({ color: 0xff3d7f, side: DoubleSide, transparent: true, opacity: 0.8 }));
    this.edge.rotation.x = -Math.PI / 2;
    this.edge.position.y = 0.05;
    group.add(this.edge);

    this.centreRing = new Mesh(new RingGeometry(BREACH_RADIUS_M - 0.12, BREACH_RADIUS_M, 48),
      new MeshBasicMaterial({ color: 0xff2020, side: DoubleSide, transparent: true, opacity: 0.5 }));
    this.centreRing.rotation.x = -Math.PI / 2;
    this.centreRing.position.y = 0.055;
    group.add(this.centreRing);

    // Speaker stacks on the diagonals, just beyond the floor.
    const cabinet = new MeshStandardMaterial({ color: 0x111114, roughness: 0.8 });
    const cone = new MeshStandardMaterial({ color: 0x2a2a30, roughness: 0.4, metalness: 0.5 });
    for (let i = 0; i < 4; i++) {
      const angle = Math.PI / 4 + (i * Math.PI) / 2;
      const stack = new Group();
      for (let tier = 0; tier < 2; tier++) {
        const box = new Mesh(new BoxGeometry(1.1, 1.1, 0.8), cabinet);
        box.position.y = 0.55 + tier * 1.12;
        const woofer = new Mesh(new CylinderGeometry(0.38, 0.38, 0.05, 24), cone);
        woofer.rotation.x = Math.PI / 2;
        woofer.position.set(0, 0.55 + tier * 1.12, 0.41);
        stack.add(box, woofer);
      }
      stack.position.set(Math.cos(angle) * 8.5, 0, Math.sin(angle) * 8.5);
      stack.lookAt(band.centre.x, stack.position.y, band.centre.z);
      group.add(stack);
    }

    // Light posts with beams that sweep the floor.
    this.beams = [];
    const post = new MeshStandardMaterial({ color: 0x333338, metalness: 0.7, roughness: 0.3 });
    for (let i = 0; i < 4; i++) {
      const angle = (i * Math.PI) / 2;
      const x = Math.cos(angle) * 9.5;
      const z = Math.sin(angle) * 9.5;
      const pole = new Mesh(new CylinderGeometry(0.08, 0.1, 5.5, 8), post);
      pole.position.set(x, 2.75, z);
      group.add(pole);
      const pivot = new Group();
      pivot.position.set(x, 5.5, z);
      const beam = new Mesh(new ConeGeometry(1.4, 7, 24, 1, true), new MeshBasicMaterial({
        color: 0xff3d7f, transparent: true, opacity: 0.12, blending: AdditiveBlending, depthWrite: false, side: DoubleSide,
      }));
      beam.position.y = -3.5;
      pivot.add(beam);
      // Tip at the post, mouth towards the middle of the stage.
      pivot.lookAt(band.centre.x, band.centre.y, band.centre.z);
      pivot.rotateX(-Math.PI / 2);
      pivot.userData.base = pivot.quaternion.clone();
      group.add(pivot);
      this.beams.push(beam);
    }

    this.wash = new PointLight(0xff3d7f, 6, 18, 1.6);
    this.wash.position.set(0, 4.5, 0);
    group.add(this.wash);

    this.world.createTransformEntity(group).addComponent(LevelPiece);
    this.stage = group;
  }

  update() {
    if (run.phase !== 'playing' || !band.staged || !this.stage) return;
    this.watchCentre();
    this.animate();
  }

  /**
   * Back to this player's seat on the stage. Walking is IWSDK's locomotion, so this is its own
   * teleport rather than a write to the rig that locomotion would undo next frame. Measured at the
   * feet (under the head), so a player standing off-centre in a room-scale headset lands on the seat.
   */
  goHome() {
    // A hunt has no seat, and a free trip back to the start would be an escape hatch.
    if (!band.staged || band.hunt) return;
    const role = roleByKey(band.role);
    // Each seat in the room has its own spot round the role's, so nobody stands inside anybody.
    const spot = seatSpot(band.seat);
    this.world.getSystem(PlayerSystem).getFeet(feet);
    moved.copy(this.player.position);
    moved.x += band.centre.x + role.seat.x + spot.x - feet.x;
    moved.z += band.centre.z + role.seat.z + spot.z - feet.z;
    moved.y = band.centre.y;
    const locomotion = this.world.getSystem(LocomotionSystem);
    if (locomotion) locomotion.setPlayerPosition(moved);
    else this.player.position.copy(moved);
  }

  /** Whether this player is on the stage. */
  onStage() {
    if (band.hunt) return true;
    this.world.getSystem(PlayerSystem).getFeet(feet);
    return Math.hypot(feet.x - band.centre.x, feet.z - band.centre.z) <= STAGE_RADIUS_M;
  }

  watchCentre() {
    for (const entity of this.queries.actors.entities) {
      const object = entity.object3D;
      if (!object || this.counted.has(object)) continue;
      if (entity.getValue(Actor, 'state') === 'dead') continue;
      const row = object.userData.entity;
      if (!row || factionOf(row.role) !== 'hostile') continue;
      if (!inCentre(object.position.x, object.position.z, band.centre.x, band.centre.z, BREACH_RADIUS_M)) continue;
      this.counted.add(object);
      band.breaches += 1;
      band.breachAt = band.beatTime;
      band.performance = scoreBreach(band.performance);
      emit('message', { text: `${row.name || 'A zombie'} made it to the centre!`, tone: 'bad' });
      emit('band-breach', { key: row.key });
    }
  }

  animate() {
    const role = roleByKey(band.role);
    const { beat, phase } = band.clock.at(band.beatTime);
    const pulse = Math.pow(1 - phase, 3);
    const hype = band.performance.hype;
    const breaching = band.beatTime - band.breachAt < 0.6;
    const accent = new Color(breaching ? 0xff1a1a : role.color);
    // An ultimate washes the stage white for a moment.
    const sinceUlt = band.beatTime - band.ultAt;
    if (!breaching && sinceUlt < 0.8) accent.lerp(new Color(0xffffff), 1 - sinceUlt / 0.8);
    const off = new Color(0x1a1530);
    const tile = new Color();

    const lit = beat % 4;
    this.cells.forEach((cell, i) => {
      const on = cell.ring % 4 === lit || (hype > 0.75 && (cell.ring + beat) % 2 === 0);
      tile.copy(off).lerp(accent, on ? 0.35 + 0.65 * pulse : 0.05 + 0.1 * hype);
      this.floor.setColorAt(i, tile);
    });
    if (this.floor.instanceColor) this.floor.instanceColor.needsUpdate = true;

    this.edge.material.color.copy(accent);
    this.centreRing.material.opacity = breaching ? 0.95 : 0.35 + 0.25 * pulse;
    this.wash.color.copy(accent);
    this.wash.intensity = 3 + 9 * pulse * (0.4 + hype);

    const sway = Math.sin((band.beatTime / band.clock.secondsPerBeat) * Math.PI * 0.5);
    this.beams.forEach((beam, i) => {
      beam.material.color.copy(accent);
      beam.material.opacity = 0.05 + 0.18 * pulse * (0.3 + hype);
      const pivot = beam.parent;
      pivot.quaternion.copy(pivot.userData.base);
      pivot.rotateZ(sway * 0.35 * (i % 2 === 0 ? 1 : -1));
    });
  }
}
