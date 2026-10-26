import { GAME } from '../content/game.js';
import { BandSystem } from './BandSystem.js';
import { BossSystem } from './BossSystem.js';
import { BotSystem } from './BotSystem.js';
import { HqSystem } from './HqSystem.js';
import { NetSystem } from './NetSystem.js';
import { StageSystem } from './StageSystem.js';
import { setDashAttack } from '../dash.js';
import { setDropModel, setProjectileModel } from '../models.js';
import { DASH_ATTACK, ZOMBIE_DASH } from './dash.js';
import { encoreDropModel, huntRangeFor } from './rules.js';
import { singerProjectileModel } from './lightning.js';
import { spitProjectileModel } from './spit.js';

/**
 * Zombie Beat's own half of the export: the band on a stage at the centre, the zombies coming for
 * it, and a press on the beat.
 *
 * `src/main.js` calls `install` once its own systems are registered. Everything else in this
 * project is the generic template; the files in `src/game/` are this game's.
 *
 * | File | |
 * |---|---|
 * | `rules.js` | the roles, the beat, the score, the ultimates, the hunt range (pure) |
 * | `audio.js` | the groove and the instruments, synthesised on Web Audio |
 * | `StageSystem.js` | the stage set, the centre ring, sending a player home |
 * | `BandSystem.js` | the role, the props (the kit follows its drummer), the attack on the beat, the ultimate, the score display, Home |
 * | `ultPanel.js` | the ULTIMATE panel in the headset, aimed at with either hand |
 * | `NetSystem.js` | playing together: rooms, the host's zombies, guests' swings, everyone's bodies |
 * | `BotSystem.js` | CPU bandmates: how many, which roles, guarding the stage on the beat |
 * | `BossSystem.js` | the zombie bosses: held back at the start of a night, let in at random moments; on a Boss Hunt, one of them hidden far across the level |
 * | `avatar.js` | a band member's body, for other players and CPU bandmates alike |
 * | `ledger.js` | a guest's stats as the host keeps them, and where each seat stands (pure) |
 * | `roster.js` | characters that keep their level, stat points and gear on this device; the shop (pure) |
 * | `HqSystem.js` | Band HQ before and between boards, on a flat screen and in the headset, and the character card |
 * | `spit.js` | the spitter's bile in flight: the goo flipbook instead of a ball |
 * | `dash.js` | `zombie_dash` as a run: through where the target is expected to be, stopping 0.5 m past it |
 * | `lightning.js` | the singer's shot in flight: the lightning flipbook instead of a ball |
 * | `flipbook.js` | a sprite sheet played as a camera-facing flipbook, for both of those |
 * | `cast.js` | the band's characters, written by the exporter from `addon.json` |
 *
 * Encore Coins drop as a coin, or as a trophy for a big drop (`encoreDropModel`).
 *
 * ## Boss Hunt
 *
 * A board whose every win condition is a kill of a boss (`isHuntBoard`, Horror Carnival for one)
 * is a hunt instead of a night on the stage: no stage is built and Home is off, one of the named
 * bosses hides far across the level and keeps to its hideout, the CPU bandmates go with the player,
 * and the score panel shows how far off the boss is. Killing it wins the board, judged here like
 * any other kill goal.
 */
export function install(world) {
  // Every zombie hunts the band from wherever it spawned, however big the level.
  GAME.tuning.huntMeters = Math.max(GAME.tuning.huntMeters, huntRangeFor(GAME.levels));
  setDropModel(encoreDropModel);
  setProjectileModel((attack) => spitProjectileModel(attack) ?? singerProjectileModel(attack));
  setDashAttack(DASH_ATTACK, ZOMBIE_DASH);

  // The stage first: it is what marks a level as staged before the band picks its props.
  world
    .registerSystem(StageSystem, { priority: 2 })
    .registerSystem(BandSystem, { priority: 2 })
    .registerSystem(NetSystem, { priority: 2 })
    .registerSystem(BotSystem, { priority: 2 })
    .registerSystem(BossSystem, { priority: 2 })
    // Last: it reads the band's and the room's systems, and moves the room box into Band HQ.
    .registerSystem(HqSystem, { priority: 2 });
}
