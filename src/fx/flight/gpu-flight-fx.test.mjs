import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import * as FlightFxModule from '../FlightFx.js';
import { ParticleSystem } from '../gpu/ParticleSystem.js';
import { Ribbon } from '../gpu/Ribbon.js';
import { frameUniforms, setSceneDepth } from '../gpu/FrameUniforms.js';
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

function inspectVisibleStreaks(fx, camera, viewportWidth = 990, viewportHeight = 912) {
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
    const metrics = speedStreakMetrics({
      worldWidth: width,
      worldLength: width * (1 + system.uniforms.uStretch.value * velocity.length()),
      distance,
      fov: camera.fov,
      viewportHeight,
    });
    const lifeFade = smoothstep(0, Math.max(system.uniforms.uFadeIn.value, 1e-3), t)
      * (1 - smoothstep(
        THREE.MathUtils.clamp(system.uniforms.uFadeOut.value, 0, 0.98),
        1,
        t,
      ));
    const distanceFade = smoothstep(fade.x, fade.y, distance)
      * (1 - smoothstep(fade.z, fade.w, distance));
    metrics.coreContribution = system.uniforms.uOpacity.value
      * system.uniforms.uGlow.value
      * lifeFade
      * distanceFade;
    const stretchView = velocity.clone().transformDirection(camera.matrixWorldInverse);
    const direction = new THREE.Vector2(stretchView.x + 1e-5, -(stretchView.y + 1e-5)).normalize();
    metrics.screenX = (projected.x * 0.5 + 0.5) * viewportWidth;
    metrics.screenY = (-projected.y * 0.5 + 0.5) * viewportHeight;
    metrics.direction = direction;
    measured.push(metrics);
  }
  return measured;
}

function simulateMovingCameraStreaks(tierName, airspeed, duration, {
  viewportWidth = 990,
  viewportHeight = 912,
  fov = 68,
} = {}) {
  const fx = new FlightFx(environment());
  fx.setQuality(TIERS[tierName]);
  const previousResolution = frameUniforms.uResolution.value.clone();
  frameUniforms.uResolution.value.set(viewportWidth, viewportHeight);
  const camera = new THREE.PerspectiveCamera(fov, viewportWidth / viewportHeight, 0.1, 1000);
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
      for (const metrics of inspectVisibleStreaks(fx, camera, viewportWidth, viewportHeight)) {
        maxWidthPx = Math.max(maxWidthPx, metrics.widthPx);
        maxLengthPx = Math.max(maxLengthPx, metrics.lengthPx);
      }
    }
    const finalMetrics = inspectVisibleStreaks(fx, camera, viewportWidth, viewportHeight);
    const readable = finalMetrics.filter((metrics) => (
      metrics.widthPx >= 0.75 && metrics.widthPx <= 1.5
      && metrics.lengthPx >= 6 && metrics.lengthPx <= 18
    )).length;
    const luminous = finalMetrics.filter((metrics) => metrics.coreContribution >= 0.12).length;
    const peakContribution = finalMetrics.reduce(
      (maximum, metrics) => Math.max(maximum, metrics.coreContribution),
      0,
    );
    const raster = rasterizeStreaks(
      finalMetrics,
      viewportWidth,
      viewportHeight,
      fx.speedStreaks.uniforms.uStreakCore?.value ?? 3.4,
    );
    return { readable, luminous, peakContribution, maxWidthPx, maxLengthPx, ...raster };
  } finally {
    Math.random = originalRandom;
    frameUniforms.uResolution.value.copy(previousResolution);
    fx.dispose();
  }
}

