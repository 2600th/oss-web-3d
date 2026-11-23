import { stemWeights } from './physics.js';

/**
 * Adaptive-music state machine (pure; time is passed in so node tests can drive it).
 *
 * Inputs
 *  - `request({state, level}, now)` from the `music:intensity` contract event.
 *    state ∈ menu | briefing | cruise | combat | danger | ace | victory | defeat | memorial | silence
 *  - `heat(amount, now)` from combat events when no mission system drives music:
 *    locks, launches, hits and explosions warm the score up, and it cools down.
 *
 * Output of `update(now)`: `{ cue, level, weights, changed }` where `weights` are
 * linear (sum-to-1, smoothstepped) gains for the three correlated combat stems.
 *
 * Hysteresis rules (why they exist):
 *  - Combat → cruise needs `combatHold` seconds without combat pressure, so the
 *    score does not drop out between two passes of a dogfight.
 *  - The intensity level is slewed (`riseRate` fast, `fallRate` slow): the music
 *    reacts at once to a missile alert but relaxes gradually.
 *  - Victory / defeat / memorial are terminal: only an explicit request leaves them.
 */
export const COMBAT_CUES = new Set(['combat', 'ace']);
const TERMINAL = new Set(['victory', 'defeat', 'memorial']);

export class MusicState {
  constructor({ combatHold = 9, explicitTimeout = 45, riseRate = 1.6, fallRate = 0.12, heatDecay = 0.05 } = {}) {
    this.opts = { combatHold, explicitTimeout, riseRate, fallRate, heatDecay };
    this.cue = null;
    this.level = 0;
    this.targetLevel = 0;
    this._lastCombatAt = -Infinity;
    this._lastExplicitAt = -Infinity;
    this._heat = 0;
    this._heatAt = 0;
    this._lastT = null;
    this._pendingCue = null;
  }

  /**
   * Explicit request. `authoritative` (music:intensity from the mission system)
   * suspends the combat-heat heuristic for `explicitTimeout` seconds; screen and
   * mission-flow cues (ui:screen, mission:start) set the cue without doing so.
   */
  request({ state, level }, now, authoritative = true) {
    if (authoritative) this._lastExplicitAt = now;
    const lv = typeof level === 'number' ? Math.min(1, Math.max(0, level)) : undefined;
    switch (state) {
      case 'combat':
      case 'ace':
        this._lastCombatAt = now;
        this.targetLevel = lv ?? Math.max(this.targetLevel, 0.5);
        this._pendingCue = state;
        break;
      case 'danger':
        this._lastCombatAt = now;
        this.targetLevel = Math.max(lv ?? 0, 0.85);
        this._pendingCue = this.cue === 'ace' ? 'ace' : 'combat';
        break;
      case 'cruise':
        // honoured after the combat hold so a brief lull does not drop the score
        this.targetLevel = lv ?? 0;
        this._pendingCue = 'cruise';
        break;
      case 'menu': case 'briefing': case 'victory': case 'defeat': case 'memorial':
        this._pendingCue = state;
        this._lastCombatAt = -Infinity;
        this.targetLevel = lv ?? 0;
        break;
      case 'silence':
        this._pendingCue = null;
        this._silence = true;
        break;
      default:
        if (lv !== undefined) this.targetLevel = lv;
    }
  }

  /** Heuristic combat pressure, used only while no explicit request is fresh. */
  heat(amount, now) {
    this._decayHeat(now);
    this._heat = Math.min(1, this._heat + amount);
  }

  _decayHeat(now) {
    const dt = Math.max(0, now - this._heatAt);
    this._heat = Math.max(0, this._heat - dt * this.opts.heatDecay);
    this._heatAt = now;
  }

  update(now) {
    const dt = this._lastT === null ? 0 : Math.max(0, now - this._lastT);
    this._lastT = now;
    this._decayHeat(now);
    const prev = this.cue;
    const explicitFresh = now - this._lastExplicitAt < this.opts.explicitTimeout;

    let next = this.cue;
    if (this._silence) { next = null; this._silence = false; this._pendingCue = undefined; }
    else if (this._pendingCue !== undefined) {
      const want = this._pendingCue;
      if (want === 'cruise' && COMBAT_CUES.has(this.cue) && now - this._lastCombatAt < this.opts.combatHold) {
        // hold combat for now; keep the request pending
      } else {
        next = want;
        this._pendingCue = undefined;
      }
    }

    // Heuristic driver: only in flight cues and only when nothing explicit is steering.
    if (!explicitFresh && !TERMINAL.has(next) && next !== 'menu' && next !== 'briefing') {
      if (this._heat > 0.22) {
        if (!COMBAT_CUES.has(next)) next = 'combat';
        this._lastCombatAt = now;
        this.targetLevel = Math.min(1, this._heat);
      } else if (COMBAT_CUES.has(next) && now - this._lastCombatAt >= this.opts.combatHold) {
        next = 'cruise';
        this.targetLevel = 0;
      } else if (next === null && this._autoFlight) {
        next = 'cruise';
      }
    }

    // slew the level
    const rate = this.targetLevel > this.level ? this.opts.riseRate : this.opts.fallRate;
    const step = rate * dt;
    if (Math.abs(this.targetLevel - this.level) <= step) this.level = this.targetLevel;
    else this.level += Math.sign(this.targetLevel - this.level) * step;

    this.cue = next;
    return { cue: this.cue, level: this.level, weights: stemWeights(this.level, 3), changed: prev !== this.cue };
  }

  /** When true, an idle machine in flight falls back to the cruise cue. */
  set autoFlight(v) { this._autoFlight = !!v; }
}
