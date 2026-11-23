import { DEFAULT_BINDINGS } from '../ui/bindings.js';

/**
 * Touch flying and fighting.
 *
 * Left thumb: a *relative* stick — the centre is wherever the thumb lands, so
 * the player never looks down to find it (absolute sticks drift off-centre on
 * glass). In Expert mode a throttle strip sits on the left bezel; throttle is a
 * position, not a rate, so it does not self-centre. Standard mode replaces it
 * with a held BOOST.
 *
 * Right thumb: the weapon cluster, arranged on an arc around the resting
 * thumb: GUN (hold) is largest and nearest the corner, MSL next to it, FLR
 * above (the panic button must be findable blind), then weapon switch and
 * target cycle. Camera and pause are small and out of the thumb arc, top right.
 *
 * Portrait and landscape use the same cluster; CSS (`#touch` in styles.css)
 * places it from safe-area insets and orientation media queries.
 *
 * Everything feeds the shared Input through `touchAction()` — the one adapter
 * to change if gameplay renames its actions.
 */

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * The single adapter between on-screen buttons and gameplay input.
 * Preferred: `input.setAction(name, held)` (gameplay API, if it exists).
 * Fallback: simulate the bound key (DEFAULT_BINDINGS `code`) so any
 * keyboard-driven action works unchanged.
 */
export function touchAction(input, action, down) {
  if (!input) return;
  if (typeof input.setAction === 'function') {
    input.setAction(action, down);
    return;
  }
  const b = (input.bindings ?? DEFAULT_BINDINGS).find((x) => x.action === action) ?? DEFAULT_BINDINGS.find((x) => x.action === action);
  const code = b?.code;
  if (!code) return;
  if (down) {
    input.keys?.add(code);
    if (typeof input.pressTouch === 'function') input.pressTouch(code);
    else input._pressed?.add(code);
  } else {
    input.keys?.delete(code);
  }
}

const BUTTONS = [
  { id: 'gun', label: 'GUN', hold: true, aria: 'Gun, hold to fire' },
  { id: 'missile', label: 'MSL', aria: 'Fire missile' },
  { id: 'flares', label: 'FLR', aria: 'Release flares' },
  { id: 'weapon', label: 'WPN', aria: 'Switch weapon' },
  { id: 'target', label: 'TGT', aria: 'Next target' },
];

export class TouchControls {
  /**
   * @param {object} input     shared Input (src/core/Input.js)
   * @param {HTMLElement} root container
   * @param {object} opts      { settings, onPause, onCamera }
   */
  constructor(input, root, { settings = null, onPause = null } = {}) {
    this.input = input;
    this.settings = settings;
    this.onPause = onPause;
    this.enabled = false;
    this.mode = settings?.controlMode === 'expert' ? 'expert' : 'standard';
    this._listeners = [];
    this._held = new Map(); // pointerId -> action
    this._stickId = null;
    this._stickOrigin = { x: 0, y: 0 };
    this._throttleId = null;
    this._boostId = null;
    this._radius = 64;

    const layer = (this.layer = document.createElement('div'));
    layer.id = 'touch';
    layer.setAttribute('aria-hidden', 'true');
    root.appendChild(layer);

    this.stickZone = mk('div', 'tz-stick', layer);
    this.stickRing = mk('div', 'stick-ring', this.stickZone);
    this.stickNub = mk('div', 'stick-nub', this.stickZone);
    this.stickHint = mk('div', 'stick-hint', this.stickZone);
    this.stickHint.textContent = 'STICK';

    this.throttle = mk('div', 'tz-throttle', layer);
    this.throttleFill = mk('i', '', this.throttle);
    mk('span', 'tz-throttle-label', this.throttle).textContent = 'THR';
    this.boost = mk('button', 'tbtn tbtn-boost', layer);
    this.boost.textContent = 'BOOST';
    this.boost.setAttribute('aria-label', 'Afterburner, hold');

    this.cluster = mk('div', 'tz-cluster', layer);
    this.buttons = {};
    for (const b of BUTTONS) {
      const btn = mk('button', `tbtn tbtn-${b.id}`, this.cluster);
      btn.textContent = b.label;
      btn.setAttribute('aria-label', b.aria);
      btn.dataset.action = b.id;
      if (b.hold) btn.dataset.hold = '1';
      this.buttons[b.id] = btn;
    }
    this.top = mk('div', 'tz-top', layer);
    this.camBtn = mk('button', 'tbtn tbtn-small tbtn-cam', this.top);
    this.camBtn.textContent = 'CAM';
    this.camBtn.setAttribute('aria-label', 'Change camera');
    this.camBtn.dataset.action = 'camera';
    this.pauseBtn = mk('button', 'tbtn tbtn-small tbtn-pause', this.top);
    this.pauseBtn.setAttribute('aria-label', 'Pause');
    this.pauseBtn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14M16 5v14"/></svg>';

    this._applyMode();
    this._bind();
  }

