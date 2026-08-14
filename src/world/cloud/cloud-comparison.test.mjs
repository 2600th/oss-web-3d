import assert from 'node:assert/strict';
import test from 'node:test';
import { Data3DTexture, PerspectiveCamera, RedFormat, Texture, Vector3 } from 'three';
import { DEFAULT_STBN_URL } from '@takram/three-geospatial';

import {
  COMPARISON_SCENARIO_NAMES,
  CloudComparisonHarness,
  assessTakramReferenceAssetEligibility,
  assessVisualEligibility,
  applyContextEvent,
  applyComparisonEvent,
  createScenario,
  createCloudDiagnosticMetadata,
  deriveTakramProfileContext,
  describeOfficialTakramCloudAssets,
  describeCloudLifecycleResources,
  loadOfficialStbnTexture,
  installDedicatedCloudPass,
  installConsoleIssueCapture,
  parseComparisonQuery,
  publishComparisonResult,
  renderComparisonFrame,
  resetScenarioClock,
  sampleScenarioCameraPose,
  shouldBypassTerrainDepth,
} from './CloudComparisonHarness.js';
import {
  assessRawCloudDiagnosticEligibility,
  measureCloudBufferPixels,
} from './CloudBufferDiagnostics.js';
import { CloudLifecycleAuditor } from './CloudBenchmark.js';
import { getTakramCloudProfile, validateTakramProfileScenario } from './TakramCloudProfiles.js';
import { findPostSites } from '../../game/Mission.js';
import { terrainHeight } from '../heightfield.js';

const EXPECTED_SCENARIOS = [
  'opening-3.5',
  'opening-10',
  'opening-25',
  'side-bank',
  'fast-motion-stop',
  'chase-to-recon-cut',
  'objective-8km',
  'objective-3km',
  'objective-framed',
  'sun-front',
  'sun-back',
  'resize',
  'high-to-phone',
  'context-loss',
  'context-restore',
  'reference-sky',
  'himalayan-opening',
  'himalayan-side-bank',
  'cloud-buffer',
];

function stripBackend(value) {
  if (Array.isArray(value)) return value.map(stripBackend);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => key !== 'backend')
      .map(([key, item]) => [key, stripBackend(item)]));
  }
  return value;
}

function assertDeeplyFrozen(value) {
  if (value == null || typeof value !== 'object') return;
  assert.equal(Object.isFrozen(value), true);
  for (const item of Object.values(value)) assertDeeplyFrozen(item);
}

test('scenario catalog covers the complete comparison matrix in stable order', () => {
  assert.deepEqual(COMPARISON_SCENARIO_NAMES, EXPECTED_SCENARIOS);
});

test('current and Takram receive identical immutable scenario inputs', () => {
  for (const name of EXPECTED_SCENARIOS) {
    const current = createScenario(name, 'current');
    const takram = createScenario(name, 'takram');

    assert.deepEqual(stripBackend(current), stripBackend(takram), name);
    assert.equal(current.warmupFrames, 120, name);
    assert.equal(current.events[0].resetHistory, 'scenario-transition', name);
    assertDeeplyFrozen(current);
    assertDeeplyFrozen(takram);
  }
});

test('scenario creation rejects unknown scenarios and backends', () => {
  assert.throws(() => createScenario('unknown', 'current'), /Unknown cloud comparison scenario: unknown/);
  assert.throws(() => createScenario('opening-3.5', 'other'), /Unknown cloud comparison backend: other/);
});

test('comparison query accepts only the published backend, quality, scenario, profile, and view values', () => {
  assert.deepEqual(
    parseComparisonQuery('?backend=takram&quality=high&scenario=opening-3.5'),
    {
      backend: 'takram', quality: 'high', scenario: 'opening-3.5',
      profile: 'takram-reference', view: 'composite',
    },
  );
  assert.deepEqual(
    parseComparisonQuery('?backend=takram&profile=takram-himalayan&view=cloud-alpha&scenario=cloud-buffer'),
    {
      backend: 'takram', quality: 'high', scenario: 'cloud-buffer',
      profile: 'takram-himalayan', view: 'cloud-alpha',
    },
  );
  assert.deepEqual(
    parseComparisonQuery('?backend=current'),
    {
      backend: 'current', quality: 'high', scenario: 'opening-3.5',
      profile: null, view: 'composite',
    },
  );
  assert.throws(() => parseComparisonQuery('?backend=other'), /Unknown backend query value: other/);
  assert.throws(() => parseComparisonQuery('?quality=ultra'), /Unknown quality query value: ultra/);
  assert.throws(() => parseComparisonQuery('?scenario=other'), /Unknown scenario query value: other/);
  assert.throws(() => parseComparisonQuery('?backend=takram&profile=storm'), /Unknown profile query value: storm/);
  assert.throws(() => parseComparisonQuery('?backend=takram&view=cloud-depth'), /Unknown view query value: cloud-depth/);
  assert.throws(() => parseComparisonQuery('?backend=current&profile=takram-reference'), /only valid for Takram/);
  assert.throws(() => parseComparisonQuery('?backend=current&view=cloud-alpha'), /only valid for Takram/);
  assert.throws(() => parseComparisonQuery('?backend=current&extra=1'), /Unknown query parameter: extra/);
});

