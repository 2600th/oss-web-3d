/**
 * The cloud density field, shared by the volumetric raymarch and the terrain's
 * cloud shadows.
 *
 * One source of truth on purpose. The old billboard system had the shadow on
 * the ground computed from a different, cheaper noise than the thing in the
 * sky, so a shadow never actually belonged to a cloud — you could fly under a
 * bank in clear light and through a shadow with nothing above you. Sharing the
 * field means the shadow is cast by the cloud that is really there.
 *
 * Shape follows the standard modelling used for real-time cloudscapes: a
 * low-frequency coverage field decides *where* cloud exists, a vertical profile
 * decides its silhouette between cloud base and top, and higher-frequency noise
 * erodes the edges. Erosion is subtractive and scaled by (1 - base), so it eats
 * into the boundary of a cloud without punching holes through its core.
 */

export const CLOUD_CONSTANTS = {
  BASE: 4600, // cloud base, metres
  TOP: 8600, // sparse convective crowns rise above the 7.5 km opening route
  COVERAGE_SCALE: 0.00055,
  DETAIL_SCALE: 0.00082,
  COVERAGE_LOW: 0.24,
  COVERAGE_HIGH: 0.68,
  ERODE: 0.42,
  DENSITY: 0.0042,
};

export const OPENING_CLOUD_CORRIDOR = Object.freeze({
  x: 21000,
  z: 6000,
  heading: Math.PI * 0.62,
  clearDistance: 11500,
  fadeDistance: 15500,
  halfWidth: 3000,
  widthSlope: 0.8,
  edgeFade: 400,
});

const OPENING_CLOUD_BANK_REVEAL_DISTANCE = 8000;

export function openingCloudCorridorWidth(along) {
  return OPENING_CLOUD_CORRIDOR.halfWidth +
    Math.max(along - OPENING_CLOUD_BANK_REVEAL_DISTANCE, 0) * OPENING_CLOUD_CORRIDOR.widthSlope;
}

