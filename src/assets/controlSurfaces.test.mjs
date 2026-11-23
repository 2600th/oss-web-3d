import test from 'node:test';
import assert from 'node:assert/strict';
import {
  surfaceTargets, flapDemand, demandsFromFlight, demandsFromRates, bodyRates, actuate, SurfaceRig, THROWS,
  rudderTravel, airbrakeTravel, MAX_YAW_RATE, SURFACE_NODES,
} from './controlSurfaces.js';

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

test('rudder: + yaw is trailing edge right, travel washes out with airspeed', () => {
  near(surfaceTargets({ yaw: 1, airspeed: 120 }).rudder, 25 * D);
  near(surfaceTargets({ yaw: -1, airspeed: 120 }).rudder, -25 * D);
  near(surfaceTargets({ yaw: 3, airspeed: 120 }).rudder, 25 * D); // clamped
  near(rudderTravel(500), THROWS.rudder.highSpeed);
  assert.ok(rudderTravel(300) < rudderTravel(150) && rudderTravel(300) > rudderTravel(450));
  near(surfaceTargets({}).rudder, 0);
});

test('airbrakes: 35 deg open, blown back at high speed, never negative', () => {
  near(surfaceTargets({ airbrake: 1, airspeed: 200 }).airbrake, 35 * D);
  near(surfaceTargets({ airbrake: 1, airspeed: 600 }).airbrake, 35 * D * THROWS.airbrake.blowback);
  near(surfaceTargets({ airbrake: -1 }).airbrake, 0);
  near(airbrakeTravel(100), 35 * D);
});

test('player demands carry the commanded yaw and airbrake; dead jets centre the rudder', () => {
  const f = { rates: { x: 0, y: 0, z: 0 }, airspeed: 200, yawCommand: 0.5, airbrake: 1 };
  const d = demandsFromFlight(f);
  near(d.yaw, 0.5);
  near(d.airbrake, 1);
  near(d.airspeed, 200);
  // older flight models without yawCommand: from the yaw rate (rates.y + = yaw LEFT)
  const r = demandsFromFlight({ rates: { x: 0, y: -MAX_YAW_RATE / 2, z: 0 }, airspeed: 200 });
  near(r.yaw, 0.5);
  near(r.airbrake, 0);
  near(demandsFromFlight({ ...f, crashed: true }).yaw, 0);
});

test('hostile demands from body rates and deceleration', () => {
  const d = demandsFromRates({ x: 0.2, y: MAX_YAW_RATE, z: -1.75 }, 250, 0, { turnRate: 0.4, roll: 3.5 });
  near(d.pitch, 0.5);
  near(d.roll, 0.5);
  near(d.yaw, -1); // yawing left
  near(d.airbrake, 0);
  assert.equal(demandsFromRates({ x: 0, y: 0, z: 0 }, 250, -12).airbrake, 1);
  assert.ok(demandsFromRates({ x: 0, y: 0, z: 0 }, 250, -3).airbrake === 0);
});

test('rig drives rudder and both airbrakes at their actuator rates', () => {
  const nodes = {};
  const root = { getObjectByName: (n) => (nodes[n] ??= { rotation: { x: 0 } }) };
  const rig = new SurfaceRig(root);
  // airbrakes take about a second: half way after 0.5 s
  for (let i = 0; i < 30; i++) rig.update(1 / 60, { yaw: 1, airbrake: 1, airspeed: 120 });
  assert.ok(nodes.airbrake_L.rotation.x > 12 * D && nodes.airbrake_L.rotation.x < 20 * D, `${nodes.airbrake_L.rotation.x / D}`);
  near(nodes.airbrake_R.rotation.x, nodes.airbrake_L.rotation.x);
  assert.ok(nodes.rudder.rotation.x > 20 * D);
  for (let i = 0; i < 120; i++) rig.update(1 / 60, { yaw: 1, airbrake: 1, airspeed: 120 });
  near(nodes.airbrake_L.rotation.x, 35 * D, 1e-3);
  near(nodes.rudder.rotation.x, 25 * D, 1e-3);
  rig.reset({});
  near(nodes.rudder.rotation.x, 0);
  near(nodes.airbrake_L.rotation.x, 0);
});

test('every pivot the rig drives exists in the shipped MiG GLBs', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  for (const f of ['mig21.glb', 'mig21_hostile.glb', 'mig21_hostile_lod1.glb']) {
    const buf = readFileSync(fileURLToPath(new URL(`../../public/models/${f}`, import.meta.url)));
    const json = JSON.parse(buf.subarray(20, 20 + buf.readUInt32LE(12)).toString('utf8'));
    const names = new Set(json.nodes.map((n) => n.name));
    for (const n of SURFACE_NODES) assert.ok(names.has(n), `${f}: ${n} missing`);
  }
});
