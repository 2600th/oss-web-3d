/**
 * Headlight-beam tuning and bookkeeping (pure: no three.js import, so it is
 * node-tested). The renderer is HeadlightBeams.js.
 */

/**
 * The dipped beam of a truck, both lamps as one source (they are 1.6 m
 * apart; on the road that is lost in the falloff).
 *   spread     tan of the half-width of the pattern (~24 deg)
 *   cutoff     tan of the cut-off elevation (just under the horizon)
 *   aimDown    the beam axis is pitched this far down (tan, ~2 deg)
 *   slopeProbe metres ahead at which the road slope is sampled to pitch the beam
 *   intensity  renderer units: the pool near the truck reads ~10x the
 *              moonlit ground at Black Road's exposure, a few metres of
 *              road under the lamps clip to white
 *   throwRef / throwMax   the 1/d^2 falloff is multiplied by min(d / ref, max):
 *              the hot spot of a low beam lies down the road, not under the bumper
 *   albedo     road dust / gravel
 *   sigma      scattering coefficient of the night air (1/m): a faint cone,
 *              not fog
 *   g          Henyey-Greenstein asymmetry of that haze
 *   spill      fraction of the beam above the cut-off (kept small: the volume
 *              box would clip it to a hard edge)
 *   below / above  box extent under / over the lamp (m), for slopes
 *   nightOn    env.night range over which beams fade in (never by day)
 */
export const BEAM = {
  spread: 0.45,
  cutoff: -0.012,
  aimDown: 0.035,
  slopeProbe: 16,
  intensity: 1500,
  throwRef: 7,
  throwMax: 3,
  albedo: 0.3,
  sigma: 0.008,
  g: 0.55,
  spill: 0.02,
  below: 7,
  above: 4,
  color: [1, 0.8, 0.55],
  nightOn: [0.25, 0.65],
};

/** Per quality tier: how many beams are drawn, how far they reach, march steps (0 = pool only). */
export const BEAM_TIERS = {
  low: { capacity: 12, steps: 0, range: 34, maxDistance: 6000 },
  medium: { capacity: 24, steps: 4, range: 40, maxDistance: 9000 },
  high: { capacity: 48, steps: 6, range: 45, maxDistance: 12000 },
  ultra: { capacity: 64, steps: 8, range: 50, maxDistance: 15000 },
};

export function beamTier(name) {
  return { ...(BEAM_TIERS[name] ?? BEAM_TIERS.high) };
}

/**
 * The beams to draw this frame: items within `cfg.maxDistance` of the camera,
 * nearest first, at most `cfg.capacity`. Items carry `object3d.matrixWorld`
 * (its translation is read directly). `cam` is {x, y, z}.
 */
export function beamSlots(items, cam, cfg) {
  const out = [];
  const max2 = cfg.maxDistance * cfg.maxDistance;
  for (const it of items) {
    const e = it.object3d?.matrixWorld?.elements;
    if (!e) continue;
    const dx = e[12] - cam.x, dy = e[13] - cam.y, dz = e[14] - cam.z;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 > max2) continue;
    it._d2 = d2;
    out.push(it);
  }
  if (out.length > cfg.capacity) {
    out.sort((a, b) => a._d2 - b._d2);
    out.length = cfg.capacity;
  }
  return out;
}
