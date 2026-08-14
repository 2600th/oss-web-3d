import { AerialPerspectiveEffect } from '@takram/three-atmosphere';

function applyCloudAtmosphereBindings(clouds, aerialPerspective) {
  aerialPerspective.overlay = clouds.atmosphereOverlay;
  aerialPerspective.shadow = clouds.atmosphereShadow;
  aerialPerspective.shadowLength = clouds.atmosphereShadowLength;
  aerialPerspective.worldToECEFMatrix.copy(clouds.worldToECEFMatrix);
  aerialPerspective.sunDirection.copy(clouds.sunDirection);
  aerialPerspective.irradianceTexture = clouds.irradianceTexture;
  aerialPerspective.scatteringTexture = clouds.scatteringTexture;
  aerialPerspective.transmittanceTexture = clouds.transmittanceTexture;
  aerialPerspective.singleMieScatteringTexture = clouds.singleMieScatteringTexture;
  aerialPerspective.higherOrderScatteringTexture = clouds.higherOrderScatteringTexture;
  aerialPerspective.stbnTexture = clouds.stbnTexture;
}

/**
 * Owns the isolated comparison-only join between the upstream cloud buffers and
 * the Takram aerial-perspective post effect. The existing world and terrain
 * shaders are already lit, so no normal pass or aerial lighting mask is used.
 */
export function createTakramAtmosphereComposition({ camera, clouds, textures = {} }) {
  const priorSkipRendering = clouds.skipRendering;
  const aerialPerspective = new AerialPerspectiveEffect(camera, {
    ellipsoid: clouds.ellipsoid,
    sunDirection: clouds.sunDirection,
    irradianceTexture: textures.irradianceTexture ?? clouds.irradianceTexture,
    scatteringTexture: textures.scatteringTexture ?? clouds.scatteringTexture,
    transmittanceTexture: textures.transmittanceTexture ?? clouds.transmittanceTexture,
    singleMieScatteringTexture: textures.singleMieScatteringTexture
      ?? clouds.singleMieScatteringTexture,
    higherOrderScatteringTexture: textures.higherOrderScatteringTexture
      ?? clouds.higherOrderScatteringTexture,
    sunLight: false,
    skyLight: false,
    transmittance: true,
    inscatter: true,
    sky: false,
  });
  aerialPerspective.worldToECEFMatrix.copy(clouds.worldToECEFMatrix);
  aerialPerspective.stbnTexture = textures.stbnTexture ?? clouds.stbnTexture;
  clouds.skipRendering = true;

  const updateBindings = () => applyCloudAtmosphereBindings(clouds, aerialPerspective);
  const onCloudChange = () => updateBindings();
  clouds.events.addEventListener('change', onCloudChange);
  updateBindings();

  let disposed = false;
  return {
    effects: [clouds, aerialPerspective],
    passes: [],
    aerialPerspective,
    updateBindings,
    getResourceReport() {
      return {
        owner: 'takram-atmosphere-composition',
        resources: [],
        totalBytes: 0,
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clouds.events.removeEventListener('change', onCloudChange);
      clouds.skipRendering = priorSkipRendering;
      aerialPerspective.dispose();
    },
  };
}
