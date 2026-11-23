import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';

import { ImpactBlast } from './ImpactBlast.js';

const position = new THREE.Vector3(12, 34, -56);
const velocity = new THREE.Vector3(-40, -260, 80);
const normal = new THREE.Vector3(0.23, 0.91, -0.34).normalize();

function impact() {
  return { position, velocity, normal, speed: 280, strength: 0.875 };
}

test('precreates a hidden shell, terrain ring, and fixed no-shadow impact light', () => {
  const blast = new ImpactBlast();

  assert.equal(blast.group.children.length, 3);
  assert.equal(blast.shell.visible, false);
  assert.equal(blast.ring.visible, false);
  assert.equal(blast.light.intensity, 0);
  assert.equal(blast.light.castShadow, false);
  assert.equal(blast.light.distance, 120);
  assert.equal(blast.light.decay, 2);

  blast.dispose();
});

test('changes every tier ring detail with drawRange while retaining the prewarmed geometry', () => {
  const blast = new ImpactBlast();
  const geometry = blast.ring.geometry;

  for (const [name, segments] of [
    ['phone', 32],
    ['low', 48],
    ['medium', 72],
    ['high', 96],
  ]) {
    blast.setQuality({ name });
    assert.equal(blast.ring.geometry, geometry, `${name} must retain the maximum geometry`);
    assert.equal(blast.ring.geometry.drawRange.count, segments * 6, `${name} draw count`);
  }
  blast.dispose();
});

test('phone pressure shell and ring scale against portrait short-side coverage', () => {
  const high = new ImpactBlast();
  high.setQuality({ name: 'high' });
  high.trigger(impact());
  high.update(0.3);
  const highShell = high.shell.scale.x;
  const highRing = high.ring.scale.x;

  const phone = new ImpactBlast();
  phone.setQuality({ name: 'phone' });
  phone.trigger(impact());
  phone.update(0.3);
  assert.ok(phone.shell.scale.x <= highShell * 0.65);
  assert.ok(phone.ring.scale.x <= highRing * 0.65);
  high.dispose();
  phone.dispose();
});

test('trigger reveals and aligns the prewarmed blast resources to the terrain normal', () => {
  const blast = new ImpactBlast();
  const shell = blast.shell;
  const ring = blast.ring;
  const light = blast.light;

  blast.trigger(impact());

  assert.equal(blast.shell, shell);
  assert.equal(blast.ring, ring);
  assert.equal(blast.light, light);
  assert.equal(blast.shell.visible, true);
  assert.equal(blast.ring.visible, true);
  assert.ok(blast.light.intensity > 0);
  assert.deepEqual(blast.group.position.toArray(), position.toArray());
  const aligned = new THREE.Vector3(0, 1, 0).applyQuaternion(blast.ring.quaternion);
  assert.ok(aligned.angleTo(normal) < 1e-6);
  blast.dispose();
});

test('ages out the fixed flash before hiding the shell and ring', () => {
  const blast = new ImpactBlast();
  blast.trigger(impact());

  blast.update(0.36);
  assert.equal(blast.light.intensity, 0);
  assert.equal(blast.shell.visible, true);
  assert.equal(blast.ring.visible, true);

  blast.update(0.14);
  assert.equal(blast.shell.visible, false, 'pressure shell must clear by 500 ms');

  blast.update(1.25);
  assert.equal(blast.shell.visible, false);
  assert.equal(blast.ring.visible, false);
  blast.dispose();
});

test('live visual gate keeps the pressure shell and terrain ring bounded near the chase camera', () => {
  const blast = new ImpactBlast();
  blast.trigger(impact());
  blast.update(0.3);

  assert.ok(blast.shell.scale.x <= 4.8, `shell scale ${blast.shell.scale.x} exceeds visual gate`);
  assert.ok(blast.ring.scale.x <= 8, `ring scale ${blast.ring.scale.x} exceeds visual gate`);
  assert.equal(blast.shell.material.toneMapped, true);
  assert.equal(blast.ring.material.toneMapped, true);
  assert.ok(blast.shell.geometry.attributes.position.count > 2000, 'shell silhouette remains faceted');
  blast.dispose();
});

