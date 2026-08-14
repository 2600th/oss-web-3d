/**
 * Touch flying.
 *
 * Feeds the same Input object the keyboard does, so nothing downstream knows or
 * cares which one is driving.
 *
 * Layout follows the one thing every flight-on-touch postmortem agrees on: a
 * *relative* stick, not a fixed one. The pad occupies a whole region of the
 * screen and the stick centre is wherever the thumb first lands, so the player
 * never has to look down to find it and never fights an origin their thumb has
 * drifted off. Absolute sticks work on a gamepad because the hardware recentres
 * itself; on glass they slowly become unusable.
 *
 * Tilt/gyro is deliberately not offered. It reads well in a demo and badly on a
 * sofa, it cannot be used lying down, it needs a permission prompt on iOS, and
 * it competes with the screen you are trying to look at.
 *
 * Throttle is a vertical strip rather than a second stick. Throttle is a
 * *position*, not a rate — a jet at 70% should stay at 70% with no thumb on the
 * screen — and a self-centring control cannot express that.
 */

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export class TouchControls {
  /**
   * @param {Input} input       the shared input state to drive
   * @param {HTMLElement} root  container for the on-screen controls
   */
  constructor(input, root) {
    this.input = input;
    this.enabled = false;
    this.mode = 'assisted';
    this._listeners = [];
    this._disposed = false;
    this._window = root.ownerDocument?.defaultView ?? globalThis.window ?? null;
    this._onWindowBlur = this._handleWindowBlur.bind(this);

    this.layer = document.createElement('div');
    this.layer.id = 'touch';
    this.layer.setAttribute('aria-hidden', 'true');
    root.appendChild(this.layer);

    this.stickZone = el('div', 'touch-zone stick-zone', this.layer);
    this.stickRing = el('div', 'stick-ring', this.stickZone);
    this.stickNub = el('div', 'stick-nub', this.stickZone);

    this.throttleZone = el('div', 'touch-zone throttle-zone', this.layer);
    this.throttleFill = el('i', '', this.throttleZone);
    el('span', 'throttle-label', this.throttleZone, 'THR');

    this.boostButton = el('button', 'touch-btn boost-btn', this.layer, 'BOOST');
    this.reconButton = el('button', 'touch-btn recon-btn', this.layer, 'RECON');
    this.shutterButton = el('button', 'touch-btn shutter-btn', this.layer, 'SHOOT');
    this.zoomInButton = el('button', 'touch-btn zoom-btn zoom-in', this.layer, '+');
    this.zoomOutButton = el('button', 'touch-btn zoom-btn zoom-out', this.layer, '−');

    this._stickId = null;
    this._stickOrigin = { x: 0, y: 0 };
    this._throttleId = null;
    this._boostId = null;
    this._radius = 70;

    this._applyModePresentation();
    this._bind();
  }

  setMode(mode) {
    if (this._disposed) return;
    const next = mode === 'direct' ? 'direct' : 'assisted';
    if (next !== this.mode) this._clearHeldInput();
    this.mode = next;
    this._applyModePresentation();
  }

  _applyModePresentation() {
    const assisted = this.mode === 'assisted';
    this.layer.classList.toggle('assisted', assisted);
    this.throttleZone.setAttribute('aria-hidden', String(assisted));
    this.boostButton.setAttribute('aria-hidden', String(!assisted));
  }

  _clearHeldInput() {
    this._stickId = null;
    this._throttleId = null;
    this._boostId = null;
    this.stickRing.style.opacity = '0';
    this.stickNub.style.opacity = '0';
    this.input.releaseTouch();
    this.input.setTouchBoost(false);
  }

  _handleWindowBlur() {
    this._clearHeldInput();
    this.input.touchRecon = false;
    this.reconButton.classList.toggle('active', false);
    this.layer.classList.toggle('recon-open', false);
  }

  setEnabled(on) {
    if (this._disposed) return;
    this.enabled = Boolean(on);
    this.layer.classList.toggle('show', this.enabled);
    this.layer.setAttribute('aria-hidden', String(!this.enabled));
    if (!this.enabled) {
      this._clearHeldInput();
      this.input.touchRecon = false;
      this.reconButton.classList.toggle('active', false);
      this.layer.classList.toggle('recon-open', false);
    }
  }

  _listen(target, type, handler, options) {
    target.addEventListener(type, handler, options);
    this._listeners.push([target, type, handler, options]);
  }

  _bind() {
    const stick = this.stickZone;
    if (this._window) this._listen(this._window, 'blur', this._onWindowBlur);
    this._listen(stick, 'pointerdown', (e) => {
      if (!this.enabled) return;
      if (this._stickId !== null) return;
      this._stickId = e.pointerId;
      stick.setPointerCapture(e.pointerId);
      const rect = stick.getBoundingClientRect();
      // Relative origin: the stick is born where the thumb lands.
      this._stickOrigin = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      this._radius = Math.min(rect.width, rect.height) * 0.34;
      this.stickRing.style.transform = `translate(${this._stickOrigin.x}px, ${this._stickOrigin.y}px)`;
      this.stickRing.style.opacity = '1';
      this._moveStick(e);
      e.preventDefault();
    });

    const move = (e) => {
      if (e.pointerId !== this._stickId) return;
      this._moveStick(e);
      e.preventDefault();
    };
    this._listen(stick, 'pointermove', move);

    const end = (e) => {
      if (e.pointerId !== this._stickId) return;
      this._stickId = null;
      this.stickRing.style.opacity = '0';
      this.stickNub.style.opacity = '0';
      // Release returns the stick to neutral. The flight model already smooths
      // control input, so this reads as easing off rather than snapping.
      this.input.releaseTouch();
      e.preventDefault();
    };
    this._listen(stick, 'pointerup', end);
    this._listen(stick, 'pointercancel', end);
    // Capture can be lost without a pointerup — a system gesture, the tab going
    // to the background — and a stick stuck at full deflection is the classic
    // mobile-web flight bug.
    this._listen(stick, 'lostpointercapture', end);
    this._listen(document, 'visibilitychange', () => {
      if (document.hidden) this._handleWindowBlur();
    });

    // ---- throttle -------------------------------------------------------
    const thr = this.throttleZone;
    const applyThrottle = (e) => {
      const rect = thr.getBoundingClientRect();
      const t = clamp(1 - (e.clientY - rect.top) / rect.height, 0, 1);
      this.input.setTouchThrottle(t);
      this.throttleFill.style.transform = `scaleY(${t})`;
    };
    this._listen(thr, 'pointerdown', (e) => {
      if (!this.enabled || this.mode !== 'direct') return;
      this._throttleId = e.pointerId;
      thr.setPointerCapture(e.pointerId);
      applyThrottle(e);
      e.preventDefault();
    });
    this._listen(thr, 'pointermove', (e) => {
      if (!this.enabled || this.mode !== 'direct') return;
      if (e.pointerId !== this._throttleId) return;
      applyThrottle(e);
      e.preventDefault();
    });
    const thrEnd = (e) => {
      if (e.pointerId !== this._throttleId) return;
      this._throttleId = null;
      e.preventDefault();
    };
    this._listen(thr, 'pointerup', thrEnd);
    this._listen(thr, 'pointercancel', thrEnd);

    // ---- buttons --------------------------------------------------------
    const boostEnd = (e) => {
      if (e.pointerId !== this._boostId) return;
      this._boostId = null;
      this.input.setTouchBoost(false);
      e.preventDefault();
    };
    this._listen(this.boostButton, 'pointerdown', (e) => {
      if (!this.enabled || this.mode !== 'assisted' || this._boostId !== null) return;
      this._boostId = e.pointerId;
      this.boostButton.setPointerCapture(e.pointerId);
      this.input.setTouchBoost(true);
      e.preventDefault();
    });
    this._listen(this.boostButton, 'pointerup', boostEnd);
    this._listen(this.boostButton, 'pointercancel', boostEnd);
    this._listen(this.boostButton, 'lostpointercapture', boostEnd);

    // Recon is held on the keyboard, so it is a toggle here: asking a player to
    // keep a thumb pinned while steering with the other and framing a shot is
    // one thumb too many.
    this._listen(this.reconButton, 'pointerdown', (e) => {
      if (!this.enabled) return;
      e.preventDefault();
      this.input.toggleTouchRecon();
      this.reconButton.classList.toggle('active', this.input.touchRecon);
      this.layer.classList.toggle('recon-open', this.input.touchRecon);
    });
    this._listen(this.shutterButton, 'pointerdown', (e) => {
      if (!this.enabled) return;
      e.preventDefault();
      this.input.pressTouch('Enter');
    });
    this._listen(this.zoomInButton, 'pointerdown', (e) => {
      if (!this.enabled) return;
      e.preventDefault();
      this.input.pressTouch('KeyF');
    });
    this._listen(this.zoomOutButton, 'pointerdown', (e) => {
      if (!this.enabled) return;
      e.preventDefault();
      this.input.pressTouch('KeyV');
    });

    // Stop iOS from treating a two-finger flight input as a page zoom.
    for (const ev of ['gesturestart', 'gesturechange', 'gestureend']) {
      this._listen(this.layer, ev, (e) => {
        if (this.enabled) e.preventDefault();
      });
    }
  }

  _moveStick(e) {
    const rect = this.stickZone.getBoundingClientRect();
    let dx = e.clientX - rect.left - this._stickOrigin.x;
    let dy = e.clientY - rect.top - this._stickOrigin.y;

    const len = Math.hypot(dx, dy);
    if (len > this._radius) {
      dx = (dx / len) * this._radius;
      dy = (dy / len) * this._radius;
    }

    this.stickNub.style.transform = `translate(${this._stickOrigin.x + dx}px, ${
      this._stickOrigin.y + dy
    }px)`;
    this.stickNub.style.opacity = '1';

    // A small dead zone: a thumb resting on glass is never perfectly still, and
    // without one the aircraft rolls slowly whenever a finger is down.
    const dead = 0.12;
    if (this.mode === 'assisted') {
      const clampedLength = Math.hypot(dx, dy);
      const rawMagnitude = clamp(clampedLength / this._radius, 0, 1);
      const magnitude = rawMagnitude < dead
        ? 0
        : ((rawMagnitude - dead) / (1 - dead)) ** 1.35;
      const directionScale = clampedLength > 0 ? magnitude / clampedLength : 0;
      // Input converts negative pitch into positive semantic climb in the
      // default up-to-climb mode, so dragging upward reads as "climb".
      this.input.setTouchAxes(dy * directionScale, dx * directionScale);
      return;
    }

    // Direct mode intentionally retains the original independently-shaped raw
    // pitch/roll stick for players who chose the simulator-style controls.
    const norm = (v) => {
      const t = clamp(v / this._radius, -1, 1);
      const m = Math.abs(t);
      if (m < dead) return 0;
      return Math.sign(t) * ((m - dead) / (1 - dead)) ** 1.35;
    };
    // Pull up is thumb-back, matching a real stick and every flight game.
    this.input.setTouchAxes(norm(dy), norm(dx));
  }

  dispose() {
    if (this._disposed) return;
    this.setEnabled(false);
    this._disposed = true;
    for (const [target, type, handler, options] of this._listeners) {
      target.removeEventListener(type, handler, options);
    }
    this._listeners.length = 0;
    this.layer.remove();
  }
}

function el(tag, className, parent, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  parent.appendChild(node);
  return node;
}
