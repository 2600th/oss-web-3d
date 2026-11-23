import test from 'node:test';
import assert from 'node:assert/strict';
import { surfaceTargets, flapDemand, demandsFromFlight, bodyRates, actuate, SurfaceRig, THROWS } from './controlSurfaces.js';

const D = Math.PI / 180;
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('pull raises the stabilator trailing edge, push lowers it, within MiG-21 throws', () => {
  near(surfaceTargets({ pitch: 1 }).stab, -16.5 * D);
  near(surfaceTargets({ pitch: -1 }).stab, 7.5 * D);
  near(surfaceTargets({ pitch: 5 }).stab, -16.5 * D); // clamped
});

test('roll right: left aileron down, right aileron up; stabs do not move differentially', () => {
  const t = surfaceTargets({ roll: 1 });
  near(t.aileronL, 20 * D);
  near(t.aileronR, -20 * D);
  near(t.stab, 0);
});

test('flaps come down only at low airspeed', () => {
  assert.equal(flapDemand(250), 0);
  assert.equal(flapDemand(80), 1);
  assert.ok(flapDemand(110) > 0 && flapDemand(110) < 1);
});

test('demands from the flight model: rates over authority, roll sign flipped (rates.z + = roll left)', () => {
  const d = demandsFromFlight({ rates: { x: 0.3, y: 0, z: -1.5 }, pitchAuthority: 0.6, rollAuthority: 3, airspeed: 250 });
  near(d.pitch, 0.5);
  near(d.roll, 0.5);
  assert.equal(d.flap, 0);
});

test('body rates recover a known rotation', () => {
  // 0.1 rad about +X over 0.05 s -> 2 rad/s pitch up
  const h = 0.05;
  const q = { x: Math.sin(h), y: 0, z: 0, w: Math.cos(h) };
  const r = bodyRates({ x: 0, y: 0, z: 0, w: 1 }, q, 0.05);
  near(r.x, 2, 1e-9);
  near(r.y, 0);
  near(r.z, 0);
  const z = bodyRates({ x: 0, y: 0, z: 0, w: 1 }, { x: 0, y: 0, z: 0, w: 1 }, 0.016);
  near(z.x, 0);
});

test('actuators are rate limited and converge', () => {
  const s = { cmd: 0, pos: 0 };
  actuate(s, 1, THROWS.stab.rate, 0.1);
  near(s.cmd, THROWS.stab.rate * 0.1);
  for (let i = 0; i < 200; i++) actuate(s, 0.2, THROWS.stab.rate, 1 / 60);
  near(s.pos, 0.2, 1e-4);
});

test('rig drives named nodes and ignores models without them', () => {
  const nodes = {};
  const root = { getObjectByName: (n) => (nodes[n] ??= { rotation: { x: 0 } }) };
  const rig = new SurfaceRig(root);
  for (let i = 0; i < 120; i++) rig.update(1 / 60, { pitch: 1, roll: 1, flap: 0 });
  near(nodes.stab_L.rotation.x, -16.5 * D, 1e-3);
  near(nodes.stab_R.rotation.x, nodes.stab_L.rotation.x);
  near(nodes.aileron_L.rotation.x, 20 * D, 1e-3);
  near(nodes.aileron_R.rotation.x, -20 * D, 1e-3);
  const bare = new SurfaceRig({ getObjectByName: () => undefined });
  assert.equal(bare.ok, false);
  bare.update(1 / 60, { pitch: 1 });
});
