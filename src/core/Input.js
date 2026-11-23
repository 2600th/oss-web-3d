/**
 * Keyboard + mouse / gamepad / touch input, normalised into
 *
 *   axes      `pitch`, `roll`, `yaw` (-1..1, smoothed; +pitch = nose down,
 *             +roll = right, +yaw = right), `throttle` (0..1), `brake` (0..1)
 *   intent    `{turn, climb, yaw, speed, boost, brake, throttle}` — the
 *             semantic version the assisted (Standard) controller flies from
 *   actions   `input.actions.<name>` is true while held
 *   pressed   `input.pressed.<name>` is true for exactly one frame (the frame
 *             after the press), readable by any number of systems
 *   look      `{x, y}` right stick, for the camera owner
 *
 * Everything is driven from ONE data table, `DEFAULT_BINDINGS`. Rebinding is
 * `input.rebind(action, {keys, pad, mouse})`; the map persists in localStorage.
 *
 * Touch (the UI owner's TouchControls) drives the same state through
 * `setTouchAxes`, `setTouchThrottle`, `setAction(name, held)` and
 * `pressAction(name)`. The older `pressTouch(code)` / `setTouchBoost` /
 * `toggleTouchRecon` entry points still work and map onto actions.
 *
 * Node-safe: constructed in tests with a fake event target.
 */

/** Standard-mapping gamepad button indices. */
export const PAD = {
  A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, BACK: 8, START: 9,
  L3: 10, R3: 11, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15,
};

/**
 * The one control table. `keys` are KeyboardEvent.code values, `mouse` are
 * button indices (canvas only), `pad` are standard-mapping button indices.
 * Stick axes are fixed: left stick flies, right stick looks.
 */
export const DEFAULT_BINDINGS = {
  pitchDown:    { label: 'Nose down',        keys: ['KeyW', 'ArrowUp'] },
  pitchUp:      { label: 'Nose up',          keys: ['KeyS', 'ArrowDown'] },
  rollLeft:     { label: 'Roll / turn left', keys: ['KeyA', 'ArrowLeft'] },
  rollRight:    { label: 'Roll / turn right', keys: ['KeyD', 'ArrowRight'] },
  yawLeft:      { label: 'Yaw left',         keys: ['KeyQ'], pad: [PAD.LB] },
  yawRight:     { label: 'Yaw right',        keys: ['KeyE'], pad: [PAD.RB] },
  throttleUp:   { label: 'Accelerate / afterburner', keys: ['ShiftLeft', 'ShiftRight'], pad: [PAD.RT] },
  brake:        { label: 'Decelerate / airbrake (hold + pull = high-G turn)', keys: ['ControlLeft', 'KeyZ'], pad: [PAD.LT] },
  fireMissile:  { label: 'Fire missile / special', keys: ['Space'], mouse: [2], pad: [PAD.B] },
  fireGun:      { label: 'Gun',              keys: ['KeyF'], mouse: [0], pad: [PAD.A] },
  switchWeapon: { label: 'Switch weapon',    keys: ['KeyR'], pad: [PAD.X] },
  flares:       { label: 'Flares',           keys: ['KeyX'], pad: [PAD.L3] },
  targetNext:   { label: 'Next target',      keys: ['Tab', 'KeyT'], pad: [PAD.Y] },
  camera:       { label: 'Camera',           keys: ['KeyC'], pad: [PAD.BACK] },
  lookTarget:   { label: 'Look at target (hold)', keys: ['KeyG'], pad: [PAD.R3] },
  missileCam:   { label: 'Missile camera on/off', keys: ['KeyB'], pad: [PAD.RIGHT] },
  optic:        { label: 'Recon optic (hold)', keys: ['KeyV'], pad: [PAD.UP] },
  controlMode:  { label: 'Standard / Expert controls', keys: ['KeyM'], pad: [PAD.DOWN] },
  pause:        { label: 'Pause',            keys: ['Escape', 'KeyP'], pad: [PAD.START] },
  confirm:      { label: 'Confirm',          keys: ['Enter'], pad: [PAD.A] },
  back:         { label: 'Back',             keys: ['Backspace'], pad: [PAD.B] },
};

