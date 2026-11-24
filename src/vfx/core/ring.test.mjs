import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Ring, DirtyRanges, Pool, explosionRadius, plumeState, airState, shockCells, burnerState, burnerStep, vapourAmount, vapourGates, vapourCone, speedOfSound, rankLights,
} from './ring.js';

test('vapour gates: tip threads need some moisture, the wing sheet needs humid air', () => {
  const dry = vapourGates(1, 0.3), humid = vapourGates(1, 0.8), wet = vapourGates(1, 1);
  assert.ok(Math.abs(dry.tip - 0.4) < 1e-9);
  assert.ok(dry.wing < 0.22, 'no sheet over the wing on a dry day');
  assert.ok(humid.wing > 0.75 && humid.tip > 0.99);
  assert.ok(wet.wing > 0.99);
  assert.equal(vapourGates(0, 1).tip, 0);
  assert.ok(vapourGates(5, 0.5).tip <= 1);
});

test('Ring recycles the oldest slots first', () => {
  const r = new Ring(4);
  assert.deepEqual([r.next(), r.next(), r.next(), r.next(), r.next(), r.next()], [0, 1, 2, 3, 0, 1]);
  assert.equal(r.total, 6);
});

test('DirtyRanges merges contiguous slots and resets', () => {
  const d = new DirtyRanges(100, 8);
  for (const i of [5, 6, 7, 20, 21, 99, 0, 6]) d.mark(i);
  assert.deepEqual(d.flush(), [[0, 1], [5, 3], [20, 2], [99, 1]]);
  assert.equal(d.empty, true);
  assert.deepEqual(d.flush(), []);
});

test('DirtyRanges caps the range count by bridging the smallest gaps', () => {
  const d = new DirtyRanges(1000, 2);
  for (const i of [0, 2, 4, 500]) d.mark(i);
  const ranges = d.flush();
  assert.deepEqual(ranges, [[0, 5], [500, 1]]);
  // every marked slot is still covered
  for (const i of [0, 2, 4, 500]) assert.ok(ranges.some(([s, c]) => i >= s && i < s + c));
});

test('DirtyRanges covers the whole buffer when everything was touched', () => {
  const d = new DirtyRanges(8, 2);
  for (let i = 0; i < 8; i++) d.mark(i);
  assert.deepEqual(d.flush(), [[0, 8]]);
});

test('Pool reuses free items and steals the oldest when exhausted', () => {
  const p = new Pool(2, (i) => ({ i }));
  const a = p.acquire(), b = p.acquire();
  assert.notEqual(a, b);
  assert.equal(p.activeCount, 2);
  const c = p.acquire(); // full: steals the oldest (a)
  assert.equal(c, a);
  p.release(b);
  assert.equal(p.acquire(), b);
});

test('explosion sizes scale monotonically and accept metres', () => {
  const r = ['small', 'medium', 'large', 'huge'].map(explosionRadius);
  for (let i = 1; i < r.length; i++) assert.ok(r[i] > r[i - 1]);
  assert.equal(explosionRadius(12.5), 12.5);
  assert.equal(explosionRadius('nonsense'), explosionRadius('medium'));
  assert.equal(explosionRadius(undefined), explosionRadius('medium'));
});

test('plume: dry thrust is short and has no diamonds; reheat is long with diamonds', () => {
  const idle = plumeState(0.2, false), dry = plumeState(0.85, false), wet = plumeState(1, true), wetN = plumeState(1, 1);
  assert.equal(idle.diamonds, 0);
  assert.equal(dry.diamonds, 0);
  assert.ok(dry.length > idle.length);
  assert.ok(wet.length > dry.length * 2);
  assert.ok(wet.diamonds >= 3);
  assert.ok(wet.core > dry.core * 3);
  assert.ok(Math.abs(wet.length - wetN.length) < 1e-9, 'boolean reheat at full throttle equals reheat = 1');
  assert.equal(plumeState(undefined, undefined).diamonds, 0);
});

test('air: ISA pressure and density fall with altitude', () => {
  const sl = airState(0), a5 = airState(5000), a11 = airState(11000), a15 = airState(15000);
  assert.ok(Math.abs(sl.pressure - 1) < 1e-9 && Math.abs(sl.density - 1) < 1e-9);
  assert.ok(Math.abs(a5.pressure - 0.533) < 0.005, `5 km pressure ${a5.pressure}`);
  assert.ok(Math.abs(a5.density - 0.601) < 0.005, `5 km density ${a5.density}`);
  assert.ok(Math.abs(a11.pressure - 0.2234) < 0.003);
  assert.ok(a15.pressure < a11.pressure && a15.T === 216.65);
  assert.equal(airState(-50).density, 1);
});

