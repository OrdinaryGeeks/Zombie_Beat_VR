import { CanvasTexture, InputComponent, Mesh, MeshBasicMaterial, PlaneGeometry, SRGBColorSpace, createSystem } from '@iwsdk/core';
import { ASSETS } from '../content/assets.js';
import { GAME } from '../content/game.js';
import { handicapStep, xpToNext } from '../rules.js';
import { emit, on, run } from '../state.js';
import { LevelSystem } from '../systems/LevelSystem.js';
import { band } from './band.js';
import { BandSystem } from './BandSystem.js';
import { BotSystem } from './BotSystem.js';
import { NetSystem } from './NetSystem.js';
import { MAX_BAND, ROLES, isHuntBoard, roleByKey } from './rules.js';
import {
  ATTRIBUTES, DIFFICULTY_COLORS, MAX_CHARACTERS, POINTS_PER_LEVEL, RARITY_COLORS, ROLE_ICONS, active, allocate, buy,
  characterStats, createCharacter, difficulty, equip, handicapLine, isStock, itemIcon, loadSave, pointsUnspent, price, requiredLevel,
  retireCharacter, selectCharacter, suggestName, train, trainCost, unequip, whyNot, writeSave,
} from './roster.js';

/** Seconds between saves while a board is being played. */
const SAVE_EVERY = 5;
const hex = (colour) => `#${colour.toString(16).padStart(6, '0')}`;

/** The coins' key in `run.currencies`: the game's first currency, as the arcade's shop uses. */
const COIN = Object.values(GAME.loot).find((i) => i.lootType === 'currency' && i.currencyCode)?.currencyCode ?? 'gold';

/** A sprite's URL in this export, or null when it was not carried (it then draws without one). */
const spriteUrl = (name) => {
  const path = ASSETS.textures?.[`SYNTYTEXTURES/${name}.png`];
  return path ? `./${path}` : null;
};

/**
 * Band HQ: the roster, the stats, the merch stand and the boards — before the first board and after
 * every one — and the character card while one is played.
 *
 * ## Progress is kept on this device
 *
 * The roster (`roster.js`) is saved in `localStorage`: each character's level, XP, stat points and
 * what they wear, the band's coins, and the stash. It is applied to the template's `run` before
 * every board (health, weapon, armour, level) and read back from it while the board is played (XP,
 * levels, coins, gear picked up), so the rest of the game needs no idea that characters exist.
 *
 * Playing together, a guest's stats are the host's to keep (`ledger.js`), so a guest's roster sets
 * their role and is not written to while they play in someone else's room.
 *
 * ## Two ways to use it
 *
 * On a flat screen, an HTML screen. In a headset, where HTML is not drawn, a panel in front of the
 * player: thumbstick left and right for the tab, up and down for the row, trigger to choose. Both
 * act through `act()`, so they cannot do different things.
 *
 * The template's own start screen and its move-on-after-a-level are switched off through
 * `world.flow` (see `ProgressSystem` and `HudSystem`), so what it carried moves in here: the CPU
 * bandmates count (`BotSystem`) and the "Play together" box (`NetSystem`), under The Band and Boards.
 */
export class HqSystem extends createSystem({}) {
  init() {
    this.save = loadSave(globalThis.localStorage, GAME.meta.slug);
    run.handicap = Math.min(this.save.handicap ?? 0, GAME.handicap?.max ?? 0);
    this.open = false;
    this.mode = 'start';
    this.tab = 'band';
    this.focus = 0;
    this.creating = this.save.characters.length === 0;
    this.newRole = ROLES[0].key;
    this.newName = suggestName(this.newRole, this.save.characters.map((c) => c.name), Date.now());
    this.nameTyped = false;
    this.retiring = '';
    this.message = null;
    this.result = null;
    this.board = GAME.player.startLevelKey ?? [...GAME.levels].sort((a, b) => a.ordinal - b.ordinal)[0]?.key ?? null;
    this.saveIn = SAVE_EVERY;
    this.cardKey = '';
    this.panelKey = '';

    this.world.flow = {
      ownsMenu: true,
      onLevelEnd: (level, status) => this.betweenBoards(level, status),
    };
    band.rosterLocked = true;
    this.world.getSystem(BandSystem)?.drawPicker();

    // XP: the active character's Showmanship on everything this player earns, and a level-up saved.
    const gainXp = run.gainXp.bind(run);
    run.gainXp = (amount) => {
      const before = run.playerLevel;
      const mine = !this.world.net?.follower;
      gainXp(mine ? amount * this.stats().xpMultiplier : amount);
      if (mine && run.playerLevel !== before) this.levelledUp();
    };

    // A returning player's character is who they are from the first frame, menu included.
    this.applyCharacter();
    this.buildStyle();
    this.buildScreen();
    this.buildCard();
    this.buildPanel();

    this.cleanupFuncs.push(
      on('pickup', ({ lootKey }) => this.pickedUp(lootKey)),
      on('level-start', () => {
        // A guest following the host into a board leaves HQ for it.
        if (this.open) this.close();
        this.applyCharacter();
      }),
    );
    const store = () => this.persist();
    window.addEventListener('pagehide', store);
    this.cleanupFuncs.push(() => window.removeEventListener('pagehide', store));

    this.openHq('start');
  }

  // ── the roster and the run ──────────────────────────────────────────────────────────────────

  character() {
    return active(this.save);
  }

  stats() {
    const c = this.character();
    return c ? characterStats(c, GAME) : { maxHealth: run.maxHealth, mitigation: run.mitigation, weapon: run.weapon, xpMultiplier: 1 };
  }

  /** Puts the active character into `run`: who they are, what they swing and what stops a hit. */
  applyCharacter() {
    const c = this.character();
    if (!c) return;
    void this.world.getSystem(BandSystem)?.setRole(c.role, c.role === band.role);
    if (this.world.net?.follower) return;
    const stats = characterStats(c, GAME);
    run.playerLevel = c.level;
    run.xp = c.xp;
    const full = run.health >= run.maxHealth || run.phase !== 'playing';
    run.maxHealth = stats.maxHealth;
    run.health = full ? stats.maxHealth : Math.min(run.health, stats.maxHealth);
    run.mitigation = stats.mitigation;
    run.weapon = { ...stats.weapon };
    run.currencies = { [COIN]: this.save.coins };
    for (const [key, quantity] of Object.entries(this.save.stash)) {
      run.inventory.set(key, Math.max(run.inventory.get(key) ?? 0, quantity));
    }
    this.cardKey = '';
  }

  /** Reads what a board changed back into the roster: XP, level, coins. */
  syncFromRun() {
    const c = this.character();
    if (!c || this.world.net?.follower) return;
    c.level = run.playerLevel;
    c.xp = run.xp;
    this.save.coins = Math.floor(Object.values(run.currencies).reduce((sum, n) => sum + (Number(n) || 0), 0));
  }

