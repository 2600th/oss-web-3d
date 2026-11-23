import test from 'node:test';
import assert from 'node:assert/strict';
import { Vector3 } from 'three';
import { SKILLS, newMemory, decide, steer, employ } from './brain.js';
import { AiFlight, AIRFRAMES } from './aiFlight.js';
import { findSite, scatterSites, traceValleyRoad, alongPath, pathLength, slopeAt, mulberry32 } from './sites.js';

const D = Math.PI / 180;
const base = {
  range: 5000, closure: 100, angleOff: 10 * D, aspect: 170 * D, speed: 260, agl: 2000, terrainDanger: false,
  missile: null, lockedBy: 'none', role: 'lead', leaderAlive: false, leaderEngaged: false, hasRoute: false,
  targetAlive: true, targetSide: 1, alerted: false, los: true, token: true, leadAngle: 0.5,
};
const aware = () => { const m = newMemory(); m.aware = true; return m; };
const rng = () => 0.5;

test('unaware fighters patrol until the player is detected, locks on, or the group is alerted', () => {
  const k = SKILLS.bandit;
  assert.equal(decide({ ...base, range: 20000 }, newMemory(), k, 0.5, rng), 'patrol');
  assert.equal(decide({ ...base, range: 20000, role: 'wing', leaderAlive: true }, newMemory(), k, 0.5, rng), 'formation');
  assert.notEqual(decide({ ...base, range: 20000, lockedBy: 'acquiring' }, newMemory(), k, 0.5, rng), 'patrol');
  assert.equal(decide({ ...base, range: 11000 }, newMemory(), k, 0.5, rng), 'intercept');
});

test('offensive BFM: pure at missile range, lead for guns, lag to kill an overshoot', () => {
  const k = SKILLS.bandit;
  assert.equal(decide({ ...base, range: 2500 }, aware(), k, 0.5, rng), 'pure');
  assert.equal(decide({ ...base, range: 600, closure: 20 }, aware(), k, 0.5, rng), 'lead');
  assert.equal(decide({ ...base, range: 250, closure: 150 }, aware(), k, 0.5, rng), 'lag');
  // An ace takes the same overshoot into the vertical instead.
  assert.equal(decide({ ...base, range: 250, closure: 150 }, aware(), SKILLS.ace, 0.2, rng), 'yoyo');
});

test('defensive BFM: break into an attacker on the six, scissors when slow and close', () => {
  const k = SKILLS.veteran;
  const onSix = { ...base, angleOff: 160 * D, aspect: 10 * D };
  const m = aware();
  assert.equal(decide({ ...onSix, range: 1800, targetSide: -1 }, m, k, 0.3, rng), 'break');
  assert.equal(m.side, -1, 'breaks toward the side the attacker is on');
  assert.equal(decide({ ...onSix, range: 600, speed: 210 }, aware(), k, 0.3, rng), 'scissors');
  assert.equal(decide({ ...base, angleOff: 90 * D, lockedBy: 'locked', range: 3000 }, aware(), k, 0.3, rng), 'break');
});

test('priorities: terrain beats everything, then missiles, then energy', () => {
  const k = SKILLS.bandit;
  assert.equal(decide({ ...base, terrainDanger: true, missile: { range: 500 } }, aware(), k, 0.5, rng), 'recover');
  assert.equal(decide({ ...base, missile: { range: 900 } }, aware(), k, 0.5, rng), 'evade');
  const m = aware();
  assert.equal(decide({ ...base, range: 2000, speed: 150 }, m, k, 0.5, rng), 'extend');
  assert.equal(decide({ ...base, range: 2000, speed: 200 }, m, k, 0.5, rng), 'extend', 'the extension is flown out');
  for (let i = 0; i < 20; i++) decide({ ...base, range: 2000, speed: 250 }, m, k, 0.5, rng);
  assert.equal(m.mode, 'pure', 'and ends');
});

test('wingmen hold formation, bracket at range, and take over when the leader dies', () => {
  const k = SKILLS.bandit;
  const wing = { ...base, role: 'wing', leaderAlive: true };
  assert.equal(decide({ ...wing, range: 11000 }, aware(), k, 0.5, rng), 'formation');
  assert.equal(decide({ ...wing, range: 6000 }, aware(), k, 0.5, rng), 'bracket');
  assert.equal(decide({ ...wing, range: 6000, leaderAlive: false }, aware(), k, 0.5, rng), 'pure');
});