test('raw diagnostic scenarios expose deterministic sky-only and Himalayan capture contracts', () => {
  const referenceSky = createScenario('reference-sky', 'takram');
  assert.equal(referenceSky.captureKind, 'sky-only-reference');
  assert.equal(referenceSky.inSceneMissionCapture, false);
  assert.equal(referenceSky.terrainDepthPolicy, 'raw-diagnostic-bypass-only');
  assert.equal(referenceSky.depthSetup.owner, 'comparison-harness');

  const cloudBuffer = createScenario('cloud-buffer', 'takram');
  assert.equal(cloudBuffer.captureKind, 'raw-cloud-buffer-diagnostic');
  assert.equal(cloudBuffer.terrainDepthPolicy, 'preserve-terrain-depth');

  const site = findPostSites({ x: 0, y: 0, z: 0, clone() { return this; } }, 1)[0];
  const objectiveAim = [site.position.x, site.position.y + 12, site.position.z];
  for (const name of ['himalayan-opening', 'himalayan-side-bank']) {
    const scenario = createScenario(name, 'takram');
    const context = deriveTakramProfileContext(scenario, objectiveAim, terrainHeight);
    const profile = getTakramCloudProfile('takram-himalayan', context);
    const validation = validateTakramProfileScenario(profile, context);
    assert.equal(scenario.profileRequirement, 'takram-himalayan');
    const minimumTerrainSamples = name === 'himalayan-side-bank' ? 151 * 9 : 9;
    assert.ok(context.sampleCount >= minimumTerrainSamples, `${name} terrain sample coverage`);
    assert.equal(validation.eligible, true, name);
    assert.ok(validation.nearestBoundaryDistance >= 500, name);
  }
});

test('reference-sky bypasses terrain depth only for its raw Takram diagnostic views', () => {
  const referenceSky = createScenario('reference-sky', 'takram');
  const cloudBuffer = createScenario('cloud-buffer', 'takram');
  assert.equal(shouldBypassTerrainDepth({
    backendName: 'takram', view: 'cloud-alpha', scenario: referenceSky,
  }), true);
  assert.equal(shouldBypassTerrainDepth({
    backendName: 'takram', view: 'cloud-color', scenario: referenceSky,
  }), true);
  assert.equal(shouldBypassTerrainDepth({
    backendName: 'takram', view: 'composite', scenario: referenceSky,
  }), false);
  assert.equal(shouldBypassTerrainDepth({
    backendName: 'takram', view: 'cloud-alpha', scenario: cloudBuffer,
  }), false);
  assert.equal(shouldBypassTerrainDepth({
    backendName: 'current', view: 'cloud-alpha', scenario: referenceSky,
  }), false);
});

test('raw cloud buffer measurements use alpha from the source buffer and report its composite contrast overlap', () => {
  const pixels = new Uint8Array([
    // Bottom row: two connected occupied pixels.
    0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0, 0,
    // Top row: the component continues and has a three-pixel horizontal run.
    0, 0, 0, 0, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255,
  ]);
  const finalCompositePixels = new Uint8Array([
    0, 0, 0, 255, 255, 255, 255, 255, 0, 0, 0, 255, 0, 0, 0, 255,
    0, 0, 0, 255, 255, 255, 255, 255, 255, 255, 255, 255, 0, 0, 0, 255,
  ]);
  const measured = measureCloudBufferPixels({
    pixels,
    width: 4,
    height: 2,
    finalCompositePixels,
    finalCompositeWidth: 4,
    finalCompositeHeight: 2,
  });

  assert.equal(measured.status, 'MEASURED');
  assert.equal(measured.alphaOccupancy, 5 / 8);
  assert.equal(measured.topHalfAlphaOccupancy, 3 / 4);
  assert.equal(measured.connectedComponents, 1);
  assert.equal(measured.maxHorizontalRun, 3);
  assert.equal(measured.finalCompositeContrast.status, 'MEASURED');
  assert.ok(measured.finalCompositeContrast.overlapRatio > 0);
});

test('raw diagnostic eligibility rejects an empty alpha buffer, missing official assets, and unsafe layer separation', () => {
  const empty = assessRawCloudDiagnosticEligibility({
    cloudAssetMode: 'official-pinned',
    nearestLayerBoundaryDistance: 750,
    rawMetrics: { status: 'MEASURED', alphaOccupancy: 0 },
  });
  assert.deepEqual(empty, {
    eligible: false,
    reason: 'empty-cloud-buffer-alpha',
    reasons: ['empty-cloud-buffer-alpha'],
  });

  const invalid = assessRawCloudDiagnosticEligibility({
    cloudAssetMode: 'unavailable',
    nearestLayerBoundaryDistance: 499,
    rawMetrics: { status: 'MEASURED', alphaOccupancy: 0.1 },
  });
  assert.deepEqual(invalid, {
    eligible: false,
    reason: 'official-cloud-assets-unavailable',
    reasons: ['official-cloud-assets-unavailable', 'camera-near-zero-density-boundary'],
  });
});

