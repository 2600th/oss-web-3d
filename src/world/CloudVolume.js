import * as THREE from 'three';
import { Effect, EffectAttribute } from 'postprocessing';
import { CLOUD_GLSL, CLOUD_CONSTANTS } from './clouds.glsl.js';

const FULLSCREEN_VERTEX = /* glsl */ `
out vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/** Integer sampling identity mirrored by stableBlueNoise in the march shader. */
export function cloudJitterKey(entryX, entryZ, pixelX, pixelY) {
  const worldX = Math.floor(entryX / 64);
  const worldZ = Math.floor(entryZ / 64);
  const screenX = ((Math.floor(pixelX) % 64) + 64) % 64;
  const screenY = ((Math.floor(pixelY) % 64) + 64) % 64;
  return `${worldX + screenX * 17}:${worldZ + screenY * 31}`;
}

/** Confidence-weighted current-frame contribution used by temporal resolve. */
export function cloudTemporalBlend(historyLuma, currentLuma, historyAlpha, currentAlpha, baseAlpha) {
  const delta = Math.abs(historyLuma - currentLuma) + Math.abs(historyAlpha - currentAlpha) * 0.35;
  const t0 = Math.max(0, Math.min(1, (delta - 0.045) / (0.32 - 0.045)));
  const confidenceLoss = t0 * t0 * (3 - 2 * t0);
  const stableWeight = baseAlpha * 0.34;
  const changedWeight = Math.min(0.72, baseAlpha * 2.4);
  return stableWeight + (changedWeight - stableWeight) * confidenceLoss;
}

/**
 * Depth-aware bilateral upscale and composite. The expensive cloud integration
 * happens in CloudVolume.update() at a reduced resolution; this Effect remains
 * the small Engine.setClouds-compatible compositor in the normal HDR chain.
 */
export const CLOUD_COMPOSITE_FRAGMENT = /* glsl */ `
uniform sampler2D uCloudTexture;
uniform sampler2D uCloudMetaTexture;
uniform vec2 uCloudTexelSize;
uniform float uCloudMaxDistance;
uniform float uRadianceRange;
uniform float uCloudWarmup;
uniform float uCloudStrength;

