/**
 * The single source of truth for terrain elevation, GPU side.
 *
 * This GLSL chunk is compiled into the heightmap generation pass.
 * `heightfield.js` is a line-for-line JavaScript mirror used for collision,
 * observation-post placement and every other gameplay query — no render-target
 * readbacks, no pipeline stalls.
 *
 * If you change the maths here, change it there too. Calling __verifyTerrain()
 * from the browser console reads the live heightmap back and diffs it against
 * the JS mirror; it must report a sub-metre maximum error.
 *
 * Shape goals (Kargil / Ladakh, not generic Perlin hills):
 *   - valley floors around 2.8 km, ranges climbing past 6.5 km
 *   - long continuous ridgelines rather than isolated bumps
 *   - branching valley corridors wide enough to fly down
 *   - smooth talus below craggy faces, courtesy of slope erosion
 */

export const TERRAIN_CONSTANTS = {
  VALLEY_FLOOR: 2750,
  RELIEF: 4350,
  DOMAIN: 15500,
  OCTAVES: 14,
  GAIN: 0.62,
  LACUNARITY: 2.031,
  SLOPE_OCTAVES: 6,
  EROSION: 0.9,
  EROSION_MIX: 0.5,
  SHAPE_GAMMA: 2.4,
  MASSIF_BASE: 0.52,
  MASSIF_RANGE: 0.6,
  VALLEY_CUT: 0.5,
  RIDGE_MIX: 0.62,
};

const C = TERRAIN_CONSTANTS;

