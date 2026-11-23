/**
 * CPU mirror of src/world/terrainNoise.glsl.js.
 *
 * The GPU owns terrain *rendering*; this owns terrain *queries* — ground
 * collision, altitude-above-ground, observation-post placement and camera
 * clearance. Keeping one analytic function on both sides means we never have to
 * read a render target back, which would stall the pipeline every frame.
 *
 * Any edit here must be mirrored in the GLSL, and vice versa. Calling
 * __verifyTerrain() from the browser console reads the live heightmap back and
 * diffs it against this file; it must report a sub-metre maximum error.
 */

// Vertical layout, metres.
export const VALLEY_FLOOR = 2750;
export const RELIEF = 4350; // peaks reach VALLEY_FLOOR + RELIEF
export const DOMAIN = 15500; // metres per unit of noise domain

const OCTAVES = 14;
const LACUNARITY = 2.031;
const GAIN = 0.62; // amplitude falloff per octave; higher = rougher close up
const SLOPE_OCTAVES = 6; // octaves that define "is this ground steep?"
const EROSION = 0.9; // how sharply steep ground sheds fine detail
const EROSION_MIX = 0.5; // fraction of the detail erosion is allowed to remove

// Vertical shaping. These are the dials that decide whether the map reads as
// Ladakh or as rolling hills.
const SHAPE_GAMMA = 2.4; // >1 deepens valleys and sharpens summits
const MASSIF_BASE = 0.52; // relief multiplier in the basins
const MASSIF_RANGE = 0.6; // extra multiplier on the high ranges
const VALLEY_CUT = 0.5; // how deeply the corridor network incises

/**
 * Integer lattice hash. Must stay bit-identical to t_hash() in the GLSL.
 *
 * The usual fract-based hashes are unusable here: their intermediates reach
 * ~2.5e5, which in the GPU's 32-bit float leaves about six bits of fraction, so
 * the two implementations produced effectively uncorrelated values. Integer
 * mixing is exact on both sides, and the final >>>8 keeps the result inside
 * float32's 24-bit mantissa so neither side has to round.
 */
function hash(ix, iy) {
  let n = (Math.imul(ix, 1597334677) ^ Math.imul(iy, 3812015801)) >>> 0;
  n = Math.imul(n ^ (n >>> 15), 2246822519) >>> 0;
  n = Math.imul(n ^ (n >>> 13), 3266489917) >>> 0;
  n = (n ^ (n >>> 16)) >>> 0;
  return (n >>> 8) * (2 / 16777215) - 1;
}

// Scratch object reused by noised() so hot query loops allocate nothing.
const _n = { v: 0, dx: 0, dy: 0 };

function noised(x, y) {
  const px = Math.floor(x);
  const py = Math.floor(y);
  const fx = x - px;
  const fy = y - py;

  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const dux = 30 * fx * fx * (fx * (fx - 2) + 1);
  const duy = 30 * fy * fy * (fy * (fy - 2) + 1);

  const a = hash(px, py);
  const b = hash(px + 1, py);
  const c = hash(px, py + 1);
  const d = hash(px + 1, py + 1);

  const k1 = b - a;
  const k2 = c - a;
  const k3 = a - b - c + d;

  _n.v = a + k1 * ux + k2 * uy + k3 * ux * uy;
  _n.dx = dux * (k1 + k3 * uy);
  _n.dy = duy * (k2 + k3 * ux);
  return _n;
}

function fbm(x, y, octaves) {
  let sum = 0;
  let amp = 0.5;
  let freq = 1;
  let qx = x;
  let qy = y;
  for (let i = 0; i < octaves; i++) {
    sum += amp * noised(qx * freq, qy * freq).v;
    amp *= 0.5;
    freq *= 2.02;
    const nx = 0.8 * qx - 0.6 * qy;
    const ny = 0.6 * qx + 0.8 * qy;
    qx = nx;
    qy = ny;
  }
  return sum;
}

/**
 * Slope-eroded fractal terrain (the technique behind iq's "Elevated").
 *
 * The whole shape comes from one idea: divide each octave by the accumulated
 * gradient so far. Once the surface is already steep, further detail is
 * suppressed — which is exactly what erosion does, stripping fine material off
 * faces and depositing smooth talus below them. The result reads as geology:
 * long clean ridgelines, craggy shoulders, and broad smooth valley floors,
 * instead of the uniform crunch of a plain fBm.
 *
 * `ridgeMix` blends toward a ridged variant that keeps the crests sharp; the
 * Karakoram look needs both.
 */
