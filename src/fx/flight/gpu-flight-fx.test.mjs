import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { FlightFx } from '../FlightFx.js';
import { ParticleSystem } from '../gpu/ParticleSystem.js';
import { Ribbon } from '../gpu/Ribbon.js';
import { TIERS } from '../../core/Settings.js';
import { Aircraft } from '../../flight/Aircraft.js';

function environment() {
  return {
    uniforms: {
      uSunDir: { value: new THREE.Vector3(0.5, 0.7, 0.2).normalize() },
      uSunColor: { value: new THREE.Color(1, 0.94, 0.84) },
      uSunIntensity: { value: 1.5 },
      uWind: { value: new THREE.Vector2(11, 4.5) },
      uZenithColor: { value: new THREE.Color(0.03, 0.09, 0.3) },
      uHorizonColor: { value: new THREE.Color(0.56, 0.68, 0.85) },
    },
  };
}

test('FlightFx is composed from the GPU particle and ribbon foundation', () => {
  const fx = new FlightFx(environment());
  assert.ok(fx.speedStreaks instanceof ParticleSystem);
  assert.ok(fx.spindrift instanceof ParticleSystem);
  assert.ok(fx.smoke instanceof ParticleSystem);
  assert.ok(fx.sparks instanceof ParticleSystem);
  assert.ok(fx.debris instanceof ParticleSystem);
  assert.equal(fx.trails.length, 2);
  assert.ok(fx.trails.every((trail) => trail instanceof Ribbon));
  fx.dispose();
});

test('quality changes apply strict draw budgets and compile out phone contrails', () => {
  const fx = new FlightFx(environment());
  fx.setQuality(TIERS.phone);
  assert.equal(fx.speedStreaks.active, TIERS.phone.speedParticles);
  assert.ok(fx.spindrift.active <= 48);
  assert.ok(fx.trails.every((trail) => trail.active === 0));
  assert.ok(fx.smoke.active <= 96);

  fx.setQuality(TIERS.high);
  assert.equal(fx.speedStreaks.active, TIERS.high.speedParticles);
  assert.ok(fx.trails.every((trail) => trail.active > 0));
  fx.dispose();
});

test('crash creates bounded smoke, spark and debris bursts', () => {
  const fx = new FlightFx(environment());
  fx.setQuality(TIERS.high);
  const flight = {
    position: new THREE.Vector3(2, 5000, 3),
    velocity: new THREE.Vector3(120, -30, 10),
  };
  fx.crash(flight, 0.8);
  assert.ok(fx.smoke.cursor > 0);
  assert.ok(fx.sparks.cursor > 0);
  assert.ok(fx.debris.cursor > 0);
  assert.ok(fx.smoke.cursor <= fx.smoke.active);
  fx.dispose();
});

test('afterburner uses bounded shader surfaces, never camera-intersecting cones', () => {
  const aircraft = new Aircraft(environment());
  const types = [];
  const bounds = new THREE.Box3().makeEmpty();
  aircraft.exhaust.traverse((object) => {
    if (!object.isMesh) return;
    types.push(object.geometry.type);
    object.geometry.computeBoundingBox();
    bounds.union(object.geometry.boundingBox.clone().applyMatrix4(object.matrixWorld));
  });
  assert.ok(types.length >= 3);
  assert.equal(types.includes('ConeGeometry'), false);
  assert.match(aircraft.flameCore.material.fragmentShader, /gl_FragColor\s*=/);
  assert.doesNotMatch(aircraft.flameCore.material.fragmentShader, /\bout\s+vec4\b/);
  const size = bounds.getSize(new THREE.Vector3());
  assert.ok(size.x <= 3 && size.y <= 3 && size.z <= 12, `oversized plume ${size.toArray()}`);
  assert.equal(typeof aircraft.dispose, 'function');
  aircraft.dispose();
});
