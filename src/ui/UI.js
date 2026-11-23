import * as THREE from 'three/webgpu';
import { Settings, isTouchDevice } from '../core/Settings.js';
import { TouchControls } from '../core/TouchControls.js';
import { Hud } from './Hud.js';
import { Nav, el } from './dom.js';
import { FlowAdapter } from './flow.js';
import { getRelief } from './relief.js';
import { keyFor } from './bindings.js';
import { buildTitle, buildPause, buildDebrief, buildMemorial, buildCredits, buildLoading } from './screens/screens.js';
import { buildMissionSelect, buildBriefing } from './screens/missions.js';
import { buildSettings } from './screens/settingsScreen.js';

/**
 * UI orchestrator: screens, HUD, touch controls, settings side effects, and
 * the event wiring between them and the rest of the game.
 *
 * Screen ownership: gameplay's flow drives the sortie lifecycle (loading,
 * sortie, pause, debrief) through `ui:screen`; the UI drives pure menu
 * navigation (title, sorties, briefing, settings, credits, memorial) itself
 * and announces it on the same event with `source: 'ui'`.
 */

const MENU_SCREENS = new Set(['title', 'missionSelect', 'briefing', 'settings', 'credits', 'memorial']);

export class UI {
  constructor(game) {
    this.game = game;
    this.settings = new Settings();
    game.settings = this.settings; // shared: audio/camera/gameplay read their keys here
    this.flow = new FlowAdapter(game, this);
    this.params = new URLSearchParams(location.search);
    this.dev = !!import.meta.env?.DEV;
    this.touch = isTouchDevice() || this.params.get('touch') === '1';
    this.screen = 'boot';
    this.history = [];
    this.lastResult = null;
    this.titleCamera = true;
    this._t = 0;

    const host = document.getElementById('ui') ?? document.body;
    this.host = host;
    host.dataset.touch = String(this.touch);
    document.documentElement.dataset.input = this.touch ? 'touch' : 'pointer';
    this.safeProbe = el('div', 'safe-probe', host);

    this.hud = new Hud(host, this.settings);
    this.hud.setTouch(this.touch);
    this.screensEl = el('div', 'screens', host);
    this.live = el('div', 'sr-only', host);
    this.live.setAttribute('aria-live', 'polite');
    this.alert = el('div', 'sr-only', host);
    this.alert.setAttribute('role', 'alert');

    this.touchControls = new TouchControls(game.input, host, {
      settings: this.settings,
      onPause: () => this.flow.pause(),
    });

    this.nav = new Nav();
    if (this.touch) this.nav.modality = 'touch';
    this.nav.onStart = () => {
      if (this.screen === 'sortie') {
        this.flow.pause();
        return true;
      }
      return false;
    };

    this.screens = {};
    for (const s of [
      buildTitle(this), buildMissionSelect(this), buildBriefing(this), buildSettings(this),
      buildPause(this), buildDebrief(this), buildMemorial(this), buildCredits(this), buildLoading(this),
    ]) {
      this.screens[s.id] = s;
      s.root.classList.add('scr-hidden');
      s.root.dataset.screen = s.id;
      this.screensEl.appendChild(s.root);
    }

    this._applyAllSettings();
    this.settings.onChange((key, value) => this._onSetting(key, value));
    this._wireEvents();

    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);
    window.visualViewport?.addEventListener('resize', this._onResize);
    this.resize();

