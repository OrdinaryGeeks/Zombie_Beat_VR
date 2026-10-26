import {
  CanvasTexture, InputComponent, Mesh, MeshBasicMaterial, PlaneGeometry, SRGBColorSpace,
  createSystem,
} from '@iwsdk/core';
import { GAME } from '../content/game.js';
import { xpToNext } from '../rules.js';
import { LOOT_GRACE_SECONDS, on, run } from '../state.js';
import { LevelSystem } from './LevelSystem.js';
import { ProgressSystem } from './ProgressSystem.js';
import { WaveSystem } from './WaveSystem.js';

const TONES = { good: '#4ade80', bad: '#f87171', info: '#e2e8f0' };

/**
 * What the player reads: the start screen, health and XP, the level's objectives and countdown,
 * and short messages.
 *
 * Drawn twice from the same state — as HTML over the canvas on a flat screen, and as a canvas
 * texture on a panel just below your gaze in a headset, where HTML cannot reach.
 */
export class HudSystem extends createSystem({}) {
  init() {
    this.messages = [];
    this.redrawIn = 0;
    this.selected = 0;
    this.levels = [...GAME.levels].sort((a, b) => a.ordinal - b.ordinal);
    this.selected = Math.max(0, this.levels.findIndex((l) => l.key === GAME.player.startLevelKey));

    this.dom = document.getElementById('hud');
    this.menu = document.getElementById('menu');
    this.buildMenu();
    // Its own element rather than part of `#hud`, which is rewritten five times a second: a button
    // replaced between press and release never fires its click.
    this.countdownDom = document.getElementById('countdown');
    this.countdownDom?.querySelector('[data-skip]')?.addEventListener('click', () => {
      this.world.getSystem(ProgressSystem)?.skipLootGrace();
    });

    this.canvas = document.createElement('canvas');
    this.canvas.width = 1024;
    this.canvas.height = 512;
    this.texture = new CanvasTexture(this.canvas);
    this.texture.colorSpace = SRGBColorSpace;
    this.panel = new Mesh(
      new PlaneGeometry(0.8, 0.4),
      new MeshBasicMaterial({ map: this.texture, transparent: true, depthTest: false }),
    );
    this.panel.position.set(0, -0.22, -0.9);
    this.panel.rotation.x = -0.25;
    this.panel.renderOrder = 999;
    this.panel.visible = false;
    this.camera.add(this.panel);

    this.cleanupFuncs.push(
      on('message', ({ text, tone }) => this.messages.push({ text, tone, until: performance.now() + 3500 })),
      on('kill', ({ name }) => this.messages.push({ text: `Defeated ${name}`, tone: 'info', until: performance.now() + 2000 })),
      on('pickup', ({ lootKey, quantity }) => {
        const item = GAME.loot[lootKey];
        if (item) this.messages.push({ text: `+${quantity} ${item.name}`, tone: 'good', until: performance.now() + 2500 });
      }),
      on('level-start', () => this.showMenu(false)),
      on('game-complete', () => {
        this.messages.push({ text: `You finished ${GAME.meta.name}!`, tone: 'good', until: performance.now() + 8000 });
        setTimeout(() => this.showMenu(true), 6000);
      }),
    );
  }

  // ── Start screen ────────────────────────────────────────────────────────────────────────────

  buildMenu() {
    this.menu.querySelector('[data-title]').textContent = GAME.meta.name;
    const list = this.menu.querySelector('[data-levels]');
    list.replaceChildren(...this.levels.map((level, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = `${index + 1}. ${level.name}`;
      button.addEventListener('click', () => {
        this.selected = index;
        this.startSelected();
      });
      return button;
    }));

    const vr = this.menu.querySelector('[data-vr]');
    vr.hidden = true;
    navigator.xr?.isSessionSupported('immersive-vr').then((ok) => {
      vr.hidden = !ok;
    }).catch(() => undefined);
    vr.addEventListener('click', () => this.world.launchXR());
  }

  showMenu(visible) {
    // A game whose add-on owns the front door (`world.flow.ownsMenu`) draws its own.
    if (this.world.flow?.ownsMenu) visible = false;
    this.menu.hidden = !visible;
    if (visible) run.phase = 'menu';
  }

  startSelected() {
    const level = this.levels[this.selected];
    if (!level || run.phase === 'loading') return;
    this.showMenu(false);
    void this.world.getSystem(LevelSystem).load(level.key).catch((err) => {
      console.error(err);
      this.messages.push({ text: `Could not load ${level.name}`, tone: 'bad', until: performance.now() + 5000 });
      this.showMenu(true);
    });
  }

