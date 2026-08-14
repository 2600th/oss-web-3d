import assert from 'node:assert/strict';
import test from 'node:test';
import { Data3DTexture } from 'three';
import { DEFAULT_STBN_URL } from '@takram/three-geospatial';

import {
  COMPARISON_SCENARIO_NAMES,
  assessVisualEligibility,
  applyContextEvent,
  applyComparisonEvent,
  createScenario,
  describeCloudLifecycleResources,
  loadOfficialStbnTexture,
  installDedicatedCloudPass,
  installConsoleIssueCapture,
  parseComparisonQuery,
  publishComparisonResult,
  renderComparisonFrame,
  resetScenarioClock,
  sampleScenarioCameraPose,
} from './CloudComparisonHarness.js';
import { CloudLifecycleAuditor } from './CloudBenchmark.js';
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

test('comparison query accepts only the published backend, quality, and scenario values', () => {
  assert.deepEqual(
    parseComparisonQuery('?backend=takram&quality=high&scenario=opening-3.5'),
    { backend: 'takram', quality: 'high', scenario: 'opening-3.5' },
  );
  assert.throws(() => parseComparisonQuery('?backend=other'), /Unknown backend query value: other/);
  assert.throws(() => parseComparisonQuery('?quality=ultra'), /Unknown quality query value: ultra/);
  assert.throws(() => parseComparisonQuery('?scenario=other'), /Unknown scenario query value: other/);
  assert.throws(() => parseComparisonQuery('?backend=current&extra=1'), /Unknown query parameter: extra/);
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

test('Takram stays visually pending until composited imagery is reviewed', () => {
  assert.deepEqual(assessVisualEligibility({
    backend: 'current', enabled: true, lightingMode: 'shipping-environment', stbnMode: null,
  }), { eligible: true, reason: null });
  assert.deepEqual(assessVisualEligibility({
    backend: 'takram', enabled: true, lightingMode: 'takram-precomputed-lut', stbnMode: 'official-pinned',
  }), { eligible: false, reason: 'pending-composited-visual-review' });
  assert.deepEqual(assessVisualEligibility({
    backend: 'takram', enabled: true, lightingMode: 'fallback-lighting', stbnMode: 'official-pinned',
  }), { eligible: false, reason: 'fallback-lighting' });
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
    contextEvents: [],
    contextLossExtension: {
      loseContext: () => calls.push('lose'),
      restoreContext: () => calls.push('restore'),
    },
  };
  applyContextEvent(runtime, 'lose');
  runtime.frame = 154;
  applyContextEvent(runtime, 'restore');
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
