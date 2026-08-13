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
  TOP: 6450, // cloud top
  COVERAGE_SCALE: 0.00055,
  DETAIL_SCALE: 0.0031,
  COVERAGE_LOW: 0.42,
  COVERAGE_HIGH: 0.82,
  ERODE: 0.95,
  DENSITY: 0.0042,
};

export const CLOUD_GLSL = /* glsl */ `
uniform float uCloudBase;
uniform float uCloudTop;
uniform float uCloudCoverage;
uniform float uCloudDensity;
uniform vec2 uCloudWind;
uniform float uCloudTime;

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
  float weather = c_noise(vec3(p * 0.13, 2.3));
  // Warp before the cloud-scale octaves, which is what stops the field reading
  // as a noise texture stretched across the sky.
  float warp = c_noise(vec3(p * 0.47, 11.7)) * 2.0 - 1.0;
  p += warp * 0.9;
  float low = c_noise(vec3(p, 3.1));
  float mid = c_noise(vec3(p * 2.3, 7.9)) * 0.45;
  float fine = c_noise(vec3(p * 5.1, 13.3)) * 0.2;
  float shape = (low + mid + fine) / 1.65;
  return clamp(shape * (0.45 + 0.85 * weather), 0.0, 1.0);
}

/** Vertical silhouette between base and top: flat-ish bottom, rounded top. */
float cloudProfile(float h) {
  return smoothstep(0.0, 0.11, h) * (1.0 - smoothstep(0.35, 1.0, h));
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
float cloudTopAt(float shaped) {
  return uCloudBase + (uCloudTop - uCloudBase) * (0.30 + 0.70 * shaped);
}

/**
 * Density at a world point.
 *
 * The detail flag skips the fine octaves for the light march, where fine structure
 * costs a lot and changes almost nothing — a standard economy in production
 * cloud renderers.
 */
float cloudDensity(vec3 p, bool detail) {
  if (p.y < uCloudBase || p.y > uCloudTop) return 0.0;

  float cov = cloudCoverage(p.xz);
  float shaped = smoothstep(${CLOUD_CONSTANTS.COVERAGE_LOW.toFixed(3)}, ${CLOUD_CONSTANTS.COVERAGE_HIGH.toFixed(3)}, cov);
  if (shaped <= 0.002) return 0.0;

  float top = cloudTopAt(shaped);
  float h = (p.y - uCloudBase) / max(top - uCloudBase, 1.0);
  if (h > 1.0) return 0.0;

  float base = shaped * cloudProfile(h);
  if (base <= 0.002) return 0.0;

  if (detail) {
    vec3 q = p * ${CLOUD_CONSTANTS.DETAIL_SCALE.toFixed(6)};
    q.xz += uCloudWind * uCloudTime * ${CLOUD_CONSTANTS.DETAIL_SCALE.toFixed(6)};
    float erosion = c_fbm(q, 3);
    // Subtractive, scaled by (1 - base): eats the boundary, spares the core.
    // Weighted toward the top, because that is where a cumulus is lumpy — the
    // base of a deck is comparatively flat.
    base = clamp(
      base - (1.0 - base) * erosion * (0.42 + 0.58 * h) * ${CLOUD_CONSTANTS.ERODE.toFixed(3)},
      0.0, 1.0);
  }
  return base * uCloudDensity;
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

  float acc = 0.0;
  const int STEPS = 4;
  for (int i = 0; i < STEPS; i++) {
    float t = mix(t0, t1, (float(i) + 0.5) / float(STEPS));
    vec3 p = world + sunDir * t;
    // Same variable ceiling the volume uses. Taking a fixed top here would put
    // the shadow back out of step with the cloud that casts it.
    float shaped = smoothstep(${CLOUD_CONSTANTS.COVERAGE_LOW.toFixed(3)}, ${CLOUD_CONSTANTS.COVERAGE_HIGH.toFixed(3)}, cloudCoverage(p.xz));
    float h = (p.y - uCloudBase) / max(cloudTopAt(shaped) - uCloudBase, 1.0);
    if (h <= 1.0) acc += shaped * cloudProfile(h);
  }
  float optical = acc / float(STEPS) * (t1 - t0) * uCloudDensity;
  // Floored well above zero: cloud scatters a great deal of light sideways, and
  // a hard shadow under an overcast reads as a hole rather than as weather.
  return mix(0.34, 1.0, exp(-optical * 1.6));
}
`;
