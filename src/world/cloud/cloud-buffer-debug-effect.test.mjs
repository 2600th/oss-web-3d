import assert from 'node:assert/strict';
import test from 'node:test';
import { DataTexture, FloatType, RGBAFormat } from 'three';

import { CloudBufferDebugEffect } from './CloudBufferDebugEffect.js';

function floatTexture(values) {
  const texture = new DataTexture(Float32Array.from(values), 2, 2, RGBAFormat, FloatType);
  texture.needsUpdate = true;
  return texture;
}

test('raw cloud debug projects a 2 x 2 float output buffer as alpha grayscale or RGB', () => {
  const first = floatTexture([
    0.1, 0.2, 0.3, 0.25,
    0.4, 0.5, 0.6, 0.5,
    0.7, 0.8, 0.9, 0.75,
    1.0, 0.0, 0.2, 1.0,
  ]);
  const clouds = {
    haze: true,
    skipRendering: false,
    cloudsPass: { outputBuffer: first },
    update() {},
  };
  const effect = new CloudBufferDebugEffect(clouds, 'cloud-alpha');

  assert.deepEqual(effect.debugPixel(first.image.data, 2), [0.75, 0.75, 0.75, 1]);
  effect.setView('cloud-color');
  assert.deepEqual(effect.debugPixel(first.image.data, 2), [
    first.image.data[8], first.image.data[9], first.image.data[10], 1,
  ]);
});

test('raw cloud debug disables haze only while active and rebinds the resolved output after a history swap', () => {
  const first = floatTexture([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const second = floatTexture([1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1]);
  const clouds = {
    haze: true,
    skipRendering: false,
    cloudsPass: { outputBuffer: first },
    update() { this.cloudsPass.outputBuffer = second; },
  };
  const effect = new CloudBufferDebugEffect(clouds, 'cloud-alpha');

  effect.update({}, {}, 1 / 60);
  assert.equal(clouds.haze, false);
  assert.equal(clouds.skipRendering, true);
  assert.strictEqual(effect.uniforms.get('uCloudBuffer').value, second);

  effect.setView('composite');
  assert.equal(clouds.haze, true);
  effect.dispose();
  assert.equal(clouds.haze, true);
  assert.equal(clouds.skipRendering, false);
});
