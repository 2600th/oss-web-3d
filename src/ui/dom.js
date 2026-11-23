/**
 * DOM helpers and menu navigation (keyboard, gamepad, pointer).
 *
 * Navigation is owned here rather than left to the browser because the flight
 * Input listener on `window` calls preventDefault on Tab, Space and the arrow
 * keys (it has to, or the page scrolls mid-dogfight). That silently disables
 * native Tab focus, Space-to-click and arrow keys on range inputs. So menus
 * implement their own: every navigable control carries `data-nav`, the Nav
 * moves focus through them in DOM order, Left/Right adjust a control that
 * declares `data-adjust`, Enter/Space/A activate, Escape/B go back.
 */

export function el(tag, cls, parent, text) {
  const n = document.createElement(tag);
  if (tag === 'button') n.type = 'button';
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = text;
  if (parent) parent.appendChild(n);
  return n;
}

const SVGNS = 'http://www.w3.org/2000/svg';

/** Authored icon set: one 1.75-stroke line weight, 24 grid. */
const ICONS = {
  chevron: 'M9 5l7 7-7 7',
  back: 'M15 5l-7 7 7 7',
  pause: 'M8 5v14M16 5v14',
  camera: 'M4 8h4l2-3h4l2 3h4v11H4zM12 17a3.5 3.5 0 100-7 3.5 3.5 0 000 7z',
  target: 'M12 3v4M12 17v4M3 12h4M17 12h4M12 8a4 4 0 100 8 4 4 0 000-8z',
  swap: 'M5 8h12l-3-3M19 16H7l3 3',
  flare: 'M12 3v7M12 14v7M5.5 6.5l4 4M14.5 13.5l4 4M3 12h6M15 12h6M5.5 17.5l4-4M14.5 10.5l4-4',
  lock: 'M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 017 0v3',
  close: 'M6 6l12 12M18 6L6 18',
};

export function icon(name, cls = 'icon') {
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', cls);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const p = document.createElementNS(SVGNS, 'path');
  p.setAttribute('d', ICONS[name] ?? '');
  svg.appendChild(p);
  return svg;
}

/** Inline tricolour (Windows has no flag emoji; see legacy/ui/Screens.js). */
export function flag() {
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('viewBox', '0 0 27 18');
  svg.setAttribute('class', 'flag');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Flag of India');
  for (const [y, fill] of [['0', '#ff9933'], ['6', '#ffffff'], ['12', '#138808']]) {
    const r = document.createElementNS(SVGNS, 'rect');
    r.setAttribute('x', '0');
    r.setAttribute('y', y);
    r.setAttribute('width', '27');
    r.setAttribute('height', '6');
    r.setAttribute('fill', fill);
    svg.appendChild(r);
  }
  const c = document.createElementNS(SVGNS, 'circle');
  c.setAttribute('cx', '13.5');
  c.setAttribute('cy', '9');
  c.setAttribute('r', '2.2');
  c.setAttribute('fill', 'none');
  c.setAttribute('stroke', '#000080');
  c.setAttribute('stroke-width', '0.6');
  svg.appendChild(c);
  return svg;
}

// ----------------------------------------------------------------- Nav --

const PAD_REPEAT_DELAY = 0.38;
const PAD_REPEAT_RATE = 0.11;

export class Nav {
  constructor() {
    this.root = null;
    this.onBack = null;
    this.onStart = null;
    this.modality = 'pointer';
    this._pad = { held: {}, timers: {} };
    this._onKey = this._onKey.bind(this);
    window.addEventListener('keydown', this._onKey, true);
    document.addEventListener('pointermove', () => this._setModality('pointer'), { passive: true });
    document.addEventListener('pointerdown', (e) => this._setModality(e.pointerType === 'touch' ? 'touch' : 'pointer'), { passive: true });
  }

  _setModality(m) {
    if (this.modality === m) return;
    this.modality = m;
    document.documentElement.dataset.input = m;
  }

  /** Activate a screen root: its [data-nav] elements become the focus ring. */
  setRoot(root, { onBack = null, focus = true, initial = null } = {}) {
    this.root = root;
    this.onBack = onBack;
    if (root && focus) {
      const first = initial ?? root.querySelector('[data-nav][data-default]') ?? this.items()[0];
      // Don't steal focus into a menu on touch: it shows a ring nobody asked for.
      if (first) first.focus({ preventScroll: true });
    }
  }

