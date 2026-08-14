import * as THREE from 'three';
import { EffectPass } from 'postprocessing';
import { PrecomputedTexturesGenerator } from '@takram/three-atmosphere';
import { DEFAULT_STBN_URL, STBNLoader } from '@takram/three-geospatial';

import { Engine } from '../../core/Engine.js';
import { TIERS } from '../../core/Settings.js';
import { Mission } from '../../game/Mission.js';
import { terrainVisibility } from '../../game/TerrainVisibility.js';
import { CloudVolume } from '../CloudVolume.js';
import { Environment } from '../Environment.js';
import { Sky } from '../Sky.js';
import { Terrain, configureTerrain } from '../Terrain.js';
import { terrainHeight } from '../heightfield.js';
import { CurrentCloudRendererAdapter } from './CurrentCloudRendererAdapter.js';
import { CloudBufferDebugEffect, CLOUD_BUFFER_DEBUG_VIEWS } from './CloudBufferDebugEffect.js';
import {
  assessRawCloudDiagnosticEligibility,
  measureCloudBufferPixels,
  readCloudOutputBuffer,
} from './CloudBufferDiagnostics.js';
import { captureFrozenCloudCompositeEvidence } from './CloudBufferEvidenceCapture.js';
import {
  CloudBenchmark,
  CloudLifecycleAuditor,
  combineOwnedResourceItems,
  computeObjectiveContrast,
  computeTemporalTrail,
  createCloudComparisonResult,
  deriveCloudMask,
  flipPixelRows,
  summarizeResourceReport,
} from './CloudBenchmark.js';
import {
  TAKRAM_CLOUD_ASSET_MANIFEST,
  disposeTakramCloudAssets,
  loadOfficialTakramCloudAssets,
} from './TakramCloudAssets.js';
import { createTakramAtmosphereComposition } from './TakramAtmosphereComposition.js';
import { TakramCloudRendererAdapter } from './TakramCloudRendererAdapter.js';
import {
  nearestLayerBoundaryDistance,
  validateTakramProfileScenario,
} from './TakramCloudProfiles.js';

const BACKENDS = new Set(['current', 'takram']);
const QUALITIES = new Set(['phone', 'low', 'medium', 'high']);
const COMPOSITE_VIEW = 'composite';
const COMPARISON_VIEWS = new Set([COMPOSITE_VIEW, ...CLOUD_BUFFER_DEBUG_VIEWS]);
const TERRAIN_SEED = 'safed-sagar-heightfield-v1';
const WARMUP_FRAMES = 120;
const CAPTURE_FRAMES = 60;
const FIXED_DT = 1 / 60;

function event(frame, values = {}) {
  return { frame, ...values };
}

export function installConsoleIssueCapture(consoleValue, sink) {
  const originals = { warn: consoleValue.warn, error: consoleValue.error };
  const wrappers = {};
  for (const level of ['warn', 'error']) {
    wrappers[level] = (...args) => {
      sink.push({
        level,
        message: args.map(value => value instanceof Error ? value.message : String(value)).join(' '),
      });
      originals[level](...args);
    };
    consoleValue[level] = wrappers[level];
  }
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    for (const level of ['warn', 'error']) {
      if (consoleValue[level] === wrappers[level]) consoleValue[level] = originals[level];
    }
  };
}

const worldPose = (position, target, options = {}) => ({
  kind: 'world', position, target, roll: 0, fov: 58, ...options,
});

const objectivePose = (range, bearing, altitude, options = {}) => ({
  kind: 'objective', range, bearing, altitude, roll: 0, fov: 42, ...options,
});

const OPENING_TARGET = [0, 4700, -12000];
const SCENARIOS = {
  'opening-3.5': {
    openingSeconds: 3.5,
    events: [event(0, {
      resetHistory: 'scenario-transition',
      camera: worldPose([20500, 7200, 5200], OPENING_TARGET),
    })],
  },
  'opening-10': {
    openingSeconds: 10,
    events: [event(0, {
      resetHistory: 'scenario-transition',
      camera: worldPose([18800, 6900, 2400], OPENING_TARGET),
    })],
  },
  'opening-25': {
    openingSeconds: 25,
    events: [event(0, {
      resetHistory: 'scenario-transition',
      camera: worldPose([14200, 6500, -3800], OPENING_TARGET),
    })],
  },
  'side-bank': {
    minimumClearance: 1500,
    events: [
      event(0, {
        resetHistory: 'scenario-transition',
        camera: objectivePose(7000, -65, 1800, { roll: -0.62, fov: 54 }),
      }),
      event(150, { camera: objectivePose(4200, -15, 1250, { roll: 0.58, fov: 54 }) }),
      event(175, { camera: objectivePose(3500, 10, 1100, { roll: 0.12, fov: 52 }) }),
    ],
  },
  'fast-motion-stop': {
    minimumClearance: 1500,
    events: [
      event(0, {
        resetHistory: 'scenario-transition',
        camera: objectivePose(9000, -80, 2300, { roll: -0.35, fov: 60 }),
      }),
      event(150, { camera: objectivePose(3200, 5, 900, { roll: 0, fov: 46 }) }),
      event(179, { camera: objectivePose(3200, 5, 900, { roll: 0, fov: 46 }) }),
    ],
  },
  'chase-to-recon-cut': {
    minimumClearance: 900,
    events: [
      event(0, {
        resetHistory: 'scenario-transition',
        camera: objectivePose(5200, -34, 1500, { roll: -0.18, fov: 58 }),
      }),
      event(150, {
        resetHistory: 'camera-cut',
        cameraCut: true,
        camera: objectivePose(1800, 0, 500, { roll: 0, fov: 24 }),
      }),
    ],
  },
  'objective-8km': {
    objectiveRange: 8000,
    events: [event(0, {
      resetHistory: 'scenario-transition',
      camera: objectivePose(8000, -28, 1900),
    })],
  },
  'objective-3km': {
    objectiveRange: 3000,
    events: [event(0, {
      resetHistory: 'scenario-transition',
      camera: objectivePose(3000, -20, 820, { fov: 38 }),
    })],
  },
  'objective-framed': {
    minimumClearance: 700,
    objectiveRange: 1500,
    events: [event(0, {
      resetHistory: 'scenario-transition',
      camera: objectivePose(1500, 0, 420, { fov: 18, targetLift: 8 }),
    })],
  },
  'sun-front': {
    events: [event(0, {
      resetHistory: 'scenario-transition',
      camera: objectivePose(4800, 128, 1200, { fov: 48 }),
    })],
  },
  'sun-back': {
    events: [event(0, {
      resetHistory: 'scenario-transition',
      camera: objectivePose(4800, -52, 1200, { fov: 48 }),
    })],
  },
  resize: {
    events: [
      event(0, {
        resetHistory: 'scenario-transition',
        camera: objectivePose(4500, -25, 1200),
      }),
      event(150, { resetHistory: 'resize', viewport: [1280, 720] }),
    ],
  },
  'high-to-phone': {
    events: [
      event(0, {
        resetHistory: 'scenario-transition',
        quality: 'high',
        camera: objectivePose(4500, -25, 1200),
      }),
      event(150, { resetHistory: 'quality-change', quality: 'phone' }),
    ],
  },
  'context-loss': {
    events: [
      event(0, {
        resetHistory: 'scenario-transition',
        camera: objectivePose(4500, -25, 1200),
      }),
      event(150, { resetHistory: 'context-loss', context: 'lose' }),
      event(154, { resetHistory: 'context-restore', context: 'restore' }),
    ],
  },
  'context-restore': {
    events: [
      event(0, {
        resetHistory: 'scenario-transition',
        camera: objectivePose(4500, -25, 1200),
      }),
      event(140, { resetHistory: 'context-loss', context: 'lose' }),
      event(150, { resetHistory: 'context-restore', context: 'restore' }),
    ],
  },
  'reference-sky': {
    captureKind: 'sky-only-reference',
    inSceneMissionCapture: false,
    terrainDepthPolicy: 'raw-diagnostic-bypass-only',
    depthSetup: {
      owner: 'comparison-harness',
      stable: false,
      near: 4,
      far: 750000,
    },
    events: [event(0, {
      resetHistory: 'scenario-transition',
      camera: worldPose([19500, 5600, 5200], OPENING_TARGET),
    })],
  },
  'himalayan-opening': {
    profileRequirement: 'takram-himalayan',
    events: [event(0, {
      resetHistory: 'scenario-transition',
      camera: objectivePose(7600, -30, 1850, { fov: 50 }),
    })],
  },
  'himalayan-side-bank': {
    profileRequirement: 'takram-himalayan',
    minimumClearance: 1600,
    events: [
      event(0, {
        resetHistory: 'scenario-transition',
        camera: objectivePose(7400, -68, 2100, { roll: -0.48, fov: 56 }),
      }),
      event(150, { camera: objectivePose(4100, -8, 1450, { roll: 0.42, fov: 51 }) }),
    ],
  },
  'cloud-buffer': {
    captureKind: 'raw-cloud-buffer-diagnostic',
    terrainDepthPolicy: 'preserve-terrain-depth',
    events: [event(0, {
      resetHistory: 'scenario-transition',
      camera: objectivePose(5200, -25, 1500, { fov: 52 }),
    })],
  },
};

