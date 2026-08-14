import * as THREE from 'three';

/**
 * One set of uniform objects shared by every effect material by reference.
 *
 * Adapted from LinearAbiltyCastingThreeJS (MIT), src/core/FrameUniforms.js.
 *
 * The alternative was to plumb time, sun and wind into each system's update()
 * and copy them into per-material uniforms. That is what the rest of this
 * project does through Environment.uniforms, and it is the right call there
 * because those uniforms are also *authored* per system. Here there are around
 * a dozen materials that all want exactly the same eight values, none of which
 * they modify, so sharing the objects means one write per frame instead of a
 * dozen and makes it impossible for two effects to disagree about what time it
 * is -- which they did, visibly, when the exhaust ran on performance.now() and
 * everything else ran on the accumulated frame delta.
 *
 * Never mutate the objects here from a material.
 */
export const frameUniforms = {
  uTime: { value: 0 },
  uResolution: { value: new THREE.Vector2(1920, 1080) },
  uCameraNear: { value: 4 },
  uCameraFar: { value: 750000 },
  uSceneDepth: { value: null },
  uSoftFade: { value: 40 },
  uSunDir: { value: new THREE.Vector3(0, 1, 0) },
  uSunColor: { value: new THREE.Color(1, 0.94, 0.84) },
  uSunIntensity: { value: 1.5 },
  /** Hemispheric fill, in the same linear radiance units as the sun term. */
  uFxAmbient: { value: new THREE.Color(0.10, 0.15, 0.26) },
  /** Environment wind, promoted to 3D (the environment stores it as XZ). */
  uWind: { value: new THREE.Vector3(11, 0, 4.5) },
};

const _materials = new Set();

/**
 * Merge the shared uniform objects with a material's own.
 *
 * Shallow on purpose: the *objects* are shared, so a later write to
 * frameUniforms.uTime.value is seen by every material without any further
 * bookkeeping.
 */
export function sharedUniforms(own) {
  return Object.assign({}, frameUniforms, own);
}

/**
 * Register a material so setSceneDepth() can toggle its soft-particle path.
 *
 * Soft depth is a compile-time define rather than a runtime branch because it
 * costs a texture fetch on the most fill-bound geometry in the frame, and
 * because the sampler has nothing to read until the post stack renders a depth
 * prepass. Materials created before the depth texture exists compile without it
 * and are recompiled once, when it arrives.
 */
export function registerFxMaterial(material) {
  _materials.add(material);
  if (frameUniforms.uSceneDepth.value) {
    material.defines.FX_SOFT_DEPTH = '';
    material.needsUpdate = true;
  }
  return material;
}

export function unregisterFxMaterial(material) {
  _materials.delete(material);
}

/**
 * Hand the library the opaque scene depth so particles can fade against
 * terrain instead of cutting into it.
 *
 * @param {?THREE.Texture} texture  non-linear perspective depth of the opaque pass
 * @param {number} width            drawing-buffer width the texture was rendered at
 * @param {number} height
 */
export function setSceneDepth(texture, width, height) {
  const had = !!frameUniforms.uSceneDepth.value;
  frameUniforms.uSceneDepth.value = texture ?? null;
  if (width && height) frameUniforms.uResolution.value.set(width, height);
  if (had === !!texture) return;
  for (const m of _materials) {
    if (texture) m.defines.FX_SOFT_DEPTH = '';
    else delete m.defines.FX_SOFT_DEPTH;
    m.needsUpdate = true;
  }
}

export function setFxResolution(width, height) {
  frameUniforms.uResolution.value.set(width, height);
}

const _ambient = new THREE.Color();

/**
 * Advance the shared clock and re-read the environment.
 *
 * Read-only against Environment.uniforms: the atmosphere stream owns those, and
 * several of them (the LUT handles) do not exist on every branch, hence the
 * optional reads.
 */
export function updateFrameUniforms(dt, environment, camera) {
  const u = frameUniforms;
  u.uTime.value += dt;

  const env = environment?.uniforms;
  if (env) {
    u.uSunDir.value.copy(env.uSunDir.value);
    u.uSunColor.value.copy(env.uSunColor.value);
    u.uSunIntensity.value = env.uSunIntensity.value;
    const w = env.uWind.value;
    u.uWind.value.set(w.x, 0, w.y);

    // Sky fill for anything facing away from the sun. Weighted toward the
    // horizon because a particle a few hundred metres up sees far more of the
    // band around it than of the zenith, and because over snow the ground
    // bounce arrives from the same direction.
    const zenith = env.uZenithColor?.value;
    const horizon = env.uHorizonColor?.value;
    if (zenith && horizon) {
      _ambient.copy(zenith).lerp(horizon, 0.68);
      u.uFxAmbient.value.copy(_ambient).multiplyScalar(0.55);
    }
  }

  if (camera) {
    u.uCameraNear.value = camera.near;
    u.uCameraFar.value = camera.far;
  }
}
