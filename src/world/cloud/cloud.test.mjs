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

/** Mirrors SEARCH_GROWTH and REFINE_RATIO in integrateCloud. */
const SEARCH_GROWTH = 1.9;
const REFINE_RATIO = 0.22;

/**
 * How far a tier's *search* pass reaches from a horizon ray (tNear = 0).
 *
 * This is the worst case that matters for coverage: a ray crossing entirely
 * clear air spends its whole budget on search strides, and if that cannot cross
 * the tier's own march range the deck stops partway out and ends on an arc.
 * A ray that finds cloud spends the remainder refining and terminates on
 * transmittance instead, so it needs less reach, not more.
 */
function searchReach(steps, stepMin, stepAngle, stepMax) {
  let t = 0;
  for (let i = 0; i < steps; i++) {
    t += Math.min(Math.max(t * stepAngle * SEARCH_GROWTH, stepMin), stepMax);
  }
  return t;
}

/** The sampling stride at a given distance — what erosion detail is judged against. */
function refineStride(t, stepMin, stepAngle, stepMax) {
  return Math.min(Math.max(t * stepAngle * SEARCH_GROWTH, stepMin), stepMax) * REFINE_RATIO;
}

function sampleOpeningFrustum(start, heading, rayCount, nearDistance, farDistance) {
  const forward = new THREE.Vector2(-Math.sin(heading), -Math.cos(heading));
  const right = new THREE.Vector2(-forward.y, forward.x);
  const rays = [];
  const rayAngles = [];
  for (let rayIndex = 0; rayIndex < rayCount; rayIndex++) {
    const angleDegrees = -30 + (60 * rayIndex) / (rayCount - 1);
    const angle = THREE.MathUtils.degToRad(angleDegrees);
    const dx = forward.x * Math.cos(angle) + right.x * Math.sin(angle);
    const dz = forward.y * Math.cos(angle) + right.y * Math.sin(angle);
    const columns = [];
    for (let distance = nearDistance; distance <= farDistance; distance += 500) {
      columns.push(cloudModel.evaluateCloudColumn(start.x + dx * distance, start.z + dz * distance));
    }
    rays.push(columns);
    rayAngles.push(angleDegrees);
  }

  const cloudy = rays.map((ray) => ray.some((column) => column.shaped > 0.20));
  let longestRun = 0;
  let currentRun = 0;
  for (const isCloudy of cloudy) {
    currentRun = isCloudy ? currentRun + 1 : 0;
    longestRun = Math.max(longestRun, currentRun);
  }

  const centerIndex = Math.floor(rayCount / 2);
  return {
    center: rays[centerIndex],
    centerWindow: rays.filter((_, index) => Math.abs(rayAngles[index]) <= 10).flat(),
    left: rays.slice(0, centerIndex).flat(),
    right: rays.slice(centerIndex + 1).flat(),
    projectedRayCoverage: cloudy.filter(Boolean).length / rayCount,
    longestRun: longestRun / rayCount,
  };
}

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
  const start = { x: 21000, z: 6000 };
  const centerOpening = sampleOpeningFrustum(start, Math.PI * 0.62, 31, 2500, 3000);
  assert.ok(centerOpening.centerWindow.every((c) => c.shaped < 0.05));

  const samples = sampleOpeningFrustum(start, Math.PI * 0.62, 31, 3000, 8000);
  assert.ok(samples.center.every((c) => c.shaped < 0.05));
  assert.ok(samples.left.some((c) => c.shaped > 0.20));
  assert.ok(samples.right.some((c) => c.shaped > 0.20));
  assert.ok(samples.projectedRayCoverage >= 0.15 && samples.projectedRayCoverage <= 0.35);
  assert.ok(samples.longestRun <= 0.35);
}