test('raw result metadata identifies the buffer source and keeps reference-sky out of mission capture claims', () => {
  const scenario = createScenario('reference-sky', 'takram');
  const profile = getTakramCloudProfile('takram-reference');
  const metadata = createCloudDiagnosticMetadata({
    backend: 'takram',
    profileName: 'takram-reference',
    view: 'cloud-alpha',
    scenario,
    cloudProfile: profile,
    cameraGeodeticAltitude: 5600,
    profileContext: null,
    cloudAssetMode: 'official-pinned',
    rawMetrics: { status: 'MEASURED', alphaOccupancy: 0.1 },
    terrainDepthBypassed: true,
  });

  assert.deepEqual(metadata, {
    profile: 'takram-reference',
    view: 'cloud-alpha',
    cameraGeodeticAltitude: 5600,
    nearestLayerBoundaryDistance: 1900,
    cloudAssetMode: 'official-pinned',
    compositionMode: 'takram-cloud-buffer-debug',
    terrainDepthMode: 'bypassed-for-raw-reference-sky',
    captureKind: 'sky-only-reference',
    inSceneMissionCapture: false,
    eligibility: { eligible: true, reason: null, reasons: [] },
  });
});

test('a comparison frame delegates cloud rendering only to the production composer', () => {
  const calls = [];
  const camera = { position: 'camera-position' };
  const runtime = {
    environment: { update: (...args) => calls.push(['environment', ...args]) },
    sky: { update: (...args) => calls.push(['sky', ...args]) },
    terrain: { update: (...args) => calls.push(['terrain', ...args]) },
    backend: { update: () => calls.push(['backend']) },
    engine: { camera, render: (...args) => calls.push(['composer', ...args]) },
  };

  renderComparisonFrame(runtime, 1 / 60);

  assert.deepEqual(calls, [
    ['environment', 1 / 60, 'camera-position'],
    ['sky', camera],
    ['terrain', 'camera-position', 4],
    ['composer', 1 / 60],
  ]);
});

test('comparison lifecycle gate runs before the composer render', () => {
  const calls = [];
  renderComparisonFrame({
    lifecycleAudit: { beforeRender: () => calls.push('lifecycle-before-render') },
    engine: { camera: { position: 'position' }, render: () => calls.push('composer-render') },
    environment: { update() {} },
    sky: { update() {} },
    terrain: { update() {} },
  }, 1 / 60);
  assert.deepEqual(calls, ['lifecycle-before-render', 'composer-render']);
});

test('comparison resize seam audits changed cloud target and unchanged adapter before render', () => {
  const target = {
    width: 480,
    height: 270,
    texture: { image: { width: 480, height: 270 }, format: 1, type: 2 },
    disposeCount: 0,
    dispose() { this.disposeCount += 1; },
  };
  const backend = {
    cloudVolume: { _temporalTargets: [target], _shadowTarget: null },
    dispose() {},
    setSize(width, height) {
      target.dispose();
      target.width = width / 2;
      target.height = height / 2;
      target.texture.image.width = target.width;
      target.texture.image.height = target.height;
    },
    resetHistory() {},
  };
  const size = { x: 1280, y: 720 };
  const runtime = {
    frame: 150,
    backend,
    backendName: 'current',
    historyResets: [],
    contextEvents: [],
    engine: {
      camera: { aspect: 1, position: 'position', updateProjectionMatrix() {} },
      renderer: {
        setPixelRatio() {}, setSize() {},
        getDrawingBufferSize(vector) { return vector.set(size.x, size.y); },
      },
      composer: { setSize() {} },
      render() {},
    },
    environment: { update() {} },
    sky: { update() {} },
    terrain: { update() {} },
  };
  runtime.lifecycleAudit = new CloudLifecycleAuditor(() => describeCloudLifecycleResources(runtime));
  const previousWindow = globalThis.window;
  globalThis.window = { devicePixelRatio: 1 };
  try {
    applyComparisonEvent(runtime, { viewport: [1280, 720], resetHistory: 'resize' });
    renderComparisonFrame(runtime, 1 / 60);
  } finally {
    globalThis.window = previousWindow;
  }
  assert.equal(target.disposeCount, 1);
  assert.deepEqual(runtime.lifecycleAudit.reports[0].changedKeys, ['current-temporal-0']);
  assert.deepEqual(runtime.lifecycleAudit.reports[0].unchangedKeys, ['backend']);
});

