import assert from 'node:assert/strict';
import * as THREE from 'three';
import { terrainHeight } from '../heightfield.js';
import {
  CloudVolume,
  CLOUD_COMPOSITE_FRAGMENT,
  CLOUD_MARCH_FRAGMENT,
} from '../CloudVolume.js';
import * as cloudRenderer from '../CloudVolume.js';
import * as cloudModel from '../clouds.glsl.js';

const { CLOUD_CONSTANTS } = cloudModel;

assert.equal(typeof cloudRenderer.cloudJitterKey, 'function', 'cloud jitter needs a numeric stability contract');
assert.equal(typeof cloudRenderer.cloudTemporalBlend, 'function', 'temporal accumulation needs a numeric confidence contract');
assert.equal(
  cloudRenderer.cloudJitterKey(70, 70, 13, 17),
  cloudRenderer.cloudJitterKey(120, 120, 13, 17),
  'ordinary forward motion must not replace the integration jitter every frame',
);
assert.notEqual(
  cloudRenderer.cloudJitterKey(70, 70, 13, 17),
  cloudRenderer.cloudJitterKey(160, 160, 13, 17),
  'jitter still decorrelates across genuinely different world cells',
);
assert.ok(
  cloudRenderer.cloudTemporalBlend(0.48, 0.50, 0.62, 0.61, 0.24) < 0.09,
  'stable history must average sub-jitter changes more strongly than the base blend',
);
assert.ok(
  cloudRenderer.cloudTemporalBlend(0.08, 0.72, 0.12, 0.84, 0.24) > 0.54,
  'real lighting or silhouette changes must escape history promptly',
);

// The opening sortie starts around 7.5 km.  The modeled weather volume must
// extend above that camera or every cloud is seen from above as a fog deck.
assert.ok(
  CLOUD_CONSTANTS.TOP >= 8400,
  `cloud ceiling must leave tower crowns above the 7.5 km opening camera: ${CLOUD_CONSTANTS.TOP}`,
);
assert.ok(
  1 / (CLOUD_CONSTANTS.DETAIL_SCALE * 2.13 ** 2) > 240,
  'the finest crown octave must stay wider than a reduced-resolution shimmer cell',
);
assert.equal(
  typeof cloudModel.evaluateCloudColumn,
  'function',
  'the production weather model must expose a numeric route-column contract',
);

{
  const columns = [];
  for (let z = -20000; z <= 20000; z += 2000) {
    for (let x = -20000; x <= 20000; x += 2000) {
      columns.push({ ...cloudModel.evaluateCloudColumn(21000 + x, 6000 + z), x: 21000 + x, z: 6000 + z });
    }
  }
  const clearFraction = columns.filter((column) => column.shaped < 0.01).length / columns.length;
  const cloudy = columns.filter((column) => column.shaped > 0.05);
  assert.ok(clearFraction > 0.38 && clearFraction < 0.74, `route needs clean macro gaps: ${clearFraction}`);
  assert.ok(cloudy.length / columns.length > 0.24, 'route still needs coherent cloud banks between gaps');

  const corridor = cloudModel.OPENING_CLOUD_CORRIDOR;
  const forward = new THREE.Vector2(-Math.sin(corridor.heading), -Math.cos(corridor.heading));
  const right = new THREE.Vector2(-forward.y, forward.x);
  const offAxis = columns.filter((column) => {
    const dx = column.x - corridor.x;
    const dz = column.z - corridor.z;
    const along = dx * forward.x + dz * forward.y;
    const lateral = Math.abs(dx * right.x + dz * right.y);
    const width = corridor.halfWidth + Math.max(along, 0) * corridor.widthSlope;
    return along < -2600 || along > corridor.fadeDistance || lateral > width + corridor.edgeFade;
  });
  const offAxisCloudy = offAxis.filter((column) => column.shaped > 0.05);
  const offAxisCloudFraction = offAxisCloudy.length / offAxis.length;
  const offAxisCrownFraction = offAxis.filter((column) => column.top > 7700).length / offAxis.length;
  const crownsWithinBanks = offAxisCloudy.filter((column) => column.top > 7700).length / offAxisCloudy.length;
  assert.ok(
    offAxisCloudFraction >= 0.30 && offAxisCloudFraction <= 0.40,
    `weather away from the opening corridor must retain 30-40% banks: ${offAxisCloudFraction}`,
  );
  assert.ok(offAxisCrownFraction > 0.06, `off-axis valleys need visible hero crowns: ${offAxisCrownFraction}`);
  assert.ok(crownsWithinBanks > 0.2, `towers must remain a meaningful part of off-axis banks: ${crownsWithinBanks}`);
}

