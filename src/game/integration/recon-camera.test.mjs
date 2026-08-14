import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

const encodeJobs = [];
const context = {
  currentValue: 0,
  createImageData(width, height) {
    return { data: new Uint8ClampedArray(width * height * 4) };
  },
  putImageData(image) {
    this.currentValue = image.data[0];
  },
};
const canvas = {
  width: 0,
  height: 0,
  getContext: () => context,
  toBlob(callback) {
    encodeJobs.push({ callback, value: context.currentValue });
  },
};
globalThis.document = { createElement: () => canvas };
globalThis.requestAnimationFrame = (callback) => callback();

const createdUrls = [];
const revokedUrls = [];
const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;
URL.createObjectURL = (blob) => {
  const url = `blob:exposure-${blob.exposure}`;
  createdUrls.push(url);
  return url;
};
URL.revokeObjectURL = (url) => revokedUrls.push(url);

const { ReconCamera } = await import('../ReconCamera.js');
const { terrainVisibility } = await import('../TerrainVisibility.js');
const TRANSIENT_SHOT_RELEASE_MS = 4200;

function flushPromises(turns = 8) {
  return Array.from({ length: turns }).reduce((promise) => promise.then(() => {}), Promise.resolve());
}

function makeRecon() {
  encodeJobs.length = 0;
  createdUrls.length = 0;
  revokedUrls.length = 0;
  context.currentValue = 0;
  const camera = new THREE.PerspectiveCamera(58, 16 / 9, 1, 10000);
  camera.position.set(0, 500, 0);
  camera.lookAt(0, 300, -1000);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  return new ReconCamera(camera);
}

function makeDelayedCaptureSource() {
  const reads = [];
  let exposure = 0;
  const renderer = {
    toneMapping: THREE.NoToneMapping,
    toneMappingExposure: 1,
    getRenderTarget: () => null,
    setRenderTarget() {},
    readRenderTargetPixelsAsync(target, x, y, width, height, pixels) {
      const value = target.__testExposure;
      return new Promise((resolve) => reads.push({ resolve, pixels, value }));
    },
  };
  return {
    renderer,
    reads,
    renderToTarget(target) {
      target.__testExposure = ++exposure;
    },
  };
}

test('four delayed exposures issue distinct GPU reads immediately and serialize only encoding', async () => {
  const recon = makeRecon();
  const source = makeDelayedCaptureSource();
  const evaluation = { score: 0.7, range: 900 };
  const shots = Array.from({ length: 4 }, () => recon.capture(source, evaluation));

  assert.equal(source.reads.length, 4, 'every shutter must fence its rendered target immediately');
  assert.equal(encodeJobs.length, 0, 'encoding waits for readback');

  for (const read of source.reads) {
    read.pixels.fill(read.value);
    read.resolve();
  }
  await flushPromises();
  assert.equal(encodeJobs.length, 1, 'the shared canvas must encode one plate at a time');

  for (let i = 0; i < shots.length; i++) {
    const job = encodeJobs[i];
    assert.ok(job, `encode ${i + 1} should start after the previous plate completes`);
    job.callback({ exposure: job.value });
    await flushPromises();
  }
  await Promise.all(shots.map((shot) => shot.ready));
  assert.deepEqual(shots.map((shot) => shot.dataUrl), [
    'blob:exposure-1',
    'blob:exposure-2',
    'blob:exposure-3',
    'blob:exposure-4',
  ]);
  recon.dispose();
  assert.deepEqual(revokedUrls, createdUrls, 'dispose must revoke every published plate URL');
});

test('dispose is idempotent and latches pending development before canvas or URL work', async () => {
  const recon = makeRecon();
  const source = makeDelayedCaptureSource();
  let targetDisposals = 0;
  for (const target of recon.captureTargets) {
    target.addEventListener('dispose', () => targetDisposals++);
  }
  const shot = recon.capture(source, { score: 0.5, range: 1200 });
  await flushPromises();
  assert.equal(source.reads.length, 1);

  recon.dispose();
  recon.dispose();
  assert.equal(recon._releaseTimers.size, 0, 'dispose must clear every transient lease timer');
  source.reads[0].pixels.fill(7);
  source.reads[0].resolve();
  await shot.ready;

  assert.equal(targetDisposals, 2, 'each owned target must dispose exactly once');
  assert.equal(encodeJobs.length, 0, 'disposed work must not touch the shared canvas');
  assert.equal(createdUrls.length, 0, 'disposed work must not publish a late object URL');
  assert.equal(shot.dataUrl, null);
  assert.equal(shot.pending, false);
  assert.equal(shot.cancelled, true);
  assert.throws(
    () => recon.capture(source, { score: 0.5, range: 1200 }),
    /disposed ReconCamera/,
  );
});

