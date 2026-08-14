import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CloudBenchmark,
  CloudLifecycleAuditor,
  combineOwnedResourceItems,
  GpuTimerQuery,
  bytesForTarget,
  computeObjectiveContrast,
  computeTemporalTrail,
  createCloudComparisonResult,
  deriveCloudMask,
  flipPixelRows,
  measurePayloadManifest,
  summarizeResourceReport,
  summarizeSamples,
} from './CloudBenchmark.js';

test('summarizeSamples reports median and nearest-rank p95 from finite values', () => {
  assert.deepEqual(summarizeSamples([1, 2, 3, 4, 100]), { median: 3, p95: 100 });
  assert.deepEqual(summarizeSamples([Number.NaN, 4, 2]), { median: 3, p95: 4 });
  assert.deepEqual(summarizeSamples([]), { median: null, p95: null });
});

test('bytesForTarget counts attachments, layers, samples, histories, and mip levels once', () => {
  assert.equal(bytesForTarget({
    width: 1920,
    height: 1080,
    channels: 4,
    bytesPerChannel: 2,
    history: 2,
  }), 33_177_600);
  assert.equal(bytesForTarget({
    width: 4,
    height: 4,
    channels: 4,
    bytesPerChannel: 1,
    layers: 2,
    samples: 1,
    attachments: 1,
    mipLevels: 3,
  }), 168);
});

test('summarizeResourceReport keeps targets and assets separate without double counting', () => {
  assert.deepEqual(summarizeResourceReport({ resources: [
    { name: 'history', kind: 'render-target', bytes: 32 },
    { name: 'noise', kind: 'procedural-texture', bytes: 8 },
    { name: 'lut', kind: 'atmosphere-lut', bytes: 4 },
    { name: 'stbn', kind: 'sampling-texture', bytes: 2 },
  ] }), {
    targetBytes: 32,
    assetBytes: 14,
    totalBytes: 46,
    byKind: {
      'render-target': 32,
      'procedural-texture': 8,
      'atmosphere-lut': 4,
      'sampling-texture': 2,
    },
  });
});

test('combineOwnedResourceItems counts an externally supplied STBN texture exactly once', () => {
  const backend = [
    { name: 'history', kind: 'render-target', bytes: 32 },
    { name: 'stbn-external', kind: 'sampling-texture', bytes: 1_048_576 },
  ];
  const combined = combineOwnedResourceItems({
    backendResources: backend,
    atmosphereResources: [],
    stbnResource: { name: 'official-stbn', kind: 'sampling-texture', bytes: 1_048_576 },
  });
  assert.equal(combined.length, 2);
  assert.equal(summarizeResourceReport({ resources: combined }).totalBytes, 1_048_608);
});

function createFakeGl({ extension = true } = {}) {
  let nextId = 0;
  const queries = new Map();
  const deleted = [];
  const ext = extension ? {
    TIME_ELAPSED_EXT: 0x88BF,
    GPU_DISJOINT_EXT: 0x8FBB,
  } : null;
  return {
    QUERY_RESULT_AVAILABLE: 0x8867,
    QUERY_RESULT: 0x8866,
    deleted,
    queries,
    disjoint: false,
    getExtension: name => name === 'EXT_disjoint_timer_query_webgl2' ? ext : null,
    createQuery() {
      const query = { id: ++nextId };
      queries.set(query, { available: false, nanoseconds: 0 });
      return query;
    },
    beginQuery(_target, query) { this.active = query; },
    endQuery() { this.active = null; },
    getParameter(name) { return name === ext?.GPU_DISJOINT_EXT ? this.disjoint : null; },
    getQueryParameter(query, name) {
      const state = queries.get(query);
      return name === this.QUERY_RESULT_AVAILABLE ? state.available : state.nanoseconds;
    },
    deleteQuery(query) { deleted.push(query); queries.delete(query); },
    resolveAll(nanoseconds = 2_000_000) {
      for (const state of queries.values()) {
        state.available = true;
        state.nanoseconds = nanoseconds;
      }
    },
  };
}

test('GpuTimerQuery leaves unsupported GPU timing unverified without fabricated values', () => {
  const timer = new GpuTimerQuery(createFakeGl({ extension: false }));
  assert.equal(timer.begin(), false);
  assert.deepEqual(timer.snapshot(), {
    supported: false,
    status: 'UNVERIFIED',
    samplesMs: [],
    disjointCount: 0,
    droppedCount: 0,
    pendingCount: 0,
  });
});

