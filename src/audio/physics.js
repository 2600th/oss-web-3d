/**
 * Pure acoustics helpers (no Web Audio, no three.js) so they can be unit-tested
 * under node. Vectors are any `{x, y, z}`.
 *
 * Speed of sound: the Kargil sector flies at 3–7 km where the standard
 * atmosphere is roughly -5..-30 °C, i.e. c ≈ 312–328 m/s. 325 m/s is used.
 */
export const SPEED_OF_SOUND = 325;

const MIN_RATE = 0.35;
const MAX_RATE = 2.8;

function dot(a, b) { return a.x * b.x + a.y * b.y + a.z * b.z; }

/**
 * Doppler pitch factor f'/f for a source and listener with velocities.
 *
 *   f' = f * (c - vL·u) / (c - vS·u)
 *
 * with u the unit vector from source to listener. A source closing on the
 * listener (vS·u > 0) raises pitch; a listener closing on the source (vL·u < 0)
 * also raises it. Supersonic closure is clamped: the true formula diverges and
 * then goes negative (the sound arrives time-reversed), which a playback rate
 * cannot express; the sonic boom is a separate event.
 */
export function dopplerFactor(srcPos, srcVel, lisPos, lisVel, c = SPEED_OF_SOUND) {
  const dx = lisPos.x - srcPos.x, dy = lisPos.y - srcPos.y, dz = lisPos.z - srcPos.z;
  const d = Math.hypot(dx, dy, dz);
  if (d < 1e-3) return 1;
  const u = { x: dx / d, y: dy / d, z: dz / d };
  const vs = srcVel ? Math.min(dot(srcVel, u), c * 0.9) : 0;
  const vl = lisVel ? Math.max(Math.min(dot(lisVel, u), c * 0.9), -c * 0.9) : 0;
  const f = (c - vl) / (c - vs);
  return Math.min(MAX_RATE, Math.max(MIN_RATE, f));
}

/** Seconds for sound to travel `distance` metres. */
export function propagationDelay(distance, c = SPEED_OF_SOUND) {
  return Math.max(0, distance) / c;
}

/**
 * Lowpass cutoff (Hz) approximating atmospheric absorption over `distance`.
 * ISO 9613-1 at ~-10 °C / 50 % RH gives ~0.1 dB/m at 8 kHz and ~0.01 dB/m at
 * 2 kHz: a 1 km path keeps roughly 2 kHz of bandwidth, 5 km well under 1 kHz.
 */
export function airAbsorptionCutoff(distance, maxHz = 20000) {
  const d0 = 60;
  const f = maxHz * Math.pow(d0 / (d0 + Math.max(0, distance)), 0.75);
  return Math.max(220, Math.min(maxHz, f));
}

/**
 * Distance gain, inverse law with a reference distance and a soft fade to zero
 * at `maxDistance` so far sources leave quietly instead of popping out.
 */
export function distanceGain(distance, ref = 30, maxDistance = 12000, rolloff = 1) {
  const d = Math.max(ref, distance);
  const inv = ref / (ref + rolloff * (d - ref));
  const edge = Math.min(1, Math.max(0, (maxDistance - distance) / (maxDistance * 0.2)));
  return inv * edge;
}

/**
 * Closest approach of a relative trajectory. `rel` = source - listener,
 * `relVel` = sourceVel - listenerVel. Returns { t, distance } where t is the
 * time (s) until closest approach (negative if already past).
 */
export function closestApproach(rel, relVel) {
  const vv = dot(relVel, relVel);
  if (vv < 1e-6) return { t: Infinity, distance: Math.hypot(rel.x, rel.y, rel.z) };
  const t = -dot(rel, relVel) / vv;
  const x = rel.x + relVel.x * t, y = rel.y + relVel.y * t, z = rel.z + relVel.z * t;
  return { t, distance: Math.hypot(x, y, z) };
}

/**
 * Crossfade weights across `n` stems for a 0..1 level.
 * 'linear' (weights sum to 1) suits the combat stems, which are three mixes of
 * the same bars and share bit-identical parts: correlated material summed with
 * equal-power gains would bulge +3 dB mid-fade. 'power' (squares sum to 1) is
 * for unrelated material.
 */
export function stemWeights(level, n = 3, law = 'linear') {
  const out = new Array(n).fill(0);
  if (n === 1) { out[0] = 1; return out; }
  const x = Math.min(1, Math.max(0, level)) * (n - 1);
  const i = Math.min(n - 2, Math.floor(x));
  const f = x - i;
  if (law === 'power') {
    out[i] = Math.cos(f * Math.PI * 0.5);
    out[i + 1] = Math.sin(f * Math.PI * 0.5);
  } else {
    const s = f * f * (3 - 2 * f); // smoothstep keeps the ends flat
    out[i] = 1 - s;
    out[i + 1] = s;
  }
  return out;
}

/** dB <-> linear */
export const dbToGain = (db) => Math.pow(10, db / 20);
export const gainToDb = (g) => (g <= 1e-9 ? -180 : 20 * Math.log10(g));
