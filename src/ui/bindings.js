/**
 * Control bindings for display (settings, briefing legend, touch fallback).
 *
 * Gameplay owns src/core/Input.js and the real bindings. If it exposes
 * `game.input.bindings` as an array shaped like DEFAULT_BINDINGS, the UI shows
 * that instead. `code` is the KeyboardEvent.code the touch layer falls back to
 * when Input has no action API (see TouchControls.touchAction).
 */
export const DEFAULT_BINDINGS = [
  { action: 'pitch', label: 'Pitch', keys: ['W', 'S'], alt: ['Up', 'Down'], pad: 'Left stick', group: 'Flight' },
  { action: 'roll', label: 'Roll', keys: ['A', 'D'], alt: ['Left', 'Right'], pad: 'Left stick', group: 'Flight' },
  { action: 'yaw', label: 'Rudder', keys: ['Q', 'E'], pad: 'Right stick', group: 'Flight' },
  { action: 'throttleUp', label: 'Throttle up / afterburner', keys: ['Shift'], pad: 'RT', group: 'Flight' },
  { action: 'throttleDown', label: 'Throttle down', keys: ['X'], pad: 'LT', group: 'Flight' },
  { action: 'brake', label: 'Airbrake', keys: ['Z'], pad: 'LB', group: 'Flight' },
  { action: 'missile', label: 'Fire missile', keys: ['Space'], pad: 'A', code: 'Space', group: 'Combat' },
  { action: 'gun', label: 'Gun (hold)', keys: ['F'], pad: 'RB', code: 'KeyF', group: 'Combat' },
  { action: 'flares', label: 'Flares', keys: ['C'], pad: 'B', code: 'KeyC', group: 'Combat' },
  { action: 'weapon', label: 'Switch weapon', keys: ['R'], pad: 'Y', code: 'KeyR', group: 'Combat' },
  { action: 'target', label: 'Cycle target', keys: ['Tab'], pad: 'X', code: 'Tab', group: 'Combat' },
  { action: 'camera', label: 'Change camera', keys: ['V'], pad: 'Right stick click', code: 'KeyV', group: 'View' },
  { action: 'pause', label: 'Pause', keys: ['Esc'], pad: 'Menu', code: 'Escape', group: 'View' },
];

export function bindingsFor(input) {
  const b = input?.bindings;
  return Array.isArray(b) && b.length ? b : DEFAULT_BINDINGS;
}

export function keyFor(input, action) {
  const b = bindingsFor(input).find((x) => x.action === action);
  return b?.keys?.[0] ?? '';
}
