import * as THREE from 'three/webgpu';
import { Fn, float, vec2, vec3, vec4, uv, Loop, max, min, smoothstep, select, luminance, rtt, interleavedGradientNoise, screenCoordinate, screenSize, exp } from 'three/tsl';

/**
 * Screen-space crepuscular rays (Mitchell, "Volumetric Light Scattering as a
 * Post-Process", GPU Gems 3 ch. 13), for a low sun only.
 *
 * The froxel aerial perspective already integrates cloud shadow in 3D (shafts
 * under a cloud deck at any sun angle). What it cannot see is the terrain
 * cutting the sun off (its shadow sweep stops 46 m above the ground) or the
 * clean edges of cloud gaps right around the sun. This pass radially blurs
 * the bright sky around the sun toward each pixel: where a ridge or a cloud
 * body interrupts it, the streak breaks, leaving shafts.
 *
 * Two passes at `scale` of the drawing buffer: an emitter mask from the
 * composited HDR colour and the reversed depth (sky = 0; only sky texels
 * brighter than `floor`, in exposed units, emit, so clouds and terrain are
 * occluders and the sun's surroundings are the source), then a `samples`-tap
 * radial march over it. The result (exposed
 * HDR, scaled by `u.strength`) is added in the final composite; `u.strength`
 * is 0 unless the sun is on or near the screen, low, and the key light.
 */
export function createGodRays({ color, depth, sunUV, exposure, aspect, near, far, samples = 32, scale = 0.25, u }) {
  const n = samples;
  // 1. Emitters at `scale`: bright sky texels (around the sun, silver cloud
  //    edges), capped so the disc cannot dominate. A 4-tap box over the
  //    full-resolution colour/depth: thin bright strips (the gap between a
  //    cloud base and the ridges) must not alias into rings in the march.
  const mask = rtt(Fn(() => {
    const st = uv();
    const o = vec2(0.25, 0.25).div(screenSize); // the mask target's own texel
    const tap = (dx, dy) => {
      const q = st.add(o.mul(vec2(dx, dy)));
      const sky = select(depth.sample(q).x.lessThanEqual(0.0), float(1), float(0));
      const c = color.sample(q).rgb.mul(exposure);
      const e = max(luminance(c).sub(u.floor), 0).min(u.cap);
      return c.div(max(luminance(c), 1e-4)).mul(e).mul(sky);
    };
    return vec4(tap(-1, -1).add(tap(1, -1)).add(tap(-1, 1)).add(tap(1, 1)).mul(0.25), 1);
  })(), null, null, { type: THREE.HalfFloatType, resolutionScale: scale });
  mask.name = 'GodRays.mask';

  // 2. Radial march toward the sun over the (bilinear, already smooth) mask.
  const node = Fn(() => {
    const st = uv().toVar();
    const toSun = sunUV.sub(st).toVar();
    const len = toSun.mul(vec2(aspect, 1)).length();
    const span = min(len, 0.5).div(max(len, 1e-4)); // at most half the frame
    const step = toSun.mul(span).div(n).toVar();
    // per-texel start jitter turns the residual staircase into fine noise
    const p = st.add(step.mul(interleavedGradientNoise(screenCoordinate.xy))).toVar();
    const acc = vec3(0).toVar();
    const w = float(1).toVar();
    Loop(n, () => {
      p.addAssign(step);
      acc.addAssign(mask.sample(p.clamp(0, 1)).rgb.mul(w));
      w.mulAssign(u.decay);
    });
    // fall-off away from the sun in the frame
    const fall = smoothstep(1.1, 0.0, len);
    // the shafts are light scattered along the view ray: a ridge 2 km away
    // has little air in front of it, the sky has all of it
    const d = depth.sample(st).x;
    const dist = near.mul(far).div(d.mul(far.sub(near)).add(near));
    const air = select(d.lessThanEqual(0.0), float(1), float(1).sub(exp(dist.div(u.airLength).negate())));
    return vec4(acc.div(n).mul(fall).mul(air), 1);
  })();
  const tex = rtt(node, null, null, { type: THREE.HalfFloatType, resolutionScale: scale });
  tex.name = 'GodRays';
  tex.mask = mask;
  return tex;
}

/**
 * Strength of the rays for a sun direction (world, unit) and on-screen amount
 * (PostFX `sunAmount`: in front, on screen, sun is the key light). Pure.
 * Rays are a low-sun phenomenon: full below 6 degrees, gone by 24.
 */
export function godRayStrength(sunElevationDeg, sunAmount, gain = 1) {
  const t = Math.min(1, Math.max(0, (24 - sunElevationDeg) / 18));
  const low = t * t * (3 - 2 * t);
  return gain * low * Math.min(1, Math.max(0, sunAmount));
}
