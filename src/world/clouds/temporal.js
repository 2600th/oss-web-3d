/**
 * Pure parts of the cloud layer's temporal reconstruction (Clouds.js: the
 * resolve pass and renderPasses). No three.js; unit-tested in
 * temporal.test.mjs. The shader uses the same constants and the same
 * formulas, written out in TSL.
 */

/** Most samples a history texel can stand for (its weight never falls below what the blend floors give). */
export const HISTORY_MAX = 16;

/**
 * What one frame's bilinear guess is worth next to a sample marched at the
 * pixel itself. Three pixels in four get a guess each frame (the march runs
 * one pixel of every 2x2 block per frame).
 */
export const STALE_GAIN = 0.25;

/** Two distances (km) belong to the same surface if they differ by less than 12 % plus 4 m. */
export const SURFACE_REL = 0.12;
export const SURFACE_ABS_KM = 0.004;

export function sameSurface(aKm, bKm) {
  return Math.abs(aKm - bKm) < bKm * SURFACE_REL + SURFACE_ABS_KM;
}

/**
 * How a history texel that already stands for `n` samples takes a new value.
 *
 *   alpha = max(floor, gain / (n + gain)),   n' = min(n + gain, HISTORY_MAX)
 *
 * with gain 1 for a pixel marched this frame (`fresh`) and STALE_GAIN for one
 * that only got the bilinear guess. While n is small this is a running mean:
 * a texel with no history (n = 0: first frame, camera cut, sky uncovered by
 * the aircraft) takes the new value outright, the next sample counts a half,
 * then a third. Once 1 / (n + 1) drops under the floor, the floor takes over
 * and it is the exponential blend the layer always had (floorFresh 0.12,
 * floorStale 0.02 by default): the converged image is unchanged.
 *
 * Before, every texel blended at the floors from the first frame on, so new
 * sky kept one noisy, block-shaped guess for a second or more.
 */
export function historyBlend(n, fresh, floorFresh, floorStale) {
  const gain = fresh ? 1 : STALE_GAIN;
  const alpha = Math.max(fresh ? floorFresh : floorStale, gain / (n + gain));
  return { alpha, n: Math.min(n + gain, HISTORY_MAX) };
}

/**
 * Has the camera jumped since the last cloud frame (a cut between two shots,
 * a respawn, a fast-forward with rendering off)? Then last frame's clouds are
 * a picture of somewhere else, and reprojecting them would smear that picture
 * over this one. Each state: { x, y, z } position (m), { fx, fy, fz } unit
 * forward, `tanHalfFov`.
 *
 * Thresholds are far outside flight: 400 m is Mach 2 at one frame a second,
 * 25 degrees a frame is 750 degrees a second at 30 fps, and a zoom never
 * changes the field of view by a third in one frame.
 */
export const CUT_METRES = 400;
export const CUT_COS = Math.cos(25 * Math.PI / 180);
export const CUT_FOV_RATIO = 1.33;

export function cameraCut(prev, cur) {
  if (!prev || !cur) return false;
  const dx = cur.x - prev.x, dy = cur.y - prev.y, dz = cur.z - prev.z;
  if (dx * dx + dy * dy + dz * dz > CUT_METRES * CUT_METRES) return true;
  if (cur.fx * prev.fx + cur.fy * prev.fy + cur.fz * prev.fz < CUT_COS) return true;
  const r = cur.tanHalfFov / prev.tanHalfFov;
  return r > CUT_FOV_RATIO || r < 1 / CUT_FOV_RATIO;
}