test('steering: pure points at the target, break turns across it, extend runs away, recover climbs', () => {
  const out = new Vector3();
  const c = {
    position: new Vector3(0, 5000, 0), velocity: new Vector3(0, 0, -250), forward: new Vector3(0, 0, -1),
    targetPos: new Vector3(0, 5000, 2000), targetVel: new Vector3(0, 0, -260), side: 1,
  };
  steer(out, 'pure', c, SKILLS.bandit);
  assert.ok(out.z > 0);
  const br = steer(out, 'break', c, SKILLS.bandit);
  assert.ok(out.x > 0.5 && out.y < 0 && br.throttle > 1, 'breaks right, nose low, in burner');
  steer(out, 'extend', { ...c, targetPos: new Vector3(2000, 5000, 0) }, SKILLS.bandit);
  assert.ok(out.x < -0.5 && out.y > 0, 'away from the target, climbing');
  steer(out, 'recover', c, SKILLS.bandit);
  assert.ok(out.y > 0.5);
  const ev = steer(out, 'evade', { ...c, missilePos: new Vector3(0, 5000, 3000) }, SKILLS.bandit);
  assert.ok(Math.abs(out.x) > Math.abs(out.z) && ev.throttle > 1, 'puts the missile on the beam');
});

test('weapon employment: lock builds over time, needs a token, respects cooldown and ammunition', () => {
  const k = SKILLS.bandit;
  const m = aware();
  m.mode = 'pure'; m.missiles = 1; m.mslCooldown = 0;
  const s = { ...base, range: 2000, angleOff: 5 * D };
  let fired = 0, locking = 0;
  for (let t = 0; t < 4; t += 0.5) { const a = employ(s, m, k, 0.5, rng); fired += a.missile ? 1 : 0; locking += a.locking ? 1 : 0; }
  assert.equal(fired, 1);
  assert.ok(locking >= 5, 'the player gets a lock warning before the shot');
  assert.equal(m.missiles, 0);
  const m2 = aware(); m2.mode = 'pure'; m2.missiles = 2; m2.mslCooldown = 0;
  for (let t = 0; t < 6; t += 0.5) assert.equal(employ({ ...s, token: false }, m2, k, 0.5, rng).missile, false);
  assert.equal(employ({ ...s, range: 400, leadAngle: 0.02 }, m2, k, 0.5, rng).gun, true);
  assert.equal(employ({ ...s, range: 400, leadAngle: 0.3 }, m2, k, 0.5, rng).gun, false);
  // Defensive flares only while something is tracking, and only while they last.
  const m3 = aware(); m3.flares = 2;
  let flares = 0;
  for (let t = 0; t < 20; t += 0.5) flares += employ({ ...s, missile: { range: 800 } }, m3, { ...k, flareChance: 1 }, 0.5, rng).flare ? 1 : 0;
  assert.equal(flares, 2);
});

test('AI flight obeys its G limit, bleeds speed in a sustained turn and banks into it', () => {
  const f = new AiFlight(AIRFRAMES.bandit);
  f.reset(new Vector3(0, 5000, 0), 0, 260);
  let maxG = 0;
  const want = new Vector3();
  for (let i = 0; i < 600; i++) {
    want.set(-f.forward.z, 0, f.forward.x); // always 90 degrees to the right: a sustained max-rate turn
    f.step(1 / 60, want, 0.6, 1);
    maxG = Math.max(maxG, f.gLoad);
  }
  assert.ok(maxG <= AIRFRAMES.bandit.maxG + 0.3, `G ${maxG}`);
  assert.ok(f.speed < 250, 'turning costs energy');
  assert.ok(Math.abs(f.up.y) < 0.8, 'banked');
  assert.ok(Math.abs(f.forward.length() - 1) < 1e-6);
  const ace = new AiFlight(AIRFRAMES.ace);
  assert.ok(ace.cfg.maxG > f.cfg.maxG && ace.cfg.turnRate > f.cfg.turnRate);
});

// ---- sites ------------------------------------------------------------------

