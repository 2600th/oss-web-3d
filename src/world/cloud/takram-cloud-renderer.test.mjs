import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  Data3DTexture,
  DataTexture,
  PerspectiveCamera,
  Scene,
  Texture,
  Vector2,
  Vector3,
} from 'three';
import { CloudsEffect } from '@takram/three-clouds';
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

function createOptions(quality = { name: 'high' }) {
  return {
    renderer: createRenderer(),
    quality,
    camera: new PerspectiveCamera(60, 16 / 9, 1, 200_000),
    scene: new Scene(),
    sunDirection: new Vector3(0.2, 0.9, -0.3).normalize(),
    stableDepthTexture: new Texture(),
  };
}

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
