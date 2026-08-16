import { ATMOSPHERE_GLSL, ATMOSPHERE_UNIFORMS_GLSL } from '../atmosphere.glsl.js';
import { CLOUD_GLSL } from '../clouds.glsl.js';
import { terrainHeight } from '../heightfield.js';

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const mix = (a, b, t) => a + (b - a) * t;
const smoothstep = (a, b, v) => {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const DEFAULT_SUN_DIRECTION = [
  Math.cos(46 * Math.PI / 180) * Math.sin(128 * Math.PI / 180),
  Math.sin(46 * Math.PI / 180),
  Math.cos(46 * Math.PI / 180) * Math.cos(128 * Math.PI / 180),
];

function normalize3(value) {
  const length = Math.max(Math.hypot(...value), 1e-12);
  return value.map((component) => component / length);
}

function dot3(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

const fract = (v) => v - Math.floor(v);
const terrainHeightCache = new Map();

function cachedTerrainHeight(x, z) {
  const key = `${x},${z}`;
  const cached = terrainHeightCache.get(key);
  if (cached !== undefined) return cached;
  const height = terrainHeight(x, z);
  if (terrainHeightCache.size >= 32768) terrainHeightCache.clear();
  terrainHeightCache.set(key, height);
  return height;
}

/** CPU semantic mirror of the production GLSL hash21 function. */
export function terrainMaterialHash(x, z) {
  let px = fract(x * 0.1031);
  let py = fract(z * 0.1030);
  let pz = fract(x * 0.0973);
  const product = px * (py + 33.33) + py * (pz + 33.33) + pz * (px + 33.33);
  px += product;
  py += product;
  pz += product;
  return fract((px + py) * pz);
}

function terrainMaterialNoise(x, z) {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx0 = x - ix, fz0 = z - iz;
  const fx = fx0 * fx0 * (3 - 2 * fx0);
  const fz = fz0 * fz0 * (3 - 2 * fz0);
  const a = terrainMaterialHash(ix, iz), b = terrainMaterialHash(ix + 1, iz);
  const c = terrainMaterialHash(ix, iz + 1), d = terrainMaterialHash(ix + 1, iz + 1);
  return (a + (b - a) * fx) * (1 - fz) + (c + (d - c) * fx) * fz;
}

/** CPU mirror of ridgedGeology(vec3 world), including GLSL matrix order. */
export function terrainMaterialGeology(x, y, z) {
  let px = x * 0.00034 + y * 0.00009;
  let pz = z * 0.00034 - y * 0.00005;
  let sum = 0, amplitude = 0.54, norm = 0;
  for (let octave = 0; octave < 4; octave++) {
    const ridge = 1 - Math.abs(terrainMaterialNoise(px, pz) * 2 - 1);
    sum += ridge * amplitude;
    norm += amplitude;
    // mat2 arguments are columns in GLSL.
    const nx = px * 1.71 - pz * 1.09 + 11.3;
    pz = px * 1.09 + pz * 1.71 + 7.1;
    px = nx;
    amplitude *= 0.51;
  }
  return sum / norm;
}

/** CPU mirror of fbmTriplanar(vWorld * 0.00115, triplanarWeights(N)). */
export function terrainMaterialMineral(x, y, z, normal) {
  const rawWeights = normal.map((value) => Math.abs(value) ** 4);
  const weightSum = Math.max(rawWeights[0] + rawWeights[1] + rawWeights[2], 1e-4);
  const weights = rawWeights.map((value) => value / weightSum);
  let px = x * 0.00115;
  let py = y * 0.00115;
  let pz = z * 0.00115;
  let sum = 0, amplitude = 0.54, norm = 0;
  for (let octave = 0; octave < 4; octave++) {
    const triX = terrainMaterialNoise(py, pz);
    const triY = terrainMaterialNoise(px + 31.7, pz + 31.7);
    const triZ = terrainMaterialNoise(px + 73.1, py + 73.1);
    sum += (triX * weights[0] + triY * weights[1] + triZ * weights[2]) * amplitude;
    norm += amplitude;
    const nx = py * 1.93 + 11.3;
    const ny = pz * 1.93 + 7.1;
    const nz = px * 1.93 + 17.7;
    px = nx;
    py = ny;
    pz = nz;
    amplitude *= 0.51;
  }
  return sum / norm;
}

function clipmapHeightCpu(x, z, cell, centerX, centerZ) {
  const gx = (x - centerX) / cell;
  const gz = (z - centerZ) / cell;
  const ix = Math.floor(gx);
  const iz = Math.floor(gz);
  const fx = gx - ix;
  const fz = gz - iz;
  const x0 = centerX + ix * cell;
  const z0 = centerZ + iz * cell;
  const h00 = cachedTerrainHeight(x0, z0);
  const h10 = cachedTerrainHeight(x0 + cell, z0);
  const h01 = cachedTerrainHeight(x0, z0 + cell);
  const h11 = cachedTerrainHeight(x0 + cell, z0 + cell);
  return (h00 + (h10 - h00) * fx) * (1 - fz) + (h01 + (h11 - h01) * fx) * fz;
}

/**
 * The lighting normal, mirrored the way the GPU actually produces it.
 *
 * The generation pass bakes one normal per heightmap texel from a central
 * difference at plus/minus one texel, and the fragment shader then reads it
 * back through the same bilinear filter it reads height with. So the normal
 * field is an interpolation of *normals*, which is continuous everywhere.
 *
 * Differentiating the interpolated *height* at the fragment's own position —
 * which is what this mirror used to do, and what the shader used to do — is a
 * different construction with a different answer: the derivative of a bilinear
 * patch is piecewise constant, so it steps at every texel boundary. That step
 * is the triangular faceting the recon camera showed, and a mirror that models
 * it cannot validate the shader that no longer has it.
 */
function storedNormalCpu(x, z, cell, centerX, centerZ) {
  const gx = (x - centerX) / cell;
  const gz = (z - centerZ) / cell;
  const ix = Math.floor(gx);
  const iz = Math.floor(gz);
  const fx = gx - ix;
  const fz = gz - iz;

  let nx = 0;
  let nz = 0;
  for (let dj = 0; dj <= 1; dj++) {
    for (let di = 0; di <= 1; di++) {
      const px = centerX + (ix + di) * cell;
      const pz = centerZ + (iz + dj) * cell;
      const left = cachedTerrainHeight(px - cell, pz);
      const right = cachedTerrainHeight(px + cell, pz);
      const down = cachedTerrainHeight(px, pz - cell);
      const up = cachedTerrainHeight(px, pz + cell);
      const length = Math.hypot(left - right, 2 * cell, down - up);
      const weight = (di ? fx : 1 - fx) * (dj ? fz : 1 - fz);
      nx += ((left - right) / length) * weight;
      nz += ((down - up) / length) * weight;
    }
  }
  return [nx, nz];
}

function terrainFrameAtRadius(x, z, cell, radius, focusX, focusZ) {
  const centerX = Math.round(focusX / (cell * 2)) * cell * 2;
  const centerZ = Math.round(focusZ / (cell * 2)) * cell * 2;
  const e = Math.max(radius, 2);
  const center = clipmapHeightCpu(x, z, cell, centerX, centerZ);
  const left = clipmapHeightCpu(x - e, z, cell, centerX, centerZ);
  const right = clipmapHeightCpu(x + e, z, cell, centerX, centerZ);
  const down = clipmapHeightCpu(x, z - e, cell, centerX, centerZ);
  const up = clipmapHeightCpu(x, z + e, cell, centerX, centerZ);
  return {
    gx: (right - left) / (2 * e),
    gz: (up - down) / (2 * e),
    curvature: (left + right + down + up - 4 * center) / (e * e),
  };
}

/**
 * How the surface is classified into snow, glacial ice, talus and bedrock.
 *
 * Two decisions, and both exist because the classification used to move under
 * the aircraft as it closed on a mountain.
 *
 * **Fixed world radii.** The stencil used to be `uCells[level] *
 * f(distanceToCamera)`, so the same shoulder was measured with a ~575 m stencil
 * at 5 km and a ~60 m one at 1 km. Slope, curvature and aspect are properties of
 * the mountain, not of where the camera is, so they are now sampled at lengths
 * in metres. Distance may only fade *detail*, never reclassify.
 *
 * **A fixed source level.** Fixed radii alone are not enough, and this is the
 * part that is easy to miss: each clipmap level is a *different reconstruction*
 * of the terrain — a bilinear surface over its own grid — so a 28 m slope
 * measured on an 8 m grid and on a 32 m grid are genuinely different numbers.
 * Measured at one summit they were 0.151 and 0.082, and `retention` maps that
 * range from full snow to bare rock. Classification therefore always reads
 * level CLASSIFY_LEVEL — 64 m texels, ±8 km of coverage — never the level the
 * geometry happens to be using, and falls back to coarser levels only outside
 * that footprint. Because every level snaps its centre to twice its cell, its
 * texels land on fixed world coordinates, so a fixed level is a genuinely fixed
 * function of position.
 *
 * Level 4 rather than 3 because the morph blend at the top of a ring reaches
 * into the *next* level's classification: pinned to level 3, ground beyond
 * about 3 km started blending toward level 4 and drifted again. Pinned to 4,
 * the first blending happens at the outer edge of ring 4, past 5.7 km, which is
 * beyond the range at which a snow line is resolvable through aerial haze.
 */
const CLASSIFY_LEVEL = 4;
const CLASSIFY_CELL = 64;

/**
 * Lighting balance, shared by the shader and its JS mirror.
 *
 * The direct scale was 0.22 with a 1.25 ceiling, which at uSunIntensity 1.5 put
 * the sun at 0.33 — while snow alone carried a flat vec3(0.185, 0.245, 0.365)
 * of sky fill on top of atm_skyIrradiance. Blue matched or beat the sun on every
 * fragment, so a sunlit snowfield measured meanRGB 105/133/160 and never reached
 * white. The shadow floors were the other half: 0.30 on visibility and 0.42 on
 * the low-tier direct term capped cast-shadow contrast at half a stop, which is
 * why correct ray-marched shadows still read as smooth clay.
 *
 * These are the numbers the tests assert against; change them here, not inline.
 */
const DIRECT_SUN_SCALE = 0.62;
const DIRECT_SUN_CEILING = 2.4;
const SHADOW_FLOOR = 0.06;
const CLOUD_SHADOW_FLOOR = 0.34;
const LOW_TIER_SHADOW_FLOOR = 0.12;

/**
 * How much sky fill survives where the sun cannot reach.
 *
 * Ambient was previously never occluded at all, so a shadowed face still
 * received the full sky term and cast shadows could not exceed about half a
 * stop no matter what the direct floors were set to. The baked term is sun
 * visibility rather than sky visibility, but in terrain with this much relief
 * the two correlate strongly — ground the sun cannot see is usually ground
 * inside a valley or behind a ridge, which sees less sky as well. Using it as a
 * weak occlusion proxy is far closer to right than treating the sky as
 * unobstructed everywhere.
 */
const AMBIENT_OCCLUSION_FLOOR = 0.55;

/**
 * Snow albedo, shared by the shader and its JS mirror.
 *
 * These were (0.72, 0.80, 0.91) and (0.74, 0.79, 0.875) — a 26% blue bias built
 * into the material itself, which then sat under blue sky fill and a blue
 * hemisphere light. Snow's real reflectance is close to flat across the visible
 * band; the blue everyone sees in a snowfield comes from the *light*, not from
 * the snow. Encoding it twice is what drove the measured frame mean to
 * 105/133/160 with red 52% under blue.
 *
 * Kept marginally cool so shadowed snow still reads cold once the sky fill is
 * occluded, but nothing like the original bias.
 */
const SNOW_ALBEDO = [0.86, 0.875, 0.90];
const SNOW_ALBEDO_LOW = [0.85, 0.862, 0.885];

/**
 * Where procedural surface detail fades out, in metres of world distance —
 * scaled at runtime by uZoomScale, because the recon optic narrows the field to
 * a quarter and ground four kilometres away then fills the frame the way ground
 * one kilometre away does unzoomed.
 *
 * Shared with the shader by template injection so the JS mirror and the GLSL
 * cannot drift; terrainDetailWeight() takes the same scale for the same reason.
 */
const DETAIL_FADE_START = 4800;
const DETAIL_FADE_END = 7200;

/**
 * How much of the fixed per-material sky fill survives at a given sun height.
 *
 * The fill used to be constant, so dropping the sun produced a scene lit almost
 * entirely by blue. Real snow is warm-white in sun and blue only in shadow.
 */
const SKY_FILL_BASE = 0.35;
const SKY_FILL_RANGE = 0.65;
const SKY_FILL_RAMP = 1.6;

function skyFill(sunY) {
  return SKY_FILL_BASE + SKY_FILL_RANGE * clamp01(sunY * SKY_FILL_RAMP);
}

/** The same expression as skyFill(), for injection into the shader. */
const SKY_FILL_GLSL =
  `(${SKY_FILL_BASE} + ${SKY_FILL_RANGE} * clamp(uSunDir.y * ${SKY_FILL_RAMP}, 0.0, 1.0))`;
const SLOPE_RADIUS = 96;
const CURVATURE_RADIUS = 288;

function terrainFrameCpu(x, z, cell, nextCell, morph, distance, quality, focusX, focusZ) {
  const t = clamp01(morph);

  // Lighting normal: the baked, bilinearly filtered normal of the level's own
  // grid, blended across the LOD handoff exactly as the shader blends `stored`.
  // Its resolution is allowed to follow the LOD — that is an ordinary mip
  // chain, and vMorph keeps the handoff continuous.
  const fineNormal = storedNormalCpu(
    x, z, cell,
    Math.round(focusX / (cell * 2)) * cell * 2,
    Math.round(focusZ / (cell * 2)) * cell * 2,
  );
  const coarseNormal = storedNormalCpu(
    x, z, nextCell,
    Math.round(focusX / (nextCell * 2)) * nextCell * 2,
    Math.round(focusZ / (nextCell * 2)) * nextCell * 2,
  );
  const minUp = quality === 0 ? 0.32 : 0.05;
  const nx = fineNormal[0] + (coarseNormal[0] - fineNormal[0]) * t;
  const nz = fineNormal[1] + (coarseNormal[1] - fineNormal[1]) * t;
  const up = Math.max(Math.sqrt(Math.max(1 - nx * nx - nz * nz, 1e-4)), minUp);
  const normalLength = 1 / Math.hypot(nx, up, nz);
  const normal = [nx * normalLength, up * normalLength, nz * normalLength];

  const classifyFine = Math.max(CLASSIFY_CELL, cell);
  const classifyCoarse = Math.max(CLASSIFY_CELL, nextCell);
  const slopeFine = terrainFrameAtRadius(x, z, classifyFine, SLOPE_RADIUS, focusX, focusZ);
  const slopeCoarse = terrainFrameAtRadius(x, z, classifyCoarse, SLOPE_RADIUS, focusX, focusZ);
  const classifiedGx = slopeFine.gx + (slopeCoarse.gx - slopeFine.gx) * t;
  const classifiedGz = slopeFine.gz + (slopeCoarse.gz - slopeFine.gz) * t;

  const curveFine = terrainFrameAtRadius(x, z, classifyFine, CURVATURE_RADIUS, focusX, focusZ);
  const curveCoarse = terrainFrameAtRadius(x, z, classifyCoarse, CURVATURE_RADIUS, focusX, focusZ);
  const curvature = curveFine.curvature + (curveCoarse.curvature - curveFine.curvature) * t;

  // The surface orientation classification reasons about. Distinct from the
  // lighting normal on purpose: slope and aspect decide snow, ice and talus, so
  // they have to come from the fixed-level stencil above. Reading them off the
  // lighting normal instead — which is what this did — reintroduced the whole
  // artifact through the back door, because that normal follows the LOD.
  const classifyLength = 1 / Math.hypot(classifiedGx, 1, classifiedGz);
  const classifyNormal = [
    -classifiedGx * classifyLength,
    classifyLength,
    -classifiedGz * classifyLength,
  ];

  return {
    gradient: [classifiedGx, classifiedGz],
    normal,
    classifyNormal,
    curvature: Math.max(-1, Math.min(1, curvature * CURVATURE_RADIUS * 0.38)),
  };
}

/** High-tier material detail stays visible through the operational vista. */
export function terrainDetailWeight(distance, zoomScale = 1) {
  const scale = Math.min(4, Math.max(1, Number.isFinite(zoomScale) ? zoomScale : 1));
  return 1 - smoothstep(DETAIL_FADE_START * scale, DETAIL_FADE_END * scale, Math.max(distance, 0));
}

/** Pure numeric mirror of the broad material mask, used by validation. */
export function evaluateTerrainMaterial({
  x,
  z,
  height,
  slope,
  curvature,
  northAspect,
  lee,
  distance = 0,
  cell,
  nextCell = cell * 2,
  morph = 0,
  quality = 2,
  focusX = x,
  focusZ = z,
  wind = [11, 4.5],
  storedShadow = 1,
  cloudShadow = 1,
  sunIntensity = 1.5,
  sunDirection = DEFAULT_SUN_DIRECTION,
  sunColor = [1, 0.94, 0.84],
  skyIrradiance = [0.18, 0.24, 0.36],
  viewDirection = [0, 1, 0],
}) {
  let frame = null;
  if (!Number.isFinite(slope) && Number.isFinite(cell)) {
    frame = terrainFrameCpu(x, z, cell, nextCell, morph, distance, quality, focusX, focusZ);
    const classify = frame.classifyNormal;
    slope = 1 - classify[1];
    curvature = frame.curvature;
    const aspectLength = Math.hypot(-0.22, 0.25, 0.94);
    northAspect = (
      classify[0] * (-0.22 / aspectLength) +
      classify[1] * (0.25 / aspectLength) +
      classify[2] * (0.94 / aspectLength)
    ) * 0.5 + 0.5;
    const gradientLength = Math.hypot(...frame.gradient);
    const windLength = Math.max(Math.hypot(...wind), 1e-9);
    lee = gradientLength > 1e-6
      ? (
        frame.gradient[0] * (wind[0] / windLength) +
        frame.gradient[1] * (wind[1] / windLength)
      ) / gradientLength * 0.5 + 0.5
      : 0.5;
  }
  if (!frame) {
    const ny = clamp01(1 - slope);
    const nx = Math.sqrt(Math.max(0, 1 - ny * ny));
    frame = { normal: [-nx, ny, 0], gradient: [nx, 0], curvature: curvature ?? 0 };
  }
  const geology = quality === 0
    ? terrainMaterialNoise(x * 0.00042, z * 0.00042) * 0.65 +
      terrainMaterialNoise(x * 0.00091 + 13, z * 0.00091 + 13) * 0.35
    : terrainMaterialGeology(x, height, z);
  const mineral = quality === 0 ? 0.5 : terrainMaterialMineral(x, height, z, frame.normal);
  const snowLine = quality === 0
    ? 4870 + 600 * (geology - 0.5)
    : 4990 + 720 * (geology - 0.5) +
      120 * Math.sin((x + z * 0.37) * 0.00019 + (geology - 0.5) * 1.4);
  const altitude = smoothstep(snowLine - 620, snowLine + 720, height);
  const retention = 1 - smoothstep(0.1, 0.4, slope);
  if (quality === 0) {
    const snow = smoothstep(0.03, 0.97, altitude * retention) * 0.84;
    const rockColor = [0.06, 0.064, 0.074].map((value, i) => (
      value + ([0.19, 0.133, 0.082][i] - value) * geology
    ));
    const snowColor = SNOW_ALBEDO_LOW;
    const albedo = rockColor.map((value, i) => value + (snowColor[i] - value) * snow);
    const sun = normalize3(sunDirection);
    const ndl = frame.normal[0] * sun[0] + frame.normal[1] * sun[1] + frame.normal[2] * sun[2];
    const wrapped = clamp01(ndl * 0.55 + 0.45) ** 2.1;
    const direct = wrapped * mix(LOW_TIER_SHADOW_FLOOR, 1, clamp01(storedShadow)) * (0.64 + 0.36 * snow);
    const lowFill = skyFill(sun[1]);
    const ambient = [0.39, 0.42, 0.48].map((value, i) => (
      (value + ([0.32, 0.40, 0.55][i] - value) * snow) * lowFill
    ));
    const directScale = Math.min(Math.max(sunIntensity, 0) * DIRECT_SUN_SCALE, DIRECT_SUN_CEILING);
    const lit = albedo.map((value, i) => value * (ambient[i] + sunColor[i] * directScale * direct));
    return {
      height,
      rock: 1 - snow,
      shale: 1 - snow,
      granite: 0,
      iron: 0,
      scree: 0,
      ice: 0,
      snow,
      geology,
      mineral,
      albedo,
      roughness: 0.86 * (1 - snow) + 0.66 * snow,
      specular: 0.04 * (1 - snow) + 0.12 * snow,
      normal: frame.normal,
      litColor: lit,
      lightingProxy: lit[0] * 0.2126 + lit[1] * 0.7152 + lit[2] * 0.0722,
      detailWeight: terrainDetailWeight(distance),
      luminance: albedo[0] * 0.2126 + albedo[1] * 0.7152 + albedo[2] * 0.0722,
    };
  }
  const deposit = 0.78 + 0.14 * northAspect + 0.1 * lee + 0.08 * smoothstep(-0.25, 0.4, curvature);
  const snowScour = 0.52 + 0.36 * smoothstep(0.22, 0.82, geology * 0.55 + mineral * 0.45);
  const snow = smoothstep(0.04, 0.96, clamp01(altitude * retention * deposit))
    * (0.84 + (snowScour - 0.84) * smoothstep(0.03, 0.24, slope))
    * (1 - 0.27 * smoothstep(0.1, 0.3, slope));

  const iceAltitude = smoothstep(4480, 5620, height);
  const iceSlope = smoothstep(0.1, 0.22, slope) * (1 - smoothstep(0.48, 0.68, slope));
  const iceConcavity = 0.58 + 0.42 * smoothstep(-0.08, 0.35, curvature);
  const iceAspect = 0.72 + 0.28 * northAspect;
  const icePotential = smoothstep(0.05, 0.95, iceAltitude * iceSlope * iceConcavity * iceAspect);
  const ice = icePotential * (1 - snow) * 0.72;

  const screeSlope = smoothstep(0.12, 0.24, slope) * (1 - smoothstep(0.4, 0.58, slope));
  const screeDeposit = 0.55 + 0.45 * smoothstep(-0.25, 0.28, curvature);
  const screeAltitude = 1 - smoothstep(5200, 6500, height);
  const scree = screeSlope * screeDeposit * screeAltitude * Math.max(0, 1 - snow - ice);
  const rockWeight = Math.max(0, 1 - snow - ice - scree);

  const ironMix = smoothstep(0.58, 0.86, geology) * smoothstep(0.28, 0.72, mineral) * 0.72;
  const graniteMix = smoothstep(0.40, 0.66, mineral) * (1 - ironMix);
  const shaleMix = Math.max(0, 1 - graniteMix - ironMix);
  const shaleColor = [0.052, 0.058, 0.069];
  const graniteColor = [0.265, 0.168, 0.092];
  const ironColor = [0.305, 0.105, 0.045];
  const rockColor = shaleColor.map((v, i) => (
    v * shaleMix + graniteColor[i] * graniteMix + ironColor[i] * ironMix
  ));
  const screeDark = [0.205, 0.145, 0.09];
  const screeLight = [0.305, 0.225, 0.14];
  const screeColor = screeDark.map((v, i) => v + (screeLight[i] - v) * mineral);
  const iceDark = [0.105, 0.315, 0.52];
  const iceLight = [0.22, 0.50, 0.68];
  const iceColor = iceDark.map((v, i) => v + (iceLight[i] - v) * mineral);
  const snowColor = SNOW_ALBEDO;
  const albedo = rockColor.map((v, i) => (
    v * rockWeight + screeColor[i] * scree + iceColor[i] * ice + snowColor[i] * snow
  ));
  const iceRoughness = mix(0.22, 0.36, mineral);
  const roughness = 0.86 * rockWeight + 0.96 * scree + iceRoughness * ice + 0.66 * snow;
  const specular = 0.04 * rockWeight + 0.025 * scree + 0.42 * ice + 0.12 * snow;
  const sun = normalize3(sunDirection);
  const view = normalize3(viewDirection);
  const visibility = mix(SHADOW_FLOOR, 1, clamp01(storedShadow))
    * mix(CLOUD_SHADOW_FLOOR, 1, clamp01(cloudShadow));
  const ndl = dot3(frame.normal, sun);
  const wrappedMaterial = snow * 0.18 + ice * 0.1;
  let direct = mix(
    Math.max(ndl, 0),
    clamp01(ndl * 0.5 + 0.5) ** 2.7,
    wrappedMaterial,
  ) * visibility;
  direct *= rockWeight * 0.82 + scree * 0.92 + ice * 0.86 + snow;
  const ambientWeight = rockWeight * 0.25 + scree * 0.29 + ice * 0.39 + snow * 0.43;
  const fill = skyFill(sun[1]);
  const occlusion = mix(AMBIENT_OCCLUSION_FLOOR, 1, clamp01(storedShadow));
  const ambient = skyIrradiance.map((value, i) => (
    (value * ambientWeight +
      ([0.105, 0.115, 0.135][i] * rockWeight +
        [0.135, 0.115, 0.095][i] * scree +
        [0.075, 0.165, 0.275][i] * ice +
        [0.185, 0.245, 0.365][i] * snow) * fill) * occlusion
  ));
  const ambientLuma = ambient[0] * 0.2126 + ambient[1] * 0.7152 + ambient[2] * 0.0722;
  const directScale = Math.min(Math.max(sunIntensity, 0) * DIRECT_SUN_SCALE, DIRECT_SUN_CEILING);
  const litColor = albedo.map((value, i) => (
    value * (ambient[i] + sunColor[i] * directScale * direct)
  ));
  const halfVector = normalize3(sun.map((value, i) => value + view[i]));
  const specularPower = mix(24, 150, 1 - roughness);
  const materialGlint = Math.max(dot3(frame.normal, halfVector), 0) ** specularPower *
    specular * visibility;
  for (let i = 0; i < 3; i++) litColor[i] += sunColor[i] * materialGlint;
  const lightingProxy = litColor[0] * 0.2126 + litColor[1] * 0.7152 + litColor[2] * 0.0722;
  return {
    height,
    rock: rockWeight,
    shale: rockWeight * shaleMix,
    granite: rockWeight * graniteMix,
    iron: rockWeight * ironMix,
    scree,
    ice,
    snow,
    geology,
    mineral,
    albedo,
    roughness,
    specular,
    normal: frame.normal,
    litColor,
    lightingProxy,
    ambientLuma,
    detailWeight: terrainDetailWeight(distance),
    luminance: albedo[0] * 0.2126 + albedo[1] * 0.7152 + albedo[2] * 0.0722,
  };
}

/** Selects a valid height source without pretending nearest float is filtered. */
export function selectTerrainStorage({ colorFloat, floatLinear }) {
  if (!colorFloat) return { mode: 'cpu-manual-linear', gpuGenerated: false, manualLinear: true };
  if (!floatLinear) return { mode: 'gpu-manual-linear', gpuGenerated: true, manualLinear: true };
  return { mode: 'gpu-linear', gpuGenerated: true, manualLinear: false };
}

export function buildTerrainVertexShader({ levels, res, half, depthBias }) {
  return /* glsl */ `
    precision highp float;
    precision highp sampler2DArray;
    invariant gl_Position;
    in float aLevel;
    uniform sampler2DArray uHeightMap;
    uniform vec2 uCenters[${levels}];
    uniform float uCells[${levels}];
    out vec3 vWorld;
    out float vMorph;
    out float vLevelF;
    out float vNextLevelF;
    const float RES = ${res.toFixed(1)};
    const float HALF = ${half.toFixed(1)};
    vec2 levelUV(vec2 world, int level) {
      return ((world - uCenters[level]) / uCells[level] + HALF + 0.5) / RES;
    }
    vec4 terrainBilinear(vec2 uv, int level) {
      vec2 texel = uv * RES - 0.5;
      ivec2 base = ivec2(floor(texel));
      vec2 f = fract(texel);
      ivec2 hi = ivec2(int(RES) - 1);
      ivec2 p00 = clamp(base, ivec2(0), hi);
      ivec2 p10 = clamp(base + ivec2(1, 0), ivec2(0), hi);
      ivec2 p01 = clamp(base + ivec2(0, 1), ivec2(0), hi);
      ivec2 p11 = clamp(base + ivec2(1), ivec2(0), hi);
      vec4 a = mix(texelFetch(uHeightMap, ivec3(p00, level), 0), texelFetch(uHeightMap, ivec3(p10, level), 0), f.x);
      vec4 b = mix(texelFetch(uHeightMap, ivec3(p01, level), 0), texelFetch(uHeightMap, ivec3(p11, level), 0), f.x);
      return mix(a, b, f.y);
    }
    void main() {
      int level = int(aLevel + 0.5);
      int nextLevel = min(level + 1, ${levels - 1});
      float cell = uCells[level];
      vec2 center = uCenters[level];
      vec2 index = position.xz;
      vec2 d = abs(index - HALF) / HALF;
      float edge = max(d.x, d.y);
      float morph = level == ${levels - 1} ? 0.0 : smoothstep(0.70, 0.94, edge);
      vec2 odd = fract(index * 0.5) * 2.0;
      vec2 world = center + (index - odd * morph - HALF) * cell;
      float h0 = terrainBilinear(levelUV(world, level), level).r;
      float h1 = terrainBilinear(levelUV(world, nextLevel), nextLevel).r;
      vWorld = vec3(world.x, mix(h0, h1, morph), world.y);
      vMorph = morph;
      vLevelF = float(level);
      vNextLevelF = float(nextLevel);
      gl_Position = projectionMatrix * modelViewMatrix * vec4(vWorld, 1.0);
      gl_Position.z += gl_Position.w * ${depthBias} * float(level);
    }
  `;
}

export function buildTerrainFragmentShader({ levels, res, half, quality = 2 }) {
  return /* glsl */ `
    #define TERRAIN_QUALITY ${quality}
    precision highp float;
    precision highp sampler2DArray;
    in vec3 vWorld;
    in float vMorph;
    in float vLevelF;
    in float vNextLevelF;
    out vec4 fragColor;
    uniform sampler2DArray uHeightMap;
    uniform vec2 uCenters[${levels}];
    uniform float uCells[${levels}];
    uniform float uDetailFade;
    uniform float uZoomScale;
    uniform float uTime;
    uniform vec2 uWind;
    uniform vec3 uCameraPos;
    ${ATMOSPHERE_UNIFORMS_GLSL}
    ${ATMOSPHERE_GLSL}
    ${CLOUD_GLSL}
    const float RES = ${res.toFixed(1)};
    const float HALF = ${half.toFixed(1)};

    vec2 levelUV(vec2 world, int level) {
      return ((world - uCenters[level]) / uCells[level] + HALF + 0.5) / RES;
    }
    vec4 terrainBilinear(vec2 uv, int level) {
      vec2 texel = uv * RES - 0.5;
      ivec2 base = ivec2(floor(texel));
      vec2 f = fract(texel);
      ivec2 hi = ivec2(int(RES) - 1);
      ivec2 p00 = clamp(base, ivec2(0), hi);
      ivec2 p10 = clamp(base + ivec2(1, 0), ivec2(0), hi);
      ivec2 p01 = clamp(base + ivec2(0, 1), ivec2(0), hi);
      ivec2 p11 = clamp(base + ivec2(1), ivec2(0), hi);
      vec4 a = mix(texelFetch(uHeightMap, ivec3(p00, level), 0), texelFetch(uHeightMap, ivec3(p10, level), 0), f.x);
      vec4 b = mix(texelFetch(uHeightMap, ivec3(p01, level), 0), texelFetch(uHeightMap, ivec3(p11, level), 0), f.x);
      return mix(a, b, f.y);
    }
    float terrainHeightAt(vec2 world, int level) { return terrainBilinear(levelUV(world, level), level).r; }
    /** Gradient and Laplacian over a stencil measured in metres, not in cells. */
    vec3 terrainSample(vec2 world, int level, float e) {
      float hx0 = terrainHeightAt(world - vec2(e, 0.0), level);
      float hx1 = terrainHeightAt(world + vec2(e, 0.0), level);
      float hz0 = terrainHeightAt(world - vec2(0.0, e), level);
      float hz1 = terrainHeightAt(world + vec2(0.0, e), level);
      float h = terrainHeightAt(world, level);
      return vec3(vec2(hx1 - hx0, hz1 - hz0) / (2.0 * e),
                  (hx0 + hx1 + hz0 + hz1 - 4.0 * h) / max(e * e, 1.0));
    }

    /**
     * The clipmap level classification reads, whatever level the geometry uses.
     *
     * Level ${CLASSIFY_LEVEL} has ${CLASSIFY_CELL} m texels and covers the first
     * four kilometres, so everything the player can see the surface of is
     * classified from one reconstruction of the terrain. See the CPU mirror in
     * this file for why a fixed *radius* alone was not enough.
     */
    int classifyLevel(int level) { return max(level, ${CLASSIFY_LEVEL}); }

    /**
     * Unpack the normal the generation pass baked into g/b.
     *
     * Only xz are stored; y is recovered as sqrt(1 - x^2 - z^2), which is exact
     * for a heightfield and freed the alpha channel for sun visibility. The
     * clamp matters because the sample is a mix of two levels' filtered
     * normals, and a blend of two unit vectors is shorter than one — without it
     * a steep face where x^2 + z^2 drifts past 1 produces a NaN and a black
     * pixel. minUp keeps a lighting-safe upward component on the low tier.
     */
    vec3 storedNormal(vec4 stored, float minUp) {
      vec2 xz = stored.gb;
      float up = sqrt(max(1.0 - dot(xz, xz), 1e-4));
      return normalize(vec3(xz.x, max(up, minUp), xz.y));
    }
    float hash21(vec2 p) {
      vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }
    float noise2(vec2 p) {
      vec2 i = floor(p), f = fract(p);
      f = f * f * (3.0 - 2.0 * f);
      return mix(mix(hash21(i), hash21(i + vec2(1, 0)), f.x),
                 mix(hash21(i + vec2(0, 1)), hash21(i + 1.0), f.x), f.y);
    }

    #if TERRAIN_QUALITY > 0
    vec3 triplanarWeights(vec3 n) {
      vec3 w = pow(abs(n), vec3(4.0));
      return w / max(w.x + w.y + w.z, 1e-4);
    }
    float fbmTriplanar(vec3 p, vec3 weights) {
      float sum = 0.0, amplitude = 0.54, norm = 0.0;
      for (int octave = 0; octave < 4; octave++) {
        vec3 tri = vec3(noise2(p.yz), noise2(p.xz + 31.7), noise2(p.xy + 73.1));
        sum += dot(tri, weights) * amplitude;
        norm += amplitude;
        p = p.yzx * 1.93 + vec3(11.3, 7.1, 17.7);
        amplitude *= 0.51;
      }
      return sum / norm;
    }
    float ridgedGeology(vec3 world) {
      vec2 p = world.xz * 0.00034 + vec2(world.y * 0.00009, -world.y * 0.00005);
      float sum = 0.0, amplitude = 0.54, norm = 0.0;
      for (int octave = 0; octave < 4; octave++) {
        float ridge = 1.0 - abs(noise2(p) * 2.0 - 1.0);
        sum += ridge * amplitude;
        norm += amplitude;
        p = mat2(1.71, 1.09, -1.09, 1.71) * p + vec2(11.3, 7.1);
        amplitude *= 0.51;
      }
      return sum / norm;
    }
    #endif

    void main() {
      int level = int(vLevelF + 0.5);
      int nextLevel = int(vNextLevelF + 0.5);
      float cell = mix(uCells[level], uCells[nextLevel], vMorph);
      vec4 stored = mix(terrainBilinear(levelUV(vWorld.xz, level), level),
                        terrainBilinear(levelUV(vWorld.xz, nextLevel), nextLevel), vMorph);
      float surfaceHeight = stored.r;
      vec3 toCamera = uCameraPos - vWorld;
      float distanceToCamera = max(length(toCamera), 1.0);
      vec3 V = toCamera / distanceToCamera;

      #if TERRAIN_QUALITY == 0
        // The lighting normal is the one the generation pass baked, which is
        // bilinearly filtered and therefore already smooth across texels. It
        // used to be reconstructed here from a distance-widened height stencil
        // to hide triangle-scale lighting wedges; the stored normal has no
        // wedges to hide, costs four fetches instead of twenty, and does not
        // change as the aircraft closes.
        vec3 N = storedNormal(stored, 0.32);
        // Classification reads one fixed level so a patch of ground keeps its
        // identity at every range. See classifyLevel().
        vec2 lowSlopeGradient = mix(
          terrainSample(vWorld.xz, classifyLevel(level), ${SLOPE_RADIUS.toFixed(1)}).xy,
          terrainSample(vWorld.xz, classifyLevel(nextLevel), ${SLOPE_RADIUS.toFixed(1)}).xy,
          vMorph);
        float slope = 1.0 - inversesqrt(1.0 + dot(lowSlopeGradient, lowSlopeGradient));
        float geology = noise2(vWorld.xz * 0.00042) * 0.65 + noise2(vWorld.xz * 0.00091 + 13.0) * 0.35;
        float snowLine = 4870.0 + (geology - 0.5) * 600.0;
        float snow = smoothstep(snowLine - 620.0, snowLine + 720.0, surfaceHeight) * (1.0 - smoothstep(0.10, 0.40, slope));
        snow = smoothstep(0.03, 0.97, snow) * 0.84;
        vec3 rock = mix(vec3(0.060, 0.064, 0.074), vec3(0.190, 0.133, 0.082), geology);
        vec3 albedo = mix(rock, vec3(${SNOW_ALBEDO_LOW.join(", ")}), snow);
        float wrapped = pow(clamp(dot(N, uSunDir) * 0.55 + 0.45, 0.0, 1.0), 2.1);
        float direct = wrapped * mix(${LOW_TIER_SHADOW_FLOOR}, 1.0, stored.a) * mix(0.64, 1.0, snow);
        // Low-tier terrain still needs enough blue-sky fill to keep opposing
        // ridge faces readable after tone mapping — but it has to fall with the
        // sun, or a low sun lights the scene almost entirely in blue.
        float lowFill = ${SKY_FILL_GLSL};
        vec3 ambient = mix(vec3(0.39, 0.42, 0.48), vec3(0.32, 0.40, 0.55), snow) * lowFill;
        vec3 color = albedo * (ambient + uSunColor * min(uSunIntensity * ${DIRECT_SUN_SCALE}, ${DIRECT_SUN_CEILING}) * direct);
      #else
        // Lighting normal, straight from the heightmap.
        //
        // This used to be reconstructed here from four five-tap height stencils
        // across two levels — 80 texture fetches per terrain fragment — with the
        // stencil width growing with camera distance. Two things were wrong with
        // it. The reconstruction differentiates a *bilinear* height field, whose
        // derivative is discontinuous at every texel boundary, so the normal was
        // piecewise flat: that is the hard triangular faceting the recon camera
        // showed at range. And the distance-varying stencil meant the same
        // hillside was lit from a different normal at 5 km than at 1 km.
        //
        // The generation pass already bakes a normal per texel, and reading it
        // through the same bilinear filter gives a normal that is continuous by
        // construction, matches the shadow term it was baked alongside, and
        // costs nothing extra: the sample was already fetched for the height.
        vec3 N = storedNormal(stored, 0.05);

        // Classification: fixed world-space stencils on a fixed clipmap level.
        int cLevel = classifyLevel(level);
        int cNextLevel = classifyLevel(nextLevel);
        vec3 slopeSample = mix(
          terrainSample(vWorld.xz, cLevel, ${SLOPE_RADIUS.toFixed(1)}),
          terrainSample(vWorld.xz, cNextLevel, ${SLOPE_RADIUS.toFixed(1)}),
          vMorph);
        float curvatureSample = mix(
          terrainSample(vWorld.xz, cLevel, ${CURVATURE_RADIUS.toFixed(1)}).z,
          terrainSample(vWorld.xz, cNextLevel, ${CURVATURE_RADIUS.toFixed(1)}).z,
          vMorph);
        vec2 classified = slopeSample.xy;
        // The orientation classification reasons about, which is deliberately
        // not the lighting normal: snow, ice and talus are decided by landform,
        // and the lighting normal follows the LOD.
        vec3 classifyN = normalize(vec3(-classified.x, 1.0, -classified.y));
        float slope = 1.0 - classifyN.y;
        float curvature = clamp(curvatureSample * ${CURVATURE_RADIUS.toFixed(1)} * 0.38, -1.0, 1.0);
        vec3 weights = triplanarWeights(N);
        float geology = ridgedGeology(vWorld);
        float mineral = fbmTriplanar(vWorld * 0.00115, weights);
        vec3 wind = normalize(vec3(uWind.x, 0.0, uWind.y) + vec3(1e-3, 0.0, 0.0));
        vec3 downhill = normalize(vec3(classified.x, 0.0, classified.y) + vec3(1e-3, 0.0, 0.0));
        float lee = dot(downhill, wind) * 0.5 + 0.5;
        float northAspect = dot(classifyN, normalize(vec3(-0.22, 0.25, 0.94))) * 0.5 + 0.5;
        float warpedStrata = sin((vWorld.x + vWorld.z * 0.37) * 0.00019 + (geology - 0.5) * 1.4);
        float snowLine = 4990.0 + (geology - 0.5) * 720.0 + warpedStrata * 120.0;
        float altitudeSnow = smoothstep(snowLine - 620.0, snowLine + 720.0, surfaceHeight);
        float retention = 1.0 - smoothstep(0.10, 0.40, slope);
        float deposition = 0.78 + northAspect * 0.14 + lee * 0.10 + smoothstep(-0.25, 0.40, curvature) * 0.08;
        float snowScour = 0.52 + 0.36 * smoothstep(0.22, 0.82, geology * 0.55 + mineral * 0.45);
        float snow = smoothstep(0.04, 0.96, clamp(altitudeSnow * retention * deposition, 0.0, 1.0));
        snow *= mix(0.84, snowScour, smoothstep(0.03, 0.24, slope));
        snow *= 1.0 - 0.27 * smoothstep(0.10, 0.30, slope);

        // Broad glacier placement: cold, high, shaded concavities with enough
        // slope to expose compacted ice but not so much that no glacier holds.
        float iceAltitude = smoothstep(4480.0, 5620.0, surfaceHeight);
        float iceSlope = smoothstep(0.10, 0.22, slope) * (1.0 - smoothstep(0.48, 0.68, slope));
        float iceConcavity = 0.58 + 0.42 * smoothstep(-0.08, 0.35, curvature);
        float iceAspect = 0.72 + 0.28 * northAspect;
        float icePotential = smoothstep(0.05, 0.95, iceAltitude * iceSlope * iceConcavity * iceAspect);
        float ice = icePotential * (1.0 - snow) * 0.72;

        // Warm talus sits below the ice on depositional mid-slopes.  Applying
        // it only to the material remainder keeps all four weights conservative.
        float screeSlope = smoothstep(0.12, 0.24, slope) * (1.0 - smoothstep(0.40, 0.58, slope));
        float screeDeposit = 0.55 + 0.45 * smoothstep(-0.25, 0.28, curvature);
        float screeAltitude = 1.0 - smoothstep(5200.0, 6500.0, surfaceHeight);
        float scree = screeSlope * screeDeposit * screeAltitude * max(0.0, 1.0 - snow - ice);
        float rockWeight = max(0.0, 1.0 - snow - ice - scree);

        // Anti-aliased continuous strata give the dark shale and warm granite
        // directional structure without discrete contour lines or point noise.
        // Detail fades by *apparent* size, not world distance. The recon optic
        // narrows to a quarter of the normal field, so ground 4 km away fills
        // the frame the way ground 1 km away does unzoomed — and fading its
        // detail on a fixed world distance is what left the payoff shot, the
        // one image the whole sortie exists to produce, looking flatter than
        // any view the player gets for free.
        float detailDistanceFade = 1.0 - smoothstep(${DETAIL_FADE_START}.0 * uZoomScale, ${DETAIL_FADE_END}.0 * uZoomScale, distanceToCamera);
        float strataCoord = surfaceHeight * 0.0105 + dot(vWorld.xz, vec2(0.0027, 0.0014)) + geology * 2.7;
        float strataFilter = 1.0 - smoothstep(0.18, 0.88, fwidth(strataCoord));
        float strata = sin(strataCoord) * strataFilter * detailDistanceFade;
        float ironMix = smoothstep(0.58, 0.86, geology) * smoothstep(0.28, 0.72, mineral) * 0.72;
        float graniteMix = smoothstep(0.40, 0.66, mineral) * (1.0 - ironMix);
        float shaleMix = max(0.0, 1.0 - graniteMix - ironMix);
        vec3 rock = vec3(0.052, 0.058, 0.069) * shaleMix;
        rock += vec3(0.265, 0.168, 0.092) * graniteMix;
        rock += vec3(0.305, 0.105, 0.045) * ironMix;
        rock *= 1.0 + strata * 0.24;
        vec3 screeColor = mix(vec3(0.205, 0.145, 0.090), vec3(0.305, 0.225, 0.140), mineral);
        screeColor *= 1.0 + strata * 0.07;
        vec3 iceColor = mix(vec3(0.105, 0.315, 0.520), vec3(0.220, 0.500, 0.680), mineral);
        vec3 snowColor = vec3(${SNOW_ALBEDO.join(", ")});
        vec3 albedo = rock * rockWeight + screeColor * scree + iceColor * ice + snowColor * snow;
        float iceRoughness = mix(0.22, 0.36, mineral);
        float roughness = 0.86 * rockWeight + 0.96 * scree + iceRoughness * ice + 0.66 * snow;
        float specularStrength = 0.04 * rockWeight + 0.025 * scree + 0.42 * ice + 0.12 * snow;
        #if TERRAIN_QUALITY > 1
          // Filter each octave by the projected world-space pixel footprint.
          // This preserves readable normals through 5 km while removing the
          // frequencies that would otherwise shimmer at the horizon.
          vec2 footprint2 = fwidth(vWorld.xz);
          float footprint = max(max(abs(footprint2.x), abs(footprint2.y)), 1.0);
          float normalFade = uDetailFade * detailDistanceFade;
          if (normalFade > 0.002) {
            float eps = max(2.0, footprint * 0.72);
            float macroFrequency = 0.0017;
            float fineFrequency = 0.0062;
            float macroFilter = 1.0 - smoothstep(0.16, 0.72, footprint * macroFrequency);
            float fineFilter = 1.0 - smoothstep(0.12, 0.52, footprint * fineFrequency);
            vec2 macroGrad = vec2(
              noise2((vWorld.xz + vec2(eps, 0.0)) * macroFrequency) - noise2((vWorld.xz - vec2(eps, 0.0)) * macroFrequency),
              noise2((vWorld.xz + vec2(0.0, eps)) * macroFrequency) - noise2((vWorld.xz - vec2(0.0, eps)) * macroFrequency)
            ) / max(2.0 * eps * macroFrequency, 1e-3);
            vec2 fineGrad = vec2(
              noise2((vWorld.xz + vec2(eps, 0.0)) * fineFrequency + 37.0) - noise2((vWorld.xz - vec2(eps, 0.0)) * fineFrequency + 37.0),
              noise2((vWorld.xz + vec2(0.0, eps)) * fineFrequency + 37.0) - noise2((vWorld.xz - vec2(0.0, eps)) * fineFrequency + 37.0)
            ) / max(2.0 * eps * fineFrequency, 1e-3);
            float materialNormal = rockWeight * 0.095 + scree * 0.14 + ice * 0.032 + snow * 0.045;
            vec2 grad = (macroGrad * macroFilter + fineGrad * fineFilter * 0.48) * materialNormal * normalFade;
            N = normalize(vec3(N.x - grad.x, max(N.y, 0.28), N.z - grad.y));
          }
          vec2 acrossWind = normalize(vec2(-wind.z, wind.x));
          float sastrugiCoord = dot(vWorld.xz, acrossWind) * 0.082 + noise2(vWorld.xz * 0.0045) * 1.6;
          float ridgeAA = fwidth(sastrugiCoord);
          float ridge = 1.0 - smoothstep(0.08 + ridgeAA, 0.34 + ridgeAA, abs(fract(sastrugiCoord) - 0.5) * 2.0);
          albedo *= 1.0 + ridge * snow * normalFade * 0.022;
        #endif
        float visibility = mix(${SHADOW_FLOOR}, 1.0, stored.a)
          * mix(${CLOUD_SHADOW_FLOOR}, 1.0, cloudShadowAt(vWorld, uSunDir));
        float ndl = dot(N, uSunDir);
        float wrappedMaterial = snow * 0.18 + ice * 0.10;
        float direct = mix(max(ndl, 0.0), pow(clamp(ndl * 0.5 + 0.5, 0.0, 1.0), 2.7), wrappedMaterial) * visibility;
        direct *= rockWeight * 0.82 + scree * 0.92 + ice * 0.86 + snow;
        // Fixed sky fill, scaled by sun height. Constant fill meant a low sun
        // produced a scene lit almost entirely by blue; real snow is warm-white
        // in sun and blue only where the sun cannot reach it.
        float fill = ${SKY_FILL_GLSL};
        vec3 ambient = atm_skyIrradiance(N) * (rockWeight * 0.25 + scree * 0.29 + ice * 0.39 + snow * 0.43);
        ambient += vec3(0.105, 0.115, 0.135) * rockWeight * fill;
        ambient += vec3(0.135, 0.115, 0.095) * scree * fill;
        ambient += vec3(0.075, 0.165, 0.275) * ice * fill;
        ambient += vec3(0.185, 0.245, 0.365) * snow * fill;
        // Sky fill is occluded too. Leaving it unoccluded capped cast-shadow
        // contrast near half a stop however deep the direct floors went.
        ambient *= mix(${AMBIENT_OCCLUSION_FLOOR}, 1.0, stored.a);
        vec3 color = albedo * (ambient + uSunColor * min(uSunIntensity * ${DIRECT_SUN_SCALE}, ${DIRECT_SUN_CEILING}) * direct);
        vec3 H = normalize(uSunDir + V);
        float specPower = mix(24.0, 150.0, 1.0 - roughness);
        float materialGlint = pow(max(dot(N, H), 0.0), specPower) * specularStrength * visibility;
        color += uSunColor * materialGlint;
      #endif

      color = atm_applyAerial(color, -V, distanceToCamera, uCameraPos.y, vWorld.y);
      fragColor = vec4(clamp(color, vec3(0.0), vec3(2.25)), 1.0);
    }
  `;
}