const mixCpu = (a, b, t) => a + (b - a) * t;
const smoothCpu = (a, b, value) => {
  const t = Math.max(0, Math.min(1, (value - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

function hashCpu(x, y, z) {
  let n = (Math.imul((Math.floor(x) + 4096) >>> 0, 1597334677)
    ^ Math.imul((Math.floor(y) + 4096) >>> 0, 3812015801)
    ^ Math.imul((Math.floor(z) + 4096) >>> 0, 2798796415)) >>> 0;
  n = Math.imul((n ^ (n >>> 15)) >>> 0, 2246822519) >>> 0;
  n = Math.imul((n ^ (n >>> 13)) >>> 0, 3266489917) >>> 0;
  n = (n ^ (n >>> 16)) >>> 0;
  return (n >>> 8) / 16777215;
}

function noiseCpu(x, y, z) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx0 = x - ix, fy0 = y - iy, fz0 = z - iz;
  const fx = fx0 * fx0 * (3 - 2 * fx0);
  const fy = fy0 * fy0 * (3 - 2 * fy0);
  const fz = fz0 * fz0 * (3 - 2 * fz0);
  const x00 = mixCpu(hashCpu(ix, iy, iz), hashCpu(ix + 1, iy, iz), fx);
  const x10 = mixCpu(hashCpu(ix, iy + 1, iz), hashCpu(ix + 1, iy + 1, iz), fx);
  const x01 = mixCpu(hashCpu(ix, iy, iz + 1), hashCpu(ix + 1, iy, iz + 1), fx);
  const x11 = mixCpu(hashCpu(ix, iy + 1, iz + 1), hashCpu(ix + 1, iy + 1, iz + 1), fx);
  return mixCpu(mixCpu(x00, x10, fy), mixCpu(x01, x11, fy), fz);
}

function openingCorridorFactorCpu(x, z) {
  const corridor = OPENING_CLOUD_CORRIDOR;
  const forwardX = -Math.sin(corridor.heading);
  const forwardZ = -Math.cos(corridor.heading);
  const rightX = -forwardZ;
  const rightZ = forwardX;
  const dx = x - corridor.x;
  const dz = z - corridor.z;
  const along = dx * forwardX + dz * forwardZ;
  const lateral = Math.abs(dx * rightX + dz * rightZ);
  const forwardWindow = smoothCpu(-2600, -400, along) *
    (1 - smoothCpu(corridor.clearDistance, corridor.fadeDistance, along));
  const width = openingCloudCorridorWidth(along);
  const across = 1 - smoothCpu(width, width + corridor.edgeFade, lateral);
  return 1 - forwardWindow * across;
}

/** Numeric mirror used to validate the actual weather distribution on routes. */
export function evaluateCloudColumn(x, z, time = 0, windX = 1, windZ = 0) {
  let px = (x + windX * time) * CLOUD_CONSTANTS.COVERAGE_SCALE;
  let pz = (z + windZ * time) * CLOUD_CONSTANTS.COVERAGE_SCALE;
  const weather = noiseCpu(px * 0.105, pz * 0.105, 2.3);
  const front = noiseCpu(px * 0.036 + 17.2, pz * 0.036 - 9.7, 21.1);
  const warp = noiseCpu(px * 0.47, pz * 0.47, 11.7) * 2 - 1;
  px += warp * 0.9;
  pz += warp * 0.9;
  const low = noiseCpu(px, pz, 3.1);
  const mid = noiseCpu(px * 2.1, pz * 2.1, 7.9) * 0.30;
  const fine = noiseCpu(px * 4.2, pz * 4.2, 13.3) * 0.06;
  const shape = (low + mid + fine) / 1.36;
  const system = mixCpu(weather, front, 0.42);
  const threshold = mixCpu(0.585, 0.325, smoothCpu(0.32, 0.72, system));
  const bank = Math.max(0, Math.min(1, (shape - threshold) * 3.5));
  const coverage = bank * smoothCpu(0.38, 0.62, system) * openingCorridorFactorCpu(x, z);
  const shaped = smoothCpu(CLOUD_CONSTANTS.COVERAGE_LOW, CLOUD_CONSTANTS.COVERAGE_HIGH, coverage);

  const ax = (x + windX * time) * 0.00082;
  const az = (z + windZ * time) * 0.00082;
  const billow = noiseCpu(ax * 0.78, az * 0.78, 18.4);
  const towerCell = noiseCpu(ax * 1.62 + 6.2, az * 1.62 - 4.1, 31.7);
  const crown = noiseCpu(ax * 2.45 - 11.8, az * 2.45 + 7.3, 46.2);
  const tower = smoothCpu(0.35, 0.68, towerCell) * smoothCpu(0.18, 0.60, billow) * shaped;
  const topFraction = Math.max(0, Math.min(1, 0.24 + 0.38 * shaped + 0.50 * tower + 0.09 * crown * shaped));
  return {
    coverage,
    shaped,
    tower,
    top: CLOUD_CONSTANTS.BASE + (CLOUD_CONSTANTS.TOP - CLOUD_CONSTANTS.BASE) * topFraction,
  };
}

export const CLOUD_GLSL = /* glsl */ `
uniform float uCloudBase;
uniform float uCloudTop;
uniform float uCloudCoverage;
uniform float uCloudDensity;
uniform vec2 uCloudWind;
uniform float uCloudTime;
uniform float uDetailLevel;

float openingCorridorFactor(vec2 xz) {
  const vec2 origin = vec2(${OPENING_CLOUD_CORRIDOR.x.toFixed(1)}, ${OPENING_CLOUD_CORRIDOR.z.toFixed(1)});
  const vec2 forward = vec2(${(-Math.sin(OPENING_CLOUD_CORRIDOR.heading)).toFixed(8)}, ${(-Math.cos(OPENING_CLOUD_CORRIDOR.heading)).toFixed(8)});
  const vec2 right = vec2(-forward.y, forward.x);
  vec2 delta = xz - origin;
  float along = dot(delta, forward);
  float lateral = abs(dot(delta, right));
  float forwardWindow = smoothstep(-2600.0, -400.0, along) *
    (1.0 - smoothstep(${OPENING_CLOUD_CORRIDOR.clearDistance.toFixed(1)}, ${OPENING_CLOUD_CORRIDOR.fadeDistance.toFixed(1)}, along));
  float width = ${OPENING_CLOUD_CORRIDOR.halfWidth.toFixed(1)} +
    max(along - ${OPENING_CLOUD_BANK_REVEAL_DISTANCE.toFixed(1)}, 0.0) *
      ${OPENING_CLOUD_CORRIDOR.widthSlope.toFixed(3)};
  float across = 1.0 - smoothstep(width, width + ${OPENING_CLOUD_CORRIDOR.edgeFade.toFixed(1)}, lateral);
  return 1.0 - forwardWindow * across;
}

// Integer lattice hash. Same reasoning as the terrain: fract-based hashes lose
// precision at large world coordinates and start repeating visibly.
float c_hash(vec3 p) {
  uvec3 q = uvec3(ivec3(floor(p)) + 4096);
  uint n = q.x * 1597334677u ^ q.y * 3812015801u ^ q.z * 2798796415u;
  n = (n ^ (n >> 15u)) * 2246822519u;
  n = (n ^ (n >> 13u)) * 3266489917u;
  n ^= n >> 16u;
  return float(n >> 8u) * (1.0 / 16777215.0);
}

float c_noise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float n000 = c_hash(i);
  float n100 = c_hash(i + vec3(1, 0, 0));
  float n010 = c_hash(i + vec3(0, 1, 0));
  float n110 = c_hash(i + vec3(1, 1, 0));
  float n001 = c_hash(i + vec3(0, 0, 1));
  float n101 = c_hash(i + vec3(1, 0, 1));
  float n011 = c_hash(i + vec3(0, 1, 1));
  float n111 = c_hash(i + vec3(1, 1, 1));
  return mix(
    mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
    mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y),
    f.z);
}

float c_fbm(vec3 p, int octaves) {
  float sum = 0.0, amp = 0.5, norm = 0.0;
  for (int i = 0; i < 5; i++) {
    if (i >= octaves) break;
    sum += amp * c_noise(p);
    norm += amp;
    amp *= 0.52;
    p *= 2.13;
  }
  return sum / max(norm, 1e-4);
}

// A ridged companion to the soft value noise. Mixing the two by height gives
// a dense, billowy crown and wind-sheared wisps without sampling a texture.
float c_ridge(float n) {
  float r = 1.0 - abs(n * 2.0 - 1.0);
  return r * r;
}

/**
 * Coverage: how much cloud exists over this ground position, 0..1.
 *
 * Two octaves plus a wide warp. The warp is what stops banks looking like a
 * noise texture stretched across the sky — real cloud fields have structure at
 * a scale much larger than the individual clouds.
 */
float cloudCoverage(vec2 xz) {
  vec2 p = (xz + uCloudWind * uCloudTime) * uCloudCoverage;
  // Weather scale: a slow field deciding which parts of the sky have cloud at
  // all, so banks group into systems instead of being evenly sprinkled.
  float weather = c_noise(vec3(p * 0.105, 2.3));
  float front = c_noise(vec3(p * 0.036 + vec2(17.2, -9.7), 21.1));
  // Warp before the cloud-scale octaves, which is what stops the field reading
  // as a noise texture stretched across the sky.
  float warp = c_noise(vec3(p * 0.47, 11.7)) * 2.0 - 1.0;
  p += warp * 0.9;
  float low = c_noise(vec3(p, 3.1));
  float mid = c_noise(vec3(p * 2.1, 7.9)) * 0.30;
  float fine = c_noise(vec3(p * 4.2, 13.3)) * 0.06;
  float shape = (low + mid + fine) / 1.36;
  // Weather fronts choose a local threshold rather than merely multiplying
  // density. That distinction creates true clear windows between banks; a
  // multiplier left a low-density cloud everywhere and read as horizon fog.
  float system = mix(weather, front, 0.42);
  float bankThreshold = mix(0.585, 0.325, smoothstep(0.32, 0.72, system));
  float bank = clamp((shape - bankThreshold) * 3.5, 0.0, 1.0);
  float weatherGap = smoothstep(0.38, 0.62, system);
  return bank * weatherGap * openingCorridorFactor(xz);
}

/** A rolling condensation level avoids a ruler-straight fog-deck base. */
float cloudBaseAt(vec2 xz, float shaped) {
  vec2 advected = (xz + uCloudWind * uCloudTime) * 0.00031;
  float valley = c_noise(vec3(advected + vec2(-8.4, 13.1), 5.7));
  float shelf = c_noise(vec3(advected * 2.1 + vec2(3.2, -7.6), 19.3));
  return uCloudBase + 55.0 + 360.0 * mix(valley, shelf, 0.32) * (0.38 + 0.62 * shaped);
}

/** Vertical silhouette with a soft variable base and rounded crown. */
float cloudProfile(float h) {
  float softBase = smoothstep(0.0, 0.13, h);
  float roundedTop = 1.0 - smoothstep(0.46, 1.0, h);
  return softBase * roundedTop;
}

/**
 * Height-aware erosion following the production weather-volume model: broad
 * wispy cuts dominate the lower flanks, while smaller ridges carve cauliflower
 * crowns. detailLevel is a quality control, not a density control, so changing
 * tiers preserves the cloud bank rather than popping it in and out.
 */
float cloudErosion(vec3 p, float h, float detailLevel) {
  vec3 windOffset = vec3(uCloudWind.x, 0.12, uCloudWind.y) * uCloudTime;
  vec3 q = (p + windOffset) * ${CLOUD_CONSTANTS.DETAIL_SCALE.toFixed(6)};
  float broad = c_fbm(q * vec3(0.62, 0.44, 0.62), 2);
  if (detailLevel < 0.30) return broad;
  float wispy = c_ridge(c_fbm(q * vec3(1.15, 0.30, 1.15) + vec3(-3.2, 8.0, 5.4), 2));
  if (detailLevel < 0.60) return mix(broad, wispy, detailLevel * 0.72);
  float crown = c_ridge(c_fbm(q * 1.78 + vec3(7.1, 2.8, -4.6), 3));
  float verticalType = smoothstep(0.24, 0.78, h);
  float full = mix(mix(broad, wispy, 0.52), mix(broad, crown, 0.64), verticalType);
  return mix(broad, full, clamp(detailLevel, 0.0, 1.0));
}

/**
 * Height of the cloud top over this ground position.
 *
 * Cloud height rises with coverage, and this is the most important line in the
 * file. With a fixed ceiling the slab is cut off at one altitude wherever
 * coverage crosses the threshold, so the deck reads as a sheet of paper with
 * holes punched in it. Billows are the strongest cue that a cloud has volume,
 * and they come from the shape of the top surface, not from the shading.
 */
float cloudTopAt(vec2 xz, float shaped) {
  vec2 advected = (xz + uCloudWind * uCloudTime) * 0.00082;
  float billow = c_noise(vec3(advected * 0.78, 18.4));
  float towerCell = c_noise(vec3(advected * 1.62 + vec2(6.2, -4.1), 31.7));
  float crown = c_noise(vec3(advected * 2.45 + vec2(-11.8, 7.3), 46.2));
  float tower = smoothstep(0.35, 0.68, towerCell) * smoothstep(0.18, 0.60, billow) * shaped;
  float topShape = clamp(
    0.24 + 0.38 * shaped + 0.50 * tower + 0.09 * crown * shaped,
    0.0,
    1.0
  );
  return uCloudBase + (uCloudTop - uCloudBase) * topShape;
}

/**
 * Density at a world point.
 *
 * The detail flag skips the fine octaves for the light march, where fine structure
 * costs a lot and changes almost nothing — a standard economy in production
 * cloud renderers.
 */
float cloudDensityLod(vec3 p, float detailLevel) {
  if (p.y < uCloudBase || p.y > uCloudTop) return 0.0;

  float cov = cloudCoverage(p.xz);
  float shaped = smoothstep(${CLOUD_CONSTANTS.COVERAGE_LOW.toFixed(3)}, ${CLOUD_CONSTANTS.COVERAGE_HIGH.toFixed(3)}, cov);
  if (shaped <= 0.002) return 0.0;

  float baseHeight = cloudBaseAt(p.xz, shaped);
  if (p.y < baseHeight) return 0.0;
  float top = cloudTopAt(p.xz, shaped);
  float h = (p.y - baseHeight) / max(top - baseHeight, 1.0);
  if (h > 1.0) return 0.0;

  float base = shaped * cloudProfile(h);
  if (base <= 0.002) return 0.0;

  if (detailLevel > 0.0) {
    float erosion = cloudErosion(p, h, detailLevel);
    // Subtractive, scaled by (1 - base): eats the boundary, spares the core.
    // Weighted toward the top, because that is where a cumulus is lumpy — the
    // base of a deck is comparatively flat.
    base = clamp(
      base - (1.0 - base) * erosion * mix(0.38, 0.92, smoothstep(0.08, 0.92, h)) * ${CLOUD_CONSTANTS.ERODE.toFixed(3)},
      0.0, 1.0);
  }
  return base * uCloudDensity;
}

// Backward-compatible shared contract used by terrain materials. The visible
// high-tier volume and terrain shadow evaluate the same eroded density, while
// the owned cloud renderer can explicitly request cheaper density LODs.
float cloudDensity(vec3 p, bool detail) {
  return cloudDensityLod(p, detail ? 1.0 : 0.0);
}

/**
 * Fraction of sunlight reaching a ground point, for terrain shading.
 *
 * Intersects the sun ray with the cloud slab and takes a handful of coverage
 * samples through it. Cheap because it skips the detail octaves and the
 * vertical profile integral entirely — a shadow on the ground a kilometre below
 * has no business resolving cloud filigree.
 */
float cloudShadowAt(vec3 world, vec3 sunDir) {
  if (sunDir.y <= 0.02) return 1.0;
  float t0 = (uCloudBase - world.y) / sunDir.y;
  float t1 = (uCloudTop - world.y) / sunDir.y;
  if (t1 <= 0.0) return 1.0;
  t0 = max(t0, 0.0);

  float optical = 0.0;
  const int STEPS = 2;
  for (int i = 0; i < STEPS; i++) {
    float t = mix(t0, t1, (float(i) + 0.5) / float(STEPS));
    vec3 p = world + sunDir * t;
    // Legacy inline fallback follows the same density function at a broad LOD;
    // CloudVolume's live transmittance map evaluates the exact visible tier.
    optical += cloudDensityLod(p, max(uDetailLevel, 0.18));
  }
  optical *= max(t1 - t0, 0.0) / float(STEPS);
  // Beer-Lambert direct light plus a bounded skylight floor. This is an exposed
  // sampler: terrain and future water/shaft passes use exactly this weather.
  return 0.22 + 0.78 * exp(-optical * 1.35);
}
`;