/** Shader-equivalent sample at physical pixel centres (MSAA is disabled in Engine). */
function rasterizeStreaks(metricsList, viewportWidth, viewportHeight, coreScale) {
  let luminousPixels = 0;
  let readableStreaks = 0;
  for (const metrics of metricsList) {
    const dir = metrics.direction;
    const perp = new THREE.Vector2(-dir.y, dir.x);
    const halfWidth = metrics.widthPx * 0.5;
    const halfLength = metrics.lengthPx * 0.5;
    const radius = Math.ceil(halfWidth + halfLength + 1);
    let streakPixels = 0;
    const minX = Math.max(0, Math.floor(metrics.screenX - radius));
    const maxX = Math.min(viewportWidth - 1, Math.ceil(metrics.screenX + radius));
    const minY = Math.max(0, Math.floor(metrics.screenY - radius));
    const maxY = Math.min(viewportHeight - 1, Math.ceil(metrics.screenY + radius));
    for (let py = minY; py <= maxY; py++) {
      for (let px = minX; px <= maxX; px++) {
        const dx = px + 0.5 - metrics.screenX;
        const dy = py + 0.5 - metrics.screenY;
        const cx = (dx * perp.x + dy * perp.y) / Math.max(halfWidth, 1e-6);
        const cy = (dx * dir.x + dy * dir.y) / Math.max(halfLength, 1e-6);
        if (Math.abs(cx) > 1 || Math.abs(cy) > 1) continue;
        const core = 1 - smoothstep(0, 1, Math.abs(cx) * coreScale);
        const lengthFade = 1 - smoothstep(0, 1, Math.abs(cy));
        const contribution = metrics.coreContribution * core * lengthFade;
        if (contribution >= 0.08) streakPixels++;
      }
    }
    luminousPixels += streakPixels;
    if (streakPixels >= 3) readableStreaks++;
  }
  return { luminousPixels, rasterReadableStreaks: readableStreaks };
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

test('live acceptance viewport retains luminous streak cores after all shader fades', () => {
  const high = simulateMovingCameraStreaks('high', 270, 0.5, {
    viewportWidth: 990,
    viewportHeight: 912,
    fov: 68,
  });
  assert.ok(high.luminous >= 12, `only ${high.luminous} luminous cores; peak ${high.peakContribution}`);
  assert.ok(high.peakContribution <= 0.45, `overpowering core contribution ${high.peakContribution}`);
});

test('live no-MSAA raster retains several multi-pixel streaks after shape coverage', () => {
  const high = simulateMovingCameraStreaks('high', 270, 0.5, {
    viewportWidth: 990,
    viewportHeight: 912,
    fov: 68,
  });
  assert.ok(
    high.rasterReadableStreaks >= 12,
    `only ${high.rasterReadableStreaks} raster-readable streaks across ${high.luminousPixels} pixels`,
  );
  assert.ok(high.luminousPixels >= 80, `only ${high.luminousPixels} luminous pixels`);
  assert.ok(high.luminousPixels <= 260, `screen-scratching coverage ${high.luminousPixels}px`);
});

test('speed streak shape exposes a wider core without changing its outer dimensions', () => {
  const fx = new FlightFx(environment());
  assert.ok(fx.speedStreaks.uniforms.uStreakCore, 'speed streak material has no core-width control');
  assert.ok(fx.speedStreaks.uniforms.uStreakCore.value <= 1.6);
  assert.ok(fx.speedStreaks.uniforms.uStreakCore.value >= 1.1);
  fx.dispose();
});

test('only camera-shell speed streaks bypass hardware and soft scene depth', () => {
  const fx = new FlightFx(environment());
  const fakeDepth = new THREE.DepthTexture(16, 16);
  setSceneDepth(fakeDepth, 16, 16);
  try {
    assert.equal(fx.speedStreaks.material.depthTest, false);
    assert.equal('FX_SOFT_DEPTH' in fx.speedStreaks.material.defines, false);
    assert.equal(fx.speedStreaks.material.userData.fxSoftDepth, false);

    for (const system of [fx.condensation, fx.spindrift, fx.smoke, fx.sparks, fx.debris]) {
      assert.equal(system.material.depthTest, true, `${system.name} lost hardware depth`);
      assert.equal('FX_SOFT_DEPTH' in system.material.defines, true, `${system.name} lost soft depth`);
      assert.notEqual(system.material.userData.fxSoftDepth, false);
    }
  } finally {
    setSceneDepth(null, 16, 16);
    fakeDepth.dispose();
    fx.dispose();
  }
});

test('speed streak mesh reappears and emits after crossing the speed gate', () => {
  const fx = new FlightFx(environment());
  fx.setQuality(TIERS.high);
  const camera = new THREE.PerspectiveCamera(68, 990 / 912, 0.1, 1000);
  camera.lookAt(0, 0, -1);
  camera.updateMatrixWorld(true);
  const flight = {
    airspeed: 135,
    position: new THREE.Vector3(0, 0, -26),
    velocity: new THREE.Vector3(0, 0, -270),
    forward: new THREE.Vector3(0, 0, -1),
    right: new THREE.Vector3(1, 0, 0),
    altitude: 5000,
    agl: 2000,
    gLoad: 1,
  };
  fx.update(1 / 60, flight, camera.position, camera);
  assert.equal(fx.speedStreaks.mesh.visible, false);
  flight.airspeed = 270;
  fx.update(0.1, flight, camera.position, camera);
  assert.equal(fx.speedStreaks.mesh.visible, true);
  assert.ok(fx.speedStreaks.cursor > 0, 'high-speed frame emitted no particles');
  fx.dispose();
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