{
  const start = new THREE.Vector3(21000, terrainHeight(21000, 6000) + 1500, 6000);
  const heading = Math.PI * 0.62;
  const forward = new THREE.Vector2(-Math.sin(heading), -Math.cos(heading));
  const right = new THREE.Vector2(-forward.y, forward.x);
  const launch = cloudModel.evaluateCloudColumn(start.x, start.z);
  assert.ok(
    launch.shaped < 0.01 || launch.top < start.y,
    `opening camera must start outside cloud density: y=${start.y}, column=${JSON.stringify(launch)}`,
  );

  const near = [];
  for (let distance = 0; distance <= 6500; distance += 1000) {
    for (const lateral of [-3000, -1500, 0, 1500, 3000]) {
      near.push(cloudModel.evaluateCloudColumn(
        start.x + forward.x * distance + right.x * lateral,
        start.z + forward.y * distance + right.y * lateral,
      ));
    }
  }
  assert.ok(
    near.every((column) => column.shaped < 0.08),
    `the first 6.5 km launch corridor must reveal terrain instead of a cloud wall: ${Math.max(...near.map((c) => c.shaped))}`,
  );

  const far = [];
  for (let distance = 9000; distance <= 18000; distance += 1500) {
    for (const lateral of [-7000, -3500, 0, 3500, 7000]) {
      far.push(cloudModel.evaluateCloudColumn(
        start.x + forward.x * distance + right.x * lateral,
        start.z + forward.y * distance + right.y * lateral,
      ));
    }
  }
  assert.ok(far.some((column) => column.shaped > 0.35), 'mid/far view must retain modeled cloud banks');
  assert.ok(far.some((column) => column.shaped < 0.01), 'mid/far banks must remain separated by clean gaps');
}

{
  const startX = 21000;
  const startZ = 6000;
  const cameraY = terrainHeight(startX, startZ) + 1500;
  const heading = Math.PI * 0.62;
  const forward = new THREE.Vector2(-Math.sin(heading), -Math.cos(heading));
  const right = new THREE.Vector2(-forward.y, forward.x);
  const projected = [];
  for (let degrees = -30; degrees <= 30; degrees += 2) {
    const angle = THREE.MathUtils.degToRad(degrees);
    const dx = forward.x * Math.cos(angle) + right.x * Math.sin(angle);
    const dz = forward.y * Math.cos(angle) + right.y * Math.sin(angle);
    let optical = 0;
    for (let distance = 4000; distance <= 26000; distance += 1000) {
      const column = cloudModel.evaluateCloudColumn(startX + dx * distance, startZ + dz * distance);
      const cameraIntersection = column.top > cameraY
        ? Math.min(1, (column.top - cameraY) / 900)
        : 0;
      optical += column.shaped * cameraIntersection;
    }
    projected.push(1 - Math.exp(-optical * 0.55));
  }

  const cloudy = projected.map((opacity) => opacity > 0.5);
  const cloudyFraction = cloudy.filter(Boolean).length / cloudy.length;
  assert.ok(
    cloudyFraction >= 0.20 && cloudyFraction <= 0.45,
    `opening frustum should be framed by localized banks, not a curtain: ${cloudyFraction}`,
  );

  let longestCloudRun = 0;
  let currentCloudRun = 0;
  let cleanGapGroups = 0;
  let currentCleanRun = 0;
  for (let i = 0; i <= projected.length; i++) {
    if (i < projected.length && cloudy[i]) {
      currentCloudRun++;
    } else {
      longestCloudRun = Math.max(longestCloudRun, currentCloudRun);
      currentCloudRun = 0;
    }
    if (i < projected.length && projected[i] < 0.22) {
      currentCleanRun++;
    } else {
      if (currentCleanRun >= 2) cleanGapGroups++;
      currentCleanRun = 0;
    }
  }
  assert.ok(
    longestCloudRun / projected.length <= 0.35,
    `no cloud bank may span more than 35% of the horizontal view: ${longestCloudRun}/${projected.length}`,
  );
  assert.ok(cleanGapGroups >= 3, `opening frustum needs at least three sizable clean gap groups: ${cleanGapGroups}`);
}

