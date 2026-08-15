import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { readFile } from 'node:fs/promises';
import { CloudField } from '../CloudField.js';

const source = await readFile(new URL('../CloudField.js', import.meta.url), 'utf8');

function environment() {
  return {
    uniforms: {
      uSunDir: { value: new THREE.Vector3(0.4, 0.8, 0.4).normalize() },
      uSunColor: { value: new THREE.Color(1, 1, 1) },
      uZenithColor: { value: new THREE.Color(0.1, 0.2, 0.5) },
      uHorizonColor: { value: new THREE.Color(0.6, 0.7, 0.9) },
      uSunIntensity: { value: 1.5 },
      uCloudBase: { value: 5200 },
      uCloudTop: { value: 8600 },
      uCloudWind: { value: new THREE.Vector2(3.8, 1.6) },
      uCloudTime: { value: 0 },
    },
  };
}

/**
 * Every puff is one instance inside a single draw, so three.js sorts none of
 * them — it sorts objects. Without an explicit far-to-near order the blend
 * order is whatever the build loop emitted, and a cloud kilometres away paints
 * over one in front of it.
 */
test('instances are ordered far to near for the eye', () => {
  const field = new CloudField(environment(), new THREE.PerspectiveCamera(60, 1.6, 1, 60000));
  field._built = true;
  const eye = new THREE.Vector3(0, 6000, 0);
  field._rebuild(eye);
  assert.ok(field.puffCount > 200, `needs a populated field, got ${field.puffCount}`);

  field._lastSortAt.set(Infinity, 0, Infinity);
  assert.equal(field._sortBackToFront(eye), true, 'a stale order must re-sort');

  const c = field._centres;
  let previous = Infinity;
  for (let i = 0; i < field.puffCount; i++) {
    const d = (c[i * 3] - eye.x) ** 2 + (c[i * 3 + 1] - eye.y) ** 2 + (c[i * 3 + 2] - eye.z) ** 2;
    assert.ok(d <= previous + 1, `instance ${i} is nearer than the one before it`);
    previous = d;
  }
  field.dispose();
});

test('the order is rebuilt when the eye moves and reused when it barely does', () => {
  const field = new CloudField(environment(), new THREE.PerspectiveCamera(60, 1.6, 1, 60000));
  field._built = true;
  const eye = new THREE.Vector3(0, 6000, 0);
  field._rebuild(eye);
  field._sortBackToFront(eye);

  assert.equal(
    field._sortBackToFront(eye.clone().add(new THREE.Vector3(2, 0, 0))),
    false,
    'a two-metre step must not pay for a re-sort',
  );
  assert.equal(
    field._sortBackToFront(eye.clone().add(new THREE.Vector3(400, 0, 0))),
    true,
    'a real move must re-sort',
  );
  field.dispose();
});

test('sorting a full field stays inside a frame budget', () => {
  const field = new CloudField(environment(), new THREE.PerspectiveCamera(60, 1.6, 1, 60000));
  field._built = true;
  const eye = new THREE.Vector3(0, 6000, 0);
  field._rebuild(eye);
  const started = performance.now();
  for (let i = 0; i < 20; i++) {
    field._lastSortAt.set(Infinity, 0, Infinity);
    field._sortBackToFront(eye);
  }
  const perSort = (performance.now() - started) / 20;
  assert.ok(perSort < 3, `${perSort.toFixed(2)} ms per sort of ${field.puffCount} puffs`);
  field.dispose();
});

/**
 * Banking the aircraft must not spin the sky. A billboard built on the camera's
 * own up vector stays square on screen, which means it rotates with the camera
 * in the world — the single most recognisable way sprite clouds look fake.
 */
test('the billboard basis is constrained to world up, not camera up', () => {
  assert.match(
    source,
    /vec3 upRef = normalize\(mix\(vec3\(0\.0, 1\.0, 0\.0\), uCameraUp, smoothstep\([\d.]+, [\d.]+, abs\(forward\.y\)\)\)\)/,
    'the up reference must be world up, easing to camera up only near vertical',
  );
  assert.match(source, /vec3 right = normalize\(cross\(upRef, forward\)\)/);
  assert.match(source, /vec3 up = cross\(forward, right\)/);
  // The facing direction has to be per puff, or every quad shares one plane.
  assert.match(source, /vec3 toEye = uCameraPos - iCentre/);
  assert.doesNotMatch(
    source,
    /uniform vec3 uCameraRight/,
    'a camera-right uniform means the quads are pinned to a rolling basis',
  );
});

test('puffs fade before the camera reaches them', () => {
  assert.match(
    source,
    /coverage \*= smoothstep\(uNearFadeStart, uNearFadeEnd, vEyeDistance\)/,
    'a billboard at arms length is unmistakably a flat card; it must dissolve first',
  );
});

console.log('cloud field ordering and billboard contracts passed');
