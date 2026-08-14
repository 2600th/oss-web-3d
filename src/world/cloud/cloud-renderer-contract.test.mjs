import assert from 'node:assert/strict';
import test from 'node:test';
import { assertCloudRendererBackend } from './CloudRendererContract.js';
import { CurrentCloudRendererAdapter } from './CurrentCloudRendererAdapter.js';

function fakeCloudVolume() {
  return {
    sizeCalls: [],
    qualityCalls: [],
    depthCalls: [],
    updateCalls: [],
    resetCalls: [],
    disposeCount: 0,
    shadowContract: { texture: { name: 'shadow' }, version: 7 },
    resourceReport: { backend: 'current', totalBytes: 1234 },
    setSize(...args) { this.sizeCalls.push(args); },
    setQuality(...args) { this.qualityCalls.push(args); },
    setDepthTexture(...args) { this.depthCalls.push(args); },
    update(...args) { this.updateCalls.push(args); },
    resetHistory(...args) { this.resetCalls.push(args); },
    getResourceReport() { return this.resourceReport; },
    dispose() { this.disposeCount += 1; },
  };
}

test('contract accepts a complete cloud renderer backend', () => {
  const backend = new CurrentCloudRendererAdapter(fakeCloudVolume());
  assert.strictEqual(assertCloudRendererBackend(backend), backend);
});

test('contract rejects the first missing method by name', () => {
  const backend = new CurrentCloudRendererAdapter(fakeCloudVolume());
  backend.setQuality = undefined;
  backend.update = undefined;

  assert.throws(
    () => assertCloudRendererBackend(backend),
    /setQuality/,
  );
});

test('current adapter forwards lifecycle data without replacing the caller frame', () => {
  const cloudVolume = fakeCloudVolume();
  const backend = new CurrentCloudRendererAdapter(cloudVolume);
  const quality = Object.freeze({ name: 'high', cloudSteps: 38 });
  const depth = Object.freeze({ name: 'stable-depth' });
  const renderer = Object.freeze({ name: 'renderer' });
  const inputBuffer = Object.freeze({ name: 'input-buffer' });
  const frame = Object.freeze({
    dt: 1 / 60,
    renderer,
    inputBuffer,
    camera: Object.freeze({ name: 'camera' }),
    scene: Object.freeze({ name: 'scene' }),
    sunDirection: Object.freeze({ x: 0, y: 1, z: 0 }),
    environment: Object.freeze({ name: 'environment' }),
    sceneDepth: depth,
    cameraCut: false,
  });

  backend.setSize(1920, 1080, 2);
  backend.setQuality(quality);
  backend.setDepthTexture(depth);
  backend.update(frame);
  backend.resetHistory('camera-cut');

  assert.deepEqual(cloudVolume.sizeCalls, [[1920, 1080]]);
  assert.deepEqual(cloudVolume.qualityCalls, [[quality]]);
  assert.deepEqual(cloudVolume.depthCalls, [[depth]]);
  assert.equal(cloudVolume.updateCalls.length, 1);
  assert.strictEqual(cloudVolume.updateCalls[0][0], frame.renderer);
  assert.strictEqual(cloudVolume.updateCalls[0][1], frame.inputBuffer);
  assert.strictEqual(cloudVolume.updateCalls[0][2], frame.dt);
  assert.strictEqual(frame.renderer, renderer);
  assert.strictEqual(frame.inputBuffer, inputBuffer);
  assert.deepEqual(cloudVolume.resetCalls, [['camera-cut']]);
  assert.strictEqual(backend.getShadowOutput(), cloudVolume.shadowContract);
  assert.strictEqual(backend.getResourceReport(), cloudVolume.resourceReport);
});

test('current adapter disposes its wrapped volume exactly once', () => {
  const cloudVolume = fakeCloudVolume();
  const backend = new CurrentCloudRendererAdapter(cloudVolume);

  backend.dispose();
  backend.dispose();

  assert.equal(cloudVolume.disposeCount, 1);
});