  // ── Frame ───────────────────────────────────────────────────────────────────────────────────

  update(delta) {
    const now = performance.now();
    this.messages = this.messages.filter((m) => m.until > now).slice(-4);

    const ownMenu = Boolean(this.world.flow?.ownsMenu);
    if (ownMenu) this.menu.hidden = true;
    else if (run.phase === 'menu') this.menuInput();

    this.redrawIn -= delta;
    if (this.redrawIn > 0) return;
    this.redrawIn = 0.2;
    const view = this.view();
    this.drawDom(view);
    const immersive = Boolean(this.world.session);
    this.panel.visible = immersive && !(ownMenu && view.phase === 'menu');
    if (immersive) this.drawPanel(view);
  }

  /** In a headset the start screen is the panel: stick to choose, trigger to start. */
  menuInput() {
    const pad = this.input.gamepads.right ?? this.input.gamepads.left;
    if (!pad) return;
    if (pad.getAxesEnteringDown(InputComponent.Thumbstick)) this.selected = (this.selected + 1) % this.levels.length;
    if (pad.getAxesEnteringUp(InputComponent.Thumbstick)) this.selected = (this.selected - 1 + this.levels.length) % this.levels.length;
    if (pad.getButtonDown(InputComponent.Trigger)) this.startSelected();
  }

  view() {
    const level = this.world.getSystem(LevelSystem)?.level;
    const board = this.world.getSystem(ProgressSystem)?.board ?? { lines: [] };
    const quests = Object.entries(run.quests)
      .filter(([, q]) => q.status === 'active')
      .map(([key]) => GAME.quests[key]?.name)
      .filter(Boolean);
    return {
      phase: run.phase,
      title: GAME.meta.name,
      level: level?.name ?? '',
      health: run.health,
      maxHealth: run.maxHealth,
      playerLevel: run.playerLevel,
      xp: run.xp,
      xpNext: xpToNext(run.playerLevel),
      gold: Object.values(run.currencies).reduce((a, b) => a + b, 0),
      lines: board.lines,
      quests,
      countdown: this.countdown(),
      messages: this.messages,
      menu: this.levels.map((l, i) => ({ name: l.name, selected: i === this.selected })),
    };
  }

  /**
   * What is being counted down, or null: the loot grace after a level ends, else the pause before
   * the next wave. Matches the banner Game Foundry's shell draws (`Hud.setCountdown`).
   */
  countdown() {
    if ((run.phase === 'won' || run.phase === 'lost') && run.lootGrace > 0) {
      return {
        title: run.phase === 'won' ? 'Level cleared' : 'Level over',
        detail: 'Grab the loot before moving on',
        seconds: run.lootGrace,
        total: LOOT_GRACE_SECONDS,
        // A guest waits on the host, who says when the room moves on.
        canSkip: !this.world.net?.follower,
      };
    }
    const waves = run.phase === 'playing' ? this.world.getSystem(WaveSystem)?.status : null;
    if (waves?.phase === 'lead-in' && waves.secondsToNext > 0.05) {
      return {
        title: `Wave ${waves.wave} incoming`,
        detail: waves.wave > 1 ? 'Grab the loot' : 'Get ready',
        seconds: waves.secondsToNext,
        total: waves.leadInSeconds || waves.secondsToNext,
        canSkip: false,
      };
    }
    return null;
  }

  drawCountdown(countdown) {
    const box = this.countdownDom;
    if (!box) return;
    box.hidden = !countdown;
    if (!countdown) return;
    box.querySelector('[data-title]').textContent = countdown.title;
    box.querySelector('[data-detail]').textContent = countdown.detail;
    box.querySelector('[data-secs]').textContent = `${Math.ceil(countdown.seconds)}s`;
    box.querySelector('[data-fill]').style.width = `${Math.max(0, Math.min(1, countdown.seconds / countdown.total)) * 100}%`;
    box.querySelector('[data-skip]').hidden = !countdown.canSkip;
  }

