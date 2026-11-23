/**
 * Exposure and grade hints per time of day. Pure data, no three import.
 *
 * The scene is linear HDR in one photometric scale: the sun is 4.6 at the top
 * of the atmosphere, the full moon is NIGHT.moonIrradiance (a compressed 1/10
 * of that; the real ratio is 1/400000) and the moonless floor is the airglow.
 * The compression is deliberate: self-luminous effects (afterburner, tracers,
 * explosions, fires) are authored once, in absolute units, for daylight. The
 * exposure gain between noon and night multiplies them on screen, so the gain
 * has to stay small enough that a reheat plume does not white out the frame
 * (about 2.3x under a full moon, 3.5x with no moon: "dramatic", not "blind").
 *
 * PostFX meters the frame and moves exposure `strength` (0.6) of the way
 * toward it; a moonlit valley meters about 3.4 stops under the daylight
 * reference, a moonless one about 5. The hint (a) lets auto-exposure travel
 * that far (maxEV) and (b) keys the result down (`ev`), so that night ends up
 * about 2.2 stops (moon) to 3.2 stops (no moon) darker on screen than day.
 *
 * The time-of-day system applies the hint each frame:
 *   post.options.exposure.baseEV = (atmosphere calibration) + hint.ev
 *   post.options.exposure.maxEV / minEV / speedDown from the hint
 *   post.uniforms.lookSat / shadowTint / highlightTint scaled by hint.grade
 * `post.options.exposureCompensation` (the player's brightness setting) is
 * never touched.
 */

const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (x) => Math.min(1, Math.max(0, x));
const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };

/** [sun elevation deg, EV bias] - piecewise linear, descending elevation. */
export const EV_BY_SUN = [
  [90, 0], [14, 0], [4, 0.3], [-1, 0.2], [-5, -0.5], [-10, -1.65], [-90, -1.65],
];

export function evBias(sunElevation, table = EV_BY_SUN) {
  if (sunElevation >= table[0][0]) return table[0][1];
  for (let i = 1; i < table.length; i++) {
    const [e1, v1] = table[i];
    if (sunElevation >= e1) {
      const [e0, v0] = table[i - 1];
      return lerp(v1, v0, (sunElevation - e1) / (e0 - e1));
    }
  }
  return table[table.length - 1][1];
}

/** 0 by day, 1 once the sun is 10 degrees down (end of nautical twilight, compressed). */
export const darkness = (sunElevation) => smooth(0.5, -10, sunElevation);

/**
 * @param sunElevation degrees (true sun, may be far below the horizon)
 * @param moonlight 0..1, phase and altitude of the moon folded together
 */
export function lookFor(sunElevation, moonlight = 0) {
  const n = darkness(sunElevation);
  const moonless = n * (1 - clamp01(moonlight * 1.4));
  return {
    night: n,
    /** EV added to the calibrated base exposure. */
    ev: evBias(sunElevation) - 0.25 * moonless,
    /** Auto-exposure travel around the base, in EV. */
    minEV: -1.6,
    maxEV: lerp(2.2, 4.2, n),
    /** Slower dark adaptation at night keeps a flash from snapping straight back. */
    speedDown: lerp(1.1, 0.7, n),
    /** Grade multipliers on PostFX's daylight look (1 = unchanged). */
    grade: {
      saturation: lerp(1, 0.8, n),
      // scotopic blue shift: cool the shadows, keep highlights (fire, tracers) warm
      shadowTint: [lerp(1, 0.9, n), lerp(1, 0.985, n), lerp(1, 1.12, n)],
      highlightTint: [1, 1, lerp(1, 1.03, n)],
      vignette: lerp(1, 1.25, n),
    },
  };
}

/**
 * Twilight compression: [sun elevation deg, gain on the sun's irradiance].
 * Real twilight falls a thousandfold in the half hour after sunset, far below
 * the (compressed) night floor this game uses, which would cut dusk short and
 * drown its colours in airglow. Scaling the sun up as it sinks keeps the whole
 * arc - golden light, alpenglow, belt of Venus, the last glow over the sunset
 * point - inside the range between day and night, in the right order and with
 * the atmosphere model's own colours. Log-linear between entries.
 */
export const TWILIGHT_GAIN = [[1.5, 1], [0, 1.5], [-2, 5], [-4, 20], [-6, 60], [-90, 60]];

export function twilightGain(sunElevation, table = TWILIGHT_GAIN) {
  if (sunElevation >= table[0][0]) return table[0][1];
  for (let i = 1; i < table.length; i++) {
    if (sunElevation >= table[i][0]) {
      const [e0, g0] = table[i - 1];
      const [e1, g1] = table[i];
      return Math.exp(Math.log(g1) + (Math.log(g0) - Math.log(g1)) * (sunElevation - e1) / (e0 - e1));
    }
  }
  return table[table.length - 1][1];
}
