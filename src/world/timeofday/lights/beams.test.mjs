import test from 'node:test';
import assert from 'node:assert/strict';
import { BEAM, BEAM_TIERS, beamTier, beamSlots } from './beams.js';

const at = (x, y, z) => ({ object3d: { matrixWorld: { elements: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1] } } });

test('beam tiers scale down: fewer beams, shorter, no in-scatter march on low', () => {
  const names = ['low', 'medium', 'high', 'ultra'];
  for (let i = 1; i < names.length; i++) {
    const a = BEAM_TIERS[names[i - 1]], b = BEAM_TIERS[names[i]];
    assert.ok(a.capacity < b.capacity && a.steps < b.steps && a.range <= b.range && a.maxDistance < b.maxDistance, names[i]);
  }
  assert.equal(BEAM_TIERS.low.steps, 0);
  assert.deepEqual(beamTier('nonsense'), BEAM_TIERS.high);
  const t = beamTier('low');
  t.capacity = 999;
  assert.equal(BEAM_TIERS.low.capacity, 12, 'beamTier returns a copy');
});

test('beams never show by day and are fully on at night', () => {
  const [a, b] = BEAM.nightOn;
  assert.ok(a > 0 && a < b && b <= 1);
});

test('beamSlots keeps the nearest within range, capped', () => {
  const items = [at(0, 0, 500), at(0, 0, 50), at(0, 0, 20000), at(0, 0, 100), { object3d: null }, at(0, 0, 10)];
  const cfg = { capacity: 2, maxDistance: 1000 };
  const s = beamSlots(items, { x: 0, y: 0, z: 0 }, cfg);
  assert.deepEqual(s.map((it) => it.object3d.matrixWorld.elements[14]), [10, 50]);
  const all = beamSlots(items, { x: 0, y: 0, z: 0 }, { capacity: 10, maxDistance: 1000 });
  assert.equal(all.length, 4, 'out of range and missing objects dropped');
  assert.equal(beamSlots([], { x: 0, y: 0, z: 0 }, cfg).length, 0);
});