  drawDom(view) {
    this.drawCountdown(this.world.session ? null : view.countdown);
    if (!this.dom) return;
    this.dom.hidden = view.phase === 'menu';
    const pct = Math.max(0, Math.min(1, view.health / view.maxHealth)) * 100;
    const lines = view.lines.map((l) => `<li class="${l.met ? 'met' : ''} ${l.side}">${escape(l.description)} <b>${l.current}/${l.target}</b></li>`).join('');
    this.dom.innerHTML = `
      <div class="bar"><div class="fill" style="width:${pct}%"></div><span>${Math.ceil(view.health)} / ${Math.round(view.maxHealth)}</span></div>
      <div class="meta">Lv ${view.playerLevel} · XP ${Math.floor(view.xp)}/${view.xpNext} · Gold ${Math.floor(view.gold)}</div>
      <div class="level">${escape(view.level)}</div>
      <ul class="board">${lines}</ul>
      ${view.quests.length ? `<div class="quests">${view.quests.map((q) => `<div>◆ ${escape(q)}</div>`).join('')}</div>` : ''}
      <div class="messages">${view.messages.map((m) => `<div style="color:${TONES[m.tone] ?? TONES.info}">${escape(m.text)}</div>`).join('')}</div>`;
  }

  drawPanel(view) {
    const g = this.canvas.getContext('2d');
    const { width, height } = this.canvas;
    g.clearRect(0, 0, width, height);
    g.fillStyle = 'rgba(15, 23, 42, 0.78)';
    roundRect(g, 0, 0, width, height, 36);
    g.fill();
    g.fillStyle = '#f8fafc';
    g.font = '600 40px system-ui, sans-serif';

    if (view.phase === 'menu') {
      g.fillText(view.title, 40, 70);
      g.font = '28px system-ui, sans-serif';
      g.fillStyle = '#94a3b8';
      g.fillText('Stick to choose · trigger to start', 40, 115);
      view.menu.slice(0, 8).forEach((item, i) => {
        g.fillStyle = item.selected ? '#a5b4fc' : '#e2e8f0';
        g.fillText(`${item.selected ? '▶ ' : '   '}${item.name}`, 40, 175 + i * 42);
      });
    } else {
      g.fillText(view.level, 40, 64);
      g.fillStyle = '#334155';
      roundRect(g, 40, 90, 560, 34, 17);
      g.fill();
      g.fillStyle = '#ef4444';
      roundRect(g, 40, 90, 560 * Math.max(0, view.health / view.maxHealth), 34, 17);
      g.fill();
      g.fillStyle = '#f8fafc';
      g.font = '26px system-ui, sans-serif';
      g.fillText(`${Math.ceil(view.health)} / ${Math.round(view.maxHealth)}   Lv ${view.playerLevel}   Gold ${Math.floor(view.gold)}`, 620, 116);
      view.lines.slice(0, 5).forEach((line, i) => {
        g.fillStyle = line.met ? '#4ade80' : line.side === 'lose' ? '#fca5a5' : '#e2e8f0';
        g.fillText(`${line.description}  ${line.current}/${line.target}`, 40, 175 + i * 38);
      });
      view.messages.forEach((m, i) => {
        g.fillStyle = TONES[m.tone] ?? TONES.info;
        g.fillText(m.text, 40, 390 + i * 34);
      });
      if (view.countdown) this.drawPanelCountdown(g, view.countdown);
    }
    this.texture.needsUpdate = true;
  }

  /** The countdown on the headset panel: right-hand side, under the health row. */
  drawPanelCountdown(g, countdown) {
    const x = 640;
    g.fillStyle = 'rgba(250, 204, 21, 0.14)';
    roundRect(g, x - 16, 150, 376, 170, 18);
    g.fill();
    g.fillStyle = '#facc15';
    g.font = '700 52px system-ui, sans-serif';
    g.fillText(`${Math.ceil(countdown.seconds)}s`, x, 205);
    g.fillStyle = '#f8fafc';
    g.font = '600 28px system-ui, sans-serif';
    g.fillText(countdown.title, x, 245);
    g.fillStyle = '#334155';
    roundRect(g, x, 262, 340, 12, 6);
    g.fill();
    g.fillStyle = '#facc15';
    roundRect(g, x, 262, 340 * Math.max(0, Math.min(1, countdown.seconds / countdown.total)), 12, 6);
    g.fill();
    g.fillStyle = '#cbd5e1';
    g.font = '22px system-ui, sans-serif';
    g.fillText(countdown.canSkip ? 'Trigger to continue' : countdown.detail, x, 305);
  }
}

function escape(text) {
  return String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.roundRect(x, y, Math.max(0, w), h, Math.min(r, w / 2, h / 2));
}
