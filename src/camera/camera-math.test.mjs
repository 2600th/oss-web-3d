import test from 'node:test';
import assert from 'node:assert/strict';
import {
  damp, springStep, chaseDistance, fovTarget, noise1, shakeAngles, explosionTrauma, flightRumble,
  wrapAngle, inDanger, easeInOut, speedOfSound, machCrossing, warpScale, chaseLagFreq, actionShot,
} from './cameraMath.js';
import { TimeWarp } from './timeWarp.js';

test('damp is frame-rate independent', () => {
  let a = 0;
  for (let i = 0; i < 60; i++) a = damp(a, 10, 3, 1 / 60);
  let b = 0;
  for (let i = 0; i < 240; i++) b = damp(b, 10, 3, 1 / 240);
  assert.ok(Math.abs(a - b) < 1e-9, `${a} vs ${b}`);
  assert.ok(Math.abs(a - 10 * (1 - Math.exp(-3))) < 1e-9);
});

test('spring settles on target, overshoots when underdamped, survives a long hitch', () => {
  const s = { x: 0, v: 0 };
  let peak = 0;
  for (let i = 0; i < 600; i++) { springStep(s, 1, 1.2, 0.5, 1 / 60); peak = Math.max(peak, s.x); }
  assert.ok(Math.abs(s.x - 1) < 1e-3);
  assert.ok(peak > 1.05, 'zeta 0.5 should overshoot');
  const c = { x: 0, v: 0 };
  springStep(c, 1, 3, 1, 0.5); // 0.5 s hitch is clamped and sub-stepped
  assert.ok(Number.isFinite(c.x) && c.x <= 1.0001 && c.x > 0);
  const crit = { x: 0, v: 0 };
  let over = 0;
  for (let i = 0; i < 600; i++) { springStep(crit, 1, 1.2, 1, 1 / 60); over = Math.max(over, crit.x); }
  assert.ok(over <= 1.0005, 'critical damping must not overshoot');
});

test('chase distance and FOV grow with speed and burner, stay bounded', () => {
  assert.ok(chaseDistance(400) > chaseDistance(150));
  assert.ok(chaseDistance(10000) <= 21.01);
  const slow = fovTarget({ baseFov: 62, airspeed: 120 });
  const fast = fovTarget({ baseFov: 62, airspeed: 480 });
  const burner = fovTarget({ baseFov: 62, airspeed: 480, reheat: 1 });
  assert.equal(slow, 62);
  assert.ok(fast > slow && burner > fast);
  assert.ok(burner - 62 <= 12.01);
});

test('noise and shake are smooth, bounded and zero without trauma', () => {
  for (let t = 0; t < 20; t += 0.37) assert.ok(Math.abs(noise1(t, 2)) <= 1);
  assert.ok(Math.abs(noise1(1.0, 1) - noise1(1.001, 1)) < 0.01);
  const z = shakeAngles(3.3, 0, 0);
  assert.equal(z.yaw, 0); assert.equal(z.pitch, 0); assert.equal(z.roll, 0);
  const big = shakeAngles(3.3, 1, 0);
  assert.ok(Math.abs(big.roll) <= 0.07 && Math.abs(big.yaw) <= 0.045);
  const half = shakeAngles(3.3, 0.5, 0);
  assert.ok(Math.abs(half.roll - big.roll * 0.25) < 1e-12, 'trauma is squared');
});

test('explosion trauma falls off with distance and size', () => {
  assert.equal(explosionTrauma(1000, 'medium'), 0);
  assert.ok(explosionTrauma(20, 'huge') > explosionTrauma(20, 'small'));
  assert.ok(explosionTrauma(50, 'large') > explosionTrauma(300, 'large'));
  assert.ok(explosionTrauma(0, 'huge') <= 1);
});

test('flight rumble: G buffet, stall, fast and low', () => {
  assert.equal(flightRumble({ gLoad: 1, airspeed: 200, agl: 3000 }), 0);
  assert.ok(flightRumble({ gLoad: 8 }) > 0.3);
  assert.ok(flightRumble({ airspeed: 400, agl: 40 }) > 0.3);
  assert.ok(flightRumble({ gLoad: 12, stallFactor: 1, airspeed: 500, agl: 0 }) <= 1);
});

test('kill cam danger gate', () => {
  assert.equal(inDanger({}), false);
  assert.equal(inDanger({ threats: 1 }), true);
  assert.equal(inDanger({ warning: 'pullup' }), true);
  assert.equal(inDanger({ agl: 100 }), true);
  assert.equal(inDanger({ health: 0.1 }), true);
  assert.equal(inDanger({ crashed: true }), true);
});

