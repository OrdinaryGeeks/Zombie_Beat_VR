# Zombie Beat — WebXR

An immersive VR game built on Meta's [Immersive Web SDK](https://iwsdk.dev) (IWSDK) and three.js,
exported from Game Foundry. It is a plain Vite project: no backend, no database, no account. Every
level, character, attack, item and quest is JavaScript in `src/content/game.js`.

## Run it

```bash
npm install
npm run dev            # http://localhost:5173 — desktop play
npm run dev:headset    # HTTPS on your network — open the printed https://<ip>:5173 in the headset
npm run build          # static site in dist/, host it anywhere that serves HTTPS
```

No headset? Open `http://localhost:5173/?emulate` for Meta's emulated Quest 3 with on-screen controls.

## Controls

| | Headset | Desktop |
|---|---|---|
| Move | left stick | WASD |
| Turn | right stick | mouse (click the game to lock it) |
| Attack | right trigger, or pinch | left click, or F |
| Jump | A | Space |
| Start screen | stick to choose, trigger to start | click a level |

## Where things are

```
src/
  main.js               creates the IWSDK World and registers the systems
  content/game.js       ALL the game's content — edit this first
  content/assets.js     which asset files the export carried
  rules.js              damage, loot rolls, XP curve, quest and level-end rules
  state.js              the run: health, bag, quest progress, counters
  components.js         ECS components (Actor, Pickup, Projectile, ...)
  models.js             loading GLBs, atlas textures, placeholders
  systems/
    LevelSystem.js      builds a level: ground, scene model, props, cast, player start
    PlayerSystem.js     input, aim, death and respawn
    NpcSystem.js        the cast's behaviour: chase, attack, follow, flee, wander
    CombatSystem.js     hits, projectiles, deaths, loot drops, pickups
    ProgressSystem.js   quests and win/lose conditions
    HudSystem.js        start screen and HUD (HTML on desktop, a panel in VR)
public/assets/          models, scenes and atlas pages
```

The game is IWSDK's entity-component-system: each file in `systems/` is a `createSystem` class whose
`update` runs every frame, and IWSDK's own systems (locomotion, input, XR session) run before them.
See the [IWSDK docs](https://iwsdk.dev) for what else a system can query and do.

## Levels

1. **Soundcheck at Dusk** (`level_01_soundcheck`) — 22 spawns
2. **Parking Lot Jam** (`level_02_parking_lot`) — 27 spawns
3. **Midnight Carnival** (`level_03_midnight_carnival`) — 32 spawns
4. **Stadium Encore** (`level_04_stadium_encore`) — 37 spawns
5. **Casino Strip Showdown** (`level_05_casino_strip`) — 37 spawns
6. **Village Square Unplugged** (`level_06_village_square`) — 37 spawns
7. **Crossroads Last Stand** (`level_07_crossroads`) — 37 spawns
8. **Horror Carnival** (`level_08_horror_carnival`) — 33 spawns

## Assets

101 file(s) were copied into `public/assets/`.

12 could not be fetched and draw as placeholders (their paths were cleared in `game.js`):

- `SYNTYTEXTURES/PolygonCasino_03_B.png`
- `SYNTYTEXTURES/PolygonCasino_02_B.png`
- `SYNTYTEXTURES/PolygonCasino_03_A.png`
- `SYNTYTEXTURES/PolygonCasino_03_C.png`
- `SYNTYTEXTURES/PolygonCasino_02_C.png`
- `SYNTYTEXTURES/PolygonCasino_01_C.png`
- `SYNTYTEXTURES/PolygonCasino_02_A.png`
- `SYNTYTEXTURES/PolygonCasino_04_C.png`
- `SYNTYTEXTURES/PolygonCasino_01_B.png`
- `SYNTYTEXTURES/PolygonCasino_04_A.png`
- `SYNTYTEXTURES/PolygonCasino_04_B.png`
- `SYNTYTEXTURES/PolygonBattleRoyale_Texture_04_A.png`

Characters and props from Synty Studios packs remain under Synty's licence: you may use them in your
own projects, but do not redistribute the raw files (for example in a public repository).

## How this differs from the game in Game Foundry

In Game Foundry the arcade server resolved stats, rolled loot and judged levels. Here those rules
are local and simplified, in `src/rules.js`, and the numbers are frozen at export time. Animation
retargeting, the balance curve, skill trees, classes, multiplayer and saved progress are not part of
the export. Characters play their own clips when their GLB has any, and bob along otherwise.