function environment() {
  return { uniforms: {
    uCloudTime: { value: 1 },
    uCloudBase: { value: 4600 },
    uCloudTop: { value: 7200 },
    uCloudCoverage: { value: 0.00055 },
    uCloudDensity: { value: 0.0032 },
    uCloudWind: { value: new THREE.Vector2(11, 4.5) },
    uSunDir: { value: new THREE.Vector3(0.4, 0.8, 0.2).normalize() },
    uSunColor: { value: new THREE.Color(1, 0.94, 0.84) },
    uSunIntensity: { value: 1.5 },
    uZenithColor: { value: new THREE.Color(0.03, 0.09, 0.3) },
    uHorizonColor: { value: new THREE.Color(0.56, 0.68, 0.85) },
  } };
}

function camera() {
  const value = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 750000);
  value.position.set(100, 7500, 200);
  value.updateMatrixWorld();
  return value;
}

function renderer({ halfFloat = true, throwOnRender = 0 } = {}) {
  const originalTarget = { name: 'composer target' };
  return {
    originalTarget,
    target: originalTarget,
    autoClear: false,
    xr: { enabled: true },
    clearColor: new THREE.Color(0.2, 0.3, 0.4),
    clearAlpha: 0.65,
    renders: 0,
    extensions: { has: (name) => halfFloat && name === 'EXT_color_buffer_float' },
    getRenderTarget() { return this.target; },
    getClearColor(out) { return out.copy(this.clearColor); },
    getClearAlpha() { return this.clearAlpha; },
    setRenderTarget(value) { this.target = value; },
    setClearColor(value, alpha) { this.clearColor.copy(value); this.clearAlpha = alpha; },
    clear() {},
    render() {
      this.renders++;
      if (this.renders === throwOnRender) throw new Error('synthetic support-pass failure');
    },
  };
}

{
  const env = environment();
  const clouds = new CloudVolume(env, camera());
  clouds._syncEnvironment(0);
  assert.ok(
    env.uniforms.uCloudTop.value >= CLOUD_CONSTANTS.TOP,
    `runtime environment must publish the tested route ceiling: ${env.uniforms.uCloudTop.value}`,
  );
  assert.ok(
    env.uniforms.uCloudDensity.value >= 0.0012 && env.uniforms.uCloudDensity.value <= 0.0018,
    `broad banks must remain translucent while hero cores stay dense: ${env.uniforms.uCloudDensity.value}`,
  );
  clouds.dispose();
}

{
  assert.doesNotMatch(
    CLOUD_MARCH_FRAGMENT,
    /!isActiveSample\s*&&\s*uHistoryValid/,
    'inactive checker cells must never fall through to the full march',
  );
  assert.doesNotMatch(
    CLOUD_MARCH_FRAGMENT,
    /texture\(uHistoryCloud,\s*vUv\)/,
    'rejected history must never reuse stale same-screen radiance',
  );
  assert.match(
    CLOUD_MARCH_FRAGMENT,
    /firstCloudDistance/,
    'reprojection must carry a measured cloud distance',
  );
  assert.match(
    CLOUD_MARCH_FRAGMENT,
    /metaOutput\s*=\s*vec4\([^;]+,\s*0\.0\);/s,
    'unseeded inactive cells must remain invalid',
  );
  assert.match(
    CLOUD_COMPOSITE_FRAGMENT,
    /nearestScore\s*<\s*1e8\s*\?\s*nearestValidCloud\s*:\s*vec4\(0\.0\)/,
    'all-rejected bilateral taps must conservatively composite no cloud',
  );
  assert.match(
    CLOUD_COMPOSITE_FRAGMENT,
    /nearestValidCloud/,
    'upscale must search depth-compatible valid neighbors before leaving a pinhole',
  );
  assert.match(
    CLOUD_MARCH_FRAGMENT,
    /reconstructHistoryNeighbor/,
    'inactive rejected cells must use validated spatial history rather than black pinholes',
  );
  assert.match(
    CLOUD_MARCH_FRAGMENT,
    /detailAtDistance/,
    'erosion detail must be band-limited by ray distance and march footprint',
  );
}