  persist() {
    if (this.world.net?.follower) return;
    if (run.phase === 'playing') this.syncFromRun();
    writeSave(globalThis.localStorage, GAME.meta.slug, this.save);
  }

  levelledUp() {
    this.syncFromRun();
    const c = this.character();
    const stats = characterStats(c, GAME);
    run.maxHealth = stats.maxHealth;
    run.health = stats.maxHealth;
    run.mitigation = stats.mitigation;
    emit('message', { text: `+${POINTS_PER_LEVEL} stat points — spend them at Band HQ.`, tone: 'good' });
    this.persist();
  }

  /** Gear picked up goes in the stash; a better instrument than the one worn is worn from now on. */
  pickedUp(lootKey) {
    if (this.world.net?.follower) return;
    const item = GAME.loot[lootKey];
    const c = this.character();
    if (item && isStock(item) && c) {
      this.save.stash[item.key] = Math.max(1, this.save.stash[item.key] ?? 0);
      const worn = GAME.loot[c.loadout.main_hand];
      const baseDps = worn?.dps > 0 ? worn.dps : GAME.player.dps;
      if (item.lootType === 'weapon' && item.slot === 'main_hand' && item.dps > baseDps) {
        c.loadout.main_hand = item.key;
        emit('message', { text: `${c.name} plays ${item.name} from now on.`, tone: 'good' });
      }
      // The template may have equipped it with no Power on top; the character's numbers win.
      const stats = characterStats(c, GAME);
      run.weapon = { ...stats.weapon };
      run.mitigation = stats.mitigation;
    }
    this.syncFromRun();
    this.persist();
  }

  // ── opening and closing ─────────────────────────────────────────────────────────────────────

  betweenBoards(level, status) {
    this.syncFromRun();
    this.persist();
    this.result = { level, status };
    const next = status === 'won' ? this.nextBoard(level) : level.key;
    if (next) this.board = next;
    this.openHq('between');
  }

  nextBoard(level) {
    const after = [...GAME.levels].sort((a, b) => a.ordinal - b.ordinal).filter((l) => l.ordinal > level.ordinal);
    return level.next ?? after[0]?.key ?? level.key;
  }

  openHq(mode) {
    this.mode = mode;
    this.open = true;
    run.phase = 'menu';
    const c = this.character();
    this.creating = !c;
    this.tab = !c || mode === 'start' ? 'band' : pointsUnspent(c) > 0 ? 'stats' : 'boards';
    this.focus = 0;
    this.message = null;
    this.screen.hidden = false;
    this.draw();
  }

  close() {
    this.open = false;
    this.screen.hidden = true;
    this.result = null;
  }

  play() {
    const c = this.character();
    if (!c || !this.board) return;
    this.persist();
    this.close();
    this.applyCharacter();
    // A guest in a room goes where the host is; asking for a board tells the host which they want.
    void this.world.getSystem(LevelSystem).load(this.board).catch((err) => {
      console.error(err);
      emit('message', { text: 'Could not load that board.', tone: 'bad' });
      this.openHq(this.mode);
    });
  }

  // ── acting: both screens come through here ──────────────────────────────────────────────────

  act(act, arg = '') {
    const say = (error, success) => {
      this.message = error ? { text: error, tone: 'bad' } : success ? { text: success, tone: 'good' } : null;
    };
    const item = GAME.loot[arg];
    switch (act) {
      case 'tab':
        this.tab = arg;
        this.focus = 0;
        this.retiring = '';
        break;
      case 'new':
        this.creating = true;
        this.nameTyped = false;
        this.newName = suggestName(this.newRole, this.save.characters.map((c) => c.name), Date.now());
        break;
      case 'cancel-new':
        this.creating = false;
        break;
      case 'role':
        this.newRole = arg;
        if (!this.nameTyped || !this.newName.trim()) this.newName = suggestName(arg, this.save.characters.map((c) => c.name), Date.now());
        break;
      case 'create': {
        // In a headset there is no keyboard: the panel creates with the suggested name.
        const role = arg || this.newRole;
        const name = arg ? suggestName(role, this.save.characters.map((c) => c.name), Date.now()) : this.newName;
        const error = createCharacter(this.save, name, role, 1);
        say(error, `${name.trim()} joined the band.`);
        if (!error) {
          this.creating = false;
          this.applyCharacter();
        }
        break;
      }
      case 'select': {
        this.syncFromRun();
        const error = selectCharacter(this.save, arg);
        say(error, `${this.character()?.name} takes the stage.`);
        if (!error) this.applyCharacter();
        break;
      }
      case 'retire':
        if (this.retiring !== arg) {
          this.retiring = arg;
          break;
        }
        say(retireCharacter(this.save, arg), 'They left the band.');
        this.retiring = '';
        break;
      case 'allocate':
        say(allocate(this.save, arg));
        this.applyCharacter();
        break;
      case 'train':
        say(train(this.save, arg), `Trained ${ATTRIBUTES.find((a) => a.stat === arg)?.label}.`);
        this.applyCharacter();
        break;
      case 'buy':
        say(buy(this.save, item), item ? `Bought ${item.name} — it is in the stash.` : null);
        this.applyCharacter();
        break;
      case 'equip':
        say(equip(this.save, item), item ? `${this.character()?.name} is wearing ${item.name}.` : null);
        this.applyCharacter();
        break;
      case 'unequip':
        say(unequip(this.save, item));
        this.applyCharacter();
        break;
      case 'board':
        this.board = arg;
        break;
      case 'handicap':
        // A guest plays the host's fight; read when the next board loads (`LevelSystem.spawnActor`).
        if (this.world.net?.follower) break;
        run.handicap = Math.max(0, Math.min(GAME.handicap?.max ?? 0, run.handicap + Number(arg)));
        this.save.handicap = run.handicap;
        break;
      case 'play':
        this.play();
        return;
      case 'vr':
        this.world.launchXR();
        return;
      case 'cpu': {
        const bots = this.world.getSystem(BotSystem);
        if (bots?.authority) bots.setWanted((bots.wanted + 1) % MAX_BAND);
        break;
      }
    }
    if (!this.world.net?.follower) writeSave(globalThis.localStorage, GAME.meta.slug, this.save);
    this.draw();
  }

  // ── frame ───────────────────────────────────────────────────────────────────────────────────

