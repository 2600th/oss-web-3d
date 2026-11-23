import * as THREE from 'three/webgpu';
import { Settings, isTouchDevice } from '../core/Settings.js';
import { TouchControls } from '../core/TouchControls.js';
import { Hud } from './Hud.js';
import { Nav, el } from './dom.js';
import { FlowAdapter, toUiScreen } from './flow.js';
import { isGround } from './theme.js';
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
    // Focus moves and Back have sounds (src/audio listens for ui:sound);
    // activation is a real click, which audio already hears.
    this.nav.onSound = (name) => game.events.emit('ui:sound', { name });
    if (this.touch) this.nav.modality = 'touch';
    // Gameplay's flow owns the pause key and pad Menu button (Input action
    // `pause`); handling them here as well would pause and resume in one press.
    this.nav.padStartOwned = () => !!this.flow.real && (this.screen === 'pause' || this.screen === 'sortie');
    this.nav.onStart = () => {
      if (this.flow.real) return false;
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
    this.hud.keyHint.flares = keyFor(this.game.input, 'flares') || 'G';
    // With gameplay's flow, it gates input itself (input.capture); the UI owns
    // menu navigation, so the flow's keyboard fallback goes off.
    if (this.flow.real) this.game.flow.fallbackKeys = false;
    else if (this.game.input) this.game.input.enabled = false;
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
    // Gameplay's flow may already be past the title (?mission=m1): follow it.
    const fs = this.flow.real?.state;
    if (fs && fs !== 'boot' && fs !== 'title') {
      if (fs === 'debrief' && this.flow.result) this.lastResult = resultFromFlow(this.flow.result, null);
      this.show(toUiScreen(fs), { mission: this.flow.real.mission });
      return;
    }
    this.show(this.settings.memorialSeen ? 'title' : 'memorial');
  }

  /**
   * Keep the boot loader up until the world is really on screen:
   * terrain pack (main.js, before systems) -> ground textures
   * (`game.terrain.ready`) -> pipelines compiled on the first frames that
   * draw them. Pipeline compilation stalls the frame loop, so "first good
   * frame" = after textures are in, three consecutive frames under 100 ms
   * apart. A 15 s cap after textures keeps a slow GPU from hanging here.
   * Called from lateUpdate, which runs inside every animation frame.
   */
  _bootTick() {
    const boot = globalThis.__ssBoot;
    const now = performance.now();
    if (!this._bootT) {
      this._bootT = { ready: false, readyAt: 0, last: now, good: 0, frames: 0 };
      const ready = this.game.terrain?.ready;
      Promise.resolve(ready).then(() => {
        this._bootT.ready = true;
        this._bootT.readyAt = performance.now();
        boot?.set('textures', 1);
      });
    }
    const b = this._bootT;
    const gap = now - b.last;
    b.last = now;
    if (!b.ready) {
      boot?.set('shaders', 0);
      return;
    }
    b.frames++;
    b.good = gap < 100 ? b.good + 1 : 0;
    // creeps while frames compile, completes on the steady run
    boot?.set('shaders', Math.min(0.9, b.frames / 12) + (b.good / 3) * 0.1);
    if (b.good >= 3 || now - b.readyAt > 15000) {
      boot?.set('shaders', 1);
      this._bootDone();
    }
  }

  update(dt) {
    if (this.mock && this.screen === 'sortie') this.mock.update(dt);
  }

  lateUpdate(dt) {
    this._t += dt;
    if (!this._booted) this._bootTick();
    if (MENU_SCREENS.has(this.screen) || this.screen === 'boot') this._titleCamera(dt);
    // HUD animation runs on wall-clock time: slow motion, a kill cam or a
    // frozen sim (timeScale 0) must not stall callouts, fades and blinks.
    const now = performance.now();
    const rdt = Math.min(0.1, (now - (this._hudLast ?? now)) / 1000);
    this._hudLast = now;
    // Button rects change only on resize, rotation or mode switch; a
    // twice-a-second re-read covers all three without wiring each one.
    this._occT = (this._occT ?? 0) - rdt;
    if (this._occT <= 0) {
      this._occT = 0.5;
      this.hud.occluders = this.touchControls.occluders();
    }
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
    // Title, sorties and briefing are gameplay flow states: ask the flow, and
    // its ui:screen answer shows the screen (handler below).
    if (this._flowGo(id, arg)) return;
    this.show(id, arg);
    this.game.events.emit('ui:screen', { screen: id, source: 'ui' });
  }

  back() {
    const prev = this.history.pop();
    if (prev && prev !== 'boot' && prev !== 'loading') {
      if (this._flowGo(prev, prev === 'briefing' ? { id: this.briefingId } : undefined)) return;
      this.show(prev);
      this.game.events.emit('ui:screen', { screen: prev, source: 'ui' });
    } else if (this.screen !== 'title') {
      if (this._flowGo('title')) return;
      this.show('title');
    }
  }

  /** Route a flow-owned screen through game.flow; false if the UI should show it. */
  _flowGo(id, arg) {
    const f = this.flow;
    if (!f.real) return false;
    const want = { title: 'title', missionSelect: 'select', briefing: 'briefing' }[id];
    if (!want) return false;
    if (f.state === want && want !== 'briefing') return false; // already there (e.g. back from settings)
    if (id === 'title') return f.toTitle();
    if (id === 'missionSelect') return f.openSelect();
    const mid = arg?.id ?? this.briefingId;
    return mid ? f.openBriefing(mid) : false;
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
    if (this._cineOn && !MENU_SCREENS.has(id) && id !== 'boot') this.game.cameraRig?.stopCinematic?.();
    if (id === 'sortie' && prev !== 'pause') {
      const rig = this.game.cameraRig;
      const view = this.settings.defaultCamera;
      if (rig?.setMode && view) rig.setMode(view);
    }
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
    // Gameplay's flow decides when remembrance is shown (it comes before the
    // debrief, on a loss or a mission that asks for it); just move on.
    if (this.flow.real) return this.flow.quitToMenu();
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
    if (this.flow.real?.state === 'remembrance') return void this.flow.confirm(); // -> debrief
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
      if (!this._booted) return; // _bootDone() picks up the flow's state
      const id = toUiScreen(p.screen);
      if (id === 'sortie') {
        if (this.screen !== 'pause' && this.screen !== 'settings') this.hud.clearTransient();
        this.show('sortie');
        return;
      }
      if (!this.screens[id]) return;
      // Flow-driven menu steps get a deterministic Back stack.
      if (id === 'title') this.history = [];
      else if (id === 'missionSelect') this.history = ['title'];
      else if (id === 'briefing') {
        this.history = ['title', 'missionSelect'];
        this.briefingId = p.mission?.id ?? this.briefingId;
      } else if (id === 'debrief' && p.result) {
        const best = this.lastResult?.best ?? this.flow.mission(p.result.missionId)?.bestScore;
        this.lastResult = resultFromFlow(p.result, this.lastResult);
        this.lastResult.best = best;
      }
      this.show(id, p);
    });
    // Input's own mode toggle (M) keeps the setting in step.
    ev.on('controls:mode', (p) => {
      if (p?.mode && p.mode !== this.settings.controlMode) this.settings.set('controlMode', p.mode);
    });
    ev.on('loading:progress', (p) => {
      this.screens.loading.setProgress(p.progress ?? 0, p.label);
      globalThis.__ssBoot?.set('mission', p.progress ?? 0, p.label);
    });
    const onEnd = (success) => (p = {}) => {
      if (this.flow.real) {
        // Gameplay persists records and follows with ui:screen remembrance
        // or debrief after its outro; just keep the result and mark the moment.
        this.lastResult = resultFromFlow(p.result ?? {}, null, success);
        this.lastResult.best = this.flow.mission(p.result?.missionId)?.bestScore ?? undefined;
        const name = p.mission?.name ?? p.result?.name ?? '';
        if (success) this.hud.showBanner('MISSION COMPLETE', name, 4);
        else this.hud.showBanner('SORTIE ENDED', p.result?.reason === 'time' ? 'The window has closed' : name, 3.5);
        return;
      }
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
      this._missionStartAt = performance.now();
      const m = p?.mission;
      const where = typeof m?.location === 'string' ? m.location : m?.location?.name ?? '';
      if (m) this.hud.showBanner(m.name?.toUpperCase?.() ?? 'SORTIE', where, 4);
    });
    ev.on('mission:phase', (p) => {
      const ph = p?.phase;
      // the first phase arrives with mission:start; its banner already shows
      if (performance.now() - (this._missionStartAt ?? 0) < 1500) return;
      const text = typeof ph === 'string' ? ph : ph?.objective ?? ph?.text ?? ph?.name ?? '';
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
      if (t.isAce || t.fighter?.ace || t.kind === 'ace') this.hud.callout('ace', 'LEAD DOWN', pts, 3);
      else if (isGround(t)) this.hud.callout('ground', 'NEUTRALISED', pts);
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
    for (const k of [
      'hudColor', 'reducedMotion', 'subtitleSize', 'controlMode', 'invertY', 'cameraFov', 'cameraShake', 'killCam', 'missileCam',
      'brightness', 'motionBlur', 'lensFlare', 'filmGrain', 'masterVolume', 'musicVolume', 'sfxVolume', 'radioVolume',
    ]) this._onSetting(k, this.settings[k], true);
  }

  _onSetting(key, value, initial = false) {
    const g = this.game;
    const post = g.post?.options;
    const cam = g.cameraRig?.options;
    // Audio owns its buses and persists them; Settings stays the source of
    // truth so one menu drives everything. The UI bus follows effects.
    const audio = g.systems?.audio;
    const BUS = { masterVolume: 'master', musicVolume: 'music', sfxVolume: 'sfx', radioVolume: 'radio' };
    if (BUS[key] && audio?.setVolume) {
      audio.setVolume(BUS[key], value);
      if (key === 'sfxVolume') audio.setVolume('ui', value);
    }
    switch (key) {
      case 'brightness':
        if (post) post.exposureCompensation = value;
        break;
      case 'motionBlur':
        if (post) post.motionBlur = value;
        break;
      case 'lensFlare':
        if (post) post.flare = !!value;
        break;
      case 'filmGrain':
        if (post) post.grain = !!value;
        break;
      case 'cameraShake':
        if (cam) cam.shake = value;
        break;
      case 'killCam':
        if (cam) cam.killCam = !!value;
        break;
      case 'missileCam':
        if (cam) cam.missileCam = !!value;
        break;
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
      case 'reducedMotion': {
        const rm = this.settings.prefersReducedMotion;
        document.documentElement.dataset.reducedMotion = String(rm);
        if (post) post.reducedMotion = rm;
        if (cam) cam.reducedMotion = rm;
        break;
      }
      case 'subtitleSize':
        document.documentElement.dataset.subtitles = value;
        break;
      case 'controlMode':
        this.touchControls?.setMode(value);
        if (g.input?.setMode && g.input.mode !== value) g.input.setMode(value);
        break;
      case 'invertY':
        if (g.input && 'invertPitch' in g.input) g.input.invertPitch = !!value;
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
    // The camera owner's 'title' cinematic when it exists (it loops until
    // stopped); the orbit below is the fallback for builds without it.
    const rig = g.cameraRig;
    if (rig?.playCinematic && !this._cineFailed) {
      if (!this._cineOn) {
        this._cineOn = true;
        rig.playCinematic('title').then(
          () => (this._cineOn = false),
          (e) => {
            this._cineOn = false;
            this._cineFailed = true;
            console.warn('[ui] title cinematic unavailable, using the ui orbit', e);
          },
        );
      }
      return;
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

/**
 * Debrief view of gameplay's result (src/missions/system.js _onEnd):
 * {completed, score, rank, kills, accuracy, time, reason, reasonText, newBest, name}.
 */
function resultFromFlow(r, prev, success) {
  if (!r) return prev;
  return {
    success: r.completed ?? success ?? prev?.success ?? false,
    name: r.name,
    score: r.score ?? 0,
    rank: r.rank ?? null,
    kills: r.kills,
    accuracy: r.accuracy,
    time: r.time,
    reason: r.reason,
    reasonText: r.reasonText ?? null,
    best: prev?.best,
    isNewBest: r.newBest === true,
  };
}

const _v = new THREE.Vector3();
const _d = new THREE.Vector3();
const _r = new THREE.Vector3();
const _t = new THREE.Vector3();

function autoTier(r) {
  if (r?.backend !== 'webgpu') return 'low';
  return matchMedia('(pointer: coarse)').matches ? 'low' : 'high';
}
