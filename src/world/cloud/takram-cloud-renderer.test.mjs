import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  BasicDepthPacking,
  Data3DTexture,
  DataTexture,
  PerspectiveCamera,
  RedFormat,
  Scene,
  Texture,
  Vector2,
  Vector3,
} from 'three';
import { CloudsEffect } from '@takram/three-clouds';
import { AtmosphereParameters } from '@takram/three-atmosphere';
import { Geodetic } from '@takram/three-geospatial';
import { assertCloudRendererBackend } from './CloudRendererContract.js';
import { TakramCloudRendererAdapter } from './TakramCloudRendererAdapter.js';

function createRenderer(width = 1920, height = 1080, initialState = {}) {
  return {
    clears: [],
    currentTarget: initialState.target ?? null,
    activeCubeFace: initialState.cubeFace ?? 0,
    activeMipmapLevel: initialState.mipmapLevel ?? 0,
    getDrawingBufferSize(result) {
      return result.set(width, height);
    },
    getRenderTarget() {
      return this.currentTarget;
    },
    getActiveCubeFace() {
      return this.activeCubeFace;
    },
    getActiveMipmapLevel() {
      return this.activeMipmapLevel;
    },
    setRenderTarget(target, layer = 0, mipmapLevel = 0) {
      this.currentTarget = target;
      this.activeCubeFace = layer;
      this.activeMipmapLevel = mipmapLevel;
      this.clears.push({ target, layer, cleared: false });
    },
    clear() {
      const entry = this.clears.at(-1);
      if (entry != null) entry.cleared = true;
    },
  };
}

function createOptions(quality = { name: 'high' }, overrides = {}) {
  return {
    renderer: createRenderer(),
    quality,
    camera: new PerspectiveCamera(60, 16 / 9, 1, 200_000),
    scene: new Scene(),
    sunDirection: new Vector3(0.2, 0.9, -0.3).normalize(),
    stableDepthTexture: new Texture(),
    ...overrides,
  };
}

function createOfficialCloudAssets() {
  const localWeatherTexture = new Texture({ width: 512, height: 512 });
  const shapeTexture = new Data3DTexture(new Uint8Array(128 * 128 * 128), 128, 128, 128);
  const shapeDetailTexture = new Data3DTexture(new Uint8Array(32 * 32 * 32), 32, 32, 32);
  const turbulenceTexture = new Texture({ width: 128, height: 128 });
  return {
    mode: 'official-pinned',
    localWeatherTexture,
    shapeTexture,
    shapeDetailTexture,
    turbulenceTexture,
    textures: [localWeatherTexture, shapeTexture, shapeDetailTexture, turbulenceTexture],
  };
}

test('applies the selected faithful cloud profile without mutating quality', () => {
  const reference = new TakramCloudRendererAdapter(createOptions());
  const himalayan = new TakramCloudRendererAdapter(createOptions(
    { name: 'high' },
    {
      profileName: 'takram-himalayan',
      profileContext: { terrainMin: 4700, terrainMax: 6300, cameraAltitude: 7235.246 },
    },
  ));

  assert.equal(reference.profile.name, 'high');
  assert.equal(reference.cloudProfile.name, 'takram-reference');
  assert.equal(reference.effect.coverage, 0.4);
  assert.deepEqual(reference.effect.localWeatherRepeat.toArray(), [100, 100]);
  assert.deepEqual(reference.effect.localWeatherVelocity.toArray(), [0.001, 0]);
  assert.deepEqual(
    [...reference.effect.cloudLayers].map(layer => [
      layer.channel,
      layer.altitude,
      layer.height,
      layer.densityScale,
    ]),
    [
      ['r', 750, 650, 0.2],
      ['g', 1000, 1200, 0.2],
      ['b', 7500, 500, 0.003],
      ['a', 0, 0, 0],
    ],
  );
  assert.equal(reference.activeLayerCount, 3);

  assert.equal(himalayan.cloudProfile.name, 'takram-himalayan');
  assert.deepEqual(
    [...himalayan.effect.cloudLayers].slice(0, 3).map(layer => layer.altitude),
    [7735.246, 7985.246, 9485.246],
  );
  assert.deepEqual(himalayan.getProfileReport(), {
    name: 'takram-himalayan',
    altitudeTranslation: { cumulus: 6985.246, cirrus: 1985.246 },
    nearestLayerBoundaryDistance: 500,
    eligible: true,
    reasons: [],
  });

  reference.dispose();
  himalayan.dispose();
});

