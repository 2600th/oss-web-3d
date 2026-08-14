import {
  CloudShape,
  CloudShapeDetail,
  CloudsEffect,
  LocalWeather,
  Turbulence,
} from '@takram/three-clouds';
import { AtmosphereParameters } from '@takram/three-atmosphere';
import {
  BasicDepthPacking,
  ByteType,
  Data3DTexture,
  DataTexture,
  FloatType,
  HalfFloatType,
  NearestFilter,
  RedFormat,
  RepeatWrapping,
  RGFormat,
  RGBAFormat,
  UnsignedByteType,
  UnsignedIntType,
  UnsignedShortType,
  Vector2,
  Vector3,
} from 'three';
import {
  getTakramCloudProfile,
  validateTakramProfileScenario,
} from './TakramCloudProfiles.js';

export const TAKRAM_CLOUD_PROFILES = Object.freeze({
  high: Object.freeze({ name: 'high', takram: 'high', enabled: true }),
  medium: Object.freeze({ name: 'medium', takram: 'medium', enabled: true }),
  low: Object.freeze({ name: 'low', takram: 'low', enabled: true }),
  phone: Object.freeze({ name: 'phone', takram: 'low', enabled: false }),
});

export const TAKRAM_FALLBACK_LIGHTING = Object.freeze({
  accurateSunSkyLight: false,
  skyLightScale: 0.65,
  groundBounceScale: 0.15,
});

function createFallbackAtmosphereTextures() {
  const texture2D = values => {
    const texture = new DataTexture(
      new Uint8Array(values), 1, 1, RGBAFormat, UnsignedByteType,
    );
    texture.needsUpdate = true;
    return texture;
  };
  const texture3D = values => {
    const texture = new Data3DTexture(
      new Uint8Array(values), 1, 1, 1,
    );
    texture.format = RGBAFormat;
    texture.type = UnsignedByteType;
    texture.needsUpdate = true;
    return texture;
  };
  return Object.freeze({
    irradianceTexture: texture2D([72, 88, 112, 255]),
    scatteringTexture: texture3D([48, 64, 96, 255]),
    transmittanceTexture: texture2D([224, 232, 240, 255]),
    singleMieScatteringTexture: texture3D([24, 28, 32, 255]),
    higherOrderScatteringTexture: texture3D([16, 20, 28, 255]),
  });
}