test('comparison installs exactly one cloud effect in a dedicated timed pass', () => {
  const effect = { name: 'cloud' };
  const calls = [];
  class FakeEffectPass {
    constructor(camera, ...effects) {
      this.camera = camera;
      this.effects = effects;
    }
    render(...args) { calls.push(['cloud-render', ...args]); }
  }
  const composer = {
    passes: [{ name: 'render' }, { name: 'radiance' }, { name: 'finish', renderToScreen: true }],
    addPass(pass) { calls.push(['add-pass']); this.passes.push(pass); this.pass = pass; },
    removePass(pass) { calls.push(['remove-pass', pass]); },
  };
  const engine = {
    camera: { name: 'camera' },
    composer,
    clouds: effect,
    radiancePass: composer.passes[1],
    finishPass: composer.passes[2],
    _buildEffectPass() { calls.push(['rebuild-radiance', this.clouds]); },
  };
  const benchmark = { measure(render) { calls.push(['measure']); return render(); } };

  const pass = installDedicatedCloudPass(engine, effect, benchmark, FakeEffectPass);
  pass.render('renderer', 'input', 'output', 1 / 60);

  assert.strictEqual(engine.clouds, null);
  assert.deepEqual(pass.effects, [effect]);
  assert.ok(composer.passes.indexOf(pass) < composer.passes.indexOf(engine.radiancePass));
  assert.ok(composer.passes.indexOf(engine.radiancePass) < composer.passes.indexOf(engine.finishPass));
  assert.equal(pass.renderToScreen, false);
  assert.equal(engine.finishPass.renderToScreen, true);
  assert.deepEqual(calls, [
    ['rebuild-radiance', null],
    ['add-pass'],
    ['rebuild-radiance', null],
    ['measure'],
    ['cloud-render', 'renderer', 'input', 'output', 1 / 60],
  ]);
});

test('Takram comparison keeps cloud overlay and aerial perspective together before radiance', () => {
  const clouds = { name: 'CloudsEffect' };
  const aerialPerspective = { name: 'AerialPerspectiveEffect' };
  class FakeEffectPass {
    constructor(camera, ...effects) {
      this.camera = camera;
      this.effects = effects;
    }
    render() {}
  }
  const composer = {
    passes: [{ name: 'render' }, { name: 'depth' }, { name: 'radiance' }, { name: 'finish' }],
    addPass(pass) { this.passes.push(pass); },
    removePass() {},
  };
  const engine = {
    camera: { name: 'camera' },
    composer,
    clouds: clouds,
    radiancePass: composer.passes[2],
    finishPass: composer.passes[3],
    _buildEffectPass() {},
  };

  const pass = installDedicatedCloudPass(
    engine,
    [clouds, aerialPerspective],
    { measure: render => render() },
    FakeEffectPass,
  );

  assert.deepEqual(pass.effects, [clouds, aerialPerspective]);
  assert.ok(composer.passes.indexOf(composer.passes[0]) < composer.passes.indexOf(pass));
  assert.ok(composer.passes.indexOf(pass) < composer.passes.indexOf(engine.radiancePass));
  assert.ok(composer.passes.indexOf(engine.radiancePass) < composer.passes.indexOf(engine.finishPass));
});

test('comparison retains the dedicated pass for the same effect and replaces it once for a new effect', () => {
  const firstEffect = { name: 'first-cloud' };
  const secondEffect = { name: 'second-cloud' };
  class FakeEffectPass {
    constructor(camera, ...effects) {
      this.camera = camera;
      this.effects = effects;
      this.disposeCount = 0;
    }
    render() {}
    setEffects(effects) { this.effects = effects; }
    dispose() { this.disposeCount += 1; }
  }
  const composer = {
    passes: [],
    addPass(pass) { this.passes.push(pass); },
    removePass(pass) {
      const index = this.passes.indexOf(pass);
      if (index >= 0) this.passes.splice(index, 1);
    },
  };
  const engine = {
    camera: {},
    composer,
    clouds: null,
    radiancePass: {},
    finishPass: { renderToScreen: true },
    _buildEffectPass() {},
  };
  composer.passes.push(engine.radiancePass, engine.finishPass);
  const benchmark = { measure: render => render() };

  const originalPass = installDedicatedCloudPass(
    engine,
    firstEffect,
    benchmark,
    FakeEffectPass,
  );
  const retainedPass = installDedicatedCloudPass(
    engine,
    firstEffect,
    benchmark,
    FakeEffectPass,
  );

  assert.strictEqual(retainedPass, originalPass);
  assert.equal(originalPass.disposeCount, 0);
  assert.equal(composer.passes.filter(pass => pass === originalPass).length, 1);

  const replacementPass = installDedicatedCloudPass(
    engine,
    secondEffect,
    benchmark,
    FakeEffectPass,
  );

  assert.notStrictEqual(replacementPass, originalPass);
  assert.equal(originalPass.disposeCount, 1);
  assert.equal(composer.passes.includes(originalPass), false);
  assert.equal(composer.passes.filter(pass => pass === replacementPass).length, 1);
});

test('a comparison frame uses the production engine camera without a duplicate alias', () => {
  const camera = { position: 'engine-camera-position' };
  const calls = [];
  renderComparisonFrame({
    engine: { camera, render: dt => calls.push(['composer', dt]) },
    environment: { update: (...args) => calls.push(['environment', ...args]) },
    sky: { update: value => calls.push(['sky', value]) },
    terrain: { update: (...args) => calls.push(['terrain', ...args]) },
  }, 0.25);

  assert.deepEqual(calls, [
    ['environment', 0.25, 'engine-camera-position'],
    ['sky', camera],
    ['terrain', 'engine-camera-position', 4],
    ['composer', 0.25],
  ]);
});