test('disposing during an active encode prevents a late object URL', async () => {
  const recon = makeRecon();
  const source = makeDelayedCaptureSource();
  const shot = recon.capture(source, { score: 0.5, range: 1200 });
  await flushPromises();
  assert.equal(source.reads.length, 1);
  source.reads[0].pixels.fill(9);
  source.reads[0].resolve();
  await flushPromises();
  assert.equal(encodeJobs.length, 1);

  recon.dispose();
  encodeJobs[0].callback({ exposure: encodeJobs[0].value });
  await shot.ready;
  assert.equal(createdUrls.length, 0);
  assert.equal(shot.dataUrl, null);
  assert.equal(shot.cancelled, true);
});

test('evaluate reuses one stable record per post without corrupting another candidate', () => {
  const recon = makeRecon();
  recon.lineOfSight = () => 1;
  const postA = { aimPoint: new THREE.Vector3(0, 300, -1000) };
  const postB = { aimPoint: new THREE.Vector3(80, 300, -900) };

  const firstA = recon.evaluate(postA);
  const aScore = firstA.score;
  const firstB = recon.evaluate(postB);
  const secondA = recon.evaluate(postA);

  assert.equal(secondA, firstA, 'steady evaluation must reuse the post record');
  assert.notEqual(firstB, firstA, 'different posts need independent records for best-candidate selection');
  assert.equal(firstA.post, postA);
  assert.equal(firstA.score, aScore, 'evaluating another post must not overwrite the held best record');
  assert.equal(firstB.post, postB);
  recon.dispose();
});

test('recon line of sight uses the shared terrain visibility contract', () => {
  const recon = makeRecon();
  const target = new THREE.Vector3(21000, 2500, 6000);
  assert.equal(recon.lineOfSight(recon.camera.position, target), terrainVisibility(recon.camera.position, target));
  recon.dispose();
});

test('capture rejects a raw renderer and requires the Engine post-chain seam', () => {
  const recon = makeRecon();
  const rawRenderer = makeDelayedCaptureSource().renderer;
  assert.throws(
    () => recon.capture(rawRenderer, { score: 0.5, range: 1000 }),
    /Engine\.renderToTarget/,
  );
  recon.dispose();
});

function fakeTimers() {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  let now = 0;
  let nextId = 1;
  const jobs = new Map();
  globalThis.setTimeout = (callback, delay = 0) => {
    const id = nextId++;
    jobs.set(id, { callback, at: now + Math.max(0, Number(delay) || 0) });
    return id;
  };
  globalThis.clearTimeout = (id) => jobs.delete(id);
  return {
    jobs,
    advance(ms) {
      now += ms;
      while (true) {
        const due = [...jobs.entries()]
          .filter(([, job]) => job.at <= now)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        jobs.delete(due[0]);
        due[1].callback();
      }
    },
    restore() {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    },
  };
}

async function finishExposure(source, shot, index) {
  const read = source.reads[index];
  read.pixels.fill(read.value);
  read.resolve();
  await flushPromises();
  const job = encodeJobs[index];
  assert.ok(job, `exposure ${index + 1} should reach the encoder`);
  job.callback({ exposure: job.value });
  await shot.ready;
}

test('transient capture leases bound live URLs at continuous shutter cadence', async () => {
  const clock = fakeTimers();
  try {
    const recon = makeRecon();
    const source = makeDelayedCaptureSource();
    let peakUrls = 0;
    for (let i = 0; i < 18; i++) {
      const shot = recon.capture(source, { score: 0.2, range: 1500 });
      await finishExposure(source, shot, i);
      peakUrls = Math.max(peakUrls, recon._objectUrls.size);
      clock.advance(550);
    }

    assert.ok(peakUrls <= 9, `transient URL peak must remain bounded, observed ${peakUrls}`);
    clock.advance(TRANSIENT_SHOT_RELEASE_MS + 1);
    assert.equal(recon._objectUrls.size, 0);
    assert.equal(revokedUrls.length, createdUrls.length);
    recon.dispose();
  } finally {
    clock.restore();
  }
});

test('retained best shots survive the transient lease and release safely before async ready', async () => {
  const clock = fakeTimers();
  try {
    const recon = makeRecon();
    const source = makeDelayedCaptureSource();

    const retained = recon.capture(source, { score: 0.8, range: 800 });
    recon.retainShot(retained);
    await finishExposure(source, retained, 0);
    clock.advance(TRANSIENT_SHOT_RELEASE_MS * 2);
    assert.equal(retained.dataUrl, 'blob:exposure-1');
    assert.equal(revokedUrls.length, 0, 'best plate must remain owned');
    recon.releaseShot(retained);
    assert.equal(retained.dataUrl, null);
    assert.deepEqual(revokedUrls, ['blob:exposure-1']);

    const pending = recon.capture(source, { score: 0.9, range: 700 });
    recon.retainShot(pending);
    recon.releaseShot(pending);
    source.reads[1].pixels.fill(source.reads[1].value);
    source.reads[1].resolve();
    await pending.ready;
    assert.equal(pending.dataUrl, null, 'released pending best must never publish a late URL');
    assert.equal(pending.released, true);
    recon.dispose();
  } finally {
    clock.restore();
  }
});

test.after(() => {
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
});
