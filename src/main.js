import { SessionMode, World } from '@iwsdk/core';
import { ALL_COMPONENTS } from './components.js';
import { GAME } from './content/game.js';
import { CueSystem } from './cues.js';
import { run } from './state.js';
import { CombatSystem } from './systems/CombatSystem.js';
import { HudSystem } from './systems/HudSystem.js';
import { LevelSystem } from './systems/LevelSystem.js';
import { NpcSystem } from './systems/NpcSystem.js';
import { PlayerSystem } from './systems/PlayerSystem.js';
import { ProgressSystem } from './systems/ProgressSystem.js';
import { WaveSystem } from './systems/WaveSystem.js';

/**
 * Boots the game: an IWSDK world with VR offered, locomotion on, and this game's systems.
 *
 * Read top to bottom, this is the whole game: `content/game.js` is what it contains, `rules.js`
 * is how it plays, and each file in `systems/` runs one part of it every frame.
 */

if (new URLSearchParams(location.search).has('emulate')) {
  const { installEmulator } = await import('./emulator.js');
  await installEmulator();
}

document.title = GAME.meta.name;

const world = await World.create(document.getElementById('scene-container'), {
  xr: {
    sessionMode: SessionMode.ImmersiveVR,
    // A headset's browser shows its own "Enter VR" prompt; the start screen has a button too.
    offer: 'always',
    features: { handTracking: true },
  },
  render: { fov: 70, near: 0.05, far: 800, camera: { position: [0, 1.6, 0] } },
  features: {
    locomotion: {
      // The main thread keeps the setup to a plain Vite project; flip it on for very large scenes.
      useWorker: false,
      browserControls: true,
      enableJumping: true,
    },
    grabbing: false,
    spatialUI: false,
  },
});

for (const component of ALL_COMPONENTS) world.registerComponent(component);

// Order matters only loosely: input → waves → AI → combat → quests → HUD, after IWSDK's own systems.
world
  .registerSystem(LevelSystem, { priority: 1 })
  .registerSystem(PlayerSystem, { priority: 2 })
  .registerSystem(WaveSystem, { priority: 2 })
  .registerSystem(NpcSystem, { priority: 3 })
  .registerSystem(CombatSystem, { priority: 4 })
  .registerSystem(ProgressSystem, { priority: 5 })
  .registerSystem(HudSystem, { priority: 6 });

// A game's own systems, when Game Foundry has any for it: `src/game/index.js` exports `install`.
// Most exports have no `src/game/`, and this finds nothing.
const ADDONS = import.meta.glob('./game/index.js', { eager: true });
for (const addon of Object.values(ADDONS)) addon.install?.(world);

// After everything that animates, so a cue reads the bone where this frame's mixers put it.
world.registerSystem(CueSystem, { priority: 9 });

// Handy from the browser console while editing: `game.world`, `game.run`, `game.GAME`.
window.game = { world, run, GAME };