test('representative scenario routes stay safely above real terrain with finite upright transforms', () => {
  const site = findPostSites({ x: 0, y: 0, z: 0, clone() { return this; } }, 1)[0];
  const objectiveAim = [site.position.x, site.position.y + 12, site.position.z];

  for (const name of EXPECTED_SCENARIOS) {
    const scenario = createScenario(name, 'current');
    const authoredRollLimit = Math.max(
      ...scenario.events.map(item => Math.abs(item.camera?.roll ?? 0)),
    );
    const frames = new Set([0, 1, 60, 119, 120, 139, 140, 149, 150, 151, 154, 175, 179]);
    for (let frame = 0; frame < 180; frame += 10) frames.add(frame);

    for (const frame of frames) {
      const pose = sampleScenarioCameraPose(scenario, objectiveAim, frame, terrainHeight);
      assert.equal(pose.position.every(Number.isFinite), true, `${name} frame ${frame} position`);
      assert.equal(pose.target.every(Number.isFinite), true, `${name} frame ${frame} target`);
      assert.equal(Number.isFinite(pose.fov), true, `${name} frame ${frame} fov`);
      assert.equal(Number.isFinite(pose.roll), true, `${name} frame ${frame} roll`);
      assert.ok(pose.agl >= scenario.minimumClearance - 1e-6, `${name} frame ${frame} AGL`);
      assert.ok(pose.agl > scenario.depthSetup.near * 100, `${name} frame ${frame} near plane`);
      assert.ok(Math.abs(pose.roll) <= authoredRollLimit + 1e-9, `${name} frame ${frame} roll bound`);
      assert.ok(Math.abs(pose.roll) < Math.PI / 2, `${name} frame ${frame} upright`);
    }
  }
});

test('repeated runs restore identical world and cloud clock bases', () => {
  const environment = {
    uniforms: {
      uTime: { value: 999 },
      uCloudTime: { value: 999 },
    },
  };
  const opening = createScenario('opening-10', 'current');

  resetScenarioClock(environment, opening);
  assert.deepEqual(
    [environment.uniforms.uTime.value, environment.uniforms.uCloudTime.value],
    [0, 10],
  );
  environment.uniforms.uTime.value += 3;
  environment.uniforms.uCloudTime.value += 3;
  resetScenarioClock(environment, opening);
  assert.deepEqual(
    [environment.uniforms.uTime.value, environment.uniforms.uCloudTime.value],
    [0, 10],
  );
});

test('comparison loads and validates the official pinned STBN volume', async () => {
  const texture = new Data3DTexture(new Uint8Array(128 * 128 * 64), 128, 128, 64);
  const requests = [];
  const loader = {
    load(url, onLoad) {
      requests.push(url);
      queueMicrotask(() => onLoad(texture));
      return texture;
    },
  };

  const loaded = await loadOfficialStbnTexture(loader);

  assert.strictEqual(loaded, texture);
  assert.deepEqual(requests, [DEFAULT_STBN_URL]);
});

test('comparison rejects incomplete STBN volumes before warmup', async () => {
  const texture = new Data3DTexture(new Uint8Array(1), 1, 1, 1);
  let disposeCount = 0;
  texture.dispose = () => { disposeCount += 1; };
  const loader = { load(_url, onLoad) { queueMicrotask(() => onLoad(texture)); return texture; } };

  await assert.rejects(loadOfficialStbnTexture(loader), /Invalid official STBN texture: 1x1x1, 1 bytes/);
  assert.equal(disposeCount, 1);
});

test('comparison disposes the STBN loader placeholder when loading fails', async () => {
  const placeholder = new Data3DTexture(new Uint8Array(1), 1, 1, 1);
  let disposeCount = 0;
  placeholder.dispose = () => { disposeCount += 1; };
  const loader = {
    load(_url, _onLoad, _progress, onError) {
      queueMicrotask(() => onError(new Error('network-failure')));
      return placeholder;
    },
  };

  await assert.rejects(loadOfficialStbnTexture(loader), /network-failure/);
  assert.equal(disposeCount, 1);
});

test('comparison makes an unavailable official cloud asset ineligible before warmup', () => {
  assert.deepEqual(assessTakramReferenceAssetEligibility({
    backend: 'takram',
    requiresEnabledTakram: true,
    cloudAssetMode: 'unavailable',
  }), { eligible: false, reason: 'official-cloud-assets-unavailable' });
  assert.deepEqual(assessTakramReferenceAssetEligibility({
    backend: 'takram',
    requiresEnabledTakram: true,
    cloudAssetMode: 'official-pinned',
  }), { eligible: true, reason: null });
});