function createFallbackStbnTexture() {
  const texture = new Data3DTexture(new Uint8Array([128]), 1, 1, 1);
  texture.format = RedFormat;
  texture.type = UnsignedByteType;
  texture.minFilter = NearestFilter;
  texture.magFilter = NearestFilter;
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.wrapR = RepeatWrapping;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

function compatibleAtmosphereTextures(environment) {
  const textures = environment?.atmosphereTextures
    ?? environment?.precomputedTextures
    ?? environment;
  if (
    textures?.irradianceTexture?.isTexture !== true
    || textures?.scatteringTexture?.isData3DTexture !== true
    || textures?.transmittanceTexture?.isTexture !== true
  ) {
    return null;
  }
  return textures;
}

function profileFor(value) {
  const name = typeof value === 'string' ? value : value?.name;
  const profile = TAKRAM_CLOUD_PROFILES[name];
  if (profile == null) {
    throw new RangeError(`Unknown Takram cloud quality profile: ${String(name)}`);
  }
  return profile;
}

function channelsFor(format) {
  if (format === RedFormat) return 1;
  if (format === RGFormat) return 2;
  if (format === RGBAFormat) return 4;
  return 4;
}

function bytesForType(type) {
  if (type === ByteType || type === UnsignedByteType) return 1;
  if (type === HalfFloatType || type === UnsignedShortType) return 2;
  if (type === FloatType || type === UnsignedIntType) return 4;
  return 4;
}

function textureLayers(texture, fallback = 1) {
  return texture?.image?.depth ?? texture?.source?.data?.depth ?? fallback;
}

function describeRenderTarget(name, target) {
  if (target == null) return null;
  const textures = target.textures ?? [target.texture];
  const attachments = textures.filter(Boolean).map(texture => {
    const channels = channelsFor(texture.format);
    const bytesPerChannel = bytesForType(texture.type);
    const layers = textureLayers(texture, target.depth ?? 1);
    return {
      channels,
      bytesPerChannel,
      layers,
      bytes: target.width * target.height * channels * bytesPerChannel * layers,
    };
  });
  const bytes = attachments.reduce((total, attachment) => total + attachment.bytes, 0);
  return {
    name,
    kind: 'render-target',
    width: target.width,
    height: target.height,
    layers: Math.max(1, ...attachments.map(attachment => attachment.layers)),
    samples: Math.max(1, target.samples || 1),
    attachments: attachments.length,
    bytes,
  };
}

function mipFootprint(width, height, layers, generateMipmaps) {
  let mipLevels = 1;
  let texels = width * height * layers;
  if (generateMipmaps) {
    let mipWidth = width;
    let mipHeight = height;
    while (mipWidth > 1 || mipHeight > 1) {
      mipWidth = Math.max(1, Math.floor(mipWidth / 2));
      mipHeight = Math.max(1, Math.floor(mipHeight / 2));
      texels += mipWidth * mipHeight * layers;
      mipLevels += 1;
    }
  }
  return { mipLevels, texels };
}

function describeProcedural(name, resource) {
  const texture = resource.texture;
  const layers = textureLayers(texture, texture.isData3DTexture ? resource.size : 1);
  const channels = channelsFor(texture.format);
  const bytesPerChannel = bytesForType(texture.type);
  const { mipLevels, texels } = mipFootprint(
    resource.size,
    resource.size,
    layers,
    texture.generateMipmaps && !texture.isData3DTexture,
  );
  return {
    name,
    kind: 'procedural-texture',
    width: resource.size,
    height: resource.size,
    layers,
    mipLevels,
    samples: 1,
    attachments: 1,
    bytes: texels * channels * bytesPerChannel,
  };
}

function describeStandaloneTexture(name, texture, kind = 'fallback-atmosphere-texture') {
  const width = texture.image?.width ?? 1;
  const height = texture.image?.height ?? 1;
  const layers = textureLayers(texture);
  const channels = channelsFor(texture.format);
  const bytesPerChannel = bytesForType(texture.type);
  const { mipLevels, texels } = mipFootprint(
    width,
    height,
    layers,
    texture.generateMipmaps,
  );
  return {
    name,
    kind,
    width,
    height,
    layers,
    mipLevels,
    samples: 1,
    attachments: 1,
    bytes: texels * channels * bytesPerChannel,
  };
}

function uniqueTargets(effect) {
  const cloud = effect.cloudsPass;
  const shadow = effect.shadowPass;
  return [
    ['cloud-current', cloud.currentRenderTarget],
    ['cloud-resolve', cloud.resolveRenderTarget],
    ['cloud-history', cloud.historyRenderTarget],
    ['beer-shadow-current', shadow.currentRenderTarget],
    ['beer-shadow-resolve', shadow.resolveRenderTarget],
    ['beer-shadow-history', shadow.historyRenderTarget],
  ];
}

function captureRenderTargetState(renderer) {
  return {
    target: typeof renderer?.getRenderTarget === 'function'
      ? renderer.getRenderTarget()
      : null,
    cubeFace: typeof renderer?.getActiveCubeFace === 'function'
      ? renderer.getActiveCubeFace()
      : 0,
    mipmapLevel: typeof renderer?.getActiveMipmapLevel === 'function'
      ? renderer.getActiveMipmapLevel()
      : 0,
  };
}

function restoreRenderTargetState(renderer, state) {
  renderer.setRenderTarget(state.target, state.cubeFace, state.mipmapLevel);
}

export class TakramCloudRendererAdapter {
  constructor({
    renderer,
    quality,
    camera,
    scene,
    sunDirection,
    stableDepthTexture,
    profileName = 'takram-reference',
    profileContext = null,
  }) {
    this.renderer = renderer;
    this.camera = camera;
    this.scene = scene;
    this.environment = null;
    this.sunDirection = new Vector3().copy(sunDirection);
    this.depthTexture = stableDepthTexture;
    this.profile = profileFor(quality);
    this.profileContext = profileContext;
    this.cloudProfile = getTakramCloudProfile(profileName, profileContext);
    this.effect = null;
    this.generatedResources = [];
    this.cloudAssets = null;
    this.cloudAssetMode = 'procedural-unverified';
    this.fallbackAtmosphereTextures = null;
    this.stbnTexture = null;
    this.fallbackStbnTexture = null;
    this.historyGeneration = 0;
    this._disposed = false;
    this._width = 1;
    this._height = 1;
    this._pixelRatio = 1;

    if (typeof renderer?.getDrawingBufferSize === 'function') {
      const size = renderer.getDrawingBufferSize(new Vector2());
      this._width = Math.max(1, size.x);
      this._height = Math.max(1, size.y);
    }
    if (this.profile.enabled) this._constructEffect();
  }

  get activeLayerCount() {
    if (this.effect == null) return 0;
    let count = 0;
    const { cloudLayers } = this.effect;
    for (let index = 0; index < cloudLayers.length; index += 1) {
      const layer = cloudLayers[index];
      if (layer.height > 0 && layer.densityScale > 0) count += 1;
    }
    return count;
  }

  _constructEffect() {
    const effect = new CloudsEffect(
      this.camera,
      { width: this._width, height: this._height },
      AtmosphereParameters.DEFAULT,
    );
    effect.ellipsoid.getNorthUpEastFrame(
      new Vector3(effect.ellipsoid.radii.x, 0, 0),
      effect.worldToECEFMatrix,
    );
    effect.skipRendering = false;
    effect.qualityPreset = this.profile.takram;
    effect.coverage = this.cloudProfile.coverage;
    effect.localWeatherRepeat.fromArray(this.cloudProfile.localWeatherRepeat);
    effect.localWeatherOffset.set(0.18, 0.42);
    effect.localWeatherVelocity.fromArray(this.cloudProfile.localWeatherVelocity);
    effect.cloudLayers.set(this.cloudProfile.layers);
    effect.sunDirection.copy(this.sunDirection).transformDirection(effect.worldToECEFMatrix);

    const generatedResources = this.cloudAssets == null ? [
      new LocalWeather(),
      new CloudShape(),
      new CloudShapeDetail(),
      new Turbulence(),
    ] : [];
    if (this.cloudAssets == null) {
      [
        effect.localWeatherTexture,
        effect.shapeTexture,
        effect.shapeDetailTexture,
        effect.turbulenceTexture,
      ] = generatedResources;
    } else {
      this._applyCloudTextures(effect, this.cloudAssets);
    }

    if (this.stbnTexture == null) {
      this.stbnTexture = createFallbackStbnTexture();
      this.fallbackStbnTexture = this.stbnTexture;
    }
    effect.stbnTexture = this.stbnTexture;

    this.fallbackAtmosphereTextures = createFallbackAtmosphereTextures();
    this._setEnvironment(this.environment, effect);

    effect.setDepthTexture(this.depthTexture, BasicDepthPacking);
    effect.setSize(this._width, this._height);
    effect.shadowPass.setSize(
      effect.shadow.mapSize.x,
      effect.shadow.mapSize.y,
      effect.shadow.cascadeCount,
    );

    this.effect = effect;
    this.generatedResources = generatedResources;
  }

  getProfileReport() {
    if (this.profileContext == null) {
      return {
        name: this.cloudProfile.name,
        altitudeTranslation: { ...this.cloudProfile.altitudeTranslation },
        nearestLayerBoundaryDistance: null,
        eligible: null,
        reasons: ['scenario-context-unavailable'],
      };
    }
    const validation = validateTakramProfileScenario(
      this.cloudProfile,
      this.profileContext,
    );
    return {
      name: this.cloudProfile.name,
      altitudeTranslation: { ...this.cloudProfile.altitudeTranslation },
      nearestLayerBoundaryDistance: validation.nearestBoundaryDistance,
      eligible: validation.eligible,
      reasons: [...validation.reasons],
    };
  }

  _setEnvironment(environment, effect = this.effect) {
    this.environment = environment;
    if (effect == null) return;
    const fallback = this.fallbackAtmosphereTextures;
    const compatible = compatibleAtmosphereTextures(environment);
    const textures = compatible ?? fallback;
    effect.irradianceTexture = textures.irradianceTexture;
    effect.scatteringTexture = textures.scatteringTexture;
    effect.transmittanceTexture = textures.transmittanceTexture;
    effect.singleMieScatteringTexture = textures.singleMieScatteringTexture
      ?? fallback.singleMieScatteringTexture;
    effect.higherOrderScatteringTexture = textures.higherOrderScatteringTexture
      ?? fallback.higherOrderScatteringTexture;
    if (compatible == null) {
      effect.clouds.accurateSunSkyLight = TAKRAM_FALLBACK_LIGHTING.accurateSunSkyLight;
      effect.skyLightScale = TAKRAM_FALLBACK_LIGHTING.skyLightScale;
      effect.groundBounceScale = TAKRAM_FALLBACK_LIGHTING.groundBounceScale;
    } else {
      effect.clouds.accurateSunSkyLight = this.profile.takram === 'high';
      effect.skyLightScale = 1;
      effect.groundBounceScale = 1;
    }
  }

  setSize(width, height, pixelRatio = 1) {
    this._width = Math.max(1, Math.round(width));
    this._height = Math.max(1, Math.round(height));
    this._pixelRatio = pixelRatio;
    this.effect?.setSize(this._width, this._height);
    this.resetHistory('resize');
  }

  setQuality(tier) {
    const next = profileFor(tier);
    if (next === this.profile) return;
    this.profile = next;

    if (!next.enabled) {
      this.resetHistory('quality-change');
      this._disposeEffect();
      return;
    }
    if (this.effect == null) {
      this._constructEffect();
    } else {
      this.effect.qualityPreset = next.takram;
      this.effect.setSize(this._width, this._height);
      this.effect.shadowPass.setSize(
        this.effect.shadow.mapSize.x,
        this.effect.shadow.mapSize.y,
        this.effect.shadow.cascadeCount,
      );
      this._setEnvironment(this.environment);
    }
    this.resetHistory('quality-change');
  }

  setDepthTexture(texture) {
    this.depthTexture = texture;
    this.effect?.setDepthTexture(texture, BasicDepthPacking);
  }

  setStbnTexture(texture) {
    if (texture?.isData3DTexture !== true) {
      throw new TypeError('Takram STBN texture must be a Data3DTexture');
    }
    const fallback = this.fallbackStbnTexture;
    this.stbnTexture = texture;
    if (this.effect != null) this.effect.stbnTexture = texture;
    if (fallback != null && fallback !== texture) {
      this.fallbackStbnTexture = null;
      fallback.dispose();
    }
    this.resetHistory('sampling-texture-change');
  }

  _applyCloudTextures(effect, assets) {
    effect.localWeatherTexture = assets.localWeatherTexture;
    effect.shapeTexture = assets.shapeTexture;
    effect.shapeDetailTexture = assets.shapeDetailTexture;
    effect.turbulenceTexture = assets.turbulenceTexture;
  }

  setCloudTextures(assets) {
    if (
      assets?.mode !== 'official-pinned'
      || assets.localWeatherTexture?.isTexture !== true
      || assets.shapeTexture?.isData3DTexture !== true
      || assets.shapeDetailTexture?.isData3DTexture !== true
      || assets.turbulenceTexture?.isTexture !== true
    ) {
      throw new TypeError('Takram cloud textures must be the complete official-pinned asset set');
    }
    const generatedResources = this.generatedResources;
    this.cloudAssets = assets;
    this.cloudAssetMode = assets.mode;
    if (this.effect != null) this._applyCloudTextures(this.effect, assets);
    this.generatedResources = [];
    for (const resource of new Set(generatedResources)) resource.dispose();
    this.resetHistory('cloud-texture-change');
  }

  update(frame) {
    this.camera = frame.camera;
    this.scene = frame.scene;
    this.environment = frame.environment;
    this.sunDirection.copy(frame.sunDirection);
    if (frame.sceneDepth != null && frame.sceneDepth !== this.depthTexture) {
      this.setDepthTexture(frame.sceneDepth);
    }
    if (frame.cameraCut) this.resetHistory('camera-cut');
    if (this.effect == null) return;

    this.effect.mainCamera = frame.camera;
    this.effect.sunDirection
      .copy(frame.sunDirection)
      .transformDirection(this.effect.worldToECEFMatrix);
    this._setEnvironment(frame.environment);
    const renderer = frame.renderer ?? this.renderer;
    const renderTargetState = captureRenderTargetState(renderer);
    try {
      this.effect.update(renderer, frame.inputBuffer, frame.dt);
    } finally {
      restoreRenderTargetState(renderer, renderTargetState);
    }
  }

  resetHistory(_reason) {
    this.historyGeneration += 1;
    const effect = this.effect;
    const renderer = this.renderer;
    if (effect == null || typeof renderer?.setRenderTarget !== 'function' || typeof renderer?.clear !== 'function') {
      return;
    }

    const renderTargetState = captureRenderTargetState(renderer);
    const historyTargets = [
      effect.cloudsPass.resolveRenderTarget,
      effect.cloudsPass.historyRenderTarget,
      effect.shadowPass.resolveRenderTarget,
      effect.shadowPass.historyRenderTarget,
    ].filter(Boolean);
    try {
      for (const target of historyTargets) {
        const layers = Math.max(1, target.depth ?? textureLayers(target.texture));
        for (let layer = 0; layer < layers; layer += 1) {
          renderer.setRenderTarget(target, layers > 1 ? layer : 0, 0);
          renderer.clear(true, false, false);
        }
      }
    } finally {
      restoreRenderTargetState(renderer, renderTargetState);
    }
    effect.frame = 0;
  }

  getShadowOutput() {
    if (this.effect == null) {
      return { kind: 'disabled', texture: null, version: this.historyGeneration };
    }
    const shadow = this.effect.atmosphereShadow;
    return {
      kind: 'beer-cascades',
      texture: shadow?.map ?? this.effect.shadowPass.outputBuffer,
      mapSize: shadow?.mapSize ?? this.effect.shadowMaps.mapSize,
      cascadeCount: shadow?.cascadeCount ?? this.effect.shadowMaps.cascadeCount,
      intervals: shadow?.intervals ?? null,
      matrices: shadow?.matrices ?? null,
      inverseMatrices: shadow?.inverseMatrices ?? null,
      far: shadow?.far ?? this.effect.shadowMaps.far,
      topHeight: shadow?.topHeight ?? null,
      version: this.historyGeneration,
    };
  }

  getResourceReport() {
    if (this.effect == null) {
      return {
        backend: 'takram',
        enabled: false,
        profile: this.profile.name,
        renderTargetCount: 0,
        proceduralTextureCount: 0,
        fallbackTextureCount: 0,
        samplingTextureCount: 0,
        textureCount: 0,
        resources: [],
        totalBytes: 0,
      };
    }
    const targetResources = uniqueTargets(this.effect)
      .map(([name, target]) => describeRenderTarget(name, target))
      .filter(Boolean);
    const generatedResources = this.generatedResources.map((resource, index) => (
      describeProcedural(['local-weather', 'cloud-shape', 'cloud-shape-detail', 'turbulence'][index], resource)
    ));
    const fallbackResources = Object.entries(this.fallbackAtmosphereTextures).map(
      ([name, texture]) => describeStandaloneTexture(`fallback-${name}`, texture),
    );
    const samplingResources = this.stbnTexture == null ? [] : [describeStandaloneTexture(
      this.stbnTexture === this.fallbackStbnTexture ? 'stbn-fallback' : 'stbn-external',
      this.stbnTexture,
      'sampling-texture',
    )];
    const resources = [
      ...targetResources,
      ...generatedResources,
      ...fallbackResources,
      ...samplingResources,
    ];
    return {
      backend: 'takram',
      enabled: true,
      profile: this.profile.name,
      cloudAssetMode: this.cloudAssetMode,
      renderTargetCount: targetResources.length,
      proceduralTextureCount: generatedResources.length,
      fallbackTextureCount: fallbackResources.length,
      samplingTextureCount: samplingResources.length,
      textureCount: resources.reduce((total, resource) => total + resource.attachments, 0),
      resources,
      totalBytes: resources.reduce((total, resource) => total + resource.bytes, 0),
    };
  }

  _disposeEffect() {
    if (this.effect == null) return;
    const effect = this.effect;
    effect.resolution.removeEventListener('change', effect.onResolutionChange);
    const ownedDisposables = [
      ...uniqueTargets(effect).map(([, target]) => target),
      effect.cloudsPass.currentMaterial,
      effect.cloudsPass.resolveMaterial,
      effect.shadowPass.currentMaterial,
      effect.shadowPass.resolveMaterial,
      ...this.generatedResources.flatMap(resource => [
        resource.renderTarget,
        resource.material,
        resource.mesh?.geometry,
      ]),
      ...Object.values(this.fallbackAtmosphereTextures ?? {}),
      this.fallbackStbnTexture,
    ].filter(Boolean);
    const disposed = new Set();
    for (const resource of ownedDisposables) {
      if (disposed.has(resource)) continue;
      disposed.add(resource);
      resource.dispose();
    }
    this.generatedResources = [];
    this.fallbackAtmosphereTextures = null;
    if (this.stbnTexture === this.fallbackStbnTexture) this.stbnTexture = null;
    this.fallbackStbnTexture = null;
    this.effect = null;
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this._disposeEffect();
    this.stbnTexture = null;
    this.cloudAssets = null;
  }
}
