import test from 'node:test';
import assert from 'node:assert/strict';
import {
  damp, springStep, chaseDistance, fovTarget, noise1, shakeAngles, explosionTrauma, flightRumble,
  wrapAngle, inDanger, easeInOut,
} from './cameraMath.js';

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
