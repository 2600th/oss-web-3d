import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SPEED_OF_SOUND, dopplerFactor, propagationDelay, airAbsorptionCutoff, distanceGain,
  closestApproach, stemWeights, dbToGain, gainToDb,
} from './physics.js';
import { MusicState } from './musicState.js';

const v = (x = 0, y = 0, z = 0) => ({ x, y, z });
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

test('doppler: static source and listener give unity', () => {
  assert.equal(dopplerFactor(v(0, 0, 0), v(), v(100, 0, 0), v()), 1);
});

test('doppler: approaching source raises pitch by c/(c-v)', () => {
  const c = SPEED_OF_SOUND;
  const f = dopplerFactor(v(0, 0, 0), v(100, 0, 0), v(500, 0, 0), v());
  assert.ok(near(f, c / (c - 100)), `got ${f}`);
});

test('doppler: receding source lowers pitch by c/(c+v)', () => {
  const c = SPEED_OF_SOUND;
  const f = dopplerFactor(v(0, 0, 0), v(-100, 0, 0), v(500, 0, 0), v());
  assert.ok(near(f, c / (c + 100)), `got ${f}`);
});

test('doppler: listener moving toward source raises pitch by (c+v)/c', () => {
  const c = SPEED_OF_SOUND;
  const f = dopplerFactor(v(0, 0, 0), v(), v(500, 0, 0), v(-100, 0, 0));
  assert.ok(near(f, (c + 100) / c), `got ${f}`);
});

test('doppler: perpendicular motion has no first-order shift', () => {
  const f = dopplerFactor(v(0, 0, 0), v(0, 0, 250), v(500, 0, 0), v());
  assert.ok(near(f, 1));
});

test('doppler: supersonic closure is clamped, never negative or infinite', () => {
  const f = dopplerFactor(v(0, 0, 0), v(700, 0, 0), v(500, 0, 0), v());
  assert.ok(Number.isFinite(f) && f > 1 && f <= 2.8);
  const g = dopplerFactor(v(0, 0, 0), v(), v(500, 0, 0), v(900, 0, 0));
  assert.ok(g >= 0.35 && g < 1);
});

test('propagation delay: 3.25 km is 10 s at 325 m/s', () => {
  assert.ok(near(propagationDelay(3250), 10));
  assert.equal(propagationDelay(-5), 0);
});

test('air absorption: cutoff falls monotonically with distance', () => {
  let prev = Infinity;
  for (const d of [0, 50, 200, 1000, 5000, 20000]) {
    const f = airAbsorptionCutoff(d);
    assert.ok(f <= prev, `${d} m -> ${f}`);
    prev = f;
  }
  assert.ok(airAbsorptionCutoff(0) === 20000);
  assert.ok(airAbsorptionCutoff(1000) > 1500 && airAbsorptionCutoff(1000) < 3500);
  assert.ok(airAbsorptionCutoff(1e6) >= 220);
});

test('distance gain: unity inside ref, halves at double distance, zero at max', () => {
  assert.equal(distanceGain(10, 30), 1);
  assert.ok(near(distanceGain(60, 30, 1e9), 0.5));
  assert.equal(distanceGain(12000, 30, 12000), 0);
});

test('closest approach of a straight pass', () => {
  const r = closestApproach(v(-1000, 0, 50), v(250, 0, 0));
  assert.ok(near(r.t, 4));
  assert.ok(near(r.distance, 50));
});

test('stem weights: power law keeps sum of squares at 1', () => {
  for (const lv of [0, 0.1, 0.25, 0.5, 0.7, 1]) {
    const w = stemWeights(lv, 3, 'power');
    assert.ok(near(w.reduce((s, x) => s + x * x, 0), 1), `${lv}: ${w}`);
  }
});

