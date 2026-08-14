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

test('camera streaks and terrain-contact impact systems bypass only the unsafe soft-depth path', () => {
  const fx = new FlightFx(environment());
  const fakeDepth = new THREE.DepthTexture(16, 16);
  setSceneDepth(fakeDepth, 16, 16);
  try {
    assert.equal(fx.speedStreaks.material.depthTest, false);
    assert.equal('FX_SOFT_DEPTH' in fx.speedStreaks.material.defines, false);
    assert.equal(fx.speedStreaks.material.userData.fxSoftDepth, false);

    for (const system of [fx.condensation, fx.spindrift]) {
      assert.equal(system.material.depthTest, true, `${system.name} lost hardware depth`);
      assert.equal('FX_SOFT_DEPTH' in system.material.defines, true, `${system.name} lost soft depth`);
      assert.notEqual(system.material.userData.fxSoftDepth, false);
    }
    for (const system of [fx.explosion, fx.smoke, fx.sparks, fx.debris]) {
      assert.equal(system.material.depthTest, true, `${system.name} lost hardware depth`);
      assert.equal('FX_SOFT_DEPTH' in system.material.defines, false, `${system.name} was suppressed by scene depth`);
      assert.equal(system.material.userData.fxSoftDepth, false);
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
  assert.ok(fx.explosion.uniforms.uSizeScale.value <= 0.65);
  assert.equal(fx.smoke.uniforms.uSizeScale.value, 1);
  assert.equal(fx.sparks.uniforms.uSizeScale.value, 1);

  fx.setQuality(TIERS.high);
  assert.equal(fx.speedStreaks.active, TIERS.high.speedParticles);
  assert.equal(fx.explosion.uniforms.uSizeScale.value, 1);
  assert.ok(fx.trails.every((trail) => trail.active > 0));
  fx.dispose();
});

test('phone orange lobe stays below 32 percent of a true 390x844 short side', () => {
  const viewportWidth = 390;
  const viewportHeight = 844;
  const camera = new THREE.PerspectiveCamera(58, viewportWidth / viewportHeight, 4, 1000);
  const incoming = new THREE.Vector3(90, 0, -40).normalize();
  camera.position.copy(incoming).multiplyScalar(-48).add(new THREE.Vector3(0, 18, 0));
  camera.lookAt(0, 4, 0);
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();
  const impact = {
    position: new THREE.Vector3(),
    velocity: new THREE.Vector3(90, -165, -40),
    normal: new THREE.Vector3(0, 1, 0),
    speed: 192,
    strength: 1,
  };
  const originalRandom = Math.random;
  let worst = 0;
  try {
    for (let sample = 0; sample < 24; sample++) {
      let seed = (0x7f4a7c15 ^ (sample * 0x9e3779b9)) >>> 0;
      Math.random = () => {
        seed = (1664525 * seed + 1013904223) >>> 0;
        return seed / 0x100000000;
      };
      const fx = new FlightFx(environment());
      fx.setQuality(TIERS.phone);
      fx.crash(impact);
      const system = fx.explosion;
      const age = 0.3;
      const gravity = system.uniforms.uGravity.value;
      const drag = Math.max(system.uniforms.uDrag.value, 1e-3);
      const travel = (1 - Math.exp(-drag * age)) / drag;
      const focal = viewportHeight / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) * 0.5));
      const point = new THREE.Vector3();
      const velocity = new THREE.Vector3();
      const viewPoint = new THREE.Vector3();
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (let i = 0; i < system.active; i++) {
        const life = system.data.life[i];
        if (life < age) continue;
        point.fromArray(system.data.start, i * 3);
        velocity.fromArray(system.data.velocity, i * 3);
        point.addScaledVector(velocity, travel).addScaledVector(gravity, 0.5 * age * age);
        viewPoint.copy(point).applyMatrix4(camera.matrixWorldInverse);
        if (viewPoint.z >= -camera.near) continue;
        const projected = point.clone().project(camera);
        const t = age / life;
        const grownSize = system.data.size[i]
          * system.uniforms.uSizeScale.value
          * THREE.MathUtils.lerp(1, system.uniforms.uEndSize.value, t);
        const radiusPx = grownSize * 0.5 * focal / -viewPoint.z;
        const x = (projected.x * 0.5 + 0.5) * viewportWidth;
        const y = (-projected.y * 0.5 + 0.5) * viewportHeight;
        minX = Math.min(minX, x - radiusPx);
        maxX = Math.max(maxX, x + radiusPx);
        minY = Math.min(minY, y - radiusPx);
        maxY = Math.max(maxY, y + radiusPx);
      }
      worst = Math.max(worst, Math.max(maxX - minX, maxY - minY) / viewportWidth);
      fx.dispose();
    }
  } finally {
    Math.random = originalRandom;
  }
  assert.ok(worst <= 0.32, `worst seeded portrait lobe extent ${(worst * 100).toFixed(1)}%`);
});