    // Menus run on their own frame loop: while paused, game.update (and so
    // every system hook) is skipped, but the pause menu still needs a pad.
    let last = performance.now();
    const tick = (now) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      this.nav.pollGamepad(dt);
      this.screens[this.screen]?.update?.(game);
      this._raf = requestAnimationFrame(tick);
    };
    this._raf = requestAnimationFrame(tick);
  }

  // ------------------------------------------------------------ lifecycle --

  async init() {
    globalThis.__ssBoot?.set('aircraft', 1);
    // Bake the relief while the first frames compile shaders.
    const bake = () => {
      const r = getRelief(this.touch ? 768 : 1024);
      if (r) this.hud.setRelief(r.canvas, r.bounds);
    };
    if ('requestIdleCallback' in window) requestIdleCallback(bake, { timeout: 800 });
    else setTimeout(bake, 50);
    this.hud.keyHint.flares = keyFor(this.game.input, 'flares') || 'C';
    if (this.game.input) this.game.input.enabled = false;
    const mode = this.params.get('hudmock');
    if (import.meta.env.DEV && mode !== null) {
      const { HudMock } = await import('./mock.js');
      this.mock = new HudMock(this.game, this, mode || '1');
    }
  }

  /** First rendered frames have compiled: drop the boot loader, open the menus. */
  _bootDone() {
    if (this._booted) return;
    this._booted = true;
    globalThis.__ssBoot?.done();
    const jump = this.dev ? this.params.get('ui') : null;
    if (this.mock && !jump) {
      this._devSortie();
      return;
    }
    if (jump) {
      this._devJump(jump);
      return;
    }
    this.show(this.settings.memorialSeen ? 'title' : 'memorial');
  }

  update(dt) {
    if (this.mock && this.screen === 'sortie') this.mock.update(dt);
  }

  lateUpdate(dt) {
    this._t += dt;
    if (!this._booted) {
      this._frames = (this._frames ?? 0) + 1;
      globalThis.__ssBoot?.set('shaders', Math.min(1, this._frames / 3));
      if (this._frames >= 3) this._bootDone();
    }
    if (MENU_SCREENS.has(this.screen) || this.screen === 'boot') this._titleCamera(dt);
    // HUD animation runs on wall-clock time: slow motion, a kill cam or a
    // frozen sim (timeScale 0) must not stall callouts, fades and blinks.
    const now = performance.now();
    const rdt = Math.min(0.1, (now - (this._hudLast ?? now)) / 1000);
    this._hudLast = now;
    this.hud.update(rdt, this.game);
    this.touchControls.sync(this.game.hud);
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const cs = getComputedStyle(this.safeProbe);
    const safe = {
      top: parseFloat(cs.paddingTop) || 0,
      right: parseFloat(cs.paddingRight) || 0,
      bottom: parseFloat(cs.paddingBottom) || 0,
      left: parseFloat(cs.paddingLeft) || 0,
    };
    this.hud.safe = safe;
    this.hud.resize(w, h);
    this.screens[this.screen]?.onResize?.();
  }

  dispose() {
    cancelAnimationFrame(this._raf);
    window.removeEventListener('resize', this._onResize);
    this.touchControls.dispose();
    this.mock?.dispose();
  }

  // -------------------------------------------------------------- screens --

  /** Navigate to a menu screen (pushes history for Back). */
  go(id, arg) {
    if (this.screen && this.screen !== id) this.history.push(this.screen);
    this.show(id, arg);
    this.game.events.emit('ui:screen', { screen: id, source: 'ui' });
  }

  back() {
    const prev = this.history.pop();
    if (prev && prev !== 'boot' && prev !== 'loading') {
      this.show(prev);
      this.game.events.emit('ui:screen', { screen: prev, source: 'ui' });
    } else if (this.screen !== 'title') {
      this.show('title');
    }
  }

  show(id, arg) {
    const prev = this.screen;
    if (prev === id && !arg) return;
    this.screens[prev]?.onHide?.();
    for (const s of Object.values(this.screens)) {
      const on = s.id === id;
      s.root.classList.toggle('scr-hidden', !on);
      s.root.toggleAttribute('inert', !on);
    }
    this.screen = id;
    document.documentElement.dataset.screen = id;
    const flying = id === 'sortie' || id === 'pause';
    this.hud.setVisible(flying);
    this.hud.canvas.classList.toggle('dim', id === 'pause');
    this.touchControls.setEnabled(this.touch && id === 'sortie');
    this.screensEl.classList.toggle('menu-bg', MENU_SCREENS.has(id) || id === 'debrief' || id === 'loading');
    if (id === 'sortie') this.history.length = 0;
    const s = this.screens[id];
    if (!s) {
      this.nav.setRoot(null);
      return;
    }
    const initial = s.onShow?.(arg) ?? null;
    this.nav.setRoot(s.root, {
      onBack: s.noBack ? null : s.back ?? (() => this.back()),
      initial,
      focus: !this.touch || this.nav.modality !== 'touch',
    });
  }

  openBriefing(id) {
    this.briefingId = id;
    this.go('briefing', { id });
  }

  launch(id) {
    this.history.length = 0;
    this.flow.startMission(id);
  }

  afterDebrief() {
    const r = this.lastResult;
    if (r?.success !== false && !this._memorialShownThisSession) {
      this._memorialShownThisSession = true;
      this.history = ['missionSelect'];
      this.show('memorial');
      return;
    }
    this.flow.quitToMenu();
  }

  afterMemorial() {
    if (this.history.length) this.back();
    else this.show('title');
  }

  // --------------------------------------------------------------- events --

  _wireEvents() {
    const ev = this.game.events;
    const isPlayer = (k) => {
      if (!k) return false;
      if (k === 'player' || k === this.game.player || k === this.game.flight) return true;
      return k.team === 'player' || k.isPlayer === true || k.owner === 'player';
    };

    ev.on('ui:screen', (p) => {
      if (!p || p.source === 'ui') return;
      const id = p.screen;
      if (id === 'sortie') {
        if (this.screen === 'loading' || this.screen === 'briefing' || this.screen === 'debrief') this.hud.clearTransient();
        this.show('sortie');
      } else if (this.screens[id]) this.show(id, p);
    });
    ev.on('loading:progress', (p) => {
      this.screens.loading.setProgress(p.progress ?? 0, p.label);
      globalThis.__ssBoot?.set('mission', p.progress ?? 0, p.label);
    });
    const onEnd = (success) => (p = {}) => {
      const raw = p.result ?? p;
      const m = p.mission ?? this.flow.currentMission;
      const res = {
        success,
        score: raw.score ?? this.game.hud?.score ?? 0,
        rank: raw.rank ?? null,
        kills: raw.kills,
        accuracy: raw.accuracy,
        time: raw.time ?? this.game.hud?.time,
        reason: raw.reason,
        best: raw.best,
      };
      const rec = this.flow.record(m?.id ?? this.flow.local.missionId, res);
      if (rec) {
        res.best = res.best ?? rec.best;
        res.isNewBest = rec.isNewBest && success;
      }
      this.lastResult = res;
      // Gameplay should follow with ui:screen 'debrief'. If it does not (or
      // there is no gameplay flow), show it after the moment has landed.
      clearTimeout(this._debriefTimer);
      this._debriefTimer = setTimeout(() => {
        if (this.screen === 'sortie') {
          this.game.input && (this.game.input.enabled = false);
          this.show('debrief');
        }
      }, this.flow.real ? 4500 : 2200);
      if (success) this.hud.showBanner('MISSION COMPLETE', m?.name ?? '', 3.5);
      else this.hud.showBanner('MISSION INCOMPLETE', 'Return to base', 3.5);
    };
    ev.on('mission:complete', onEnd(true));
    ev.on('mission:failed', onEnd(false));
    ev.on('mission:start', (p) => {
      this.hud.clearTransient();
      const m = p?.mission;
      if (m) this.hud.showBanner(m.name?.toUpperCase?.() ?? 'SORTIE', m.location?.name ?? '', 4);
    });
    ev.on('mission:phase', (p) => {
      const ph = p?.phase;
      const text = typeof ph === 'string' ? ph : ph?.text ?? ph?.name ?? '';
      if (text) this.hud.showBanner('NEW ORDERS', text, 4.5);
      if (text) this._say(`New orders: ${text}`);
    });
    ev.on('radio', (p) => {
      this.hud.pushRadio({ callsign: p.callsign ?? p.speaker, text: p.text, priority: p.priority });
      if (this.settings.subtitles !== false && p.text) this._say(`${p.callsign ?? p.speaker ?? ''}: ${p.text}`);
    });
    ev.on('target:destroyed', (p) => {
      if (!isPlayer(p.killer)) return;
      const t = p.target ?? {};
      const pts = Number.isFinite(p.score) ? `+${p.score}` : '';
      if (t.isAce) this.hud.callout('ace', 'ACE DOWN', [t.name, pts].filter(Boolean).join('  '), 3);
      else if (t.kind && !/^(air|aircraft|fighter|bomber|helo|helicopter|jet|transport)$/i.test(t.kind)) this.hud.callout('ground', 'NEUTRALISED', pts);
      else this.hud.callout('kill', 'SPLASH', pts);
    });
    ev.on('target:hit', (p) => {
      if (p.target?.team === 'friendly' || p.target?.team === 'player') return;
      if (p.attacker && !isPlayer(p.attacker)) return;
      this.hud.callout('hit', 'STRUCK', '', 1.1);
    });
    ev.on('missile:end', (p) => {
      const m = p.missile;
      if (!m || !isPlayer(m.owner)) return;
      if (p.reason === 'miss' || p.reason === 'fuel' || p.reason === 'ground') this.hud.callout('miss', 'NO HIT', '', 1.3);
    });
    for (const k of ['acquiring', 'locked', 'lost']) {
      ev.on(`lock:${k}`, (p) => this.hud.onLock(k === 'lost' ? 'none' : k, p?.target));
    }
    ev.on('threat:missile', (p) => {
      const was = this.hud.threatLevel;
      this.hud.setThreat(p.level ?? 'warning');
      if (!was) this._say('Missile warning', true);
    });
    ev.on('threat:cleared', () => this.hud.setThreat(null));
    ev.on('player:hit', (p) => {
      if (this.settings.prefersReducedMotion) this.hud.flashDamage(0);
      else this.hud.flashDamage(p.damage ?? 0.2);
    });
  }

  _say(text, urgent = false) {
    const n = urgent ? this.alert : this.live;
    n.textContent = '';
    // next frame so repeated identical lines are re-announced
    requestAnimationFrame(() => (n.textContent = text));
  }

  // ------------------------------------------------------------- settings --

  _applyAllSettings() {
    for (const k of ['hudColor', 'reducedMotion', 'subtitleSize', 'controlMode', 'cameraFov']) this._onSetting(k, this.settings[k], true);
  }

  _onSetting(key, value, initial = false) {
    const g = this.game;
    switch (key) {
      case 'tier': {
        if (initial) break;
        const name = value ?? autoTier(g.r);
        g.r?.setTier?.(name);
        if (this.reloadNotice) this.reloadNotice.hidden = false;
        break;
      }
      case 'hudColor':
      case 'palette':
      case 'hudScale':
      case 'hudOpacity':
        this.hud.applySettings(this.settings);
        break;
      case 'reducedMotion':
        document.documentElement.dataset.reducedMotion = String(this.settings.prefersReducedMotion);
        break;
      case 'subtitleSize':
        document.documentElement.dataset.subtitles = value;
        break;
      case 'controlMode':
        this.touchControls?.setMode(value);
        break;
      case 'cameraFov':
        if (g.cameraRig) g.cameraRig.baseFov = 62 + value;
        break;
    }
    if (!initial) g.events.emit('settings:change', { key, value, settings: this.settings });
  }

  // ------------------------------------------------------- title flyby --

  /**
   * Slow orbit of the player jet behind the menus. Only while a menu is up and
   * the gameplay flow is not driving its own camera (`game.flow.titleCamera`).
   */
  _titleCamera(dt) {
    const g = this.game;
    if (!this.titleCamera || g.flow?.titleCamera || !g.flight?.position) return;
    const f = g.flight;
    if (!this.flow.real && f.agl < 900 && !f.crashed) {
      // Menu-time terrain clearance for the unattended jet (local flow only).
      f.position.y += (900 - f.agl) * Math.min(1, dt * 0.8);
    }
    const cam = g.camera;
    const a = this._t * 0.05 + 0.9;
    const R = 30;
    const hd = Math.atan2(f.forward.x, -f.forward.z);
    const fx = Math.sin(hd);
    const fz = -Math.cos(hd);
    // aircraft-yaw frame: forward (fx, fz), right (-fz, fx)
    const lx = Math.sin(a) * R;
    const lz = Math.cos(a) * R;
    _v.set(f.position.x + (-fz) * lx + fx * lz, f.position.y + 3 + Math.sin(this._t * 0.13) * 2.5, f.position.z + fx * lx + fz * lz);
    cam.position.copy(_v);
    cam.up.set(0, 1, 0);
    // Frame the jet off-centre (right third on wide screens) so the menu
    // column reads against open sky rather than the airframe.
    _d.subVectors(f.position, _v).normalize();
    _r.crossVectors(_d, cam.up).normalize();
    const portrait = innerHeight > innerWidth;
    const shift = portrait ? 0 : 0.28 * R;
    _t.copy(f.position).addScaledVector(_r, -shift);
    if (portrait) _t.y -= R * 0.18;
    cam.lookAt(_t);
    cam.updateMatrixWorld();
  }

  // ------------------------------------------------------------------ dev --

  _devSortie() {
    this.flow.local.missionId = 'first-light';
    this.flow.local.state = 'sortie';
    if (this.game.input) this.game.input.enabled = true;
    this.mock?.start();
    this.show('sortie');
  }

  _devJump(id) {
    if (id === 'sortie') return this._devSortie();
    if (id === 'pause') {
      this._devSortie();
      setTimeout(() => this.flow.pause(), 300);
      return;
    }
    if (id === 'debrief' || id === 'debrief-fail') {
      this.flow.local.missionId = 'first-light';
      const ok = id === 'debrief';
      this.lastResult = ok
        ? { success: true, score: 48250, rank: 'A', kills: 14, accuracy: 0.62, time: 512, best: 51100 }
        : { success: false, score: 9100, kills: 3, accuracy: 0.31, time: 288 };
      this.show('debrief');
      return;
    }
    if (id === 'loading') {
      this.show('loading', { mission: this.flow.mission('first-light'), progress: 0.62, label: 'Building terrain' });
      return;
    }
    if (id === 'briefing') return this.openBriefing(this.params.get('mission') ?? 'first-light');
    if (this.screens[id]) {
      this.history = ['title'];
      this.show(id);
    } else this.show('title');
  }
}

const _v = new THREE.Vector3();
const _d = new THREE.Vector3();
const _r = new THREE.Vector3();
const _t = new THREE.Vector3();

function autoTier(r) {
  if (r?.backend !== 'webgpu') return 'low';
  return matchMedia('(pointer: coarse)').matches ? 'low' : 'high';
}