test('CloudBenchmark remains unverified when timer queries are unsupported', () => {
  let now = 0;
  const benchmark = new CloudBenchmark(createFakeGl({ extension: false }), {
    now: () => now,
    visibility: () => ({ visibilityState: 'visible', focused: true }),
  });
  for (let frame = 0; frame < 300; frame += 1) {
    benchmark.measure(() => { now += 1; });
  }
  const report = benchmark.report();
  assert.equal(report.cpu.sampleCount, 180);
  assert.equal(report.gpu.supported, false);
  assert.equal(report.gpu.medianMs, null);
  assert.equal(report.status, 'UNVERIFIED');
});

test('GpuTimerQuery is nonblocking, bounded to 32 pending queries, and converts nanoseconds', () => {
  const gl = createFakeGl();
  const timer = new GpuTimerQuery(gl, { maxPending: 32 });
  for (let index = 0; index < 32; index += 1) {
    assert.equal(timer.begin(), true);
    timer.end();
  }
  assert.equal(timer.begin(), false);
  assert.equal(timer.snapshot().pendingCount, 32);
  gl.resolveAll();
  assert.equal(timer.poll(), 32);
  const report = timer.snapshot();
  assert.equal(report.samplesMs.length, 32);
  assert.equal(report.samplesMs[0], 2);
  assert.equal(report.droppedCount, 1);
});

test('GpuTimerQuery discards and deletes every pending query when the GPU is disjoint', () => {
  const gl = createFakeGl();
  const timer = new GpuTimerQuery(gl);
  for (let index = 0; index < 3; index += 1) {
    timer.begin();
    timer.end();
  }
  gl.disjoint = true;
  timer.poll();
  assert.equal(gl.deleted.length, 3);
  assert.equal(timer.snapshot().disjointCount, 3);
  assert.deepEqual(timer.snapshot().samplesMs, []);
});

test('CloudBenchmark excludes warmup and records eligibility and capabilities', () => {
  let now = 0;
  const gl = createFakeGl();
  const benchmark = new CloudBenchmark(gl, {
    warmupFrames: 120,
    minimumSamples: 180,
    now: () => now,
    visibility: () => ({ visibilityState: 'visible', focused: true }),
  });
  for (let frame = 0; frame < 300; frame += 1) {
    benchmark.measure(() => { now += 2; });
    gl.resolveAll(3_000_000);
    benchmark.poll();
  }
  const report = benchmark.report();
  assert.equal(report.status, 'VERIFIED');
  assert.equal(report.cpu.sampleCount, 180);
  assert.equal(report.gpu.sampleCount, 180);
  assert.deepEqual(report.cpu, { sampleCount: 180, medianMs: 2, p95Ms: 2 });
  assert.equal(report.gpu.medianMs, 3);
  assert.equal(report.fps, null);
  assert.equal(report.fpsStatus, 'UNVERIFIED');
  assert.equal(report.capabilities.timerQuery, true);
  assert.deepEqual(report.observation, {
    visibilityStates: ['visible'],
    focusStates: [true],
    rejectedFrames: 0,
  });
});

test('CloudBenchmark reports application FPS only from 180 end-to-end frame intervals', () => {
  const benchmark = new CloudBenchmark(createFakeGl({ extension: false }), {
    visibility: () => ({ visibilityState: 'visible', focused: true }),
  });
  for (let index = 0; index < 180; index += 1) benchmark.recordFrameInterval(20);
  const report = benchmark.report();
  assert.equal(report.fps, 50);
  assert.equal(report.fpsStatus, 'VERIFIED');
  assert.deepEqual(report.frameCadence, {
    status: 'VERIFIED', sampleCount: 180, medianMs: 20, p95Ms: 20,
  });
});

test('CloudBenchmark replaces dropped GPU queries until it has 180 valid samples', () => {
  let now = 0;
  const gl = createFakeGl();
  const benchmark = new CloudBenchmark(gl, {
    now: () => now,
    visibility: () => ({ visibilityState: 'visible', focused: true }),
  });
  for (let frame = 0; frame < 120 + 33; frame += 1) {
    benchmark.measure(() => { now += 1; });
  }
  assert.ok(benchmark.report().gpu.droppedCount > 0);
  for (let frame = 0; frame < 220; frame += 1) {
    gl.resolveAll(1_000_000);
    benchmark.measure(() => { now += 1; });
  }
  assert.equal(benchmark.report().gpu.sampleCount, 180);
  assert.equal(benchmark.complete, true);
});

test('objective contrast linearizes final sRGB RGBA8 samples', () => {
  const black = new Uint8Array([0, 0, 0, 255]);
  const mid = new Uint8Array([128, 128, 128, 255]);
  const result = computeObjectiveContrast({ targetPixels: mid, backgroundPixels: black });
  assert.equal(result.colorSpace, 'linear-srgb-from-final-rgba8');
  assert.ok(Math.abs(result.targetLuminance - 0.2158605) < 1e-6);
  assert.equal(result.backgroundLuminance, 0);
  assert.ok(Math.abs(result.contrast - 0.2158605) < 1e-6);
});

