/**
 * Controller rumble patterns (pure; unit-tested in node).
 *
 * Two motors: `strong` (low frequency, heavy: launches, hits taken, blasts)
 * and `weak` (high frequency, buzzy: the gun, hit confirms). Kept short and
 * mostly below half strength: rumble that is on all the time stops meaning
 * anything. The player turns it off with Settings > Controls > Controller
 * vibration (`settings.vibration`, shared with touch haptics).
 */

const clamp01 = (x) => Math.min(1, Math.max(0, x));

export const RUMBLE = {
  gun: { strong: 0.05, weak: 0.28, ms: 110 }, // re-armed every GUN_PERIOD while the trigger is held
  hit: { strong: 0, weak: 0.42, ms: 50 }, // our round or missile struck something
  kill: { strong: 0.45, weak: 0.65, ms: 200 },
  killLead: { strong: 0.75, weak: 0.85, ms: 320 },
  launch: { strong: 0.42, weak: 0.22, ms: 140 },
  rocket: { strong: 0.18, weak: 0.14, ms: 60 },
  flare: { strong: 0, weak: 0.16, ms: 45 },
  nearMiss: { strong: 0.3, weak: 0.45, ms: 170 },
  sonic: { strong: 0.5, weak: 0.2, ms: 220 },
  destroyed: { strong: 1, weak: 1, ms: 700 },
};

/** Gun buzz re-trigger period (ms); a little under its length so it never gaps. */
export const GUN_PERIOD = 90;

/** Shortest gap (ms) between two pulses that are not stronger than the one playing. */
const MIN_GAP = 40;

/** Taking a hit, by severity 0..1 (see cameraMath.hitSeverity). */
export function damageRumble(sev) {
  const k = clamp01(sev);
  return { strong: 0.18 + 0.72 * k, weak: 0.25 + 0.5 * k, ms: Math.round(110 + 230 * k) };
}

const BLAST_REACH = { small: 160, medium: 320, large: 650, huge: 1300 };

/** A blast near the jet (not ours to confirm: just the air shaking). null when too far. */
export function blastRumble(distance, size = 'medium') {
  const reach = BLAST_REACH[size] ?? 320;
  if (!(distance < reach)) return null;
  const k = Math.pow(1 - distance / reach, 1.5);
  if (k < 0.04) return null;
  return { strong: 0.7 * k, weak: 0.35 * k, ms: Math.round(90 + 200 * k) };
}

/**
 * Plays patterns through `play(strong, weak, ms)` (Input.rumble). A new
 * effect replaces the running one on real hardware, so a weaker effect does
 * not cut a stronger one short; the gun buzz is the lowest layer and only
 * re-arms when nothing else is playing.
 */
export class Rumbler {
  constructor({ play, enabled = () => true, now = () => performance.now() }) {
    this.play = play;
    this.enabled = enabled;
    this.now = now;
    this.until = 0;
    this.level = 0;
    this.gunNext = 0;
    this.last = -Infinity;
    this.scale = 1;
  }

  /** Fire one pattern ({strong, weak, ms}); returns true if it played. */
  pulse(spec, scale = 1) {
    if (!spec || !this.enabled()) return false;
    const k = scale * this.scale;
    const strong = clamp01(spec.strong * k);
    const weak = clamp01(spec.weak * k);
    if (strong + weak <= 0.01) return false;
    const t = this.now();
    const level = strong + weak;
    if (t < this.until && level < this.level - 0.05) return false;
    // a burst of equal pulses (a dozen rounds landing in one frame) is one
    // effect: re-arm at most every MIN_GAP unless this one is stronger
    if (t < this.until && t - this.last < MIN_GAP && level <= this.level + 0.05) return false;
    if (this.play(strong, weak, spec.ms) === false) return false;
    this.until = t + spec.ms;
    this.level = level;
    this.last = t;
    return true;
  }

  /** Per frame: keep the gun buzz going while `gunFiring`. */
  update(gunFiring) {
    if (!gunFiring) return;
    const t = this.now();
    if (t < this.gunNext || t < this.until - 20) return;
    this.gunNext = t + GUN_PERIOD;
    this.pulse(RUMBLE.gun);
  }

  stop(stopHardware) {
    this.until = 0;
    this.level = 0;
    this.gunNext = 0;
    stopHardware?.();
  }
}
