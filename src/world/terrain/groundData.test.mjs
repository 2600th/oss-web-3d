// Ground-data layer (groundData.js) on synthetic terrain, and the shared snow
// line (snow.js) its CPU twin in assets/system.js builds on.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGroundData, blur } from './groundData.js';
import { SNOW, snowLine, snowCover } from './snow.js';

const N = 64;
const CELL = 30;
const field = (fn) => {
  const H = new Float32Array(N * N);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) H[j * N + i] = fn(i * CELL, j * CELL);
  return H;
};
const at = (g, i, j, c) => g[(j * N + i) * 4 + c] / 255;

test('a plane, however steep, is fully open to the near scan (only concavity occludes)', () => {
  for (const slope of [0, 0.3, 0.9]) {
    const g = buildGroundData({ H: field((x, z) => 3000 + x * slope + z * slope * 0.3), n: N, cellX: CELL, cellZ: CELL });
    for (const [i, j] of [[20, 20], [32, 40], [45, 12]]) assert.ok(at(g, i, j, 0) > 0.98, `slope ${slope}: ${at(g, i, j, 0)}`);
  }
});

test('a gully floor is occluded, its rims are not', () => {
  // V valley along z, walls rising 0.8 m per metre
  const g = buildGroundData({ H: field((x) => 3000 + Math.abs(x - 32 * CELL) * 0.8), n: N, cellX: CELL, cellZ: CELL });
  const floor = at(g, 32, 32, 0);
  const wall = at(g, 40, 32, 0);
  assert.ok(floor < 0.75, `floor ${floor}`);
  assert.ok(wall > floor + 0.2, `wall ${wall} vs floor ${floor}`);
});

test('debris fans collect at the foot of a cliff, not on the cliff or far out on the flat', () => {
  // flat for x < 30 cells, then a 45 degree-plus wall
  const g = buildGroundData({ H: field((x) => 3000 + Math.max(0, x - 30 * CELL) * 1.4), n: N, cellX: CELL, cellZ: CELL });
  const foot = at(g, 28, 32, 1);
  const wall = at(g, 40, 32, 1);
  const flat = at(g, 5, 32, 1);
  assert.ok(foot > 0.4, `foot ${foot}`);
  assert.ok(wall < 0.15, `wall ${wall}`);
  assert.ok(flat < 0.05, `flat ${flat}`);
});

test('moisture and fields follow the river distance, height and slope', () => {
  const river = new Uint8Array(N * N);
  const riverMin = -40;
  const riverStep = 4; // metres per byte, so the field covers 0..980 m
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const edge = Math.abs(i - 8) * CELL - 20;
    river[j * N + i] = Math.max(0, Math.min(255, Math.round((edge - riverMin) / riverStep)));
  }
  const flatLow = buildGroundData({ H: field(() => 3100), n: N, cellX: CELL, cellZ: CELL, river, riverMin, riverStep });
  assert.ok(at(flatLow, 9, 32, 2) > 0.6, 'wet beside the channel');
  assert.ok(at(flatLow, 40, 32, 2) < 0.05, 'dry far from it');
  assert.ok(at(flatLow, 20, 32, 3) > 0.8, 'fields on the flat 360 m out');
  assert.ok(at(flatLow, 8, 32, 3) < 0.05, 'no fields in the bed');
  assert.ok(at(flatLow, 50, 32, 3) < 0.05, 'none 1.3 km out');
  const high = buildGroundData({ H: field(() => 4200), n: N, cellX: CELL, cellZ: CELL, river, riverMin, riverStep });
  assert.ok(at(high, 20, 32, 3) < 0.02, 'no farming at 4200 m');
  const steep = buildGroundData({ H: field((x, z) => 3100 + z * 0.3), n: N, cellX: CELL, cellZ: CELL, river, riverMin, riverStep });
  assert.ok(at(steep, 20, 32, 3) < 0.02, 'no fields on a 17 degree slope');
});

test('blur keeps a constant field and averages a spike', () => {
  const f = new Float32Array(N * N).fill(0.4);
  assert.ok(Math.abs(blur(f, N, 2)[N * 10 + 10] - 0.4) < 1e-6);
  const s = new Float32Array(N * N);
  s[N * 30 + 30] = 9;
  const b = blur(s, N, 1);
  assert.ok(Math.abs(b[N * 30 + 30] - 1) < 1e-6);
  assert.ok(Math.abs(b[N * 31 + 31] - 1) < 1e-6);
});

test('snow line: every term moves it the way the shader does', () => {
  assert.equal(snowLine({}), SNOW.LINE);
  assert.equal(snowLine({ nz: 1 }), SNOW.LINE + SNOW.ASPECT);
  assert.equal(snowLine({ macro: 0.5 }), SNOW.LINE + 0.5 * SNOW.MACRO);
  assert.equal(snowLine({ curv: 1 }), SNOW.LINE - SNOW.CURV_HI * SNOW.CURV); // clamped
  assert.equal(snowLine({ streak: 1, patch: -1 }), SNOW.LINE + SNOW.STREAK - SNOW.PATCH);
  // the macro term alone is worth a few hundred metres: the berm bug
  const alt = SNOW.LINE + 150;
  assert.ok(snowCover({ alt }) > 0.9);
  assert.ok(snowCover({ alt, macro: 0.9 }) < 0.1);
  // steep ground sheds it
  assert.ok(snowCover({ alt: SNOW.LINE + 400, tan: 1.5 }) < 0.05);
});