test('constructs and preallocates the real vanilla Takram backend', () => {
  const options = createOptions();
  const backend = new TakramCloudRendererAdapter(options);

  assert.strictEqual(assertCloudRendererBackend(backend), backend);
  assert.ok(backend.effect instanceof CloudsEffect);
  assert.equal(backend.effect.skipRendering, false);
  assert.equal(backend.effect.defines.has('SKIP_RENDERING'), false);
  assert.strictEqual(backend.camera, options.camera);
  assert.strictEqual(backend.scene, options.scene);
  assert.strictEqual(backend.depthTexture, options.stableDepthTexture);
  assert.equal(backend.profile.name, 'high');
  assert.equal(backend.profile.enabled, true);
  assert.equal(backend.activeLayerCount, 3);
  assert.deepEqual(
    new Vector2(
      backend.effect.cloudsPass.historyRenderTarget.width,
      backend.effect.cloudsPass.historyRenderTarget.height,
    ),
    new Vector2(1920, 1080),
  );
  assert.strictEqual(
    backend.effect.cloudsPass.currentMaterial.depthBuffer,
    options.stableDepthTexture,
  );
  assert.equal(
    backend.effect.cloudsPass.currentMaterial.depthPacking,
    BasicDepthPacking,
    'Takram only declares readDepthValue when DEPTH_PACKING is defined',
  );
  assert.equal(
    backend.effect.cloudsPass.currentMaterial.defines.DEPTH_PACKING,
    String(BasicDepthPacking),
  );
  assert.equal(backend.effect.clouds.accurateSunSkyLight, false);
  assert.equal(backend.effect.skyLightScale > 0 && backend.effect.skyLightScale <= 1, true);
  assert.equal(backend.effect.groundBounceScale >= 0 && backend.effect.groundBounceScale <= 1, true);
  assert.strictEqual(backend.effect.irradianceTexture, backend.fallbackAtmosphereTextures.irradianceTexture);
  assert.strictEqual(backend.effect.scatteringTexture, backend.fallbackAtmosphereTextures.scatteringTexture);
  assert.strictEqual(backend.effect.transmittanceTexture, backend.fallbackAtmosphereTextures.transmittanceTexture);

  const report = backend.getResourceReport();
  assert.equal(report.backend, 'takram');
  assert.equal(report.enabled, true);
  assert.equal(report.renderTargetCount, 6);
  assert.equal(report.proceduralTextureCount, 4);
  assert.equal(report.totalBytes > 64 * 1024 * 1024, true);
  const weather = report.resources.find(resource => resource.name === 'local-weather');
  const turbulence = report.resources.find(resource => resource.name === 'turbulence');
  assert.equal(weather.mipLevels, 10);
  assert.equal(weather.bytes, 1_398_100);
  assert.equal(turbulence.mipLevels, 8);
  assert.equal(turbulence.bytes, 87_380);

  backend.dispose();
});

test('keeps Takram depth sampling compiled when the stable depth texture changes', () => {
  const backend = new TakramCloudRendererAdapter(createOptions());
  const nextDepthTexture = new Texture();

  backend.setDepthTexture(nextDepthTexture);

  assert.strictEqual(backend.effect.cloudsPass.currentMaterial.depthBuffer, nextDepthTexture);
  assert.equal(backend.effect.cloudsPass.currentMaterial.depthPacking, BasicDepthPacking);
  assert.equal(
    backend.effect.cloudsPass.currentMaterial.defines.DEPTH_PACKING,
    String(BasicDepthPacking),
  );

  backend.dispose();
});

