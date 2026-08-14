import * as THREE from 'three';
import { terrainHeight, terrainSlope } from '../world/heightfield.js';
import {
  ParticleSystem,
  ParticleShape,
  RateEmitter,
  DistanceEmitter,
} from './gpu/ParticleSystem.js';
import { Ribbon } from './gpu/Ribbon.js';
import { frameUniforms, updateFrameUniforms } from './gpu/FrameUniforms.js';
import { ImpactBlast } from './flight/ImpactBlast.js';

const SYSTEM_KEYS = Object.freeze([
  'speedStreaks',
  'condensation',
  'spindrift',
  'explosion',
  'smoke',
  'sparks',
  'debris',
]);

const BUDGETS = Object.freeze({
  phone: { drift: 32, condense: 32, trail: 0, explosion: 32, smoke: 64, sparks: 48, debris: 16 },
  low: { drift: 48, condense: 56, trail: 0, explosion: 48, smoke: 96, sparks: 80, debris: 24 },
  medium: { drift: 110, condense: 120, trail: 160, explosion: 72, smoke: 160, sparks: 144, debris: 40 },
  high: { drift: 180, condense: 220, trail: 256, explosion: 96, smoke: 256, sparks: 240, debris: 64 },
});

const WHITE = new THREE.Color(0.94, 0.97, 1.0);
const ICE = new THREE.Color(0.70, 0.86, 1.0);
const FIRE = new THREE.Color(1.0, 0.24, 0.025);
const EMBER = new THREE.Color(1.0, 0.72, 0.12);
const SOOT = new THREE.Color(0.14, 0.16, 0.18);
const METAL = new THREE.Color(0.34, 0.36, 0.37);

const SPEED_STREAK_WIDTH_PX = 0.8;
const SPEED_STREAK_LENGTH_PX = 8.5;
const SPEED_STREAK_NEAR = 148;
const SPEED_STREAK_FAR = 158;

/** Project world-space streak dimensions through a vertical perspective FOV. */
export function speedStreakMetrics({
  worldWidth,
  worldLength,
  distance,
  fov,
  viewportHeight,
}) {
  const focalLengthPx = viewportHeight / (2 * Math.tan(THREE.MathUtils.degToRad(fov) * 0.5));
  const pixelsPerWorldUnit = focalLengthPx / distance;
  return {
    widthPx: worldWidth * pixelsPerWorldUnit,
    lengthPx: worldLength * pixelsPerWorldUnit,
  };
}

/**
 * GPU-authored flight effects. The CPU only appends births to ring buffers;
 * age, drag, gravity, wind, turbulence, spreading and fading are evaluated in
 * shaders from the shared frame clock.
 */
export class FlightFx {
  constructor(environment) {
    this.environment = environment;
    this.group = new THREE.Group();
    this.group.name = 'FlightFx';

    this.speedStreaks = new ParticleSystem({
      name: 'speed-streaks', capacity: 700, shape: ParticleShape.STREAK,
      additive: true, stretch: true, depthTest: false, softDepth: false, renderOrder: 14,
    });
    this.condensation = new ParticleSystem({
      name: 'wing-condensation', capacity: 220, shape: ParticleShape.STREAK,
      additive: false, lit: true, curl: true, stretch: true, wind: true, renderOrder: 13,
    });
    this.spindrift = new ParticleSystem({
      name: 'ridge-spindrift', capacity: 180, shape: ParticleShape.SMOKE,
      additive: false, lit: true, curl: true, wind: true, renderOrder: 12,
    });
    this.explosion = new ParticleSystem({
      name: 'impact-fireball', capacity: 96, shape: ParticleShape.SOFT,
      additive: true, curl: true, softFade: 4, renderOrder: 15,
    });
    this.smoke = new ParticleSystem({
      name: 'impact-smoke', capacity: 256, shape: ParticleShape.SMOKE,
      additive: false, lit: true, curl: true, wind: true, softFade: 10, renderOrder: 13,
    });
    this.sparks = new ParticleSystem({
      name: 'impact-sparks', capacity: 240, shape: ParticleShape.STREAK,
      additive: true, stretch: true, renderOrder: 16,
    });
    this.debris = new ParticleSystem({
      name: 'impact-debris', capacity: 64, shape: ParticleShape.CHIP,
      additive: false, lit: true, stretch: true, renderOrder: 14,
    });
    this.impactBlast = new ImpactBlast();

    this.trails = [0, 1].map((side) => new Ribbon({
      name: side ? 'right-contrail' : 'left-contrail', capacity: 256, life: 28,
    }));

    for (const key of SYSTEM_KEYS) this.group.add(this[key].mesh);
    for (const trail of this.trails) this.group.add(trail.mesh);
    this.group.add(this.impactBlast.group);
    this._configureMaterials();

    this._speedRate = new RateEmitter();
    this._condensationRate = new RateEmitter();
    this._driftRate = new RateEmitter();
    this._trailDistance = new DistanceEmitter(18);
    this._time = 0;
    this._disposed = false;

    this._position = new THREE.Vector3();
    this._velocity = new THREE.Vector3();
    this._direction = new THREE.Vector3();
    this._inherit = new THREE.Vector3();
    this._wing = new THREE.Vector3();
    this._impactNormal = new THREE.Vector3();
    this._reflected = new THREE.Vector3();
    this._tangent = new THREE.Vector3();
    this._cameraForward = new THREE.Vector3();
    this._cameraRight = new THREE.Vector3();
    this._cameraUp = new THREE.Vector3();
    this._spawn = {
      position: this._position,
      velocity: this._velocity,
      direction: this._direction,
      inherit: this._inherit,
      radius: 0,
      speed: 1,
      speedVariance: 0.2,
      spread: 0.2,
      size: 1,
      sizeVariance: 0.3,
      life: 1,
      lifeVariance: 0.25,
      spin: 0,
      tint: WHITE,
      time: 0,
    };
  }

