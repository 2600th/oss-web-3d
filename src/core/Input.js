/**
 * Keyboard / gamepad / touch input, normalised into flight axes.
 *
 * Axes are smoothed toward their target rather than snapping. A jet's stick is
 * not a switch, and raw digital keys applied straight to a rate controller feel
 * like a spreadsheet. The smoothing time constants here are part of the flight
 * feel, not a UI nicety.
 *
 * There is deliberately no mouse-flying path. One existed here — a `mouseMode`
 * flag, a mousemove listener and a branch that overrode pitch and roll from the
 * cursor — but nothing ever set the flag, so it was unreachable from the first
 * commit. Wiring it up properly would mean pointer lock (a free cursor over a
 * fullscreen canvas cannot express a centred stick), and pointer lock needs a
 * click to enter, which is the same click the title sequence uses to skip. A
 * half-wired input mode is worse than none, so the path is gone rather than
 * left as scaffolding: the game is flown on keys, a pad, or glass.
 */

const AXIS_ATTACK = 7.0; // how fast a key press reaches full deflection
const AXIS_RELEASE = 9.5; // how fast it centres again

const TEXT_ENTRY_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

/**
 * Is this keystroke being typed into a text field rather than flown with?
 *
 * The listener is on `window`, so anything typed into a control in the UI layer
 * bubbles up to it. Until the leaderboard there were no text fields anywhere in
 * the experience and it never mattered; with one, it mattered twice over.
 * Recording the key meant Enter in the callsign field also reached the debrief's
 * `consumePress('Enter')` and restarted the sortie in the same frame the score
 * was saved — the player never saw their rank. Suppressing the key meant Space
 * was preventDefaulted, so a callsign with a space in it could not be typed at
 * all, even though sanitiseName accepts one.
 */