test('temporal trail measures only residuals outside the dilated current cloud mask', () => {
  const history = new Uint8Array([
    0, 0, 0, 255,
    255, 255, 255, 255,
    255, 255, 255, 255,
    255, 255, 255, 255,
    0, 0, 0, 255,
  ]);
  const reference = new Uint8Array(5 * 4);
  const mask = new Uint8Array([0, 0, 1, 0, 0]);
  const report = computeTemporalTrail({
    historyFrames: [history, history],
    referenceFrames: [reference, reference],
    cloudMasks: [mask, mask],
    width: 5,
    height: 1,
    dilationRadius: 1,
  });
  assert.equal(report.status, 'VERIFIED');
  assert.equal(report.frames[0].outsidePixelCount, 2);
  assert.equal(report.frames[0].residualRatio, 0);
  assert.equal(report.heatmaps[0][0], 0);
  assert.equal(report.heatmaps[0][4], 0);
});

test('temporal trail stays unverified when the cloud mask leaves no outside pixels', () => {
  const frame = new Uint8Array(2 * 4);
  const report = computeTemporalTrail({
    historyFrames: [frame, frame],
    referenceFrames: [frame, frame],
    cloudMasks: [new Uint8Array([1, 1]), new Uint8Array([1, 1])],
    width: 2,
    height: 1,
    dilationRadius: 1,
  });
  assert.equal(report.status, 'UNVERIFIED');
  assert.equal(report.reason, 'no-outside-cloud-pixels');
  assert.equal(report.frames[0].residualRatio, null);
});

test('deriveCloudMask marks final pixels materially changed by cloud compositing', () => {
  const noCloud = new Uint8Array([10, 10, 10, 255, 30, 30, 30, 255]);
  const composited = new Uint8Array([10, 11, 10, 255, 50, 55, 60, 255]);
  assert.deepEqual(deriveCloudMask(composited, noCloud, 4), new Uint8Array([0, 1]));
});

test('flipPixelRows aligns bottom-up readPixels artifacts with top-down images', () => {
  assert.deepEqual(
    flipPixelRows(new Uint8Array([1, 2, 3, 4]), 2, 2),
    new Uint8Array([3, 4, 1, 2]),
  );
});

test('cloud comparison result schema preserves unverified measurements as null', () => {
  const result = createCloudComparisonResult({
    backend: 'takram',
    versions: { '@takram/three-clouds': '0.7.6' },
    scenario: 'opening-3.5',
    viewport: { width: 1920, height: 1080, pixelRatio: 1 },
    quality: 'high',
    benchmark: {
      status: 'UNVERIFIED',
      cpu: { sampleCount: 0, medianMs: null, p95Ms: null },
      gpu: { supported: false, sampleCount: 0, medianMs: null, p95Ms: null,
        disjointCount: 0, droppedCount: 0, pendingCount: 0 },
      fps: null,
      capabilities: { timerQuery: false },
      observation: { visibilityStates: [], focusStates: [], rejectedFrames: 0 },
    },
    resources: { targetBytes: 0, assetBytes: 0, totalBytes: 0, byKind: {} },
  });
  assert.equal(result.version, 'cloud-comparison-v1');
  assert.equal(result.measurements.gpu.status, 'UNVERIFIED');
  assert.equal(result.measurements.gpu.medianMs, null);
  assert.deepEqual(Object.keys(result), [
    'version', 'backend', 'versions', 'scenario', 'viewport', 'quality', 'measurementStatus',
    'measurements', 'resources', 'payload', 'objective', 'temporal', 'consoleIssues', 'artifacts',
  ]);
});

test('measurePayloadManifest reads built manifest assets and reports raw and compressed bytes', async () => {
  const manifest = {
    'comparison.html': { name: 'comparison', file: 'assets/comparison.js', imports: ['takram.js'] },
    'takram.js': { file: 'assets/takram.js', assets: ['assets/stbn.bin'] },
  };
  const sizes = { 'assets/comparison.js': 10, 'assets/takram.js': 20, 'assets/stbn.bin': 30 };
  const result = await measurePayloadManifest(
    manifest,
    ['comparison'],
    async file => new Uint8Array(sizes[file]),
    async bytes => new Uint8Array(Math.ceil(bytes.byteLength / 2)),
  );
  assert.deepEqual(result, {
    status: 'MEASURED',
    compressedBytes: 30,
    uncompressedBytes: 60,
    files: ['assets/comparison.js', 'assets/stbn.bin', 'assets/takram.js'],
  });
});