test('maps the local Y-up world onto an unscaled ECEF tangent frame', () => {
  const backend = new TakramCloudRendererAdapter(createOptions());
  const { effect } = backend;
  const matrix = effect.worldToECEFMatrix;
  const originECEF = new Vector3().applyMatrix4(matrix);
  const cloudAltitudeECEF = new Vector3(0, 7_500, 0).applyMatrix4(matrix);
  const originHeight = new Geodetic().setFromECEF(
    originECEF,
    { ellipsoid: effect.ellipsoid },
  ).height;
  const cloudAltitude = new Geodetic().setFromECEF(
    cloudAltitudeECEF,
    { ellipsoid: effect.ellipsoid },
  ).height;
  const geodeticUp = effect.ellipsoid.getSurfaceNormal(originECEF);
  const elements = matrix.elements;
  const basis = [
    new Vector3(elements[0], elements[1], elements[2]),
    new Vector3(elements[4], elements[5], elements[6]),
    new Vector3(elements[8], elements[9], elements[10]),
  ];

  assert.ok(Math.abs(originHeight) < 1e-6);
  assert.ok(Math.abs(cloudAltitude - 7_500) < 1e-6);
  assert.ok(Math.abs(basis[0].dot(geodeticUp)) < 1e-12);
  assert.ok(Math.abs(basis[1].dot(geodeticUp) - 1) < 1e-12);
  assert.ok(Math.abs(basis[2].dot(geodeticUp)) < 1e-12);
  assert.equal(basis.every(axis => Math.abs(axis.length() - 1) < 1e-12), true);
  assert.ok(Math.abs(basis[0].clone().cross(basis[1]).dot(basis[2]) - 1) < 1e-12);
  assert.ok(effect.sunDirection.distanceTo(
    backend.sunDirection.clone().transformDirection(matrix),
  ) < 1e-12);

  const coordinateMaterials = [
    effect.cloudsPass.currentMaterial,
    effect.cloudsPass.resolveMaterial,
    effect.shadowPass.currentMaterial,
    effect.shadowPass.resolveMaterial,
  ].filter(material => material.uniforms.worldToECEFMatrix != null);
  assert.equal(coordinateMaterials.length, 2);
  assert.equal(
    coordinateMaterials.every(
      material => material.uniforms.worldToECEFMatrix.value === matrix,
    ),
    true,
  );

  backend.camera.position.set(20_500, 7_500, 5_200);
  backend.camera.updateMatrixWorld(true);
  effect.updateSharedUniforms(0);
  const altitudeCorrection = effect.cloudsPass.currentMaterial.uniforms.altitudeCorrection.value;
  assert.equal(altitudeCorrection.toArray().every(Number.isFinite), true);
  assert.ok(altitudeCorrection.length() < 25_000);

  backend.dispose();
});

test('reference weather uses the pinned Takram vanilla repeat and coverage', () => {
  const backend = new TakramCloudRendererAdapter(createOptions());
  const repeat = backend.effect.localWeatherRepeat;
  assert.deepEqual(repeat.toArray(), [100, 100]);
  assert.equal(backend.effect.coverage, 0.4);
  assert.deepEqual(backend.effect.localWeatherVelocity.toArray(), [0.001, 0]);

  backend.dispose();
});

test('reference profile authors the two cumulus and one cirrus default layers', () => {
  const backend = new TakramCloudRendererAdapter(createOptions());
  const layers = [];
  for (const layer of backend.effect.cloudLayers) {
    if (layer.height > 0) layers.push(layer);
  }

  assert.equal(layers.length, 3);
  assert.deepEqual(
    layers.map(layer => [layer.altitude, layer.height, layer.densityScale]),
    [[750, 650, 0.2], [1000, 1200, 0.2], [7500, 500, 0.003]],
  );
  assert.deepEqual(layers.map(layer => layer.shapeAmount), [1, 1, 0.4]);
  assert.deepEqual(layers.map(layer => layer.shapeDetailAmount), [1, 1, 0]);

  backend.dispose();
});