  _configureMaterials() {
    const streak = this.speedStreaks.uniforms;
    streak.uGravity.value.set(0, 0, 0);
    streak.uDrag.value = 0.08;
    streak.uStretch.value = 0.04;
    streak.uEndSize.value = 1;
    // Additive blending multiplies RGB by alpha, so the old 0.24 * 0.18
    // combination contributed at most 0.043 linear light before the streak's
    // sub-pixel shape coverage and lifetime/distance fades. That was
    // effectively invisible after the cinematic grade. Keep alpha restrained
    // but give the ice core enough radiance to survive the full pipeline.
    streak.uGlow.value = 0.9;
    streak.uOpacity.value = 0.32;
    streak.uStreakCore.value = 1.25;
    streak.uDistFade.value.set(88, 100, 142, 160);
    this.speedStreaks.setGradient(ICE, WHITE, ICE, WHITE);

    for (const system of [this.condensation, this.spindrift]) {
      system.uniforms.uGravity.value.set(0, 0.25, 0);
      system.uniforms.uDrag.value = 1.15;
      system.uniforms.uTurbulence.value = 2.4;
      system.uniforms.uTurbFrequency.value = 0.018;
      system.uniforms.uWindScale.value = 0.65;
      system.uniforms.uEndSize.value = 1.8;
      system.uniforms.uOpacity.value = 0.18;
      system.setGradient(WHITE, ICE, WHITE, WHITE);
    }
    this.condensation.uniforms.uDistFade.value.set(0, 1, 2500, 4200);
    this.condensation.uniforms.uStretch.value = 0.006;
    this.spindrift.uniforms.uDistFade.value.set(20, 50, 1600, 2600);

    this.explosion.uniforms.uGravity.value.set(0, 2.0, 0);
    this.explosion.uniforms.uDrag.value = 2.5;
    this.explosion.uniforms.uEndSize.value = 3.5;
    this.explosion.uniforms.uGlow.value = 2.4;
    this.explosion.setGradient(new THREE.Color(1.0, 0.92, 0.62), EMBER, FIRE, SOOT);

    this.smoke.uniforms.uGravity.value.set(0, 2.8, 0);
    this.smoke.uniforms.uDrag.value = 0.48;
    this.smoke.uniforms.uTurbulence.value = 5.5;
    this.smoke.uniforms.uWindScale.value = 0.75;
    this.smoke.uniforms.uEndSize.value = 4.5;
    this.smoke.uniforms.uOpacity.value = 0.82;
    this.smoke.setGradient(new THREE.Color(0.34, 0.30, 0.25), SOOT, new THREE.Color(0.08, 0.09, 0.1), SOOT);

    this.sparks.uniforms.uGravity.value.set(0, -9.80665, 0);
    this.sparks.uniforms.uDrag.value = 0.38;
    this.sparks.uniforms.uStretch.value = 0.035;
    this.sparks.uniforms.uGlow.value = 2.0;
    this.sparks.setGradient(new THREE.Color(1, 0.94, 0.62), EMBER, FIRE, SOOT);

    this.debris.uniforms.uGravity.value.set(0, -9.80665, 0);
    this.debris.uniforms.uDrag.value = 0.18;
    this.debris.uniforms.uEndSize.value = 0.8;
    this.debris.setGradient(METAL, new THREE.Color(0.18, 0.19, 0.2), SOOT, SOOT);

    for (const trail of this.trails) {
      trail.uniforms.uSpread.value = 0.035;
      trail.uniforms.uTurb.value = 0.13;
      trail.uniforms.uOpacity.value = 0.18;
      trail.uniforms.uTaper.value = 0.04;
      trail.uniforms.uAlbedo.value.copy(WHITE);
    }
  }