function disposableResource(name, signature) {
  return {
    name,
    signature,
    disposeCount: 0,
    dispose() { this.disposeCount += 1; },
  };
}

function descriptor(key, resource) {
  return { key, resource, signature: resource.signature };
}

test('lifecycle resize resets before render and recreates only the changed-size target', () => {
  const history = disposableResource('history', '960x540:rgba16f');
  const shadow = disposableResource('shadow', '256x256:rgba8');
  let resources = [descriptor('history', history), descriptor('shadow', shadow)];
  const audit = new CloudLifecycleAuditor(() => resources);

  audit.begin('resize');
  history.dispose();
  history.signature = '1280x720:rgba16f';
  resources = [descriptor('history', history), descriptor('shadow', shadow)];
  audit.markReset('resize');
  audit.completeMutation();
  const report = audit.beforeRender();

  assert.equal(history.disposeCount, 1);
  assert.equal(shadow.disposeCount, 0);
  assert.deepEqual(report.changedKeys, ['history']);
  assert.deepEqual(report.unchangedKeys, ['shadow']);
  assert.equal(report.resetBeforeRender, true);
});

test('lifecycle high-phone-high releases superseded resources once and rebuilds cleanly', () => {
  const highTarget = disposableResource('high-target', '1920x1080:rgba16f');
  let resources = [descriptor('cloud-target', highTarget)];
  const audit = new CloudLifecycleAuditor(() => resources);

  audit.begin('quality-change');
  highTarget.dispose();
  resources = [];
  audit.markReset('quality-change');
  audit.completeMutation();
  const disabled = audit.beforeRender();

  const rebuiltTarget = disposableResource('rebuilt-target', '1920x1080:rgba16f');
  audit.begin('quality-change');
  resources = [descriptor('cloud-target', rebuiltTarget)];
  audit.markReset('quality-change');
  audit.completeMutation();
  const rebuilt = audit.beforeRender();

  assert.equal(highTarget.disposeCount, 1);
  assert.equal(rebuiltTarget.disposeCount, 0);
  assert.deepEqual(disabled.releasedKeys, ['cloud-target']);
  assert.deepEqual(rebuilt.createdKeys, ['cloud-target']);
});

test('lifecycle context restore disposes old backend pass and query once before new render', () => {
  const oldBackend = disposableResource('backend', 'current:high');
  const oldPass = disposableResource('pass', 'cloud-effect-pass');
  const oldQuery = disposableResource('query', 'timer-query-generation-1');
  let resources = [
    descriptor('backend', oldBackend),
    descriptor('pass', oldPass),
    descriptor('query', oldQuery),
  ];
  const audit = new CloudLifecycleAuditor(() => resources);

  audit.begin('context-restore');
  oldBackend.dispose();
  oldPass.dispose();
  oldQuery.dispose();
  const newBackend = disposableResource('backend-2', 'current:high');
  const newPass = disposableResource('pass-2', 'cloud-effect-pass');
  const newQuery = disposableResource('query-2', 'timer-query-generation-2');
  resources = [
    descriptor('backend', newBackend),
    descriptor('pass', newPass),
    descriptor('query', newQuery),
  ];
  audit.markReset('context-restore');
  audit.completeMutation();
  const report = audit.beforeRender();

  assert.deepEqual([oldBackend.disposeCount, oldPass.disposeCount, oldQuery.disposeCount], [1, 1, 1]);
  assert.deepEqual(report.recreatedKeys, ['backend', 'pass', 'query']);
  assert.equal(report.resetBeforeRender, true);
});

test('lifecycle unchanged resize or quality retains resources without disposal', () => {
  const target = disposableResource('target', '1280x720:rgba16f');
  let resources = [descriptor('target', target)];
  const audit = new CloudLifecycleAuditor(() => resources);
  for (const reason of ['resize', 'quality-change']) {
    audit.begin(reason);
    resources = [descriptor('target', target)];
    audit.markReset(reason);
    audit.completeMutation();
    const report = audit.beforeRender();
    assert.deepEqual(report.unchangedKeys, ['target']);
  }
  assert.equal(target.disposeCount, 0);
});

test('lifecycle refuses to render a transition before reset or reconstruction completes', () => {
  const target = disposableResource('target', '1280x720:rgba16f');
  const audit = new CloudLifecycleAuditor(() => [descriptor('target', target)]);
  audit.begin('resize');
  audit.completeMutation();
  assert.throws(() => audit.beforeRender(), /resize transition rendered before history reset/);

  const second = new CloudLifecycleAuditor(() => [descriptor('target', target)]);
  second.begin('context-restore');
  second.markReset('context-restore');
  assert.throws(() => second.beforeRender(), /context-restore transition rendered before reconstruction completed/);
});
