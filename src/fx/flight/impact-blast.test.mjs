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

test('changes ring detail with drawRange while retaining the prewarmed geometry', () => {
  const blast = new ImpactBlast();
  const geometry = blast.ring.geometry;

  blast.setQuality({ name: 'phone' });

  assert.equal(blast.ring.geometry, geometry);
  assert.equal(blast.ring.geometry.drawRange.count, 32 * 6);
  blast.dispose();
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

  blast.update(1.25);
  assert.equal(blast.shell.visible, false);
  assert.equal(blast.ring.visible, false);
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
});

test('trigger does not allocate a temporary impact vector', async () => {
  const implementation = await readFile(new URL('./ImpactBlast.js', import.meta.url), 'utf8');
  const triggerBody = implementation.match(/trigger\(impact\) \{([\s\S]*?)\n  \}/)?.[1] ?? '';

  assert.doesNotMatch(triggerBody, /\.clone\s*\(/);
});