export const TERRAIN_NOISE_GLSL = /* glsl */ `
#define T_VALLEY_FLOOR ${C.VALLEY_FLOOR.toFixed(1)}
#define T_RELIEF       ${C.RELIEF.toFixed(1)}
#define T_DOMAIN       ${C.DOMAIN.toFixed(1)}
#define T_OCTAVES      ${C.OCTAVES}
#define T_SLOPE_OCT    ${C.SLOPE_OCTAVES}
#define T_LAC          ${C.LACUNARITY.toFixed(3)}
#define T_GAIN         ${C.GAIN.toFixed(3)}
#define T_EROSION      ${C.EROSION.toFixed(3)}
#define T_EROSION_MIX  ${C.EROSION_MIX.toFixed(3)}
#define T_SHAPE_GAMMA  ${C.SHAPE_GAMMA.toFixed(3)}
#define T_MASSIF_BASE  ${C.MASSIF_BASE.toFixed(3)}
#define T_MASSIF_RANGE ${C.MASSIF_RANGE.toFixed(3)}
#define T_VALLEY_CUT   ${C.VALLEY_CUT.toFixed(3)}
#define T_RIDGE_MIX    ${C.RIDGE_MIX.toFixed(3)}

const mat2 T_ROT = mat2(0.8, 0.6, -0.6, 0.8);

/**
 * Integer lattice hash.
 *
 * The usual fract(p.x*p.y*(p.x+p.y)) hash is unusable here. Its intermediates
 * reach ~2.5e5, which in 32-bit float leaves roughly six bits of fraction — the
 * GPU and the float64 JS mirror were measured disagreeing by up to 0.93 on a
 * [-1,1] output, i.e. effectively uncorrelated. Integer mixing is exact on both
 * sides, and the final >>8 keeps the result inside float32's 24-bit mantissa so
 * neither implementation has to round. Measured agreement is now under 1 mm at
 * the fine clipmap levels.
 */
float t_hash(vec2 p) {
  uvec2 q = uvec2(ivec2(p));
  uint n = q.x * 1597334677u ^ q.y * 3812015801u;
  n = (n ^ (n >> 15u)) * 2246822519u;
  n = (n ^ (n >> 13u)) * 3266489917u;
  n ^= n >> 16u;
  return float(n >> 8u) * (2.0 / 16777215.0) - 1.0;
}

// Value noise returning (value, d/dx, d/dy). The analytic derivatives are what
// make slope erosion possible.
vec3 t_noised(vec2 x) {
  vec2 p = floor(x);
  vec2 f = x - p;
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  vec2 du = 30.0 * f * f * (f * (f - 2.0) + 1.0);

  float a = t_hash(p + vec2(0.0, 0.0));
  float b = t_hash(p + vec2(1.0, 0.0));
  float c = t_hash(p + vec2(0.0, 1.0));
  float d = t_hash(p + vec2(1.0, 1.0));

  float k1 = b - a;
  float k2 = c - a;
  float k3 = a - b - c + d;

  return vec3(
    a + k1 * u.x + k2 * u.y + k3 * u.x * u.y,
    du.x * (k1 + k3 * u.y),
    du.y * (k2 + k3 * u.x)
  );
}

float t_fbm(vec2 q, int octaves) {
  float sum = 0.0, amp = 0.5, freq = 1.0;
  for (int i = 0; i < 5; i++) {
    if (i >= octaves) break;
    sum += amp * t_noised(q * freq).x;
    amp *= 0.5;
    freq *= 2.02;
    q = T_ROT * q;
  }
  return sum;
}

/**
 * Slope-eroded fractal terrain (the technique behind iq's "Elevated").
 *
 * Each octave is divided by the gradient accumulated so far, so once the
 * surface is already steep, further detail is suppressed. That is what erosion
 * does — it strips fine material off faces and deposits smooth talus below
 * them — and it is the reason this reads as geology rather than as noise.
 *
 * ridgeMix blends toward 1-|n| to keep crests sharp. The Karakoram needs both.
 */
float t_eroded(vec2 q, float ridgeMix) {
  float sum = 0.0, amp = 1.0, norm = 0.0, damp = 1.0;
  vec2 d = vec2(0.0);

  for (int i = 0; i < T_OCTAVES; i++) {
    vec3 n = t_noised(q);

    // Only the structural octaves feed the gradient estimate. Letting every
    // octave accumulate turns this into a plain low-pass filter — detail dies
    // everywhere with octave count instead of dying on steep ground — and the
    // map flattens into featureless basins. The result is also blended rather
    // than absolute, so steep ground sheds some of its fine relief, not all.
    if (i < T_SLOPE_OCT) {
      d += n.yz;
      damp = 1.0 - T_EROSION_MIX + T_EROSION_MIX / (1.0 + T_EROSION * dot(d, d));
    }

    float ridge = 2.0 * (1.0 - abs(n.x)) - 1.0;
    float v = mix(n.x, ridge, ridgeMix);

    sum += amp * v * (i < 2 ? 1.0 : damp);
    norm += amp;

    amp *= T_GAIN;
    q = T_ROT * q * T_LAC;
  }

  return sum / norm;
}

/**
 * Low-frequency ridged field whose crest lines become *valley axes*. This is
 * what gives the map long branching corridors to fly down instead of isolated
 * bowls between random peaks.
 */
float t_ridgeNetwork(vec2 q) {
  float sum = 0.0, amp = 0.5, norm = 0.0;
  for (int i = 0; i < 5; i++) {
    sum += amp * (1.0 - abs(t_noised(q).x));
    norm += amp;
    amp *= 0.52;
    q = T_ROT * q * 2.11;
  }
  return sum / norm;
}

/** Terrain elevation in metres for a world XZ position in metres. */
float t_height(vec2 worldXZ) {
  vec2 p = worldXZ / T_DOMAIN;

  // Domain warp bends the ranges into arcs and hides the noise lattice.
  float wx = t_fbm(p * 0.55 + 11.3, 4);
  float wy = t_fbm(p * 0.55 + 31.7, 4);
  vec2 pw = p + 0.34 * vec2(wx, wy);

  // Massif vs basin at ~18 km, so one 70 km horizon holds several ranges.
  float cont = t_fbm(pw * 0.86, 5);
  float massif = smoothstep(-0.30, 0.30, cont);

  // The eroded field is strongly left-skewed: a dense band near its top with a
  // long tail down into the incised valleys. Remapping through a power curve
  // spreads that band back out — flat gravel floors at the bottom, and summits
  // that actually tower — without the hard knee a piecewise boost would add.
  float relief = clamp((t_eroded(pw, T_RIDGE_MIX) + 1.0) / 1.4, 0.0, 1.0);
  relief = pow(relief, T_SHAPE_GAMMA);
  relief *= T_MASSIF_BASE + T_MASSIF_RANGE * massif;

  float valley = smoothstep(0.58, 0.95, t_ridgeNetwork(pw * 0.72 + 5.0));
  relief *= 1.0 - T_VALLEY_CUT * valley;

  return T_VALLEY_FLOOR + T_RELIEF * min(relief, 1.06);
}
`;