export const ACTIONS = Object.keys(DEFAULT_BINDINGS);
export const CONTROL_MODES = ['standard', 'expert'];

const STORAGE_KEY = 'safedsagar.v2.controls';
const AXIS_ATTACK = 9.0; // how fast a key press reaches full deflection
const AXIS_RELEASE = 11.0; // how fast it centres again
const CRUISE_THROTTLE = 0.8; // released lever; just under the reheat detent
const IDLE_THROTTLE = 0.12;
const TEXT_ENTRY_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

function isTextEntry(node) {
  if (!node) return false;
  if (TEXT_ENTRY_TAGS.has(node.tagName)) return true;
  return node.isContentEditable === true;
}

function cloneBindings(src) {
  const out = {};
  for (const [name, b] of Object.entries(src)) {
    out[name] = { label: b.label, keys: [...(b.keys ?? [])], mouse: [...(b.mouse ?? [])], pad: [...(b.pad ?? [])] };
  }
  return out;
}

function storage() {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

export class Input {
  constructor(target = globalThis.window) {
    this.enabled = true;
    /** When true, bound keys are preventDefault-ed even inside Ctrl chords. */
    this.capture = false;
    this.bindings = cloneBindings(DEFAULT_BINDINGS);
    this.mode = 'standard';
    /** false: S / stick-back pulls the nose up (flight convention). */
    this.invertPitch = false;
    this._loadPrefs();

    this.keys = new Set();
    this.mouseButtons = new Set();
    this.pitch = 0;
    this.roll = 0;
    this.yaw = 0;
    this.throttle = CRUISE_THROTTLE;
    this.brake = 0;
    this.look = { x: 0, y: 0 };
    this.modality = 'keyboard';
    this.intent = { turn: 0, climb: 0, yaw: 0, speed: 0, boost: false, brake: 0, throttle: CRUISE_THROTTLE };

    this.actions = {};
    this.pressed = {};
    for (const a of ACTIONS) { this.actions[a] = false; this.pressed[a] = false; }
    this._edgeQueue = new Set(); // actions pressed since the last update()
    this._consumed = new Set();
    this._virtual = new Set(); // actions held by touch / script
    this._pressedCodes = new Set(); // legacy consumePress(code)
    this._padPrev = [];
    this._pad = null;

    this._touchPitch = null;
    this._touchRoll = null;
    this._touchThrottle = null;
    this.touchActive = false;
    this.touchBoost = false;
    this.touchRecon = false;
    this._pitchTarget = this._rollTarget = this._yawTarget = 0;

    this._onKeyDown = (e) => {
      if (isTextEntry(e.target) || e.metaKey) return;
      const bound = this._actionsForKey(e.code);
      if (bound.length && (this.capture || (!e.ctrlKey && !e.altKey))) e.preventDefault?.();
      if (e.repeat) return;
      this.modality = 'keyboard';
      this.keys.add(e.code);
      this._pressedCodes.add(e.code);
      for (const a of bound) this._edgeQueue.add(a);
    };
    this._onKeyUp = (e) => this.keys.delete(e.code);
    this._onMouseDown = (e) => {
      if (e.target?.tagName !== 'CANVAS') return;
      this.modality = 'keyboard';
      this.mouseButtons.add(e.button);
      for (const [name, b] of Object.entries(this.bindings)) if (b.mouse.includes(e.button)) this._edgeQueue.add(name);
    };
    this._onMouseUp = (e) => this.mouseButtons.delete(e.button);
    this._onContextMenu = (e) => { if (e.target?.tagName === 'CANVAS') e.preventDefault?.(); };
    this._onBlur = () => this.releaseAll();
    this._onVisibilityChange = () => { if (this._document?.hidden) this.releaseAll(); };

    this._target = target ?? null;
    this._document = target?.document ?? globalThis.document ?? null;
    if (target?.addEventListener) {
      target.addEventListener('keydown', this._onKeyDown);
      target.addEventListener('keyup', this._onKeyUp);
      target.addEventListener('mousedown', this._onMouseDown);
      target.addEventListener('mouseup', this._onMouseUp);
      target.addEventListener('contextmenu', this._onContextMenu);
      target.addEventListener('blur', this._onBlur);
    }
    this._document?.addEventListener?.('visibilitychange', this._onVisibilityChange);
  }

  // ------------------------------------------------------------ bindings --

  _actionsForKey(code) {
    const out = [];
    for (const [name, b] of Object.entries(this.bindings)) if (b.keys.includes(code)) out.push(name);
    return out;
  }

  /** Replace the bindings of one action; any of keys / pad / mouse. */
  rebind(action, { keys, pad, mouse } = {}) {
    const b = this.bindings[action];
    if (!b) return false;
    if (keys) b.keys = [...keys];
    if (pad) b.pad = [...pad];
    if (mouse) b.mouse = [...mouse];
    this._savePrefs();
    return true;
  }

  resetBindings() {
    this.bindings = cloneBindings(DEFAULT_BINDINGS);
    this._savePrefs();
  }

  setMode(mode) {
    this.mode = mode === 'expert' ? 'expert' : 'standard';
    this._savePrefs();
    return this.mode;
  }

  _loadPrefs() {
    try {
      const raw = storage()?.getItem(STORAGE_KEY);
      if (!raw) return;
      const p = JSON.parse(raw);
      if (CONTROL_MODES.includes(p.mode)) this.mode = p.mode;
      this.invertPitch = p.invertPitch === true;
      for (const [name, b] of Object.entries(p.bindings ?? {})) {
        if (!this.bindings[name]) continue;
        for (const f of ['keys', 'pad', 'mouse']) if (Array.isArray(b[f])) this.bindings[name][f] = [...b[f]];
      }
    } catch { /* corrupt prefs: keep defaults */ }
  }

  _savePrefs() {
    try {
      const bindings = {};
      for (const [n, b] of Object.entries(this.bindings)) bindings[n] = { keys: b.keys, pad: b.pad, mouse: b.mouse };
      storage()?.setItem(STORAGE_KEY, JSON.stringify({ mode: this.mode, invertPitch: this.invertPitch, bindings }));
    } catch { /* storage unavailable */ }
  }

  // --------------------------------------------------------- touch/script --

  /** Hold or release an action from an on-screen control or a script. */
  setAction(name, held) {
    if (!(name in this.actions)) return;
    if (held) {
      if (!this._virtual.has(name)) this._edgeQueue.add(name);
      this._virtual.add(name);
    } else this._virtual.delete(name);
  }

  /** One-shot press of an action (edge only). */
  pressAction(name) {
    if (name in this.actions) this._edgeQueue.add(name);
  }

  /** @param {number|null} pitch +1 = nose down; null releases the stick. */
  setTouchAxes(pitch, roll) {
    if (pitch !== null) this.modality = 'touch';
    this.touchActive = pitch !== null;
    this._touchPitch = pitch;
    this._touchRoll = roll;
  }

  /** Absolute throttle lever (0..1); null returns to hold-to-accelerate. */
  setTouchThrottle(t) {
    if (t !== null) this.modality = 'touch';
    this._touchThrottle = t;
  }

  setTouchBoost(held) {
    if (held === true) this.modality = 'touch';
    this.touchBoost = held === true;
    this.setAction('throttleUp', held === true);
  }

  toggleTouchRecon() {
    this.modality = 'touch';
    this.touchRecon = !this.touchRecon;
    this.setAction('optic', this.touchRecon);
  }

  releaseTouch() {
    this.touchActive = false;
    this._touchPitch = null;
    this._touchRoll = null;
  }

  /** Legacy: fire an edge by key code from an on-screen button. */
  pressTouch(code) {
    this.modality = 'touch';
    this._pressedCodes.add(code);
    for (const a of this._actionsForKey(code)) this._edgeQueue.add(a);
  }

  // ---------------------------------------------------------------- edges --

  /** True once per press, for the first caller. Use `pressed` to share. */
  consume(action) {
    if (!this.pressed[action] || this._consumed.has(action)) return false;
    this._consumed.add(action);
    return true;
  }

  /** Legacy: true once, on the frame a raw key code went down. */
  consumePress(code) {
    return this._pressedCodes.delete(code);
  }

  anyPress() { return this._pressedCodes.size > 0 || this._edgeQueue.size > 0; }

  clearPresses() {
    this._pressedCodes.clear();
    this._edgeQueue.clear();
    for (const a of ACTIONS) this.pressed[a] = false;
  }

  releaseAll() {
    this.keys.clear();
    this.mouseButtons.clear();
    this._virtual.clear();
    this.clearPresses();
    this._pitchTarget = this._rollTarget = this._yawTarget = 0;
    this.touchActive = false;
    this.touchRecon = false;
    this.touchBoost = false;
    this._touchPitch = this._touchRoll = null;
    this.pitch = this.roll = this.yaw = 0;
    this.brake = 0;
    for (const a of ACTIONS) this.actions[a] = false;
    setNeutralIntent(this.intent, this.throttle);
  }

  resetForLaunch(throttle = CRUISE_THROTTLE) {
    this.releaseAll();
    this._touchThrottle = null;
    this.throttle = Number.isFinite(throttle) ? Math.min(1, Math.max(0, throttle)) : CRUISE_THROTTLE;
  }

  get gamepad() { return this._pad; }

  _sampleGamepad() {
    const nav = globalThis.navigator;
    if (!nav?.getGamepads) return null;
    const pads = nav.getGamepads();
    for (let i = 0; i < pads.length; i++) {
      const p = pads[i];
      if (p && p.connected && p.mapping !== 'xr-standard') return p;
    }
    return null;
  }

  // --------------------------------------------------------------- update --

  update(dt) {
    const pad = this._pad = this._sampleGamepad();

    // Held state per action, and pad edges.
    for (const name of ACTIONS) {
      const b = this.bindings[name];
      let held = this._virtual.has(name);
      for (let i = 0; !held && i < b.keys.length; i++) held = this.keys.has(b.keys[i]);
      for (let i = 0; !held && i < b.mouse.length; i++) held = this.mouseButtons.has(b.mouse[i]);
      if (pad) {
        for (let i = 0; i < b.pad.length; i++) {
          const idx = b.pad[i];
          const down = (pad.buttons[idx]?.value ?? 0) > 0.35 || pad.buttons[idx]?.pressed === true;
          if (down) held = true;
        }
      }
      this.actions[name] = this.enabled && held;
    }
    if (pad) {
      for (let i = 0; i < pad.buttons.length; i++) {
        const down = (pad.buttons[i]?.value ?? 0) > 0.35 || pad.buttons[i]?.pressed === true;
        if (down && !this._padPrev[i]) {
          this.modality = 'gamepad';
          for (const [name, b] of Object.entries(this.bindings)) if (b.pad.includes(i)) this._edgeQueue.add(name);
        }
        this._padPrev[i] = down;
      }
    }

    // Publish edges for this frame.
    this._consumed.clear();
    for (const a of ACTIONS) this.pressed[a] = this._edgeQueue.has(a);
    this._edgeQueue.clear();

    const intent = this.intent;
    if (!this.enabled) {
      this._pitchTarget = this._rollTarget = this._yawTarget = 0;
      this.brake = 0;
      setNeutralIntent(intent, this.throttle);
    } else {
      const a = this.actions;
      let p = (a.pitchDown ? 1 : 0) - (a.pitchUp ? 1 : 0);
      let r = (a.rollRight ? 1 : 0) - (a.rollLeft ? 1 : 0);
      const y = (a.yawRight ? 1 : 0) - (a.yawLeft ? 1 : 0);
      let accel = a.throttleUp ? 1 : 0;
      let brake = a.brake ? 1 : 0;

      if (pad) {
        const ax0 = deadzone(pad.axes[0] ?? 0);
        const ax1 = deadzone(pad.axes[1] ?? 0);
        if (ax0) r = ax0;
        if (ax1) p = -ax1; // stick back (positive axis) = nose up
        this.look.x = deadzone(pad.axes[2] ?? 0);
        this.look.y = deadzone(pad.axes[3] ?? 0);
        accel = Math.max(accel, pad.buttons[PAD.RT]?.value ?? 0);
        brake = Math.max(brake, pad.buttons[PAD.LT]?.value ?? 0);
        if (ax0 || ax1) this.modality = 'gamepad';
      } else {
        this.look.x = this.look.y = 0;
      }
      if (this.touchActive && this._touchPitch !== null) {
        p = this._touchPitch;
        r = this._touchRoll ?? 0;
      }
      if (this.invertPitch) p = -p;

      this._pitchTarget = p;
      this._rollTarget = r;
      this._yawTarget = y;

      // Arcade lever: hold to accelerate (into reheat), hold to brake, release
      // to return to cruise. A touch lever, when present, is absolute instead.
      let throttleTarget;
      if (this._touchThrottle !== null && !accel && !brake) throttleTarget = this._touchThrottle;
      else throttleTarget = CRUISE_THROTTLE + accel * (1 - CRUISE_THROTTLE) - brake * (CRUISE_THROTTLE - IDLE_THROTTLE);
      this.throttle += (throttleTarget - this.throttle) * (1 - Math.exp(-6 * dt));
      this.brake = brake;

      intent.turn = r;
      intent.climb = -p;
      intent.yaw = y;
      intent.speed = accel - brake;
      intent.boost = accel > 0.5;
      intent.brake = brake;
      intent.throttle = this.throttle;
    }

    this.pitch = approach(this.pitch, this._pitchTarget, dt);
    this.roll = approach(this.roll, this._rollTarget, dt);
    this.yaw = approach(this.yaw, this._yawTarget, dt);
  }

  dispose() {
    this.releaseAll();
    const t = this._target;
    if (t?.removeEventListener) {
      t.removeEventListener('keydown', this._onKeyDown);
      t.removeEventListener('keyup', this._onKeyUp);
      t.removeEventListener('mousedown', this._onMouseDown);
      t.removeEventListener('mouseup', this._onMouseUp);
      t.removeEventListener('contextmenu', this._onContextMenu);
      t.removeEventListener('blur', this._onBlur);
    }
    this._document?.removeEventListener?.('visibilitychange', this._onVisibilityChange);
  }
}

function setNeutralIntent(intent, throttle) {
  intent.turn = 0;
  intent.climb = 0;
  intent.yaw = 0;
  intent.speed = 0;
  intent.boost = false;
  intent.brake = 0;
  intent.throttle = throttle;
}

/** Analogue stick deadzone, rescaled so the usable range still reaches 1. */
function deadzone(v) {
  return Math.abs(v) < 0.14 ? 0 : (v - Math.sign(v) * 0.14) / 0.86;
}

/** Frame-rate independent approach toward the commanded deflection. */
function approach(current, target, dt) {
  const rate = Math.abs(target) > Math.abs(current) ? AXIS_ATTACK : AXIS_RELEASE;
  return current + (target - current) * (1 - Math.exp(-rate * dt));
}