// A synthetic valley running east-west along z = 0 that descends to the east,
// with a ridge at z = 3000 and a bump on it.
const height = (x, z) => 3000 + Math.abs(z) * 0.4 - x * 0.01 + (Math.hypot(x - 1000, z - 3000) < 400 ? 300 : 0);

test('findSite: peak finds the bump, valley finds the floor', () => {
  const peak = findSite(800, 2800, 1000, 'peak', { height, step: 50 });
  assert.ok(Math.hypot(peak.x - 1000, peak.z - 3000) < 450);
  const floor = findSite(0, 800, 1500, 'valley', { height, step: 50 });
  assert.ok(Math.abs(floor.z) < 100);
  assert.ok(slopeAt(0, 1000, 30, height) > 0.3);
});

test('a traced road stays on the valley floor and follows it', () => {
  const road = traceValleyRoad(0, 500, 90 * D, { length: 6000, height });
  const last = road[road.length - 1];
  assert.ok(last.x > 4500, 'made progress down the valley');
  assert.ok(road.slice(5).every((p) => Math.abs(p.z) < 260), 'converged on and held the floor');
  assert.ok(Math.abs(pathLength(road) - 6000) < 200);
  const mid = alongPath(road, 3000);
  assert.ok(Math.abs(mid.heading - 90 * D) < 0.5);
  assert.ok(Math.abs(mid.y - height(mid.x, mid.z)) < 30);
});

test('a traced road keeps to the dry bank of a meandering river', () => {
  // A valley along +x with a flat floodplain +-80 m wide and 0.5 walls; a river
  // 40 m wide meanders +-50 m across the floor, carved 3 m into it, so the
  // lowest ground (what the road used to follow) is the riverbed itself.
  const rz = (x) => 50 * Math.sin(x / 600);
  const edge = (x, z) => Math.abs(z - rz(x)) - 20;
  const h = (x, z) => 3000 - x * 0.01 + Math.max(0, Math.abs(z) - 80) * 0.5 - (edge(x, z) < 0 ? 3 : 0);
  // start in the middle of the river
  const road = traceValleyRoad(0, 0, 90 * D, { length: 6000, height: h, edge });
  assert.deepEqual(road, traceValleyRoad(0, 0, 90 * D, { length: 6000, height: h, edge }), 'deterministic');
  const L = pathLength(road);
  assert.ok(Math.abs(L - 6000) < 600, `length kept: ${L}`);
  assert.ok(road[road.length - 1].x > 5000, 'general direction kept');
  const o = {};
  let minEdge = Infinity, near = 0, n = 0;
  for (let d = 0; d <= L; d += 5) {
    alongPath(road, d, o);
    const e = edge(o.x, o.z);
    minEdge = Math.min(minEdge, e);
    if (e < 5) near++;
    n++;
    assert.ok(Math.abs(o.z) < 110, `stayed on the floor, not the wall: z ${o.z.toFixed(0)} at ${d} m`);
  }
  assert.ok(minEdge > 0, `never in the water (closest ${minEdge.toFixed(1)} m)`);
  assert.ok(near / n < 0.05, `rarely at the waterline: ${(100 * near / n).toFixed(1)} %`);
});

test('sites avoid the water too', () => {
  const edge = (x, z) => Math.abs(z) - 30; // a 60 m river along the flat floor
  const flat = () => 3000;
  for (const s of scatterSites(0, 0, 8, { seed: 3, height: flat, edge, rMin: 20, rMax: 120 })) assert.ok(edge(s.x, s.z) >= 6, `site at z ${s.z}`);
  const v = findSite(0, 0, 300, 'valley', { height: (x, z) => 3000 + Math.abs(z) * 0.1, edge, step: 10 });
  assert.ok(edge(v.x, v.z) > 0, 'valley site on the bank, not in the river');
});

test('scatterSites is deterministic and keeps units apart', () => {
  const a = scatterSites(0, 0, 6, { seed: 7, height });
  const b = scatterSites(0, 0, 6, { seed: 7, height });
  assert.deepEqual(a, b);
  assert.equal(a.length, 6);
  for (let i = 0; i < a.length; i++) for (let j = i + 1; j < a.length; j++) assert.ok(Math.hypot(a[i].x - a[j].x, a[i].z - a[j].z) >= 28);
  assert.notEqual(mulberry32(1)(), mulberry32(2)());
});
