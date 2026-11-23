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
  // past maxTilt the berm would be a 2 m plinth: the truck leans on to its steep limit
  const steep = Math.min(UNIT_RIGS.truck.maxTilt * 2, UNIT_RIGS.truck.maxTilt + 10 * Math.PI / 180);
  near(s.pitch, steep);
  assert.ok(s.foundation && s.foundation.depth > 0.25);
  // on ground it can follow within maxTilt + a bit, it leans only as far as it needs to
  const m = seatUnit((x, z) => 100 - 0.6 * z, 0, 0, 0, BOX, UNIT_RIGS.truck); // 31 degrees
  assert.ok(m.pitch > UNIT_RIGS.truck.maxTilt && m.pitch < Math.atan(0.6));
  assert.ok(m.hang <= 0.35, `hang ${m.hang}`);
});

test('emplacements stay nearly level and dig into the uphill side up to maxBury', () => {
  const spec = UNIT_RIGS.bunker;
  // a gentle cross-slope: what the tilt leaves over fits in maxBury, so the low
  // edge is set `sink` into the ground and nothing needs a berm
  const gentle = (x) => 100 + 0.15 * x; // 8.5 degrees across the bunker
  const g = seatUnit(gentle, 0, 0, 0, BOX, spec);
  near(g.pitch, 0);
  near(g.roll, spec.maxTilt); // follows only a few degrees
  const leftG = 3 * (0.15 - Math.tan(spec.maxTilt));
  near(g.relief, leftG, 1e-9);
  near(g.hang, 0, 1e-9);
  near(g.bury, leftG + spec.sink, 1e-9);
  assert.ok(g.bury <= spec.maxBury);
  assert.equal(g.foundation, null);
  // steeper: the uphill edge goes exactly maxBury in, the rest is a berm downhill
  const steep = (x) => 100 + 0.4 * x; // 22 degrees
  const s = seatUnit(steep, 0, 0, 0, BOX, spec);
  const left = 3 * (0.4 - Math.tan(spec.maxTilt));
  near(s.bury, spec.maxBury, 1e-9);
  near(s.hang, left - spec.maxBury, 1e-9);
  assert.ok(s.foundation && Math.abs(s.foundation.depth - (s.hang + 0.35)) < 1e-9);
  // a dead-level site needs no berm
  assert.equal(seatUnit(() => 50, 0, 0, 0, BOX, spec).foundation, null);
});

test('sloped seat: no footprint edge hangs and none is buried past maxBury', () => {
  // A slope plus a bump and a twist: the old corner-only seat put the base 65 %
  // of the way up the corner relief, so the low corners showed daylight.
  const h = (x, z) => 3000 + 0.25 * x - 0.12 * z + 0.04 * x * z + 0.3 * Math.sin(x * 0.9) * Math.cos(z * 0.7);
  for (const type of ['truck', 'aaa', 'sam', 'radar', 'flak', 'sangar', 'tent', 'bunker', 'supply', 'manpads']) {
    const spec = UNIT_RIGS[type];
    for (const yaw of [0, 0.6, 2.1, -2.7]) {
      const s = seatUnit(h, 7, -4, yaw, BOX, spec);
      // check every edge point (denser than the seat's own grid) against the seated, tilted model
      const c = Math.cos(yaw), sn = Math.sin(yaw);
      const cp = Math.cos(s.pitch), sp = Math.sin(s.pitch), cr = Math.cos(s.roll), sr = Math.sin(s.roll);
      const base = h(7, -4) + s.offset;
      let gap = -Infinity, sunk = -Infinity;
      for (let k = 0; k <= 40; k++) {
        const t = k / 40;
        for (const [lx, lz] of [[-1.5 + 3 * t, -3], [-1.5 + 3 * t, 3], [-1.5, -3 + 6 * t], [1.5, -3 + 6 * t]]) {
          // the edge point through the model's own rotation (order 'YXZ': roll, then pitch)
          const X = lx * cr, Y = lx * sr * cp - lz * sp, Z = lx * sr * sp + lz * cp;
          const y = base + Y;
          const g = h(7 + X * c + Z * sn, -4 - X * sn + Z * c);
          gap = Math.max(gap, y - g);
          sunk = Math.max(sunk, g - y);
        }
      }
      // between grid samples the ground can dip a little further: 5 cm of slack
      if (s.foundation) assert.ok(s.foundation.depth >= gap + 0.15, `${type} ${yaw}: berm ${s.foundation.depth} under a ${gap} gap`);
      else assert.ok(gap < 0.12, `${type} ${yaw}: edge hangs ${gap.toFixed(3)} m with no berm`);
      assert.ok(sunk < spec.maxBury + 0.08, `${type} ${yaw}: edge buried ${sunk.toFixed(3)} m (max ${spec.maxBury})`);
    }
  }
});

test('a vehicle on an even slope within maxTilt lies flat on it, wheels just set in', () => {
  const h = (x, z) => 4200 + 0.3 * x + 0.2 * z; // 19.8 degrees, under the truck's 26
  const s = seatUnit(h, 10, 20, 0.9, BOX, UNIT_RIGS.truck);
  near(s.relief, 0, 1e-6);
  near(s.offset, -UNIT_RIGS.truck.sink, 1e-6);
  assert.equal(s.foundation, null);
  // tilt equals the ground's slope in the unit's own frame
  const c = Math.cos(0.9), sn = Math.sin(0.9);
  near(Math.tan(s.pitch), -(0.3 * sn + 0.2 * c), 1e-6); // - d h / d lz
  near(Math.tan(s.roll), (0.3 * c - 0.2 * sn) * Math.cos(s.pitch), 1e-6); // d h / d lx, through the pitch
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
