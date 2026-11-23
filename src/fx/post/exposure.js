/**
 * Auto-exposure maths (pure, no three.js). The GPU meters the frame's
 * centre-weighted average log2 luminance; this file turns that number into an
 * exposure multiplier with eye-like adaptation.
 *
 * Exposure is *partial* metering around a calibrated reference, not "make the
 * average mid grey". A frame that is 80% sunlit snow under a deep blue sky is
 * genuinely bright; metering it fully to 18% grey turns the snow into concrete
 * and the sky into slate. So the meter only moves exposure `strength` of the
 * way from the calibrated base toward the metered target, and never beyond
 * [minEV, maxEV] around it.
 */
export const EXPOSURE_DEFAULTS = Object.freeze({
  baseEV: -0.75, // exposure (log2) for the reference scene: sunlit terrain under clear sky
  refLog: -1.15, // metered average log2 luminance of that reference scene (measured in-game: -1.09..-1.15)
  strength: 0.6, // 0 = fixed exposure, 1 = full metering
  minEV: -1.6, // relative to baseEV: how much darker it may go (sun-filled frame, snowfield)
  maxEV: 2.2, // relative to baseEV: how much brighter (inside cloud, shadowed valley, dusk)
  speedUp: 2.4, // 1/s adaptation toward a brighter scene (eye closes fast)
  speedDown: 1.1, // 1/s toward a darker scene (eye opens slowly)
});

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

/** Target exposure EV for a metered average log2 luminance. */
export function targetExposureEV(avgLog2, o = EXPOSURE_DEFAULTS, compensationEV = 0) {
  const metered = Number.isFinite(avgLog2) ? avgLog2 : o.refLog;
  const delta = clamp((o.refLog - metered) * o.strength, o.minEV, o.maxEV);
  return o.baseEV + delta + compensationEV;
}

/**
 * Frame-rate independent adaptation of the *metered luminance* in log2 space.
 * Brightening (metered going up) adapts faster than darkening.
 */
export function adaptLog2(current, target, dt, o = EXPOSURE_DEFAULTS) {
  if (!Number.isFinite(current)) return target;
  if (!Number.isFinite(target) || !(dt > 0)) return current;
  const rate = target > current ? o.speedUp : o.speedDown;
  return current + (target - current) * (1 - Math.exp(-rate * Math.min(dt, 0.25)));
}

export function evToMultiplier(ev) { return Math.pow(2, ev); }