test('shock cells: about a nozzle diameter on the runway, longer fast and high', () => {
  const ground = shockCells(0, 0), fight = shockCells(5000, 0.75), high = shockCells(10000, 1.5);
  assert.ok(ground.npr > 1.83, 'the jet is under-expanded even standing still');
  assert.ok(ground.spacing > 0.7 && ground.spacing < 1.2, `ground ${ground.spacing}`);
  assert.ok(fight.spacing > ground.spacing * 1.25, `fight ${fight.spacing}`);
  assert.ok(high.spacing > fight.spacing * 1.25 && high.spacing < 2.6, `high ${high.spacing}`);
  // altitude alone (same Mach) spreads them: colder intake air, higher pressure ratio
  assert.ok(shockCells(10000, 0.75).spacing > shockCells(0, 0.75).spacing * 1.15);
  // a bigger nozzle scales the cells with it
  assert.ok(Math.abs(shockCells(0, 0, 0.9).spacing - 2 * ground.spacing) < 1e-9);
  for (const c of [shockCells(20000, 3), shockCells(undefined, undefined), shockCells(-100, -1)]) {
    assert.ok(Number.isFinite(c.spacing) && c.spacing > 0);
  }
});

test('plume: thin air makes it longer, with wider-spaced, fainter diamonds', () => {
  const low = plumeState(1, true, 300, 0.6), high = plumeState(1, true, 9000, 0.9);
  assert.ok(high.length > low.length * 1.2);
  assert.ok(high.spacing > low.spacing);
  assert.ok(high.contrast < low.contrast && high.contrast > 0.5);
  assert.ok(high.spread > low.spread && high.spread <= 1);
  assert.ok(low.diamonds >= 4 && low.diamonds <= 12, `cells in the flame ${low.diamonds}`);
  // dry thrust does not care about the reheat terms
  assert.equal(plumeState(0.8, false, 9000, 0.9).length, plumeState(0.8, false, 0, 0).length);
});

test('burner: lights with a pop that lunges and settles, collapses cleanly', () => {
  const dt = 1 / 60;
  const s = burnerState();
  const dry = plumeState(0.8, false, 5000, 0.7), wet = plumeState(1, true, 5000, 0.7);
  for (let i = 0; i < 120; i++) burnerStep(s, dry, dt);
  assert.equal(s.pop, 0);
  assert.equal(s.lit, false);
  assert.ok(Math.abs(s.flameLength - dry.length) < 1e-3);
  // light-up: flagged exactly once
  let flags = 0, peak = 0, peakAt = 0, powerPeak = 0;
  const at = {};
  for (let i = 1; i <= 120; i++) {
    burnerStep(s, wet, dt);
    if (s.lightUp) flags++;
    if (s.flameLength > peak) { peak = s.flameLength; peakAt = i * dt; }
    powerPeak = Math.max(powerPeak, s.power);
    at[i] = s.flameLength;
  }
  assert.equal(flags, 1);
  assert.ok(peak > wet.length * 1.08, `the flame overshoots (${peak} vs ${wet.length})`);
  assert.ok(peakAt > 0.05 && peakAt < 0.35, `lunge peaks at ${peakAt}s`);
  assert.ok(at[1] < wet.length * 0.75, 'it is not there on the first frame');
  assert.ok(Math.abs(at[42] - wet.length) < wet.length * 0.05, 'settled by 0.7 s');
  assert.ok(powerPeak <= wet.core * 2.2);
  assert.ok(s.pop < 1e-3 && s.lit);
  // collapse: monotonic, most of the way down in half a second, no pop
  let prev = s.flameLength;
  for (let i = 0; i < 30; i++) {
    burnerStep(s, dry, dt);
    assert.ok(s.flameLength <= prev + 1e-9);
    assert.equal(s.pop, 0);
    prev = s.flameLength;
  }
  assert.ok(s.reheat < 0.06 && s.flameLength < dry.length + 0.5);
  // relight pops again
  burnerStep(s, wet, dt);
  assert.equal(s.lightUp, true);
  // a huge frame time does not overshoot or go NaN
  const big = burnerStep(burnerState(), wet, 5);
  assert.ok(Number.isFinite(big.flameLength) && big.flameLength <= wet.length * 1.55 + 1e-9);
});

test('vapour needs load or alpha, and speed', () => {
  assert.equal(vapourAmount(1, 0.03, 250, 4000), 0);
  assert.ok(vapourAmount(8, 0.1, 250, 4000) > 0.9);
  assert.ok(vapourAmount(2, 0.35, 250, 4000) > 0.5);
  assert.equal(vapourAmount(8, 0.3, 80, 4000), 0);
  assert.ok(vapourAmount(8, 0.1, 250, 10000) < vapourAmount(8, 0.1, 250, 4000));
});

test('vapour cone only appears in the transonic band', () => {
  assert.equal(vapourCone(0.8), 0);
  assert.ok(vapourCone(0.97) > 0.9);
  assert.equal(vapourCone(1.2), 0);
});

test('speed of sound falls with altitude then holds in the stratosphere', () => {
  assert.ok(Math.abs(speedOfSound(0) - 340.3) < 0.5);
  assert.ok(speedOfSound(6000) < speedOfSound(0));
  assert.equal(speedOfSound(12000), speedOfSound(20000));
});

test('rankLights keeps the lights that are brightest at the camera', () => {
  const cam = { x: 0, y: 0, z: 0 };
  const req = [
    { x: 5000, y: 0, z: 0, intensity: 1e6 },  // huge but far
    { x: 10, y: 0, z: 0, intensity: 2000 },   // modest, close
    { x: 300, y: 0, z: 0, intensity: 500 },   // weak, mid
  ];
  const top = rankLights(req, cam, 2);
  assert.equal(top.length, 2);
  assert.equal(top[0].x, 10);
  assert.equal(top[1].x, 5000);
});
