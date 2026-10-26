import { Vector3, createSystem } from '@iwsdk/core';
import { Actor, Pickup } from '../components.js';
import { GAME } from '../content/game.js';
import { createLootMesh } from '../models.js';
import { xpToNext } from '../rules.js';
import { RelayClient } from '../net.js';
import { LOOT_GRACE_SECONDS, emit, on, run } from '../state.js';
import { CombatSystem } from '../systems/CombatSystem.js';
import { LevelSystem } from '../systems/LevelSystem.js';
import { PlayerSystem } from '../systems/PlayerSystem.js';
import { BandSystem } from './BandSystem.js';
import { band } from './band.js';
import { animateAvatar, createAvatar, disposeAvatar, performUltimate, setAvatarRole } from './avatar.js';
import { BotSystem } from './BotSystem.js';
import { StageSystem } from './StageSystem.js';
import { addLoot, creditKill, hurt, newLedger, youMessage } from './ledger.js';
import { roleByKey, ROLES, ULT_MIN_GAP_SECONDS, ULTIMATES, ultimateDamage } from './rules.js';

const PLAYER_INTERVAL = 1 / 15;
const WORLD_INTERVAL = 1 / 10;
/** How often the host tells a guest their stats when something changed, and at the least. */
const YOU_INTERVAL = 0.2;
const YOU_KEEPALIVE = 1;
/** A remote player not heard from for this long stops drawing zombies (and hits) on the host. */
const STALE_MS = 2500;

const feet = new Vector3();
const look = new Vector3();

/**
 * Zombie Beat, played together.
 *
 * Players join a room on the page's own server (`relay.mjs`, via `src/net.js`): type a room name
 * on the start screen, or open the game with `?room=<name>&name=<you>`. Everyone who types the
 * same name is in the same band. Up to six.
 *
 * ## Who decides what
 *
 * The first player in hosts, and the room hands hosting on if they leave. The **host** runs the
 * zombies exactly as single-player does, except that "the player" is whoever is nearest
 * (`world.net.players()`), and judges the level. Ten times a second it tells everyone where every
 * zombie is, how hurt it is, and the level's counters.
 *
 * A **guest** (`world.net.follower`) runs no zombie AI, judges nothing and owns none of its own
 * numbers. Its zombies ease to where the host says (`NpcSystem.follow`); it loads whatever level the
 * host is on and sees the host's drops.
 *
 * ### The host keeps every guest's stats
 *
 * Each guest has a ledger on the host (`ledger.js`): health, max health, level, XP, currencies,
 * weapon, bag. The host sends it down (`you`) whenever it changes, and the guest's HUD shows it.
 *
 * - **A guest's swing is an event on the host.** The guest draws it and sends only what it was:
 *   role, where, which way, how on the beat. The host works out the damage from *that guest's
 *   weapon in its ledger*, delivers it in the host's world, and a kill is credited to the guest
 *   (`world.net.creditKill`): XP and gold to their ledger, the kill to the band's objectives.
 * - **A zombie's hit on a guest lands in their ledger** (`world.net.hitPlayer`). When it kills them
 *   the host counts the death for the band and sends `respawn`.
 * - **A drop is the host's.** Every guest sees it (in the world snapshot); the first player to walk
 *   over it gets it, from the host (`world.net.pickup`), into their ledger.
 * - **What the host sees, every guest sees.** Each player's swing and ultimate go to everyone, and
 *   the players who are not landing them draw them at no damage (`drawAttack`, `drawUltimate`). The
 *   zombies' attacks ride the world snapshot (`za`) and are drawn the same way: the ring of a bite,
 *   spit in flight, a scream's ray. CPU bandmates' swings are drawn whole, bolts and all, and what
 *   the host is told about the world (a wave starting, a bandmate down: a `shared` message) is told
 *   to the band. Zero damage lands nothing anywhere (`CombatSystem.damageActor`).
 *
 * What a guest still tells the host is only where it is, which role, and when it swung, as it is
 * between friends: the relay trusts positions.
 *
 * If the host leaves, the next host starts every guest from the game's starting stats.
 *
 * ## What each player looks like
 *
 * In first person you never see yourself; everyone else sees you as one of the characters in
 * `cast.js`, chosen by your seat in the room, so every player in a band looks different. Your
 * instrument is in your hand, and while you stand still your body plays your role: guitar, drums,
 * singing or dancing, baked into the character by Game Foundry's exporter.
 */