test('crash stages an impact blast with owned depth fades and directional particles', () => {
  const fx = new FlightFx(environment());
  fx.setQuality(TIERS.high);
  const impact = {
    position: new THREE.Vector3(2, 5000, 3),
    velocity: new THREE.Vector3(120, -30, 10),
    normal: new THREE.Vector3(0.2, 0.96, -0.1).normalize(),
    speed: 124,
    strength: 0.8,
  };

  const emissions = new Map();
  for (const system of [fx.explosion, fx.smoke, fx.sparks, fx.debris]) {
    const emit = system.emit.bind(system);
    system.emit = (count, spawn) => {
      emissions.set(system, {
        count,
        position: spawn.position?.clone(),
        velocity: spawn.velocity?.clone(),
        direction: spawn.direction?.clone(),
        inherit: spawn.inherit?.clone(),
        spread: spawn.spread,
        size: spawn.size,
        sizeVariance: spawn.sizeVariance,
        life: spawn.life,
        lifeVariance: spawn.lifeVariance,
      });
      emit(count, spawn);
    };
  }

  fx.crash(impact);
  assert.ok(fx.impactBlast.shell.visible);
  assert.ok(fx.impactBlast.light.intensity > 0);
  assert.ok(fx.explosion.cursor > 0);
  assert.ok(fx.smoke.cursor > 0);
  assert.ok(fx.sparks.cursor > 0);
  assert.ok(fx.debris.cursor > 0);
  assert.equal(fx.explosion.uniforms.uSoftFade.value, 4);
  assert.equal(fx.smoke.uniforms.uSoftFade.value, 10);
  assert.equal(frameUniforms.uSoftFade.value, 40);
  assert.ok(emissions.get(fx.explosion).position.clone().sub(impact.position).dot(impact.normal) >= 2.5);
  assert.ok(emissions.get(fx.smoke).position.clone().sub(impact.position).dot(impact.normal) >= 4.5);
  assert.ok(emissions.get(fx.sparks).position.clone().sub(impact.position).dot(impact.normal) >= 2);
  assert.equal(emissions.get(fx.smoke).inherit.lengthSq(), 0);
  assert.equal(emissions.get(fx.sparks).inherit.lengthSq(), 0);
  assert.ok(emissions.get(fx.debris).inherit.dot(impact.velocity) > 0);
  assert.ok(emissions.get(fx.debris).inherit.length() <= impact.speed * 0.05);
  assert.ok(emissions.get(fx.sparks).velocity.dot(impact.normal) > 0);
  assert.ok(fx.smoke.cursor <= fx.smoke.active);
  assert.ok(fx.explosion.uniforms.uGlow.value <= 1.4);
  assert.ok(fx.explosion.uniforms.uOpacity.value <= 0.7);
  assert.ok(fx.explosion.uniforms.uEndSize.value <= 2.1);

  fx.resetImpact();
  assert.equal(fx.impactBlast.shell.visible, false);
  assert.equal(fx.impactBlast.light.intensity, 0);
  fx.dispose();
});

