// Game flow: a small, renderer-agnostic state machine the UI renders from.
//
//   title -> select -> briefing -> sortie <-> pause
//                                    |
//                                    v
//                         (remembrance) -> debrief -> select / retry
//
// Every transition emits `ui:screen` `{screen, ...data}` (and `flow:state`).
// The UI owner draws screens from that event or by polling `flow.state`,
// `flow.missions`, `flow.selected`, `flow.result`, and calls the methods
// below from its buttons. Flow itself owns only the pause key.
//
// While no UI system is registered, a keyboard fallback drives the flow:
// Enter = continue, Backspace = back, 1-5 = pick a mission, R = cycle the
// special weapon in the briefing. Set `flow.fallbackKeys = false` to disable.
import { Autopilot } from './Autopilot.js';
import { DIFFICULTY_LEVELS, DEFAULT_DIFFICULTY, difficultyFor, difficultyList } from './difficulty.js';

const DIFFICULTY_KEY = 'safedsagar.v2.difficulty';

export const FLOW_STATES = ['boot', 'title', 'select', 'briefing', 'sortie', 'pause', 'remembrance', 'debrief'];

export class Flow {
  constructor(game) {
    this.game = game;
    this.state = 'boot';
    /** Mission id chosen on the select screen. */
    this.selected = null;
    /** Special weapon id chosen in the briefing. */
    this.special = null;
    /** Result of the last sortie (see MissionSystem._onEnd for the shape). */
    this.result = null;
    /** null = auto (on while no ui system exists). */
    this.fallbackKeys = null;
    /** Title/menu flyby: `{active, subject}` for the camera owner to frame. */
    this.cinematic = { active: false, subject: game.player.group };
    this._last = null;
    /** 'easy' | 'normal' | 'hard' (see difficulty.js). Change with setDifficulty. */
    this.difficulty = DEFAULT_DIFFICULTY;

    game.events.on('flow:missionEnd', ({ result }) => this._onMissionEnd(result));
    // The settings screen writes the `difficulty` key; follow it.
    game.events.on('settings:change', ({ key, value }) => { if (key === 'difficulty') this._applyDifficulty(value); });
    const doc = globalThis.document;
    doc?.addEventListener?.('visibilitychange', () => { if (doc.hidden) this.pause(); });
  }

  get ms() { return this.game.systems.missions; }

  /** Mission list with metadata, unlock state and best results, for menus. */
  get missions() { return this.ms?.meta() ?? []; }

  get mission() { return this.missions.find((m) => m.id === this.selected) ?? null; }

  /** Difficulty rows for a menu: `[{id, label, description}]`. */
  get difficulties() { return difficultyList(); }

  /** Choose a difficulty. Persists (settings key `difficulty`) and applies at once. */
  setDifficulty(level) {
    if (!DIFFICULTY_LEVELS.includes(level)) return false;
    const settings = this.game.settings;
    if (settings?.set) settings.set('difficulty', level);
    else { try { globalThis.localStorage?.setItem(DIFFICULTY_KEY, level); } catch { /* unavailable */ } }
    this._applyDifficulty(level);
    return true;
  }

  _applyDifficulty(level) {
    if (!DIFFICULTY_LEVELS.includes(level)) return;
    const game = this.game;
    const changed = level !== this.difficulty;
    this.difficulty = level;
    const d = difficultyFor(level);
    if (game.systems.combat) game.systems.combat.world.difficulty = d;
    game.systems.ai?.setDifficulty?.(d);
    if (changed) game.events.emit('flow:difficulty', { difficulty: level, ...d });
  }

  /** Called once by Game after every system is initialised. */
  boot() {
    const q = new URLSearchParams(globalThis.location?.search ?? '');
    let stored = null;
    try { stored = globalThis.localStorage?.getItem(DIFFICULTY_KEY) ?? null; } catch { /* unavailable */ }
    this._applyDifficulty(q.get('difficulty') ?? this.game.settings?.difficulty ?? stored ?? DEFAULT_DIFFICULTY);
    const id = q.get('mission');
    if (id && this.missions.some((m) => m.id === id)) this.startMission(id, { special: q.get('special') ?? undefined });
    else this.toTitle();
  }

  _set(state, data = {}) {
    this.state = state;
    this.game.events.emit('flow:state', { state, ...data });
    this.game.events.emit('ui:screen', { screen: state, ...data });
  }

  _cinematic(on) {
    const game = this.game;
    if (on === this.cinematic.active) return;
    this.cinematic.active = on;
    if (on) {
      const ap = Autopilot.valleyFlyby();
      game.autopilot = ap;
      game.playerControl = false;
      game.spawnAt(ap.start());
      game.events.emit('camera:request', { mode: 'cinematic', subject: this.cinematic.subject });
    } else {
      game.autopilot = null;
      game.events.emit('camera:request', { mode: 'restore' });
    }
  }

