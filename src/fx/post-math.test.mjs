import test from 'node:test';
import assert from 'node:assert/strict';
import { EXPOSURE_DEFAULTS as E, targetExposureEV, adaptLog2, evToMultiplier } from './post/exposure.js';
import { ScreenState } from './ScreenState.js';

test('exposure: reference scene gets the base EV; metering is partial and clamped', () => {
  assert.equal(targetExposureEV(E.refLog), E.baseEV);
  // a scene 2 stops brighter is only pulled down strength * 2 stops
  assert.ok(Math.abs(targetExposureEV(E.refLog + 2) - (E.baseEV - 2 * E.strength)) < 1e-12);
  // extreme scenes hit the clamps
  assert.equal(targetExposureEV(E.refLog + 50), E.baseEV + E.minEV);
  assert.equal(targetExposureEV(E.refLog - 50), E.baseEV + E.maxEV);
  // compensation adds straight through; garbage metering falls back to base
  assert.equal(targetExposureEV(E.refLog, E, 0.5), E.baseEV + 0.5);
  assert.equal(targetExposureEV(NaN), E.baseEV);
  assert.equal(evToMultiplier(0), 1);
  assert.equal(evToMultiplier(-1), 0.5);
});

test('exposure adaptation: frame-rate independent, faster toward bright', () => {
  let a = 0; for (let i = 0; i < 30; i++) a = adaptLog2(a, 2, 1 / 60);
  let b = 0; for (let i = 0; i < 120; i++) b = adaptLog2(b, 2, 1 / 240);
  assert.ok(Math.abs(a - b) < 1e-9);
  const up = adaptLog2(0, 1, 0.1);
  const down = adaptLog2(1, 0, 0.1);
  assert.ok(up > 1 - down, 'brightening adapts faster');
  assert.equal(adaptLog2(NaN, 3, 0.016), 3);
  assert.equal(adaptLog2(1, NaN, 0.016), 1);
});

test('G-LOC: brief high G is survivable, sustained high G greys out, recovery', () => {
  const s = new ScreenState();
  for (let i = 0; i < 30; i++) s.update(1 / 60, { gLoad: 9 }); // 0.5 s snap
  assert.ok(s.grey < 0.25, `snap pull grey ${s.grey}`);
  for (let i = 0; i < 6 * 60; i++) s.update(1 / 60, { gLoad: 8 }); // 6 s sustained
  assert.ok(s.grey > 0.9, `sustained grey ${s.grey}`);
  for (let i = 0; i < 6 * 60; i++) s.update(1 / 60, { gLoad: 1 });
  assert.ok(s.grey < 0.01, `recovered ${s.grey}`);
});

test('redout from sustained negative G', () => {
  const s = new ScreenState();
  for (let i = 0; i < 4 * 60; i++) s.update(1 / 60, { gLoad: -3 });
  assert.ok(s.red > 0.8);
  assert.equal(s.grey, 0);
});

test('hits, explosions and cloud wetness decay', () => {
  const s = new ScreenState();
  s.hit(0.2);
  assert.ok(s.damage > 0.9 && s.smear > 0.9);
  assert.equal(s.explosion(1000, 'large'), 0);
  assert.ok(s.explosion(30, 'large') > 0.7);
  s.update(1 / 60, { inCloud: 1 });
  for (let i = 0; i < 120; i++) s.update(1 / 60, { inCloud: 1 });
  assert.ok(s.wet > 0.9);
  for (let i = 0; i < 180; i++) s.update(1 / 60, { inCloud: 0 });
  assert.ok(s.damage < 0.05 && s.smear < 0.01 && s.flash < 0.01);
  assert.ok(s.wet < 0.5 && s.wet > 0.1, `lens dries over seconds, ${s.wet}`);
});

test('low health heartbeat only when alive and hurt', () => {
  const s = new ScreenState();
  let peak = 0;
  for (let i = 0; i < 120; i++) { s.update(1 / 60, { health: 0.1 }); peak = Math.max(peak, s.lowHealth); }
  assert.ok(peak > 0.6);
  s.update(1 / 60, { health: 0.1, alive: false });
  assert.equal(s.lowHealth, 0);
  s.update(1 / 60, { health: 0.9 });
  assert.equal(s.lowHealth, 0);
});
