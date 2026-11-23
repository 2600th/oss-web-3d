// Pure numbers behind the sun / moon shadows (no three.js imports: node-tested).
//
// References:
//  - Cascaded shadow maps, practical split scheme: Zhang et al., "Parallel-Split
//    Shadow Maps" (2006); Dimitrov, "Cascaded Shadow Maps" (NVIDIA, 2007).
//  - Stable cascades (sphere-sized, texel-snapped): Valient, "Stable Rendering of
//    Cascaded Shadow Maps", ShaderX6 (2008). three's CSMShadowNode does both.
//  - Penumbra from the light's angular size: Fernando, "Percentage-Closer Soft
//    Shadows" (NVIDIA, 2005). For a distant disc light the penumbra width grows
//    linearly with the blocker-receiver distance d: w = 2 d tan(theta / 2).
//  - Cloud shadow tracing distance: Hillaire, "Physically Based Sky, Atmosphere
//    and Cloud Rendering in Frostbite" (SIGGRAPH 2016 course) and Unreal's
//    VolumetricCloud "Shadow Tracing Distance" (default 15 km): the cloud shadow
//    map only integrates a bounded length of the sun ray.

/** Angular diameter of the sun and of the full moon seen from the Earth (degrees). */
export const SUN_ANGULAR_DIAMETER = 0.533;
export const MOON_ANGULAR_DIAMETER = 0.518;

/** tan(theta / 2): penumbra half-width per metre of blocker-receiver distance. */
export function penumbraSlope(angularDiameterDeg = SUN_ANGULAR_DIAMETER) {
  return Math.tan((angularDiameterDeg * Math.PI) / 360);
}

/** Full penumbra width (m) for a blocker `separation` metres above the receiver along the light. */
export function penumbraWidth(separation, angularDiameterDeg = SUN_ANGULAR_DIAMETER) {
  return 2 * Math.max(0, separation) * penumbraSlope(angularDiameterDeg);
}

/**
 * Distance (m) from a caster of width `width` at which its umbra vanishes:
 * beyond it the caster only ever hides part of the sun disc, so its shadow
 * fades out (a guy wire, a mast, an aircraft seen from far below).
 */
export function umbraLength(width, angularDiameterDeg = SUN_ANGULAR_DIAMETER) {
  return width / (2 * penumbraSlope(angularDiameterDeg));
}

/**
 * Cascade split distances, normalised by `far` (three's CSMShadowNode
 * `customSplitsCallback` contract: push `count` values, the last one 1).
 * lambda blends the logarithmic (1) and uniform (0) schemes (PSSM).
 */
export function cascadeSplits(count, near, far, lambda = 0.8, target = []) {
  target.length = 0;
  for (let i = 1; i < count; i++) {
    const f = i / count;
    const log = near * (far / near) ** f;
    const uni = near + (far - near) * f;
    target.push((lambda * log + (1 - lambda) * uni) / far);
  }
  target.push(1);
  return target;
}

/**
 * Per-tier sun shadow setup. `cascades` / `mapSize` default to the Quality
 * tier's `shadowCascades` / `shadowMapSize`; `far` is the distance (m) from
 * the camera that the shadow map covers (it fades out over the last quarter;
 * beyond it the terrain's own heightfield shadow and the cloud shadow remain).
 * `pcss` = contact-hardening soft shadows (WebGPU only: it reads raw depth).
 * Without it the filter is a fixed disc of `fallbackRadius()` metres.
 */
export const SUN_SHADOW_TIERS = {
  low: { cascades: 2, mapSize: 1024, far: 260, lambda: 0.7, pcss: false, blocker: 0, taps: 8 },
  medium: { cascades: 3, mapSize: 2048, far: 520, lambda: 0.8, pcss: true, blocker: 8, taps: 12 },
  high: { cascades: 4, mapSize: 2048, far: 900, lambda: 0.82, pcss: true, blocker: 10, taps: 16 },
  ultra: { cascades: 4, mapSize: 4096, far: 1200, lambda: 0.82, pcss: true, blocker: 12, taps: 20 },
};

export function sunShadowConfig(tier = {}, backend = 'webgpu') {
  const base = SUN_SHADOW_TIERS[tier.name] ?? SUN_SHADOW_TIERS.high;
  const cfg = {
    ...base,
    cascades: tier.shadowCascades ?? base.cascades,
    mapSize: tier.shadowMapSize ?? base.mapSize,
  };
  if (backend !== 'webgpu') cfg.pcss = false; // the WebGL2 backend cannot load a compare-sampled depth texture
  return cfg;
}

/**
 * Filter radius (m) when there is no blocker search (low tier, WebGL2): the
 * penumbra half-width of a caster FALLBACK_SEPARATION metres above the ground.
 * A fixed disc that size still fades the shadows of casters much thinner than
 * it (guy wires, aerials) the way their missing umbra would, at the price of
 * slightly soft contact shadows.
 */
export const FALLBACK_SEPARATION = 30;

export function fallbackRadius(angularDiameterDeg = SUN_ANGULAR_DIAMETER, separation = FALLBACK_SEPARATION) {
  return separation * penumbraSlope(angularDiameterDeg);
}

/** World size (m) of one shadow-map texel for an orthographic cascade `width` metres across. */
export function texelWorld(width, mapSize) {
  return width / mapSize;
}

/**
 * Bias for a cascade, in world metres: a normal offset of ~1.5 texels removes
 * acne on lit faces without the detached ("peter-panning") shadows a large
 * constant depth bias gives, plus a small depth bias that scales with the texel.
 * (Holbert, "Normal Offset Shadows", GDC 2011; MJP, "A Sampling of Shadow Techniques".)
 */
export function cascadeBias(texel) {
  return { normal: 1.5 * texel, depth: 0.5 * texel };
}

/* --------------------------------------------------------------- clouds */

/**
 * Where the cloud shadow march runs along the sun ray, measured from the point
 * where the ray crosses `refY`: from the cloud base to the top, but never more
 * than `maxPath` metres of ray. At a grazing sun the ray crosses the layer over
 * tens of kilometres; integrating all of it with a handful of steps aliases
 * into stripes across the sun azimuth, and the far end of it does not shade
 * the ground anyway (the light there has crossed the whole atmosphere).
 */
export const CLOUD_SHADOW_PATH = 8000; // metres of sun ray the cloud shadow map integrates

export function cloudShadowSpan(base, top, sunY, refY, maxPath = CLOUD_SHADOW_PATH, steps = 16) {
  const sy = Math.max(sunY, 1e-3);
  const t0 = (base - refY) / sy;
  const t1 = Math.min((top - refY) / sy, t0 + maxPath);
  return { t0, t1, ds: (t1 - t0) / steps };
}

/* ------------------------------------------------------ terrain sweep */

/**
 * How strongly the terrain's heightfield shadow applies to a receiver `agl`
 * metres above the DEM ground: fully near the ground (units, props, the
 * aircraft on a low pass), fading out where the 8-bit sweep saturates.
 */
export const SWEEP_REACH = { full: 36, none: 46 }; // the 8-bit sweep saturates at 47.75 m (shadowConst.js)

export function sweepReach(agl, full = SWEEP_REACH.full, none = SWEEP_REACH.none) {
  if (agl <= full) return 1;
  if (agl >= none) return 0;
  const t = (agl - full) / (none - full);
  return 1 - t * t * (3 - 2 * t);
}
