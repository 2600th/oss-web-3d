import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import { DistanceEmitter, ParticleSystem, RateEmitter } from './ParticleSystem.js';
import { Ribbon } from './Ribbon.js';

test('rate emitter drops hitch overflow instead of replaying it for later frames', () => {
  const emitter = new RateEmitter(1000);

  assert.equal(emitter.tick(1), 240);
  assert.equal(emitter.tick(0), 0);
});

test('distance emitter drops hitch overflow instead of replaying stale trail nodes', () => {
  const emitter = new DistanceEmitter(1);

  assert.equal(emitter.tick(100), 8);
  assert.equal(emitter.tick(0), 0);
});

test('particle quality reduction prevents hidden live slots reappearing later', () => {
  const particles = new ParticleSystem({ name: 'quality-test', capacity: 4 });
  const position = new THREE.Vector3();

  particles.emit(4, { position, time: 2 });
  particles.setActive(2);
  particles.setActive(4);

  assert.ok(particles.data.spawn[2] < -1000);
  assert.ok(particles.data.spawn[3] < -1000);
  particles.dispose();
});

test('ribbon quality reduction retires hidden segments before they can reappear', () => {
  const ribbon = new Ribbon({ name: 'quality-ribbon', capacity: 4, life: 30 });

  for (let i = 0; i < 5; i++) ribbon.push(new THREE.Vector3(i, 0, 0), 0.25, i);
  ribbon.flush();
  ribbon.setActive(2);
  ribbon.setActive(4);

  assert.ok(ribbon.data.data[2 * 4] < -1000);
  assert.ok(ribbon.data.data[2 * 4 + 1] < -1000);
  assert.ok(ribbon.data.data[3 * 4] < -1000);
  assert.ok(ribbon.data.data[3 * 4 + 1] < -1000);
  assert.deepEqual(ribbon._ranges, [[2, 2]]);
  ribbon.dispose();
});

test('ribbon disable and re-enable starts a new strip instead of reconnecting history', () => {
  const ribbon = new Ribbon({ name: 'disabled-ribbon', capacity: 4, life: 30 });

  ribbon.push(new THREE.Vector3(0, 0, 0), 0.25, 0);
  ribbon.setActive(0);
  ribbon.setActive(4);
  ribbon.push(new THREE.Vector3(100, 0, 0), 0.25, 1);

  assert.ok(ribbon.data.data[0] < -1000);
  assert.ok(ribbon.data.data[1] < -1000);
  ribbon.push(new THREE.Vector3(101, 0, 0), 0.25, 2);
  assert.equal(ribbon.data.data[0], 1);
  assert.equal(ribbon.data.data[1], 2);
  ribbon.dispose();
});

test('GPU buffers reject capacities that cannot form a ring', () => {
  assert.throws(() => new ParticleSystem({ name: 'bad', capacity: 0 }), RangeError);
  assert.throws(() => new Ribbon({ name: 'bad', capacity: 0 }), RangeError);
});

test('emitters reject invalid rates and spacing', () => {
  assert.throws(() => new RateEmitter(-1), RangeError);
  assert.throws(() => new DistanceEmitter(0), RangeError);
});

test('ribbon is fully present at birth and erodes as its threshold rises', () => {
  const ribbon = new Ribbon({ name: 'dissolve-test' });

  assert.match(
    ribbon.material.fragmentShader,
    /float dissolve = smoothstep\(threshold, threshold \+ 0\.55, n\);/,
  );
  ribbon.dispose();
});

test('ribbon shader guards join normalization at reversals and degenerate nodes', () => {
  const ribbon = new Ribbon({ name: 'join-test' });

  assert.match(ribbon.material.vertexShader, /vec3 fxSafeNormalize/);
  assert.match(ribbon.material.vertexShader, /fxSafeNormalize\(dir \+ backDir, dir\)/);
  assert.match(ribbon.material.vertexShader, /fxSafeNormalize\(dir \+ fwdDir, dir\)/);
  ribbon.dispose();
});