{
  const clouds = new CloudVolume(environment(), camera());
  clouds.setSize(1920, 1080);
  let disposedTargets = 0;
  for (const target of clouds._temporalTargets) target.addEventListener('dispose', () => disposedTargets++);
  clouds.initialize(renderer({ halfFloat: true }));
  assert.equal(disposedTargets, 2, 'HDR initialization must release bootstrap targets');
  assert.equal(clouds._temporalTargets[0].textures[0].type, THREE.HalfFloatType);
  assert.equal(clouds._marchUniforms.uRadianceRange.value, 1);
  clouds.setQuality({ name: 'high' });
  assert.deepEqual([clouds._temporalTargets[0].width, clouds._temporalTargets[0].height], [768, 432]);
  assert.equal(clouds._marchUniforms.uSteps.value, 38);
  assert.ok(clouds._marchUniforms.uTemporalAlpha.value <= 0.26, 'high tier needs stable active-sample accumulation');
  assert.equal(clouds.uniforms.get('uCloudStrength').value, 1);
  clouds.setQuality({ name: 'low' });
  assert.deepEqual(
    [clouds._temporalTargets[0].width, clouds._temporalTargets[0].height],
    [576, 324],
    'low tier needs enough spatial support to avoid a blotchy one-in-nine veil',
  );
  assert.equal(clouds._marchUniforms.uCheckerPeriod.value, 2, 'low tier must refresh every cell within four frames');
  assert.ok(
    clouds.uniforms.get('uCloudStrength').value <= 0.45,
    'reduced-resolution low clouds must stay translucent instead of becoming a noisy horizon wall',
  );
  clouds.setQuality({ name: 'phone' });
  assert.ok(clouds.uniforms.get('uCloudStrength').value <= 0.25);
  clouds.dispose();
}

{
  const clouds = new CloudVolume(environment(), camera());
  const fakeRenderer = renderer({ halfFloat: true });
  clouds.initialize(fakeRenderer);
  clouds.setDepthTexture(new THREE.DepthTexture());
  clouds.setSize(1920, 1080);
  clouds.setQuality({ name: 'high' });
  assert.ok(clouds.uniforms.has('uCloudWarmup'), 'compositor needs an early-history visibility ramp');
  clouds.update(fakeRenderer, null, 1 / 60);
  const firstFrame = clouds.uniforms.get('uCloudWarmup').value;
  assert.ok(firstFrame > 0 && firstFrame < 0.25, `first checker frame must remain subdued: ${firstFrame}`);
  for (let frame = 1; frame < 7; frame++) clouds.update(fakeRenderer, null, 1 / 60);
  assert.equal(clouds.uniforms.get('uCloudWarmup').value, 1, 'clouds must reach full visibility after history fills');
  clouds.dispose();
}

{
  const clouds = new CloudVolume(environment(), camera());
  clouds.initialize(renderer({ halfFloat: false }));
  assert.equal(clouds._temporalTargets[0].textures[0].type, THREE.UnsignedByteType);
  assert.ok(clouds._marchUniforms.uRadianceRange.value > 1, 'normalized fallback must encode HDR range');
  clouds.dispose();
}

{
  const clouds = new CloudVolume(environment(), camera());
  clouds.setDepthTexture(new THREE.DepthTexture());
  clouds.setSize(100, 50);
  const failingRenderer = renderer({ throwOnRender: 2 });
  assert.throws(() => clouds.update(failingRenderer, null, 0.016), /synthetic support-pass failure/);
  assert.equal(failingRenderer.target, failingRenderer.originalTarget, 'render target must restore after failure');
  assert.equal(failingRenderer.autoClear, false);
  assert.equal(failingRenderer.xr.enabled, true);
  assert.ok(failingRenderer.clearColor.equals(new THREE.Color(0.2, 0.3, 0.4)));
  assert.equal(failingRenderer.clearAlpha, 0.65);
  clouds.dispose();
}

console.log('cloud R6 projected-frustum and temporal contracts passed');
