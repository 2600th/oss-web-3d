import test from 'node:test';
import assert from 'node:assert/strict';
import { attachNavLights, MIG21_LAMPS } from './fixtures.js';

const mock = () => {
  const added = [];
  return { added, add: (o) => (added.push(o), o) };
};

test('nav lights: red left (-X), green right (+X), on the measured lenses', () => {
  const s = mock();
  attachNavLights(s, {}, { phase: 0 });
  const [red, green, tail, beacon, strobe] = s.added;
  assert.ok(red.color[0] > red.color[1] && red.offset.x < 0, 'red on the left wing');
  assert.ok(green.color[1] > green.color[0] && green.offset.x > 0, 'green on the right wing');
  assert.deepEqual([green.offset.x, green.offset.y, green.offset.z], MIG21_LAMPS.wing);
  // within a few cm of the lens (2.81, -0.746, 1.419), not floating over the wing
  assert.ok(Math.abs(green.offset.y + 0.746) < 0.03 && Math.abs(green.offset.z - 1.419) < 0.05);
  assert.ok(Math.abs(tail.offset.y - 1.704) < 0.03 && Math.abs(tail.offset.z - 7.635) < 0.05);
  // beacon on the spine skin (top y 0.381 at z 1.2), belly strobe under the skin (-1.444 at z 3)
  assert.ok(beacon.offset.y > 0.381 && beacon.offset.y < 0.45);
  assert.ok(strobe.offset.y < -1.444 && strobe.offset.y > -1.52);
});

test('nav lights: each lamp faces its own side, so the far wing light is not seen across the jet', () => {
  const s = mock();
  attachNavLights(s, {}, { phase: 0 });
  const [red, green, tail, beacon, strobe] = s.added;
  const facing = (l, v) => {
    const n = Math.hypot(l.dir.x, l.dir.y, l.dir.z), m = Math.hypot(...v);
    return (l.dir.x * v[0] + l.dir.y * v[1] + l.dir.z * v[2]) / n / m;
  };
  // camera high on the left, behind the wing (the evidence shot): green hidden, red seen
  const fromLeft = [-0.72, 0.42, 0.56];
  assert.ok(facing(green, fromLeft) < green.cone - 0.1, 'green culled from the left');
  assert.ok(facing(red, fromLeft) > red.cone + 0.12, 'red seen from the left');
  assert.ok(facing(tail, [0, 0.3, 1]) > 0.9 && facing(beacon, [0, 1, 0]) > 0.9 && facing(strobe, [0, -1, 0]) > 0.9);
});

test('nav lights: steady lights are small and dim by day, the flashers stay visible', () => {
  const s = mock();
  attachNavLights(s, {}, { phase: 0 });
  const [red, green, tail, beacon, strobe] = s.added;
  for (const l of [red, green, tail]) {
    assert.ok(l.day <= 0.15 && l.daySize <= 0.3 && !l.blink, 'steady light: a small point in daylight');
  }
  for (const l of [beacon, strobe]) assert.ok(l.blink && l.day >= 0.5, 'flasher visible by day');
});
