import {
  BufferGeometry, CanvasTexture, Float32BufferAttribute, Group, Line, LineBasicMaterial, Mesh,
  MeshBasicMaterial, PlaneGeometry, Raycaster, SRGBColorSpace, Vector3,
} from '@iwsdk/core';

/** How far off the gaze the panel sits, and how far the gaze may drift before it follows. Radians. */
const SIDE = -0.55;
const FOLLOW_AFTER = 1.0;
const DISTANCE = 0.9;
const BELOW_EYES = 0.45;
const WIDTH = 0.42;
const STUB = 0.25;
const REACH = 6;

const HANDS = ['left', 'right'];

/**
 * The ultimate as a button in the headset: a panel floating low and to the left of where the
 * player looks. Point either controller (or hand) at it and pull the trigger (or pinch).
 *
 * It follows the gaze lazily: it stays put while the player turns their head towards it to aim,
 * and only swings round once they have looked well away. Each hand gets a short laser, which
 * reaches all the way to the panel while it is pointing at it.
 */
export class UltPanel {
  constructor(world, scene, camera) {
    this.world = world;
    this.camera = camera;
    this.canvas = document.createElement('canvas');
    this.canvas.width = 512;
    this.canvas.height = 160;
    this.texture = new CanvasTexture(this.canvas);
    this.texture.colorSpace = SRGBColorSpace;
    this.panel = new Mesh(
      new PlaneGeometry(WIDTH, WIDTH * (160 / 512)),
      new MeshBasicMaterial({ map: this.texture, transparent: true, depthTest: false }),
    );
    this.panel.renderOrder = 1001;
    this.group = new Group();
    this.group.add(this.panel);
    this.group.visible = false;
    scene.add(this.group);

    this.rays = new Map();
    this.hovering = new Set();
    this.anchorYaw = null;
    this.drawn = '';
    this.raycaster = new Raycaster();
    this.origin = new Vector3();
    this.direction = new Vector3();
    this.head = new Vector3();
    this.gaze = new Vector3();
  }

  /** Whether `hand` ('left' or 'right'), or with no argument either hand, points at the panel. */
  aimed(hand) {
    if (!this.group.visible) return false;
    return hand ? this.hovering.has(hand) : this.hovering.size > 0;
  }

  update(delta, visible, look) {
    this.group.visible = visible;
    if (!visible) {
      this.anchorYaw = null;
      this.hovering.clear();
      for (const ray of this.rays.values()) ray.visible = false;
      return;
    }

    this.place(delta);
    this.group.updateMatrixWorld(true);
    this.hovering.clear();
    for (const hand of HANDS) {
      const space = this.world.playerSpaceEntities?.raySpaces?.[hand]?.object3D;
      if (!space) continue;
      space.updateMatrixWorld(true);
      space.getWorldPosition(this.origin);
      // A ray space points down its -Z; a plain Object3D's world direction is its +Z.
      space.getWorldDirection(this.direction).negate();
      this.raycaster.set(this.origin, this.direction);
      this.raycaster.far = REACH;
      const hit = this.raycaster.intersectObject(this.panel, false)[0];
      if (hit) this.hovering.add(hand);
      this.drawRay(hand, space, hit ? hit.distance : STUB, Boolean(hit), look.color);
    }
    this.draw(look, this.hovering.size > 0);
  }

  dispose() {
    this.group.removeFromParent();
    this.panel.geometry.dispose();
    this.panel.material.dispose();
    this.texture.dispose();
    for (const ray of this.rays.values()) {
      ray.removeFromParent();
      ray.geometry.dispose();
      ray.material.dispose();
    }
    this.rays.clear();
  }

  place(delta) {
    this.camera.getWorldPosition(this.head);
    this.camera.getWorldDirection(this.gaze);
    const gazeYaw = Math.atan2(this.gaze.x, this.gaze.z);
    if (this.anchorYaw === null) this.anchorYaw = gazeYaw;
    const off = Math.atan2(Math.sin(gazeYaw - this.anchorYaw), Math.cos(gazeYaw - this.anchorYaw));
    if (Math.abs(off) > FOLLOW_AFTER) this.anchorYaw += off * Math.min(1, delta * 3);
    const yaw = this.anchorYaw + SIDE;
    this.group.position.set(
      this.head.x + Math.sin(yaw) * DISTANCE,
      this.head.y - BELOW_EYES,
      this.head.z + Math.cos(yaw) * DISTANCE,
    );
    this.group.lookAt(this.head);
  }

  /** A laser on the hand's ray space: its own -Z, `length` metres long. */
  drawRay(hand, space, length, hit, color) {
    let ray = this.rays.get(hand);
    if (!ray) {
      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new Float32BufferAttribute([0, 0, 0, 0, 0, -1], 3));
      ray = new Line(geometry, new LineBasicMaterial({ transparent: true, depthTest: false }));
      ray.renderOrder = 1002;
      this.rays.set(hand, ray);
    }
    if (ray.parent !== space) space.add(ray);
    ray.visible = true;
    ray.scale.set(1, 1, length);
    ray.material.color.set(hit ? '#ffffff' : color);
    ray.material.opacity = hit ? 1 : 0.45;
  }

  draw(look, hovered) {
    const key = `${look.label}|${Math.floor(look.fill * 20)}|${look.ready}|${look.color}|${hovered}`;
    if (key === this.drawn) return;
    this.drawn = key;
    const g = this.canvas.getContext('2d');
    const { width, height } = this.canvas;
    g.clearRect(0, 0, width, height);
    g.fillStyle = look.ready ? look.color : 'rgba(12,8,24,0.82)';
    g.beginPath();
    g.roundRect(6, 6, width - 12, height - 12, 40);
    g.fill();
    if (!look.ready) {
      g.save();
      g.clip();
      g.fillStyle = `${look.color}66`;
      g.fillRect(6, 6, (width - 12) * look.fill, height - 12);
      g.restore();
    }
    g.lineWidth = hovered ? 12 : 6;
    g.strokeStyle = hovered ? '#ffffff' : look.color;
    g.stroke();
    g.fillStyle = look.ready ? '#0c0818' : '#f5f0ff';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = 'bold 44px system-ui, sans-serif';
    g.fillText(look.ready ? look.label.toUpperCase() : `ULTIMATE ${Math.floor(look.fill * 100)}%`, width / 2, height / 2 - 14);
    g.font = '600 24px system-ui, sans-serif';
    g.fillText(look.ready ? 'point here + trigger' : 'play on the beat to charge', width / 2, height / 2 + 34);
    this.texture.needsUpdate = true;
  }
}
