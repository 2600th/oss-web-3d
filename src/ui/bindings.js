/**
 * Control bindings for display (settings, HUD key hints, touch).
 *
 * Gameplay owns src/core/Input.js and the real table: `input.bindings` is an
 * object `{ action: {label, keys: [KeyboardEvent.code], pad: [button index],
 * mouse: [button]} }`. The UI turns it into display rows. DEFAULT_BINDINGS is
 * only the fallback when no Input table exists (tests, early boot).
 *
 * UI action names (left) map to gameplay action names (right) for touch.
 */
export const UI_TO_INPUT = {
  missile: 'fireMissile',
  gun: 'fireGun',
  flares: 'flares',
  weapon: 'switchWeapon',
  target: 'targetNext',
  camera: 'camera',
  pause: 'pause',
  optic: 'optic',
};

const PAD_NAMES = ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'View', 'Menu', 'L3', 'R3', 'D-pad up', 'D-pad down', 'D-pad left', 'D-pad right'];
const MOUSE_NAMES = ['Left click', 'Middle click', 'Right click'];

const GROUP = {
  pitchDown: 'Flight', pitchUp: 'Flight', rollLeft: 'Flight', rollRight: 'Flight', yawLeft: 'Flight', yawRight: 'Flight',
  throttleUp: 'Flight', brake: 'Flight', controlMode: 'Flight',
  fireMissile: 'Combat', fireGun: 'Combat', switchWeapon: 'Combat', flares: 'Combat', targetNext: 'Combat', optic: 'Combat',
  camera: 'View', lookTarget: 'View', missileCam: 'View', pause: 'View',
};
// menu-only actions are not worth a row in the controls reference
const HIDDEN = new Set(['confirm', 'back']);

/** KeyboardEvent.code -> short key cap label. */
export function keyLabel(code) {
  if (!code) return '';
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  const map = {
    ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Escape: 'Esc', Space: 'Space',
    ShiftLeft: 'Shift', ShiftRight: 'R Shift', ControlLeft: 'Ctrl', ControlRight: 'R Ctrl', Enter: 'Enter',
    Backspace: 'Backspace', Tab: 'Tab',
  };
  return map[code] ?? code;
}

export const DEFAULT_BINDINGS = [
  { action: 'pitch', label: 'Pitch', keys: ['W', 'S'], alt: ['Up', 'Down'], pad: 'Left stick', group: 'Flight' },
  { action: 'roll', label: 'Roll', keys: ['A', 'D'], alt: ['Left', 'Right'], pad: 'Left stick', group: 'Flight' },
  { action: 'yaw', label: 'Rudder', keys: ['Q', 'E'], pad: 'LB / RB', group: 'Flight' },
  { action: 'throttleUp', label: 'Throttle up / afterburner', keys: ['Shift'], pad: 'RT', group: 'Flight' },
  { action: 'brake', label: 'Airbrake', keys: ['Ctrl', 'Z'], pad: 'LT', group: 'Flight' },
  { action: 'missile', label: 'Fire missile / special', keys: ['Space'], pad: 'B', code: 'Space', group: 'Combat' },
  { action: 'gun', label: 'Gun (hold)', keys: ['F'], pad: 'A', code: 'KeyF', group: 'Combat' },
  { action: 'flares', label: 'Flares', keys: ['X'], pad: 'L3', code: 'KeyX', group: 'Combat' },
  { action: 'weapon', label: 'Switch weapon', keys: ['R'], pad: 'X', code: 'KeyR', group: 'Combat' },
  { action: 'target', label: 'Next target', keys: ['Tab', 'T'], pad: 'Y', code: 'Tab', group: 'Combat' },
  { action: 'camera', label: 'Camera', keys: ['C'], pad: 'View', code: 'KeyC', group: 'View' },
  { action: 'pause', label: 'Pause', keys: ['Esc', 'P'], pad: 'Menu', code: 'Escape', group: 'View' },
];

/** Display rows from the live Input table, else the fallback list. */
export function bindingsFor(input) {
  const b = input?.bindings;
  if (Array.isArray(b) && b.length) return b;
  if (b && typeof b === 'object' && Object.keys(b).length) {
    const rows = [];
    for (const [action, v] of Object.entries(b)) {
      if (HIDDEN.has(action)) continue;
      const keys = (v.keys ?? []).map(keyLabel);
      const pad = [...(v.pad ?? []).map((i) => PAD_NAMES[i] ?? `Button ${i}`), ...(v.mouse ?? []).map((i) => MOUSE_NAMES[i] ?? `Mouse ${i}`)].join(' / ');
      rows.push({ action, label: v.label ?? action, keys, pad, code: v.keys?.[0], group: GROUP[action] ?? 'Other' });
    }
    return rows;
  }
  return DEFAULT_BINDINGS;
}

/** First key cap for a UI or gameplay action name. */
export function keyFor(input, action) {
  const rows = bindingsFor(input);
  const name = UI_TO_INPUT[action] ?? action;
  const b = rows.find((x) => x.action === name) ?? rows.find((x) => x.action === action);
  return b?.keys?.[0] ?? '';
}
