import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { fillGround, LAND } from './textures.js';

const make = () => {
  const n = 4;
  const t = new THREE.DataArrayTexture(new Uint8Array(n * n * 4 * 3).fill(7), n, n, 3);
  t.needsUpdate = true;
  return { t, n };
};

test('ground data that arrives before the first upload sends the whole array, not one layer', () => {
  const { t, n } = make();
  const v = t.version;
  assert.equal(fillGround(t, new Uint8Array(n * n * 4).fill(200)), true);
  // A layer list on a texture the GPU has never seen would leave surf and river zero.
  assert.equal(t.layerUpdates.size, 0);
  assert.ok(t.version > v);
  assert.equal(t.image.data[0], 7); // surf untouched
  assert.equal(t.image.data[n * n * 4 * LAND.ground], 200);
});

test('ground data after the first upload re-sends only the ground layer', () => {
  const { t, n } = make();
  t.userData.uploaded = true;
  assert.equal(fillGround(t, new Uint8Array(n * n * 4).fill(200)), true);
  assert.deepEqual([...t.layerUpdates], [LAND.ground]);
});

test('a released CPU copy is reported, not written', () => {
  const { t, n } = make();
  t.image.data = null;
  assert.equal(fillGround(t, new Uint8Array(n * n * 4)), false);
});