test('supplies a valid sampling volume to both Takram ray marches', () => {
  const backend = new TakramCloudRendererAdapter(createOptions());
  const texture = backend.effect.stbnTexture;

  assert.equal(texture?.isData3DTexture, true);
  assert.ok(texture.image.width > 0);
  assert.ok(texture.image.height > 0);
  assert.ok(texture.image.depth > 0);
  assert.strictEqual(
    backend.effect.cloudsPass.currentMaterial.uniforms.stbnTexture.value,
    texture,
  );
  assert.strictEqual(
    backend.effect.shadowPass.currentMaterial.uniforms.stbnTexture.value,
    texture,
  );

  const report = backend.getResourceReport();
  assert.equal(report.samplingTextureCount, 1);
  assert.equal(report.resources.find(resource => resource.name === 'stbn-fallback').bytes, 1);

  backend.dispose();
});

test('replaces and disposes the fallback without taking ownership of official STBN', () => {
  const backend = new TakramCloudRendererAdapter(createOptions());
  const fallback = backend.effect.stbnTexture;
  const official = new Data3DTexture(new Uint8Array(8), 2, 2, 2);
  official.format = RedFormat;
  let fallbackDisposals = 0;
  let officialDisposals = 0;
  fallback.addEventListener('dispose', () => { fallbackDisposals += 1; });
  official.addEventListener('dispose', () => { officialDisposals += 1; });

  backend.setStbnTexture(official);

  assert.equal(fallbackDisposals, 1);
  assert.strictEqual(backend.effect.stbnTexture, official);
  assert.equal(
    backend.getResourceReport().resources.find(resource => resource.name === 'stbn-external').bytes,
    8,
  );

  backend.dispose();
  assert.equal(fallbackDisposals, 1);
  assert.equal(officialDisposals, 0);
  official.dispose();
});

test('uses harness-owned official cloud textures without retaining generated cloud resources', () => {
  const backend = new TakramCloudRendererAdapter(createOptions());
  const generated = [...backend.generatedResources];
  let generatedDisposals = 0;
  for (const resource of generated) {
    const dispose = resource.dispose.bind(resource);
    resource.dispose = () => {
      generatedDisposals += 1;
      dispose();
    };
  }
  const assets = createOfficialCloudAssets();
  const officialDisposals = new Map(assets.textures.map(texture => [texture, 0]));
  for (const texture of assets.textures) {
    texture.addEventListener('dispose', () => {
      officialDisposals.set(texture, officialDisposals.get(texture) + 1);
    });
  }

  backend.setCloudTextures(assets);

  assert.equal(generatedDisposals, 4);
  assert.deepEqual(backend.generatedResources, []);
  assert.strictEqual(backend.effect.localWeatherTexture, assets.localWeatherTexture);
  assert.strictEqual(backend.effect.shapeTexture, assets.shapeTexture);
  assert.strictEqual(backend.effect.shapeDetailTexture, assets.shapeDetailTexture);
  assert.strictEqual(backend.effect.turbulenceTexture, assets.turbulenceTexture);
  const report = backend.getResourceReport();
  assert.equal(report.cloudAssetMode, 'official-pinned');
  assert.equal(report.proceduralTextureCount, 0);
  assert.equal(
    report.resources.some(resource => ['local-weather', 'cloud-shape', 'cloud-shape-detail', 'turbulence']
      .includes(resource.name)),
    false,
  );

  backend.dispose();
  assert.equal([...officialDisposals.values()].every(count => count === 0), true);
});