test('uses a normalized exponential flash envelope with an exact 350 ms boundary', () => {
  const blast = new ImpactBlast();
  blast.trigger(impact());
  const peak = blast.light.intensity;

  blast.update(0.175);
  const midpointRatio = blast.light.intensity / peak;
  assert.ok(Math.abs(midpointRatio - 0.07585818002124355) < 1e-12);
  assert.ok(Math.abs(midpointRatio - 0.25) > 0.1, 'midpoint must not be quadratic');

  blast.trigger(impact());
  blast.update(0.349);
  assert.ok(blast.light.intensity > 0);
  blast.update(0.001);
  assert.equal(blast.light.intensity, 0);
  blast.dispose();
});

test('reset is idempotent and disposal emits once per owned GPU resource', () => {
  const blast = new ImpactBlast();
  blast.trigger(impact());
  blast.reset();
  blast.reset();

  assert.equal(blast.shell.visible, false);
  assert.equal(blast.ring.visible, false);
  assert.equal(blast.light.intensity, 0);

  const resources = [
    blast.shell.geometry,
    blast.shell.material,
    blast.ring.geometry,
    blast.ring.material,
  ];
  const disposeCounts = new Map(resources.map((resource) => [resource, 0]));
  for (const resource of resources) {
    resource.addEventListener('dispose', () => {
      disposeCounts.set(resource, disposeCounts.get(resource) + 1);
    });
  }

  blast.dispose();
  blast.dispose();
  for (const resource of resources) assert.equal(disposeCounts.get(resource), 1);
});

test('ships one displaced dissolving shell and a GLSL3 shock-ring profile', async () => {
  const [implementation, shaders] = await Promise.all([
    readFile(new URL('./ImpactBlast.js', import.meta.url), 'utf8'),
    readFile(new URL('./impact-blast.glsl.js', import.meta.url), 'utf8'),
  ]);
  const source = `${implementation}\n${shaders}`;

  assert.equal((source.match(/fxFbm3\s*\(/g) ?? []).length, 1);
  assert.equal((source.match(/float\s+dissolveThreshold/g) ?? []).length, 1);
  assert.match(implementation, /Math\.pow\([^;]+,\s*0\.55\)/);
  assert.match(shaders, /\bout\s+vec4\s+outColor\s*;/);
  assert.match(implementation, /glslVersion:\s*THREE\.GLSL3/);
  assert.doesNotMatch(shaders, /gl_FragColor/);
  assert.doesNotMatch(shaders, /vec3\(1\.85,\s*1\.42,\s*0\.82\)/, 'shell radiance clips to white');
  assert.match(shaders, /float\s+pressureEnvelope/);
});

test('shell ignition has nonzero alpha at trigger age without an update-order birth gate', async () => {
  const shaders = await readFile(new URL('./impact-blast.glsl.js', import.meta.url), 'utf8');
  assert.doesNotMatch(shaders, /float\s+birth|smoothstep\(0\.0,\s*0\.045,\s*uAge\)/);

  const smoothstep = (low, high, value) => {
    const t = Math.max(0, Math.min(1, (value - low) / (high - low)));
    return t * t * (3 - 2 * t);
  };
  const triggerAge = 0;
  const shellNoise = 0.5;
  const fresnel = 0.5;
  const dissolveThreshold = smoothstep(0.28, 1, triggerAge);
  const dissolve = smoothstep(dissolveThreshold - 0.16, dissolveThreshold + 0.1, shellNoise);
  const alpha = (0.28 + fresnel * 0.72)
    * dissolve
    * (1 - smoothstep(0.7, 1, triggerAge));
  assert.ok(alpha > 0);
});

test('trigger does not allocate a temporary impact vector', async () => {
  const implementation = await readFile(new URL('./ImpactBlast.js', import.meta.url), 'utf8');
  const triggerBody = implementation.match(/trigger\(impact\) \{([\s\S]*?)\n  \}/)?.[1] ?? '';

  assert.doesNotMatch(triggerBody, /\.clone\s*\(/);
});