  setQuality(tier) {
    const name = BUDGETS[tier?.name] ? tier.name : 'high';
    const budget = BUDGETS[name];
    this.speedStreaks.setActive(Math.min(this.speedStreaks.capacity, tier?.speedParticles ?? 700));
    this.spindrift.setActive(budget.drift);
    this.condensation.setActive(budget.condense);
    this.explosion.setActive(budget.explosion);
    this.smoke.setActive(budget.smoke);
    this.sparks.setActive(budget.sparks);
    this.debris.setActive(budget.debris);
    this.impactBlast.setQuality(tier);
    for (const trail of this.trails) trail.setActive(tier?.contrails ? budget.trail : 0);
    this._tier = name;
  }

  reset() {
    for (const key of SYSTEM_KEYS) this[key].reset();
    for (const trail of this.trails) trail.reset();
    this._speedRate.reset();
    this._condensationRate.reset();
    this._driftRate.reset();
    this._trailDistance.reset();
  }

  resetImpact() {
    this.impactBlast.reset();
  }

  update(dt, flight, cameraPos, camera = null) {
    this._time += dt;
    updateFrameUniforms(dt, this.environment, camera);
    this._updateSpeed(dt, flight, cameraPos, camera);
    this._updateCondensation(dt, flight);
    this._updateSpindrift(dt, flight);
    this.impactBlast.update(dt);
    for (const key of SYSTEM_KEYS) this[key].flush();
    for (const trail of this.trails) trail.flush();
  }

  _updateSpeed(dt, flight, cameraPos, camera) {
    const intensity = THREE.MathUtils.clamp((flight.airspeed - 135) / 240, 0, 1);
    this.speedStreaks.mesh.visible = intensity > 0.015 && this.speedStreaks.active > 0;
    if (!this.speedStreaks.mesh.visible) return;
    this._speedRate.rate = this.speedStreaks.active * (0.10 + intensity * 0.22);
    let owed = this._speedRate.tick(dt);
    if (owed <= 0) return;

    const viewForward = this._cameraForward;
    const viewRight = this._cameraRight;
    const viewUp = this._cameraUp;
    if (camera) {
      camera.getWorldDirection(viewForward);
      viewRight.setFromMatrixColumn(camera.matrixWorld, 0).normalize();
      viewUp.setFromMatrixColumn(camera.matrixWorld, 1).normalize();
    } else {
      viewForward.copy(flight.forward).normalize();
      viewRight.copy(flight.right).normalize();
      viewUp.crossVectors(viewRight, viewForward).normalize();
    }

    const fov = camera?.fov ?? 67;
    const aspect = camera?.aspect ?? (16 / 9);
    const tanHalfFov = Math.tan(THREE.MathUtils.degToRad(fov) * 0.5);
    const speed = Math.max(flight.velocity.length(), 1);
    const stretchRatio = SPEED_STREAK_LENGTH_PX / SPEED_STREAK_WIDTH_PX;
    this.speedStreaks.uniforms.uStretch.value = (stretchRatio - 1) / speed;
    this.speedStreaks.uniforms.uStretchWorld.value.copy(flight.velocity).multiplyScalar(-1);

    const spawn = this._spawn;
    spawn.inherit.set(0, 0, 0);
    spawn.velocity.set(0, 0, 0);
    spawn.radius = 0;
    spawn.speedVariance = 0;
    spawn.spread = 0;
    spawn.sizeVariance = 0.02;
    spawn.life = 0.58;
    spawn.lifeVariance = 0.2;
    spawn.spin = 0;
    spawn.tint = ICE;
    spawn.time = frameUniforms.uTime.value;
    while (owed-- > 0) {
      const depth = THREE.MathUtils.lerp(SPEED_STREAK_NEAR, SPEED_STREAK_FAR, Math.random());
      const halfHeight = depth * tanHalfFov;
      const halfWidth = halfHeight * aspect;
      const horizontal = (Math.random() * 2 - 1) * halfWidth * 0.5;
      const vertical = (Math.random() * 2 - 1) * halfHeight * 0.5;
      spawn.position.copy(cameraPos)
        .addScaledVector(viewForward, depth)
        .addScaledVector(viewRight, horizontal)
        .addScaledVector(viewUp, vertical);
      // Author in physical pixels at the current drawing-buffer height. A
      // fixed 720 px reference made the same streak 1.27x wider in the live
      // 990x912 acceptance viewport (and larger still on high-DPI displays),
      // violating the canopy-scratch cap despite the earlier 720p test.
      const viewportHeight = Math.max(frameUniforms.uResolution.value.y, 1);
      const worldPerPixel = 2 * depth * tanHalfFov / viewportHeight;
      spawn.size = SPEED_STREAK_WIDTH_PX * worldPerPixel;
      this.speedStreaks.emit(1, spawn);
    }
  }

