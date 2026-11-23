/**
 * Pure camera maths (no three.js, unit-tested in camera-math.test.mjs).
 *
 * Everything time-dependent is frame-rate independent: exponential damping
 * x += (target - x) * (1 - exp(-lambda * dt)) rather than lerp(x, t, 0.1),
 * and springs are sub-stepped so a 20 fps hitch cannot make them explode.
 */

export const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
export const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
export const dampFactor = (lambda, dt) => 1 - Math.exp(-lambda * Math.max(0, dt));
export const damp = (a, b, lambda, dt) => a + (b - a) * dampFactor(lambda, dt);

/**
 * Damped spring toward `target`. state = { x, v }. `freq` in Hz, `zeta` damping
 * ratio (1 = critical, < 1 overshoots: that overshoot is the "gut" in a G kick).
 */
export function springStep(state, target, freq, zeta, dt) {
  const w = 2 * Math.PI * freq;
  let remaining = Math.min(Math.max(0, dt), 0.1);
  const h = 1 / 240;
  while (remaining > 1e-6) {
    const s = Math.min(h, remaining);
    const a = w * w * (target - state.x) - 2 * zeta * w * state.v;
    state.v += a * s;
    state.x += state.v * s;
    remaining -= s;
  }
  return state.x;
}

/** Chase distance grows a little with speed so 900 km/h reads as fast, not as "same jet, smaller". */
export function chaseDistance(airspeed) {
  return 16.5 + smoothstep(120, 420, airspeed) * 4.5;
}

/**
 * Field of view target: a small speed ramp plus an afterburner kick. Kept
 * subtle (about +12 degrees at most) — the effect works when it is felt, not noticed.
 */
export function fovTarget({ baseFov = 62, airspeed = 0, reheat = 0, brake = 0 } = {}) {
  return baseFov + smoothstep(140, 480, airspeed) * 7 + clamp(reheat, 0, 1) * 5 - clamp(brake, 0, 1) * 2.5;
}

/**
 * Smooth deterministic noise in [-1, 1]: sum of incommensurate sines, cheap and
 * free of the periodicity you see with a single sine.
 */
export function noise1(t, seed = 0) {
  const s = seed * 17.13;
  return (
    Math.sin(t * 1.0 + s) * 0.5 +
    Math.sin(t * 2.17 + s * 1.7 + 1.3) * 0.3 +
    Math.sin(t * 4.79 + s * 2.3 + 2.1) * 0.2
  );
}

/**
 * Rotational shake in radians from impulse trauma (0..1, squared for a
 * natural fall-off) and continuous rumble (0..1, high-frequency buzz).
 * Big + slow for hits/explosions, small + fast for guns/buffet.
 */
export function shakeAngles(t, trauma, rumble, scale = 1, out = { yaw: 0, pitch: 0, roll: 0 }) {
  const tr = clamp(trauma, 0, 1);
  const a = tr * tr * scale;
  const r = clamp(rumble, 0, 1) * scale;
  const ft = t * 9.0; // impulse shake frequency (rad/s scale for noise1)
  const fr = t * 47.0; // rumble frequency
  out.yaw = noise1(ft, 1) * 0.045 * a + noise1(fr, 4) * 0.0035 * r;
  out.pitch = noise1(ft, 2) * 0.045 * a + noise1(fr, 5) * 0.0045 * r;
  out.roll = noise1(ft, 3) * 0.07 * a + noise1(fr, 6) * 0.003 * r;
  return out;
}

/** Trauma for an explosion at `distance` m. 0 beyond its felt radius. */
export function explosionTrauma(distance, size = 'medium') {
  const R = { small: 120, medium: 260, large: 500, huge: 900 }[size] ?? 260;
  const k = { small: 0.35, medium: 0.6, large: 0.85, huge: 1 }[size] ?? 0.6;
  if (!(distance < R)) return 0;
  const f = 1 - distance / R;
  return k * f * f;
}