test('startRun publishes and returns an ineligible result before warmup when cloud assets fail', async () => {
  const calls = { assetLoader: 0, render: 0, benchmarkFrames: 0 };
  const runtime = Object.assign(Object.create(CloudComparisonHarness.prototype), {
    disposed: false,
    running: false,
    phase: 'ready',
    frame: 0,
    runResult: null,
    backendName: 'takram',
    initialQuality: 'high',
    quality: 'high',
    settings: { tier: {} },
    requiresEnabledTakram: true,
    cloudAssets: null,
    cloudAssetMode: 'loading-official',
    profileName: 'takram-reference',
    view: 'cloud-alpha',
    profileContext: null,
    terrainDepthBypassed: false,
    historyResets: [],
    contextEvents: [],
    lifecycleAudit: { reports: [] },
    scenario: {
      name: 'cloud-buffer', warmupFrames: 120, events: [], fixedDeltaSeconds: 1 / 60,
      captureKind: 'raw-cloud-buffer-diagnostic', inSceneMissionCapture: false,
    },
    environment: { uniforms: { uTime: { value: 0 }, uCloudTime: { value: 0 } } },
    benchmark: {
      minimumSamples: 1,
      reset() {},
      recordFrameInterval() { calls.benchmarkFrames += 1; },
    },
    backend: {
      profile: { enabled: true },
      cloudProfile: null,
      setSize() {},
      setCloudTextures() { throw new Error('cloud textures must not be installed after failure'); },
    },
    engine: {
      maxPixelRatio: 1,
      camera: { position: { y: 6000 }, updateProjectionMatrix() {} },
      renderer: {
        setPixelRatio() {},
        setSize() {},
        getDrawingBufferSize(vector) { return vector.set(320, 180); },
      },
      composer: { setSize() {} },
      render() { calls.render += 1; },
    },
    canvas: { width: 320, height: 180 },
    _prepareStbn: async () => {},
    async _loadOfficialCloudAssets() {
      calls.assetLoader += 1;
      throw new Error('fixture cloud asset load failed');
    },
  });
  const previousWindow = globalThis.window;
  const previousConsoleError = console.error;
  globalThis.window = { innerWidth: 320, innerHeight: 180, devicePixelRatio: 1 };
  console.error = () => {};
  try {
    const result = await runtime.startRun();
    assert.strictEqual(result, runtime.runResult);
    assert.equal(result.profile, 'takram-reference');
    assert.equal(result.view, 'cloud-alpha');
    assert.equal(result.cloudAssetMode, 'unavailable');
    assert.deepEqual(result.eligibility, {
      eligible: false,
      reason: 'official-cloud-assets-unavailable',
      reasons: ['official-cloud-assets-unavailable'],
    });
  } finally {
    globalThis.window = previousWindow;
    console.error = previousConsoleError;
  }

  assert.equal(calls.assetLoader, 1);
  assert.equal(runtime.phase, 'ineligible');
  assert.equal(runtime.cloudAssetMode, 'unavailable');
  assert.equal(calls.render, 0);
  assert.equal(calls.benchmarkFrames, 0);
});

