import test from 'node:test';
import assert from 'node:assert/strict';
import { seatUnit, aimAngles, slew, UNIT_RIGS } from './unitRig.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const BOX = { min: [-1.5, 0, -3], max: [1.5, 2, 3] };

test('flat ground: no tilt, no offset, no foundation', () => {
  const s = seatUnit(() => 100, 0, 0, 0.7, BOX, UNIT_RIGS.truck);
  near(s.pitch, 0);
  near(s.roll, 0);
  assert.ok(Math.abs(s.offset + 0.04) < 1e-9);
  assert.equal(s.foundation, null);
});

test('vehicle on a slope rising to the north tilts nose-up and sits on the plane', () => {
  // height rises 0.2 m per metre toward -Z (north): a unit facing north (yaw 0) pitches up
  const h = (x, z) => 100 - 0.2 * z;
  const s = seatUnit(h, 0, 0, 0, BOX, UNIT_RIGS.truck);
  near(s.pitch, Math.atan(0.2), 1e-9);
  near(s.roll, 0);
  assert.ok(Math.abs(s.offset) < 0.1);
  // turned to face east (yaw -90 deg), the same slope is a roll: left side (north) high
  const e = seatUnit(h, 0, 0, -Math.PI / 2, BOX, UNIT_RIGS.truck);
  near(e.pitch, 0, 1e-9);
  near(e.roll, -Math.atan(0.2), 1e-9);
});

test('tilt is clamped and the leftover drop gets a foundation', () => {
  const h = (x, z) => 100 - 0.8 * z; // 39 degrees
  const s = seatUnit(h, 0, 0, 0, BOX, UNIT_RIGS.truck);
  near(s.pitch, UNIT_RIGS.truck.maxTilt);
  assert.ok(s.foundation && s.foundation.depth > 0.25);
});

test('emplacements stay nearly level, part-buried uphill, with a berm downhill', () => {
  const h = (x, z) => 100 + 0.3 * x; // 17 degrees across the bunker
  const s = seatUnit(h, 0, 0, 0, BOX, UNIT_RIGS.bunker);
  near(s.pitch, 0);
  near(s.roll, UNIT_RIGS.bunker.maxTilt); // follows only a few degrees
  // relief left after the tilt: 0.9 - 3 * tan(3 deg); the base sits half way up
  // it, which on an even slope is the height at the origin
  const left = 0.9 - 3 * Math.tan(UNIT_RIGS.bunker.maxTilt);
  near(s.offset, 0, 1e-9);
  assert.ok(s.foundation && Math.abs(s.foundation.depth - (left / 2 + 0.35)) < 1e-9);
  // a dead-level site needs no berm
  assert.equal(seatUnit(() => 50, 0, 0, 0, BOX, UNIT_RIGS.bunker).foundation, null);
});

test('aim angles: target ahead and up, and behind-right', () => {
  const pivot = { position: { x: 0, y: 1, z: 0 } };
  const barrel = { position: { x: 0, y: 0.5, z: 0 } };
  const tmp = { copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; } };
  const a = aimAngles(null, { x: 0, y: 1001.5, z: -1000 }, pivot, barrel, tmp);
  near(a.yaw, 0);
  near(a.pitch, Math.PI / 4);
  const b = aimAngles(null, { x: 100, y: 1.5, z: 100 }, pivot, barrel, tmp);
  near(b.yaw, Math.atan2(-100, -100));
  near(b.pitch, 0);
});

test('slew wraps the short way round', () => {
  near(slew(3.1, -3.1, 0.5, true), 3.1 + (2 * Math.PI - 6.2));
  near(slew(0, 1, 0.25), 0.25);
});
