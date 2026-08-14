import * as THREE from 'three';
import {
  LakeField,
  LAKE_SURFACE_SEGMENTS,
  lakeSurfaceMesh,
} from './lakes.js';
import { WATER_FRAGMENT_SHADER, WATER_VERTEX_SHADER } from './water.glsl.js';

const TAU = Math.PI * 2;
const CAPILLARY = 0.000074;
const SURFACE_SEGMENTS = LAKE_SURFACE_SEGMENTS;

const WAVES = [
  [0.923076923, 0.384615385, 34, 0.095, 0.42],
  [-0.316227766, 0.948683298, 17, 0.052, 0.36],
  [0.624695048, -0.780868809, 7.8, 0.022, 0.28],
  [-0.857492926, -0.514495755, 2.6, 0.0075, 0.18],
  [0.196116135, 0.980580676, 0.72, 0.0022, 0.08],
  [-0.707106781, 0.707106781, 0.18, 0.00055, 0.03],
];

export const WATER_QUALITY = Object.freeze({
  high: Object.freeze({ waveCount: 6, caustics: 2, refraction: true, exactFresnel: true, radialRings: 12, maxLakes: 48, drawDistance: 26000 }),
  medium: Object.freeze({ waveCount: 5, caustics: 1, refraction: true, exactFresnel: true, radialRings: 10, maxLakes: 36, drawDistance: 22000 }),
  low: Object.freeze({ waveCount: 3, caustics: 0, refraction: false, exactFresnel: false, radialRings: 8, maxLakes: 24, drawDistance: 16000 }),
  phone: Object.freeze({ waveCount: 2, caustics: 0, refraction: false, exactFresnel: false, radialRings: 6, maxLakes: 12, drawDistance: 11000 }),
});

export function schlickFresnel(cosTheta, etaIncident = 1, etaTransmitted = 1.33) {
  const r = (etaIncident - etaTransmitted) / (etaIncident + etaTransmitted);
  const f0 = r * r;
  const grazing = 1 - Math.min(Math.max(cosTheta, 0), 1);
  return f0 + (1 - f0) * grazing ** 5;
}

/** Exact unpolarised dielectric Fresnel reflectance. */
export function dielectricFresnel(cosTheta, etaIncident = 1, etaTransmitted = 1.33) {
  const ci = Math.min(Math.max(cosTheta, 0), 1);
  const ratio = etaIncident / etaTransmitted;
  const sinTransmitted2 = ratio * ratio * Math.max(0, 1 - ci * ci);
  if (sinTransmitted2 >= 1) return 1;
  const ct = Math.sqrt(Math.max(0, 1 - sinTransmitted2));
  const rs = (etaIncident * ci - etaTransmitted * ct) /
    Math.max(etaIncident * ci + etaTransmitted * ct, 1e-12);
  const rp = (etaTransmitted * ci - etaIncident * ct) /
    Math.max(etaTransmitted * ci + etaIncident * ct, 1e-12);
  return 0.5 * (rs * rs + rp * rp);
}

export function beerLambertSample(color, distance, absorption = [0.052, 0.024, 0.012]) {
  const path = Math.max(distance, 0);
  return [
    Math.min(Math.max(color[0] * Math.exp(-absorption[0] * path), 0), 1),
    Math.min(Math.max(color[1] * Math.exp(-absorption[1] * path), 0), 1),
    Math.min(Math.max(color[2] * Math.exp(-absorption[2] * path), 0), 1),
  ];
}

export function gerstnerSample(x, z, time, waveCount = 6) {
  let height = 0;
  let horizontalX = 0;
  let horizontalZ = 0;
  let dPxdx = 1;
  let dPxdz = 0;
  let dPydx = 0;
  let dPydz = 0;
  let dPzdx = 0;
  let dPzdz = 1;
  const count = Math.min(Math.max(waveCount | 0, 0), WAVES.length);
  for (let i = 0; i < count; i++) {
    const wave = WAVES[i];
    const k = TAU / wave[2];
    const phase = k * (wave[0] * x + wave[1] * z) +
      Math.sqrt(9.81 * k + CAPILLARY * k * k * k) * time;
    height += wave[3] * Math.sin(phase);
    const horizontal = wave[4] * wave[3] * Math.cos(phase);
    horizontalX += wave[0] * horizontal;
    horizontalZ += wave[1] * horizontal;
    const slope = wave[3] * k * Math.cos(phase);
    const compression = wave[4] * wave[3] * k * Math.sin(phase);
    dPxdx -= wave[0] * wave[0] * compression;
    dPxdz -= wave[0] * wave[1] * compression;
    dPydx += wave[0] * slope;
    dPydz += wave[1] * slope;
    dPzdx -= wave[1] * wave[0] * compression;
    dPzdz -= wave[1] * wave[1] * compression;
  }
  const nx = dPydz * dPzdx - dPzdz * dPydx;
  const ny = dPzdz * dPxdx - dPxdz * dPzdx;
  const nz = dPxdz * dPydx - dPydz * dPxdx;
  const invLength = 1 / Math.hypot(nx, ny, nz);
  return {
    height,
    horizontal: [horizontalX, horizontalZ],
    normal: [nx * invLength, ny * invLength, nz * invLength],
  };
}

