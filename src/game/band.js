import { Box3, Vector3 } from '@iwsdk/core';
import { createProp } from '../models.js';
import { BeatClock, DEFAULT_ROLE, FRESH_PERFORMANCE } from './rules.js';

/**
 * What the band's two systems share. `StageSystem` owns the centre and the breaches,
 * `BandSystem` the role, the clock and the score.
 */
export const band = {
  role: DEFAULT_ROLE,
  /** True when the roster owns the role (`HqSystem`): it is the active character's, not switched in play. */
  rosterLocked: false,
  clock: new BeatClock(),
  /** Seconds on the beat clock, written every frame by `BandSystem`. */
  beatTime: 0,
  performance: { ...FRESH_PERFORMANCE },
  lastGrade: null,
  lastGradeAt: -Infinity,
  breaches: 0,
  breachAt: -Infinity,
  /** The ultimate's meter, 0 to 1, filled by playing on the beat. */
  ultCharge: 0,
  /** Beat-clock seconds of the last ultimate, for the lights. */
  ultAt: -Infinity,
  /** The centre of the stage: the level's start, on the ground. */
  centre: new Vector3(),
  /** False until a level has been built, so nothing judges the menu. */
  staged: false,
  /**
   * True on a Boss Hunt board (`isHuntBoard` in `rules.js`): no stage is built, `centre` is just
   * the start, and nobody is sent home. Written by `StageSystem` when a level starts.
   */
  hunt: false,
  /** On a hunt: the boss being hunted, `{ name, object }` (`object` null until it is in), or null. */
  quarry: null,
  /** This player's seat in the room, 0 when playing alone. Written by `NetSystem`. */
  seat: 0,
  /** Playing together: each other player's id → the role they are playing. Written by `NetSystem`. */
  remoteRoles: new Map(),
  /**
   * The key of what the active character wears in the main hand, or null. Written by `HqSystem`;
   * `BandSystem` plays that role's classic when it is one (`instrumentFor`).
   */
  mainHand: null,

  /** Whether anybody in the band, this player or another, is on the drums. */
  anyoneDrumming() {
    return this.role === 'drummer' || [...this.remoteRoles.values()].includes('drummer');
  },

  resetLevel(centre) {
    this.centre.copy(centre);
    this.performance = { ...FRESH_PERFORMANCE };
    this.lastGrade = null;
    this.lastGradeAt = -Infinity;
    this.breaches = 0;
    this.breachAt = -Infinity;
    this.ultCharge = 0;
    this.ultAt = -Infinity;
    this.staged = true;
  },
};

/**
 * Loads an instrument (`instrumentFor` in `rules.js`): fitted to its size, turned by its `turnZ`,
 * and centred over its origin. `held` puts the origin at its middle, for a hand to hold it round;
 * otherwise it stands on its base, as a kit stands on the stage.
 */
export async function createInstrument(instrument, { held = false } = {}) {
  const prop = await createProp({ model: instrument.prop, texture: null }, instrument.sizeM);
  const body = prop.children[0];
  if (!body) return prop;
  body.rotation.z += instrument.turnZ ?? 0;
  prop.updateMatrixWorld(true);
  const box = new Box3().setFromObject(body);
  const centre = box.getCenter(new Vector3());
  body.position.x -= centre.x;
  body.position.z -= centre.z;
  body.position.y -= held ? centre.y : box.min.y;
  return prop;
}