test('phone quality is an explicit disabled profile with no Takram targets', () => {
  const options = createOptions({ name: 'phone' });
  const backend = new TakramCloudRendererAdapter(options);

  assert.equal(backend.profile.name, 'phone');
  assert.equal(backend.profile.takram, 'low');
  assert.equal(backend.profile.enabled, false);
  assert.equal(backend.effect, null);
  assert.equal(backend.activeLayerCount, 0);
  assert.deepEqual(backend.getResourceReport(), {
    backend: 'takram',
    enabled: false,
    profile: 'phone',
    renderTargetCount: 0,
    proceduralTextureCount: 0,
    fallbackTextureCount: 0,
    samplingTextureCount: 0,
    textureCount: 0,
    resources: [],
    totalBytes: 0,
  });

  backend.dispose();
});

test('quality changes reset history and never reuse high targets for phone', () => {
  const options = createOptions();
  const backend = new TakramCloudRendererAdapter(options);
  const highEffect = backend.effect;

  backend.resetHistory('camera-cut');
  assert.equal(backend.historyGeneration, 1);
  assert.equal(options.renderer.clears.some(entry => entry.cleared), true);

  backend.setQuality({ name: 'phone' });
  assert.equal(backend.historyGeneration, 2);
  assert.equal(backend.effect, null);
  assert.notStrictEqual(backend.effect, highEffect);
  assert.equal(backend.getResourceReport().totalBytes, 0);

  backend.dispose();
});

test('quality changes immediately reapply fallback atmosphere lighting', () => {
  const backend = new TakramCloudRendererAdapter(createOptions());

  backend.setQuality({ name: 'low' });
  backend.setQuality({ name: 'high' });

  assert.equal(backend.effect.clouds.accurateSunSkyLight, false);
  assert.strictEqual(
    backend.effect.transmittanceTexture,
    backend.fallbackAtmosphereTextures.transmittanceTexture,
  );

  backend.dispose();
});

test('maps frame camera, depth and sun data without replacing the frame', () => {
  const backend = new TakramCloudRendererAdapter(createOptions({ name: 'phone' }));
  const camera = new PerspectiveCamera();
  const depth = new Texture();
  const sunDirection = new Vector3(-0.4, 0.7, 0.2).normalize();
  const frame = Object.freeze({
    dt: 1 / 60,
    renderer: createRenderer(390, 844),
    inputBuffer: Object.freeze({ name: 'caller-owned-input' }),
    camera,
    scene: new Scene(),
    sunDirection,
    environment: null,
    sceneDepth: depth,
    cameraCut: true,
  });

  backend.update(frame);

  assert.strictEqual(backend.camera, camera);
  assert.strictEqual(backend.depthTexture, depth);
  assert.deepEqual(backend.sunDirection, sunDirection);
  assert.equal(backend.historyGeneration, 1);
  assert.strictEqual(frame.inputBuffer.name, 'caller-owned-input');

  backend.dispose();
});

test('maps compatible frame atmosphere textures and restores accurate High lighting', () => {
  const backend = new TakramCloudRendererAdapter(createOptions());
  const environment = {
    irradianceTexture: new DataTexture(),
    scatteringTexture: new Data3DTexture(),
    transmittanceTexture: new DataTexture(),
    singleMieScatteringTexture: new Data3DTexture(),
    higherOrderScatteringTexture: new Data3DTexture(),
  };
  const frame = {
    dt: 1 / 60,
    renderer: backend.renderer,
    inputBuffer: {},
    camera: backend.camera,
    scene: backend.scene,
    sunDirection: backend.sunDirection,
    environment,
    sceneDepth: backend.depthTexture,
    cameraCut: false,
  };
  backend.effect.update = () => {};

  backend.update(frame);

  assert.strictEqual(backend.effect.irradianceTexture, environment.irradianceTexture);
  assert.strictEqual(backend.effect.scatteringTexture, environment.scatteringTexture);
  assert.strictEqual(backend.effect.transmittanceTexture, environment.transmittanceTexture);
  assert.strictEqual(backend.effect.singleMieScatteringTexture, environment.singleMieScatteringTexture);
  assert.strictEqual(backend.effect.higherOrderScatteringTexture, environment.higherOrderScatteringTexture);
  assert.equal(backend.effect.clouds.accurateSunSkyLight, true);

  backend.dispose();
});