void mainImage(const in vec4 inputColor, const in vec2 uv, const in float depth, out vec4 outputColor) {
  vec2 lowSize = 1.0 / uCloudTexelSize;
  vec2 pixel = uv * lowSize - 0.5;
  vec2 base = floor(pixel);
  vec2 f = fract(pixel);
  vec4 cloud = vec4(0.0);
  float weightSum = 0.0;
  float currentDepthMetric = min(-getViewZ(depth) / uCloudMaxDistance, 1.0);

  // Four-tap depth-aware upscale. Samples across a terrain/cloud boundary are
  // rejected instead of bleeding the reduced-resolution cloud over a ridge.
  for (int y = 0; y < 2; y++) {
    for (int x = 0; x < 2; x++) {
      vec2 offset = vec2(float(x), float(y));
      vec2 sampleUv = (base + offset + 0.5) * uCloudTexelSize;
      vec4 meta = texture(uCloudMetaTexture, sampleUv);
      float bilinear = mix(1.0 - f.x, f.x, float(x)) * mix(1.0 - f.y, f.y, float(y));
      float relativeDepth = abs(meta.r - currentDepthMetric);
      float depthAware = (currentDepthMetric > 0.999 && meta.r > 0.999) ? 1.0 : exp(-relativeDepth * 80.0);
      float w = bilinear * depthAware * step(0.5, meta.a);
      cloud += texture(uCloudTexture, sampleUv) * w;
      weightSum += w;
    }
  }

  if (weightSum > 1e-4) cloud /= weightSum;
  else {
    // Checker bootstrap and a single disocclusion can leave all four bilinear
    // taps invalid. Search one texel farther, but only accept the same surface
    // depth class; this closes pinholes without pulling clouds across ridges.
    vec4 nearestValidCloud = vec4(0.0);
    float nearestScore = 1e9;
    for (int y = -1; y <= 2; y++) {
      for (int x = -1; x <= 2; x++) {
        vec2 offset = vec2(float(x), float(y));
        vec2 sampleUv = (base + offset + 0.5) * uCloudTexelSize;
        vec4 meta = texture(uCloudMetaTexture, sampleUv);
        float relativeDepth = abs(meta.r - currentDepthMetric);
        bool skyPair = currentDepthMetric > 0.999 && meta.r > 0.999;
        bool compatible = skyPair || relativeDepth < 0.018;
        float score = relativeDepth + length(offset - f) * 0.0004;
        if (meta.a > 0.5 && compatible && score < nearestScore) {
          nearestScore = score;
          nearestValidCloud = texture(uCloudTexture, sampleUv);
        }
      }
    }
    cloud = nearestScore < 1e8 ? nearestValidCloud : vec4(0.0);
  }
  cloud.rgb *= uRadianceRange;
  cloud *= uCloudWarmup * uCloudStrength;
  cloud = max(cloud, vec4(0.0));
  outputColor = vec4(inputColor.rgb * (1.0 - cloud.a) + cloud.rgb, inputColor.a);
}
`;

export const CLOUD_MARCH_FRAGMENT = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;

in vec2 vUv;
layout(location = 0) out vec4 cloudOutput;
layout(location = 1) out vec4 metaOutput;

uniform sampler2D uSceneDepth;
uniform sampler2D uHistoryCloud;
uniform sampler2D uHistoryMeta;
uniform mat4 uInvViewProj;
uniform mat4 uPrevViewProj;
uniform vec3 uCamPos;
uniform vec3 uCamForward;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uZenithColor;
uniform vec3 uHorizonColor;
uniform float uSunIntensity;
uniform float uCameraNear;
uniform float uCameraFar;
uniform float uMaxDistance;
uniform float uHistoryValid;
uniform float uDeltaTime;
uniform float uTemporalAlpha;
uniform int uSteps;
uniform int uLightSteps;
uniform int uCheckerPeriod;
uniform int uActiveSlot;
uniform float uRadianceRange;

${CLOUD_GLSL}

float depthToViewZ(float depth) {
  return (uCameraNear * uCameraFar) /
    ((uCameraFar - uCameraNear) * depth - uCameraFar);
}

float hg(float mu, float g) {
  float gg = g * g;
  float d = 1.0 + gg - 2.0 * g * mu;
  return (1.0 - gg) / (12.566370614 * max(d * sqrt(max(d, 1e-4)), 1e-4));
}

// A true dual-lobe direct phase: the strong positive lobe produces the silver
// rim and the small negative lobe keeps the anti-solar cloud body alive.
float dualLobePhase(float mu, float forwardG) {
  float forward = 12.566370614 * hg(mu, forwardG);
  float backward = 12.566370614 * hg(mu, -0.24);
  return mix(forward, backward, 0.18);
}

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

// A 64 m world cell keeps the integration phase stable across ordinary flight
// motion. Checker slots control which pixels update, not what random phase a
// pixel receives; changing the phase every slot was visible as crawling grain.
float stableBlueNoise(vec3 entryPoint) {
  vec2 worldCell = floor(entryPoint.xz * (1.0 / 64.0));
  vec2 pixelCell = mod(floor(gl_FragCoord.xy), 64.0);
  return hash12(worldCell + pixelCell * vec2(17.0, 31.0));
}

float temporalBlendWeight(vec4 historyCloud, vec4 currentCloud) {
  const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
  float delta = abs(dot(historyCloud.rgb - currentCloud.rgb, LUMA)) +
    abs(historyCloud.a - currentCloud.a) * 0.35;
  float confidenceLoss = smoothstep(0.045, 0.32, delta);
  return mix(uTemporalAlpha * 0.34, min(0.72, uTemporalAlpha * 2.4), confidenceLoss);
}

bool reconstructHistoryNeighbor(
  vec2 centerUv,
  float currentDepthMetric,
  float tNear,
  float tFar,
  out vec4 neighborCloud,
  out float neighborDistance
) {
  vec2 texel = 1.0 / vec2(textureSize(uHistoryMeta, 0));
  float bestScore = 1e9;
  neighborCloud = vec4(0.0);
  neighborDistance = max(tFar, 0.0);
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 uv = centerUv + vec2(float(x), float(y)) * texel;
      if (any(lessThan(uv, vec2(0.002))) || any(greaterThan(uv, vec2(0.998)))) continue;
      vec4 meta = texture(uHistoryMeta, uv);
      float depthDelta = abs(meta.r - currentDepthMetric);
      bool skyPair = currentDepthMetric > 0.999 && meta.r > 0.999;
      float intervalDelta = abs(meta.g - tNear / uMaxDistance);
      bool depthInside = meta.b >= tNear / uMaxDistance - 0.01 &&
        meta.b <= tFar / uMaxDistance + 0.01;
      float score = depthDelta + intervalDelta + length(vec2(float(x), float(y))) * 0.0006;
      if (meta.a > 0.5 && (skyPair || depthDelta < 0.012) && intervalDelta < 0.045 &&
          depthInside && score < bestScore) {
        bestScore = score;
        neighborCloud = texture(uHistoryCloud, uv);
        neighborCloud.rgb *= uRadianceRange;
        neighborDistance = meta.b * uMaxDistance;
      }
    }
  }
  return bestScore < 1e8;
}

float lightOpticalDepth(vec3 p) {
  float span = min((uCloudTop - p.y) / max(uSunDir.y, 0.05), 3200.0);
  if (span <= 0.0) return 0.0;
  float stepLength = span / float(uLightSteps);
  float optical = 0.0;
  vec3 coneX = normalize(cross(uSunDir, vec3(0.0, 1.0, 0.001)));
  vec3 coneY = cross(uSunDir, coneX);
  for (int i = 0; i < 6; i++) {
    if (i >= uLightSteps) break;
    float fi = float(i);
    float t = (fi + 0.5) * stepLength;
    vec2 spiral = vec2(fract(fi * 0.754877 + 0.31), fract(fi * 0.569840 + 0.73)) * 2.0 - 1.0;
    vec3 q = p + uSunDir * t + (coneX * spiral.x + coneY * spiral.y) * t * 0.035;
    optical += cloudDensityLod(q, 0.0) * stepLength;
  }
  return optical;
}

float multipleScattering(float opticalDepth, float mu) {
  float energy = 1.0;
  float extinction = 1.0;
  float g = 0.72;
  float sum = 0.0;
  for (int order = 0; order < 3; order++) {
    sum += energy * dualLobePhase(mu, g) * exp(-opticalDepth * extinction);
    energy *= 0.34;
    extinction *= 0.54;
    g *= 0.48;
  }
  return sum;
}

void slabIntersection(vec3 dir, float sceneDistance, out float tNear, out float tFar) {
  if (abs(dir.y) < 1e-5) {
    bool inside = uCamPos.y > uCloudBase && uCamPos.y < uCloudTop;
    tNear = 0.0;
    tFar = inside ? uMaxDistance : -1.0;
  } else {
    float bottom = (uCloudBase - uCamPos.y) / dir.y;
    float top = (uCloudTop - uCamPos.y) / dir.y;
    tNear = min(bottom, top);
    tFar = max(bottom, top);
  }
  tNear = max(tNear, 0.0);
  tFar = min(tFar, min(sceneDistance, uMaxDistance));
}

vec4 integrateCloud(vec3 dir, float tNear, float tFar, out float firstCloudDistance) {
  float span = tFar - tNear;
  float stepLength = span / float(uSteps);
  float jitter = stableBlueNoise(uCamPos + dir * tNear);
  float mu = dot(dir, uSunDir);
  float backPhase = 12.566370614 * hg(mu, -0.22);
  vec3 scattering = vec3(0.0);
  float transmittance = 1.0;
  firstCloudDistance = tFar;
  bool foundCloud = false;

  for (int i = 0; i < 96; i++) {
    if (i >= uSteps || transmittance < 0.012) break;
    float t = tNear + (float(i) + jitter) * stepLength;
    if (t > tFar) break;
    vec3 p = uCamPos + dir * t;
    float footprintFade = 1.0 - smoothstep(90.0, 520.0, stepLength);
    float distanceFade = 1.0 - smoothstep(9000.0, 30000.0, t);
    float detailAtDistance = uDetailLevel * footprintFade * distanceFade;
    float density = cloudDensityLod(p, detailAtDistance);
    if (density <= 0.0) continue;
    if (!foundCloud) {
      firstCloudDistance = t;
      foundCloud = true;
    }

    float opticalToSun = lightOpticalDepth(p);
    float direct = min(multipleScattering(opticalToSun, mu), 5.5);
    float powder = 1.0 - exp(-density * stepLength * 3.4);
    float powderBoost = 1.0 + powder * smoothstep(0.05, 0.92, mu) * 0.92;
    float h = clamp((p.y - uCloudBase) / (uCloudTop - uCloudBase), 0.0, 1.0);
    float crownLight = mix(0.15, 1.20, smoothstep(0.10, 0.82, h));
    vec3 skyFill = mix(uZenithColor * 0.16, uHorizonColor * 0.36, h * h);
    vec3 groundBounce = vec3(0.055, 0.080, 0.13) * (1.0 - h) * 0.20;
    vec3 luminance = uSunColor * uSunIntensity * direct * powderBoost * crownLight * 0.23 +
      (skyFill + groundBounce) * (0.36 + 0.10 * backPhase);

    float stepTransmittance = exp(-density * stepLength);
    scattering += transmittance * luminance * (1.0 - stepTransmittance);
    transmittance *= stepTransmittance;
  }

  float distanceAtCloud = mix(tNear, tFar, 0.45);
  float horizonFade = 1.0 - smoothstep(uMaxDistance * 0.72, uMaxDistance, distanceAtCloud);
  return vec4(scattering * horizonFade, (1.0 - transmittance) * horizonFade);
}

void main() {
  float sceneDepth = texture(uSceneDepth, vUv).r;
  vec4 farPoint = uInvViewProj * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
  vec3 dir = normalize(farPoint.xyz / farPoint.w - uCamPos);
  float sceneDistance = uMaxDistance;
  if (sceneDepth < 0.999999) {
    float viewZ = -depthToViewZ(sceneDepth);
    sceneDistance = viewZ / max(dot(dir, uCamForward), 1e-3);
  }

  float tNear;
  float tFar;
  slabIntersection(dir, sceneDistance, tNear, tFar);

  vec4 seedMeta = texture(uHistoryMeta, vUv);
  float defaultDistance = max(tNear + (tFar - tNear) * 0.42, 0.0);
  float seedDistance = seedMeta.a > 0.5
    ? clamp(seedMeta.b * uMaxDistance, max(tNear, 0.0), max(tFar, 0.0))
    : defaultDistance;
  vec3 historyPoint = uCamPos + dir * seedDistance;
  historyPoint += vec3(uCloudWind.x, 0.0, uCloudWind.y) * uDeltaTime;
  vec4 previousClip = uPrevViewProj * vec4(historyPoint, 1.0);
  vec2 previousUv = previousClip.xy / max(previousClip.w, 1e-5) * 0.5 + 0.5;
  bool inHistory = all(greaterThan(previousUv, vec2(0.002))) && all(lessThan(previousUv, vec2(0.998)));
  vec4 historyMeta = texture(uHistoryMeta, previousUv);
  vec4 historyCloud = texture(uHistoryCloud, previousUv);
  historyCloud.rgb *= uRadianceRange;
  float currentDepthMetric = min(-depthToViewZ(sceneDepth) / uMaxDistance, 1.0);
  float depthDelta = abs(currentDepthMetric - historyMeta.r);
  bool skyPair = currentDepthMetric > 0.999 && historyMeta.r > 0.999;
  bool intervalMatch = abs(historyMeta.g - tNear / uMaxDistance) < 0.045;
  bool cloudDepthMatch = historyMeta.b >= tNear / uMaxDistance - 0.01 &&
    historyMeta.b <= tFar / uMaxDistance + 0.01;
  bool historyOk = uHistoryValid > 0.5 && inHistory && historyMeta.a > 0.5 &&
    (skyPair || depthDelta < 0.012) && intervalMatch && cloudDepthMatch && previousClip.w > 0.0;

  ivec2 cell = ivec2(gl_FragCoord.xy);
  int checkerSlot = (cell.x % uCheckerPeriod) + (cell.y % uCheckerPeriod) * uCheckerPeriod;
  bool isActiveSample = checkerSlot == uActiveSlot;

  if (!isActiveSample) {
    // A rejected inactive cell stays empty and invalid until its checker slot
    // runs. This keeps bootstrap bounded without laundering stale screen-space
    // radiance into valid history.
    vec4 neighborCloud;
    float neighborDistance;
    bool neighborOk = uHistoryValid > 0.5 && inHistory &&
      reconstructHistoryNeighbor(
        previousUv,
        currentDepthMetric,
        tNear,
        tFar,
        neighborCloud,
        neighborDistance
      );
    if (historyOk) {
      cloudOutput = vec4(historyCloud.rgb / uRadianceRange, historyCloud.a);
      metaOutput = vec4(currentDepthMetric, tNear / uMaxDistance, seedDistance / uMaxDistance, 1.0);
    } else if (neighborOk) {
      cloudOutput = vec4(neighborCloud.rgb / uRadianceRange, neighborCloud.a);
      metaOutput = vec4(currentDepthMetric, tNear / uMaxDistance, neighborDistance / uMaxDistance, 1.0);
    } else {
      cloudOutput = vec4(0.0);
      metaOutput = vec4(currentDepthMetric, tNear / uMaxDistance, 0.0, 0.0);
    }
    return;
  }

  float firstCloudDistance = max(tFar, 0.0);
  vec4 currentCloud = tFar > tNear
    ? integrateCloud(dir, tNear, tFar, firstCloudDistance)
    : vec4(0.0);
  if (historyOk) currentCloud = mix(historyCloud, currentCloud, temporalBlendWeight(historyCloud, currentCloud));
  cloudOutput = vec4(currentCloud.rgb / uRadianceRange, currentCloud.a);
  metaOutput = vec4(currentDepthMetric, tNear / uMaxDistance, firstCloudDistance / uMaxDistance, 1.0);
}
`;

