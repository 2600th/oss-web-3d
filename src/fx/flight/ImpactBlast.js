import * as THREE from 'three';
import {
  IMPACT_RING_FRAGMENT,
  IMPACT_RING_VERTEX,
  IMPACT_SHELL_FRAGMENT,
  IMPACT_SHELL_VERTEX,
} from './impact-blast.glsl.js';

const UP = new THREE.Vector3(0, 1, 0);
const RING_LIFE = 0.9;
const SHELL_LIFE = 1.25;
const LIGHT_LIFE = 0.35;
// Dimensionless decay constant for a fast ignition spike. Normalizing expm1
// keeps the peak at one and the 350 ms boundary exactly at zero.
const LIGHT_DECAY_K = 5;
const RING_SEGMENTS = Object.freeze({ phone: 32, low: 48, medium: 72, high: 96 });

function clamp01(value) {
  return THREE.MathUtils.clamp(value, 0, 1);
}

function flashEnvelope(progress) {
  if (progress >= 1) return 0;
  return Math.expm1(LIGHT_DECAY_K * (1 - progress)) / Math.expm1(LIGHT_DECAY_K);
}

/**
 * Build all ring tiers into one maximum-detail buffer. Each draw range indexes
 * a complete circle, so lowering quality never turns the shockwave into an arc.
 */
function createRingGeometry() {
  const maxSegments = RING_SEGMENTS.high;
  const positions = new Float32Array(maxSegments * 2 * 3);
  const uvs = new Float32Array(maxSegments * 2 * 2);
  for (let i = 0; i < maxSegments; i++) {
    const angle = (i / maxSegments) * Math.PI * 2;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const inner = i * 6;
    const outer = inner + 3;
    positions[inner] = cos * 0.91;
    positions[inner + 2] = sin * 0.91;
    positions[outer] = cos * 1.09;
    positions[outer + 2] = sin * 1.09;
    const uv = i * 4;
    uvs[uv] = i / maxSegments;
    uvs[uv + 1] = 0;
    uvs[uv + 2] = i / maxSegments;
    uvs[uv + 3] = 1;
  }

  const ranges = {};
  const indices = [];
  for (const [name, segments] of Object.entries(RING_SEGMENTS)) {
    const start = indices.length;
    for (let segment = 0; segment < segments; segment++) {
      const current = Math.round((segment / segments) * maxSegments) % maxSegments;
      const next = Math.round(((segment + 1) / segments) * maxSegments) % maxSegments;
      const a = current * 2;
      const b = a + 1;
      const c = next * 2;
      const d = c + 1;
      indices.push(a, b, d, a, d, c);
    }
    ranges[name] = { start, count: segments * 6 };
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.userData.qualityRanges = ranges;
  geometry.computeBoundingSphere();
  return geometry;
}

function material(vertexShader, fragmentShader, uniforms) {
  return new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader,
    fragmentShader,
    uniforms,
    transparent: true,
    depthTest: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  });
}

export class ImpactBlast {
  constructor() {
    this.group = new THREE.Group();
    this.group.name = 'fx:impact-blast';

    this.shell = new THREE.Mesh(
      new THREE.IcosahedronGeometry(1, 3),
      material(IMPACT_SHELL_VERTEX, IMPACT_SHELL_FRAGMENT, {
        uAge: { value: 0 },
        uStrength: { value: 1 },
      }),
    );
    this.shell.name = 'fx:impact-shell';
    this.shell.visible = false;
    this.shell.frustumCulled = false;
    this.shell.renderOrder = 21;

    const ringGeometry = createRingGeometry();
    this.ring = new THREE.Mesh(
      ringGeometry,
      material(IMPACT_RING_VERTEX, IMPACT_RING_FRAGMENT, {
        uAge: { value: 0 },
        uStrength: { value: 1 },
      }),
    );
    this.ring.name = 'fx:impact-ring';
    this.ring.visible = false;
    this.ring.frustumCulled = false;
    this.ring.renderOrder = 20;

    this.light = new THREE.PointLight(0xff9b52, 0, 120, 2);
    this.light.name = 'fx:impact-light';
    this.light.castShadow = false;

    this.group.add(this.shell, this.ring, this.light);
    this._age = SHELL_LIFE;
    this._strength = 1;
    this._peakLight = 0;
    this._disposed = false;
    this._impactAxis = new THREE.Vector3();
    this._impactNormal = new THREE.Vector3();
    this.setQuality({ name: 'high' });
  }

  trigger(impact) {
    if (this._disposed) return;
    this._age = 0;
    this._strength = clamp01(impact.strength);
    this._peakLight = 145000 * this._strength;
    this.group.position.copy(impact.position);
    this._impactAxis.copy(impact.velocity).negate();
    if (this._impactAxis.lengthSq() < 1e-8) this._impactAxis.copy(UP);
    else this._impactAxis.normalize();
    this._impactNormal.copy(impact.normal);
    if (this._impactNormal.lengthSq() < 1e-8) this._impactNormal.copy(UP);
    else this._impactNormal.normalize();
    this.shell.quaternion.setFromUnitVectors(UP, this._impactAxis);
    this.ring.quaternion.setFromUnitVectors(UP, this._impactNormal);
    this.light.position.copy(this._impactNormal).multiplyScalar(2.5);
    this.shell.material.uniforms.uAge.value = 0;
    this.shell.material.uniforms.uStrength.value = this._strength;
    this.ring.material.uniforms.uAge.value = 0;
    this.ring.material.uniforms.uStrength.value = this._strength;
    this.shell.scale.setScalar(2.2);
    this.ring.scale.setScalar(2.5);
    this.shell.visible = true;
    this.ring.visible = true;
    this.light.intensity = this._peakLight;
  }

  update(dt) {
    if (this._disposed || !Number.isFinite(dt) || dt <= 0 || this._age >= SHELL_LIFE) return;
    this._age += dt;

    const shellAge = clamp01(this._age / SHELL_LIFE);
    this.shell.material.uniforms.uAge.value = shellAge;
    this.shell.scale.setScalar(THREE.MathUtils.lerp(2.2, 19, Math.sqrt(shellAge)));

    const ringAge = clamp01(this._age / RING_LIFE);
    this.ring.material.uniforms.uAge.value = ringAge;
    const ringProgress = Math.pow(clamp01(this._age / 0.9), 0.55);
    const radius = THREE.MathUtils.lerp(2.5, 28, ringProgress);
    this.ring.scale.setScalar(radius);

    const lightAge = clamp01(this._age / LIGHT_LIFE);
    this.light.intensity = this._peakLight * flashEnvelope(lightAge);
    if (this._age >= RING_LIFE) this.ring.visible = false;
    if (this._age >= SHELL_LIFE) this.shell.visible = false;
  }

  setQuality(tier) {
    const name = RING_SEGMENTS[tier?.name] ? tier.name : 'high';
    const { start, count } = this.ring.geometry.userData.qualityRanges[name];
    this.ring.geometry.setDrawRange(start, count);
  }

  reset() {
    this._age = SHELL_LIFE;
    this.shell.visible = false;
    this.ring.visible = false;
    this.light.intensity = 0;
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this.reset();
    this.shell.geometry.dispose();
    this.shell.material.dispose();
    this.ring.geometry.dispose();
    this.ring.material.dispose();
    this.group.clear();
  }
}
