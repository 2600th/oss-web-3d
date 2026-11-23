import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FIRE, fireTemperature, fireColor, litKeep, clipSegmentNear, makePath, emitAlong, sizeForRate, blastSmokeLife,
  makeBolt, strokeEnvelope, ScorchRing,
} from './fxmath.js';
import { GUN_MUZZLE } from './sockets.js';

// ------------------------------------------------------------------ fire --

test('fire ramp: blackbody order, never blue or magenta', () => {
  for (let h = 0; h <= FIRE.hMax; h += 0.05) {
    const [r, g, b] = fireColor(h);
    assert.ok(r >= g - 1e-9 && g >= b - 1e-9, `heat ${h.toFixed(2)}: r ${r} g ${g} b ${b}`);
    assert.ok(r >= 0 && g >= 0 && b >= 0);
  }
});

test('fire ramp: hotter is brighter and whiter', () => {
  let prev = fireColor(0.05);
  for (let h = 0.1; h <= FIRE.hMax; h += 0.05) {
    const c = fireColor(h);
    assert.ok(c[0] > prev[0], 'brightness rises with heat');
    assert.ok(c[1] / c[0] > prev[1] / prev[0], 'green share rises (red -> orange -> yellow)');
    prev = c;
  }
  // dull red at the bottom, yellow-white at the top, orange at heat 1
  const lo = fireColor(0.3), mid = fireColor(1), hi = fireColor(FIRE.hMax);
  assert.ok(lo[1] / lo[0] < 0.2, `dull red ${lo}`);
  assert.ok(mid[1] / mid[0] > 0.3 && mid[1] / mid[0] < 0.6, `orange ${mid}`);
  assert.ok(hi[1] / hi[0] > 0.55, `yellow ${hi}`);
  assert.ok(hi[0] / lo[0] > 30, 'the core outshines the embers by more than an order of magnitude');
});

test('fire ramp: temperatures and clamping', () => {
  assert.equal(fireTemperature(0), FIRE.t0);
  assert.equal(fireTemperature(1), FIRE.t0 + FIRE.t1);
  assert.equal(fireTemperature(99), fireTemperature(FIRE.hMax));
  assert.equal(fireTemperature(-1), FIRE.t0);
});

test('hot puffs lose their lit (scattered) colour', () => {
  assert.equal(litKeep(0), 1);
  assert.ok(Math.abs(litKeep(1) - 0.15) < 1e-9);
  assert.equal(litKeep(5), litKeep(1));
});

// --------------------------------------------------------------- ribbons --

test('near clip: both in front is untouched, both behind is culled', () => {
  assert.deepEqual(clipSegmentNear(-10, -20, -0.6), { visible: true, ta: 0, tb: 1 });
  assert.equal(clipSegmentNear(5, 1, -0.6).visible, false);
  assert.equal(clipSegmentNear(-0.5, -0.1, -0.6).visible, false, 'inside the near distance counts as behind');
});

test('near clip: a segment through the camera plane is cut at the plane', () => {
  const az = -10, bz = 10;
  const r = clipSegmentNear(az, bz, -0.6);
  assert.ok(r.visible);
  assert.equal(r.ta, 0);
  const zAtB = az + (bz - az) * r.tb;
  assert.ok(Math.abs(zAtB + 0.6) < 1e-9, `clipped end on the plane, z ${zAtB}`);
  const s = clipSegmentNear(10, -10, -0.6);
  assert.equal(s.tb, 1);
  assert.ok(Math.abs(10 + (-20) * s.ta + 0.6) < 1e-9);
});

// ----------------------------------------------------- per-metre emission --

test('per-metre emission: same spacing at any speed and frame rate', () => {
  for (const [speed, fps] of [[250, 60], [250, 24], [40, 144], [600, 30]]) {
    const path = makePath();
    const pts = [];
    const dt = 1 / fps;
    for (let i = 0; i <= fps * 2; i++) emitAlong(path, speed * dt * i, 0, 0, 1.5, 1000, (x) => pts.push(x));
    for (let i = 1; i < pts.length; i++) {
      const gap = pts[i] - pts[i - 1];
      assert.ok(Math.abs(gap - 1.5) < 1e-6, `speed ${speed} fps ${fps}: gap ${gap}`);
    }
    const expected = Math.floor((speed * 2) / 1.5) + 1;
    assert.ok(Math.abs(pts.length - expected) <= 1, `count ${pts.length} vs ${expected}`);
  }
});

test('per-metre emission: carry across frames, cap, teleport', () => {
  const path = makePath();
  let n = emitAlong(path, 0, 0, 0, 10, 100, () => {});
  assert.equal(n, 1, 'first call lays one puff at the source');
  n = emitAlong(path, 6, 0, 0, 10, 100, () => {});
  assert.equal(n, 0);
  const got = [];
  emitAlong(path, 12, 0, 0, 10, 100, (x, y, z, k) => got.push([x, k]));
  assert.equal(got.length, 1);
  assert.ok(Math.abs(got[0][0] - 10) < 1e-9, 'second puff exactly 10 m from the first');
  assert.ok(got[0][1] > 0 && got[0][1] <= 1);
  // the cap stretches the spacing evenly instead of dropping the tail
  const capped = [];
  emitAlong(path, 1012, 0, 0, 1, 50, (x) => capped.push(x));
  assert.equal(capped.length, 50);
  assert.ok(Math.abs(capped[49] - 1012) < 1e-6 || capped[49] < 1012 + 1e-6);
  // a jump across the map restarts the path (no 3 km line of smoke)
  const jumped = [];
  emitAlong(path, 9000, 0, 0, 1, 50, (x) => jumped.push(x));
  assert.deepEqual(jumped, [9000]);
});

