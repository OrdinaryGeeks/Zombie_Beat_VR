import {
  Color, DirectionalLight, Fog, HemisphereLight, LocomotionEnvironment, LocomotionSystem, Mesh,
  MeshStandardMaterial, PlaneGeometry, Raycaster, Vector3, createSystem,
} from '@iwsdk/core';
import { Actor, LevelPiece } from '../components.js';
import { GAME } from '../content/game.js';
import { createCharacter, createLevelModel, createProp } from '../models.js';
import { buildNavCollision, decodeNav, navFloor, navHeightAt } from '../navCollision.js';
import { factionOf, handicapStep, raised } from '../rules.js';
import { emit, run } from '../state.js';

const DOWN = new Vector3(0, -1, 0);

/**
 * Builds a level from `GAME.levels`: its ground (a baked scene model, or a flat plane), its props
 * and its cast, and puts the player at the start.
 *
 * Everything it spawns carries `LevelPiece`, so loading the next level is "dispose every
 * LevelPiece, then build again" — nothing from one level survives into another.
 */
export class LevelSystem extends createSystem({
  pieces: { required: [LevelPiece] },
}) {
  init() {
    this.raycaster = new Raycaster();
    /** Meshes the ground height is read from. */
    this.groundMeshes = [];
    /** The baked level's navigation grid, when the scene carries one. See `navCollision.js`. */
    this.nav = null;
    this.start = new Vector3();
    this.ceiling = 50;
    this.floor = -5;
    this.loadToken = 0;
    /**
     * Which spawns a game wants kept back when a level loads, as `(entity) => boolean`, or null for
     * none. A held spawn keeps its place in `level.spawns` (its `spawnIndex`), so every machine in a
     * room still agrees which actor is which once it is let in with `release`.
     */
    this.holdBack = null;
    /** The same, for the crowd `WaveSystem` lets in over time. Kept apart so a game's own survives. */
    this.waveHold = null;
    /** Where the current level's generated spawns are shifted to. See `repeatSpot`. */
    this.offset = null;
    /** Every spawnIndex let into the current level, so none is ever let in twice. */
    this.spawned = new Set();
    /** spawnIndex → where it would have stood, for the current level. */
    this.held = new Map();

    this.hemi = new HemisphereLight(0xdbeafe, 0x3f3f46, 1.4);
    this.sun = new DirectionalLight(0xffffff, 2.2);
    this.sun.position.set(30, 60, 20);
    this.scene.add(this.hemi, this.sun);
  }

  get level() {
    return GAME.levels.find((l) => l.key === run.levelKey) ?? null;
  }

  /** The height of the ground under (x, z), or `fallback` when nothing is underneath. */
  groundHeight(x, z, fallback = 0) {
    // A baked level knows its ground: the grid the player collides with, read in O(1).
    if (this.nav) return navHeightAt(this.nav, x, z);
    if (this.groundMeshes.length === 0) return fallback;
    this.raycaster.set(new Vector3(x, this.ceiling, z), DOWN);
    this.raycaster.far = this.ceiling - this.floor + 10;
    const hit = this.raycaster.intersectObjects(this.groundMeshes, true)[0];
    return hit ? hit.point.y : fallback;
  }

  /** Tears down the current level and builds `levelKey`. Safe to call while a load is running. */
  async load(levelKey) {
    const level = GAME.levels.find((l) => l.key === levelKey);
    if (!level) throw new Error(`No level "${levelKey}" in GAME.levels.`);
    const token = ++this.loadToken;
    run.phase = 'loading';
    emit('level-loading', { level });

    for (const entity of [...this.queries.pieces.entities]) {
      // Clones share geometry and textures with the model cache; disposing those would break the
      // next level that uses the same model.
      entity.dispose({ disposeResources: false });
    }
    this.groundMeshes = [];
    this.held.clear();
    this.spawned.clear();

    this.applySky(level);

    // The ground: the level's own scene when it has one. A baked Synty scene carries its navigation
    // grid, and that — not the drawn model — is what the player walks on: IWSDK's locomotor ignores
    // instance matrices, and every ground tile in a baked level is instanced, so colliding with the
    // model drops the player straight through the floor. Anything else gets the model itself, and
    // a flat plane under it so a model with holes never drops the player into the void.
    const model = await createLevelModel(level.scene);
    if (token !== this.loadToken) return;
    this.nav = model ? await decodeNav(model.root.userData?.gamefoundry?.nav).catch((err) => {
      console.warn('[level] The scene\'s navigation grid could not be read; colliding with the model.', err);
      return null;
    }) : null;
    if (token !== this.loadToken) return;
    let baseY = 0;
    if (model) {
      const piece = this.world.createTransformEntity(model.root).addComponent(LevelPiece);
      if (!this.nav) piece.addComponent(LocomotionEnvironment, { type: 'static' });
      this.groundMeshes.push(model.root);
      model.root.updateMatrixWorld(true);
    }
    if (this.nav) {
      const collision = buildNavCollision(this.nav);
      this.world.createTransformEntity(collision.group)
        .addComponent(LevelPiece)
        .addComponent(LocomotionEnvironment, { type: 'static' });
      const floor = navFloor(this.nav);
      this.ceiling = floor + 200;
      this.floor = floor - 5;
      console.log(`[level] ${level.key}: walking on the baked navigation, ${collision.triangles} collision triangles.`);
    } else {
      const bounds = model ? this.boundsOf(model.root) : null;
      this.ceiling = bounds ? bounds.max.y + 50 : 50;
      this.floor = bounds ? bounds.min.y - 5 : -5;
      if (bounds) baseY = bounds.min.y - 0.05;

      const size = Math.max(60, (level.ground.radiusMeters ?? 60) * 2.2);
      const plane = new Mesh(
        new PlaneGeometry(size, size),
        new MeshStandardMaterial({ color: new Color(level.ground.color), roughness: 1 }),
      );
      plane.rotation.x = -Math.PI / 2;
      plane.position.y = baseY;
      plane.receiveShadow = true;
      this.world.createTransformEntity(plane).addComponent(LevelPiece).addComponent(LocomotionEnvironment, { type: 'static' });
      this.groundMeshes.push(plane);
    }

    // The start: where the game says this level is played on its scene, else the scene's own
    // walkable spawn point, else the level's authored start.
    const spawn = model?.spawn ?? null;
    const anchor = model && level.anchor ? level.anchor : spawn;
    const sx = anchor?.x ?? level.playerStart.x;
    const sz = anchor?.z ?? level.playerStart.z;
    const sy = anchor && anchor === spawn ? spawn.y : undefined;
    this.start.set(sx, sy ?? this.groundHeight(sx, sz, baseY), sz);
    this.placePlayer();

    // Props and cast, models loaded in parallel. A layout authored on the scene is already in the
    // scene's coordinates; generated positions are around the start, wherever the scene put it.
    const relative = level.coordinates === 'start' && anchor;
    const offsetX = relative ? anchor.x - level.playerStart.x : 0;
    const offsetZ = relative ? anchor.z - level.playerStart.z : 0;
    this.offset = { x: offsetX, z: offsetZ };
    const now = [];
    level.spawns.forEach((placement, index) => {
      const entity = GAME.entities[placement.entity];
      if (entity && (this.holdBack?.(entity) || this.waveHold?.(entity))) this.held.set(index, { placement, offsetX, offsetZ });
      else now.push(this.spawnActor(placement, offsetX, offsetZ, token, index));
    });
    await Promise.all([
      ...level.props.map((placement) => this.spawnProp(placement, offsetX, offsetZ, token)),
      ...now,
    ]);
    if (token !== this.loadToken) return;

    run.startLevel(level.key);
    emit('level-start', { level });
  }

  /**
   * Lets a held spawn into the level, where it would have stood had it spawned with the rest, and
   * emits `actor-arrived`. False when that index is not held (already in, or not on this level).
   */
  async release(index) {
    // Already in (or already dead and gone): a guest re-indexing after an actor sank out of sight
    // still sees the host name it for a moment, and must not raise it again.
    if (this.spawned.has(index)) return false;
    const spot = this.held.get(index) ?? this.repeatSpot(index);
    if (!spot) return false;
    this.held.delete(index);
    const token = this.loadToken;
    await this.spawnActor(spot.placement, spot.offsetX, spot.offsetZ, token, index);
    if (token !== this.loadToken) return false;
    emit('actor-arrived', { entity: GAME.entities[spot.placement.entity], index });
    return true;
  }

  /**
   * A spot for an index past the end of `level.spawns`: the same placement again, `index % length`.
   * How waves send a level's crowd round a second time (`WaveSystem`) with an index no actor has had,
   * which every machine in a room resolves to the same placement without being told it.
   */
  repeatSpot(index) {
    const spawns = this.level?.spawns ?? [];
    if (!this.offset || index < spawns.length || spawns.length === 0) return null;
    return { placement: spawns[index % spawns.length], offsetX: this.offset.x, offsetZ: this.offset.z };
  }

  /** Puts the player back at the level's start (a new level, or a respawn). */
  placePlayer() {
    const locomotion = this.world.getSystem(LocomotionSystem);
    if (locomotion) locomotion.setPlayerPosition(this.start.clone());
    else this.player.position.copy(this.start);
  }

  applySky(level) {
    const sky = new Color(level.sky.color);
    this.scene.background = sky;
    this.scene.fog = new Fog(sky, level.sky.fogNear, level.sky.fogFar);
  }

  boundsOf(object) {
    const box = { min: new Vector3(Infinity, Infinity, Infinity), max: new Vector3(-Infinity, -Infinity, -Infinity) };
    object.traverse((node) => {
      if (!node.isMesh || !node.geometry) return;
      node.geometry.computeBoundingBox();
      const b = node.geometry.boundingBox.clone().applyMatrix4(node.matrixWorld);
      box.min.min(b.min);
      box.max.max(b.max);
    });
    return Number.isFinite(box.min.y) ? box : null;
  }

  async spawnProp(placement, offsetX, offsetZ, token) {
    const prop = GAME.props[placement.prop];
    if (!prop) return;
    const root = await createProp(prop);
    if (token !== this.loadToken) return;
    const x = placement.x + offsetX;
    const z = placement.z + offsetZ;
    root.position.set(x, this.groundHeight(x, z, this.start.y), z);
    root.rotation.y = placement.yaw ?? 0;
    this.world.createTransformEntity(root).addComponent(LevelPiece);
  }

  async spawnActor(placement, offsetX, offsetZ, token, index = 0) {
    // Before the first await, so two releases of one index in the same frame cannot both spawn it.
    this.spawned.add(index);
    const row = GAME.entities[placement.entity];
    if (!row) {
      console.warn(`[level] Spawn names "${placement.entity}", which is not in GAME.entities.`);
      return;
    }
    // What this board fields: raised by the handicap the level was started at. Every system reads
    // the actor's numbers from `userData.entity`, so its kill pays the raised rewards too.
    const entity = raised(row, handicapStep(run.handicap));
    const giver = Object.values(GAME.quests).some((q) => q.giver === entity.key);
    const root = await createCharacter(entity, { colourKey: giver ? 'giver' : factionOf(entity.role) });
    if (token !== this.loadToken) return;
    const x = placement.x + offsetX;
    const z = placement.z + offsetZ;
    root.position.set(x, this.groundHeight(x, z, this.start.y), z);
    root.rotation.y = placement.yaw ?? 0;
    root.userData.entity = entity;
    // Its place in `level.spawns`: the same on every machine, so players in one room can agree
    // which zombie is which however the models happened to finish loading.
    root.userData.spawnIndex = index;
    this.world.createTransformEntity(root)
      .addComponent(LevelPiece)
      .addComponent(Actor, { key: entity.key, hp: entity.hp, maxHp: entity.hp, homeX: x, homeZ: z });
  }
}