  items() {
    if (!this.root) return [];
    return [...this.root.querySelectorAll('[data-nav]')].filter(
      (n) => !n.disabled && n.getAttribute('aria-disabled') !== 'true' && n.offsetParent !== null,
    );
  }

  current() {
    const a = document.activeElement;
    return this.root && a && this.root.contains(a) && a.hasAttribute('data-nav') ? a : null;
  }

  move(delta) {
    const list = this.items();
    if (!list.length) return;
    const cur = this.current();
    let i = cur ? list.indexOf(cur) : -1;
    i = i < 0 ? (delta > 0 ? 0 : list.length - 1) : (i + delta + list.length) % list.length;
    list[i].focus({ preventScroll: false });
    list[i].scrollIntoView?.({ block: 'nearest' });
    if (list[i] !== cur) this.onSound?.('hover');
  }

  adjust(dir) {
    const cur = this.current();
    if (cur && cur.dataset.adjust !== undefined) {
      cur.dispatchEvent(new CustomEvent('nav-adjust', { detail: dir }));
      this.onSound?.('hover');
      return true;
    }
    // Horizontal groups (e.g. a row of buttons) move along the row.
    if (cur && cur.closest('[data-nav-row]')) {
      this.move(dir);
      return true;
    }
    return false;
  }

  activate() {
    const cur = this.current();
    if (cur) cur.click();
  }

  back() {
    if (this.onBack) {
      this.onSound?.('back');
      this.onBack();
    }
  }

  _onKey(e) {
    if (!this.root) {
      if ((e.code === 'Escape' || e.code === 'KeyP') && this.onStart) {
        if (this.onStart()) e.preventDefault();
      }
      return;
    }
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
    this._setModality('keyboard');
    let handled = true;
    switch (e.code) {
      case 'ArrowDown':
      case 'KeyS':
        this.move(1);
        break;
      case 'ArrowUp':
      case 'KeyW':
        this.move(-1);
        break;
      case 'Tab':
        this.move(e.shiftKey ? -1 : 1);
        break;
      case 'ArrowLeft':
      case 'KeyA':
        handled = this.adjust(-1);
        break;
      case 'ArrowRight':
      case 'KeyD':
        handled = this.adjust(1);
        break;
      case 'Enter':
      case 'NumpadEnter':
      case 'Space':
        if (e.repeat) break;
        if (this.current()) this.activate();
        else this.move(1);
        break;
      case 'Escape':
      case 'Backspace':
        this.back();
        break;
      default:
        handled = false;
    }
    if (handled) {
      e.preventDefault();
      // Keep menu keys away from the flight Input (it would record them).
      e.stopPropagation();
    }
  }

  /** Poll the gamepad; call once per animation frame. */
  pollGamepad(dt) {
    const pads = navigator.getGamepads?.() ?? [];
    let pad = null;
    for (let i = 0; i < pads.length; i++) if (pads[i]?.connected) { pad = pads[i]; break; }
    if (!pad) return;
    const ax = pad.axes[0] ?? 0;
    const ay = pad.axes[1] ?? 0;
    const b = (i) => !!pad.buttons[i]?.pressed;
    const state = {
      up: b(12) || ay < -0.55,
      down: b(13) || ay > 0.55,
      left: b(14) || ax < -0.55,
      right: b(15) || ax > 0.55,
      a: b(0),
      b: b(1),
      start: b(9),
    };
    const fire = (key, fn, repeat) => {
      const was = this._pad.held[key];
      const now = state[key];
      if (now && !was) {
        this._setModality('gamepad');
        fn();
        this._pad.timers[key] = PAD_REPEAT_DELAY;
      } else if (now && repeat) {
        this._pad.timers[key] -= dt;
        if (this._pad.timers[key] <= 0) {
          fn();
          this._pad.timers[key] = PAD_REPEAT_RATE;
        }
      }
      this._pad.held[key] = now;
    };
    if (this.root) {
      fire('up', () => this.move(-1), true);
      fire('down', () => this.move(1), true);
      fire('left', () => this.adjust(-1), true);
      fire('right', () => this.adjust(1), true);
      fire('a', () => (this.current() ? this.activate() : this.move(1)), false);
      fire('b', () => this.back(), false);
      fire('start', () => (this.padStartOwned?.() ? null : this.back()), false);
    } else {
      for (const k of ['up', 'down', 'left', 'right', 'a', 'b']) this._pad.held[k] = state[k];
      fire('start', () => this.onStart?.(), false);
    }
  }
}