function sharedUniform(source, name, fallback) {
  return source?.uniforms?.[name] || { value: fallback };
}

function makeGeometry(profile) {
  const maxLakes = profile.maxLakes;
  const radialRings = profile.radialRings;
  const verticesPerLake = 1 + radialRings * SURFACE_SEGMENTS;
  const indicesPerLake = SURFACE_SEGMENTS * (1 + (radialRings - 1) * 2) * 3;
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array(maxLakes * verticesPerLake * 3);
  const depths = new Float32Array(maxLakes * verticesPerLake);
  const shoreDistances = new Float32Array(maxLakes * verticesPerLake);
  const indexCount = maxLakes * indicesPerLake;
  const IndexArray = maxLakes * verticesPerLake > 65535 ? Uint32Array : Uint16Array;
  const indices = new IndexArray(indexCount);

  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aDepth', new THREE.BufferAttribute(depths, 1));
  geometry.setAttribute('aShoreDistance', new THREE.BufferAttribute(shoreDistances, 1));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.setDrawRange(0, 0);
  geometry.userData.radialRings = radialRings;
  geometry.userData.verticesPerLake = verticesPerLake;
  geometry.userData.outerRingStart = 1 + (radialRings - 1) * SURFACE_SEGMENTS;
  return geometry;
}

function makeMaterial(environment, profile) {
  const uniforms = {
    uTime: sharedUniform(environment, 'uTime', 0),
    uSunDir: sharedUniform(environment, 'uSunDir', new THREE.Vector3(0.45, 0.72, 0.25).normalize()),
    uSunColor: sharedUniform(environment, 'uSunColor', new THREE.Color(1, 0.94, 0.84)),
    uZenithColor: sharedUniform(environment, 'uZenithColor', new THREE.Color(0.03, 0.09, 0.3)),
    uHorizonColor: sharedUniform(environment, 'uHorizonColor', new THREE.Color(0.56, 0.68, 0.85)),
    uCameraPosition: { value: new THREE.Vector3() },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uCameraNear: { value: 0.1 },
    uCameraFar: { value: 750000 },
    uSceneColor: { value: null },
    uSceneDepth: { value: null },
    uHasRefraction: { value: 0 },
    uWaveFadeDistance: { value: profile.drawDistance },
  };
  return new THREE.ShaderMaterial({
    name: 'GlacialLakeWater',
    glslVersion: THREE.GLSL3,
    vertexShader: WATER_VERTEX_SHADER,
    fragmentShader: WATER_FRAGMENT_SHADER,
    uniforms,
    defines: {
      WATER_WAVES: profile.waveCount,
      WATER_CAUSTICS: profile.caustics,
      WATER_REFRACTION: profile.refraction ? 1 : 0,
      WATER_EXACT_FRESNEL: profile.exactFresnel ? 1 : 0,
    },
    depthTest: true,
    depthWrite: true,
    transparent: false,
    toneMapped: true,
  });
}

/**
 * One draw-call surface batch for the deterministic LakeField around an observer.
 * The renderer argument is retained for integration symmetry; no GPU resources
 * are created outside Three's normal lazy material compilation.
 */
export class Water extends THREE.Mesh {
  constructor(renderer, environment, options = {}) {
    const quality = WATER_QUALITY[options.quality] ? options.quality : 'high';
    const base = WATER_QUALITY[quality];
    const profile = {
      ...base,
      maxLakes: options.maxLakes ?? base.maxLakes,
      drawDistance: options.drawDistance ?? base.drawDistance,
    };
    const geometry = makeGeometry(profile);
    const material = makeMaterial(environment, profile);
    super(geometry, material);

    this.name = 'GlacialLakeWater';
    this.renderer = renderer;
    this.environment = environment;
    this.quality = quality;
    this.profile = profile;
    this.field = options.field || new LakeField(profile);
    this.ownsField = !options.field;
    this.visibleLakeCount = 0;
    this.hasRefraction = false;
    this.frustumCulled = false;
    this._fieldVersion = -1;
    this._pruneClock = 0;
    this._disposed = false;
    this._lakeMeshes = new WeakMap();
  }

  update(dt, cameraOrPosition) {
    const position = cameraOrPosition?.isCamera ? cameraOrPosition.position : cameraOrPosition;
    if (!position) return;
    this.material.uniforms.uCameraPosition.value.copy(position);
    if (cameraOrPosition?.isCamera) {
      this.material.uniforms.uCameraNear.value = cameraOrPosition.near;
      this.material.uniforms.uCameraFar.value = cameraOrPosition.far;
    }
    this.field.update(position.x, position.z, this.quality === 'phone' ? 4 : 8);
    if (this.field.version !== this._fieldVersion) this._rebuildBatch();

    this._pruneClock += Math.max(dt || 0, 0);
    if (this._pruneClock >= 15) {
      this._pruneClock = 0;
      this.field.prune?.(position.x, position.z);
    }
  }