test('stem weights: linear law (correlated stems) sums to 1 and is monotonic', () => {
  let prevTop = -1;
  for (let lv = 0; lv <= 1.0001; lv += 0.05) {
    const w = stemWeights(lv, 3);
    assert.ok(near(w.reduce((s, x) => s + x, 0), 1), `${lv}: ${w}`);
    assert.ok(w[2] >= prevTop - 1e-9);
    prevTop = w[2];
  }
  assert.deepEqual(stemWeights(0, 3).map((x) => Math.round(x)), [1, 0, 0]);
  assert.deepEqual(stemWeights(1, 3).map((x) => Math.round(x)), [0, 0, 1]);
  assert.ok(near(stemWeights(0.5, 3)[1], 1));
});

test('db conversions round-trip', () => {
  assert.ok(near(gainToDb(dbToGain(-12)), -12));
});

test('music state: explicit menu then combat switch immediately', () => {
  const m = new MusicState();
  m.request({ state: 'menu' }, 0);
  assert.equal(m.update(0).cue, 'menu');
  m.request({ state: 'combat', level: 0.6 }, 1);
  const o = m.update(1);
  assert.equal(o.cue, 'combat');
  assert.equal(o.changed, true);
});

test('music state: combat holds before dropping to cruise', () => {
  const m = new MusicState({ combatHold: 9 });
  m.request({ state: 'combat', level: 0.8 }, 0);
  m.update(0);
  m.request({ state: 'cruise', level: 0 }, 2);
  assert.equal(m.update(2).cue, 'combat');
  assert.equal(m.update(8.9).cue, 'combat');
  assert.equal(m.update(9.1).cue, 'cruise');
});

test('music state: level rises fast and falls slowly', () => {
  const m = new MusicState({ riseRate: 2, fallRate: 0.1 });
  m.request({ state: 'combat', level: 1 }, 0);
  m.update(0);
  assert.ok(m.update(0.5).level >= 0.99);
  m.request({ state: 'combat', level: 0 }, 0.5);
  const lv = m.update(1.5).level;
  assert.ok(lv > 0.85 && lv < 0.95, `level ${lv}`);
});

test('music state: danger forces a high intensity', () => {
  const m = new MusicState({ riseRate: 100 });
  m.request({ state: 'danger', level: 0.2 }, 0);
  m.update(0);
  const o = m.update(0.1);
  assert.equal(o.cue, 'combat');
  assert.ok(o.level >= 0.85);
  assert.ok(o.weights[2] > o.weights[0]);
});

test('music state: heuristic heat drives combat without a mission system, then cools', () => {
  const m = new MusicState({ combatHold: 5, heatDecay: 0.1 });
  m.autoFlight = true;
  assert.equal(m.update(0).cue, 'cruise');
  m.heat(0.6, 1);
  assert.equal(m.update(1).cue, 'combat');
  // 0.6 heat decays below the 0.22 threshold ~3.8 s later (t≈4.8), then the
  // 5 s hold runs; drive it at frame-like steps as the system does.
  const at = (t) => { let o; for (let s = 1.1; s <= t + 1e-9; s += 0.1) o = m.update(s); return o.cue; };
  assert.equal(at(9.5), 'combat');
  assert.equal(at(10.5), 'cruise');
});

test('music state: explicit requests suppress the heuristic', () => {
  const m = new MusicState();
  m.request({ state: 'cruise', level: 0 }, 0);
  m.update(0);
  m.heat(1, 1);
  assert.equal(m.update(1).cue, 'cruise');
});

test('music state: victory is terminal against heat', () => {
  const m = new MusicState();
  m.request({ state: 'victory' }, 0);
  m.update(0);
  m.heat(1, 20);
  assert.equal(m.update(20).cue, 'victory');
});

test('music state: screen/mission cues do not suspend the heat heuristic', () => {
  const m = new MusicState();
  m.request({ state: 'cruise', level: 0 }, 0, false);
  m.update(0);
  m.heat(0.8, 1);
  assert.equal(m.update(1).cue, 'combat');
});

test('music state: an authoritative level holds for the explicit timeout', () => {
  const m = new MusicState({ explicitTimeout: 45, riseRate: 100, fallRate: 100 });
  m.request({ state: 'combat', level: 1 }, 0);
  let o;
  for (let t = 0; t <= 40; t += 0.5) o = m.update(t);
  assert.equal(o.cue, 'combat');
  assert.equal(o.level, 1);
});