test('orange lobe footprint clears the measured 300 and 800 ms coverage gates', () => {
  const fx = new FlightFx(environment());
  fx.setQuality(TIERS.high);
  let lobe = null;
  const emit = fx.explosion.emit.bind(fx.explosion);
  fx.explosion.emit = (count, spawn) => {
    lobe = {
      count,
      spread: spawn.spread,
      size: spawn.size,
      sizeVariance: spawn.sizeVariance,
      life: spawn.life,
      lifeVariance: spawn.lifeVariance,
    };
    emit(count, spawn);
  };
  fx.crash({
    position: new THREE.Vector3(),
    velocity: new THREE.Vector3(90, -165, -40),
    normal: new THREE.Vector3(0, 1, 0),
    speed: 192,
    strength: 1,
  });

  const maximumLife = lobe.life * (1 + lobe.lifeVariance);
  const minimumLife = lobe.life * (1 - lobe.lifeVariance);
  const t300 = THREE.MathUtils.clamp(0.3 / minimumLife, 0, 1);
  const maximumDiameter300 = lobe.size * (1 + lobe.sizeVariance)
    * THREE.MathUtils.lerp(1, fx.explosion.uniforms.uEndSize.value, t300);
  const t800 = THREE.MathUtils.clamp(0.8 / maximumLife, 0, 1);
  const warmFade800 = 1 - smoothstep(fx.explosion.uniforms.uFadeOut.value, 1, t800);

  assert.ok(maximumLife <= 0.87, `orange lobe survives ${maximumLife.toFixed(3)}s`);
  assert.ok(maximumDiameter300 <= 7.5, `300ms billboard diameter ${maximumDiameter300.toFixed(2)}m`);
  assert.ok(lobe.spread <= 0.56, `orange lobe spread ${lobe.spread}`);
  assert.ok(warmFade800 <= 0.06, `800ms warm fade ${warmFade800.toFixed(3)}`);
  fx.dispose();
});

test('orange lobe 300ms screen extent stays below 32 percent across random seeds', () => {
  const viewportWidth = 990;
  const viewportHeight = 912;
  const camera = new THREE.PerspectiveCamera(58, viewportWidth / viewportHeight, 4, 1000);
  const incoming = new THREE.Vector3(90, 0, -40).normalize();
  camera.position.copy(incoming).multiplyScalar(-48).add(new THREE.Vector3(0, 18, 0));
  camera.lookAt(0, 4, 0);
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();
  const impact = {
    position: new THREE.Vector3(),
    velocity: new THREE.Vector3(90, -165, -40),
    normal: new THREE.Vector3(0, 1, 0),
    speed: 192,
    strength: 1,
  };
  const originalRandom = Math.random;
  let worst = 0;
  try {
    for (let sample = 0; sample < 24; sample++) {
      let seed = (0x9e3779b9 ^ (sample * 0x85ebca6b)) >>> 0;
      Math.random = () => {
        seed = (1664525 * seed + 1013904223) >>> 0;
        return seed / 0x100000000;
      };
      const fx = new FlightFx(environment());
      fx.setQuality(TIERS.high);
      fx.crash(impact);
      const system = fx.explosion;
      const age = 0.3;
      const gravity = system.uniforms.uGravity.value;
      const drag = Math.max(system.uniforms.uDrag.value, 1e-3);
      const travel = (1 - Math.exp(-drag * age)) / drag;
      const focal = viewportHeight / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) * 0.5));
      const point = new THREE.Vector3();
      const velocity = new THREE.Vector3();
      const viewPoint = new THREE.Vector3();
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (let i = 0; i < system.active; i++) {
        const life = system.data.life[i];
        if (life < age) continue;
        point.fromArray(system.data.start, i * 3);
        velocity.fromArray(system.data.velocity, i * 3);
        point.addScaledVector(velocity, travel).addScaledVector(gravity, 0.5 * age * age);
        viewPoint.copy(point).applyMatrix4(camera.matrixWorldInverse);
        if (viewPoint.z >= -camera.near) continue;
        const projected = point.clone().project(camera);
        const t = age / life;
        const grownSize = system.data.size[i]
          * THREE.MathUtils.lerp(1, system.uniforms.uEndSize.value, t);
        const radiusPx = grownSize * 0.5 * focal / -viewPoint.z;
        const x = (projected.x * 0.5 + 0.5) * viewportWidth;
        const y = (-projected.y * 0.5 + 0.5) * viewportHeight;
        minX = Math.min(minX, x - radiusPx);
        maxX = Math.max(maxX, x + radiusPx);
        minY = Math.min(minY, y - radiusPx);
        maxY = Math.max(maxY, y + radiusPx);
      }
      const extent = Math.max(maxX - minX, maxY - minY) / viewportHeight;
      worst = Math.max(worst, extent);
      fx.dispose();
    }
  } finally {
    Math.random = originalRandom;
  }
  assert.ok(worst <= 0.32, `worst seeded 300ms lobe extent ${(worst * 100).toFixed(1)}%`);
});