function deepFreeze(value) {
  if (value == null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function unverifiedBenchmarkReport() {
  return {
    status: 'UNVERIFIED',
    cpu: { sampleCount: 0, medianMs: null, p95Ms: null },
    gpu: {
      supported: false,
      status: 'UNVERIFIED',
      sampleCount: 0,
      medianMs: null,
      p95Ms: null,
      disjointCount: 0,
      droppedCount: 0,
      pendingCount: 0,
    },
    fps: null,
    fpsStatus: 'UNVERIFIED',
    frameCadence: { status: 'UNVERIFIED', sampleCount: 0, medianMs: null, p95Ms: null },
    capabilities: { timerQuery: false, webgl2: false },
    observation: { visibilityStates: [], focusStates: [], rejectedFrames: 0 },
  };
}

deepFreeze(SCENARIOS);

export const COMPARISON_SCENARIO_NAMES = Object.freeze(Object.keys(SCENARIOS));

function defaultTakramProfileForScenario(scenario) {
  return scenario.profileRequirement ?? 'takram-reference';
}

export function createScenario(name, backend) {
  if (!BACKENDS.has(backend)) {
    throw new RangeError(`Unknown cloud comparison backend: ${String(backend)}`);
  }
  const definition = SCENARIOS[name];
  if (definition == null) {
    throw new RangeError(`Unknown cloud comparison scenario: ${String(name)}`);
  }
  return deepFreeze({
    name,
    backend,
    terrainSeed: TERRAIN_SEED,
    warmupFrames: WARMUP_FRAMES,
    captureFrames: CAPTURE_FRAMES,
    fixedDeltaSeconds: FIXED_DT,
    minimumClearance: 1200,
    profileRequirement: null,
    captureKind: 'in-scene-mission-capture',
    inSceneMissionCapture: true,
    terrainDepthPolicy: 'preserve-terrain-depth',
    depthSetup: {
      owner: 'production-composer',
      stable: true,
      near: 4,
      far: 750000,
    },
    ...structuredClone(definition),
  });
}

export function parseComparisonQuery(search = '') {
  const params = new URLSearchParams(search);
  for (const key of params.keys()) {
    if (!['backend', 'quality', 'scenario', 'profile', 'view'].includes(key)) {
      throw new RangeError(`Unknown query parameter: ${key}`);
    }
  }
  const backend = params.get('backend') ?? 'current';
  const quality = params.get('quality') ?? 'high';
  const scenario = params.get('scenario') ?? 'opening-3.5';
  if (!BACKENDS.has(backend)) throw new RangeError(`Unknown backend query value: ${backend}`);
  if (!QUALITIES.has(quality)) throw new RangeError(`Unknown quality query value: ${quality}`);
  if (!COMPARISON_SCENARIO_NAMES.includes(scenario)) {
    throw new RangeError(`Unknown scenario query value: ${scenario}`);
  }
  const definition = SCENARIOS[scenario];
  const requestedProfile = params.get('profile');
  const requestedView = params.get('view');
  if (backend === 'current') {
    if (requestedProfile != null) {
      throw new RangeError('profile query values are only valid for Takram');
    }
    if (requestedView != null && requestedView !== COMPOSITE_VIEW) {
      throw new RangeError('raw view query values are only valid for Takram');
    }
    return { backend, quality, scenario, profile: null, view: COMPOSITE_VIEW };
  }
  const profile = requestedProfile ?? defaultTakramProfileForScenario(definition);
  const view = requestedView ?? COMPOSITE_VIEW;
  if (!['takram-reference', 'takram-himalayan'].includes(profile)) {
    throw new RangeError(`Unknown profile query value: ${profile}`);
  }
  if (!COMPARISON_VIEWS.has(view)) throw new RangeError(`Unknown view query value: ${view}`);
  if (definition.profileRequirement != null && profile !== definition.profileRequirement) {
    throw new RangeError(`${scenario} requires profile=${definition.profileRequirement}`);
  }
  return { backend, quality, scenario, profile, view };
}

export function renderComparisonFrame(runtime, dt) {
  const camera = runtime.engine.camera;
  runtime.environment.update(dt, camera.position);
  runtime.sky.update(camera);
  runtime.terrain.update(camera.position, runtime.terrainBudget ?? 4);
  runtime.atmosphereComposition?.updateBindings();
  // The attached Effect is invoked once by EffectComposer. Calling the adapter
  // here as well would render the cloud backend twice and invalidate A/B data.
  runtime.lifecycleAudit?.beforeRender();
  runtime.engine.render(dt);
}

function lifecycleResourceSignature(resource) {
  const image = resource?.texture?.image ?? resource?.image ?? resource?.source?.data;
  const width = resource?.width ?? image?.width;
  const height = resource?.height ?? image?.height;
  const depth = resource?.depth ?? image?.depth ?? 1;
  const texture = resource?.texture ?? resource;
  if (width != null && height != null) {
    return `${width}x${height}x${depth}:${String(texture?.format)}:${String(texture?.type)}`;
  }
  return resource?.constructor?.name ?? typeof resource;
}

export function describeCloudLifecycleResources(runtime) {
  const descriptors = [];
  const resources = new Set();
  const add = (key, resource, signature = lifecycleResourceSignature(resource)) => {
    if (resource == null || resources.has(resource) || typeof resource.dispose !== 'function') return;
    resources.add(resource);
    descriptors.push({ key, resource, signature });
  };
  add('backend', runtime.backend, 'cloud-renderer-adapter');
  add('pass', runtime.engine?.cloudComparisonPass, 'cloud-effect-pass');
  add('query', runtime.benchmark?.gpu, 'timer-query');
  add('atmosphere-generator', runtime.atmosphereGenerator, 'takram-atmosphere-generator');
  for (const [name, texture] of Object.entries(runtime.atmosphereTextures ?? {})) {
    add(`atmosphere-${name}`, texture);
  }
  add('official-stbn', runtime.stbnTexture);
  for (const [name, texture] of Object.entries(runtime.cloudAssets ?? {})) {
    if (name.endsWith('Texture')) add(`official-cloud-${name}`, texture);
  }

  const current = runtime.backend?.cloudVolume;
  for (let index = 0; index < (current?._temporalTargets?.length ?? 0); index += 1) {
    add(`current-temporal-${index}`, current._temporalTargets[index]);
  }
  add('current-shadow', current?._shadowTarget);

  const effect = runtime.backend?.effect;
  const targets = [
    ['takram-cloud-current', effect?.cloudsPass?.currentRenderTarget],
    ['takram-cloud-resolve', effect?.cloudsPass?.resolveRenderTarget],
    ['takram-cloud-history', effect?.cloudsPass?.historyRenderTarget],
    ['takram-shadow-current', effect?.shadowPass?.currentRenderTarget],
    ['takram-shadow-resolve', effect?.shadowPass?.resolveRenderTarget],
    ['takram-shadow-history', effect?.shadowPass?.historyRenderTarget],
  ];
  for (const [key, resource] of targets) add(key, resource);
  add('takram-cloud-current-material', effect?.cloudsPass?.currentMaterial);
  add('takram-cloud-resolve-material', effect?.cloudsPass?.resolveMaterial);
  add('takram-shadow-current-material', effect?.shadowPass?.currentMaterial);
  add('takram-shadow-resolve-material', effect?.shadowPass?.resolveMaterial);
  for (let index = 0; index < (runtime.backend?.generatedResources?.length ?? 0); index += 1) {
    const generated = runtime.backend.generatedResources[index];
    add(`takram-generated-${index}-target`, generated.renderTarget);
    add(`takram-generated-${index}-material`, generated.material);
    add(`takram-generated-${index}-geometry`, generated.mesh?.geometry);
  }
  for (const [name, texture] of Object.entries(runtime.backend?.fallbackAtmosphereTextures ?? {})) {
    add(`takram-fallback-${name}`, texture);
  }
  add('takram-stbn-fallback', runtime.backend?.fallbackStbnTexture);
  add('takram-stbn-external', runtime.backend?.stbnTexture);
  add('takram-aerial-perspective', runtime.atmosphereComposition?.aerialPerspective,
    'takram-aerial-perspective-effect');
  return descriptors;
}

export function resetScenarioClock(environment, scenario) {
  environment.uniforms.uTime.value = 0;
  environment.uniforms.uCloudTime.value = scenario.openingSeconds ?? 0;
}

export function loadOfficialStbnTexture(loader = new STBNLoader()) {
  return new Promise((resolve, reject) => {
    let placeholder = null;
    try {
      placeholder = loader.load(DEFAULT_STBN_URL, texture => {
        const image = texture.image;
        const bytes = image?.data?.byteLength ?? 0;
        if (image?.width !== 128 || image?.height !== 128 || image?.depth !== 64
          || bytes !== 128 * 128 * 64) {
          texture.dispose?.();
          if (placeholder != null && placeholder !== texture) placeholder.dispose?.();
          reject(new Error(
            `Invalid official STBN texture: ${image?.width ?? 0}x${image?.height ?? 0}x${image?.depth ?? 0}, ${bytes} bytes`,
          ));
          return;
        }
        if (placeholder != null && placeholder !== texture) placeholder.dispose?.();
        resolve(texture);
      }, undefined, error => {
        placeholder?.dispose?.();
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    } catch (error) {
      reject(error);
    }
  });
}

export function assessVisualEligibility({ backend, enabled, lightingMode, stbnMode, cloudAssetMode }) {
  if (backend === 'current') return { eligible: true, reason: null };
  if (!enabled) return { eligible: false, reason: 'takram-disabled-phone' };
  if (cloudAssetMode !== 'official-pinned') {
    return { eligible: false, reason: 'official-cloud-assets-unavailable' };
  }
  if (lightingMode === 'fallback-lighting') return { eligible: false, reason: 'fallback-lighting' };
  if (stbnMode !== 'official-pinned') return { eligible: false, reason: 'official-stbn-unavailable' };
  // Assets and shaders are necessary but not sufficient: silhouette, terrain
  // occlusion, repetition and horizon artifacts require composited image review.
  return { eligible: false, reason: 'pending-composited-visual-review' };
}

export function assessTakramReferenceAssetEligibility({
  backend,
  requiresEnabledTakram,
  cloudAssetMode,
}) {
  if (backend !== 'takram' || !requiresEnabledTakram) return { eligible: true, reason: null };
  if (cloudAssetMode !== 'official-pinned') {
    return { eligible: false, reason: 'official-cloud-assets-unavailable' };
  }
  return { eligible: true, reason: null };
}

export function createCloudDiagnosticMetadata({
  backend,
  profileName,
  view,
  scenario,
  cloudProfile,
  cameraGeodeticAltitude,
  profileContext,
  cloudAssetMode,
  rawMetrics,
  captureEvidence = null,
  terrainDepthBypassed,
}) {
  const nearestLayerBoundaryDistance = cloudProfile?.layers == null
    || !Number.isFinite(cameraGeodeticAltitude)
    ? null
    : nearestLayerBoundaryDistanceForProfile(cloudProfile, cameraGeodeticAltitude);
  const profileValidation = profileName === 'takram-himalayan' && profileContext != null
    ? validateTakramProfileScenario(cloudProfile, profileContext)
    : { eligible: nearestLayerBoundaryDistance == null || nearestLayerBoundaryDistance >= 500 };
  const raw = view !== COMPOSITE_VIEW;
  const eligibility = raw
    ? assessRawCloudDiagnosticEligibility({
      cloudAssetMode,
      nearestLayerBoundaryDistance,
      rawMetrics,
      captureEvidence,
    })
    : profileValidation.eligible
      ? { eligible: true, reason: null, reasons: [] }
      : {
        eligible: false,
        reason: 'camera-near-zero-density-boundary',
        reasons: ['camera-near-zero-density-boundary'],
      };
  const referenceSky = scenario.name === 'reference-sky'
    || scenario.captureKind === 'sky-only-reference';
  return deepFreeze({
    profile: profileName,
    view,
    cameraGeodeticAltitude: Number.isFinite(cameraGeodeticAltitude)
      ? cameraGeodeticAltitude
      : null,
    nearestLayerBoundaryDistance,
    cloudAssetMode,
    compositionMode: backend === 'takram'
      ? raw ? 'takram-cloud-buffer-debug' : 'takram-atmosphere-composition'
      : 'current-production-composer',
    terrainDepthMode: terrainDepthBypassed && raw && referenceSky
      ? 'bypassed-for-raw-reference-sky'
      : 'stable-scene-depth',
    captureKind: referenceSky ? 'sky-only-reference' : scenario.captureKind,
    // This is intentionally derived from the canonical scenario label rather
    // than caller data, so a reference-sky result cannot become a mission
    // capture through a future scenario object merge.
    inSceneMissionCapture: referenceSky ? false : scenario.inSceneMissionCapture === true,
    eligibility,
  });
}

function nearestLayerBoundaryDistanceForProfile(profile, altitude) {
  return nearestLayerBoundaryDistance(profile.layers, altitude);
}

function selectedEffectForComposer(name, adapter) {
  return (name === 'current' ? adapter.cloudVolume : adapter.effect) ?? null;
}

const comparisonEffectIdentity = Symbol('cloud-comparison-effect');
const comparisonBenchmarkIdentity = Symbol('cloud-comparison-benchmark');
const comparisonPassClassIdentity = Symbol('cloud-comparison-pass-class');

function releaseDedicatedCloudPass(engine) {
  const pass = engine.cloudComparisonPass;
  if (pass == null) return;
  engine.composer.removePass(pass);
  pass.setEffects?.([]);
  pass.dispose?.();
  engine.cloudComparisonPass = null;
}

export function installDedicatedCloudPass(
  engine,
  effect,
  benchmark,
  EffectPassClass = EffectPass,
) {
  const effects = Array.isArray(effect) ? effect : effect == null ? [] : [effect];
  const installedPass = engine.cloudComparisonPass;
  if (
    installedPass != null
    && installedPass[comparisonEffectIdentity] === effect
    && installedPass[comparisonBenchmarkIdentity] === benchmark
    && installedPass[comparisonPassClassIdentity] === EffectPassClass
  ) {
    return installedPass;
  }
  releaseDedicatedCloudPass(engine);
  // The normal radiance pass remains lens-only. This makes the query boundary
  // exactly one cloud composition instead of cloud + lens artifacts.
  engine.clouds = null;
  engine._buildEffectPass();
  if (effects.length === 0) return null;
  const pass = new EffectPassClass(engine.camera, ...effects);
  pass[comparisonEffectIdentity] = effect;
  pass[comparisonBenchmarkIdentity] = benchmark;
  pass[comparisonPassClassIdentity] = EffectPassClass;
  const render = pass.render.bind(pass);
  pass.render = (...args) => benchmark.measure(() => render(...args));
  engine.cloudComparisonPass = pass;
  engine.composer.addPass(pass);
  const passes = engine.composer.passes;
  const appendedIndex = passes.indexOf(pass);
  const radianceIndex = passes.indexOf(engine.radiancePass);
  if (appendedIndex >= 0 && radianceIndex >= 0 && appendedIndex > radianceIndex) {
    passes.splice(appendedIndex, 1);
    passes.splice(radianceIndex, 0, pass);
  }
  pass.renderToScreen = false;
  engine._buildEffectPass();
  return pass;
}

function installComparisonEffects(runtime) {
  if (runtime.backendName === 'takram' && runtime.view !== COMPOSITE_VIEW && runtime.backend.effect != null) {
    runtime.cloudBufferDebugEffect = new CloudBufferDebugEffect(runtime.backend.effect, runtime.view);
    runtime.atmosphereComposition = null;
    installDedicatedCloudPass(runtime.engine, runtime.cloudBufferDebugEffect, runtime.benchmark);
    return;
  }
  if (runtime.backendName === 'takram' && runtime.backend.effect != null) {
    runtime.atmosphereComposition = createTakramAtmosphereComposition({
      camera: runtime.engine.camera,
      scene: runtime.engine.scene,
      clouds: runtime.backend.effect,
      textures: { ...(runtime.atmosphereTextures ?? {}), stbnTexture: runtime.stbnTexture },
      renderer: runtime.engine.renderer,
    });
    installDedicatedCloudPass(runtime.engine, runtime.atmosphereComposition.effects, runtime.benchmark);
    return;
  }
  installDedicatedCloudPass(
    runtime.engine,
    selectedEffectForComposer(runtime.backendName, runtime.backend),
    runtime.benchmark,
  );
}

function disposeComparisonEffects(runtime) {
  runtime.cloudBufferDebugEffect?.dispose();
  runtime.cloudBufferDebugEffect = null;
  runtime.atmosphereComposition?.dispose();
  runtime.atmosphereComposition = null;
}

export function shouldBypassTerrainDepth({ backendName, view, scenario }) {
  return backendName === 'takram'
    && view !== COMPOSITE_VIEW
    && scenario.terrainDepthPolicy === 'raw-diagnostic-bypass-only';
}

function configureDiagnosticDepth(runtime) {
  const bypassTerrainDepth = shouldBypassTerrainDepth(runtime);
  runtime.terrainDepthBypassed = bypassTerrainDepth;
  runtime.backend.setDepthTexture(
    bypassTerrainDepth ? null : runtime.engine.composer.stableDepthTexture,
  );
}

function resolvedPose(pose, objectiveAim) {
  if (pose.kind === 'world') {
    return {
      position: new THREE.Vector3(...pose.position),
      target: new THREE.Vector3(...pose.target),
      roll: pose.roll,
      fov: pose.fov,
    };
  }
  const angle = THREE.MathUtils.degToRad(pose.bearing);
  const aim = new THREE.Vector3(...objectiveAim);
  aim.y += pose.targetLift ?? 0;
  return {
    position: new THREE.Vector3(
      aim.x + Math.sin(angle) * pose.range,
      aim.y + pose.altitude,
      aim.z + Math.cos(angle) * pose.range,
    ),
    target: aim,
    roll: pose.roll,
    fov: pose.fov,
  };
}

export function sampleScenarioCameraPose(scenario, objectiveAim, frame, heightAt = terrainHeight) {
  const cameraEvents = scenario.events.filter(item => item.camera != null);
  let previous = cameraEvents[0];
  let next = previous;
  for (const item of cameraEvents) {
    if (item.frame <= frame) previous = item;
    if (item.frame >= frame) {
      next = item;
      break;
    }
    next = item;
  }
  const from = resolvedPose(previous.camera, objectiveAim);
  const to = resolvedPose(next.camera, objectiveAim);
  const span = Math.max(1, next.frame - previous.frame);
  const alpha = next === previous ? 0 : THREE.MathUtils.clamp((frame - previous.frame) / span, 0, 1);
  const position = new THREE.Vector3().lerpVectors(from.position, to.position, alpha);
  const target = from.target.lerp(to.target, alpha);
  const ground = heightAt(position.x, position.z);
  position.y = Math.max(position.y, ground + scenario.minimumClearance);
  const result = {
    position: position.toArray(),
    target: target.toArray(),
    roll: THREE.MathUtils.lerp(from.roll, to.roll, alpha),
    fov: THREE.MathUtils.lerp(from.fov, to.fov, alpha),
    agl: position.y - ground,
  };
  return deepFreeze(result);
}

/**
 * Derives the Himalayan altitude context from the scenario's deterministic
 * terrain samples before the cloud adapter is constructed. The maximum camera
 * altitude is deliberate: every interpolated pose then remains at least as
 * far below the translated lower cloud boundary as the validated sample.
 */
export function deriveTakramProfileContext(scenario, objectiveAim, heightAt = terrainHeight) {
  const authoredFrames = scenario.events
    .filter(item => item.camera != null)
    .map(item => item.frame);
  if (authoredFrames.length === 0) throw new RangeError('Takram profile scenario has no camera poses');
  const finalCameraFrame = Math.max(...authoredFrames);
  const frames = Array.from({ length: finalCameraFrame + 1 }, (_unused, frame) => frame);
  const samples = frames.map(frame => sampleScenarioCameraPose(scenario, objectiveAim, frame, heightAt));
  // Probe a fixed nine-point neighbourhood for every deterministic camera
  // sample. This captures ridge crests between authored keyframes without
  // relying on asynchronously streamed terrain geometry.
  const terrainOffsets = [-250, 0, 250];
  const terrain = samples.flatMap(sample => terrainOffsets.flatMap(offsetX => (
    terrainOffsets.map(offsetZ => heightAt(
      sample.position[0] + offsetX,
      sample.position[2] + offsetZ,
    ))
  )));
  return deepFreeze({
    terrainMin: Math.min(...terrain),
    terrainMax: Math.max(...terrain),
    cameraAltitude: Math.max(...samples.map(sample => sample.position[1])),
    sampleCount: terrain.length,
    cameraSampleCount: samples.length,
  });
}

function applyCamera(runtime, frame) {
  const camera = runtime.engine.camera;
  const pose = sampleScenarioCameraPose(
    runtime.scenario,
    runtime.objective.aimPoint.toArray(),
    frame,
  );
  camera.position.fromArray(pose.position);
  camera.fov = pose.fov;
  camera.updateProjectionMatrix();
  camera.up.set(0, 1, 0);
  camera.lookAt(new THREE.Vector3().fromArray(pose.target));
  camera.rotateZ(pose.roll);
  camera.updateMatrixWorld(true);
}

function setRuntimeSize(runtime, width, height) {
  const camera = runtime.engine.camera;
  const pixelRatio = Math.min(window.devicePixelRatio || 1, runtime.engine.maxPixelRatio);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  runtime.engine.renderer.setPixelRatio(pixelRatio);
  runtime.engine.renderer.setSize(width, height, false);
  runtime.engine.composer.setSize(width, height);
  const size = runtime.engine.renderer.getDrawingBufferSize(new THREE.Vector2());
  runtime.backend.setSize(size.x, size.y, pixelRatio);
}

function setRuntimeQuality(runtime, quality) {
  if (runtime.quality === quality) return;
  runtime.quality = quality;
  runtime.settings.tier = TIERS[quality];
  disposeComparisonEffects(runtime);
  runtime.backend.setQuality(TIERS[quality]);
  installComparisonEffects(runtime);
  if (runtime.backendName === 'takram' && runtime.stbnTexture) {
    runtime.backend.setStbnTexture(runtime.stbnTexture);
  }
  runtime.engine.renderScale = Math.min(1, runtime.settings.tier.pixelRatio);
  runtime.engine._buildEffectPass();
  setRuntimeSize(runtime, window.innerWidth, window.innerHeight);
  configureDiagnosticDepth(runtime);
}

export function applyContextEvent(runtime, action) {
  const extension = runtime.contextLossExtension;
  if (extension == null) {
    runtime.contextEvents.push({ frame: runtime.frame, action, supported: false });
  } else if (action === 'lose') {
    extension.loseContext();
    runtime.contextEvents.push({ frame: runtime.frame, action: 'lose', supported: true });
  } else {
    extension.restoreContext();
    runtime.contextEvents.push({ frame: runtime.frame, action: 'restore', supported: true });
  }
}

export function applyComparisonEvent(runtime, item) {
  const lifecycleReason = item.context === 'lose' ? 'context-restore'
    : item.quality ? 'quality-change'
      : item.viewport ? 'resize' : null;
  if (lifecycleReason != null) runtime.lifecycleAudit?.begin(lifecycleReason);
  if (item.quality) setRuntimeQuality(runtime, item.quality);
  if (item.viewport) setRuntimeSize(runtime, item.viewport[0], item.viewport[1]);
  if (item.context) applyContextEvent(runtime, item.context);
  if (item.resetHistory) {
    runtime.backend.resetHistory(item.resetHistory);
    runtime.historyResets.push({ frame: runtime.frame, reason: item.resetHistory });
    runtime.lifecycleAudit?.markReset(item.resetHistory);
  }
  if (lifecycleReason != null && lifecycleReason !== 'context-restore') {
    runtime.lifecycleAudit?.completeMutation();
  }
}

function textureBytes(texture) {
  const image = texture?.image ?? texture?.source?.data;
  const width = image?.width ?? 1;
  const height = image?.height ?? 1;
  const depth = image?.depth ?? 1;
  const channels = texture?.format === THREE.RedFormat ? 1
    : texture?.format === THREE.RGFormat ? 2
      : texture?.format === THREE.RGBFormat ? 3 : 4;
  const bytesPerChannel = texture?.type === THREE.FloatType ? 4
    : texture?.type === THREE.HalfFloatType ? 2 : 1;
  let mipWidth = width;
  let mipHeight = height;
  let texels = width * height * depth;
  let mipLevels = 1;
  if (texture?.generateMipmaps) {
    while (mipWidth > 1 || mipHeight > 1) {
      mipWidth = Math.max(1, Math.floor(mipWidth / 2));
      mipHeight = Math.max(1, Math.floor(mipHeight / 2));
      texels += mipWidth * mipHeight * depth;
      mipLevels += 1;
    }
  }
  return { width, height, depth, channels, bytesPerChannel, mipLevels,
    bytes: texels * channels * bytesPerChannel };
}

function describeAtmosphereTextures(textures) {
  if (textures == null) return null;
  const resources = Object.entries(textures).map(([name, texture]) => ({
    name,
    kind: 'atmosphere-lut',
    ...textureBytes(texture),
  }));
  return {
    owner: 'comparison-harness',
    resources,
    totalBytes: resources.reduce((total, resource) => total + resource.bytes, 0),
  };
}

export function describeOfficialTakramCloudAssets(assets) {
  if (assets?.mode !== 'official-pinned') return null;
  const textureEntries = [
    ['official-local-weather', 'localWeather', 'localWeatherTexture'],
    ['official-cloud-shape', 'shape', 'shapeTexture'],
    ['official-cloud-shape-detail', 'shapeDetail', 'shapeDetailTexture'],
    ['official-turbulence', 'turbulence', 'turbulenceTexture'],
  ];
  const resources = textureEntries.map(([name, manifestName, textureName]) => {
    const entry = TAKRAM_CLOUD_ASSET_MANIFEST[manifestName];
    return {
      name,
      kind: 'official-cloud-texture',
      source: `/cloud-comparison/takram/${entry.file}`,
      payloadBytes: entry.bytes,
      ...textureBytes(assets[textureName]),
    };
  });
  return {
    owner: 'comparison-harness',
    resources,
    payloadBytes: resources.reduce((total, resource) => total + resource.payloadBytes, 0),
    totalBytes: resources.reduce((total, resource) => total + resource.bytes, 0),
  };
}

function disposeAtmosphereTextures(textures) {
  const disposed = new Set();
  for (const texture of Object.values(textures ?? {})) {
    if (texture == null || disposed.has(texture)) continue;
    disposed.add(texture);
    texture.dispose?.();
  }
}

export function sampleObjectiveReadability(runtime) {
  const camera = runtime.engine.camera;
  const point = runtime.objective.aimPoint.clone().project(camera);
  const visibility = terrainVisibility(camera.position, runtime.objective.aimPoint);
  if (point.z < -1 || point.z > 1 || Math.abs(point.x) > 1 || Math.abs(point.y) > 1) {
    return deepFreeze({ projected: [point.x, point.y, point.z], onScreen: false,
      terrainVisibility: visibility, terrainOccluded: visibility <= 0, cloudOcclusion: 'not-sampled',
      colorSpace: 'linear-srgb-from-final-rgba8', targetLuminance: null,
      backgroundLuminance: null, contrast: null });
  }

  const renderer = runtime.engine.renderer;
  const gl = renderer.getContext();
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  const sampleSize = 9;
  const centerX = Math.round((point.x * 0.5 + 0.5) * (size.x - 1));
  const centerY = Math.round((point.y * 0.5 + 0.5) * (size.y - 1));
  const x = Math.max(0, Math.min(size.x - sampleSize, centerX - 4));
  const y = Math.max(0, Math.min(size.y - sampleSize, centerY - 4));
  const pixels = new Uint8Array(sampleSize * sampleSize * 4);
  gl.readPixels(x, y, sampleSize, sampleSize, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

  const targetPixels = [];
  const backgroundPixels = [];
  for (let row = 0; row < sampleSize; row += 1) {
    for (let column = 0; column < sampleSize; column += 1) {
      const index = (row * sampleSize + column) * 4;
      const destination = Math.abs(row - 4) <= 1 && Math.abs(column - 4) <= 1
        ? targetPixels
        : backgroundPixels;
      destination.push(pixels[index], pixels[index + 1], pixels[index + 2], pixels[index + 3]);
    }
  }
  const contrastReport = computeObjectiveContrast({
    targetPixels: Uint8Array.from(targetPixels),
    backgroundPixels: Uint8Array.from(backgroundPixels),
  });
  return deepFreeze({
    projected: [point.x, point.y, point.z],
    onScreen: true,
    terrainVisibility: visibility,
    terrainOccluded: visibility <= 0,
    cloudOcclusion: visibility > 0 && contrastReport.contrast < 0.08
      ? 'possible-low-contrast'
      : 'not-detected',
    ...contrastReport,
    sample: { x, y, width: sampleSize, height: sampleSize },
  });
}

function nextAnimationFrame() {
  return new Promise(resolve => requestAnimationFrame(resolve));
}

export function publishComparisonResult(documentValue, result) {
  let element = documentValue.getElementById('comparison-result');
  if (element == null) {
    element = documentValue.createElement('pre');
    element.id = 'comparison-result';
    element.hidden = true;
    documentValue.body.append(element);
  }
  const serializable = structuredClone(result);
  const previousArtifactIds = element._comparisonArtifactIds ?? [];
  const artifactIds = [];
  for (let index = 0; index < (serializable.artifacts?.length ?? 0); index += 1) {
    const artifact = serializable.artifacts[index];
    if (typeof artifact.dataUrl !== 'string') continue;
    const imageId = `comparison-artifact-${index}`;
    let image = documentValue.getElementById(imageId);
    if (image == null) {
      image = documentValue.createElement('img');
      image.id = imageId;
      documentValue.body.append(image);
    }
    image.hidden = true;
    image.alt = artifact.name ?? artifact.kind ?? 'comparison artifact';
    image.src = artifact.dataUrl;
    artifactIds.push(imageId);
    delete artifact.dataUrl;
    artifact.domId = image.id;
  }
  for (const imageId of previousArtifactIds) {
    if (!artifactIds.includes(imageId)) documentValue.getElementById(imageId)?.remove?.();
  }
  element._comparisonArtifactIds = artifactIds;
  element.textContent = JSON.stringify(serializable);
}

function captureFinalRgba8(renderer) {
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  const pixels = new Uint8Array(size.x * size.y * 4);
  const gl = renderer.getContext();
  gl.readPixels(0, 0, size.x, size.y, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  return { width: size.x, height: size.y, pixels };
}

function heatmapDataUrl(heatmap, width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  const image = context.createImageData(width, height);
  const topDown = flipPixelRows(heatmap, width, height);
  for (let index = 0; index < topDown.length; index += 1) {
    const value = topDown[index];
    const offset = index * 4;
    image.data[offset] = value;
    image.data[offset + 1] = Math.round(value * 0.15);
    image.data[offset + 2] = 0;
    image.data[offset + 3] = 255;
  }
  context.putImageData(image, 0, 0);
  return canvas.toDataURL('image/png');
}

function rgbaDataUrl(frame) {
  const canvas = document.createElement('canvas');
  canvas.width = frame.width;
  canvas.height = frame.height;
  const context = canvas.getContext('2d');
  const image = context.createImageData(frame.width, frame.height);
  image.data.set(flipPixelRows(frame.pixels, frame.width, frame.height, 4));
  context.putImageData(image, 0, 0);
  return canvas.toDataURL('image/png');
}

export class CloudComparisonHarness {
  constructor(canvas, query) {
    this.canvas = canvas;
    this.backendName = query.backend;
    this.initialQuality = query.quality;
    this.quality = query.quality;
    this.scenario = createScenario(query.scenario, query.backend);
    this.profileName = query.profile ?? (query.backend === 'takram'
      ? defaultTakramProfileForScenario(this.scenario)
      : null);
    this.view = query.view ?? COMPOSITE_VIEW;
    this.phase = 'initializing';
    this.frame = 0;
    this.running = false;
    this.disposed = false;
    this.runResult = null;
    this.historyResets = [];
    this.contextEvents = [];
    this.consoleIssues = [];
    this.cloudAssets = null;
    this.cloudAssetMode = null;
    this.atmosphereComposition = null;
    this.cloudBufferDebugEffect = null;
    this.terrainDepthBypassed = false;
    this._restoreConsole = installConsoleIssueCapture(console, this.consoleIssues);

    this.settings = { tier: TIERS[this.quality] };
    this.engine = new Engine(canvas, this.settings);
    this.contextLossExtension = this.engine.renderer.getContext().getExtension('WEBGL_lose_context');
    this.benchmark = new CloudBenchmark(this.engine.renderer.getContext());
    this.engine.adaptEnabled = false;
    configureTerrain({ res: this.settings.tier.terrainRes });
    this.engine.applySettings();

    this.environment = new Environment();
    this.environment.addTo(this.engine.scene);
    this.sky = new Sky(this.environment);
    this.engine.scene.add(this.sky.mesh);
    this.terrain = new Terrain(this.engine.renderer, this.environment);
    this.terrain.setQuality(this.settings.tier);
    this.engine.scene.add(this.terrain.group);

    this.mission = new Mission(this.engine.scene, new THREE.Vector3(0, 0, 0), 1);
    this.objective = this.mission.target;
    this.terrain.prime(this.objective.position);
    this.profileContext = this.profileName === 'takram-himalayan'
      ? deriveTakramProfileContext(this.scenario, this.objective.aimPoint.toArray())
      : null;
    resetScenarioClock(this.environment, this.scenario);
    const envMap = this.sky.bakeEnvironment(this.engine.renderer, this.environment);
    this.engine.scene.environment = envMap;

    if (this.engine.composer.stableDepthTexture == null) this.engine.composer.createDepthTexture();
    this._constructBackend();
    installComparisonEffects(this);
    this.lifecycleAudit = new CloudLifecycleAuditor(() => describeCloudLifecycleResources(this));
    configureDiagnosticDepth(this);
    setRuntimeSize(this, window.innerWidth, window.innerHeight);
    this.phase = 'ready';

    this._onContextLost = eventValue => {
      eventValue.preventDefault();
      this.contextLost = true;
    };
    this._onContextRestored = () => {
      this.contextLost = false;
      this._contextRestorePromise = this._recreateAfterContextRestore();
    };
    canvas.addEventListener('webglcontextlost', this._onContextLost);
    canvas.addEventListener('webglcontextrestored', this._onContextRestored);
    this._onWindowError = eventValue => {
      this.consoleIssues.push({ level: 'error', message: eventValue.message ?? 'window-error' });
    };
    this._onUnhandledRejection = eventValue => {
      const reason = eventValue.reason;
      this.consoleIssues.push({ level: 'error', message: reason instanceof Error
        ? reason.message
        : String(reason) });
    };
    window.addEventListener('error', this._onWindowError);
    window.addEventListener('unhandledrejection', this._onUnhandledRejection);
  }

  _constructBackend() {
    const stableDepthTexture = this.engine.composer.stableDepthTexture;
    if (this.backendName === 'current') {
      this.backend = new CurrentCloudRendererAdapter(new CloudVolume(this.environment, this.engine.camera));
      this.lightingMode = 'shipping-environment';
      this.requiresEnabledTakram = false;
      this.cloudAssetMode = 'not-applicable-current';
      return;
    }
    this.backend = new TakramCloudRendererAdapter({
      renderer: this.engine.renderer,
      quality: this.settings.tier,
      camera: this.engine.camera,
      scene: this.engine.scene,
      sunDirection: this.environment.sunDir,
      stableDepthTexture,
      profileName: this.profileName,
      profileContext: this.profileContext,
    });
    this.requiresEnabledTakram = this.backend.profile.enabled
      || this.scenario.events.some(item => item.quality && item.quality !== 'phone');
    if (this.requiresEnabledTakram) {
      this.atmosphereGenerator = new PrecomputedTexturesGenerator(this.engine.renderer, {
        type: THREE.HalfFloatType,
        combinedScattering: true,
        higherOrderScattering: true,
      });
      this.lightingMode = 'precomputing-takram-lut';
      this.stbnMode = 'loading-official';
      this.cloudAssetMode = 'loading-official';
    } else {
      this.lightingMode = 'not-applicable-disabled';
      this.stbnMode = 'not-applicable-disabled';
      this.cloudAssetMode = 'not-applicable-disabled';
    }
  }

  async _recreateAfterContextRestore() {
    // Let WebGLRenderer finish its own restoration listeners, then reconstruct
    // the isolated comparison runtime. Several production post effects and the
    // atmosphere LUT own render targets, so recreating only the cloud backend
    // leaves undefined contents in the final composite after a real loss.
    await nextAnimationFrame();
    releaseDedicatedCloudPass(this.engine);
    disposeComparisonEffects(this);
    this.backend.dispose();
    this.atmosphereGenerator?.dispose();
    disposeAtmosphereTextures(this.atmosphereTextures);
    this.stbnTexture?.dispose();
    disposeTakramCloudAssets(this.cloudAssets);
    this.benchmark.dispose();
    this.mission.dispose();
    this.terrain.dispose();
    this.sky.dispose();
    this.environment.dispose();
    this.engine.dispose();
    this.atmosphereGenerator = null;
    this.atmosphereTextures = null;
    this.stbnTexture = null;
    this.cloudAssets = null;

    this.settings.tier = TIERS[this.quality];
    this.engine = new Engine(this.canvas, this.settings);
    this.engine.adaptEnabled = false;
    configureTerrain({ res: this.settings.tier.terrainRes });
    this.engine.applySettings();
    this.contextLossExtension = this.engine.renderer.getContext().getExtension('WEBGL_lose_context');
    this.benchmark = new CloudBenchmark(this.engine.renderer.getContext());
    this.environment = new Environment();
    this.environment.addTo(this.engine.scene);
    this.sky = new Sky(this.environment);
    this.engine.scene.add(this.sky.mesh);
    this.terrain = new Terrain(this.engine.renderer, this.environment);
    this.terrain.setQuality(this.settings.tier);
    this.engine.scene.add(this.terrain.group);
    this.mission = new Mission(this.engine.scene, new THREE.Vector3(0, 0, 0), 1);
    this.objective = this.mission.target;
    this.terrain.prime(this.objective.position);
    this.profileContext = this.profileName === 'takram-himalayan'
      ? deriveTakramProfileContext(this.scenario, this.objective.aimPoint.toArray())
      : null;
    resetScenarioClock(this.environment, this.scenario);
    const envMap = this.sky.bakeEnvironment(this.engine.renderer, this.environment);
    this.engine.scene.environment = envMap;
    if (this.engine.composer.stableDepthTexture == null) this.engine.composer.createDepthTexture();
    this._constructBackend();
    this.backend.setQuality(this.settings.tier);
    installComparisonEffects(this);
    configureDiagnosticDepth(this);
    setRuntimeSize(this, window.innerWidth, window.innerHeight);
    await Promise.all([this._prepareAtmosphere(), this._prepareStbn(), this._prepareCloudAssets()]);
    this._assertTakramReferenceAssetsAvailable();
    this.backend.resetHistory('context-restore-recreated');
    this.lifecycleAudit.markReset('context-restore-recreated');
    this.lifecycleAudit.completeMutation();
  }

  status() {
    return deepFreeze({
      phase: this.phase,
      backend: this.backendName,
      quality: this.quality,
      scenario: this.scenario.name,
      profile: this.profileName,
      view: this.view,
      compositionMode: this.backendName === 'takram'
        ? this.view === COMPOSITE_VIEW
          ? 'takram-atmosphere-composition'
          : 'takram-cloud-buffer-debug'
        : 'current-production-composer',
      terrainDepthBypassed: this.terrainDepthBypassed,
      frame: this.frame,
      running: this.running,
      disposed: this.disposed,
      fallback: this.backendName === 'takram' && this.backend.profile?.enabled === false
        ? 'takram-disabled-phone'
        : null,
      lightingMode: this.lightingMode,
      stbnMode: this.stbnMode ?? null,
      cloudAssetMode: this.cloudAssetMode,
    });
  }

  async _prepareAtmosphere() {
    if (this.atmosphereGenerator == null) return;
    if (this.atmosphereTextures != null) {
      this.backend._setEnvironment(this.atmosphereTextures);
      this.atmosphereComposition?.updateBindings();
      this.lightingMode = 'takram-precomputed-lut';
      return;
    }
    try {
      this.atmosphereTextures = await this.atmosphereGenerator.update();
      // Deliberately isolated harness seam: Task 1's public backend contract has
      // no atmosphere-texture setter because the shipping backend does not need
      // one. The selected Takram effect still receives real generated LUTs.
      this.backend._setEnvironment(this.atmosphereTextures);
      this.atmosphereComposition?.updateBindings();
      this.lightingMode = 'takram-precomputed-lut';
    } catch (error) {
      this.atmosphereError = error instanceof Error ? error.message : String(error);
      this.lightingMode = 'fallback-lighting';
      console.error('[cloud-comparison] Takram atmosphere LUT generation failed', error);
    }
  }

  async _prepareStbn() {
    if (!this.requiresEnabledTakram) return;
    if (this.stbnTexture == null) {
      try {
        this.stbnTexture = await loadOfficialStbnTexture();
        this.stbnMode = 'official-pinned';
      } catch (error) {
        this.stbnError = error instanceof Error ? error.message : String(error);
        this.stbnMode = 'fallback-unverified';
        console.error('[cloud-comparison] Official Takram STBN load failed', error);
        return;
      }
    }
    this.backend.setStbnTexture(this.stbnTexture);
    this.atmosphereComposition?.updateBindings();
  }

  async _prepareCloudAssets() {
    if (!this.requiresEnabledTakram) return;
    if (this.cloudAssets == null) {
      try {
        this.cloudAssets = await this._loadOfficialCloudAssets();
        this.cloudAssetMode = this.cloudAssets.mode;
      } catch (error) {
        this.cloudAssetError = error instanceof Error ? error.message : String(error);
        this.cloudAssetMode = 'unavailable';
        console.error('[cloud-comparison] Official Takram cloud asset load failed', error);
        return;
      }
    }
    this.backend.setCloudTextures(this.cloudAssets);
  }

  async _loadOfficialCloudAssets() {
    return loadOfficialTakramCloudAssets();
  }

  _assertTakramReferenceAssetsAvailable() {
    const eligibility = this._takramReferenceAssetEligibility();
    if (eligibility.eligible) return;
    const error = new Error(`Ineligible Takram reference: ${eligibility.reason}`);
    error.code = 'ineligible-reference';
    throw error;
  }

  _takramReferenceAssetEligibility() {
    return assessTakramReferenceAssetEligibility({
      backend: this.backendName,
      requiresEnabledTakram: this.requiresEnabledTakram,
      cloudAssetMode: this.cloudAssetMode,
    });
  }

  _publishIneligibleAssetResult(assetEligibility) {
    const reason = assetEligibility.reason ?? 'official-cloud-assets-unavailable';
    const cameraGeodeticAltitude = this.profileContext?.cameraAltitude
      ?? this.engine.camera.position.y;
    const rawMetrics = { status: 'UNVERIFIED', reason };
    const diagnosticMetadata = createCloudDiagnosticMetadata({
      backend: this.backendName,
      profileName: this.profileName,
      view: this.view,
      scenario: this.scenario,
      cloudProfile: this.backend.cloudProfile ?? null,
      cameraGeodeticAltitude,
      profileContext: this.profileContext,
      cloudAssetMode: this.cloudAssetMode,
      rawMetrics,
      terrainDepthBypassed: this.terrainDepthBypassed,
    });
    const ineligibleMetadata = {
      ...diagnosticMetadata,
      eligibility: {
        eligible: false,
        reason,
        reasons: [reason],
      },
    };
    this.runResult = deepFreeze({ ...createCloudComparisonResult({
      backend: this.backendName,
      versions: {
        three: '0.185.1',
        postprocessing: '6.39.4',
        ...(this.backendName === 'takram' ? {
          '@takram/three-clouds': '0.7.6',
          '@takram/three-atmosphere': '0.19.1',
          '@takram/three-geospatial': '0.9.1',
          '@takram/three-geospatial-effects': '0.6.4',
        } : {}),
      },
      scenario: this.scenario.name,
      viewport: {
        width: this.canvas.width,
        height: this.canvas.height,
        pixelRatio: this.engine.renderer.getPixelRatio?.() ?? null,
      },
      quality: this.quality,
      benchmark: unverifiedBenchmarkReport(),
      resources: { ...summarizeResourceReport({ resources: [] }), items: [] },
      objective: { status: 'UNVERIFIED', reason: 'ineligible-before-warmup' },
      temporal: { status: 'UNVERIFIED', reason: 'ineligible-before-warmup' },
      consoleIssues: this.consoleIssues ?? [],
      artifacts: [{
        kind: 'run-metadata',
        warmupFrames: this.scenario.warmupFrames,
        renderedFrames: 0,
        cloudAssetMode: this.cloudAssetMode,
        profile: this.profileName,
        view: this.view,
        compositionMode: diagnosticMetadata.compositionMode,
        terrainDepthMode: diagnosticMetadata.terrainDepthMode,
        captureKind: diagnosticMetadata.captureKind,
        inSceneMissionCapture: diagnosticMetadata.inSceneMissionCapture,
        rawCloudBuffer: rawMetrics,
        rawCloudCaptureEvidence: null,
        ineligibleBeforeWarmup: true,
        ineligibilityReason: reason,
        lifecycleAudits: structuredClone(this.lifecycleAudit?.reports ?? []),
      }],
    }),
    ...ineligibleMetadata,
    cloudBuffer: rawMetrics,
    cloudBufferEvidence: null,
    lifecycleAudits: structuredClone(this.lifecycleAudit?.reports ?? []),
    });
    this.phase = 'ineligible';
    if (typeof document !== 'undefined') publishComparisonResult(document, this.runResult);
    return this.runResult;
  }

  _captureFrozenCloudCompositeEvidence(rawReadback) {
    const clouds = this.backend.effect;
    const rawDebug = this.cloudBufferDebugEffect;
    if (clouds == null || rawDebug == null) {
      return {
        rawReadback,
        finalComposite: null,
        evidence: {
          sameOutputBufferIdentity: false,
          sameCloudFrame: false,
          diagnosticCloudUpdates: null,
          diagnosticRenders: 0,
        },
      };
    }
    let composition = null;
    return captureFrozenCloudCompositeEvidence({
      rawReadback,
      getCloudState: () => ({
        outputBuffer: clouds.cloudsPass.outputBuffer,
        cloudFrame: Number.isFinite(clouds.frame) ? clouds.frame : null,
      }),
      installCompositePass: () => {
        releaseDedicatedCloudPass(this.engine);
        composition = createTakramAtmosphereComposition({
          camera: this.engine.camera,
          scene: this.engine.scene,
          clouds,
          textures: { ...(this.atmosphereTextures ?? {}), stbnTexture: this.stbnTexture },
          renderer: this.engine.renderer,
        });
        installDedicatedCloudPass(this.engine, composition.aerialPerspective, {
          measure: render => render(),
        });
      },
      renderComposite: () => renderComparisonFrame(this, 0),
      captureComposite: () => captureFinalRgba8(this.engine.renderer),
      restoreRawPass: () => {
        releaseDedicatedCloudPass(this.engine);
        composition?.dispose();
        installDedicatedCloudPass(this.engine, rawDebug, this.benchmark);
        rawDebug.renderFrozenBufferOnce();
        renderComparisonFrame(this, 0);
        return 1;
      },
    });
  }

  async _replayTemporalStop({ freshReset, noCloud = false }) {
    const stopFrame = 175;
    const captures = [];
    const pass = this.engine.cloudComparisonPass;
    const previousEnabled = pass.enabled;
    if (noCloud) pass.enabled = false;
    resetScenarioClock(this.environment, this.scenario);
    this.backend.resetHistory(freshReset ? 'temporal-fresh-replay' : 'temporal-history-replay');
    try {
      for (let frame = 0; frame <= stopFrame + 1; frame += 1) {
        for (const item of this.scenario.events) {
          if (item.frame === frame && item.cameraCut) this.backend.resetHistory('camera-cut');
        }
        applyCamera(this, frame);
        if (freshReset && frame === stopFrame) this.backend.resetHistory('temporal-fresh-reference');
        renderComparisonFrame(this, this.scenario.fixedDeltaSeconds);
        if (frame === stopFrame || frame === stopFrame + 1) {
          captures.push(captureFinalRgba8(this.engine.renderer));
        }
        if (frame > 0 && frame % 30 === 0) await nextAnimationFrame();
      }
    } finally {
      pass.enabled = previousEnabled;
    }
    return { captures };
  }

  async _measureTemporalTrail() {
    if (this.scenario.name !== 'fast-motion-stop' || this.engine.cloudComparisonPass == null) {
      return { report: { status: 'UNVERIFIED', reason: 'not-temporal-scenario' }, artifacts: [] };
    }
    const history = await this._replayTemporalStop({ freshReset: false });
    const reference = await this._replayTemporalStop({ freshReset: true });
    const noCloud = await this._replayTemporalStop({ freshReset: true, noCloud: true });
    const { width, height } = history.captures[0];
    const masks = reference.captures.map((frame, index) => (
      deriveCloudMask(frame.pixels, noCloud.captures[index].pixels)
    ));
    const measured = computeTemporalTrail({
      historyFrames: history.captures.map(frame => frame.pixels),
      referenceFrames: reference.captures.map(frame => frame.pixels),
      cloudMasks: masks,
      width,
      height,
      dilationRadius: 2,
    });
    const cloudMaskCoverage = masks.map(mask => (
      mask.reduce((total, value) => total + (value > 0 ? 1 : 0), 0) / mask.length
    ));
    const artifacts = measured.heatmaps.map((heatmap, index) => ({
      kind: 'temporal-heatmap',
      name: `temporal-trail-frame-${index + 1}.png`,
      mimeType: 'image/png',
      dataUrl: heatmapDataUrl(heatmap, width, height),
    }));
    for (const [kind, frames] of [
      ['temporal-history-source', history.captures],
      ['temporal-fresh-reference', reference.captures],
    ]) {
      for (let index = 0; index < frames.length; index += 1) {
        artifacts.push({
          kind,
          name: `${kind}-frame-${index + 1}.png`,
          mimeType: 'image/png',
          dataUrl: rgbaDataUrl(frames[index]),
        });
      }
    }
    return {
      report: { status: measured.status, reason: measured.reason, frames: measured.frames,
        maskSource: 'fresh-reset-composite-minus-no-cloud', dilationRadius: 2,
        cloudMaskCoverage },
      artifacts,
    };
  }

  async startRun() {
    if (this.disposed) throw new Error('Cloud comparison harness is disposed');
    if (this.running) throw new Error('Cloud comparison run is already active');
    this.running = true;
    this.phase = 'preparing';
    this.frame = 0;
    this.runResult = null;
    this.historyResets.length = 0;
    this.contextEvents.length = 0;
    this.lifecycleAudit.reports.length = 0;
    this.benchmark.reset();
    // Keep up to one full nonblocking query queue of drain frames. No query
    // result is ever synchronously waited on.
    const minimumFrames = this.scenario.warmupFrames + this.benchmark.minimumSamples;
    const maximumFrames = this.scenario.warmupFrames + 600;
    let renderedFrames = 0;
    let previousFrameTime = performance.now();

    try {
      resetScenarioClock(this.environment, this.scenario);
      setRuntimeQuality(this, this.initialQuality);
      setRuntimeSize(this, window.innerWidth, window.innerHeight);
      await Promise.all([this._prepareAtmosphere(), this._prepareStbn(), this._prepareCloudAssets()]);
      const assetEligibility = this._takramReferenceAssetEligibility();
      if (!assetEligibility.eligible) return this._publishIneligibleAssetResult(assetEligibility);
      this.phase = 'warming';
      for (this.frame = 0; this.frame < maximumFrames; this.frame += 1) {
        for (const item of this.scenario.events) {
          if (item.frame === this.frame) applyComparisonEvent(this, item);
        }
        applyCamera(this, this.frame);
        if (this._contextRestorePromise) {
          const restorePromise = this._contextRestorePromise;
          try {
            await restorePromise;
          } catch (error) {
            const assetEligibility = this._takramReferenceAssetEligibility();
            this.lifecycleAudit?.abortMutation?.(
              !assetEligibility.eligible ? assetEligibility.reason : 'context-restore-failed',
            );
            if (error?.code === 'ineligible-reference' && !assetEligibility.eligible) {
              return this._publishIneligibleAssetResult(assetEligibility);
            }
            throw error;
          } finally {
            if (this._contextRestorePromise === restorePromise) this._contextRestorePromise = null;
          }
        }
        if (!this.contextLost) renderComparisonFrame(this, this.scenario.fixedDeltaSeconds);
        renderedFrames = this.frame + 1;
        if (this.frame === this.scenario.warmupFrames) this.phase = 'capturing';
        await nextAnimationFrame();
        const frameTime = performance.now();
        if (this.frame >= this.scenario.warmupFrames) {
          this.benchmark.recordFrameInterval(frameTime - previousFrameTime);
        }
        previousFrameTime = frameTime;
        if (renderedFrames >= minimumFrames && this.benchmark.complete) break;
      }
      const temporalEvidence = await this._measureTemporalTrail();
      // readPixels must run in the same task as the final post render because
      // preserveDrawingBuffer is intentionally disabled in production.
      renderComparisonFrame(this, 0);
      const rawReadback = this.view === COMPOSITE_VIEW
        ? null
        : readCloudOutputBuffer(this.engine.renderer, this.backend.effect);
      const frozenEvidence = this.view === COMPOSITE_VIEW
        ? null
        : this._captureFrozenCloudCompositeEvidence(rawReadback);
      const sameCloudState = frozenEvidence?.evidence.sameOutputBufferIdentity === true
        && frozenEvidence?.evidence.sameCloudFrame === true;
      const rawMetrics = this.view === COMPOSITE_VIEW
        ? { status: 'NOT_APPLICABLE', reason: 'composite-view' }
        : rawReadback?.status === 'MEASURED'
          ? measureCloudBufferPixels({
            pixels: rawReadback.pixels,
            width: rawReadback.width,
            height: rawReadback.height,
            finalCompositePixels: sameCloudState ? frozenEvidence.finalComposite?.pixels ?? null : null,
            finalCompositeWidth: sameCloudState ? frozenEvidence.finalComposite?.width ?? null : null,
            finalCompositeHeight: sameCloudState ? frozenEvidence.finalComposite?.height ?? null : null,
          })
          : rawReadback;
      const readability = sampleObjectiveReadability(this);
      const visualGate = assessVisualEligibility({
        backend: this.backendName,
        enabled: this.backendName === 'current' || this.backend.profile?.enabled === true,
        lightingMode: this.lightingMode,
        stbnMode: this.stbnMode,
        cloudAssetMode: this.cloudAssetMode,
      });
      const backendResources = this.backend.getResourceReport();
      const atmosphereResources = describeAtmosphereTextures(this.atmosphereTextures);
      const compositionResources = this.atmosphereComposition?.getResourceReport() ?? null;
      const cloudAssetResources = describeOfficialTakramCloudAssets(this.cloudAssets);
      const stbnResource = this.stbnTexture == null ? null : {
        name: 'official-stbn', kind: 'sampling-texture', source: DEFAULT_STBN_URL,
        width: 128, height: 128, depth: 64, channels: 1, bytesPerChannel: 1,
        payloadBytes: this.stbnTexture.image.data.byteLength, bytes: 128 * 128 * 64,
      };
      const resourceItems = combineOwnedResourceItems({
        backendResources: backendResources.resources ?? [],
        atmosphereResources: atmosphereResources?.resources ?? [],
        stbnResource,
      });
      resourceItems.push(...(cloudAssetResources?.resources ?? []));
      resourceItems.push(...(compositionResources?.resources ?? []));
      const cameraGeodeticAltitude = this.profileContext?.cameraAltitude
        ?? this.engine.camera.position.y;
      const diagnosticMetadata = createCloudDiagnosticMetadata({
        backend: this.backendName,
        profileName: this.profileName,
        view: this.view,
        scenario: this.scenario,
        cloudProfile: this.backend.cloudProfile ?? null,
        cameraGeodeticAltitude,
        profileContext: this.profileContext,
        cloudAssetMode: this.cloudAssetMode,
        rawMetrics,
        captureEvidence: frozenEvidence?.evidence ?? null,
        terrainDepthBypassed: this.terrainDepthBypassed,
      });
      this.runResult = deepFreeze({ ...createCloudComparisonResult({
        backend: this.backendName,
        versions: {
          three: '0.185.1',
          postprocessing: '6.39.4',
          ...(this.backendName === 'takram' ? {
            '@takram/three-clouds': '0.7.6',
            '@takram/three-atmosphere': '0.19.1',
            '@takram/three-geospatial': '0.9.1',
            '@takram/three-geospatial-effects': '0.6.4',
          } : {}),
        },
        scenario: this.scenario.name,
        viewport: {
          width: this.canvas.width,
          height: this.canvas.height,
          pixelRatio: this.engine.renderer.getPixelRatio(),
        },
        quality: this.quality,
        benchmark: this.benchmark.report(),
        resources: { ...summarizeResourceReport({ resources: resourceItems }), items: resourceItems },
        objective: { status: readability.onScreen ? 'MEASURED' : 'UNVERIFIED', ...readability },
        temporal: temporalEvidence.report,
        consoleIssues: this.consoleIssues,
        artifacts: [{
          kind: 'run-metadata',
          warmupFrames: this.scenario.warmupFrames,
          renderedFrames,
          fallback: this.backendName === 'takram' && this.backend.profile?.enabled === false
            ? 'takram-disabled-phone'
            : null,
          lightingMode: this.lightingMode,
          stbnMode: this.stbnMode ?? null,
          cloudAssetMode: this.cloudAssetMode,
          profile: this.profileName,
          view: this.view,
          compositionMode: diagnosticMetadata.compositionMode,
          terrainDepthMode: diagnosticMetadata.terrainDepthMode,
          captureKind: diagnosticMetadata.captureKind,
          inSceneMissionCapture: diagnosticMetadata.inSceneMissionCapture,
          rawCloudBuffer: rawMetrics,
          rawCloudCaptureEvidence: frozenEvidence?.evidence ?? null,
          cloudAssetSource: cloudAssetResources == null ? null : {
            payloadBytes: cloudAssetResources.payloadBytes,
            gpuBytes: cloudAssetResources.totalBytes,
            gpuOwnership: 'comparison-harness',
          },
          atmosphereComposition: compositionResources == null ? null : {
            owner: compositionResources.owner,
            gpuBytes: compositionResources.totalBytes,
            effectOrder: ['clouds', 'aerial-perspective'],
            normalPasses: this.atmosphereComposition.passes.length,
          },
          visualComparisonEligible: visualGate.eligible,
          visualEligibilityReason: visualGate.reason,
          historyResets: structuredClone(this.historyResets),
          contextEvents: structuredClone(this.contextEvents),
          lifecycleAudits: structuredClone(this.lifecycleAudit.reports),
          stbnSource: stbnResource == null ? null : {
            source: stbnResource.source,
            payloadBytes: stbnResource.payloadBytes,
            gpuOwnership: resourceItems.includes(stbnResource) ? 'comparison-harness' : 'backend',
          },
        }, ...temporalEvidence.artifacts],
      }),
      ...diagnosticMetadata,
      cloudBuffer: rawMetrics,
      cloudBufferEvidence: frozenEvidence?.evidence ?? null,
      });
      this.phase = 'complete';
      publishComparisonResult(document, this.runResult);
      return this.runResult;
    } catch (error) {
      this.phase = error?.code === 'ineligible-reference' ? 'ineligible' : 'error';
      throw error;
    } finally {
      this.running = false;
    }
  }

  result() {
    return this.runResult;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.running = false;
    this.phase = 'disposed';
    this.canvas.removeEventListener('webglcontextlost', this._onContextLost);
    this.canvas.removeEventListener('webglcontextrestored', this._onContextRestored);
    window.removeEventListener('error', this._onWindowError);
    window.removeEventListener('unhandledrejection', this._onUnhandledRejection);
    this._restoreConsole();
    releaseDedicatedCloudPass(this.engine);
    disposeComparisonEffects(this);
    this.lifecycleAudit.dispose();
    this.benchmark.dispose();
    this.backend.dispose();
    this.atmosphereGenerator?.dispose();
    disposeAtmosphereTextures(this.atmosphereTextures);
    this.stbnTexture?.dispose();
    disposeTakramCloudAssets(this.cloudAssets);
    this.mission.dispose();
    this.terrain.dispose();
    this.sky.dispose();
    this.environment.dispose();
    this.engine.dispose();
  }
}

function showFailure(message) {
  const element = document.getElementById('comparison-error');
  if (element) {
    element.hidden = false;
    element.textContent = message;
  }
}

async function bootComparisonPage() {
  const canvas = document.getElementById('comparison-viewport');
  if (!canvas) return;
  try {
    const query = parseComparisonQuery(window.location.search);
    document.title = `Safed Sagar Cloud Comparison — ${query.backend}`
      + `${query.profile == null ? '' : ` / ${query.profile}`}`
      + ` / ${query.view}`;
    const harness = new CloudComparisonHarness(canvas, query);
    window.addEventListener('pagehide', () => harness.dispose(), { once: true });
    if (import.meta.env.DEV) {
      window.__cloudComparison = Object.freeze({
        status: () => harness.status(),
        startRun: () => harness.startRun(),
        result: () => harness.result(),
        dispose: () => harness.dispose(),
      });
    }
    await harness.startRun();
  } catch (error) {
    console.error('[cloud-comparison]', error);
    showFailure(error instanceof Error ? error.message : String(error));
  }
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  void bootComparisonPage();
}