/** Continuous rumble from flight state: G buffet, stall buffet, fast + low. */
export function flightRumble({ gLoad = 1, stallFactor = 0, airspeed = 0, agl = 1e4 } = {}) {
  const g = smoothstep(5, 9, gLoad) * 0.55;
  const stall = clamp(stallFactor, 0, 1) * 0.5;
  // ground effect turbulence: fast and low shakes, felt from ~650 km/h under 300 m
  const low = smoothstep(180, 360, airspeed) * (1 - smoothstep(40, 300, agl)) * 0.5;
  return clamp(g + stall + low, 0, 1);
}

/** Wrap an angle to (-PI, PI]. */
export function wrapAngle(a) {
  a = (a + Math.PI) % (2 * Math.PI);
  if (a < 0) a += 2 * Math.PI;
  return a - Math.PI;
}

/** Ease for camera transitions. */
export const easeInOut = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };

/** Danger check for the kill cam: never cut away while the player is under threat. */
export function inDanger({ threats = 0, warning = 'none', agl = 1e4, health = 1, crashed = false } = {}) {
  if (crashed) return true;
  if (threats > 0) return true;
  if (warning === 'missile' || warning === 'pullup' || warning === 'terrain' || warning === 'stall') return true;
  if (agl < 220) return true;
  if (health < 0.25) return true;
  return false;
}

/** Speed of sound (m/s) at altitude, ISA troposphere (floors at the tropopause). */
export function speedOfSound(altitude = 0) {
  const T = Math.max(216.65, 288.15 - 0.0065 * altitude);
  return Math.sqrt(1.4 * 287.05 * T);
}

/**
 * Mach-crossing detector with hysteresis (pure; `state` = { above }).
 * Returns +1 when accelerating through Mach 1.0 (latched above 1.0), -1 when
 * decelerating back below 0.97, else 0. Hysteresis keeps a jet hovering at
 * exactly Mach 1 from thumping every frame.
 */
export function machCrossing(state, mach) {
  if (state.above === undefined) { state.above = mach >= 1.0; return 0; }
  if (!state.above && mach >= 1.0) { state.above = true; return 1; }
  if (state.above && mach < 0.97) { state.above = false; return -1; }
  return 0;
}

/**
 * Time-dilation envelope for slow-motion beats (kill cam, missile impact,
 * death). Eases from 1 to `scale` over `ease` s, holds until `hold`, eases
 * back to 1 by `end`. Smooth at both ends so audio pitch and the physics
 * step never jump.
 */
export function warpScale(t, { scale = 0.25, ease = 0.15, hold = 1.6, end = 2.4 } = {}) {
  if (!(t > 0) || t >= end) return 1;
  let k;
  if (t < ease) k = easeInOut(t / ease);
  else if (t <= hold) k = 1;
  else k = 1 - easeInOut((t - hold) / Math.max(1e-3, end - hold));
  return 1 + (scale - 1) * k;
}

/**
 * Chase-camera lag per speed: a spring frequency (Hz) for the boom offset.
 * Slow: tight (the jet stays put in frame); fast: looser, so accelerations
 * and pulls read as the camera being dragged along. `lag` = user scale (0..1.5).
 */
export function chaseLagFreq(airspeed, lag = 1) {
  const base = 2.2 - 0.9 * smoothstep(120, 450, airspeed);
  return base / Math.max(0.35, lag);
}

/**
 * Pick the dramatic shot for the optional action ("cinematic") camera.
 * Deterministic: a slot from elapsed time, filtered by what makes sense at
 * the current range. Returns 'shoulder' | 'side' | 'enemy'.
 */
export function actionShot(elapsed, range, seed = 0) {
  const shots = range < 1400 ? ['shoulder', 'enemy', 'side', 'shoulder'] : ['shoulder', 'side', 'shoulder'];
  const slot = Math.floor(Math.max(0, elapsed) / 5.5 + seed) % shots.length;
  return shots[slot];
}
