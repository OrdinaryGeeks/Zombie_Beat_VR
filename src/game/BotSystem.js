import { Vector3, createSystem } from '@iwsdk/core';
import { Actor } from '../components.js';
import { GAME } from '../content/game.js';
import { factionOf } from '../rules.js';
import { emit, on, run } from '../state.js';
import { LevelSystem } from '../systems/LevelSystem.js';
import { PlayerSystem } from '../systems/PlayerSystem.js';
import { animateAvatar, createAvatar, disposeAvatar, placeAvatar, setAvatarRole } from './avatar.js';
import { band } from './band.js';
import { BandSystem } from './BandSystem.js';
import { hurt, newLedger, seatSpot } from './ledger.js';
import {
  BOT_NAMES, MAX_BAND, WAVE_REACH, botCount, botRoles, botSeats, botSwingsOn, roleByKey,
} from './rules.js';

/** How far from its spot a CPU bandmate looks for a zombie, and how far it will chase one. */
const GUARD_METRES = 12;
const LEASH_METRES = 9;
const SPEED = 3.2;
const DOWN_SECONDS = 6;
const SETTING_KEY = 'zb:cpu';
const huntCentre = new Vector3();

const toTarget = new Vector3();

/**
 * CPU bandmates: computer-played members of the band, in a solo game or beside other players.
 *
 * Choose how many at Band HQ (under The Band and Boards, or a row on the headset panel; `HqSystem`
 * moves this system's control in), or press C in play (0 to 5; a band is six at most, players
 * included). They take the roles nobody is playing (a solo guitarist gets a drummer, a singer and a
 * dancer first), each in a seat of its own, so each has its own body from the cast.
 *
 * ## What they do
 *
 * Guard the stage. A bandmate goes for the nearest zombie within 12 m of its spot, chases no further
 * than 9 m from it, and otherwise walks back and plays. It swings only on the beat, every other
 * beat, alternating with its neighbours, with the same role shapes and damage rules a player has
 * (`BandSystem.deliver` / `damageFor`) and the starting weapon. Zombies go for bandmates as they go
 * for players (they are in `world.net.players()`); one knocked down lies there for a few seconds and
 * gets back up at its spot. They pick nothing up, and their kills' XP and gold go to the host.
 *
 * ## Who runs them
 *
 * Whoever runs the zombies: the solo player, or the host when playing together. The host's count is
 * the one that counts; its bandmates go out in the world snapshot (`snapshot` → `applyRemote`), and
 * every guest draws them, swings and all, without deciding anything.
 */