test('wrapAngle and easeInOut', () => {
  assert.ok(Math.abs(wrapAngle(3 * Math.PI) - Math.PI) < 1e-9 || Math.abs(wrapAngle(3 * Math.PI) + Math.PI) < 1e-9);
  assert.ok(Math.abs(wrapAngle(-0.5) + 0.5) < 1e-12);
  assert.equal(easeInOut(0), 0);
  assert.equal(easeInOut(1), 1);
  assert.equal(easeInOut(0.5), 0.5);
});

test('speed of sound: ISA lapse, floored at the tropopause', () => {
  assert.ok(Math.abs(speedOfSound(0) - 340.3) < 0.5);
  assert.ok(speedOfSound(6000) < speedOfSound(0));
  assert.ok(Math.abs(speedOfSound(11000) - speedOfSound(15000)) < 1e-9);
  assert.ok(Math.abs(speedOfSound(15000) - 295.1) < 0.5);
});

test('Mach crossing: latches on init, fires once each way, hysteresis', () => {
  const s = {};
  assert.equal(machCrossing(s, 1.2), 0); // already supersonic on the first frame: no thump
  assert.equal(machCrossing(s, 0.99), 0); // inside the hysteresis band
  assert.equal(machCrossing(s, 0.96), -1);
  assert.equal(machCrossing(s, 0.999), 0);
  assert.equal(machCrossing(s, 1.0), 1);
  assert.equal(machCrossing(s, 1.01), 0);
  let n = 0;
  for (let i = 0; i < 200; i++) n += Math.abs(machCrossing(s, 0.99 + 0.015 * Math.sin(i))); // hovering at ~M1
  assert.equal(n, 0);
});

test('warpScale: eases in, holds, eases out, 1 outside the envelope', () => {
  const env = { scale: 0.2, ease: 0.1, hold: 1.5, end: 2.3 };
  assert.equal(warpScale(0, env), 1);
  assert.equal(warpScale(-1, env), 1);
  assert.equal(warpScale(2.3, env), 1);
  assert.ok(Math.abs(warpScale(0.8, env) - 0.2) < 1e-9);
  assert.ok(warpScale(0.05, env) < 1 && warpScale(0.05, env) > 0.2);
  assert.ok(warpScale(1.9, env) > 0.2 && warpScale(1.9, env) < 1);
  // continuous: no step at the joins
  for (const t of [0.1, 1.5]) assert.ok(Math.abs(warpScale(t - 1e-4, env) - warpScale(t + 1e-4, env)) < 1e-2);
});

test('TimeWarp drives game.timeScale relative to the base and restores it', () => {
  const g = { timeScale: 2 };
  const w = new TimeWarp(g);
  w.start({ scale: 0.25, ease: 0.1, hold: 1, end: 1.5 });
  w.update(0.5);
  assert.ok(Math.abs(g.timeScale - 0.5) < 1e-9);
  w.update(1.2);
  assert.equal(g.timeScale, 2);
  assert.equal(w.active, null);
  w.start({ scale: 0.25, ease: 0.1, hold: 1, end: 1.5 });
  w.update(0.5);
  w.cancel();
  assert.equal(g.timeScale, 2);
});

test('chase lag spring loosens with speed and the user lag setting', () => {
  assert.ok(chaseLagFreq(100) > chaseLagFreq(500));
  assert.ok(chaseLagFreq(300, 1.5) < chaseLagFreq(300, 1));
  assert.ok(Number.isFinite(chaseLagFreq(300, 0)) && chaseLagFreq(300, 0) > 0);
});

test('action camera shots are deterministic and range-aware', () => {
  assert.equal(actionShot(0, 800), actionShot(0, 800));
  const far = new Set(), near = new Set();
  for (let t = 0; t < 60; t += 1) { far.add(actionShot(t, 3000)); near.add(actionShot(t, 800)); }
  assert.ok(!far.has('enemy'));
  assert.ok(near.has('enemy') && near.has('shoulder') && near.has('side'));
});

test('springVec recovers from a non-finite target or state', async () => {
  const THREE = await import('three');
  const { springVec, newSpring } = await import('./views.js');
  const s = newSpring();
  springVec(s, new THREE.Vector3(1, 2, 3), 2, 0.9, 1 / 60);
  springVec(s, new THREE.Vector3(NaN, 0, 0), 2, 0.9, 1 / 60);
  assert.ok(Number.isFinite(s.x.x) && Number.isFinite(s.v.x), 'NaN target leaked into the spring');
  s.x.set(NaN, 0, 0);
  const out = springVec(s, new THREE.Vector3(4, 5, 6), 2, 0.9, 1 / 60);
  assert.deepEqual([out.x, out.y, out.z], [4, 5, 6]);
});
