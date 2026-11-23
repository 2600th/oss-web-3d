import test from 'node:test';
import assert from 'node:assert/strict';
import { toHalfBits, fromHalfBits, encodeShadow, SHADOW_MIN, SHADOW_MAX } from './shadowConst.js';

test('binary16 conversion matches known bit patterns', () => {
  const cases = [[0, 0x0000], [1, 0x3c00], [-2, 0xc000], [0.5, 0x3800], [65504, 0x7bff], [1e6, 0x7c00], [2 ** -24, 0x0001], [2 ** -14, 0x0400], [0.1, 0x2e66], [-0, 0x8000]];
  for (const [v, bits] of cases) assert.equal(toHalfBits(v), bits, `${v}`);
  if (typeof Float16Array === 'function') {
    // agrees with the engine's own rounding wherever it exists
    const f = new Float16Array(1), u = new Uint16Array(f.buffer);
    for (let i = 0; i < 20000; i++) {
      // float32 inputs (what the worker computes from): no double rounding through float32
      const v = Math.fround((Math.random() - 0.3) * 10 ** (Math.random() * 5 - 1));
      f[0] = v;
      assert.equal(toHalfBits(v), u[0], `${v}`);
    }
  }
});

test('sweep encoding: exact near the shadow edge, under 0.1 % error to 8 km, no saturation at 48 m', () => {
  for (let v = -60; v <= SHADOW_MAX; v += v < 64 ? 0.37 : v * 0.013) {
    const back = fromHalfBits(encodeShadow(v));
    const err = Math.abs(back - v);
    if (Math.abs(v) < 4) assert.ok(err <= 0.002, `${v}: ${err}`);
    else assert.ok(err <= Math.abs(v) * 0.001, `${v}: ${err}`);
  }
  // the old 8-bit field read 47.75 m for everything above it
  assert.ok(fromHalfBits(encodeShadow(300)) > 299.8);
  assert.equal(fromHalfBits(encodeShadow(-1e9)), SHADOW_MIN);
  assert.equal(fromHalfBits(encodeShadow(1e9)), SHADOW_MAX);
  // monotonic, so the GPU's linear filter between texels never inverts the edge
  let prev = -Infinity;
  for (let v = -70; v < 9000; v += 0.5) {
    const b = fromHalfBits(encodeShadow(v));
    assert.ok(b >= prev);
    prev = b;
  }
});