test('startRun publishes a fresh ineligible result when a context-restore asset reload fails', async () => {
  const calls = { render: 0, benchmarkFrames: 0 };
  const staleResult = Object.freeze({ profile: 'stale-profile', sentinel: 'pre-context-result' });
  const lifecycleResource = {
    disposeCount: 0,
    dispose() { this.disposeCount += 1; },
  };
  const originalLifecycleDispose = lifecycleResource.dispose;
  const lifecycleAudit = new CloudLifecycleAuditor(() => [{
    key: 'restore-fixture-resource', resource: lifecycleResource, signature: 'fixture',
  }]);
  const runtime = Object.assign(Object.create(CloudComparisonHarness.prototype), {
    disposed: false,
    running: false,
    phase: 'ready',
    frame: 0,
    contextLost: false,
    runResult: staleResult,
    backendName: 'takram',
    initialQuality: 'high',
    quality: 'high',
    settings: { tier: {} },
    requiresEnabledTakram: true,
    cloudAssets: { mode: 'official-pinned' },
    cloudAssetMode: 'official-pinned',
    profileName: 'takram-reference',
    view: 'cloud-alpha',
    profileContext: null,
    terrainDepthBypassed: false,
    historyResets: [],
    contextEvents: [],
    lifecycleAudit,
    scenario: {
      name: 'cloud-buffer', warmupFrames: 120, fixedDeltaSeconds: 1 / 60, minimumClearance: 0,
      events: [{
        frame: 0,
        context: 'lose',
        resetHistory: 'context-loss',
        camera: { kind: 'world', position: [0, 6000, 0], target: [0, 0, 0], roll: 0, fov: 50 },
      }],
      captureKind: 'raw-cloud-buffer-diagnostic', inSceneMissionCapture: false,
    },
    environment: {
      uniforms: { uTime: { value: 0 }, uCloudTime: { value: 0 } },
      update() {},
    },
    sky: { update() {} },
    terrain: { update() {} },
    objective: { aimPoint: new Vector3(0, 0, 0) },
    benchmark: {
      minimumSamples: 1,
      reset() {},
      recordFrameInterval() { calls.benchmarkFrames += 1; },
    },
    backend: {
      profile: { enabled: true },
      cloudProfile: null,
      setSize() {},
      setCloudTextures() {},
      resetHistory() {},
    },
    engine: {
      maxPixelRatio: 1,
      camera: new PerspectiveCamera(50, 1),
      renderer: {
        setPixelRatio() {},
        setSize() {},
        getDrawingBufferSize(vector) { return vector.set(320, 180); },
      },
      composer: { setSize() {} },
      render() { calls.render += 1; },
    },
    canvas: { width: 320, height: 180 },
    _prepareAtmosphere: async () => {},
    _prepareStbn: async () => {},
    _prepareCloudAssets: async () => {},
    _onContextRestored() {
      this._beginContextRestore();
    },
    async _recreateAfterContextRestore() {
      const error = new Error('fixture context restore cloud asset load failed');
      error.code = 'ineligible-reference';
      throw error;
    },
    contextLossExtension: {
      loseContext() {
        setTimeout(() => {
          runtime.cloudAssets = null;
          runtime.cloudAssetMode = 'unavailable';
          runtime._onContextRestored();
          // The production loop observes this promise on its next animation
          // frame. Mark it handled here so Node does not report the fixture's
          // intentionally asynchronous rejection before that frame runs.
          runtime._contextRestorePromise.catch(() => {});
        }, 0);
      },
      restoreContext() {},
    },
  });
  const previousWindow = globalThis.window;
  const previousAnimationFrame = globalThis.requestAnimationFrame;
  globalThis.window = { innerWidth: 320, innerHeight: 180, devicePixelRatio: 1 };
  globalThis.requestAnimationFrame = callback => setTimeout(() => callback(performance.now()), 0);
  try {
    const result = await runtime.startRun();
    assert.strictEqual(result, runtime.runResult);
    assert.notStrictEqual(result, staleResult);
    assert.equal(result.profile, 'takram-reference');
    assert.equal(result.view, 'cloud-alpha');
    assert.equal(result.cloudAssetMode, 'unavailable');
    assert.deepEqual(result.eligibility, {
      eligible: false,
      reason: 'official-cloud-assets-unavailable',
      reasons: ['official-cloud-assets-unavailable'],
    });
    assert.equal(result.artifacts[0].renderedFrames, 0);
    assert.deepEqual(result.artifacts[0].lifecycleAudits, [{
      reason: 'context-restore',
      resetReason: 'context-loss',
      state: 'ABORTED',
      abortReason: 'official-cloud-assets-unavailable',
      resetBeforeRender: false,
      reconstructionCompleted: false,
    }]);
    assert.deepEqual(result.lifecycleAudits, result.artifacts[0].lifecycleAudits);
  } finally {
    globalThis.window = previousWindow;
    globalThis.requestAnimationFrame = previousAnimationFrame;
  }

  assert.equal(runtime.contextLost, true);
  assert.deepEqual(runtime.contextEvents, [{ frame: 0, action: 'lose', supported: true }]);
  assert.equal(runtime.phase, 'ineligible');
  assert.equal(calls.render, 0);
  assert.equal(calls.benchmarkFrames, 0);
  assert.strictEqual(lifecycleResource.dispose, originalLifecycleDispose);
  assert.equal(lifecycleAudit.beforeRender(), null);
  assert.doesNotThrow(() => lifecycleAudit.begin('retry'));
  lifecycleAudit.abortMutation('retry-complete');
  lifecycleAudit.dispose();
  lifecycleAudit.dispose();
  assert.strictEqual(lifecycleResource.dispose, originalLifecycleDispose);
});

test('context restore gate keeps rendering disabled until reconstruction resolves', async () => {
  let completeRestore;
  const runtime = Object.assign(Object.create(CloudComparisonHarness.prototype), {
    contextLost: false,
    _recreateAfterContextRestore: () => new Promise(resolve => { completeRestore = resolve; }),
  });

  const restore = runtime._beginContextRestore();
  assert.equal(runtime.contextLost, true);
  completeRestore();
  await restore;
  assert.equal(runtime.contextLost, false);
});

test('comparison accounts for each harness-owned official cloud texture exactly once', () => {
  const localWeatherTexture = new Texture({ width: 512, height: 512 });
  localWeatherTexture.generateMipmaps = true;
  const shapeTexture = new Data3DTexture(new Uint8Array(128 * 128 * 128), 128, 128, 128);
  shapeTexture.format = RedFormat;
  shapeTexture.generateMipmaps = false;
  const shapeDetailTexture = new Data3DTexture(new Uint8Array(32 * 32 * 32), 32, 32, 32);
  shapeDetailTexture.format = RedFormat;
  shapeDetailTexture.generateMipmaps = false;
  const turbulenceTexture = new Texture({ width: 128, height: 128 });
  turbulenceTexture.generateMipmaps = true;

  const report = describeOfficialTakramCloudAssets({
    mode: 'official-pinned',
    localWeatherTexture,
    shapeTexture,
    shapeDetailTexture,
    turbulenceTexture,
  });

  assert.equal(report.owner, 'comparison-harness');
  assert.equal(report.resources.length, 4);
  assert.equal(report.resources.reduce((total, resource) => total + resource.payloadBytes, 0), 2_859_264);
  assert.equal(report.resources.reduce((total, resource) => total + resource.bytes, 0), 3_615_400);
  assert.deepEqual(report.resources.map(resource => resource.name), [
    'official-local-weather',
    'official-cloud-shape',
    'official-cloud-shape-detail',
    'official-turbulence',
  ]);
});