  _menuMusic(state = 'menu') { this.game.events.emit('music:intensity', { level: 0.2, state }); }

  // ---------------------------------------------------------------- API --

  toTitle() {
    this.ms?.stop();
    this.game.paused = false;
    this._cinematic(true);
    this._menuMusic();
    this._set('title');
  }

  openSelect() {
    this.ms?.stop();
    this.game.paused = false;
    this._cinematic(true);
    this._menuMusic();
    const list = this.missions;
    if (!this.selected) this.selected = (list.filter((m) => m.unlocked && !m.free && !m.best?.completed)[0] ?? list[0])?.id ?? null;
    this._set('select', { missions: list, selected: this.selected });
  }

  /** Choose a mission and open its briefing. Locked missions are refused. */
  selectMission(id) {
    const m = this.missions.find((x) => x.id === id);
    if (!m || !m.unlocked) return false;
    this.selected = id;
    this.special = m.special;
    this._menuMusic('briefing');
    this._set('briefing', { mission: m, special: this.special });
    return true;
  }

  setSpecial(id) {
    const m = this.mission;
    if (!m || !m.specials.some((s) => s.id === id)) return false;
    this.special = id;
    this.game.events.emit('flow:special', { special: id });
    return true;
  }

  startMission(id = this.selected, { special = this.special } = {}) {
    const game = this.game;
    const m = this.missions.find((x) => x.id === id);
    if (!m) return false;
    this.selected = id;
    this._cinematic(false);
    game.paused = false;
    game.input.resetForLaunch?.();
    this._applyDifficulty(this.difficulty);
    if (!this.ms.start(id, { special })) return false;
    this.special = this.ms.special;
    this._last = { id, special: this.special };
    game.playerControl = true;
    this.result = null;
    this._set('sortie', { mission: m, special: this.special });
    return true;
  }

  pause() {
    if (this.state !== 'sortie') return false;
    this.game.paused = true;
    this.game.input.releaseAll?.();
    this._set('pause', { mission: this.mission });
    return true;
  }

  resume() {
    if (this.state !== 'pause') return false;
    this.game.paused = false;
    this._set('sortie', { mission: this.mission, resumed: true });
    return true;
  }

  retry() {
    if (!this._last) return false;
    return this.startMission(this._last.id, { special: this._last.special });
  }

  quitToMenu() {
    this.game.playerControl = false;
    this.openSelect();
  }

  _onMissionEnd(result) {
    this.result = result;
    this.game.playerControl = false;
    this.ms.stop();
    this._cinematic(true);
    if (result.remembrance) {
      this._menuMusic('memorial');
      this._set('remembrance', { remembrance: result.remembrance, result });
    }
    else this._set('debrief', { result });
  }

  /** Generic "continue" for whatever screen is up. */
  confirm() {
    switch (this.state) {
      case 'title': return this.openSelect();
      case 'select': return this.selectMission(this.selected ?? this.missions[0]?.id);
      case 'briefing': return this.startMission();
      case 'pause': return this.resume();
      case 'remembrance': this._menuMusic(this.result?.completed ? 'victory' : 'defeat'); return this._set('debrief', { result: this.result });
      case 'debrief': return this.openSelect();
      default: return false;
    }
  }

  back() {
    switch (this.state) {
      case 'select': return this.toTitle();
      case 'briefing': return this.openSelect();
      case 'pause': return this.quitToMenu();
      case 'debrief': return this.retry();
      default: return false;
    }
  }

  // ------------------------------------------------------------- update --

  /** Runs every frame, paused or not. `dt` is real seconds. */
  update() {
    const game = this.game;
    const input = game.input;
    input.capture = this.state === 'sortie';
    if (input.pressed.pause) {
      if (this.state === 'sortie') this.pause();
      else if (this.state === 'pause') this.resume();
    }
    const fallback = this.fallbackKeys ?? !(game.systems.ui || game.systems.hud || game.systems.screens);
    if (!fallback || this.state === 'sortie') return;
    if (input.pressed.confirm) this.confirm();
    else if (input.pressed.back) this.back();
    else if (this.state === 'select') {
      const list = this.missions;
      for (let i = 0; i < list.length; i++) {
        if (input.consumePress(`Digit${i + 1}`) && list[i].unlocked) this.selected = list[i].id, this._set('select', { missions: list, selected: this.selected });
      }
    } else if (this.state === 'briefing' && input.pressed.switchWeapon) {
      const m = this.mission;
      const i = m.specials.findIndex((s) => s.id === this.special);
      this.setSpecial(m.specials[(i + 1) % m.specials.length].id);
    }
  }
}
