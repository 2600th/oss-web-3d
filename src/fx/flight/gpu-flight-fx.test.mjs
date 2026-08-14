import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import * as FlightFxModule from '../FlightFx.js';
import { ParticleSystem } from '../gpu/ParticleSystem.js';
import { Ribbon } from '../gpu/Ribbon.js';
import { frameUniforms } from '../gpu/FrameUniforms.js';
import { TIERS } from '../../core/Settings.js';
import { Aircraft } from '../../flight/Aircraft.js';

const { FlightFx } = FlightFxModule;
const speedStreakMetrics = FlightFxModule.speedStreakMetrics
  ?? (() => ({ widthPx: 0, lengthPx: 0 }));

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

function smoothstep(edge0, edge1, value) {
  const t = THREE.MathUtils.clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function inspectVisibleStreaks(fx, camera) {
  const system = fx.speedStreaks;
  const currentTime = frameUniforms.uTime.value;
  const stretchWorld = system.uniforms.uStretchWorld.value;
  const point = new THREE.Vector3();
  const viewPoint = new THREE.Vector3();
  const velocity = new THREE.Vector3();
  const measured = [];
  for (let i = 0; i < system.active; i++) {
    const age = currentTime - system.data.spawn[i];
    const life = system.data.life[i];
    if (age < 0 || age > life) continue;
    const t = age / life;
    if (t < Math.max(system.uniforms.uSizeIn.value, system.uniforms.uFadeIn.value)) continue;
    const i3 = i * 3;
    point.fromArray(system.data.start, i3);
    velocity.fromArray(system.data.velocity, i3);
    const drag = Math.max(system.uniforms.uDrag.value, 1e-3);
    const travel = (1 - Math.exp(-drag * age)) / drag;
    point.addScaledVector(velocity, travel);
    viewPoint.copy(point).applyMatrix4(camera.matrixWorldInverse);
    const distance = -viewPoint.z;
    const fade = system.uniforms.uDistFade.value;
    if (distance <= fade.x || distance >= fade.w) continue;
    const projected = point.project(camera);
    if (Math.abs(projected.x) > 1 || Math.abs(projected.y) > 1) continue;
    velocity.add(stretchWorld);
    const grow = smoothstep(0, Math.max(system.uniforms.uSizeIn.value, 1e-3), t);
    const lifeScale = THREE.MathUtils.lerp(1, system.uniforms.uEndSize.value, t) * grow;
    const width = system.data.size[i] * lifeScale;
    measured.push(speedStreakMetrics({
      worldWidth: width,
      worldLength: width * (1 + system.uniforms.uStretch.value * velocity.length()),
      distance,
      fov: camera.fov,
      viewportHeight: 720,
    }));
  }
  return measured;
}

function simulateMovingCameraStreaks(tierName, airspeed, duration) {
  const fx = new FlightFx(environment());
  fx.setQuality(TIERS[tierName]);
  const camera = new THREE.PerspectiveCamera(67, 16 / 9, 0.1, 1000);
  camera.position.set(0, 0, 0);
  camera.lookAt(0, 0, -1);
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();
  const flight = {
    airspeed,
    position: new THREE.Vector3(0, 0, -26),
    velocity: new THREE.Vector3(0, 0, -airspeed),
    forward: new THREE.Vector3(0, 0, -1),
    right: new THREE.Vector3(1, 0, 0),
    altitude: 5000,
    agl: 2000,
    gLoad: 1,
  };

  let seed = 0x51f15e;
  const originalRandom = Math.random;
  Math.random = () => {
    seed = (1664525 * seed + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
  try {
    const step = 1 / 60;
    let maxWidthPx = 0;
    let maxLengthPx = 0;
    for (let elapsed = 0; elapsed < duration; elapsed += step) {
      const frameDt = Math.min(step, duration - elapsed);
      camera.position.addScaledVector(flight.forward, airspeed * frameDt);
      flight.position.addScaledVector(flight.forward, airspeed * frameDt);
      camera.updateMatrixWorld(true);
      fx.update(frameDt, flight, camera.position, camera);
      for (const metrics of inspectVisibleStreaks(fx, camera)) {
        maxWidthPx = Math.max(maxWidthPx, metrics.widthPx);
        maxLengthPx = Math.max(maxLengthPx, metrics.lengthPx);
      }
    }
    const finalMetrics = inspectVisibleStreaks(fx, camera);
    const readable = finalMetrics.filter((metrics) => (
      metrics.widthPx >= 0.75 && metrics.widthPx <= 1.5
      && metrics.lengthPx >= 6 && metrics.lengthPx <= 18
    )).length;
    return { readable, maxWidthPx, maxLengthPx };
  } finally {
    Math.random = originalRandom;
    fx.dispose();
  }
}

test('speed streak dimensions remain readable at chase-camera distance', () => {
  const metrics = speedStreakMetrics({
    worldWidth: 0.16,
    worldLength: 2.2,
    distance: 105,
    fov: 67,
    viewportHeight: 720,
  });
  assert.ok(metrics.widthPx >= 0.75 && metrics.widthPx <= 1.5, `${metrics.widthPx}px wide`);
  assert.ok(metrics.lengthPx >= 6 && metrics.lengthPx <= 18, `${metrics.lengthPx}px long`);
});

test('moving chase camera retains readable streak counts on desktop and phone', () => {
  const high = simulateMovingCameraStreaks('high', 260, 0.5);
  const phone = simulateMovingCameraStreaks('phone', 260, 0.5);
  assert.ok(high.readable >= 12, `high retained ${high.readable}`);
  assert.ok(phone.readable >= 4, `phone retained ${phone.readable}`);
});

test('moving chase camera keeps live streak dimensions below canopy-scratch caps', () => {
  const high = simulateMovingCameraStreaks('high', 260, 0.5);
  const phone = simulateMovingCameraStreaks('phone', 260, 0.5);
  assert.ok(high.maxWidthPx <= 1.5, `high reached ${high.maxWidthPx}px wide`);
  assert.ok(high.maxLengthPx <= 18, `high reached ${high.maxLengthPx}px long`);
  assert.ok(phone.maxWidthPx <= 1.5, `phone reached ${phone.maxWidthPx}px wide`);
  assert.ok(phone.maxLengthPx <= 18, `phone reached ${phone.maxLengthPx}px long`);
});

test('speed streaks stay hidden below the airspeed threshold', () => {
  const fx = new FlightFx(environment());
  fx.setQuality(TIERS.high);
  const camera = new THREE.PerspectiveCamera(67, 16 / 9, 0.1, 1000);
  camera.updateMatrixWorld(true);
  fx.update(0.5, {
    airspeed: 135,
    position: new THREE.Vector3(),
    velocity: new THREE.Vector3(),
    forward: new THREE.Vector3(0, 0, -1),
    right: new THREE.Vector3(1, 0, 0),
    altitude: 5000,
    agl: 2000,
    gLoad: 1,
  }, camera.position, camera);
  assert.equal(fx.speedStreaks.mesh.visible, false);
  assert.equal(fx.speedStreaks.cursor, 0);
  fx.dispose();
});

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
