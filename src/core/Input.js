/**
 * Keyboard / mouse / gamepad input, normalised into flight axes.
 *
 * Axes are smoothed toward their target rather than snapping. A jet's stick is
 * not a switch, and raw digital keys applied straight to a rate controller feel
 * like a spreadsheet. The smoothing time constants here are part of the flight
 * feel, not a UI nicety.
 */

const AXIS_ATTACK = 7.0; // how fast a key press reaches full deflection
const AXIS_RELEASE = 9.5; // how fast it centres again

export class Input {
  constructor(target = window) {
    this.keys = new Set();
    this.pitch = 0;
    this.roll = 0;
    this.yaw = 0;
    this.throttle = 0.72;
    this.brake = 0;
    this.reconHeld = false;
    this.enabled = true;

    // Touch state. `touchActive` latches on first use so a desktop session is
    // never affected by these being present.
    this.touchActive = false;
    this.touchRecon = false;
    this._touchPitch = undefined;
    this._touchRoll = undefined;
    this._touchThrottle = undefined;

    this._pitchTarget = 0;
    this._rollTarget = 0;
    this._yawTarget = 0;

    this.mouseMode = false;
    this._mouseX = 0;
    this._mouseY = 0;

    // Edge-triggered actions consumed once per frame by the game.
    this._pressed = new Set();

    this._onKeyDown = (e) => {
      if (e.repeat) return;
      // Never swallow browser-level combinations.
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      this.keys.add(e.code);
      this._pressed.add(e.code);
      if (PREVENT_DEFAULT.has(e.code)) e.preventDefault();
    };
    this._onKeyUp = (e) => this.keys.delete(e.code);
    this._onBlur = () => {
      this.keys.clear();
      this._pitchTarget = this._rollTarget = this._yawTarget = 0;
    };
    this._onMouseMove = (e) => {
      if (!this.mouseMode) return;
      this._mouseX = e.clientX / window.innerWidth - 0.5;
      this._mouseY = e.clientY / window.innerHeight - 0.5;
    };

    target.addEventListener('keydown', this._onKeyDown);
    target.addEventListener('keyup', this._onKeyUp);
    target.addEventListener('blur', this._onBlur);
    target.addEventListener('mousemove', this._onMouseMove);
    this._target = target;
  }

  // ------------------------------------------------------------- touch --
  //
  // Touch writes into the same targets the keyboard does, so the smoothing,
  // the flight model and the game state machine never learn which input is
  // driving. The only difference is that touch axes are analogue and arrive
  // pre-shaped, so update() must not overwrite them with key state.

  setTouchAxes(pitch, roll) {
    this.touchActive = true;
    this._touchPitch = pitch;
    this._touchRoll = roll;
  }

  setTouchThrottle(t) {
    this.touchActive = true;
    this._touchThrottle = t;
  }

  toggleTouchRecon() {
    this.touchRecon = !this.touchRecon;
    this.touchActive = true;
  }

  /** Fire an edge-triggered action from an on-screen button. */
  pressTouch(code) {
    this.touchActive = true;
    this._pressed.add(code);
  }

  /** True once, on the frame a key went down. */
  consumePress(code) {
    if (!this._pressed.has(code)) return false;
    this._pressed.delete(code);
    return true;
  }

  anyPress() {
    return this._pressed.size > 0;
  }

  clearPresses() {
    this._pressed.clear();
  }

  get gamepad() {
    if (!navigator.getGamepads) return null;
    const pads = navigator.getGamepads();
    for (const p of pads) if (p && p.connected) return p;
    return null;
  }

  update(dt, invertPitch = false) {
    if (!this.enabled) {
      this._pitchTarget = this._rollTarget = this._yawTarget = 0;
    } else {
      const k = this.keys;
      let p = (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0) - (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0);
      let r = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
      let y = (k.has('KeyE') ? 1 : 0) - (k.has('KeyQ') ? 1 : 0);

      const pad = this.gamepad;
      if (pad) {
        const dz = (v) => (Math.abs(v) < 0.14 ? 0 : (v - Math.sign(v) * 0.14) / 0.86);
        const ax0 = dz(pad.axes[0] ?? 0);
        const ax1 = dz(pad.axes[1] ?? 0);
        if (ax0) r = ax0;
        if (ax1) p = ax1;
        const lt = pad.buttons[6]?.value ?? 0;
        const rt = pad.buttons[7]?.value ?? 0;
        if (rt > 0.02 || lt > 0.02) this.throttle = Math.min(1, Math.max(0, this.throttle + (rt - lt) * dt * 1.1));
        const yawAxis = dz(pad.axes[2] ?? 0);
        if (yawAxis) y = yawAxis;
      }

      if (this.mouseMode) {
        p = Math.max(-1, Math.min(1, this._mouseY * 2.6));
        r = Math.max(-1, Math.min(1, this._mouseX * 2.6));
      }

      // Touch overrides, applied last so an on-screen stick wins over the
      // (absent) keys rather than being averaged with them. Only axes the
      // player is actually touching are taken: with no thumb down the stick
      // reports zero, which is what a released stick should mean.
      if (this.touchActive) {
        if (this._touchPitch !== undefined) p = this._touchPitch;
        if (this._touchRoll !== undefined) r = this._touchRoll;
        if (this._touchThrottle !== undefined) this.throttle = this._touchThrottle;
      }

      this._pitchTarget = invertPitch ? -p : p;
      this._rollTarget = r;
      this._yawTarget = y;

      if (k.has('ShiftLeft') || k.has('ShiftRight')) {
        this.throttle = Math.min(1, this.throttle + dt * 0.62);
      }
      if (k.has('ControlLeft') || k.has('ControlRight')) {
        this.throttle = Math.max(0, this.throttle - dt * 0.62);
      }
      this.brake = k.has('KeyZ') ? 1 : 0;
      this.reconHeld =
        k.has('Space') || !!this.gamepad?.buttons[5]?.value || this.touchRecon === true;
    }

    this.pitch = approach(this.pitch, this._pitchTarget, dt);
    this.roll = approach(this.roll, this._rollTarget, dt);
    this.yaw = approach(this.yaw, this._yawTarget, dt);
  }

  dispose() {
    this._target.removeEventListener('keydown', this._onKeyDown);
    this._target.removeEventListener('keyup', this._onKeyUp);
    this._target.removeEventListener('blur', this._onBlur);
    this._target.removeEventListener('mousemove', this._onMouseMove);
  }
}

const PREVENT_DEFAULT = new Set([
  'Space',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Tab',
]);

/**
 * Frame-rate independent approach. Using a plain lerp with a per-frame alpha
 * makes control response depend on frame rate, which is exactly the kind of
 * thing that makes a game feel different on two machines.
 */
function approach(current, target, dt) {
  const rate = Math.abs(target) > Math.abs(current) ? AXIS_ATTACK : AXIS_RELEASE;
  return current + (target - current) * (1 - Math.exp(-rate * dt));
}
