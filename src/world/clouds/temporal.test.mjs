import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HISTORY_MAX, STALE_GAIN, sameSurface, historyBlend, cameraCut, CUT_METRES,
} from './temporal.js';

test('cloud history: a texel with no history takes the new value outright, then averages', () => {
  // marched pixel: 1, 1/2, 1/3 ... a running mean
  let n = 0;
  const alphas = [];
  for (let i = 0; i < 5; i++) {
    const r = historyBlend(n, true, 0.12, 0.02);
    alphas.push(r.alpha);
    n = r.n;
  }
  assert.deepEqual(alphas.map((a) => +a.toFixed(4)), [1, 0.5, 0.3333, 0.25, 0.2]);
  // after k samples the estimate is their mean
  let est = 0; n = 0;
  for (const x of [4, 8, 6, 2]) {
    const r = historyBlend(n, true, 0.12, 0.02);
    est += (x - est) * r.alpha;
    n = r.n;
  }
  assert.ok(Math.abs(est - 5) < 1e-12);
});

test('cloud history: converged texels blend at the floors the layer always had', () => {
  assert.equal(historyBlend(HISTORY_MAX, true, 0.12, 0.02).alpha, 0.12);
  assert.equal(historyBlend(HISTORY_MAX, false, 0.12, 0.02).alpha, 0.02);
  // the count saturates
  assert.equal(historyBlend(HISTORY_MAX, true, 0.12, 0.02).n, HISTORY_MAX);
  assert.equal(historyBlend(HISTORY_MAX - 0.1, false, 0.12, 0.02).n, HISTORY_MAX);
  // the floor takes over once 1 / (n + 1) is under it
  assert.equal(historyBlend(9, true, 0.12, 0.02).alpha, 0.12);
  assert.ok(historyBlend(7, true, 0.12, 0.02).alpha > 0.12);
});

test('cloud history: a bilinear guess counts for a quarter of a marched sample', () => {
  const first = historyBlend(0, false, 0.12, 0.02);
  assert.equal(first.alpha, 1); // nothing else to go on
  assert.equal(first.n, STALE_GAIN);
  // with one marched sample in the history, a guess moves it by a fifth
  assert.ok(Math.abs(historyBlend(1, false, 0.12, 0.02).alpha - 0.2) < 1e-12);
  // alpha never rises with age
  let prev = 2;
  for (let n = 0; n <= HISTORY_MAX; n += 0.25) {
    const a = historyBlend(n, false, 0.12, 0.02).alpha;
    assert.ok(a <= prev);
    prev = a;
  }
});

test('cloud history: same-surface test is relative with a small absolute floor', () => {
  assert.ok(sameSurface(10, 10.5));
  assert.ok(!sameSurface(10, 12));
  assert.ok(sameSurface(0.010, 0.013)); // 3 m apart at 10 m: inside the 4 m floor
  assert.ok(!sameSurface(2, 1e9)); // aircraft against the sky
});

test('cloud history: camera cuts are detected, flight is not', () => {
  const pose = (o = {}) => ({ x: 0, y: 3000, z: 0, fx: 0, fy: 0, fz: -1, tanHalfFov: 0.5, ...o });
  assert.equal(cameraCut(null, pose()), false); // first frame: the reset path handles it
  // Mach 2 at 30 fps is 23 m a frame; a hard turn is a few degrees a frame
  assert.equal(cameraCut(pose(), pose({ z: -23 })), false);
  const a = 8 * Math.PI / 180;
  assert.equal(cameraCut(pose(), pose({ fx: Math.sin(a), fz: -Math.cos(a) })), false);
  assert.equal(cameraCut(pose(), pose({ tanHalfFov: 0.52 })), false);
  // a cut to another shot
  assert.equal(cameraCut(pose(), pose({ x: CUT_METRES + 1 })), true);
  assert.equal(cameraCut(pose(), pose({ fx: 1, fz: 0 })), true);
  assert.equal(cameraCut(pose(), pose({ tanHalfFov: 0.1 })), true);
  assert.equal(cameraCut(pose(), pose({ tanHalfFov: 0.9 })), true);
});
