import test from 'node:test';
import assert from 'node:assert/strict';
import { nextScale, ADAPTIVE_DEFAULTS } from './AdaptiveResolution.js';

const o = { ...ADAPTIVE_DEFAULTS, budgetMs: 10, minScale: 0.6 };

test('over budget drops at least one step, proportionally to the overshoot', () => {
  assert.equal(nextScale(1, 10.5, o), 0.95);
  const s = nextScale(1, 40, o); // 4x over: sqrt(0.9/4) = 0.47 -> clamped
  assert.equal(s, 0.6);
  assert.ok(nextScale(0.8, 14, o) < 0.8);
});

test('never below minScale, never above maxScale', () => {
  assert.equal(nextScale(0.6, 100, o), 0.6);
  assert.equal(nextScale(1, 1, o), 1);
});

test('climbs one step only with headroom at the next scale', () => {
  assert.equal(nextScale(0.8, 4, o), 0.85);
  // 6.8 ms at 0.8 -> ~7.7 ms at 0.85, over 72 % of 10 ms: stay
  assert.equal(nextScale(0.8, 6.8, o), 0.8);
});

test('inside the band nothing changes (no oscillation)', () => {
  assert.equal(nextScale(0.9, 9.5, o), 0.9);
});

test('steps are clean decimals', () => {
  for (let s = 0.6; s <= 1; s += 0.05) {
    const n = nextScale(s, 3, o);
    assert.equal(n, +n.toFixed(3));
  }
});

test('bad input leaves the scale alone', () => {
  assert.equal(nextScale(0.9, NaN, o), 0.9);
  assert.equal(nextScale(0.9, 0, o), 0.9);
});
