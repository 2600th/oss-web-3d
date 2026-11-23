import test from 'node:test';
import assert from 'node:assert/strict';
import { generateBlueNoise } from './blueNoise.js';

const size = 32;
const bn = generateBlueNoise(size);

test('blue noise is a permutation of ranks, so every threshold is used once', () => {
  const seen = new Uint8Array(size * size);
  for (const v of bn) {
    const r = Math.round(v * size * size);
    assert.ok(r >= 0 && r < size * size && !seen[r]);
    seen[r] = 1;
  }
});

test('blue noise has far less low-frequency energy than white noise', () => {
  // Box-filter 4x4 (toroidal) and measure the variance of the means: white noise
  // gives var/16; a blue-noise mask is nearly uniform at that scale.
  const blurVar = (a) => {
    let s = 0, s2 = 0;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      let m = 0;
      for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) m += a[((y + j) % size) * size + ((x + i) % size)];
      m /= 16; s += m; s2 += m * m;
    }
    const n = size * size;
    return s2 / n - (s / n) ** 2;
  };
  let seed = 7;
  const white = Float32Array.from({ length: size * size }, () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296));
  assert.ok(blurVar(bn) < blurVar(white) * 0.3, `${blurVar(bn)} vs ${blurVar(white)}`);
});

test('generation is deterministic', () => {
  assert.deepEqual(Array.from(generateBlueNoise(16, 5)), Array.from(generateBlueNoise(16, 5)));
});