  _updateCondensation(dt, flight) {
    const cold = THREE.MathUtils.clamp((flight.altitude - 6100) / 1200, 0, 1);
    const load = THREE.MathUtils.clamp((Math.abs(flight.gLoad) - 2.7) / 3.2, 0, 1);
    const strength = THREE.MathUtils.clamp(cold * 0.7 + load, 0, 1);
    const speedGate = THREE.MathUtils.clamp((flight.airspeed - 100) / 100, 0, 1);
    this._condensationRate.rate = this.condensation.active * 0.24 * strength * speedGate;
    const owed = this._condensationRate.tick(dt);
    const spawn = this._spawn;
    spawn.inherit.set(0, 0, 0);
    spawn.velocity.copy(flight.velocity).multiplyScalar(0.94);
    spawn.radius = 0.22;
    spawn.speedVariance = 0.02;
    spawn.spread = 0.04;
    spawn.size = 0.16 + load * 0.16;
    spawn.sizeVariance = 0.4;
    spawn.life = 1.4 + cold * 1.4;
    spawn.lifeVariance = 0.28;
    spawn.spin = 0.4;
    spawn.tint = WHITE;
    spawn.time = frameUniforms.uTime.value;
    this.condensation.uniforms.uStretchWorld.value.copy(flight.velocity).multiplyScalar(-0.06);
    for (let side = -1; side <= 1; side += 2) {
      spawn.position.copy(flight.position)
        .addScaledVector(flight.right, side * 3.35)
        .addScaledVector(flight.forward, -1.8);
      this.condensation.emit(Math.ceil(owed * 0.5), spawn);
    }

    if (!this.trails[0].active) return;
    if (strength < 0.08 || speedGate < 0.1) {
      for (const trail of this.trails) trail.break();
      return;
    }
    const nodes = this._trailDistance.tick(Math.max(0, flight.airspeed * dt));
    for (let n = 0; n < nodes; n++) {
      for (let side = 0; side < 2; side++) {
        const sign = side ? 1 : -1;
        this._wing.copy(flight.position)
          .addScaledVector(flight.right, sign * 3.35)
          // The chase camera sits about 26 m aft. Beginning the persistent
          // ribbon 58 m aft keeps its newest segment out of the lens corridor;
          // it remains visible as curved history during manoeuvres instead of
          // becoming two bright scratches from the bottom corners.
          .addScaledVector(flight.forward, -58);
        this.trails[side].push(this._wing, 0.42 + load * 0.5, frameUniforms.uTime.value);
      }
    }
  }

  _updateSpindrift(dt, flight) {
    const near = 1 - THREE.MathUtils.smoothstep(flight.agl, 420, 1450);
    this._driftRate.rate = this.spindrift.active * 0.38 * near;
    let owed = this._driftRate.tick(dt);
    const spawn = this._spawn;
    spawn.inherit.set(0, 0, 0);
    const wind = this.environment.uniforms.uWind.value;
    while (owed-- > 0) {
      const ahead = 240 + Math.random() * 950;
      const lateral = (Math.random() - 0.5) * 720;
      const x = flight.position.x + flight.forward.x * ahead + flight.right.x * lateral;
      const z = flight.position.z + flight.forward.z * ahead + flight.right.z * lateral;
      const height = terrainHeight(x, z);
      if (height < 4550 || terrainSlope(x, z, 28) < 0.2) continue;
      spawn.position.set(x, height + 3 + Math.random() * 9, z);
      spawn.velocity.set(wind.x * 0.9, 4.5, wind.y * 0.9);
      spawn.radius = 5;
      spawn.speedVariance = 0.32;
      spawn.spread = 0.24;
      spawn.size = 5.5;
      spawn.sizeVariance = 0.65;
      spawn.life = 3.2;
      spawn.lifeVariance = 0.35;
      spawn.spin = 0.4;
      spawn.tint = WHITE;
      spawn.time = frameUniforms.uTime.value;
      this.spindrift.emit(1, spawn);
    }
  }

