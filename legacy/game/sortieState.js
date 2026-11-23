/**
 * Predicates over the game's top-level state.
 *
 * These live in their own module rather than inline in Game.js for the same
 * reason shouldToggleDebug does: Game.js touches `window` at import time, so a
 * test cannot load it.
 */

/**
 * True when Enter should start a sortie.
 *
 * Enter is also the manual shutter. Accepting it on a debrief meant the key the
 * player had been pressing for the whole flight discarded the contact sheet and
 * a leaderboard time that had not been recorded yet. Input already ignores keys
 * typed into the callsign field, so the old dispatch only fired while focus sat
 * outside it — which is exactly where focus is when the debrief opens.
 *
 * Restarting is deliberate and stays on the debrief's own button.
 *
 * @param {string} state
 * @returns {boolean}
 */
export function acceptsLaunchKey(state) {
  return state === 'briefing';
}