export class NetSystem extends createSystem({
  actors: { required: [Actor] },
  pickups: { required: [Pickup] },
}) {
  init() {
    this.client = new RelayClient();
    /** id → remote player: what they last said, and their body here. */
    this.remotes = new Map();
    /** Host only: when each guest last fired an ultimate, in seconds. */
    this.lastUltimate = new Map();
    /** spawnIndex → actor entity, rebuilt each level. */
    this.byIndex = new Map();
    this.playerIn = 0;
    this.worldIn = 0;
    /** Set while loading a level because the host said to, so it is not echoed back as a request. */
    this.following = false;
    this.lastLevelKey = null;
    /** Host only: guest id → their stats. */
    this.ledgers = new Map();
    this.dirty = new Set();
    this.youIn = 0;
    this.keepaliveIn = 0;
    /** Guest only: the host's drops as drawn here, by net id. */
    this.drops = new Map();
    /** Host only: its zombies' attacks since the last snapshot, `[spawnIndex, key, x, y, z]`. */
    this.actorAttacks = [];

    const net = this;
    // The hook the template's systems read. Undefined until here, so single-player is unchanged.
    this.world.net = {
      get follower() {
        return net.client.connected && !net.client.isHost;
      },
      // Everyone the zombies can go for besides this player: the other players, and CPU bandmates.
      players: () => [...net.livePlayers(), ...(net.bots()?.targets() ?? [])],
      hitPlayer: (id, damage) => (id.startsWith('cpu:') ? net.bots()?.hit(id, damage) : net.hitGuest(id, damage)),
      creditKill: (id, row) => (id.startsWith('cpu:') ? net.creditCpu(row) : net.creditGuest(id, row)),
      pickup: (id, lootKey, quantity) => net.giveGuest(id, lootKey, quantity),
      /** The room, `[{ id, seat, name }]`, everyone included; empty playing alone. */
      peers: () => (net.client.connected ? net.client.peers : []),
      /** Another player's or a CPU bandmate's avatar, by id, or null. */
      body: (id) => (id.startsWith('cpu:') ? net.bots()?.bots.get(id)?.avatar ?? null : net.remotes.get(id) ?? null),
    };

    this.client.onMessage = (from, m) => this.receive(from, m);
    this.client.onRoster = (peers) => this.applyRoster(peers);
    this.client.onClose = (reason) => {
      this.clearRemotes();
      this.clearDrops();
      // The host's bandmates go with the host; this player's own come back as their setting says.
      this.bots()?.clear();
      band.seat = 0;
      emit('message', { text: `Left the room (${reason}).`, tone: 'bad' });
      this.drawStatus();
    };

    this.buildJoinPanel();
    this.buildStatus();

    this.cleanupFuncs.push(
      on('level-loading', ({ level }) => {
        // A guest that picked a level itself asks the host to take the band there.
        if (this.world.net.follower && !this.following) this.client.send('host', { t: 'want', key: level.key });
      }),
      on('level-start', ({ level }) => {
        this.following = false;
        this.lastLevelKey = level.key;
        this.indexActors();
        this.clearDrops();
        this.actorAttacks.length = 0;
        // A new level starts every guest at full health, as it does the host.
        for (const [id, ledger] of this.ledgers) {
          ledger.hp = ledger.maxHp;
          this.dirty.add(id);
        }
        if (this.client.isHost) this.client.send('all', { t: 'level', key: level.key });
      }),
      on('level-end', ({ status }) => {
        if (this.client.isHost) this.client.send('all', { t: 'end', status });
      }),
      // A held spawn let in mid-level (a boss) needs a place in the index the snapshots go by.
      on('actor-arrived', () => this.indexActors()),
      // Everyone's swing and ultimate go to everyone: the host lands a guest's, and every other
      // player draws it (`drawAttack`, `drawUltimate`), the host's own included.
      on('band-attack', (attack) => {
        if (!this.client.connected) return;
        const r = (v) => [round(v.x), round(v.y), round(v.z)];
        this.client.send('all', {
          t: 'atk', role: attack.role, o: r(attack.origin), f: r(attack.feet), d: r(attack.direction), g: attack.grade,
          w: attack.attackKey ?? null,
        });
      }),
      on('band-ultimate', (ult) => {
        if (!this.client.connected) return;
        const r = (v) => [round(v.x), round(v.y), round(v.z)];
        this.client.send('all', {
          t: 'ult', role: ult.role, o: r(ult.origin), f: r(ult.feet), d: r(ult.direction), g: ult.grade,
        });
      }),
      // The host's zombies' attacks, drawn on every guest with the next snapshot (`sendWorld`).
      on('actor-attack', ({ entity, attack, target }) => {
        if (!this.client.connected || !this.client.isHost) return;
        const index = entity.object3D?.userData.spawnIndex;
        if (index === undefined || !GAME.attacks[attack.key]) return;
        this.actorAttacks.push([index, attack.key, round(target.x), round(target.y), round(target.z)]);
        // A snapshot is a tenth of a second; anything older than a crowd's worth is stale anyway.
        if (this.actorAttacks.length > 64) this.actorAttacks.shift();
      }),
      // What the host is told about the world (a wave, a bandmate down) is told to the band.
      on('message', ({ text, tone, shared, skip }) => {
        if (!shared || !this.client.connected || !this.client.isHost) return;
        this.client.send('all', { t: 'msg', text: String(text), tone, skip: skip ?? null });
      }),
    );

    const params = new URLSearchParams(location.search);
    if (params.get('room')) void this.join(params.get('room'), params.get('name') || this.defaultName());
  }

  // ── joining ─────────────────────────────────────────────────────────────────────────────────

  defaultName() {
    try {
      return localStorage.getItem('zb:name') || '';
    } catch {
      return '';
    }
  }

  async join(room, name) {
    const cleanRoom = String(room).trim().replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24);
    if (!cleanRoom) return;
    try {
      localStorage.setItem('zb:name', name);
    } catch {
      // Private window: the name is simply not remembered.
    }
    this.setJoinStatus(`Joining ${cleanRoom}...`);
    try {
      await this.client.join(cleanRoom, name || 'Player');
      band.seat = this.client.seat ?? 0;
      emit('message', { text: `Joined room ${cleanRoom} as seat ${this.client.seat + 1}.`, tone: 'good' });
      this.setJoinStatus(this.client.isHost
        ? `In ${cleanRoom}, hosting. Pick a level; the band follows you.`
        : `In ${cleanRoom}. Waiting for the host to start a level.`);
    } catch (err) {
      this.setJoinStatus(`Could not join: ${err.message}. Is this running on its dev server (npm run dev)?`);
    }
    this.drawStatus();
  }

  leave() {
    this.client.leave();
    this.clearRemotes();
    this.clearDrops();
    this.bots()?.clear();
    band.seat = 0;
    this.setJoinStatus('Playing alone.');
    this.drawStatus();
  }

  applyRoster(peers) {
    const present = new Set(peers.map((p) => p.id));
    for (const peer of peers) {
      if (peer.id === this.client.id) continue;
      let remote = this.remotes.get(peer.id);
      if (!remote) {
        remote = this.newRemote(peer);
        this.remotes.set(peer.id, remote);
        emit('message', { text: `${peer.name} joined the band.`, tone: 'info' });
      }
      remote.name = peer.name;
    }
    for (const [id, remote] of this.remotes) {
      if (present.has(id)) continue;
      emit('message', { text: `${remote.name} left the band.`, tone: 'info' });
      this.dropRemote(id);
    }
    if (this.client.isHost) {
      // Every guest gets a ledger the moment they are in the room, so their first swing has a weapon.
      for (const id of this.remotes.keys()) this.ledgerFor(id);
    } else {
      this.ledgers.clear();
    }
    for (const id of [...this.ledgers.keys()]) if (!present.has(id)) this.ledgers.delete(id);
    this.drawStatus();
  }

  // ── the host's books on its guests ──────────────────────────────────────────────────────────

  ledgerFor(id) {
    let ledger = this.ledgers.get(id);
    if (!ledger) {
      ledger = newLedger(GAME.player);
      this.ledgers.set(id, ledger);
      this.dirty.add(id);
    }
    return ledger;
  }

  hitGuest(id, damage) {
    if (!this.client.isHost || run.phase !== 'playing') return;
    const ledger = this.ledgerFor(id);
    const { died } = hurt(ledger, damage, GAME.player.mitigation);
    this.dirty.add(id);
    if (!died) return;
    run.deaths += 1;
    const name = this.remotes.get(id)?.name ?? 'A bandmate';
    // Told to the rest of the band; the one who went down is told by `respawn` instead.
    emit('message', { text: `${name} went down.`, tone: 'bad', shared: true, skip: id });
    this.client.send(id, { t: 'respawn' });
  }

  bots() {
    return this.world.getSystem(BotSystem) ?? null;
  }

  /** A CPU bandmate's kill pays whoever runs the band: the solo player, or the host. */
  creditCpu(row) {
    run.gainXp(row.xpReward ?? 0);
    if (row.currencyReward > 0) run.currencies.gold = (run.currencies.gold ?? 0) + Math.round(row.currencyReward);
  }

  creditGuest(id, row) {
    if (!this.client.isHost) return;
    const levels = creditKill(this.ledgerFor(id), row, xpToNext, GAME.progression.healthPerLevel);
    this.dirty.add(id);
    if (levels > 0) this.client.send(id, { t: 'levelup', lv: this.ledgers.get(id).level });
  }

  giveGuest(id, lootKey, quantity) {
    if (!this.client.isHost) return;
    const item = GAME.loot[lootKey];
    const outcome = addLoot(this.ledgerFor(id), item, quantity, xpToNext, GAME.progression.healthPerLevel);
    this.dirty.add(id);
    this.client.send(id, { t: 'got', key: lootKey, q: quantity, o: outcome });
  }

  /** Each guest's ledger, sent down when it changed and once a second regardless. */
  sendLedgers(delta) {
    this.youIn -= delta;
    this.keepaliveIn -= delta;
    if (this.youIn > 0) return;
    this.youIn = YOU_INTERVAL;
    const everyone = this.keepaliveIn <= 0;
    if (everyone) this.keepaliveIn = YOU_KEEPALIVE;
    for (const [id, ledger] of this.ledgers) {
      if (!everyone && !this.dirty.has(id)) continue;
      this.client.send(id, youMessage(ledger, xpToNext));
    }
    this.dirty.clear();
  }

  /** A guest's own stats, as the host keeps them, onto this guest's `run` (which the HUD reads). */
  applyYou(m) {
    if (!Number.isFinite(m.hp) || !Number.isFinite(m.mhp)) return;
    run.health = m.hp;
    run.maxHealth = m.mhp;
    if (Number.isFinite(m.lv)) run.playerLevel = m.lv;
    if (Number.isFinite(m.xp)) run.xp = m.xp;
    if (m.cur && typeof m.cur === 'object') run.currencies = { ...m.cur };
    if (m.w && Number.isFinite(m.w.dps)) run.weapon = { name: String(m.w.name ?? ''), attackKey: m.w.attackKey ?? null, dps: m.w.dps };
    if (m.bag && typeof m.bag === 'object') run.inventory = new Map(Object.entries(m.bag).filter(([, q]) => Number.isFinite(q)));
  }

  // ── what goes out ───────────────────────────────────────────────────────────────────────────

  update(delta) {
    for (const remote of this.remotes.values()) {
      // On another level, or not yet heard from: not in this player's world right now.
      animateAvatar(remote, delta, remote.level === run.levelKey && run.phase !== 'menu');
    }
    if (!this.client.connected) return;

    this.playerIn -= delta;
    if (this.playerIn <= 0) {
      this.playerIn = PLAYER_INTERVAL;
      this.sendPlayer();
    }
    if (this.client.isHost) this.sendLedgers(delta);
    else this.spinDrops(delta);

    // Through the loot grace too, so a drop the host or a bandmate sweeps up vanishes for everyone.
    if (this.client.isHost && run.canCollect()) {
      this.worldIn -= delta;
      if (this.worldIn <= 0) {
        this.worldIn = WORLD_INTERVAL;
        this.sendWorld();
      }
    }
  }

  sendPlayer() {
    const player = this.world.getSystem(PlayerSystem);
    player.getFeet(feet);
    this.camera.getWorldDirection(look);
    const moved = this.lastFeet ? Math.hypot(feet.x - this.lastFeet.x, feet.z - this.lastFeet.z) : 0;
    this.lastFeet = feet.clone();
    this.client.send('all', {
      t: 'p', x: round(feet.x), y: round(feet.y), z: round(feet.z),
      r: round(Math.atan2(look.x, look.z), 3),
      mv: moved > 0.02 ? 1 : 0,
      role: band.role,
      lv: run.phase === 'playing' ? run.levelKey : null,
    });
  }

  sendWorld() {
    const actors = [];
    for (const entity of this.queries.actors.entities) {
      const object = entity.object3D;
      if (!object) continue;
      const index = object.userData.spawnIndex;
      if (index === undefined) continue;
      const state = entity.getValue(Actor, 'state');
      const maxHp = entity.getValue(Actor, 'maxHp') || 1;
      actors.push([
        index, round(object.position.x), round(object.position.y), round(object.position.z),
        round(object.rotation.y, 3), state === 'chase' || state === 'return' ? 1 : 0,
        object.userData.swings ?? 0, round(entity.getValue(Actor, 'hp') / maxHp, 3), state === 'dead' ? 1 : 0,
        // Which take the last swing was (a bite, a scream, a dash's run), and whether it is running.
        object.userData.take ?? '', object.userData.dash ? 1 : 0,
      ]);
    }
    const drops = [];
    for (const entity of this.queries.pickups.entities) {
      const object = entity.object3D;
      if (!object?.userData.netId) continue;
      drops.push([object.userData.netId, entity.getValue(Pickup, 'lootKey'), round(object.position.x), round(object.userData.baseY ?? object.position.y), round(object.position.z), entity.getValue(Pickup, 'quantity')]);
    }
    this.client.send('all', {
      t: 'w', lv: run.levelKey, e: round(run.elapsed, 1), tk: run.totalKills, k: run.kills, dd: run.deaths, a: actors, pk: drops,
      b: this.bots()?.snapshot() ?? [],
      za: this.actorAttacks.splice(0),
    });
  }

  // ── what comes in ───────────────────────────────────────────────────────────────────────────

  receive(from, m) {
    switch (m.t) {
      case 'p': this.applyPlayer(from, m); break;
      case 'w': if (this.world.net.follower) this.applyWorld(m); break;
      case 'level': if (this.world.net.follower) this.followLevel(m.key); break;
      case 'end': if (this.world.net.follower) this.applyEnd(m.status); break;
      case 'want': if (this.client.isHost) this.grantLevel(m.key); break;
      case 'atk': if (this.client.isHost) this.applyAttack(from, m); else this.drawAttack(from, m); break;
      case 'ult': if (this.client.isHost) this.applyUltimate(from, m); else this.drawUltimate(from, m); break;
      case 'msg':
        if (this.world.net.follower && typeof m.text === 'string' && m.skip !== this.client.id) {
          emit('message', { text: m.text.slice(0, 160), tone: ['good', 'bad', 'info'].includes(m.tone) ? m.tone : 'info' });
        }
        break;
      case 'you': if (this.world.net.follower) this.applyYou(m); break;
      case 'respawn':
        if (!this.world.net.follower) break;
        emit('message', { text: 'You were defeated.', tone: 'bad' });
        emit('player-death', {});
        this.world.getSystem(StageSystem)?.goHome();
        break;
      case 'levelup':
        if (this.world.net.follower) emit('message', { text: `Level up! You are level ${m.lv}.`, tone: 'good' });
        break;
      case 'got':
        if (this.world.net.follower && GAME.loot[m.key]) {
          emit('pickup', { lootKey: m.key, quantity: m.q });
          if (m.o === 'equipped') emit('message', { text: `Equipped ${GAME.loot[m.key].name}`, tone: 'good' });
        }
        break;
      default: break;
    }
  }

  applyPlayer(from, m) {
    const remote = this.remotes.get(from);
    if (!remote || !finite(m.x, m.y, m.z)) return;
    remote.target.set(m.x, m.y, m.z);
    remote.targetRy = Number.isFinite(m.r) ? m.r : remote.targetRy;
    remote.moving = m.mv === 1;
    remote.level = typeof m.lv === 'string' ? m.lv : null;
    remote.heardAt = performance.now();
    if (!remote.placed) {
      remote.group.position.copy(remote.target);
      remote.placed = true;
    }
    const role = ROLES.some((r) => r.key === m.role) ? m.role : null;
    if (role !== remote.role) {
      setAvatarRole(remote, role);
      if (role) band.remoteRoles.set(from, role);
      else band.remoteRoles.delete(from);
      if (role) emit('message', { text: `${remote.name} is on ${roleByKey(role).label.toLowerCase()}.`, tone: 'info' });
    }
  }

  applyWorld(m) {
    // The host is playing a level this guest is not (a new one, a retry after a loss, or the
    // guest is still on the menu or the end board): go there.
    // The same level during the loot grace is not a level to follow: it is the one just finished.
    if (typeof m.lv === 'string' && (m.lv !== run.levelKey || !run.canCollect())) {
      this.followLevel(m.lv);
      return;
    }
    if (!run.canCollect() || !Array.isArray(m.a)) return;
    if (Number.isFinite(m.e)) run.elapsed = m.e;
    if (Number.isFinite(m.tk)) run.totalKills = m.tk;
    if (m.k && typeof m.k === 'object') run.kills = { ...m.k };
    if (Number.isFinite(m.dd)) run.deaths = m.dd;

    for (const row of m.a) {
      if (!Array.isArray(row) || row.length < 9) continue;
      const [index, x, y, z, ry, moving, swings, hpFraction, dead, take, dashing] = row;
      const entity = this.byIndex.get(index);
      if (!entity) {
        // One the host has let in that this guest is still holding (a boss, a wave, a wave's crowd
        // sent round again): let it in here too. `actor-arrived` re-indexes, and the next snapshot
        // moves it. Never a dead one — that is a zombie this guest already saw fall.
        if (dead !== 1) void this.world.getSystem(LevelSystem).release(index);
        continue;
      }
      if (!entity.object3D || !finite(x, y, z)) continue;
      const object = entity.object3D;
      object.userData.netTarget = {
        x, y, z, ry, moving: moving === 1, swings,
        take: typeof take === 'string' ? take : '', dashing: dashing === 1,
      };
      const maxHp = entity.getValue(Actor, 'maxHp') || 1;
      entity.setValue(Actor, 'hp', Math.max(0, hpFraction) * maxHp);
      if (dead === 1 && entity.getValue(Actor, 'state') !== 'dead') {
        entity.setValue(Actor, 'state', 'dead');
        object.userData.deadFor = 0;
        const row = object.userData.entity;
        if (row) emit('kill', { key: row.key, name: row.name });
      }
    }
    if (Array.isArray(m.pk)) this.applyDrops(m.pk);
    if (Array.isArray(m.b)) this.bots()?.applyRemote(m.b);
    if (Array.isArray(m.za)) this.drawActorAttacks(m.za);
  }

  /**
   * The host's zombies' attacks since its last snapshot, drawn here at no damage: the swing's ring,
   * the spit in flight, the scream's ray. What each one did to this player arrives in their ledger.
   */
  drawActorAttacks(rows) {
    const combat = this.world.getSystem(CombatSystem);
    if (!combat || run.phase !== 'playing') return;
    for (const row of rows) {
      if (!Array.isArray(row) || row.length < 5) continue;
      const [index, key, x, y, z] = row;
      const entity = this.byIndex.get(index);
      const attack = GAME.attacks[key];
      if (!entity?.object3D || !attack || !finite(x, y, z) || entity.getValue(Actor, 'state') === 'dead') continue;
      combat.actorAttack(entity, new Vector3(x, y, z), attack, { drawOnly: true });
    }
  }

  /** Another player's swing, the host's or a guest's, drawn here at no damage. The host lands it. */
  drawAttack(from, m) {
    if (run.phase !== 'playing' || !ROLES.some((r) => r.key === m.role) || this.remotes.get(from)?.level !== run.levelKey) return;
    const shot = this.shot(m);
    if (!shot) return;
    const weapon = { name: '', dps: 0, attackKey: typeof m.w === 'string' && GAME.attacks[m.w] ? m.w : null };
    this.world.getSystem(BandSystem)?.deliver(m.role, shot.origin, shot.at, shot.direction, 0, shot.grade, null, weapon);
  }

  /** Another player's ultimate, drawn here at no damage, on their body: the host lands it. */
  drawUltimate(from, m) {
    const remote = this.remotes.get(from);
    if (run.phase !== 'playing' || !ROLES.some((r) => r.key === m.role) || remote?.level !== run.levelKey) return;
    const shot = this.shot(m);
    if (!shot) return;
    const follow = () => this.remotes.get(from)?.group.position ?? null;
    this.world.getSystem(BandSystem)?.deliverUltimate(m.role, shot.origin, shot.at, shot.direction, 0, shot.grade, null, follow);
    performUltimate(remote, m.role, ULTIMATES[m.role].shape.seconds ?? 0);
  }

  /** A swing's or an ultimate's where and which way, off the wire, or null when it does not parse. */
  shot(m) {
    const vec = (a) => (Array.isArray(a) && finite(a[0], a[1], a[2]) ? new Vector3(a[0], a[1], a[2]) : null);
    const origin = vec(m.o);
    const at = vec(m.f);
    const direction = vec(m.d);
    if (!origin || !at || !direction || direction.lengthSq() < 1e-6) return null;
    const grade = ['perfect', 'good', 'miss'].includes(m.g) ? m.g : 'miss';
    return { origin, at, direction: direction.normalize(), grade };
  }

  /** The host's drops, drawn here: added as they appear, removed as they are taken. */
  applyDrops(rows) {
    const present = new Set();
    for (const row of rows) {
      if (!Array.isArray(row) || row.length < 5) continue;
      // The sixth is what it is worth, which can change how it is drawn; an older host sends none.
      const [id, lootKey, x, y, z, quantity = 1] = row;
      if (!finite(x, y, z) || !GAME.loot[lootKey]) continue;
      present.add(id);
      if (this.drops.has(id)) continue;
      const drop = { mesh: null, age: 0 };
      this.drops.set(id, drop);
      void createLootMesh(GAME.loot[lootKey], Number(quantity) || 1).then((mesh) => {
        if (this.drops.get(id) !== drop) return;
        mesh.position.set(x, y, z);
        mesh.userData.baseY = y;
        this.scene.add(mesh);
        drop.mesh = mesh;
      });
    }
    for (const [id, drop] of this.drops) {
      if (present.has(id)) continue;
      drop.mesh?.removeFromParent();
      this.drops.delete(id);
    }
  }

  spinDrops(delta) {
    for (const drop of this.drops.values()) {
      if (!drop.mesh) continue;
      drop.age += delta;
      drop.mesh.rotation.y += delta * 1.5;
      drop.mesh.position.y = drop.mesh.userData.baseY + 0.1 + Math.sin(drop.age * 3) * 0.08;
    }
  }

  clearDrops() {
    for (const drop of this.drops.values()) drop.mesh?.removeFromParent();
    this.drops.clear();
  }

  /** A guest goes where the host is. */
  followLevel(key) {
    if (!key || run.phase === 'loading' || (key === run.levelKey && run.phase === 'playing')) return;
    this.following = true;
    document.getElementById('menu')?.setAttribute('hidden', '');
    void this.world.getSystem(LevelSystem).load(key).catch((err) => {
      this.following = false;
      console.error('[net] Could not follow the host to', key, err);
    });
  }

  applyEnd(status) {
    if (status !== 'won' && status !== 'lost') return;
    run.phase = status;
    // The host's grace, counted here too so the countdown shows; the host still says what is next.
    run.lootGrace = LOOT_GRACE_SECONDS;
    emit('message', { text: status === 'won' ? 'The band held the stage!' : 'The horde took the stage...', tone: status === 'won' ? 'good' : 'bad' });
  }

  /** The host takes the band to a level a guest picked, unless a set is already under way. */
  grantLevel(key) {
    if (run.phase === 'playing' || run.phase === 'loading') {
      if (run.levelKey) this.client.send('all', { t: 'level', key: run.levelKey });
      return;
    }
    document.getElementById('menu')?.setAttribute('hidden', '');
    void this.world.getSystem(LevelSystem).load(key).catch((err) => console.error('[net] Could not load', key, err));
  }

  /**
   * A guest's swing, delivered in the host's world. The damage is worked out here, from the guest's
   * weapon in their ledger, not taken from the guest; the kill, if there is one, is theirs.
   */
  applyAttack(from, m) {
    if (run.phase !== 'playing' || !ROLES.some((r) => r.key === m.role) || !this.remotes.has(from)) return;
    const vec = (a) => (Array.isArray(a) && finite(a[0], a[1], a[2]) ? new Vector3(a[0], a[1], a[2]) : null);
    const origin = vec(m.o);
    const at = vec(m.f);
    const direction = vec(m.d);
    if (!origin || !at || !direction || direction.lengthSq() < 1e-6) return;
    const grade = ['perfect', 'good', 'miss'].includes(m.g) ? m.g : 'miss';
    const bandSystem = this.world.getSystem(BandSystem);
    if (!bandSystem) return;
    const ledger = this.ledgerFor(from);
    const damage = bandSystem.damageFor(m.role, ledger.weapon, grade);
    bandSystem.deliver(m.role, origin, at, direction.normalize(), damage, grade, from, ledger.weapon);
  }

  /**
   * A guest's ultimate, delivered in the host's world, damage worked out here from their ledger.
   * Their meter is theirs and cannot be checked, so the host holds them to the shortest time a full
   * meter can take (`ULT_MIN_GAP_SECONDS`).
   */
  applyUltimate(from, m) {
    if (run.phase !== 'playing' || !ROLES.some((r) => r.key === m.role) || !this.remotes.has(from)) return;
    const now = performance.now() / 1000;
    if (now - (this.lastUltimate.get(from) ?? -Infinity) < ULT_MIN_GAP_SECONDS) return;
    const vec = (a) => (Array.isArray(a) && finite(a[0], a[1], a[2]) ? new Vector3(a[0], a[1], a[2]) : null);
    const origin = vec(m.o);
    const at = vec(m.f);
    const direction = vec(m.d);
    if (!origin || !at || !direction || direction.lengthSq() < 1e-6) return;
    const grade = ['perfect', 'good', 'miss'].includes(m.g) ? m.g : 'miss';
    const bandSystem = this.world.getSystem(BandSystem);
    if (!bandSystem) return;
    this.lastUltimate.set(from, now);
    const ledger = this.ledgerFor(from);
    const damage = ultimateDamage(bandSystem.hitFor(m.role, ledger.weapon), m.role, grade);
    // An aura goes where the guest goes: read their body as it moves, until they leave.
    const follow = () => this.remotes.get(from)?.group.position ?? null;
    bandSystem.deliverUltimate(m.role, origin, at, direction.normalize(), damage, grade, from, follow);
    performUltimate(this.remotes.get(from), m.role, ULTIMATES[m.role].shape.seconds ?? 0);
  }

  indexActors() {
    this.byIndex.clear();
    for (const entity of this.queries.actors.entities) {
      const index = entity.object3D?.userData.spawnIndex;
      if (index !== undefined) this.byIndex.set(index, entity);
    }
  }

  /** Remote players on this level and heard from lately: who the host's zombies can go for. */
  livePlayers() {
    const now = performance.now();
    const out = [];
    for (const [id, remote] of this.remotes) {
      if (remote.level !== run.levelKey || now - remote.heardAt > STALE_MS) continue;
      out.push({ id, position: remote.target });
    }
    return out;
  }

  // ── remote players' bodies ──────────────────────────────────────────────────────────────────

  newRemote(peer) {
    const remote = createAvatar(this.scene, { id: peer.id, name: peer.name, seat: peer.seat });
    remote.level = null;
    remote.heardAt = 0;
    return remote;
  }

  dropRemote(id) {
    const remote = this.remotes.get(id);
    if (remote) disposeAvatar(remote);
    this.remotes.delete(id);
    band.remoteRoles.delete(id);
  }

  clearRemotes() {
    for (const id of [...this.remotes.keys()]) this.dropRemote(id);
  }

  // ── the room panel on the start screen, and the status line in play ─────────────────────────

  buildJoinPanel() {
    const card = document.querySelector('#menu .card');
    if (!card) return;
    const panel = document.createElement('div');
    Object.assign(panel.style, {
      margin: '18px 0 0', padding: '14px', borderRadius: '12px', border: '1px solid #334155', display: 'grid', gap: '8px',
    });
    panel.innerHTML = `
      <div style="font-weight:600">Play together</div>
      <div style="font-size:13px;color:#94a3b8">Everyone who types the same room name is in the same band. Up to six.</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <input data-room placeholder="Room name" maxlength="24" style="flex:1;min-width:120px;padding:10px;border-radius:8px;border:1px solid #334155;background:#0b1020;color:inherit;font:inherit">
        <input data-name placeholder="Your name" maxlength="20" style="flex:1;min-width:120px;padding:10px;border-radius:8px;border:1px solid #334155;background:#0b1020;color:inherit;font:inherit">
      </div>
      <div style="display:flex;gap:8px">
        <button type="button" data-join style="text-align:center;flex:1">Join room</button>
        <button type="button" data-leave style="text-align:center" hidden>Leave</button>
      </div>
      <div data-status style="font-size:13px;color:#cbd5e1">Playing alone.</div>`;
    const vr = card.querySelector('[data-vr]');
    card.insertBefore(panel, vr ?? null);
    const params = new URLSearchParams(location.search);
    panel.querySelector('[data-room]').value = params.get('room') ?? '';
    panel.querySelector('[data-name]').value = params.get('name') ?? this.defaultName();
    panel.querySelector('[data-join]').addEventListener('click', () => {
      void this.join(panel.querySelector('[data-room]').value, panel.querySelector('[data-name]').value.trim());
    });
    panel.querySelector('[data-leave]').addEventListener('click', () => this.leave());
    this.joinPanel = panel;
  }

  setJoinStatus(text) {
    if (!this.joinPanel) return;
    this.joinPanel.querySelector('[data-status]').textContent = text;
    const inRoom = this.client.connected;
    this.joinPanel.querySelector('[data-leave]').hidden = !inRoom;
    this.joinPanel.querySelector('[data-join]').textContent = inRoom ? 'Switch room' : 'Join room';
  }

  buildStatus() {
    const el = document.createElement('div');
    Object.assign(el.style, {
      position: 'fixed', top: '12px', right: '12px', zIndex: '30', padding: '6px 12px', borderRadius: '999px',
      background: 'rgba(12,8,24,0.72)', color: '#f5f0ff', font: '600 12px system-ui, sans-serif', pointerEvents: 'none',
    });
    el.hidden = true;
    document.body.appendChild(el);
    this.status = el;
    this.cleanupFuncs.push(() => el.remove());
  }

  drawStatus() {
    if (!this.status) return;
    this.status.hidden = !this.client.connected;
    if (this.status.hidden) return;
    const names = [...this.remotes.values()].map((r) => r.name);
    this.status.textContent = `Room ${this.client.room} · ${names.length + 1} in the band${this.client.isHost ? ' · hosting' : ''}`
      + (names.length ? ` · with ${names.join(', ')}` : '');
  }
}

const round = (value, places = 2) => {
  const f = 10 ** places;
  return Math.round(value * f) / f;
};

const finite = (...values) => values.every((v) => typeof v === 'number' && Number.isFinite(v));