export class BotSystem extends createSystem({
  actors: { required: [Actor] },
}) {
  init() {
    /** id → bandmate. On a guest, the host's, as last reported. */
    this.bots = new Map();
    this.wanted = readSetting();

    this.cleanupFuncs.push(
      on('level-start', () => this.rebuild(true)),
      on('level-loading', () => this.clear()),
    );
    this.buildMenuControl();
    this.buildButton();
  }

  get authority() {
    return !this.world.net?.follower;
  }

  setWanted(count) {
    this.wanted = Math.max(0, Math.min(MAX_BAND - 1, count));
    writeSetting(this.wanted);
    this.drawControls();
    if (run.phase === 'playing' && this.authority) this.rebuild(false);
  }

  // ── who is in the band ──────────────────────────────────────────────────────────────────────

  /** The players in the band, for roles and seats: this one, and everyone else in the room. */
  humans() {
    const roles = [band.role];
    const seats = [band.seat];
    for (const [id, role] of band.remoteRoles) if (!id.startsWith('cpu:')) roles.push(role);
    for (const peer of this.world.net?.peers?.() ?? []) seats.push(peer.seat);
    return { roles, seats: [...new Set(seats)], count: Math.max(1, new Set(seats).size) };
  }

  /**
   * Makes the band the right size. `fresh` (a new level) puts everyone back on their spot at full
   * health; otherwise bandmates already playing stay where they are.
   */
  rebuild(fresh) {
    if (!this.authority || !band.staged) return;
    const humans = this.humans();
    const count = botCount(this.wanted, humans.count);
    const roles = botRoles(humans.roles, count);
    const seats = botSeats(humans.seats, count);
    for (const [id, bot] of this.bots) {
      if (bot.index >= count) {
        disposeAvatar(bot.avatar);
        band.remoteRoles.delete(id);
        this.bots.delete(id);
      }
    }
    for (let index = 0; index < count; index++) {
      const id = `cpu:${index}`;
      let bot = this.bots.get(id);
      if (!bot || bot.seat !== seats[index]) {
        if (bot) disposeAvatar(bot.avatar);
        bot = this.newBot(index, seats[index]);
        this.bots.set(id, bot);
        fresh = true;
      }
      if (bot.role !== roles[index]) {
        bot.role = roles[index];
        setAvatarRole(bot.avatar, bot.role);
      }
      band.remoteRoles.set(id, bot.role);
      if (fresh) this.sendHome(bot, true);
    }
  }

  newBot(index, seat) {
    const name = `${BOT_NAMES[index % BOT_NAMES.length]} (CPU)`;
    const bot = {
      id: `cpu:${index}`, index, seat, name, role: null,
      ledger: newLedger(GAME.player),
      position: new Vector3(), ry: 0, moving: false, down: 0, cooldown: 0, lastBeat: -1, swings: 0,
      avatar: createAvatar(this.scene, { id: `cpu:${index}`, name, seat }),
    };
    return bot;
  }

  spotOf(bot) {
    const role = roleByKey(bot.role);
    const spot = seatSpot(bot.seat);
    // On a hunt there is no stage to guard: the band forms up around the player and goes with them.
    const centre = band.hunt ? this.world.getSystem(PlayerSystem).getFeet(huntCentre) : band.centre;
    const x = centre.x + role.seat.x + spot.x;
    const z = centre.z + role.seat.z + spot.z;
    const level = this.world.getSystem(LevelSystem);
    return new Vector3(x, level ? level.groundHeight(x, z, band.centre.y) : band.centre.y, z);
  }

  sendHome(bot, healed) {
    bot.position.copy(this.spotOf(bot));
    bot.ry = Math.atan2(band.centre.x - bot.position.x, band.centre.z - bot.position.z) || Math.PI;
    if (healed) {
      bot.ledger.hp = bot.ledger.maxHp;
      bot.down = 0;
    }
    placeAvatar(bot.avatar, bot.position, bot.ry);
  }

  clear() {
    for (const [id, bot] of this.bots) {
      disposeAvatar(bot.avatar);
      band.remoteRoles.delete(id);
    }
    this.bots.clear();
  }

  // ── for the zombies and the host ────────────────────────────────────────────────────────────

  /** Bandmates the zombies can go for: up, and on this level. */
  targets() {
    if (!this.authority || run.phase !== 'playing') return [];
    const out = [];
    for (const bot of this.bots.values()) if (!bot.down) out.push({ id: bot.id, position: bot.position, collects: false });
    return out;
  }

  hit(id, damage) {
    const bot = this.bots.get(id);
    if (!bot || bot.down || !this.authority) return;
    const { died } = hurt(bot.ledger, damage, GAME.player.mitigation);
    if (!died) return;
    bot.down = DOWN_SECONDS;
    emit('message', { text: `${bot.name} is down!`, tone: 'bad', shared: true });
  }

  /** For the guests: every bandmate, compact. */
  snapshot() {
    const r = (v, p = 2) => Math.round(v * 10 ** p) / 10 ** p;
    return [...this.bots.values()].map((b) => [
      b.index, b.seat, b.role, r(b.position.x), r(b.position.y), r(b.position.z), r(b.ry, 3),
      b.moving ? 1 : 0, b.swings, b.down > 0 ? 1 : 0,
    ]);
  }

  /** A guest drawing the host's bandmates. Their swings are drawn here too; the host lands them. */
  applyRemote(rows) {
    if (this.authority || !Array.isArray(rows)) return;
    const present = new Set();
    for (const row of rows) {
      if (!Array.isArray(row) || row.length < 10) continue;
      const [index, seat, role, x, y, z, ry, moving, swings, down] = row;
      if (![index, seat, x, y, z, ry].every(Number.isFinite) || !roleByKey(role) || roleByKey(role).key !== role) continue;
      const id = `cpu:${index}`;
      present.add(id);
      let bot = this.bots.get(id);
      if (!bot || bot.seat !== seat) {
        if (bot) disposeAvatar(bot.avatar);
        bot = this.newBot(index, seat);
        this.bots.set(id, bot);
        bot.swings = swings;
        placeAvatar(bot.avatar, new Vector3(x, y, z), ry);
      }
      bot.role = role;
      setAvatarRole(bot.avatar, role);
      band.remoteRoles.set(id, role);
      bot.position.set(x, y, z);
      bot.ry = ry;
      bot.moving = moving === 1;
      bot.down = down === 1 ? 1 : 0;
      if (swings > bot.swings) {
        bot.swings = swings;
        // The whole swing as the host draws it — a singer's bolt flies here too — at no damage.
        const direction = new Vector3(Math.sin(ry), 0, Math.cos(ry));
        const origin = bot.position.clone();
        origin.y += 1.3;
        this.world.getSystem(BandSystem)?.deliver(role, origin, bot.position.clone(), direction, 0, 'perfect', null, bot.ledger.weapon);
      }
    }
    for (const [id, bot] of this.bots) {
      if (present.has(id)) continue;
      disposeAvatar(bot.avatar);
      band.remoteRoles.delete(id);
      this.bots.delete(id);
    }
  }

  // ── frame ───────────────────────────────────────────────────────────────────────────────────

  update(delta) {
    if (this.input.keyboard.getKeyDown('KeyC') && run.phase === 'playing' && this.authority) {
      this.setWanted((this.wanted + 1) % MAX_BAND);
    }
    this.button.hidden = run.phase !== 'playing';
    // Every frame, menu included: whether this player may choose changes as they join and leave rooms.
    this.drawControls();
    if (run.phase !== 'playing') {
      for (const bot of this.bots.values()) animateAvatar(bot.avatar, delta, false);
      return;
    }
    // Players come and go and change roles; the band follows, a couple of times a second.
    this.resizeIn = (this.resizeIn ?? 0) - delta;
    if (this.authority && this.resizeIn <= 0) {
      this.resizeIn = 0.5;
      this.rebuild(false);
    }
    for (const bot of this.bots.values()) {
      if (this.authority) this.think(bot, delta);
      bot.avatar.target.copy(bot.position);
      bot.avatar.targetRy = bot.ry;
      bot.avatar.moving = bot.moving;
      bot.avatar.down = bot.down > 0;
      animateAvatar(bot.avatar, delta, true);
    }
  }

  think(bot, delta) {
    bot.cooldown = Math.max(0, bot.cooldown - delta);
    bot.moving = false;
    if (bot.down > 0) {
      bot.down -= delta;
      if (bot.down <= 0) {
        this.sendHome(bot, true);
        emit('message', { text: `${bot.name} is back up.`, tone: 'good', shared: true });
      }
      return;
    }

    const role = roleByKey(bot.role);
    const reach = WAVE_REACH[role.wave] ?? 3;
    const spot = this.spotOf(bot);
    const target = this.nearestZombie(spot);

    let goal = null;
    if (target) {
      toTarget.subVectors(target.object3D.position, bot.position).setY(0);
      const distance = toTarget.length();
      bot.ry = Math.atan2(toTarget.x, toTarget.z);
      if (distance > reach * 0.85) goal = target.object3D.position;
      else this.swing(bot, role, toTarget.normalize());
    } else if (bot.position.distanceTo(spot) > 0.4) {
      goal = spot;
    }

    if (goal) {
      toTarget.subVectors(goal, bot.position).setY(0);
      const distance = toTarget.length();
      const step = Math.min(distance, SPEED * delta);
      const next = bot.position.clone().addScaledVector(toTarget.normalize(), step);
      // On a leash to its spot: it guards the stage, it does not go on a hunt.
      if (goal === spot || next.distanceTo(spot) <= LEASH_METRES) {
        bot.position.copy(next);
        const level = this.world.getSystem(LevelSystem);
        if (level) bot.position.y = level.groundHeight(bot.position.x, bot.position.z, bot.position.y);
        bot.moving = step > 0.001;
        if (goal === spot) bot.ry = Math.atan2(toTarget.x, toTarget.z);
      }
    }
  }

  nearestZombie(spot) {
    let best = null;
    let bestDistance = GUARD_METRES;
    for (const entity of this.queries.actors.entities) {
      if (entity.getValue(Actor, 'state') === 'dead') continue;
      const row = entity.object3D?.userData.entity;
      if (!row || factionOf(row.role) !== 'hostile') continue;
      const p = entity.object3D.position;
      const distance = Math.hypot(p.x - spot.x, p.z - spot.z);
      if (distance < bestDistance) {
        best = entity;
        bestDistance = distance;
      }
    }
    return best;
  }

  swing(bot, role, direction) {
    const { beat, phase } = band.clock.at(band.beatTime);
    if (bot.cooldown > 0 || !botSwingsOn(beat, phase, bot.index, bot.lastBeat)) return;
    bot.lastBeat = beat;
    bot.cooldown = 0.38;
    bot.swings += 1;
    const bandSystem = this.world.getSystem(BandSystem);
    if (!bandSystem) return;
    // A good drummer, not a perfect one.
    const grade = Math.random() < 0.75 ? 'perfect' : 'good';
    const origin = bot.position.clone();
    origin.y += 1.3;
    const damage = bandSystem.damageFor(role.key, bot.ledger.weapon, grade);
    bandSystem.deliver(role.key, origin, bot.position.clone(), direction, damage, grade, bot.id, bot.ledger.weapon);
  }

  // ── the controls ────────────────────────────────────────────────────────────────────────────

  buildMenuControl() {
    const card = document.querySelector('#menu .card');
    if (!card) return;
    const row = document.createElement('div');
    Object.assign(row.style, {
      margin: '14px 0 0', display: 'flex', alignItems: 'center', gap: '10px', justifyContent: 'space-between',
      padding: '10px 14px', borderRadius: '12px', border: '1px solid #334155',
    });
    row.innerHTML = `
      <div><div style="font-weight:600">CPU bandmates</div>
        <div data-cpu-note style="font-size:13px;color:#94a3b8">They take the roles nobody is playing.</div></div>
      <div style="display:flex;align-items:center;gap:8px">
        <button type="button" data-cpu-less style="text-align:center;width:40px">−</button>
        <b data-cpu-count style="min-width:1.5em;text-align:center"></b>
        <button type="button" data-cpu-more style="text-align:center;width:40px">+</button>
      </div>`;
    const levels = card.querySelector('[data-levels]');
    card.insertBefore(row, levels ?? null);
    row.querySelector('[data-cpu-less]').addEventListener('click', () => this.setWanted(this.wanted - 1));
    row.querySelector('[data-cpu-more]').addEventListener('click', () => this.setWanted(this.wanted + 1));
    this.menuRow = row;
    this.drawControls();
  }

  buildButton() {
    const button = document.createElement('button');
    button.type = 'button';
    Object.assign(button.style, {
      position: 'fixed', right: '12px', top: '44px', zIndex: '30', padding: '6px 12px', borderRadius: '999px',
      border: '1px solid #9b6bff', background: 'rgba(12,8,24,0.72)', color: '#f5f0ff',
      font: '600 12px system-ui, sans-serif', cursor: 'pointer',
    });
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      if (this.authority) this.setWanted((this.wanted + 1) % MAX_BAND);
    });
    button.hidden = true;
    document.body.appendChild(button);
    this.button = button;
    this.cleanupFuncs.push(() => button.remove());
  }

  drawControls() {
    const guest = !this.authority;
    const key = `${guest}|${this.wanted}|${this.bots.size}`;
    if (key === this.controlsKey) return;
    this.controlsKey = key;
    const label = guest ? `CPU bandmates: ${this.bots.size} (host's choice)` : `CPU bandmates: ${this.wanted} (C)`;
    if (this.button && this.button.textContent !== label) this.button.textContent = label;
    if (this.button) this.button.style.cursor = guest ? 'default' : 'pointer';
    if (!this.menuRow) return;
    this.menuRow.querySelector('[data-cpu-count]').textContent = String(this.wanted);
    this.menuRow.querySelector('[data-cpu-less]').disabled = guest || this.wanted <= 0;
    this.menuRow.querySelector('[data-cpu-more]').disabled = guest || this.wanted >= MAX_BAND - 1;
    this.menuRow.querySelector('[data-cpu-note]').textContent = guest
      ? 'In someone else\'s room the host chooses.'
      : 'They take the roles nobody is playing.';
  }
}

function readSetting() {
  try {
    const value = Number(localStorage.getItem(SETTING_KEY));
    return Number.isFinite(value) ? Math.max(0, Math.min(MAX_BAND - 1, value)) : 0;
  } catch {
    return 0;
  }
}

function writeSetting(value) {
  try {
    localStorage.setItem(SETTING_KEY, String(value));
  } catch {
    // Private window: the choice lasts this session only.
  }
}