const SHADOW_FRAGMENT = /* glsl */ `
precision highp float;
precision highp int;
in vec2 vUv;
out vec4 fragColor;
uniform vec2 uShadowCenter;
uniform float uShadowExtent;
uniform vec3 uSunDir;
${CLOUD_GLSL}

void main() {
  vec2 xz = uShadowCenter + (vUv - 0.5) * uShadowExtent;
  float stepLength = (uCloudTop - uCloudBase) / 8.0;
  float optical = 0.0;
  for (int i = 0; i < 8; i++) {
    float y = uCloudBase + (float(i) + 0.5) * stepLength;
    vec2 sunOffset = uSunDir.xz / max(uSunDir.y, 0.05) * (y - uCloudBase);
    optical += cloudDensityLod(vec3(xz + sunOffset, y), uDetailLevel) * stepLength;
  }
  float transmittance = 0.22 + 0.78 * exp(-optical * 1.35);
  fragColor = vec4(vec3(transmittance), 1.0);
}
`;

function makeTemporalTarget(type = THREE.UnsignedByteType) {
  const target = new THREE.WebGLRenderTarget(1, 1, {
    count: 2,
    type,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
    stencilBuffer: false,
  });
  target.textures[0].name = 'Cloud radiance history';
  target.textures[1].name = 'Cloud depth metadata';
  target.textures[0].generateMipmaps = false;
  target.textures[1].generateMipmaps = false;
  return target;
}