test('Takram stays visually pending until composited imagery is reviewed', () => {
  assert.deepEqual(assessVisualEligibility({
    backend: 'current', enabled: true, lightingMode: 'shipping-environment', stbnMode: null,
  }), { eligible: true, reason: null });
  assert.deepEqual(assessVisualEligibility({
    backend: 'takram', enabled: true, lightingMode: 'takram-precomputed-lut', stbnMode: 'official-pinned',
    cloudAssetMode: 'official-pinned',
  }), { eligible: false, reason: 'pending-composited-visual-review' });
  assert.deepEqual(assessVisualEligibility({
    backend: 'takram', enabled: true, lightingMode: 'fallback-lighting', stbnMode: 'official-pinned',
    cloudAssetMode: 'official-pinned',
  }), { eligible: false, reason: 'fallback-lighting' });
  assert.deepEqual(assessVisualEligibility({
    backend: 'takram', enabled: true, lightingMode: 'takram-precomputed-lut', stbnMode: 'official-pinned',
    cloudAssetMode: 'unavailable',
  }), { eligible: false, reason: 'official-cloud-assets-unavailable' });
});

test('comparison publishes machine-readable result in a hidden ordinary DOM node', () => {
  const nodes = new Map();
  const body = { append(node) { nodes.set(node.id, node); } };
  const documentValue = {
    body,
    getElementById: id => nodes.get(id) ?? null,
    createElement: tagName => ({ tagName, hidden: false, id: '', textContent: '' }),
  };
  const result = { version: 'cloud-comparison-v1', measurementStatus: 'VERIFIED' };

  publishComparisonResult(documentValue, result);

  const node = nodes.get('comparison-result');
  assert.equal(node.hidden, true);
  assert.equal(node.textContent, JSON.stringify(result));
});

test('comparison retains image artifacts in hidden DOM nodes without bloating result JSON', () => {
  const nodes = new Map();
  const documentValue = {
    body: { append(node) { nodes.set(node.id, node); } },
    getElementById: id => nodes.get(id) ?? null,
    createElement: tagName => ({
      tagName, hidden: false, id: '', textContent: '',
      remove() { nodes.delete(this.id); },
    }),
  };
  publishComparisonResult(documentValue, {
    version: 'cloud-comparison-v1',
    artifacts: [{ name: 'heatmap.png', dataUrl: 'data:image/png;base64,AAAA' }],
  });
  const published = JSON.parse(nodes.get('comparison-result').textContent);
  assert.equal(published.artifacts[0].dataUrl, undefined);
  assert.equal(published.artifacts[0].domId, 'comparison-artifact-0');
  assert.equal(nodes.get('comparison-artifact-0').src, 'data:image/png;base64,AAAA');
  assert.equal(nodes.get('comparison-artifact-0').hidden, true);

  publishComparisonResult(documentValue, { version: 'cloud-comparison-v1', artifacts: [] });
  assert.equal(nodes.has('comparison-artifact-0'), false);
});

test('context restore reuses the extension captured before context loss', () => {
  const calls = [];
  const runtime = {
    frame: 150,
    contextLost: false,
    contextEvents: [],
    contextLossExtension: {
      loseContext: () => calls.push('lose'),
      restoreContext: () => calls.push('restore'),
    },
  };
  applyContextEvent(runtime, 'lose');
  assert.equal(runtime.contextLost, true);
  runtime.frame = 154;
  applyContextEvent(runtime, 'restore');
  assert.equal(runtime.contextLost, true);
  assert.deepEqual(calls, ['lose', 'restore']);
  assert.deepEqual(runtime.contextEvents, [
    { frame: 150, action: 'lose', supported: true },
    { frame: 154, action: 'restore', supported: true },
  ]);
});

test('comparison captures console warnings and errors and restores the console', () => {
  const forwarded = [];
  const consoleValue = {
    warn: (...args) => forwarded.push(['warn', ...args]),
    error: (...args) => forwarded.push(['error', ...args]),
  };
  const originalWarn = consoleValue.warn;
  const originalError = consoleValue.error;
  const issues = [];
  const restore = installConsoleIssueCapture(consoleValue, issues);
  consoleValue.warn('shader', 'warning');
  consoleValue.error(new Error('compile failed'));
  restore();
  assert.deepEqual(issues, [
    { level: 'warn', message: 'shader warning' },
    { level: 'error', message: 'compile failed' },
  ]);
  assert.deepEqual(forwarded, [
    ['warn', 'shader', 'warning'],
    ['error', new Error('compile failed')],
  ]);
  assert.strictEqual(consoleValue.warn, originalWarn);
  assert.strictEqual(consoleValue.error, originalError);
});
