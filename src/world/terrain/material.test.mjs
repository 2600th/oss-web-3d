import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import {
  buildTerrainFragmentShader,
  buildTerrainVertexShader,
  evaluateTerrainMaterial,
  terrainMaterialHash,
  selectTerrainStorage,
  terrainDetailWeight,
} from './material.glsl.js';
import { terrainHeight } from '../heightfield.js';
import { Terrain, configureTerrain } from '../Terrain.js';

const common = { levels: 10, res: 257, half: 128 };
const high = buildTerrainFragmentShader({ ...common, quality: 2 });
const low = buildTerrainFragmentShader({ ...common, quality: 0 });
const vertex = buildTerrainVertexShader({ ...common, depthBias: '1.2e-5' });

const terrainSource = await readFile(new URL('../Terrain.js', import.meta.url), 'utf8');
const materialMethodStart = terrainSource.indexOf('  _buildTerrainMaterial() {');
const materialMethodEnd = terrainSource.indexOf('  /** Regenerate one clipmap', materialMethodStart);
assert.ok(materialMethodStart >= 0 && materialMethodEnd > materialMethodStart, 'terrain material builder is discoverable');
const materialMethodSource = terrainSource.slice(materialMethodStart, materialMethodEnd);
assert.match(materialMethodSource, /vertexShader:\s*buildTerrainVertexShader\(\{/, 'ShaderMaterial directly receives the generated vertex shader');
assert.match(materialMethodSource, /fragmentShader:\s*buildTerrainFragmentShader\(\{/, 'ShaderMaterial directly receives the generated fragment shader');
assert.doesNotMatch(materialMethodSource, /this\.material\.(?:vertexShader|fragmentShader)\s*=/, 'generated shaders are not assigned after construction');
assert.doesNotMatch(materialMethodSource, /\/\*\s*glsl\s*\*\/\s*`/, 'material builder carries no obsolete inline GLSL payload');

assert.equal(selectTerrainStorage({ colorFloat: true, floatLinear: true }).mode, 'gpu-linear');
assert.equal(selectTerrainStorage({ colorFloat: true, floatLinear: false }).mode, 'gpu-manual-linear');
assert.equal(selectTerrainStorage({ colorFloat: false, floatLinear: false }).mode, 'cpu-manual-linear');
assert.match(vertex, /terrainBilinear/, 'vertex displacement uses deterministic manual bilinear filtering');
assert.match(high, /#define TERRAIN_QUALITY 2/, 'high shader specializes at compile time');
assert.match(low, /#define TERRAIN_QUALITY 0/, 'low shader specializes at compile time');
assert.match(high, /for \(int octave = 0; octave < 4; octave\+\+\)/, 'geology uses genuine multi-octave synthesis');
assert.match(high, /ridgedGeology/, 'geology includes directional ridges');
assert.doesNotMatch(high, /sparkle|hash21\(floor/, 'point sparkle is absent');
assert.doesNotMatch(high, /fract\(bedding\)|discard/, 'contours and dither transitions are absent');
assert.match(high, /icePotential/, 'high shader carries the same glacial-ice mask as the numeric contract');
assert.match(high, /iceRoughness/, 'high shader shades compacted ice as a distinct smooth material');
assert.match(high, /detailDistanceFade/, 'high shader preserves band-limited material detail at flight distance');
assert.match(high, /fwidth\(vWorld\.xz\)/, 'high shader filters procedural normal detail by projected footprint');
assert.match(high, /float surfaceHeight = stored\.r/, 'material altitude must use bilinear height instead of triangle-planar vWorld.y');
assert.match(high, /ironMix/, 'high shader must preserve a distinct iron geology channel');
assert.match(high, /graniteMix/, 'high shader must preserve a distinct warm granite channel');
assert.match(low, /float lowNormalRadius/, 'low tier must use a distance-aware broad normal stencil');
assert.match(low, /max\(lowN\.y, 0\.32\)/, 'low lighting normals must retain a safe upward component');

// Golden probes are evaluated from the GLSL hash/warp/triplanar equations,
// rather than from the former sine-hash approximation. A change to either
// side must now update one explicit production contract.
assert.ok(Math.abs(terrainMaterialHash(17, -9) - 0.42563698624326207) < 1e-12);
const productionProbe = evaluateTerrainMaterial({
  x: 21000,
  z: 6000,
  height: terrainHeight(21000, 6000),
  cell: 64,
  nextCell: 128,
  morph: 0.46,
  distance: 8000,
  storedShadow: 0.37,
  cloudShadow: 0.64,
  sunIntensity: 2.2,
  skyIrradiance: [0.12, 0.18, 0.28],
  viewDirection: [0.1, 0.7, 0.7],
});
assert.ok(Math.abs(productionProbe.geology - 0.696373584310663) < 1e-12);
assert.ok(Math.abs(productionProbe.mineral - 0.6523138439725243) < 1e-12);
assert.ok(Math.abs(productionProbe.roughness - 0.695724923600153) < 1e-12);
assert.deepEqual(
  productionProbe.litColor.map((value) => Number(value.toFixed(12))),
  [0.180068948122, 0.240363772958, 0.369158859472],
  'CPU lighting must match the deployed shadow/sun/ambient/specular equation',
);
assert.ok(Math.abs(productionProbe.lightingProxy - 0.2368440984440886) < 1e-12);

// Numeric material contract: broad continuous accumulation, bounded albedo,
// and no threshold-sized jumps over a 30 m flight-camera step.
let previous;
let maxSnowJump = 0;
let minRockLuma = Infinity;
let maxSnowLuma = -Infinity;
for (let i = 0; i < 240; i++) {
  const x = i * 30;
  const sample = evaluateTerrainMaterial({
    x,
    z: 1700 + i * 11,
    height: 3900 + i * 9,
    slope: 0.08 + 0.36 * (0.5 + 0.5 * Math.sin(i * 0.071)),
    curvature: Math.sin(i * 0.043) * 0.35,
    northAspect: 0.5 + 0.5 * Math.sin(i * 0.019),
    lee: 0.5 + 0.5 * Math.cos(i * 0.023),
  });
  assert.ok(sample.snow >= 0 && sample.snow <= 1);
  assert.ok(sample.albedo.every((v) => v >= 0.045 && v <= 0.94));
  if (previous) maxSnowJump = Math.max(maxSnowJump, Math.abs(sample.snow - previous.snow));
  if (sample.snow < 0.2) minRockLuma = Math.min(minRockLuma, sample.luminance);
  if (sample.snow > 0.65) maxSnowLuma = Math.max(maxSnowLuma, sample.luminance);
  previous = sample;
}
assert.ok(maxSnowJump < 0.18, `snow mask continuity regressed: ${maxSnowJump}`);
assert.ok(minRockLuma >= 0.05, `rock albedo crushed: ${minRockLuma}`);
assert.ok(maxSnowLuma <= 0.9, `snow albedo clips before lighting: ${maxSnowLuma}`);
assert.ok(maxSnowLuma - minRockLuma > 0.5, 'rock/snow value separation is meaningful');

// Low-tier rendered-response proxy. Closely spaced route samples cross many
// alternate clipmap triangle diagonals; a faceted lighting normal used to turn
// those transitions into severe dark wedges despite a continuous heightfield.
let previousLow;
let maxLowLightingJump = 0;
let minLowLighting = Infinity;
for (let i = 0; i < 320; i++) {
  const x = 15000 + i * 32;
  const z = 1800 + i * 17 + Math.sin(i * 0.09) * 420;
  const lowSample = evaluateTerrainMaterial({
    x,
    z,
    height: terrainHeight(x, z),
    cell: 64,
    nextCell: 128,
    morph: (i % 48) / 47,
    distance: 1800 + i * 11,
    quality: 0,
  });
  minLowLighting = Math.min(minLowLighting, lowSample.lightingProxy);
  if (previousLow) {
    maxLowLightingJump = Math.max(
      maxLowLightingJump,
      Math.abs(lowSample.lightingProxy - previousLow.lightingProxy),
    );
  }
  previousLow = lowSample;
}
assert.ok(minLowLighting > 0.046, `low route lighting collapsed into black wedges: ${minLowLighting}`);
assert.ok(maxLowLightingJump < 0.17, `low route lighting retained hard facet jumps: ${maxLowLightingJump}`);

// Real operational-route samples exercise the deployed fract hash,
// height-warped geology, triplanar mineral field, and clipmap LOD reconstruction.
{
  const samples = [];
  const lowSamples = [];
  for (let z = -2000; z <= 14000; z += 500) {
    for (let x = 14000; x <= 28000; x += 500) {
      const routeSample = {
        x,
        z,
        height: terrainHeight(x, z),
        cell: 64,
        nextCell: 128,
        morph: 0.46,
        distance: 4200,
      };
      samples.push(evaluateTerrainMaterial(routeSample));
      lowSamples.push(evaluateTerrainMaterial({ ...routeSample, quality: 0 }));
    }
  }
  assert.ok(samples.every((sample) => (
    Array.isArray(sample.normal) && sample.normal.length === 3 && sample.normal.every(Number.isFinite)
  )), 'coarse route samples must expose a finite reconstructed normal');
  assert.ok(samples.every((sample) => sample.normal[1] >= 0.18), 'low-tier normals must remain upward and lighting-safe');

  const means = { rock: 0, scree: 0, ice: 0, snow: 0, shale: 0, granite: 0, iron: 0 };
  for (const sample of samples) {
    for (const key of Object.keys(means)) means[key] += sample[key] / samples.length;
  }
  assert.ok(means.snow < 0.48, `opening route cannot collapse mostly to snow: ${JSON.stringify(means)}`);
  assert.ok(means.rock > 0.20, `opening route needs persistent exposed bedrock: ${JSON.stringify(means)}`);
  assert.ok(means.scree > 0.055, `opening route needs readable talus coverage: ${JSON.stringify(means)}`);
  assert.ok(means.ice > 0.055 && means.ice < 0.30, `ice must be distinct but bounded: ${JSON.stringify(means)}`);
  assert.ok(means.shale > 0.045, `charcoal shale needs route-scale coverage: ${JSON.stringify(means)}`);
  assert.ok(means.granite > 0.045, `warm granite needs route-scale coverage: ${JSON.stringify(means)}`);
  assert.ok(means.iron > 0.012, `iron geology needs route-scale coverage: ${JSON.stringify(means)}`);

  const lowMeans = lowSamples.reduce((result, sample) => ({
    rock: result.rock + sample.rock / lowSamples.length,
    snow: result.snow + sample.snow / lowSamples.length,
  }), { rock: 0, snow: 0 });
  assert.ok(
    lowMeans.rock >= 0.35 && lowMeans.rock <= 0.50,
    `low route needs substantial exposed rock: ${JSON.stringify(lowMeans)}`,
  );
  assert.ok(lowMeans.snow <= 0.60, `low route cannot collapse to white: ${JSON.stringify(lowMeans)}`);
}

{
  // A fully morphed level and the next ring's inner edge describe the same
  // surface. Their reconstructed normal/material response must be identical.
  const positions = [
    [21000, 6000],
    [17400, 9800],
    [26200, 1800],
    [23600, 13200],
  ];
  for (const [x, z] of positions) {
    const commonSample = { x, z, height: terrainHeight(x, z), distance: 5200 };
    const fineEdge = evaluateTerrainMaterial({ ...commonSample, cell: 64, nextCell: 128, morph: 1 });
    const coarseInner = evaluateTerrainMaterial({ ...commonSample, cell: 128, nextCell: 256, morph: 0 });
    const dot = fineEdge.normal.reduce((sum, value, i) => sum + value * coarseInner.normal[i], 0);
    assert.ok(dot > 0.9999, `LOD normal handoff must be continuous at ${x},${z}: ${dot}`);
    assert.ok(Math.abs(fineEdge.snow - coarseInner.snow) < 1e-5, 'LOD snow classification must not reveal the ring seam');
  }
}
const steepSummit = evaluateTerrainMaterial({ x: 4200, z: -3100, height: 6100, slope: 0.43, curvature: 0, northAspect: 0.5, lee: 0.5 });
const gentleSummit = evaluateTerrainMaterial({ x: 4200, z: -3100, height: 6100, slope: 0.08, curvature: 0, northAspect: 0.5, lee: 0.5 });
assert.ok(steepSummit.snow < 0.12, `steep summit must expose geology: ${steepSummit.snow}`);
assert.ok(gentleSummit.snow > 0.82, `gentle summit must retain snow: ${gentleSummit.snow}`);

// Glacial ice must be a first-class material, not a blue tint hidden inside
// snow.  A high, shaded, concave shoulder exposes compacted ice with a cooler
// albedo and smoother response than surrounding rock.
const glacialShoulder = evaluateTerrainMaterial({
  x: -8400,
  z: 6200,
  height: 5550,
  slope: 0.28,
  curvature: 0.34,
  northAspect: 0.92,
  lee: 0.18,
  distance: 3600,
});
assert.ok(glacialShoulder.ice > 0.24, `glacial shoulder must expose ice: ${glacialShoulder.ice}`);
assert.ok(
  glacialShoulder.albedo[2] - glacialShoulder.albedo[0] > 0.14,
  `ice must retain a readable blue response: ${glacialShoulder.albedo}`,
);
assert.ok(glacialShoulder.roughness < 0.52, `compacted ice must be smoother than rock: ${glacialShoulder.roughness}`);
assert.ok(glacialShoulder.specular > 0.25, `compacted ice must carry a restrained specular lobe: ${glacialShoulder.specular}`);

// Talus must read as its own warm, loose material on mid-slope deposition
// zones, while true cliffs stay exposed as bedrock.
const talus = evaluateTerrainMaterial({
  x: 5100,
  z: 2700,
  height: 4020,
  slope: 0.27,
  curvature: 0.12,
  northAspect: 0.42,
  lee: 0.64,
  distance: 2800,
});
const cliff = evaluateTerrainMaterial({
  x: 5100,
  z: 2700,
  height: 4020,
  slope: 0.64,
  curvature: -0.10,
  northAspect: 0.42,
  lee: 0.64,
  distance: 2800,
});
assert.ok(talus.scree > 0.34, `mid-slope talus must expose scree: ${talus.scree}`);
assert.ok(cliff.scree < 0.08, `cliffs must remain bedrock instead of scree: ${cliff.scree}`);
assert.ok(talus.albedo[0] - talus.albedo[2] > 0.055, `scree must retain a warm response: ${talus.albedo}`);
assert.ok(
  Math.abs(talus.luminance - cliff.luminance) > 0.035,
  `scree and cliff rock need readable value separation: ${talus.luminance}, ${cliff.luminance}`,
);
const alpineTalus = evaluateTerrainMaterial({
  x: 5100,
  z: 2700,
  height: 5680,
  slope: 0.29,
  curvature: 0.10,
  northAspect: 0.32,
  lee: 0.35,
  distance: 3400,
});
assert.ok(alpineTalus.scree > 0.055, `high-altitude talus must remain readable in the opening vista: ${alpineTalus.scree}`);
assert.ok(alpineTalus.snow < 0.78, `wind-exposed alpine talus cannot collapse to uniform snow: ${alpineTalus.snow}`);

// Operational detail must survive the 1.5-5 km flight envelope, then fade
// before its projected frequency can shimmer at the horizon.
assert.ok(terrainDetailWeight(1500) > 0.94, 'detail must be fully present at 1.5 km');
assert.ok(terrainDetailWeight(5000) > 0.55, 'band-limited normal detail must survive at 5 km');
assert.ok(terrainDetailWeight(7800) < 0.04, 'normal detail must be gone before horizon aliasing');
assert.ok(glacialShoulder.detailWeight > 0.75, `3.6 km detail must remain strong: ${glacialShoulder.detailWeight}`);

// Material transitions must remain broad enough to avoid contour bands while
// still producing meaningful ice and scree regions.
let priorMaterial;
let maxIceJump = 0;
let maxScreeJump = 0;
for (let height = 4200; height <= 6200; height += 50) {
  const sample = evaluateTerrainMaterial({
    x: -8400,
    z: 6200,
    height,
    slope: 0.28,
    curvature: 0.34,
    northAspect: 0.92,
    lee: 0.18,
    distance: 3600,
  });
  assert.ok(sample.rock >= 0 && sample.scree >= 0 && sample.ice >= 0 && sample.snow >= 0);
  assert.ok(sample.rock + sample.scree + sample.ice + sample.snow <= 1.000001);
  if (priorMaterial) {
    maxIceJump = Math.max(maxIceJump, Math.abs(sample.ice - priorMaterial.ice));
    maxScreeJump = Math.max(maxScreeJump, Math.abs(sample.scree - priorMaterial.scree));
  }
  priorMaterial = sample;
}
assert.ok(maxIceJump < 0.16, `ice transition became a contour: ${maxIceJump}`);
assert.ok(maxScreeJump < 0.16, `scree transition became a contour: ${maxScreeJump}`);

// Low tier must omit the expensive high-tier functions from its active branch.
const lowActive = low.slice(low.indexOf('#if TERRAIN_QUALITY == 0'), low.indexOf('#else', low.indexOf('#if TERRAIN_QUALITY == 0')));
assert.doesNotMatch(lowActive, /terrainWideGradient|fbmTriplanar|atm_skyIrradiance|cloudShadowAt/);
assert.equal((lowActive.match(/terrainSample\(/g) ?? []).length, 2, 'low tier must retain exactly two terrain samples');

// The no-float-render-target path must spread CPU terrain work across moving
// frames. Committing a tile is atomic: its centre cannot move until the full
// layer is ready, and at most one array layer may be uploaded in one update.
{
  configureTerrain({ res: 17, levels: 3 });
  const renderer = { extensions: { has: () => false } };
  const terrain = new Terrain(renderer, { uniforms: {} });
  terrain.cpuSampleBudget = 64;
  try {
    for (let frame = 0; frame < 32; frame++) {
      terrain.update(new THREE.Vector3(21000 + frame * 12, 0, 6000), 3);
      assert.ok(terrain.cpuFrameStats.samples <= 64, `CPU fallback exceeded its sample budget: ${JSON.stringify(terrain.cpuFrameStats)}`);
      assert.ok(terrain.cpuFrameStats.commits <= 1, `CPU fallback committed multiple layers: ${JSON.stringify(terrain.cpuFrameStats)}`);
      assert.ok(
        terrain.cpuFrameStats.uploadBytes <= 17 * 17 * 4 * Float32Array.BYTES_PER_ELEMENT,
        `CPU fallback uploaded more than one layer: ${JSON.stringify(terrain.cpuFrameStats)}`,
      );
    }
    assert.ok(terrain.centers.some((center) => Number.isFinite(center.x)), 'amortised work must eventually commit a usable layer');
    terrain.prime(new THREE.Vector3(21000, 0, 6000));
    const beforePrime = terrain.centers.map((center) => center.clone());
    terrain.prime(new THREE.Vector3(26000, 0, 9000));
    const primeCommits = terrain.centers.reduce((count, center, index) => (
      count + (center.equals(beforePrime[index]) ? 0 : 1)
    ), 0);
    assert.ok(primeCommits <= 1, `a runtime prime must not synchronously replace every fallback layer: ${primeCommits}`);
  } finally {
    terrain.dispose();
    configureTerrain({ res: 257, levels: 10 });
  }
}

// Cold fallback construction must obey the same moving-frame budget as later
// updates. The title veil can reveal layers progressively; no special prime
// path may synchronously compute or upload all ten 257x257 layers.
{
  configureTerrain({ res: 257, levels: 10 });
  const terrain = new Terrain({ extensions: { has: () => false } }, { uniforms: {} });
  const focus = new THREE.Vector3(21000, 0, 6000);
  try {
    terrain.prime(focus);
    assert.ok(terrain.cpuFrameStats.samples <= 16384, `cold prime exceeded work budget: ${JSON.stringify(terrain.cpuFrameStats)}`);
    assert.ok(terrain.cpuFrameStats.commits <= 1, `cold prime committed multiple layers: ${JSON.stringify(terrain.cpuFrameStats)}`);
    assert.ok(terrain.centers.filter((center) => Number.isFinite(center.x)).length <= 1, 'cold prime synchronously generated the full clipmap');

    let frames = 1;
    const committed = new Set();
    while (frames < 110 && committed.size < 10) {
      terrain.update(focus, 4);
      frames++;
      assert.ok(terrain.cpuFrameStats.samples <= 16384);
      assert.ok(terrain.cpuFrameStats.commits <= 1);
      assert.ok(terrain.cpuFrameStats.uploadBytes <= 257 * 257 * 4 * Float32Array.BYTES_PER_ELEMENT);
      terrain.centers.forEach((center, level) => {
        if (Number.isFinite(center.x)) committed.add(level);
      });
    }
    assert.equal(committed.size, 10, `round-robin fallback starved levels after ${frames} frames`);
  } finally {
    terrain.dispose();
  }
}

console.log('terrain material numeric and shader contracts passed');