function isTextEntry(node) {
  if (!node) return false;
  if (TEXT_ENTRY_TAGS.has(node.tagName)) return true;
  return node.isContentEditable === true;
}

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
    this.intent = {
      turn: 0,
      climb: 0,
      speed: 0,
      boost: false,
      brake: 0,
      throttle: 0.72,
    };
    this.modality = 'keyboard';

    // Touch state. `touchActive` latches on first use so a desktop session is
    // never affected by these being present.
    this.touchActive = false;
    this.touchRecon = false;
    this.touchBoost = false;
    this._touchPitch = null;
    this._touchRoll = null;
    this._touchThrottle = null;

    this._pitchTarget = 0;
    this._rollTarget = 0;
    this._yawTarget = 0;

    // Edge-triggered actions consumed once per frame by the game.
    this._pressed = new Set();

    // Sampled once per update(); see the getter below.
    this._pad = null;
    this._padReleaseQuarantined = false;
    this._reconWasHeld = false;

    this._onKeyDown = (e) => {
      if (e.repeat) return;
      // Keys typed into a text field are text, not controls: neither recorded
      // nor suppressed. Checked before `keys.add` so a field cannot leave a
      // key stuck down either.
      if (isTextEntry(e.target)) return;
      // Command is the one modifier still refused outright. macOS does not
      // deliver keyup for a character key while Command is held, so anything
      // recorded during a Cmd chord would stay in `keys` for the rest of the
      // session and fly the aircraft on its own. Ctrl and Alt do deliver keyup,
      // and losing the window to a shortcut fires blur, which clears the set.
      if (e.metaKey) return;
      this.modality = 'keyboard';
      this.keys.add(e.code);
      this._pressed.add(e.code);
      // Suppressing the default is what would swallow a browser shortcut —
      // *recording* the key never could. The original guard returned early on
      // any modifier, which meant Control's own keydown never reached `keys`
      // (ctrlKey is already true on it), so the advertised throttle-down
      // binding was unreachable and every other key was dropped for as long as
      // Ctrl was held — i.e. for the whole time the player was pulling the
      // throttle back. Gating the suppression instead gives both: Ctrl+R still
      // reloads because we never call preventDefault on it, and bare Ctrl is an
      // ordinary binding. Shift is excluded from the test because Shift is
      // itself a binding and forms no browser accelerator with Space or Tab.
      if (PREVENT_DEFAULT.has(e.code) && !e.ctrlKey && !e.altKey) e.preventDefault();
    };
    this._onKeyUp = (e) => this.keys.delete(e.code);
    this._onBlur = () => this.releaseAll();
    this._onVisibilityChange = () => {
      if (this._document.hidden) this.releaseAll();
    };

    target.addEventListener('keydown', this._onKeyDown);
    target.addEventListener('keyup', this._onKeyUp);
    target.addEventListener('blur', this._onBlur);
    this._document = target.document ?? globalThis.document ?? null;
    this._document?.addEventListener('visibilitychange', this._onVisibilityChange);
    this._target = target;
  }

  // ------------------------------------------------------------- touch --
  //
  // Touch writes into the same targets the keyboard does, so the smoothing,
  // the flight model and the game state machine never learn which input is
  // driving. The only difference is that touch axes are analogue and arrive
  // pre-shaped, so update() must not overwrite them with key state.

  /**
   * @param {number|null} pitch  null when the stick is released
   * @param {number|null} roll
   */
  setTouchAxes(pitch, roll) {
    if (pitch !== null) this.modality = 'touch';
    this.touchActive = pitch !== null;
    this._touchPitch = pitch;
    this._touchRoll = roll;
  }

  setTouchThrottle(t) {
    this.modality = 'touch';
    this._touchThrottle = t;
  }

  // Only a *press* claims the modality. Releasing does not: the touch layer
  // clears held input on mode change, on blur and when it disables itself,
  // and a release that announced "touch" would relabel a desktop session's
  // control legend with drag gestures before the player ever touched a
  // screen — which is exactly what setEnabled(false) did on every load.
  setTouchBoost(held) {
    if (held === true) this.modality = 'touch';
    this.touchBoost = held === true;
  }

  toggleTouchRecon() {
    this.modality = 'touch';
    this.touchRecon = !this.touchRecon;
    this.touchActive = true;
  }

  /** Drop all held touch input; used on blur, capture loss and sortie start. */
  releaseTouch() {
    this.touchActive = false;
    this._touchPitch = null;
    this._touchRoll = null;
  }

  /** Fire an edge-triggered action from an on-screen button. */
  pressTouch(code) {
    this.modality = 'touch';
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

  /**
   * Clear every transient input source without changing the positional
   * throttle. Lifecycle safety releases (blur, pause, visibility and dispose)
   * must not silently move the Direct-mode throttle lever.
   */
  releaseAll() {
    this.keys.clear();
    this._pressed.clear();
    this._pitchTarget = this._rollTarget = this._yawTarget = 0;
    this.touchActive = false;
    this.touchRecon = false;
    this.touchBoost = false;
    this._touchPitch = null;
    this._touchRoll = null;
    this._touchThrottle = null;
    this._pad = null;
    this._padReleaseQuarantined = true;
    this._reconWasHeld = false;
    this.reconHeld = false;
    this.brake = 0;
    this.pitch = this.roll = this.yaw = 0;
    setNeutralIntent(this.intent, this.throttle);
  }

  /** Reset transient input and the throttle baseline for a new sortie. */
  resetForLaunch(throttle = 0.72) {
    this.releaseAll();
    this.throttle = Number.isFinite(throttle) ? Math.min(1, Math.max(0, throttle)) : 0.72;
    setNeutralIntent(this.intent, this.throttle);
  }

  /**
   * The active gamepad, as sampled at the top of this frame's update().
   *
   * navigator.getGamepads() is not a cheap accessor: the spec requires it to
   * return a *fresh* array of freshly snapshotted Gamepad objects on every
   * call, so reading it twice a frame — once for the axes, once for the recon
   * button — allocated two arrays and two pad snapshots per frame for the whole
   * session. Sampling once and caching costs nothing and cannot go stale within
   * a frame, since the browser only refreshes pad state between tasks anyway.
   */
  get gamepad() {
    return this._pad;
  }

  _sampleGamepad() {
    if (!navigator.getGamepads) return null;
    const pads = navigator.getGamepads();
    // Indexed rather than for..of: the iterator protocol allocates too, and
    // this runs every frame.
    for (let i = 0; i < pads.length; i++) {
      const p = pads[i];
      if (p && p.connected) return p;
    }
    return null;
  }

  update(dt, verticalMode = 'upToClimb') {
    this._pad = this._sampleGamepad();
    if (this._padReleaseQuarantined) {
      if (!this._pad || isPadNeutral(this._pad)) this._padReleaseQuarantined = false;
      else this._pad = null;
    }
    const invertAnalogue = verticalMode === 'upToDive' || verticalMode === true;
    const intent = this.intent;
    setNeutralIntent(intent, this.throttle);

    if (!this.enabled) {
      this._pitchTarget = this._rollTarget = this._yawTarget = 0;
      this.reconHeld = false;
      this._reconWasHeld = false;
    } else {
      const k = this.keys;
      let p = (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0) - (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0);
      let r = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
      let y = (k.has('KeyE') ? 1 : 0) - (k.has('KeyQ') ? 1 : 0);
      let analogueVertical = false;
      intent.climb = p ? -p : 0;
      intent.turn = r;
      intent.speed = k.has('ControlLeft') || k.has('ControlRight') ? -1 : 0;
      intent.boost = k.has('ShiftLeft') || k.has('ShiftRight') || this.touchBoost;

      const pad = this._pad;
      if (pad) {
        const ax0 = deadzone(pad.axes[0] ?? 0);
        const ax1 = deadzone(pad.axes[1] ?? 0);
        if (ax0) {
          r = ax0;
          intent.turn = ax0;
        }
        if (ax1) {
          p = ax1;
          analogueVertical = true;
          intent.climb = invertAnalogue ? ax1 : -ax1;
        }
        const lt = pad.buttons[6]?.value ?? 0;
        const rt = pad.buttons[7]?.value ?? 0;
        if (rt > 0.02 || lt > 0.02) {
          const triggerSpeed = rt - lt;
          intent.speed = triggerSpeed;
          this.throttle = Math.min(1, Math.max(0, this.throttle + triggerSpeed * dt * 1.1));
        }
        const yawAxis = deadzone(pad.axes[2] ?? 0);
        if (yawAxis) y = yawAxis;
        if (ax0 || ax1 || yawAxis || rt > 0.02 || lt > 0.02 || hasPressedButton(pad.buttons)) {
          this.modality = 'gamepad';
        }
      }

      // Touch overrides, applied last so an on-screen stick wins over the keys
      // rather than being averaged with them — but ONLY while a thumb is
      // actually down.
      //
      // This used to latch: touchActive was set on first use and never cleared,
      // and release stored zeroes rather than clearing the axes, so from the
      // first touch onward every frame overwrote pitch and roll with 0. On a
      // tablet with a keyboard, or a touchscreen laptop, one tap disabled the
      // keyboard and the gamepad for the rest of the session.
      if (this.touchActive && this._touchPitch !== null) {
        p = this._touchPitch;
        r = this._touchRoll;
        analogueVertical = true;
        intent.climb = invertAnalogue ? p : -p;
        intent.turn = r;
      }
      // Throttle is a position rather than a rate, so the last touched value
      // does persist — but only until a key moves it, which the clauses below
      // are free to do.
      if (this._touchThrottle !== null) {
        this.throttle = this._touchThrottle;
        this._touchThrottle = null;
      }

      this._pitchTarget = analogueVertical && invertAnalogue ? -p : p;
      this._rollTarget = r;
      this._yawTarget = y;

      if (k.has('ShiftLeft') || k.has('ShiftRight')) {
        this.throttle = Math.min(1, this.throttle + dt * 0.62);
      }
      if (k.has('ControlLeft') || k.has('ControlRight')) {
        this.throttle = Math.max(0, this.throttle - dt * 0.62);
      }
      this.brake = k.has('KeyZ') ? 1 : 0;
      this.reconHeld = k.has('Space') || !!pad?.buttons[5]?.value || this.touchRecon === true;
      if (this.reconHeld && !this._reconWasHeld) this._pressed.add('Space');
      this._reconWasHeld = this.reconHeld;
      intent.brake = this.brake;
      intent.throttle = this.throttle;
    }

    this.pitch = approach(this.pitch, this._pitchTarget, dt);
    this.roll = approach(this.roll, this._rollTarget, dt);
    this.yaw = approach(this.yaw, this._yawTarget, dt);
  }

  dispose() {
    this.releaseAll();
    this._target.removeEventListener('keydown', this._onKeyDown);
    this._target.removeEventListener('keyup', this._onKeyUp);
    this._target.removeEventListener('blur', this._onBlur);
    this._document?.removeEventListener('visibilitychange', this._onVisibilityChange);
  }
}

function setNeutralIntent(intent, throttle) {
  intent.turn = 0;
  intent.climb = 0;
  intent.speed = 0;
  intent.boost = false;
  intent.brake = 0;
  intent.throttle = throttle;
}

function hasPressedButton(buttons) {
  for (let i = 0; i < buttons.length; i++) {
    if (buttons[i]?.value) return true;
  }
  return false;
}

function isPadNeutral(pad) {
  for (let i = 0; i < pad.axes.length; i++) {
    if (deadzone(pad.axes[i] ?? 0)) return false;
  }
  for (let i = 0; i < pad.buttons.length; i++) {
    if ((pad.buttons[i]?.value ?? 0) > 0.02) return false;
  }
  return true;
}

/** Analogue stick deadzone, rescaled so the usable range still reaches 1. */
function deadzone(v) {
  return Math.abs(v) < 0.14 ? 0 : (v - Math.sign(v) * 0.14) / 0.86;
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
