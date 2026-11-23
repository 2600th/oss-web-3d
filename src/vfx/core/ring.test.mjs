import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Ring, DirtyRanges, Pool, explosionRadius, plumeState, vapourAmount, vapourCone, speedOfSound, rankLights,
} from './ring.js';

test('Ring recycles the oldest slots first', () => {
  const r = new Ring(4);
  assert.deepEqual([r.next(), r.next(), r.next(), r.next(), r.next(), r.next()], [0, 1, 2, 3, 0, 1]);
  assert.equal(r.total, 6);
});

test('DirtyRanges merges contiguous slots and resets', () => {
  const d = new DirtyRanges(100, 8);
  for (const i of [5, 6, 7, 20, 21, 99, 0, 6]) d.mark(i);
  assert.deepEqual(d.flush(), [[0, 1], [5, 3], [20, 2], [99, 1]]);
  assert.equal(d.empty, true);
  assert.deepEqual(d.flush(), []);
});

test('DirtyRanges caps the range count by bridging the smallest gaps', () => {
  const d = new DirtyRanges(1000, 2);
  for (const i of [0, 2, 4, 500]) d.mark(i);
  const ranges = d.flush();
  assert.deepEqual(ranges, [[0, 5], [500, 1]]);
  // every marked slot is still covered
  for (const i of [0, 2, 4, 500]) assert.ok(ranges.some(([s, c]) => i >= s && i < s + c));
});

test('DirtyRanges covers the whole buffer when everything was touched', () => {
  const d = new DirtyRanges(8, 2);
  for (let i = 0; i < 8; i++) d.mark(i);
  assert.deepEqual(d.flush(), [[0, 8]]);
});

test('Pool reuses free items and steals the oldest when exhausted', () => {
  const p = new Pool(2, (i) => ({ i }));
  const a = p.acquire(), b = p.acquire();
  assert.notEqual(a, b);
  assert.equal(p.activeCount, 2);
  const c = p.acquire(); // full: steals the oldest (a)
  assert.equal(c, a);
  p.release(b);
  assert.equal(p.acquire(), b);
});

test('explosion sizes scale monotonically and accept metres', () => {
  const r = ['small', 'medium', 'large', 'huge'].map(explosionRadius);
  for (let i = 1; i < r.length; i++) assert.ok(r[i] > r[i - 1]);
  assert.equal(explosionRadius(12.5), 12.5);
  assert.equal(explosionRadius('nonsense'), explosionRadius('medium'));
  assert.equal(explosionRadius(undefined), explosionRadius('medium'));
});

test('plume: dry thrust is short and has no diamonds; reheat is long with diamonds', () => {
  const idle = plumeState(0.2, false), dry = plumeState(0.85, false), wet = plumeState(1, true), wetN = plumeState(1, 1);
  assert.equal(idle.diamonds, 0);
  assert.equal(dry.diamonds, 0);
  assert.ok(dry.length > idle.length);
  assert.ok(wet.length > dry.length * 2);
  assert.ok(wet.diamonds >= 3);
  assert.ok(wet.core > dry.core * 3);
  assert.ok(Math.abs(wet.length - wetN.length) < 1e-9, 'boolean reheat at full throttle equals reheat = 1');
  assert.equal(plumeState(undefined, undefined).diamonds, 0);
});

test('vapour needs load or alpha, and speed', () => {
  assert.equal(vapourAmount(1, 0.03, 250, 4000), 0);
  assert.ok(vapourAmount(8, 0.1, 250, 4000) > 0.9);
  assert.ok(vapourAmount(2, 0.35, 250, 4000) > 0.5);
  assert.equal(vapourAmount(8, 0.3, 80, 4000), 0);
  assert.ok(vapourAmount(8, 0.1, 250, 10000) < vapourAmount(8, 0.1, 250, 4000));
});

test('vapour cone only appears in the transonic band', () => {
  assert.equal(vapourCone(0.8), 0);
  assert.ok(vapourCone(0.97) > 0.9);
  assert.equal(vapourCone(1.2), 0);
});

test('speed of sound falls with altitude then holds in the stratosphere', () => {
  assert.ok(Math.abs(speedOfSound(0) - 340.3) < 0.5);
  assert.ok(speedOfSound(6000) < speedOfSound(0));
  assert.equal(speedOfSound(12000), speedOfSound(20000));
});

test('rankLights keeps the lights that are brightest at the camera', () => {
  const cam = { x: 0, y: 0, z: 0 };
  const req = [
    { x: 5000, y: 0, z: 0, intensity: 1e6 },  // huge but far
    { x: 10, y: 0, z: 0, intensity: 2000 },   // modest, close
    { x: 300, y: 0, z: 0, intensity: 500 },   // weak, mid
  ];
  const top = rankLights(req, cam, 2);
  assert.equal(top.length, 2);
  assert.equal(top[0].x, 10);
  assert.equal(top[1].x, 5000);
});