  update(delta) {
    // What the band reads to pick the active character's instrument (`BandSystem.watchMainHand`).
    band.mainHand = this.character()?.loadout?.main_hand ?? null;
    const immersive = Boolean(this.world.session);
    if (this.open && immersive) this.panelInput();
    this.panel.visible = this.open && immersive;
    if (this.panel.visible) this.drawPanel();

    if (run.phase === 'playing') {
      this.saveIn -= delta;
      if (this.saveIn <= 0) {
        this.saveIn = SAVE_EVERY;
        this.persist();
      }
    }
    this.drawCard();
  }

  // ── the flat screen ─────────────────────────────────────────────────────────────────────────

  buildScreen() {
    const el = document.createElement('div');
    el.className = 'zb-hq';
    el.hidden = true;
    // Clicks and keys here are the screen's: not a swing, not the mouse grab, not a hotkey.
    el.addEventListener('pointerdown', (e) => e.stopPropagation());
    el.addEventListener('keydown', (e) => e.stopPropagation());
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const target = e.target.closest('[data-act]');
      if (target && !target.disabled) this.act(target.dataset.act, target.dataset.arg ?? '');
    });
    el.addEventListener('input', (e) => {
      if (e.target.dataset.field !== 'name') return;
      this.newName = e.target.value;
      this.nameTyped = true;
    });
    el.innerHTML = '<div class="zb-hq-inner zb-panel"><div data-view></div><div data-together class="zb-together"></div><div data-foot></div></div>';
    document.body.appendChild(el);
    this.screen = el;
    this.view = el.querySelector('[data-view]');
    this.together = el.querySelector('[data-together]');
    this.foot = el.querySelector('[data-foot]');
    // What the template's start screen carried, which is not shown: CPU bandmates and the room box.
    const cpu = this.world.getSystem(BotSystem)?.menuRow;
    if (cpu) this.together.appendChild(cpu);
    const join = this.world.getSystem(NetSystem)?.joinPanel;
    if (join) this.together.appendChild(join);
    this.vrSupported = false;
    navigator.xr?.isSessionSupported('immersive-vr').then((ok) => {
      this.vrSupported = ok;
      if (this.open) this.draw();
    }).catch(() => undefined);
    this.cleanupFuncs.push(() => el.remove());
  }

  draw() {
    if (!this.view) return;
    const c = this.character();
    const board = GAME.levels.find((l) => l.key === this.board);
    const tabs = [['band', 'The Band', 'ICON_Inventory_Backpack'], ['stats', 'Stats', 'ICON_Map_Star'], ['shop', 'Merch Stand', 'ICON_Map_GunShop'], ['boards', 'Boards', 'ICON_Map_Flag']];
    const focused = document.activeElement?.dataset?.field === 'name' ? document.activeElement.selectionStart : null;

    this.view.innerHTML = `
      <header class="zb-head"><div class="zb-hazard"></div><h1>BAND HQ</h1>
        ${c ? `<div class="zb-who">${tint(ROLE_ICONS[c.role], hex(roleByKey(c.role).color), 22)}<b>${esc(c.name)}</b> · LV ${c.level} ${esc(roleByKey(c.role).label)}</div>` : ''}
        <div class="zb-coins">${img('ICON_ZB_Coin_Encore', 30)}<b>${Math.floor(this.save.coins).toLocaleString()}</b></div></header>
      ${this.resultBanner()}
      <nav class="zb-tabs">${tabs.map(([key, label, icon]) => `
        <button type="button" data-act="tab" data-arg="${key}" class="zb-tab ${this.tab === key ? 'on' : ''}" ${!c && key !== 'band' ? 'disabled' : ''}>
          ${tint(icon, this.tab === key ? '#120c06' : '#f2e6d0', 18)}${label}
          ${key === 'stats' && c && pointsUnspent(c) > 0 ? `<span class="zb-pip">${pointsUnspent(c)}</span>` : ''}</button>`).join('')}</nav>
      ${this.message ? `<div class="zb-msg ${this.message.tone}">${esc(this.message.text)}</div>` : ''}
      <section class="zb-body">${this.body()}</section>`;
    // Drawn apart from the view so the boxes moved in between them (CPU bandmates, the room) survive.
    this.foot.innerHTML = `
      <footer class="zb-foot">
        <span class="zb-dim">WASD move · mouse look · click or F plays on the beat · E ultimate · T home</span>
        ${this.vrSupported ? '<button type="button" class="zb-btn ghost" data-act="vr">Enter VR</button>' : ''}
        <button type="button" class="zb-play" data-act="play" ${!c || !board ? 'disabled' : ''}>
          ${!c ? 'Make a character to play' : board ? `Play ▸ Board ${board.ordinal} · ${esc(board.name)}${run.handicap > 0 && !this.world.net?.follower ? ` · Handicap +${run.handicap}` : ''}` : 'Pick a board'}</button>
      </footer>`;
    this.together.hidden = this.tab !== 'boards' && this.tab !== 'band';

    if (focused !== null) {
      const input = this.view.querySelector('[data-field="name"]');
      input?.focus();
      input?.setSelectionRange(focused, focused);
    }
  }

  resultBanner() {
    if (this.mode !== 'between' || !this.result) return '';
    const won = this.result.status === 'won';
    const hunt = isHuntBoard(this.result.level, GAME.entities);
    const verdict = won ? (hunt ? 'BOSS DOWN!' : 'ENCORE!') : (hunt ? 'THE HUNT IS OVER' : 'THE HORDE GOT THROUGH');
    return `<div class="zb-result ${won ? 'won' : 'lost'}">${tint(won ? 'ICON_Map_Star' : 'ICON_Map_Skull', won ? '#7dffb0' : '#ff7d7d', 32)}
      <div><b>${verdict}</b> — ${esc(this.result.level.name)}</div></div>`;
  }

  body() {
    switch (this.tab) {
      case 'stats': return this.statsTab();
      case 'shop': return this.shopTab();
      case 'boards': return this.boardsTab();
      default: return this.bandTab();
    }
  }

  bandTab() {
    const characters = this.save.characters;
    if (this.creating || characters.length === 0) {
      const role = roleByKey(this.newRole);
      return `<div class="zb-create"><h2>${characters.length ? 'A new band member' : 'Form your band'}</h2>
        <p class="zb-dim">Pick what they play. A character keeps its level, its stats and its gear on this device — come back to them any time.</p>
        <div class="zb-roles">${ROLES.map((r) => `
          <button type="button" class="zb-role ${r.key === this.newRole ? 'on' : ''}" data-act="role" data-arg="${r.key}" style="--c:${hex(r.color)}">
            <div class="zb-portrait">${ring(hex(r.color))}${tint(ROLE_ICONS[r.key], hex(r.color), 40)}</div>
            <b>${r.label}</b><span>${esc(r.blurb)}</span></button>`).join('')}</div>
        <label class="zb-name">Stage name <input data-field="name" maxlength="24" value="${esc(this.newName)}"></label>
        <div class="zb-row"><button type="button" class="zb-btn big" data-act="create">Join the band as ${esc(role.label)}</button>
          ${characters.length ? '<button type="button" class="zb-btn ghost" data-act="cancel-new">Cancel</button>' : ''}</div></div>`;
    }
    return `<div class="zb-grid">${characters.map((c) => {
      const colour = hex(roleByKey(c.role).color);
      const isActive = c.id === this.save.activeId;
      const spent = ATTRIBUTES.filter((a) => (c.attributes[a.stat] ?? 0) > 0).map((a) => `${a.label} ${c.attributes[a.stat]}`).join(' · ');
      return `<div class="zb-char ${isActive ? 'on' : ''}">
        <div class="zb-portrait">${ring(colour)}${tint(ROLE_ICONS[c.role], colour, 40)}</div>
        <div class="zb-char-name">${esc(c.name)}</div><div class="zb-dim">LV ${c.level} · ${esc(roleByKey(c.role).label)}</div>
        ${bar(c.xp, xpToNext(c.level), '#5ab8ff', `${Math.floor(c.xp)} / ${xpToNext(c.level)} XP`)}
        <div class="zb-dim">${spent || 'No points spent yet'}</div>
        ${isActive
          ? `<div class="zb-tag">ON STAGE${pointsUnspent(c) ? ` · ${pointsUnspent(c)} pts to spend` : ''}</div>`
          : `<div class="zb-row"><button type="button" class="zb-btn" data-act="select" data-arg="${c.id}">Play as ${esc(c.name)}</button>
             <button type="button" class="zb-btn ghost" data-act="retire" data-arg="${c.id}">${this.retiring === c.id ? 'Sure?' : 'Retire'}</button></div>`}
      </div>`;
    }).join('')}
    ${characters.length < MAX_CHARACTERS ? `<button type="button" class="zb-char zb-add" data-act="new">${tint('ICON_Inventory_Backpack', '#f2e6d0', 44)}
      <b>New band member</b><span class="zb-dim">${characters.length} / ${MAX_CHARACTERS}</span></button>` : ''}</div>`;
  }

  statsTab() {
    const c = this.character();
    if (!c) return '';
    const s = characterStats(c, GAME);
    const cost = trainCost(c);
    return `<div class="zb-stat-head"><div><b>LV ${c.level}</b> ${bar(c.xp, xpToNext(c.level), '#5ab8ff', `${Math.floor(c.xp)} / ${xpToNext(c.level)} XP`)}</div>
        <div class="zb-points ${pointsUnspent(c) ? 'hot' : ''}"><b>${pointsUnspent(c)}</b> points to spend
        <span class="zb-dim">${POINTS_PER_LEVEL} per level · train more with coins</span></div></div>
      <div class="zb-vitals"><span>${img('ICON_Status_Health01', 22)} ${s.maxHealth} health</span>
        <span>${img('ICON_Inventory_Weapon', 22)} ${s.weapon.dps} dps</span>
        <span>${img('ICON_Status_Armor', 22)} ${Math.round(s.mitigation * 100)}% armour</span></div>
      ${ATTRIBUTES.map((a) => {
        const points = c.attributes[a.stat] ?? 0;
        const capped = points >= a.maxPoints;
        return `<div class="zb-attr">${img(a.icon, 44)}
          <div><b>${a.label}</b> <span class="zb-dim">+${a.perPointPct}% a point</span><div class="zb-dim">${a.blurb}</div>
            <div class="zb-pips">${pips(points, a.maxPoints)}</div></div>
          <div class="zb-attr-num"><b>${points}</b><span>+${a.perPointPct * points}%</span></div>
          <div class="zb-col"><button type="button" class="zb-btn" data-act="allocate" data-arg="${a.stat}" ${pointsUnspent(c) > 0 && !capped ? '' : 'disabled'}>+1 point</button>
            <button type="button" class="zb-btn ghost" data-act="train" data-arg="${a.stat}" ${cost !== null && !capped && this.save.coins >= cost ? '' : 'disabled'}>
              Train ${img('ICON_ZB_Coin_Encore', 18)} ${cost ?? '—'}</button></div></div>`;
      }).join('')}`;
  }

  shopTab() {
    const c = this.character();
    const worn = new Set(Object.values(c?.loadout ?? {}));
    const stock = Object.values(GAME.loot).filter(isStock).sort((a, b) => a.itemLevel - b.itemLevel);
    if (!stock.length) return '<div class="zb-dim zb-pad">Nothing on the stand today.</div>';
    return `<p class="zb-dim">Gear goes in the band's stash, and any member can wear it. What a character wears comes back with them.</p>
      <div class="zb-grid">${stock.map((item) => {
        const owned = (this.save.stash[item.key] ?? 0) > 0;
        const reasons = whyNot(this.save, item);
        const stat = item.dps ? `${Number(item.dps).toFixed(1)} dps` : item.armorValue ? `${Number(item.armorValue).toFixed(1)} armour` : '';
        return `<div class="zb-item" style="--r:${RARITY_COLORS[item.rarity] ?? '#cbd5e1'}">
          <div class="zb-item-icon">${img(itemIcon(item), 72)}</div><b>${esc(item.name)}</b>
          <div class="zb-dim">${esc(item.rarity)} · ${esc(String(item.slot).replace('_', ' '))}${stat ? ` · ${stat}` : ''}</div>
          <div class="zb-dim">needs LV ${requiredLevel(item)}</div>
          ${owned
            ? `<button type="button" class="zb-btn ${worn.has(item.key) ? 'ghost' : ''}" data-act="${worn.has(item.key) ? 'unequip' : 'equip'}" data-arg="${item.key}">${worn.has(item.key) ? 'Take off' : 'Wear'}</button>`
            : `<button type="button" class="zb-btn" data-act="buy" data-arg="${item.key}" ${reasons.length ? 'disabled' : ''}>${img('ICON_ZB_Coin_Encore', 18)} ${price(item).toLocaleString()}</button>
               ${reasons.length ? `<div class="zb-why">${esc(reasons.join(' '))}</div>` : ''}`}</div>`;
      }).join('')}</div>`;
  }

  boardsTab() {
    const c = this.character();
    const guest = Boolean(this.world.net?.follower);
    const max = GAME.handicap?.max ?? 0;
    // A guest's boards are the host's, at the host's handicap, which this machine is not told.
    const handicap = guest ? 0 : run.handicap;
    return `${guest ? '<p class="zb-dim">You are a guest in a room: the host picks the board, and you join them on it.</p>' : ''}
      ${max > 0 ? `<div class="zb-handicap"><b>Handicap</b>
        <button type="button" class="zb-btn ghost" data-act="handicap" data-arg="-1" ${!guest && handicap > 0 ? '' : 'disabled'}>−</button>
        <span class="zb-handicap-n">+${handicap}</span>
        <button type="button" class="zb-btn ghost" data-act="handicap" data-arg="1" ${!guest && handicap < max ? '' : 'disabled'}>+</button>
        <span class="zb-dim">${guest ? 'The host sets the handicap.' : esc(handicapLine(handicapStep(handicap)))}</span></div>` : ''}
      <div class="zb-boards">${[...GAME.levels].sort((a, b) => a.ordinal - b.ordinal).map((level) => {
        const pitch = difficulty(c?.level ?? 1, (level.recommendedPlayerLevel ?? 1) + handicap);
        return `<button type="button" class="zb-board ${level.key === this.board ? 'on' : ''}" data-act="board" data-arg="${level.key}">
          <div class="zb-flag">${level.ordinal}</div>
          <div><b>${esc(level.name)}</b><div class="zb-dim">${esc(level.description ?? '')}</div></div>
          <div class="zb-board-meta"><span style="color:${DIFFICULTY_COLORS[pitch]}">${pitch.toUpperCase()}</span>
            ${isHuntBoard(level, GAME.entities) ? '<span style="color:#ff4d6d">BOSS HUNT</span>' : ''}
            <span class="zb-dim">LV ${level.recommendedPlayerLevel ?? 1}${handicap > 0 ? ` +${handicap}` : ''}</span>
            ${run.wonLevels.has(level.key) ? `<span class="zb-won">${tint('ICON_Map_Star', '#ffe27d', 16)} cleared</span>` : ''}</div></button>`;
      }).join('')}</div>`;
  }

  // ── the card in play ────────────────────────────────────────────────────────────────────────

  buildCard() {
    const el = document.createElement('div');
    el.className = 'zb-card zb-panel';
    el.hidden = true;
    document.body.appendChild(el);
    this.card = el;
    this.cleanupFuncs.push(() => el.remove());
  }

  drawCard() {
    const c = this.character();
    const show = Boolean(c) && run.phase === 'playing' && !this.world.session;
    this.card.hidden = !show;
    if (!show) return;
    const coins = Math.floor(Object.values(run.currencies).reduce((sum, n) => sum + (Number(n) || 0), 0));
    const unspent = pointsUnspent({ ...c, level: run.playerLevel });
    const key = `${c.id}|${run.playerLevel}|${Math.floor(run.xp)}|${coins}|${unspent}`;
    if (key === this.cardKey) return;
    this.cardKey = key;
    const colour = hex(roleByKey(c.role).color);
    this.card.innerHTML = `<div class="zb-portrait">${ring(colour)}${tint(ROLE_ICONS[c.role], colour, 30)}</div>
      <div class="zb-card-body"><div class="zb-card-name"><b>${esc(c.name)}</b> <span>LV ${run.playerLevel} ${esc(roleByKey(c.role).label)}</span></div>
        ${bar(run.xp, xpToNext(run.playerLevel), '#5ab8ff', '')}
        <div class="zb-card-foot"><span>${img('ICON_ZB_Coin_Encore', 20)} ${coins.toLocaleString()}</span>
          ${unspent ? `<span class="zb-pts">+${unspent} pts · Band HQ</span>` : ''}</div></div>`;
  }

  // ── the headset ─────────────────────────────────────────────────────────────────────────────

  buildPanel() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = 1024;
    this.canvas.height = 768;
    this.texture = new CanvasTexture(this.canvas);
    this.texture.colorSpace = SRGBColorSpace;
    this.panel = new Mesh(new PlaneGeometry(1.0, 0.75), new MeshBasicMaterial({ map: this.texture, transparent: true, depthTest: false }));
    this.panel.position.set(0, -0.05, -1.1);
    this.panel.renderOrder = 1000;
    this.panel.visible = false;
    this.camera.add(this.panel);
    this.images = new Map();
    this.cleanupFuncs.push(() => {
      this.panel.removeFromParent();
      this.panel.geometry.dispose();
      this.panel.material.dispose();
      this.texture.dispose();
    });
  }

  /** The panel's rows for the current tab, each one `{ text, sub, colour, act, arg, enabled }`. */
  panelRows() {
    const c = this.character();
    const rows = [];
    if (this.tab === 'band' || !c) {
      for (const ch of this.save.characters) {
        const mine = ch.id === this.save.activeId;
        rows.push({ text: `${mine ? '★' : '▶'} ${ch.name}`, sub: `LV ${ch.level} ${roleByKey(ch.role).label}${mine ? ' · on stage' : ''}`, colour: hex(roleByKey(ch.role).color), act: 'select', arg: ch.id, enabled: !mine });
      }
      if (this.save.characters.length < MAX_CHARACTERS) {
        for (const r of ROLES) rows.push({ text: `+ New ${r.label.toLowerCase()}`, sub: r.blurb, colour: hex(r.color), act: 'create', arg: r.key, enabled: true });
      }
      const bots = this.world.getSystem(BotSystem);
      if (bots) {
        rows.push(bots.authority
          ? { text: `CPU bandmates: ${bots.wanted}`, sub: `Trigger for one more (0 to ${MAX_BAND - 1}). They take the roles nobody is playing.`, colour: '#9b6bff', act: 'cpu', arg: '', enabled: true }
          : { text: `CPU bandmates: ${bots.bots.size}`, sub: 'In someone else\'s room the host chooses.', colour: '#9b6bff', act: 'cpu', arg: '', enabled: false });
      }
    } else if (this.tab === 'stats') {
      const cost = trainCost(c);
      for (const a of ATTRIBUTES) {
        const points = c.attributes[a.stat] ?? 0;
        rows.push({ text: `+1 ${a.label}  (${points} · +${a.perPointPct * points}%)`, sub: a.blurb, act: 'allocate', arg: a.stat, enabled: pointsUnspent(c) > 0 && points < a.maxPoints });
        rows.push({ text: `   Train ${a.label} — ${cost ?? '—'} coins`, sub: '', act: 'train', arg: a.stat, enabled: cost !== null && this.save.coins >= cost && points < a.maxPoints });
      }
    } else if (this.tab === 'shop') {
      const worn = new Set(Object.values(c.loadout));
      for (const item of Object.values(GAME.loot).filter(isStock).sort((a, b) => a.itemLevel - b.itemLevel)) {
        const owned = (this.save.stash[item.key] ?? 0) > 0;
        const reasons = whyNot(this.save, item);
        rows.push(owned
          ? { text: `${worn.has(item.key) ? 'Take off' : 'Wear'} ${item.name}`, sub: item.rarity, colour: RARITY_COLORS[item.rarity], act: worn.has(item.key) ? 'unequip' : 'equip', arg: item.key, enabled: true }
          : { text: `Buy ${item.name} — ${price(item)}`, sub: reasons.join(' ') || item.rarity, colour: RARITY_COLORS[item.rarity], act: 'buy', arg: item.key, enabled: reasons.length === 0 });
      }
    } else {
      const guest = Boolean(this.world.net?.follower);
      const max = GAME.handicap?.max ?? 0;
      const handicap = guest ? 0 : run.handicap;
      if (max > 0) {
        const line = guest ? 'The host sets the handicap.' : handicapLine(handicapStep(handicap));
        rows.push({ text: `Handicap +${handicap}  ▲`, sub: line, colour: '#ffb020', act: 'handicap', arg: '1', enabled: !guest && handicap < max });
        rows.push({ text: `Handicap +${handicap}  ▼`, sub: '', colour: '#ffb020', act: 'handicap', arg: '-1', enabled: !guest && handicap > 0 });
      }
      for (const level of [...GAME.levels].sort((a, b) => a.ordinal - b.ordinal)) {
        const pitch = difficulty(c.level, (level.recommendedPlayerLevel ?? 1) + handicap);
        rows.push({ text: `${level.key === this.board ? '◆' : ' '} ${level.ordinal}. ${level.name}`, sub: `${pitch}${isHuntBoard(level, GAME.entities) ? ' · boss hunt' : ''} · LV ${level.recommendedPlayerLevel ?? 1}${handicap > 0 ? ` +${handicap}` : ''}`, colour: DIFFICULTY_COLORS[pitch], act: 'board', arg: level.key, enabled: true });
      }
    }
    const board = GAME.levels.find((l) => l.key === this.board);
    rows.push({ text: c && board ? `▶ PLAY: ${board.name}` : 'Make a character to play', sub: '', colour: '#ffb020', act: 'play', arg: '', enabled: Boolean(c && board) });
    return rows;
  }

  panelInput() {
    const pad = this.input.gamepads.right ?? this.input.gamepads.left;
    if (!pad) return;
    const tabs = ['band', 'stats', 'shop', 'boards'];
    const rows = this.panelRows();
    const stick = InputComponent.Thumbstick;
    if (pad.getAxesEnteringDown?.(stick)) this.focus = (this.focus + 1) % rows.length;
    if (pad.getAxesEnteringUp?.(stick)) this.focus = (this.focus - 1 + rows.length) % rows.length;
    const step = pad.getAxesEnteringRight?.(stick) ? 1 : pad.getAxesEnteringLeft?.(stick) ? -1 : 0;
    if (step && this.character()) this.act('tab', tabs[(tabs.indexOf(this.tab) + step + tabs.length) % tabs.length]);
    if (pad.getButtonDown(InputComponent.Trigger)) {
      const row = rows[Math.min(this.focus, rows.length - 1)];
      if (row?.enabled) this.act(row.act, row.arg);
    }
  }

  drawPanel() {
    const rows = this.panelRows();
    this.focus = Math.min(this.focus, rows.length - 1);
    const c = this.character();
    const key = `${this.tab}|${this.focus}|${JSON.stringify(rows.map((r) => [r.text, r.sub, r.enabled]))}|${this.save.coins}|${this.message?.text}`;
    if (key === this.panelKey) return;
    this.panelKey = key;

    const g = this.canvas.getContext('2d');
    const { width, height } = this.canvas;
    g.clearRect(0, 0, width, height);
    g.fillStyle = 'rgba(18,14,10,0.94)';
    g.beginPath();
    g.roundRect(0, 0, width, height, 28);
    g.fill();
    g.fillStyle = '#ffb020';
    g.fillRect(0, 0, width, 10);
    g.font = '900 44px Impact, system-ui, sans-serif';
    g.fillText('BAND HQ', 32, 64);
    g.font = '600 26px system-ui, sans-serif';
    g.fillStyle = '#f2e6d0';
    if (c) g.fillText(`${c.name} · LV ${c.level} ${roleByKey(c.role).label}`, 250, 60);
    g.fillStyle = '#ffe27d';
    g.textAlign = 'right';
    g.fillText(`${Math.floor(this.save.coins)} coins`, width - 32, 60);
    g.textAlign = 'left';

    ['band', 'stats', 'shop', 'boards'].forEach((t, i) => {
      const on = t === this.tab;
      g.fillStyle = on ? '#ffb020' : 'rgba(255,255,255,0.08)';
      g.fillRect(32 + i * 240, 84, 228, 44);
      g.fillStyle = on ? '#120c06' : '#f2e6d0';
      g.font = '800 22px system-ui, sans-serif';
      const pts = t === 'stats' && c && pointsUnspent(c) ? ` (${pointsUnspent(c)})` : '';
      g.fillText(`${{ band: 'THE BAND', stats: 'STATS', shop: 'MERCH', boards: 'BOARDS' }[t]}${pts}`, 48 + i * 240, 114);
    });

    const top = 148;
    const rowH = 54;
    const visible = Math.floor((height - top - 70) / rowH);
    const first = Math.max(0, Math.min(this.focus - Math.floor(visible / 2), rows.length - visible));
    rows.slice(first, first + visible).forEach((row, i) => {
      const y = top + i * rowH;
      const on = first + i === this.focus;
      if (on) {
        g.fillStyle = 'rgba(255,176,32,0.22)';
        g.fillRect(24, y, width - 48, rowH - 6);
        g.fillStyle = '#ffb020';
        g.fillRect(24, y, 6, rowH - 6);
      }
      g.globalAlpha = row.enabled ? 1 : 0.4;
      g.fillStyle = row.colour ?? '#f2e6d0';
      g.font = '700 26px system-ui, sans-serif';
      g.fillText(row.text, 44, y + 30);
      if (row.sub) {
        g.fillStyle = 'rgba(242,230,208,0.65)';
        g.font = '500 18px system-ui, sans-serif';
        g.fillText(row.sub.slice(0, 80), 44, y + 48);
      }
      g.globalAlpha = 1;
    });

    g.font = '500 20px system-ui, sans-serif';
    g.fillStyle = this.message ? (this.message.tone === 'bad' ? '#ffb3b3' : '#b7ffd3') : 'rgba(242,230,208,0.6)';
    g.fillText(this.message?.text ?? 'Stick: ← → tabs · ↑ ↓ rows · trigger to choose', 32, height - 28);
    this.texture.needsUpdate = true;
  }

  // ── looks ───────────────────────────────────────────────────────────────────────────────────

  buildStyle() {
    const url = (name) => (spriteUrl(name) ? `url('${spriteUrl(name)}')` : 'none');
    const style = document.createElement('style');
    style.textContent = `
      :root { --zb-panel: ${url('SPR_Apocalypse_Box_Rusty01')}; --zb-card: ${url('SPR_Apocalypse_Box_Metal01')};
        --zb-card-on: ${url('SPR_Apocalypse_Box_RustyBolts01')}; --zb-bar: ${url('SPR_Apocalypse_Bar_MetalRounded02')};
        --zb-hazard: ${url('SPR_Background_HazardStripes')}; --zb-vignette: ${url('SPR_UI_FX_Background_Vignette')};
        --zb-flag: ${url('SPR_HUD_Flag_Grunge')}; --zb-ink: #f2e6d0; --zb-amber: #ffb020; }
      .zb-hq[hidden], .zb-card[hidden], .zb-together[hidden] { display: none !important; }
      .zb-panel { border: 26px solid rgba(90,80,70,.9); border-image: var(--zb-panel) 92 / 26px stretch; background: rgba(18,14,10,.94); background-clip: padding-box; }
      .zb-img { object-fit: contain; vertical-align: middle; flex: none; }
      .zb-ico { display: inline-block; vertical-align: middle; flex: none; -webkit-mask: var(--m) center / contain no-repeat; mask: var(--m) center / contain no-repeat; }
      .zb-ring { position: absolute; inset: 4px; border-radius: 50%; border: 3px solid var(--c); }
      .zb-portrait { position: relative; width: 64px; height: 64px; display: grid; place-items: center; flex: none; }
      .zb-dim { opacity: .68; font-size: 12px; font-weight: 500; }
      .zb-bar { position: relative; height: 14px; margin: 5px 0; border: 7px solid rgba(120,120,120,.6); border-image: var(--zb-bar) 40 60 / 7px 10px stretch; background: rgba(0,0,0,.6); background-clip: padding-box; }
      .zb-bar > div { height: 100%; }
      .zb-bar > span { position: absolute; inset: -4px 0; display: grid; place-items: center; font-size: 10px; font-weight: 700; text-shadow: 0 1px 2px #000; }
      .zb-hq { position: fixed; inset: 0; z-index: 40; display: grid; place-items: center; padding: 16px; color: var(--zb-ink); font: 600 14px system-ui, sans-serif;
        background: radial-gradient(ellipse at center, rgba(20,10,30,.55), rgba(0,0,0,.88)), var(--zb-vignette) center / cover; }
      .zb-hq-inner { box-sizing: border-box; width: min(1060px, 100%); max-height: calc(100vh - 32px); overflow-y: auto; overflow-x: hidden; }
      .zb-head { position: relative; display: flex; align-items: center; gap: 16px; padding: 4px 4px 10px; }
      .zb-hazard { position: absolute; left: -8px; right: -8px; top: -14px; height: 8px; background: var(--zb-amber); opacity: .85;
        -webkit-mask: var(--zb-hazard) 0 0 / 16px 16px repeat; mask: var(--zb-hazard) 0 0 / 16px 16px repeat; }
      .zb-head h1 { margin: 0; font: 900 26px/1 Impact, 'Arial Black', system-ui, sans-serif; letter-spacing: .12em; color: var(--zb-amber); }
      .zb-who { display: flex; align-items: center; gap: 6px; font-size: 13px; }
      .zb-coins { margin-left: auto; display: flex; align-items: center; gap: 6px; font-size: 18px; color: #ffe27d; }
      .zb-result { display: flex; align-items: center; gap: 12px; padding: 10px 14px; margin-bottom: 8px; background: rgba(125,255,176,.1); border-left: 4px solid #7dffb0; }
      .zb-result.lost { background: rgba(255,125,125,.1); border-left-color: #ff7d7d; }
      .zb-tabs { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 8px; }
      .zb-tab { position: relative; display: flex; align-items: center; gap: 7px; padding: 8px 16px; cursor: pointer; font: 800 13px system-ui, sans-serif;
        letter-spacing: .08em; text-transform: uppercase; color: var(--zb-ink); background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.14); border-radius: 3px; }
      .zb-tab.on { background: var(--zb-amber); color: #120c06; }
      .zb-tab:disabled { opacity: .35; cursor: default; }
      .zb-pip { position: absolute; top: -8px; right: -8px; min-width: 20px; height: 20px; border-radius: 10px; display: grid; place-items: center; background: #ff3d7f; color: #fff; font-size: 11px; }
      .zb-msg { padding: 7px 12px; margin-bottom: 8px; background: rgba(125,255,176,.12); color: #b7ffd3; }
      .zb-msg.bad { background: rgba(255,90,90,.14); color: #ffb3b3; }
      .zb-pad { padding: 30px; text-align: center; }
      .zb-foot { display: flex; align-items: center; gap: 12px; padding-top: 12px; }
      .zb-foot .zb-dim { margin-right: auto; }
      .zb-play { padding: 14px 28px; cursor: pointer; font: 900 17px system-ui, sans-serif; color: #120c06; background: linear-gradient(#ffcf5a, var(--zb-amber)); border: 0; border-radius: 3px; }
      .zb-play:disabled { opacity: .45; cursor: default; }
      .zb-btn { display: inline-flex; align-items: center; justify-content: center; gap: 5px; padding: 7px 12px; cursor: pointer; font: 700 12px system-ui, sans-serif;
        color: #120c06; background: var(--zb-ink); border: 0; border-radius: 3px; }
      .zb-btn.big { padding: 11px 20px; font-size: 14px; background: var(--zb-amber); }
      .zb-btn.ghost { background: transparent; color: var(--zb-ink); border: 1px solid rgba(242,230,208,.4); }
      .zb-btn:disabled { opacity: .35; cursor: default; }
      .zb-row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-top: 8px; }
      .zb-col { display: flex; flex-direction: column; gap: 6px; }
      .zb-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; }
      .zb-char, .zb-item { display: flex; flex-direction: column; align-items: center; gap: 4px; text-align: center; padding: 6px; color: var(--zb-ink); font: inherit;
        border: 22px solid rgba(120,120,120,.5); border-image: var(--zb-card) 70 / 22px stretch; background: rgba(40,34,28,.85); background-clip: padding-box; }
      .zb-char .zb-bar { align-self: stretch; }
      .zb-char.on { border-image-source: var(--zb-card-on); }
      .zb-char-name { font-size: 17px; font-weight: 800; }
      .zb-tag { margin-top: 6px; padding: 3px 9px; font-size: 11px; letter-spacing: .1em; background: var(--zb-amber); color: #120c06; }
      .zb-add { cursor: pointer; justify-content: center; min-height: 200px; }
      .zb-create h2 { margin: 2px 0 4px; font-size: 20px; color: var(--zb-amber); }
      .zb-roles { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 10px; margin: 12px 0; }
      .zb-role { display: flex; flex-direction: column; align-items: center; gap: 4px; padding: 12px; cursor: pointer; text-align: center; font: inherit; color: var(--zb-ink);
        background: rgba(255,255,255,.04); border: 2px solid rgba(255,255,255,.12); border-radius: 4px; }
      .zb-role span { font-size: 12px; font-weight: 500; opacity: .75; }
      .zb-role.on { border-color: var(--c); box-shadow: 0 0 18px var(--c); }
      .zb-name { display: flex; flex-direction: column; gap: 4px; max-width: 360px; font-size: 12px; letter-spacing: .08em; text-transform: uppercase; }
      .zb-name input { padding: 10px 12px; font: 700 16px system-ui, sans-serif; color: var(--zb-ink); background: rgba(0,0,0,.5); border: 1px solid rgba(242,230,208,.35); text-transform: none; }
      .zb-stat-head { display: grid; grid-template-columns: 1fr auto; gap: 16px; align-items: center; margin-bottom: 8px; }
      .zb-points { text-align: right; display: flex; flex-direction: column; }
      .zb-points.hot b { color: #ff3d7f; font-size: 22px; }
      .zb-vitals { display: flex; gap: 18px; flex-wrap: wrap; padding: 8px 12px; margin-bottom: 10px; background: rgba(0,0,0,.35); }
      .zb-vitals span { display: flex; align-items: center; gap: 6px; }
      .zb-attr { display: grid; grid-template-columns: auto 1fr auto auto; gap: 14px; align-items: center; padding: 10px 12px; margin-bottom: 8px; background: rgba(255,255,255,.04); }
      .zb-attr-num { display: flex; flex-direction: column; align-items: center; min-width: 54px; }
      .zb-attr-num b { font-size: 22px; } .zb-attr-num span { font-size: 12px; color: #7dffb0; }
      .zb-pips { display: flex; gap: 3px; margin-top: 5px; } .zb-pips i { width: 14px; height: 6px; background: rgba(255,255,255,.14); }
      .zb-pips i.on { background: var(--zb-amber); } .zb-pips i.half { background: rgba(255,176,32,.45); }
      .zb-item-icon { width: 84px; height: 84px; display: grid; place-items: center; }
      .zb-item b { color: var(--r); } .zb-item .zb-btn { margin-top: 6px; } .zb-why { font-size: 11px; color: #ffb3b3; }
      .zb-handicap { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 10px; padding: 8px 12px;
        background: rgba(255,255,255,.04); border: 1px solid rgba(255,255,255,.08); border-radius: 3px; }
      .zb-handicap .zb-btn { min-width: 34px; padding: 4px 10px; font-weight: 900; }
      .zb-handicap-n { min-width: 34px; text-align: center; font: 900 18px system-ui, sans-serif; color: var(--zb-amber); }
      .zb-boards { display: flex; flex-direction: column; gap: 8px; }
      .zb-board { display: grid; grid-template-columns: auto 1fr auto; gap: 14px; align-items: center; padding: 10px 14px; cursor: pointer; text-align: left; font: inherit;
        color: var(--zb-ink); background: rgba(255,255,255,.04); border: 2px solid rgba(255,255,255,.08); }
      .zb-board.on { border-color: var(--zb-amber); background: rgba(255,176,32,.12); }
      .zb-flag { width: 44px; height: 44px; display: grid; place-items: center; font: 900 18px system-ui, sans-serif; color: #120c06; background: var(--zb-amber);
        -webkit-mask: var(--zb-flag) center / contain no-repeat; mask: var(--zb-flag) center / contain no-repeat; }
      .zb-board-meta { display: flex; flex-direction: column; align-items: flex-end; gap: 2px; font-size: 12px; font-weight: 800; }
      .zb-won { display: flex; align-items: center; gap: 4px; color: #ffe27d; }
      .zb-together { margin-top: 12px; }
      .zb-together { display: grid; gap: 10px; }
      .zb-together > div { border-color: rgba(242,230,208,.18) !important; border-radius: 4px !important; background: rgba(255,255,255,.04); }
      .zb-together button { font: 700 13px system-ui, sans-serif; padding: 8px 12px; cursor: pointer; color: #120c06; background: var(--zb-ink); border: 0; border-radius: 3px; }
      .zb-together button:disabled { opacity: .35; cursor: default; }
      .zb-together input { font: inherit; }
      .zb-card { position: fixed; left: 12px; bottom: 64px; z-index: 30; width: 270px; display: flex; gap: 10px; align-items: center; color: var(--zb-ink);
        font: 600 13px system-ui, sans-serif; pointer-events: none; border-width: 16px; border-image-width: 16px; }
      .zb-card-body { flex: 1; min-width: 0; } .zb-card-name span { opacity: .7; font-size: 11px; }
      .zb-card .zb-bar { height: 6px; border-width: 4px; }
      .zb-card-foot { display: flex; align-items: center; justify-content: space-between; color: #ffe27d; }
      .zb-card-foot span { display: flex; align-items: center; gap: 4px; } .zb-pts { color: #ff7dab; font-size: 11px; }
      @media (max-width: 720px) { .zb-attr { grid-template-columns: auto 1fr; } .zb-attr .zb-col { grid-column: 1 / -1; flex-direction: row; } .zb-foot .zb-dim { display: none; } }`;
    document.head.appendChild(style);
    this.cleanupFuncs.push(() => style.remove());
  }
}

