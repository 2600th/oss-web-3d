// First-sortie onboarding: short contextual prompts, each shown once, each
// tied to the moment it is useful (a lock prompt when something is in lock
// range, the flare prompt when the first missile is in the air). Pure logic
// (node-testable); the mission system feeds it a small context every frame
// and emits what it returns as a `hint` event (and, until a HUD claims the
// event, as a radio line from the wingman).
//
// A prompt is retired without being shown when the player does the thing
// first. Progress persists, so a returning player is not taught twice, and a
// player who has already completed the first mission is not taught at all.

const KEY = 'safedsagar.v2.onboarding';
const GAP = 7; // seconds between two prompts (the flare prompt ignores it)

const KEY_NAMES = {
  Space: 'SPACE', ShiftLeft: 'SHIFT', ShiftRight: 'SHIFT', ControlLeft: 'CTRL', ControlRight: 'CTRL', Tab: 'TAB',
  ArrowUp: 'UP', ArrowDown: 'DOWN', ArrowLeft: 'LEFT', ArrowRight: 'RIGHT', Escape: 'ESC', Enter: 'ENTER',
};
const PAD_NAMES = ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'VIEW', 'MENU', 'L3', 'R3', 'D-PAD UP', 'D-PAD DOWN', 'D-PAD LEFT', 'D-PAD RIGHT'];
/** On-screen button captions (src/core/TouchControls.js). Actions without one have no touch control. */
const TOUCH_NAMES = {
  fireMissile: 'MSL', fireGun: 'GUN', flares: 'FLR', switchWeapon: 'WPN', targetNext: 'TGT', camera: 'CAM', optic: 'EYE', throttleUp: 'BOOST',
};

/** The control to show for an action on the device the player is using. */
export function controlLabel(bindings, action, modality = 'keyboard') {
  const b = bindings?.[action];
  if (modality === 'touch') return TOUCH_NAMES[action] ?? null;
  if (modality === 'gamepad') {
    const i = b?.pad?.[0];
    return i === undefined ? null : PAD_NAMES[i] ?? `BUTTON ${i}`;
  }
  const code = b?.keys?.[0];
  if (!code) return null;
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  return KEY_NAMES[code] ?? code.toUpperCase();
}

/**
 * The prompts, in priority order. `when(c)` is tested against the context:
 *   time, threats, lockable (selected target inside lock range), lockState,
 *   targetDistance, gunSolution, kills, spAmmo, current ('msl'|'sp'),
 *   specialName, phase, targets (count on the HUD)
 * `learn` names the player action that retires the prompt.
 */
export const HINTS = [
  {
    id: 'flares', action: 'flares', urgent: true, learn: 'flares',
    when: (c) => c.threats > 0,
    text: (k) => (k ? `Missile on you, lead! Flares, and break hard across it. [${k}]` : 'Missile on you, lead! Break hard across it.'),
  },
  {
    id: 'fire', action: 'fireMissile', learn: 'fire',
    when: (c) => c.lockState === 'locked',
    text: (k) => `Steady tone, lead. Take the shot. [${k}]`,
  },
  {
    id: 'lock', action: null, learn: 'lock',
    when: (c) => c.lockable && c.lockState !== 'locked',
    text: () => 'Hold the target inside the circle, lead. Wait for the steady tone.',
  },
  {
    id: 'gun', action: 'fireGun', learn: 'gun',
    when: (c) => c.gunSolution && c.targetDistance < 1500,
    text: (k) => `You are inside gun range. Put the pipper on it. [${k}]`,
  },
  {
    id: 'special', action: 'switchWeapon', learn: 'special',
    when: (c) => c.kills >= 1 && c.spAmmo > 0 && c.current === 'msl' && c.threats === 0,
    text: (k, c) => `Good hit. You are carrying ${c.specialName ?? 'a special weapon'} as well. [${k}]`,
  },
  {
    id: 'target', action: 'targetNext', learn: 'target',
    when: (c) => c.kills >= 2 && c.targets > 2 && c.threats === 0,
    text: (k) => `Plenty left up there. Step through them. [${k}]`,
  },
  {
    id: 'turn', action: 'brake', learn: 'highG',
    when: (c) => c.time > 12 && c.threats === 0 && !c.lockable,
    text: (k, c, keys) => (k
      ? `Airbrake and turn together for a high-G turn${keys.throttleUp ? `, burner to get the speed back` : ''}. [${k}${keys.throttleUp ? ` / ${keys.throttleUp}` : ''}]`
      : null),
  },
  {
    id: 'camera', action: 'camera', learn: 'camera',
    when: (c) => c.time > 24 && c.threats === 0 && !c.lockable,
    text: (k) => `Change your view whenever you like. [${k}]`,
  },
];

function store() {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

export class Onboarding {
  /**
   * @param {object} o
   * @param {boolean} [o.veteran]  the first mission is already complete: teach nothing
   * @param {Storage|null} [o.storage]
   */
  constructor({ veteran = false, storage = store() } = {}) {
    this.storage = storage;
    this.done = {};
    try {
      const p = JSON.parse(storage?.getItem(KEY) ?? 'null');
      if (p && typeof p === 'object') this.done = { ...p };
    } catch { /* corrupt: teach again */ }
    this.enabled = !veteran && HINTS.some((h) => !this.done[h.id]);
    this._last = -Infinity;
  }

  _save() {
    try { this.storage?.setItem(KEY, JSON.stringify(this.done)); } catch { /* unavailable */ }
  }

  /** The player did it: never prompt for it. `what` is a HINTS `learn` name. */
  learn(what) {
    let changed = false;
    for (const h of HINTS) if (h.learn === what && !this.done[h.id]) { this.done[h.id] = true; changed = true; }
    if (changed) this._save();
  }

  /**
   * @param {object} c context (see HINTS)
   * @param {(action:string)=>string|null} label control caption for an action
   * @returns {{id, action, text, keys, urgent, duration}|null} a prompt to show now
   */
  update(c, label) {
    if (!this.enabled) return null;
    for (const h of HINTS) {
      if (this.done[h.id] || !h.when(c)) continue;
      if (!h.urgent && c.time - this._last < GAP) return null;
      const key = h.action ? label(h.action) : null;
      // No control for it on this device (e.g. no airbrake button on touch).
      if (h.action && !key) { this.done[h.id] = true; continue; }
      const text = h.text(key, c, { throttleUp: label('throttleUp') });
      this.done[h.id] = true;
      this._save();
      if (!text) continue;
      this._last = c.time;
      this.enabled = HINTS.some((x) => !this.done[x.id]);
      return { id: h.id, action: h.action, text, keys: key ? [key] : [], urgent: h.urgent === true, duration: 6 };
    }
    return null;
  }
}

export const ONBOARDING_KEY = KEY;