test('tier compensation keeps coverage: size x 1/sqrt(rate)', () => {
  assert.equal(sizeForRate(1), 1);
  for (const r of [0.5, 0.75, 1.3]) {
    const k = sizeForRate(r);
    assert.ok(Math.abs(r * k * k - 1) < 1e-9, 'count x area constant');
  }
});

test('blast smoke lingers longer for bigger blasts, within the pool life span', () => {
  assert.ok(blastSmokeLife(6.5) < blastSmokeLife(14));
  assert.ok(blastSmokeLife(25) >= 40 && blastSmokeLife(25) <= 60, 'large: most of a minute');
  assert.ok(blastSmokeLife(500) < 64);
  assert.ok(blastSmokeLife(1) >= 12);
});

// ------------------------------------------------------------- lightning --

function lcg(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

test('bolt: a connected channel from cloud to ground, with branches', () => {
  const top = { x: 0, y: 5600, z: 0 }, bottom = { x: 300, y: 200, z: -100 };
  const segs = makeBolt(lcg(7), top, bottom, { depth: 6 });
  const main = segs.filter((s) => s.k === 1);
  assert.equal(main.length, 64, 'depth 6: 64 main segments');
  assert.deepEqual(main[0].a, [0, 5600, 0]);
  assert.deepEqual(main[main.length - 1].b, [300, 200, -100]);
  for (let i = 1; i < main.length; i++) assert.deepEqual(main[i].a, main[i - 1].b, 'main channel is continuous');
  const branches = segs.filter((s) => s.k < 1);
  assert.ok(branches.length > 0, 'some branches');
  for (const b of branches) assert.ok(b.w < main[0].w && b.k <= 0.45 + 1e-9);
  // branches go down, not up into the cloud
  const ys = branches.map((s) => s.b[1]);
  assert.ok(Math.max(...ys) <= 5600);
});

test('bolt: deterministic for a seed', () => {
  const a = makeBolt(lcg(3), { x: 0, y: 1000, z: 0 }, { x: 0, y: 0, z: 0 });
  const b = makeBolt(lcg(3), { x: 0, y: 1000, z: 0 }, { x: 0, y: 0, z: 0 });
  assert.deepEqual(a, b);
});

test('stroke envelope: sharp rise, fast fall, restrikes', () => {
  const strokes = [{ t: 0, amp: 1 }, { t: 0.12, amp: 0.6 }];
  assert.equal(strokeEnvelope(strokes, -0.01), 0);
  assert.ok(strokeEnvelope(strokes, 0.008) > 0.8);
  assert.ok(strokeEnvelope(strokes, 0.1) < 0.2);
  assert.ok(strokeEnvelope(strokes, 0.13) > 0.4, 'the restroke lights the channel again');
  assert.ok(strokeEnvelope(strokes, 0.5) < 0.01);
});

// -------------------------------------------------------------- scorches --

test('scorch ring: newest overwrites oldest, packed mirrors the arrays', () => {
  const r = new ScorchRing(3);
  assert.equal(r.count, 0);
  assert.equal(r.age(0, 10), Infinity);
  for (let i = 0; i < 4; i++) r.add(i * 10, 1, i * 20, 5 + i, i);
  assert.equal(r.count, 3);
  assert.equal(r.version, 4);
  // slot 0 now holds the 4th mark
  assert.deepEqual([...r.packed.slice(0, 4)], [30, 60, 8, 3]);
  assert.deepEqual([...r.positions.slice(0, 3)], [30, 1, 60]);
  assert.equal(r.age(0, 5), 2);
  // terrain feed: oldest first, ages from now
  const l = r.list(5);
  assert.deepEqual(l.map((s) => s.x), [10, 20, 30]);
  assert.deepEqual(l.map((s) => s.age), [4, 3, 2]);
  assert.equal(l[2].radius, 8);
  assert.equal(l[2].z, 60);
  r.clear();
  assert.equal(r.list(5).length, 0);
  assert.equal(r.count, 0);
  assert.equal(r.age(1, 5), Infinity);
});

// ----------------------------------------------------------------- gun --

test('gun socket: under the nose, behind the radome, on the centreline', () => {
  assert.equal(GUN_MUZZLE.x, 0);
  assert.ok(GUN_MUZZLE.y < -1 && GUN_MUZZLE.y > -1.6, 'belly height');
  assert.ok(GUN_MUZZLE.z < -2 && GUN_MUZZLE.z > -4, 'a few metres ahead of the centre, far behind the 7 m nose tip');
  assert.ok(Object.isFrozen(GUN_MUZZLE));
});