assert.equal(
  typeof cloudModel.openingCloudCorridorWidth,
  'function',
  'off-axis classification must consume the production delayed-width boundary',
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
    const width = cloudModel.openingCloudCorridorWidth(along);
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
  /**
   * Extinction is asserted through the opacity it produces, not as a number.
   *
   * The previous band (0.0012-0.0018) is what allowed the deck to disappear:
   * measured live by rendering the frame with and without the cloud composite,
   * clouds changed 0.03% of pixels at cruise and needed a 20x gain before they
   * covered the frame. A ceiling chosen to prevent an opaque wall had instead
   * made the clouds invisible, and nothing in the suite could tell, because
   * nothing tested what the number *does*.
   *
   * So: a hero core has to actually be a cloud, and a bank shoulder has to
   * actually transmit. Those are the two failure modes, and both are alpha.
   */
  const extinction = env.uniforms.uCloudDensity.value;
  const alphaOver = (metres, shaped) => 1 - Math.exp(-extinction * shaped * metres);
  assert.ok(
    alphaOver(1200, 0.95) >= 0.9,
    `a hero core must read as solid cloud, not haze: alpha ${alphaOver(1200, 0.95).toFixed(3)}`,
  );
  assert.ok(
    alphaOver(350, 0.30) <= 0.75,
    `a bank shoulder must still transmit terrain and sky: alpha ${alphaOver(350, 0.3).toFixed(3)}`,
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
  // Erosion is band-limited by the stride actually being taken, which is the
  // only honest measure of what frequency a sample can carry. It is no longer
  // flattened into one scalar here — see the per-octave Nyquist block below.
  // The near-field stride must never be derived from the march span. That is
  // the defect that erased the cloud you were flying through: along a
  // near-horizontal ray inside the deck the span saturates at uMarchRange, and
  // a span/uSteps floor then made the stride 197 m from the camera outward, so
  // nothing within two hundred metres of the aircraft was ever sampled.
  assert.doesNotMatch(
    CLOUD_MARCH_FRAGMENT,
    /span\s*\/\s*float\(uSteps\)/,
    'the near-field stride must not be derived from the total march span',
  );
  assert.match(
    CLOUD_MARCH_FRAGMENT,
    /float search = clamp\(t \* uStepAngle \* SEARCH_GROWTH, uStepMin, uStepMax\)/,
    'the search stride must be distance-proportional and floored on uStepMin alone',
  );
  assert.match(
    CLOUD_MARCH_FRAGMENT,
    /float stepLength = search \* REFINE_RATIO/,
    'the sampling stride must be a fixed fraction of the search stride',
  );
  // Two-level marching: hunt with cheap density, sample with the real thing.
  assert.match(
    CLOUD_MARCH_FRAGMENT,
    /if \(!refining\) \{[\s\S]{0,400}cloudDensityLod\(p, 0\.0\)/,
    'the search pass must use low-frequency density, not the eroded field',
  );
  assert.match(
    CLOUD_MARCH_FRAGMENT,
    /t = max\(t - search \* BACKUP, tNear\)/,
    'a hit must rewind so the lit rim is not stepped over',
  );
  assert.match(
    CLOUD_MARCH_FRAGMENT,
    /if \(clearRun > CLEAR_RUN_EXIT\) refining = false/,
    'the march must return to the wide stride once past a cloud',
  );
}

// The rewind must be shorter than the clear run that ends refinement, or the
// march drops back to searching before it ever reaches the boundary it found,
// and the cloud is detected and abandoned on every approach.
{
  const backup = Number(/const float BACKUP = ([\d.]+)/.exec(CLOUD_MARCH_FRAGMENT)[1]);
  const clearRunExit = Number(/const int CLEAR_RUN_EXIT = (\d+)/.exec(CLOUD_MARCH_FRAGMENT)[1]);
  const refineStepsToRegainRewind = backup / REFINE_RATIO;
  assert.ok(
    clearRunExit > refineStepsToRegainRewind,
    `clear run ${clearRunExit} must exceed the ${refineStepsToRegainRewind.toFixed(1)} refine steps the rewind costs`,
  );
}

// Every erosion octave must be gone before the sampling stride can alias it.
// This is the contract that stops the cloud flicker, so it is checked against
// the octave frequencies the shader actually builds rather than against
// hand-copied numbers.
{
  const { CLOUD_NYQUIST } = cloudModel;
  const expected = (multiplier, octaves) =>
    1 / (CLOUD_CONSTANTS.DETAIL_SCALE * multiplier * 2.13 ** (octaves - 1)) / 2;
  assert.ok(Math.abs(CLOUD_NYQUIST.WISPY - expected(1.15, 2)) < 1e-6);
  assert.ok(Math.abs(CLOUD_NYQUIST.CROWN - expected(1.78, 3)) < 1e-6);
  assert.ok(
    CLOUD_NYQUIST.CROWN < CLOUD_NYQUIST.WISPY && CLOUD_NYQUIST.WISPY < CLOUD_NYQUIST.BROAD,
    'finer octaves must carry tighter stride limits',
  );

  // The shader must gate each octave on its own limit, and the fade must be
  // complete by it — a smoothstep that only starts at the Nyquist stride is
  // still aliasing at the stride where it matters.
  const source = cloudModel.CLOUD_GLSL;
  for (const [name, limit] of [['WISPY', CLOUD_NYQUIST.WISPY], ['CROWN', CLOUD_NYQUIST.CROWN]]) {
    const level = name.toLowerCase() + 'Level';
    const pattern = new RegExp(`float ${level} = detailLevel \\* \\(1\\.0 - smoothstep\\(([\\d.]+), ([\\d.]+), stride\\)\\)`);
    const found = pattern.exec(source);
    assert.ok(found, `${name} octave must be faded against the sampling stride`);
    assert.ok(
      Number(found[2]) <= limit + 0.05,
      `${name} fade completes at ${found[2]} m but aliases beyond ${limit.toFixed(0)} m`,
    );
    assert.ok(Number(found[1]) < Number(found[2]), `${name} fade must ramp, not switch`);
  }

  // And the march must hand the stride over rather than pre-flattening it into
  // one scalar, which cannot band-limit three octaves at once.
  assert.match(
    CLOUD_MARCH_FRAGMENT,
    /cloudDensityStride\(p, uDetailLevel, stepLength\)/,
    'the march must pass its stride to the density function',
  );
}

// At every tier, the stride the march actually uses where cloud is first met
// must be fine enough to carry the crown octave near the aircraft. This is the
// "can you see the cloud you are flying through" contract, in numbers.
{
  const { CLOUD_NYQUIST } = cloudModel;
  const budget = new CloudVolume(environment(), camera());
  for (const name of ['medium', 'high']) {
    budget.setQuality({ name });
    const u = budget._marchUniforms;
    const near = refineStride(0, u.uStepMin.value, u.uStepAngle.value, u.uStepMax.value);
    assert.ok(
      near <= CLOUD_NYQUIST.CROWN,
      `${name} samples cloud at the camera every ${near.toFixed(0)} m, past the ${CLOUD_NYQUIST.CROWN.toFixed(0)} m crown limit`,
    );
  }
  budget.dispose();
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
  assert.deepEqual([clouds._temporalTargets[0].width, clouds._temporalTargets[0].height], [960, 540]);
  assert.equal(clouds._marchUniforms.uSteps.value, 112);
  assert.equal(
    clouds._marchUniforms.uCheckerPeriod.value,
    1,
    'high tier must march every pixel every frame; the checkerboard was the stipple',
  );
  assert.equal(clouds.uniforms.get('uCloudStrength').value, 1);
  clouds.setQuality({ name: 'low' });
  assert.deepEqual(
    [clouds._temporalTargets[0].width, clouds._temporalTargets[0].height],
    [615, 346],
    'low tier needs enough spatial support to avoid a blotchy one-in-nine veil',
  );
  assert.equal(clouds._marchUniforms.uCheckerPeriod.value, 1, 'low tier can afford every pixel too now');
  clouds.setQuality({ name: 'phone' });
  assert.ok(clouds.uniforms.get('uCloudStrength').value <= 0.45);
  clouds.dispose();

  // The march budget must be ordered by tier in every dimension that costs
  // time, and each tier's stride schedule must be able to cross its own march
  // range within its own step count — otherwise the deck simply stops partway
  // out and ends on an arc.
  {
    const budget = new CloudVolume(environment(), camera());
    let previous = null;
    for (const name of ['phone', 'low', 'medium', 'high']) {
      budget.setQuality({ name });
      const u = budget._marchUniforms;
      const reach = searchReach(
        u.uSteps.value,
        u.uStepMin.value,
        u.uStepAngle.value,
        u.uStepMax.value,
      );
      assert.ok(
        reach >= u.uMarchRange.value,
        `${name} steps reach only ${Math.round(reach)} m of its ${u.uMarchRange.value} m march range`,
      );
      const current = {
        steps: u.uSteps.value,
        light: u.uLightSteps.value,
        march: u.uMarchRange.value,
        scale: budget._resolutionScale,
      };
      if (previous) {
        for (const key of Object.keys(current)) {
          assert.ok(current[key] >= previous[key], `${name} ${key} regressed below the tier below it`);
        }
      }
      previous = current;
    }
    budget.dispose();
  }
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
  assert.ok(firstFrame > 0 && firstFrame < 0.25, `the deck must not step into view: ${firstFrame}`);
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

{
  const clouds = new CloudVolume(environment(), camera());
  clouds._historyValid = true;
  clouds._historyFrames = 5;
  clouds.uniforms.get('uCloudWarmup').value = 0.75;
  const frameBeforeReset = clouds._frame;
  const writeIndexBeforeReset = clouds._writeIndex;

  clouds.resetHistory('camera-cut');

  assert.equal(clouds._historyValid, false);
  assert.equal(clouds._historyFrames, 0);
  assert.equal(clouds.uniforms.get('uCloudWarmup').value, 0);
  assert.equal(clouds._frame, frameBeforeReset, 'history reset must not alter checker scheduling');
  assert.equal(clouds._writeIndex, writeIndexBeforeReset, 'history reset must not replace owned targets');
  clouds.dispose();
}

{
  const clouds = new CloudVolume(environment(), camera());
  clouds.setSize(1920, 1080);
  clouds.initialize(renderer({ halfFloat: true }));
  clouds.setQuality({ name: 'high' });

  const report = clouds.getResourceReport();
  assert.equal(report.backend, 'current');
  assert.equal(report.renderTargetCount, 3);
  assert.equal(report.textureCount, 5);
  assert.deepEqual(report.resources, [
    {
      name: 'temporal-history',
      width: 960,
      height: 540,
      channels: 4,
      bytesPerChannel: 2,
      layers: 1,
      samples: 1,
      attachments: 2,
      history: 2,
      bytes: 16588800,
    },
    {
      name: 'cloud-shadow',
      width: 256,
      height: 256,
      channels: 4,
      bytesPerChannel: 1,
      layers: 1,
      samples: 1,
      attachments: 1,
      history: 1,
      bytes: 262144,
    },
  ]);
  assert.equal(report.totalBytes, 16850944);
  // The march resolution rose from 0.40 to 0.50 of the drawing buffer, which is
  // what the history targets cost. Budget, not an exact figure, because the
  // scale is a tuning knob: 24 MiB at 1080p high leaves the rest of the
  // renderer the room it needs on a 6 GB mobile part.
  assert.ok(report.totalBytes <= 24 * 1024 * 1024, `high cloud memory: ${report.totalBytes}`);

  clouds.setQuality({ name: 'phone' });
  const phoneReport = clouds.getResourceReport();
  assert.ok(
    phoneReport.totalBytes <= 8 * 1024 * 1024,
    `phone cloud memory: ${phoneReport.totalBytes}`,
  );
  clouds.dispose();
}

// The sun march scales with transmittance, and its reach does not.
//
// Measured on the reference GPU at the worst-case pose (low in a valley, where
// the march crosses the deck edge-on): each sun step was about nine per cent of
// the entire frame, and making the budget follow transmittance took that pose
// from 17.9 ms to 10.4 ms — a 42% frame saving, which is what moved high tier
// from failing the 30 fps floor on a 2060-class GPU to clearing it.
//
// The reach compensation is the half that is easy to delete by accident. A
// shorter march reports less cloud between the sample and the sun, so without
// it the saving arrives as a deck that lights up from the inside. Measured
// against a full-budget build with the cloud clock pinned, the mean signed
// difference is -0.03 of 255 — no bias — where dropping the compensation would
// show up as a systematic positive.
{
  const source = CLOUD_MARCH_FRAGMENT;
  assert.match(
    source,
    /int lightBudget = max\(2, int\(ceil\(float\(uLightSteps\) \* \(0\.35 \+ 0\.65 \* transmittance\)\)\)\)/,
    'the sun march budget must follow transmittance, with a floor that keeps a gradient',
  );
  assert.match(
    source,
    /float reach = \(pow\(1\.45, float\(budget\)\) - 1\.0\) \/ 0\.45/,
    'a reduced budget must still cross the slab, or the deck brightens from within',
  );

  // The compensated first step times the geometric sum is the same distance at
  // every budget — that invariant is the whole point of the formula.
  const covered = (budget) => {
    const reach = (Math.pow(1.45, budget) - 1) / 0.45;
    const first = 0.13 * (12.02 / reach);
    return first * reach;
  };
  const full = covered(5);
  for (const budget of [2, 3, 4, 5, 6]) {
    assert.ok(
      Math.abs(covered(budget) - full) < 1e-9,
      `budget ${budget} must cover the same span as the full march`,
    );
  }
}

console.log('cloud R6 projected-frustum and temporal contracts passed');

// The shadow march must sample (x, height, z).
//
// vec3(vec2, float) builds (x, z, y), which put the marching height into the z
// slot and the world z into the height slot — so cloudDensityLod tested a
// coordinate that ranges over the whole world against a 3.4 km slab, rejected
// nearly every sample, and returned a shadow map that was uniformly full sun.
// It went unnoticed while the volumetric march did its own shading; once the
// billboards took over, this map became the only cloud shadow in the scene.
{
  const shadow = cloudRenderer.CLOUD_SHADOW_FRAGMENT;
  assert.ok(shadow, 'the shadow pass must be inspectable');
  assert.doesNotMatch(
    shadow,
    /cloudDensityLod\(vec3\([a-zA-Z]+ \+ [a-zA-Z]+, y\)/,
    'the shadow march must not build its sample with vec3(vec2, float)',
  );
  assert.match(
    shadow,
    /cloudDensityLod\(vec3\(sampleXz\.x, y, sampleXz\.y\)/,
    'the shadow march must sample (x, height, z)',
  );
}

console.log('cloud shadow orientation contract passed');