function eroded(px, py, ridgeMix) {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let dx = 0;
  let dy = 0;
  let qx = px;
  let qy = py;
  let damp = 1;

  for (let i = 0; i < OCTAVES; i++) {
    const n = noised(qx, qy);

    // Only the structural octaves feed the gradient estimate. Letting every
    // octave accumulate turns this into a plain low-pass filter — detail dies
    // everywhere with octave count instead of dying on steep ground — and the
    // map flattens into featureless basins.
    if (i < SLOPE_OCTAVES) {
      dx += n.dx;
      dy += n.dy;
      // Blended, never absolute: full damping erased detail across whole
      // basins and left the map reading as smooth bowls between craggy
      // massifs. Steep ground should shed *some* of its fine relief, not all.
      damp = 1 - EROSION_MIX + EROSION_MIX / (1 + EROSION * (dx * dx + dy * dy));
    }

    // 1 - |n| turns each octave into a crease; mixing it in sharpens the
    // ridgelines without giving up the eroded flanks.
    const ridge = 2 * (1 - Math.abs(n.v)) - 1;
    const v = n.v + (ridge - n.v) * ridgeMix;

    sum += amp * v * (i < 2 ? 1 : damp);
    norm += amp;

    amp *= GAIN;
    const nx = (0.8 * qx - 0.6 * qy) * LACUNARITY;
    const ny = (0.6 * qx + 0.8 * qy) * LACUNARITY;
    qx = nx;
    qy = ny;
  }

  return sum / norm;
}

/**
 * Low-frequency ridged field. Its crest lines are used as *valley axes*, which
 * is what gives the map long branching corridors you can actually fly down,
 * rather than isolated bowls between random peaks.
 */
function ridgeNetwork(px, py) {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let qx = px;
  let qy = py;
  for (let i = 0; i < 5; i++) {
    const n = noised(qx, qy).v;
    sum += amp * (1 - Math.abs(n));
    norm += amp;
    amp *= 0.52;
    const nx = (0.8 * qx - 0.6 * qy) * 2.11;
    const ny = (0.6 * qx + 0.8 * qy) * 2.11;
    qx = nx;
    qy = ny;
  }
  return sum / norm;
}

function smoothstep(e0, e1, x) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/** Terrain elevation in metres at world (x, z). */
export function terrainHeight(x, z) {
  const px = x / DOMAIN;
  const py = z / DOMAIN;

  // Domain warp bends the ranges into arcs and hides the noise lattice.
  const wx = fbm(px * 0.55 + 11.3, py * 0.55 + 11.3, 4);
  const wy = fbm(px * 0.55 + 31.7, py * 0.55 + 31.7, 4);
  const pwx = px + 0.34 * wx;
  const pwy = py + 0.34 * wy;

  // Which parts of the map are high massif and which are broad basin. ~18 km
  // features, so a single 70 km horizon holds several distinct ranges.
  const cont = fbm(pwx * 0.86, pwy * 0.86, 5);
  const massif = smoothstep(-0.30, 0.30, cont);

  // The eroded field is strongly left-skewed: a dense band near its top with a
  // long tail down into the incised valleys. Remapping through a power curve
  // spreads that band back out — flat gravel floors at the bottom, and summits
  // that actually tower — without the hard knee that a piecewise boost would
  // introduce (which produced flat basins beside craggy massifs).
  let relief = Math.min(1, Math.max(0, (eroded(pwx, pwy, 0.62) + 1.0) / 1.4));
  relief = Math.pow(relief, SHAPE_GAMMA);
  relief *= MASSIF_BASE + MASSIF_RANGE * massif;

  // Carve the corridor network in.
  const valley = smoothstep(0.58, 0.95, ridgeNetwork(pwx * 0.72 + 5.0, pwy * 0.72 + 5.0));
  relief *= 1 - VALLEY_CUT * valley;

  return VALLEY_FLOOR + RELIEF * Math.min(relief, 1.06);
}

/** Surface normal at world (x, z), by central difference. */
export function terrainNormal(x, z, eps = 6, out = { x: 0, y: 1, z: 0 }) {
  const hL = terrainHeight(x - eps, z);
  const hR = terrainHeight(x + eps, z);
  const hD = terrainHeight(x, z - eps);
  const hU = terrainHeight(x, z + eps);
  const nx = hL - hR;
  const ny = 2 * eps;
  const nz = hD - hU;
  const inv = 1 / Math.hypot(nx, ny, nz);
  out.x = nx * inv;
  out.y = ny * inv;
  out.z = nz * inv;
  return out;
}

const _slopeN = { x: 0, y: 1, z: 0 };

/** Steepness in 0..1 (0 = flat, 1 = vertical). */
export function terrainSlope(x, z, eps = 14) {
  return 1 - terrainNormal(x, z, eps, _slopeN).y;
}

/**
 * Highest terrain point along a straight XZ segment. Used for terrain-proximity
 * warning and for keeping the chase camera out of the rock behind the player.
 */
export function maxHeightAlong(x0, z0, x1, z1, samples = 8) {
  let m = -Infinity;
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const h = terrainHeight(x0 + (x1 - x0) * t, z0 + (z1 - z0) * t);
    if (h > m) m = h;
  }
  return m;
}