  crash(impact) {
    const s = THREE.MathUtils.clamp(impact.strength, 0.2, 1);
    this.impactBlast.trigger(impact);

    const normal = this._impactNormal.copy(impact.normal);
    if (normal.lengthSq() < 1e-8) normal.set(0, 1, 0);
    else normal.normalize();
    const reflected = this._reflected.copy(impact.velocity).reflect(normal);
    if (reflected.lengthSq() < 1e-8) reflected.copy(normal);
    else reflected.normalize();
    const tangent = this._tangent.copy(impact.velocity)
      .addScaledVector(normal, -impact.velocity.dot(normal));
    if (tangent.lengthSq() < 1e-8) tangent.set(1, 0, 0).cross(normal).normalize();
    else tangent.normalize();

    const spawn = this._spawn;
    spawn.position.copy(impact.position);
    spawn.inherit.copy(impact.velocity).multiplyScalar(0.18);
    spawn.time = frameUniforms.uTime.value;

    // The short core reads as ignition, while the second emission supplies the
    // slower orange fuel lobes without allocating another particle material.
    spawn.velocity.copy(normal).multiplyScalar(9 + 5 * s);
    spawn.radius = 1.2;
    spawn.speedVariance = 0.35;
    spawn.spread = 0.45;
    spawn.size = 3.2 + 2.2 * s;
    spawn.sizeVariance = 0.25;
    spawn.life = 0.11;
    spawn.lifeVariance = 0.18;
    spawn.spin = 1;
    spawn.tint = WHITE;
    const coreCount = Math.min(this.explosion.active, Math.round(6 + 10 * s));
    this.explosion.emit(coreCount, spawn);

    spawn.velocity.copy(reflected).multiplyScalar(12 + 10 * s).addScaledVector(normal, 5);
    spawn.radius = 2.4;
    spawn.speedVariance = 0.65;
    spawn.spread = 0.75;
    spawn.size = 4 + 4 * s;
    spawn.sizeVariance = 0.45;
    spawn.life = 0.7 + s * 0.55;
    spawn.lifeVariance = 0.3;
    spawn.tint = EMBER;
    const lobeCount = Math.min(
      Math.max(0, this.explosion.active - coreCount),
      Math.round(12 + 36 * s),
    );
    this.explosion.emit(lobeCount, spawn);

    spawn.velocity.copy(tangent).multiplyScalar(5 + 4 * s).addScaledVector(normal, 12 + 8 * s);
    spawn.radius = 3.5;
    spawn.size = 4.5 + 3 * s;
    spawn.life = 6 + 5 * s;
    spawn.spin = 0.25;
    spawn.tint = SOOT;
    this.smoke.emit(Math.round(22 + 58 * s), spawn);

    spawn.velocity.copy(reflected).multiplyScalar(22 + 16 * s).addScaledVector(normal, 18);
    spawn.radius = 1.5;
    spawn.size = 0.11 + s * 0.12;
    spawn.life = 1.2 + s;
    spawn.spin = 0;
    spawn.tint = EMBER;
    this.sparks.emit(Math.round(35 + 110 * s), spawn);

    spawn.velocity.copy(reflected).multiplyScalar(10 + 9 * s).addScaledVector(normal, 8);
    spawn.inherit.copy(impact.velocity).multiplyScalar(0.3);
    spawn.radius = 2;
    spawn.size = 0.22 + s * 0.28;
    spawn.life = 3.5 + s * 2.5;
    spawn.spin = 7;
    spawn.tint = METAL;
    this.debris.emit(Math.round(8 + 34 * s), spawn);
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    for (const key of SYSTEM_KEYS) this[key].dispose();
    for (const trail of this.trails) trail.dispose();
    this.impactBlast.dispose();
    this.group.clear();
  }
}