test('update restores the exact renderer target face and mip level when Takram throws', () => {
  const originalTarget = { name: 'caller-target' };
  const renderer = createRenderer(1920, 1080, {
    target: originalTarget,
    cubeFace: 4,
    mipmapLevel: 3,
  });
  const backend = new TakramCloudRendererAdapter({ ...createOptions(), renderer });
  const frame = {
    dt: 1 / 60,
    renderer,
    inputBuffer: {},
    camera: backend.camera,
    scene: backend.scene,
    sunDirection: backend.sunDirection,
    environment: null,
    sceneDepth: backend.depthTexture,
    cameraCut: false,
  };
  backend.effect.update = () => {
    renderer.setRenderTarget({ name: 'takram-target' }, 1, 2);
    throw new Error('synthetic Takram failure');
  };

  assert.throws(() => backend.update(frame), /synthetic Takram failure/);
  assert.strictEqual(renderer.currentTarget, originalTarget);
  assert.equal(renderer.activeCubeFace, 4);
  assert.equal(renderer.activeMipmapLevel, 3);

  backend.dispose();
});

test('history reset restores the exact renderer target face and mip level', () => {
  const originalTarget = { name: 'caller-target' };
  const renderer = createRenderer(1920, 1080, {
    target: originalTarget,
    cubeFace: 5,
    mipmapLevel: 2,
  });
  const backend = new TakramCloudRendererAdapter({ ...createOptions(), renderer });

  backend.resetHistory('camera-cut');

  assert.strictEqual(renderer.currentTarget, originalTarget);
  assert.equal(renderer.activeCubeFace, 5);
  assert.equal(renderer.activeMipmapLevel, 2);

  backend.dispose();
});

test('disposes every owned target material geometry and texture exactly once', () => {
  const backend = new TakramCloudRendererAdapter(createOptions());
  const effect = backend.effect;
  const ownedResources = [
    effect.cloudsPass.currentRenderTarget,
    effect.cloudsPass.resolveRenderTarget,
    effect.cloudsPass.historyRenderTarget,
    effect.shadowPass.currentRenderTarget,
    effect.shadowPass.resolveRenderTarget,
    effect.shadowPass.historyRenderTarget,
    effect.cloudsPass.currentMaterial,
    effect.cloudsPass.resolveMaterial,
    effect.shadowPass.currentMaterial,
    effect.shadowPass.resolveMaterial,
    ...backend.generatedResources.flatMap(resource => [
      resource.renderTarget,
      resource.material,
      resource.mesh.geometry,
    ]),
    ...Object.values(backend.fallbackAtmosphereTextures),
    backend.fallbackStbnTexture,
  ].filter(Boolean);
  assert.equal(new Set(ownedResources).size, ownedResources.length);
  let liveCount = ownedResources.length;
  const disposeCounts = new Map(ownedResources.map(resource => [resource, 0]));

  for (const resource of ownedResources) {
    resource.addEventListener('dispose', () => {
      disposeCounts.set(resource, disposeCounts.get(resource) + 1);
      liveCount -= 1;
    });
  }

  backend.dispose();
  backend.dispose();

  assert.equal(liveCount, 0);
  assert.equal([...disposeCounts.values()].every(count => count === 1), true);
});

test('third-party notice preserves the exact UTF-8 Hillaire attribution', async () => {
  const notice = await readFile(new URL('../../../public/THIRD_PARTY_NOTICES.txt', import.meta.url), 'utf8');
  assert.match(notice, /Sébastien Hillaire/);
  assert.doesNotMatch(notice, /SÃ©bastien/);
});