test('crash particles remain alive above the impact plane after shell clearance', () => {
  const fx = new FlightFx(environment());
  fx.setQuality(TIERS.high);
  const impact = {
    position: new THREE.Vector3(0, 5000, 0),
    velocity: new THREE.Vector3(90, -165, -40),
    normal: new THREE.Vector3(0.2, 0.96, -0.1).normalize(),
    speed: 192,
    strength: 1,
  };
  let seed = 0x1badb002;
  const originalRandom = Math.random;
  Math.random = () => {
    seed = (1664525 * seed + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
  try {
    fx.crash(impact);
    const aliveAbove = (system, age, minimumHeight = 0) => {
      let count = 0;
      const point = new THREE.Vector3();
      const velocity = new THREE.Vector3();
      const gravity = system.uniforms.uGravity.value;
      const drag = Math.max(system.uniforms.uDrag.value, 1e-3);
      const travel = (1 - Math.exp(-drag * age)) / drag;
      for (let i = 0; i < system.active; i++) {
        if (system.data.life[i] < age) continue;
        point.fromArray(system.data.start, i * 3);
        velocity.fromArray(system.data.velocity, i * 3);
        point.addScaledVector(velocity, travel).addScaledVector(gravity, 0.5 * age * age);
        if (point.sub(impact.position).dot(impact.normal) >= minimumHeight) count++;
      }
      return count;
    };

    assert.ok(aliveAbove(fx.explosion, 0.3, 0.5) >= 8, 'fire lobes buried or dead at 300 ms');
    assert.ok(aliveAbove(fx.sparks, 0.3, 0.25) >= 16, 'sparks buried at 300 ms');
    assert.ok(aliveAbove(fx.smoke, 0.8, 1) >= 20, 'smoke buried at 800 ms');
  } finally {
    Math.random = originalRandom;
    fx.dispose();
  }
});

test('staged crash fire stays within the active phone particle budget', () => {
  const fx = new FlightFx(environment());
  fx.setQuality(TIERS.phone);
  let emitted = 0;
  const emit = fx.explosion.emit.bind(fx.explosion);
  fx.explosion.emit = (count, spawn) => {
    emitted += count;
    emit(count, spawn);
  };

  fx.crash({
    position: new THREE.Vector3(),
    velocity: new THREE.Vector3(100, -80, 0),
    normal: new THREE.Vector3(0, 1, 0),
    speed: 128,
    strength: 1,
  });

  assert.ok(emitted <= fx.explosion.active);
  fx.dispose();
});

test('aircraft crash presentation hides the jet and exhaust until reset', () => {
  const aircraft = new Aircraft(environment());
  const flight = {
    position: new THREE.Vector3(7, 4800, -3),
    orientation: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.4),
    throttleSmoothed: 1,
  };

  aircraft.setCrashPresentation(true);
  assert.equal(aircraft.model.visible, false);
  assert.equal(aircraft.exhaust.visible, false);
  aircraft.update(1 / 60, flight);
  assert.ok(aircraft.group.position.equals(flight.position));
  assert.ok(aircraft.group.quaternion.equals(flight.orientation));
  assert.equal(aircraft.model.visible, false);
  assert.equal(aircraft.exhaust.visible, false);

  aircraft.setCrashPresentation(false);
  assert.equal(aircraft.model.visible, true);
  assert.equal(aircraft.exhaust.visible, true);
  aircraft.dispose();
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