export class CloudVolume extends Effect {
  constructor(environment, camera) {
    const effectUniforms = new Map([
      ['uCloudTexture', { value: null }],
      ['uCloudMetaTexture', { value: null }],
      ['uCloudTexelSize', { value: new THREE.Vector2(1, 1) }],
      ['uCloudMaxDistance', { value: 46000 }],
      ['uCloudWarmup', { value: 0 }],
      ['uCloudStrength', { value: 1 }],
    ]);
    effectUniforms.set('uRadianceRange', { value: 8 });
    super('CloudVolume', CLOUD_COMPOSITE_FRAGMENT, {
      attributes: EffectAttribute.DEPTH,
      uniforms: effectUniforms,
    });

    this.environment = environment;
    this.camera = camera;
    this._depthTexture = null;
    this._width = 1;
    this._height = 1;
    this._resolutionScale = 0.5;
    this._frame = 0;
    this._writeIndex = 0;
    this._historyValid = false;
    this._historyFrames = 0;
    this._shadowStripe = 0;
    this._shadowCenterStep = 2048;

    this._invProjection = new THREE.Matrix4();
    this._currentViewProj = new THREE.Matrix4();
    this._previousViewProj = new THREE.Matrix4();
    this._previousCameraPosition = new THREE.Vector3();
    this._previousCameraQuaternion = new THREE.Quaternion();
    this._savedClearColor = new THREE.Color();

    const shared = {
      uCloudBase: { value: CLOUD_CONSTANTS.BASE },
      uCloudTop: { value: CLOUD_CONSTANTS.TOP },
      uCloudCoverage: { value: CLOUD_CONSTANTS.COVERAGE_SCALE },
      uCloudDensity: { value: CLOUD_CONSTANTS.DENSITY },
      uCloudWind: { value: new THREE.Vector2(1, 0) },
      uCloudTime: { value: 0 },
      uDetailLevel: { value: 1 },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    };
    this._sharedUniforms = shared;

    this._marchUniforms = {
      ...shared,
      uSceneDepth: { value: null },
      uHistoryCloud: { value: null },
      uHistoryMeta: { value: null },
      uInvViewProj: { value: new THREE.Matrix4() },
      uPrevViewProj: { value: new THREE.Matrix4() },
      uCamPos: { value: new THREE.Vector3() },
      uCamForward: { value: new THREE.Vector3(0, 0, -1) },
      uSunColor: { value: new THREE.Color(1, 1, 1) },
      uZenithColor: { value: new THREE.Color(0.03, 0.09, 0.3) },
      uHorizonColor: { value: new THREE.Color(0.56, 0.68, 0.85) },
      uSunIntensity: { value: 1.5 },
      uCameraNear: { value: camera.near },
      uCameraFar: { value: camera.far },
      uMaxDistance: { value: 46000 },
      uHistoryValid: { value: 0 },
      uDeltaTime: { value: 0 },
      uTemporalAlpha: { value: 0.28 },
      uSteps: { value: 48 },
      uLightSteps: { value: 5 },
      uCheckerPeriod: { value: 2 },
      uActiveSlot: { value: 0 },
      uRadianceRange: { value: 8 },
    };

    this._marchMaterial = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: FULLSCREEN_VERTEX,
      fragmentShader: CLOUD_MARCH_FRAGMENT,
      uniforms: this._marchUniforms,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    this._shadowMaterial = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: FULLSCREEN_VERTEX,
      fragmentShader: SHADOW_FRAGMENT,
      uniforms: {
        ...shared,
        uShadowCenter: { value: new THREE.Vector2() },
        uShadowExtent: { value: 48000 },
      },
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });

    this._fullscreenGeometry = new THREE.PlaneGeometry(2, 2);
    this._fullscreenScene = new THREE.Scene();
    this._fullscreenCamera = new THREE.Camera();
    this._fullscreenMesh = new THREE.Mesh(this._fullscreenGeometry, this._marchMaterial);
    this._fullscreenMesh.frustumCulled = false;
    this._fullscreenScene.add(this._fullscreenMesh);

    this._temporalTargets = [makeTemporalTarget(), makeTemporalTarget()];
    this._shadowTarget = new THREE.WebGLRenderTarget(256, 256, {
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
    });
    this._shadowTarget.texture.name = 'Live cloud transmittance';
    this._shadowTarget.texture.generateMipmaps = false;

    this.shadowContract = {
      texture: this._shadowTarget.texture,
      center: this._shadowMaterial.uniforms.uShadowCenter.value,
      extent: this._shadowMaterial.uniforms.uShadowExtent.value,
      glsl: CLOUD_GLSL,
      version: 0,
    };
  }

  getShadowContract() {
    return this.shadowContract;
  }

  initialize(renderer) {
    const halfFloat = Boolean(renderer?.extensions?.has?.('EXT_color_buffer_float'));
    const type = halfFloat ? THREE.HalfFloatType : THREE.UnsignedByteType;
    const radianceRange = halfFloat ? 1 : 8;

    for (const target of this._temporalTargets) target.dispose();
    this._temporalTargets = [makeTemporalTarget(type), makeTemporalTarget(type)];
    this._marchUniforms.uRadianceRange.value = radianceRange;
    this.uniforms.get('uRadianceRange').value = radianceRange;
    this._writeIndex = 0;
    this._historyValid = false;
    this._historyFrames = 0;
    this.uniforms.get('uCloudWarmup').value = 0;
    this.setSize(this._width, this._height);
  }

  setDepthTexture(depthTexture) {
    if (this._depthTexture !== depthTexture) {
      this._historyValid = false;
      this._historyFrames = 0;
      this.uniforms.get('uCloudWarmup').value = 0;
    }
    this._depthTexture = depthTexture;
    this._marchUniforms.uSceneDepth.value = depthTexture;
  }

  setQuality(tier) {
    const name = tier.name ?? 'high';
    const quality = {
      phone: { scale: 0.20, steps: 12, light: 2, detail: 0.15, checker: 3, temporal: 0.42, strength: 0.22 },
      low: { scale: 0.30, steps: 18, light: 2, detail: 0.28, checker: 2, temporal: 0.30, strength: 0.42 },
      medium: { scale: 0.33, steps: 30, light: 3, detail: 0.64, checker: 2, temporal: 0.29, strength: 0.78 },
      high: { scale: 0.40, steps: 38, light: 4, detail: 0.9, checker: 2, temporal: 0.24, strength: 1 },
    }[name] ?? { scale: 0.40, steps: 38, light: 4, detail: 0.9, checker: 2, temporal: 0.24, strength: 1 };

    this._resolutionScale = quality.scale;
    this._marchUniforms.uSteps.value = Math.min(tier.cloudSteps ?? quality.steps, quality.steps);
    this._marchUniforms.uLightSteps.value = Math.min(tier.cloudLightSteps ?? quality.light, quality.light);
    this._marchUniforms.uMaxDistance.value = tier.cloudDistance ?? 46000;
    this.uniforms.get('uCloudMaxDistance').value = this._marchUniforms.uMaxDistance.value;
    this._marchUniforms.uCheckerPeriod.value = quality.checker;
    this._marchUniforms.uTemporalAlpha.value = quality.temporal;
    this._sharedUniforms.uDetailLevel.value = quality.detail;
    this.uniforms.get('uCloudStrength').value = quality.strength;
    this._historyValid = false;
    this._historyFrames = 0;
    this.uniforms.get('uCloudWarmup').value = 0;
    this.setSize(this._width, this._height);
  }

  setSize(width, height) {
    this._width = Math.max(1, width);
    this._height = Math.max(1, height);
    const lowWidth = Math.max(1, Math.ceil(this._width * this._resolutionScale));
    const lowHeight = Math.max(1, Math.ceil(this._height * this._resolutionScale));
    for (const target of this._temporalTargets) target.setSize(lowWidth, lowHeight);
    this.uniforms.get('uCloudTexelSize').value.set(1 / lowWidth, 1 / lowHeight);
    this._historyValid = false;
    this._historyFrames = 0;
    this.uniforms.get('uCloudWarmup').value = 0;
  }

  _syncEnvironment(dt) {
    const env = this.environment.uniforms;
    const shared = this._sharedUniforms;
    // Publish the tested route-height volume back through Environment so the
    // visible march, terrain shadows and live shadow map use the same ceiling.
    if (env.uCloudTop) env.uCloudTop.value = Math.max(env.uCloudTop.value, CLOUD_CONSTANTS.TOP);
    // Three to four kilometres of volume at the old 0.0032 extinction became
    // an opaque grey wall even at moderate coverage. Dense cores still reach
    // several optical depths here, while bank shoulders transmit terrain/sky.
    if (env.uCloudDensity) env.uCloudDensity.value = Math.min(env.uCloudDensity.value, 0.00155);
    shared.uCloudTime.value = env.uCloudTime?.value ?? (shared.uCloudTime.value + dt);
    shared.uCloudBase.value = env.uCloudBase?.value ?? CLOUD_CONSTANTS.BASE;
    shared.uCloudTop.value = env.uCloudTop?.value ?? CLOUD_CONSTANTS.TOP;
    shared.uCloudCoverage.value = env.uCloudCoverage?.value ?? CLOUD_CONSTANTS.COVERAGE_SCALE;
    shared.uCloudDensity.value = env.uCloudDensity?.value ?? CLOUD_CONSTANTS.DENSITY;
    shared.uCloudWind.value.copy(env.uCloudWind.value);
    shared.uSunDir.value.copy(env.uSunDir.value);

    this._marchUniforms.uSunColor.value.copy(env.uSunColor.value);
    this._marchUniforms.uSunIntensity.value = env.uSunIntensity.value;
    this._marchUniforms.uZenithColor.value.copy(env.uZenithColor.value);
    this._marchUniforms.uHorizonColor.value.copy(env.uHorizonColor.value);
  }

  _updateCamera(dt) {
    const camera = this.camera;
    camera.updateMatrixWorld();
    this._invProjection.copy(camera.projectionMatrix).invert();
    this._marchUniforms.uInvViewProj.value.multiplyMatrices(camera.matrixWorld, this._invProjection);
    this._currentViewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this._marchUniforms.uPrevViewProj.value.copy(this._previousViewProj);
    this._marchUniforms.uCamPos.value.copy(camera.position);
    camera.getWorldDirection(this._marchUniforms.uCamForward.value);
    this._marchUniforms.uCameraNear.value = camera.near;
    this._marchUniforms.uCameraFar.value = camera.far;
    this._marchUniforms.uDeltaTime.value = Math.min(Math.max(dt, 0), 0.1);

    if (this._historyValid) {
      const moved = camera.position.distanceToSquared(this._previousCameraPosition) > 1800 * 1800;
      const rotated = Math.abs(camera.quaternion.dot(this._previousCameraQuaternion)) < 0.965;
      if (moved || rotated) {
        this._historyValid = false;
        this._historyFrames = 0;
        this.uniforms.get('uCloudWarmup').value = 0;
      }
    }
    this._marchUniforms.uHistoryValid.value = this._historyValid ? 1 : 0;
  }

  _updateShadowCenter() {
    const center = this.shadowContract.center;
    const x = Math.floor(this.camera.position.x / this._shadowCenterStep) * this._shadowCenterStep;
    const y = Math.floor(this.camera.position.z / this._shadowCenterStep) * this._shadowCenterStep;
    if (center.x !== x || center.y !== y) {
      center.set(x, y);
      this._shadowStripe = 0;
      return true;
    }
    return false;
  }

  update(renderer, inputBuffer, dt = 0) {
    if (!this._depthTexture) return;
    this._syncEnvironment(dt);
    this._updateCamera(dt);

    const writeTarget = this._temporalTargets[this._writeIndex];
    const historyTarget = this._temporalTargets[1 - this._writeIndex];
    this._marchUniforms.uHistoryCloud.value = historyTarget.textures[0];
    this._marchUniforms.uHistoryMeta.value = historyTarget.textures[1];
    const period = this._marchUniforms.uCheckerPeriod.value;
    this._marchUniforms.uActiveSlot.value = this._frame % (period * period);

    const previousTarget = renderer.getRenderTarget();
    const previousAutoClear = renderer.autoClear;
    const previousXr = renderer.xr.enabled;
    const previousMaterial = this._fullscreenMesh.material;
    const previousShadowScissorTest = this._shadowTarget.scissorTest;
    renderer.getClearColor(this._savedClearColor);
    const previousClearAlpha = renderer.getClearAlpha();

    try {
      renderer.xr.enabled = false;
      renderer.autoClear = true;
      renderer.setRenderTarget(writeTarget);
      this._fullscreenMesh.material = this._marchMaterial;
      renderer.render(this._fullscreenScene, this._fullscreenCamera);

      const shadowMoved = this._updateShadowCenter();
      this._shadowTarget.scissorTest = false;
      renderer.setRenderTarget(this._shadowTarget);
      if (shadowMoved || this.shadowContract.version === 0) {
        renderer.setClearColor(0xffffff, 1);
        renderer.clear(true, false, false);
      }
      const stripeHeight = this._shadowTarget.height / 8;
      renderer.autoClear = false;
      this._shadowTarget.scissor.set(
        0,
        this._shadowStripe * stripeHeight,
        this._shadowTarget.width,
        stripeHeight,
      );
      this._shadowTarget.scissorTest = true;
      // Rebinding applies this target's viewport/scissor; the finally block
      // rebinds the exact prior target, restoring its framebuffer state.
      renderer.setRenderTarget(this._shadowTarget);
      this._fullscreenMesh.material = this._shadowMaterial;
      renderer.render(this._fullscreenScene, this._fullscreenCamera);
    } finally {
      this._shadowTarget.scissorTest = previousShadowScissorTest;
      this._fullscreenMesh.material = previousMaterial;
      renderer.setRenderTarget(previousTarget);
      renderer.setClearColor(this._savedClearColor, previousClearAlpha);
      renderer.autoClear = previousAutoClear;
      renderer.xr.enabled = previousXr;
    }

    this.uniforms.get('uCloudTexture').value = writeTarget.textures[0];
    this.uniforms.get('uCloudMetaTexture').value = writeTarget.textures[1];
    this._previousViewProj.copy(this._currentViewProj);
    this._previousCameraPosition.copy(this.camera.position);
    this._previousCameraQuaternion.copy(this.camera.quaternion);
    this._historyValid = true;
    this._historyFrames += 1;
    const warmupFrames = period * period + 2;
    this.uniforms.get('uCloudWarmup').value = Math.min(1, this._historyFrames / warmupFrames);
    this._writeIndex = 1 - this._writeIndex;
    this._frame = (this._frame + 1) % 256;
    this._shadowStripe = (this._shadowStripe + 1) % 8;
    this.shadowContract.version += 1;
  }

  dispose() {
    for (const target of this._temporalTargets) target.dispose();
    this._shadowTarget.dispose();
    this._marchMaterial.dispose();
    this._shadowMaterial.dispose();
    this._fullscreenGeometry.dispose();
  }
}