// ── bits ────────────────────────────────────────────────────────────────────────────────────────

function esc(text) {
  return String(text).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

/** A full-colour sprite, or nothing when the export did not carry it. */
function img(name, size) {
  const src = spriteUrl(name);
  return src ? `<img class="zb-img" src="${src}" alt="" width="${size}" height="${size}" draggable="false">` : '';
}

/** A white sprite tinted with a colour; a dot of that colour when the export did not carry it. */
function tint(name, colour, size) {
  const src = spriteUrl(name);
  return src
    ? `<i class="zb-ico" style="--m:url('${src}');background:${colour};width:${size}px;height:${size}px"></i>`
    : `<i style="display:inline-block;width:${size / 2}px;height:${size / 2}px;border-radius:50%;background:${colour}"></i>`;
}

const ring = (colour) => `<i class="zb-ring" style="--c:${colour}"></i>`;

function bar(value, max, colour, label) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return `<div class="zb-bar"><div style="width:${pct}%;background:${colour}"></div>${label ? `<span>${label}</span>` : ''}</div>`;
}

function pips(points, max) {
  const shown = Math.min(max, 10);
  const per = max / shown;
  return Array.from({ length: shown }, (_, i) => `<i class="${points >= (i + 1) * per ? 'on' : points > i * per ? 'half' : ''}"></i>`).join('');
}