  _rebuildBatch() {
    const position = this.geometry.attributes.position;
    const depth = this.geometry.attributes.aDepth;
    const shore = this.geometry.attributes.aShoreDistance;
    const index = this.geometry.index;
    const count = Math.min(this.field.activeCount, this.profile.maxLakes);
    let vertexCursor = 0;
    let indexCursor = 0;

    for (let lakeIndex = 0; lakeIndex < count; lakeIndex++) {
      const lake = this.field.active[lakeIndex];
      let mesh = this._lakeMeshes.get(lake);
      if (
        !mesh || mesh.x !== lake.x || mesh.z !== lake.z || mesh.level !== lake.level ||
        mesh.radialRings !== this.profile.radialRings
      ) {
        mesh = lakeSurfaceMesh(lake, this.profile.radialRings);
        this._lakeMeshes.set(lake, mesh);
      }
      const baseVertex = vertexCursor;
      position.array.set(mesh.positions, baseVertex * 3);
      depth.array.set(mesh.depths, baseVertex);
      shore.array.set(mesh.shores, baseVertex);
      for (let i = 0; i < mesh.indices.length; i++) {
        index.array[indexCursor++] = baseVertex + mesh.indices[i];
      }
      vertexCursor += mesh.vertexCount;
    }

    position.needsUpdate = true;
    depth.needsUpdate = true;
    shore.needsUpdate = true;
    index.needsUpdate = true;
    this.geometry.setDrawRange(0, indexCursor);
    this.visibleLakeCount = count;
    this.visible = count > 0;
    this._fieldVersion = this.field.version;
  }

  setSize(width, height, pixelRatio = 1) {
    this.material.uniforms.uResolution.value.set(
      Math.max(1, Math.floor(width * pixelRatio)),
      Math.max(1, Math.floor(height * pixelRatio)),
    );
  }

  setRefractionSource({ colorTexture, depthTexture, width, height, near, far } = {}) {
    const uniforms = this.material.uniforms;
    uniforms.uSceneColor.value = colorTexture || null;
    uniforms.uSceneDepth.value = depthTexture || null;
    if (width && height) uniforms.uResolution.value.set(width, height);
    if (near > 0) uniforms.uCameraNear.value = near;
    if (far > 0) uniforms.uCameraFar.value = far;
    this.hasRefraction = Boolean(this.profile.refraction && colorTexture && depthTexture);
    uniforms.uHasRefraction.value = this.hasRefraction ? 1 : 0;
    return this.hasRefraction;
  }

  clearRefractionSource() {
    const uniforms = this.material.uniforms;
    uniforms.uSceneColor.value = null;
    uniforms.uSceneDepth.value = null;
    uniforms.uHasRefraction.value = 0;
    this.hasRefraction = false;
  }

  setQuality(quality) {
    const profile = WATER_QUALITY[quality];
    if (!profile) throw new RangeError(`Unknown water quality: ${quality}`);
    if (quality === this.quality) return false;

    const oldGeometry = this.geometry;
    const oldMaterial = this.material;
    const oldUniforms = oldMaterial.uniforms;
    const colorTexture = oldUniforms.uSceneColor.value;
    const depthTexture = oldUniforms.uSceneDepth.value;

    this.quality = quality;
    this.profile = { ...profile };
    this.geometry = makeGeometry(profile);
    this.material = makeMaterial(this.environment, profile);
    this._lakeMeshes = new WeakMap();
    this.material.uniforms.uCameraPosition.value.copy(oldUniforms.uCameraPosition.value);
    this.material.uniforms.uResolution.value.copy(oldUniforms.uResolution.value);
    this.material.uniforms.uCameraNear.value = oldUniforms.uCameraNear.value;
    this.material.uniforms.uCameraFar.value = oldUniforms.uCameraFar.value;

    if (this.ownsField) {
      this.field.configure(profile);
    }

    this._fieldVersion = -1;
    this._rebuildBatch();
    if (colorTexture && depthTexture) {
      this.setRefractionSource({
        colorTexture,
        depthTexture,
        width: oldUniforms.uResolution.value.x,
        height: oldUniforms.uResolution.value.y,
        near: oldUniforms.uCameraNear.value,
        far: oldUniforms.uCameraFar.value,
      });
    }
    oldGeometry.dispose();
    oldMaterial.dispose();
    return true;
  }

  waterLevelAt(x, z) {
    return this.field.waterLevelAt?.(x, z, this.profile.radialRings) ?? -Infinity;
  }

  waterDepthAt(x, z) {
    return this.field.waterDepthAt?.(x, z, this.profile.radialRings) ?? 0;
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this.clearRefractionSource();
    this.geometry.dispose();
    this.material.dispose();
    this._lakeMeshes = new WeakMap();
    if (this.ownsField) this.field.dispose?.();
  }
}