  setMode(mode) {
    const next = mode === 'expert' ? 'expert' : 'standard';
    if (next !== this.mode) this._release();
    this.mode = next;
    this._applyMode();
  }

  _applyMode() {
    this.layer.dataset.mode = this.mode;
  }

  setEnabled(on) {
    this.enabled = !!on;
    this.layer.classList.toggle('show', this.enabled);
    if (!this.enabled) this._release();
  }

  /**
   * Screen rects (CSS px) of every visible button, so the HUD can move target
   * markers out from under the player's thumbs. Empty while hidden.
   */
  occluders() {
    if (!this.enabled) return [];
    const out = [];
    for (const n of [this.boost, this.camBtn, this.pauseBtn, ...Object.values(this.buttons)]) {
      const r = n.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) out.push({ x: r.left, y: r.top, w: r.width, h: r.height });
    }
    return out;
  }

  dispose() {
    this._release();
    for (const [t, type, fn, o] of this._listeners) t.removeEventListener(type, fn, o);
    this.layer.remove();
  }

  _listen(t, type, fn, o) {
    t.addEventListener(type, fn, o);
    this._listeners.push([t, type, fn, o]);
  }

  _buzz() {
    if (this.settings?.vibration === false) return;
    try {
      navigator.vibrate?.(8);
    } catch {
      /* not allowed */
    }
  }

  _release() {
    this._stickId = null;
    this._throttleId = null;
    this.stickZone.classList.remove('active');
    this.input?.releaseTouch?.();
    if (this._boostId !== null) {
      this.input?.setTouchBoost?.(false);
      this._boostId = null;
      this.boost.classList.remove('down');
    }
    for (const [, action] of this._held) touchAction(this.input, action, false);
    this._held.clear();
    for (const b of Object.values(this.buttons)) b.classList.remove('down');
  }

  _bind() {
    const opt = { passive: false };
    // Stick
    this._listen(this.stickZone, 'pointerdown', (e) => {
      if (this._stickId !== null) return;
      e.preventDefault();
      this._stickId = e.pointerId;
      this.stickZone.setPointerCapture?.(e.pointerId);
      const r = this.stickZone.getBoundingClientRect();
      this._radius = clamp(Math.min(r.width, r.height) * 0.22, 46, 78);
      this._stickOrigin.x = e.clientX - r.left;
      this._stickOrigin.y = e.clientY - r.top;
      this.stickZone.style.setProperty('--sx', `${this._stickOrigin.x}px`);
      this.stickZone.style.setProperty('--sy', `${this._stickOrigin.y}px`);
      this.stickZone.style.setProperty('--sr', `${this._radius}px`);
      this.stickZone.style.setProperty('--nx', '0px');
      this.stickZone.style.setProperty('--ny', '0px');
      this.stickZone.classList.add('active');
      this.input?.setTouchAxes?.(0, 0);
    }, opt);
    this._listen(this.stickZone, 'pointermove', (e) => {
      if (e.pointerId !== this._stickId) return;
      e.preventDefault();
      const r = this.stickZone.getBoundingClientRect();
      let dx = e.clientX - r.left - this._stickOrigin.x;
      let dy = e.clientY - r.top - this._stickOrigin.y;
      const len = Math.hypot(dx, dy);
      const R = this._radius;
      if (len > R) {
        dx = (dx / len) * R;
        dy = (dy / len) * R;
      }
      this.stickZone.style.setProperty('--nx', `${dx}px`);
      this.stickZone.style.setProperty('--ny', `${dy}px`);
      const sens = this.settings?.sensitivity ?? 1;
      const shape = (v) => Math.sign(v) * Math.pow(Math.abs(v), 1.35); // fine control near centre
      let pitch = clamp(shape(dy / R) * sens, -1, 1);
      const roll = clamp(shape(dx / R) * sens, -1, 1);
      if (this.settings?.invertY) pitch = -pitch;
      this.input?.setTouchAxes?.(pitch, roll);
    }, opt);
    const endStick = (e) => {
      if (e.pointerId !== this._stickId) return;
      this._stickId = null;
      this.stickZone.classList.remove('active');
      this.input?.setTouchAxes?.(null, null);
      this.input?.releaseTouch?.();
    };
    this._listen(this.stickZone, 'pointerup', endStick);
    this._listen(this.stickZone, 'pointercancel', endStick);
    this._listen(this.stickZone, 'lostpointercapture', endStick);

    // Throttle strip (expert)
    const setThrottle = (e) => {
      const r = this.throttle.getBoundingClientRect();
      const t = clamp(1 - (e.clientY - r.top) / r.height, 0, 1);
      this.throttleFill.style.transform = `scaleY(${t})`;
      this.throttle.classList.toggle('burner', t > 0.85);
      this.input?.setTouchThrottle?.(t);
    };
    this._listen(this.throttle, 'pointerdown', (e) => {
      e.preventDefault();
      this._throttleId = e.pointerId;
      this.throttle.setPointerCapture?.(e.pointerId);
      setThrottle(e);
    }, opt);
    this._listen(this.throttle, 'pointermove', (e) => {
      if (e.pointerId === this._throttleId) setThrottle(e);
    }, opt);
    const endThrottle = (e) => {
      if (e.pointerId === this._throttleId) this._throttleId = null;
    };
    this._listen(this.throttle, 'pointerup', endThrottle);
    this._listen(this.throttle, 'pointercancel', endThrottle);

    // Boost (standard)
    this._listen(this.boost, 'pointerdown', (e) => {
      e.preventDefault();
      this._boostId = e.pointerId;
      this.boost.setPointerCapture?.(e.pointerId);
      this.boost.classList.add('down');
      this.input?.setTouchBoost?.(true);
      this._buzz();
    }, opt);
    const endBoost = (e) => {
      if (e.pointerId !== this._boostId) return;
      this._boostId = null;
      this.boost.classList.remove('down');
      this.input?.setTouchBoost?.(false);
    };
    this._listen(this.boost, 'pointerup', endBoost);
    this._listen(this.boost, 'pointercancel', endBoost);

    // Action buttons (cluster + camera)
    for (const btn of [...Object.values(this.buttons), this.camBtn]) {
      const action = btn.dataset.action;
      this._listen(btn, 'pointerdown', (e) => {
        e.preventDefault();
        btn.setPointerCapture?.(e.pointerId);
        btn.classList.add('down');
        this._held.set(e.pointerId, action);
        touchAction(this.input, action, true);
        this._buzz();
      }, opt);
      const up = (e) => {
        if (this._held.get(e.pointerId) !== action) return;
        this._held.delete(e.pointerId);
        btn.classList.remove('down');
        touchAction(this.input, action, false);
      };
      this._listen(btn, 'pointerup', up);
      this._listen(btn, 'pointercancel', up);
    }
    this._listen(this.pauseBtn, 'click', (e) => {
      e.preventDefault();
      this.onPause?.();
    });
    // never let a long-press open the context menu / text selection
    this._listen(this.layer, 'contextmenu', (e) => e.preventDefault());
    if (typeof window !== 'undefined') this._listen(window, 'blur', () => this._release());
  }

  /** Reflect live state (weapon ready, flares left) on the buttons. */
  sync(hud) {
    if (!this.enabled || !hud) return;
    const fl = hud.flares;
    this.buttons.flares.classList.toggle('empty', !!fl && fl.count <= 0);
    const w = hud.weapon;
    this.buttons.missile.classList.toggle('empty', !!w && w.current !== 'gun' && w.ammo <= 0);
    this.buttons.missile.classList.toggle('cooling', !!w && w.ready === false);
    const lock = hud.lock?.state;
    this.buttons.missile.classList.toggle('locked', lock === 'locked');
    if (this.mode === 'expert' && this._throttleId === null && Number.isFinite(hud.throttle)) {
      this.throttleFill.style.transform = `scaleY(${clamp(hud.throttle, 0, 1)})`;
    }
  }
}

function mk(tag, cls, parent) {
  const n = document.createElement(tag);
  if (tag === 'button') n.type = 'button';
  if (cls) n.className = cls;
  parent.appendChild(n);
  return n;
}
