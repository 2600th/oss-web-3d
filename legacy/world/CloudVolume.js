import * as THREE from 'three';
import { Effect, EffectAttribute } from 'postprocessing';
import { CLOUD_GLSL, CLOUD_CONSTANTS } from './clouds.glsl.js';
import { CloudNoise } from './CloudNoise.js';

/**
 * Extinction ceiling, per metre, applied to the shared Environment value.
 *
 * This was 0.00155, set to stop the deck becoming "an opaque grey wall". It
 * overshot badly: measured by rendering the frame twice and differencing it,
 * the clouds changed **0.03% of pixels** at cruise, and it took a 20x
 * composite gain before they covered the frame at all. A cloud that thin over
 * a bright snowfield is exactly the pale grey haze the deck was reported as —
 * the wall was never fixed, it was faded out until it stopped being visible.
 *
 * The wall is a *contrast* problem, not a density one, and it belongs to
 * coverage: cloudCoverage already carves genuine clear windows between banks
 * with its weather-front threshold. So the extinction is free to be what real
 * cumulus is, and the banks are free to be solid.
 */
const CLOUD_EXTINCTION = 0.0075;

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
uniform float uStepAngle;
uniform float uStepMin;
uniform float uStepMax;
uniform float uMarchRange;
uniform float uDirectScale;
uniform float uAmbientScale;

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
  float backward = 12.566370614 * hg(mu, -0.35);
  return mix(forward, backward, 0.22);
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

/**
 * Optical depth from a sample point toward the sun.
 *
 * Steps grow geometrically. A uniform light march spends as much of its budget
 * two kilometres away, where the cloud it is shadowing against is a different
 * cloud, as it does in the first two hundred metres that actually carve the
 * lit rim. The cone jitter widens with distance for the same reason: it is a
 * cheap stand-in for the solid angle of the sun plus forward scattering.
 *
 * The budget is passed in rather than read from the uniform because the caller
 * knows something this function cannot: how much the sample it is lighting can
 * still contribute. See the call site.
 *
 * Reach is held fixed as the budget falls. Simply running fewer steps would
 * shorten the march, which reports less cloud between the sample and the sun
 * and lights the deck up from the inside — a brightening artifact, not a
 * cheaper version of the same image. Solving the geometric sum for the first
 * step keeps the total distance covered the same at every budget.
 */
float lightOpticalDepth(vec3 p, float detail, int budget) {
  float span = min((uCloudTop - p.y) / max(uSunDir.y, 0.15), 2600.0);
  if (span <= 0.0) return 0.0;
  vec3 coneX = normalize(cross(uSunDir, vec3(0.0, 1.0, 0.001)));
  vec3 coneY = cross(uSunDir, coneX);
  float optical = 0.0;
  float t = 0.0;
  // 12.02 is the geometric sum at the full five steps, which is the reach the
  // lighting was tuned against; 0.13 is the first step that produced it.
  float reach = (pow(1.45, float(budget)) - 1.0) / 0.45;
  float stepLength = span * 0.13 * (12.02 / max(reach, 1e-3));
  for (int i = 0; i < 6; i++) {
    if (i >= budget || t >= span) break;
    float fi = float(i);
    vec2 spiral = vec2(fract(fi * 0.754877 + 0.31), fract(fi * 0.569840 + 0.73)) * 2.0 - 1.0;
    vec3 q = p + uSunDir * (t + stepLength * 0.5) +
      (coneX * spiral.x + coneY * spiral.y) * t * 0.06;
    // The light march's own stride band-limits it, and it is a coarse one by
    // design — a shadow gathered toward the sun has no business resolving
    // filigree the primary march can barely carry.
    optical += cloudDensityStride(q, detail, stepLength) * stepLength;
    t += stepLength;
    stepLength *= 1.45;
  }
  return optical;
}

/**
 * Multiple scattering as a sum of attenuated octaves.
 *
 * Each successive order sees less extinction, carries less energy and has a
 * flatter phase function, which is what keeps a thick cloud from going black
 * in its own shadow. Without it Beer's law alone makes every base opaque
 * charcoal, which is most of why these clouds read as grey fog.
 */
vec3 multipleScattering(float opticalDepth, float mu) {
  float energy = 1.0;
  float extinction = 1.0;
  float eccentricity = 1.0;
  float sum = 0.0;
  for (int order = 0; order < 3; order++) {
    sum += energy * dualLobePhase(mu, 0.80 * eccentricity) * exp(-opticalDepth * extinction);
    energy *= 0.42;
    extinction *= 0.55;
    eccentricity *= 0.60;
  }
  return vec3(sum);
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

/**
 * Raymarch the cloud slab.
 *
 * The step schedule is the reason this used to look like fog. A uniform
 * span/uSteps is fine when the slab is crossed steeply, but along the horizon
 * the span reaches the full 46 km draw distance, so 38 uniform steps meant a
 * **1.2 km stride** — wider than the clouds being sampled. Adjacent pixels then
 * hit and missed different banks, which is exactly the vertical curtain
 * striping in the frame, and the footprint fade correctly concluded that no
 * detail octave could survive such a stride and switched erosion off entirely,
 * which is why the result had no billows and no silhouette.
 *
 * Steps are now proportional to distance, so every step covers roughly the same
 * screen-space footprint, with a floor derived from the span so a steep
 * crossing still gets fine samples and a shallow one still terminates. Inside a
 * cloud the step shortens again: the lit rim is a few tens of metres thick and
 * it is the whole reason a cloud reads as solid.
 */
vec4 integrateCloud(vec3 dir, float tNear, float tFar, out float firstCloudDistance) {
  float marchFar = min(tFar, tNear + uMarchRange);
  float jitter = stableBlueNoise(uCamPos + dir * tNear);
  float mu = dot(dir, uSunDir);
  vec3 scattering = vec3(0.0);
  float transmittance = 1.0;
  firstCloudDistance = tFar;
  bool foundCloud = false;

  // Search wide, refine where it matters.
  //
  // SEARCH_GROWTH makes the empty-space stride grow faster than the sampling
  // stride, so a ray crosses twenty kilometres of clear air in a few dozen
  // strides and still has budget left for the cloud it finds. REFINE_RATIO is
  // the fraction of that stride used once inside, and BACKUP is how far the
  // march rewinds on a hit so the lit rim is not stepped over — half a stride,
  // because a full one wastes refine steps re-crossing air already known empty.
  const float SEARCH_GROWTH = 1.9;
  const float REFINE_RATIO = 0.22;
  const float BACKUP = 0.5;
  const int CLEAR_RUN_EXIT = 6;

  float t = tNear + clamp(tNear * uStepAngle * SEARCH_GROWTH, uStepMin, uStepMax) * jitter;
  bool refining = false;
  int clearRun = 0;

  for (int i = 0; i < 224; i++) {
    if (i >= uSteps || transmittance < 0.015 || t >= marchFar) break;
    float search = clamp(t * uStepAngle * SEARCH_GROWTH, uStepMin, uStepMax);
    float stepLength = search * REFINE_RATIO;
    vec3 p = uCamPos + dir * t;

    if (!refining) {
      // Coarse pass: low-frequency density only. Erosion cannot change whether
      // a point is inside a cloud, only where its boundary sits, so paying for
      // it while hunting is pure waste.
      if (cloudDensityLod(p, 0.0) > 0.0) {
        refining = true;
        clearRun = 0;
        t = max(t - search * BACKUP, tNear);
      } else {
        t += search;
      }
      continue;
    }

    // The stride goes to the density function, which drops each erosion octave
    // before that stride can alias it. The old code passed a single scalar
    // faded by stride, which cannot band-limit three octaves of very different
    // sizes: at the 197 m stride the previous schedule produced near the camera
    // it still asked for 89% detail, and the finest octave is 151 m across.
    // That is where the flicker came from.
    float density = cloudDensityStride(p, uDetailLevel, stepLength);
    // Feather the far end of the march instead of cutting it, or the deck ends
    // on a hard arc at exactly uMarchRange.
    density *= 1.0 - smoothstep(uMarchRange * 0.72, uMarchRange, t - tNear);

    if (density > 0.0) {
      clearRun = 0;
      if (!foundCloud) {
        firstCloudDistance = t;
        foundCloud = true;
      }

      // The sun march is the most expensive thing in this loop by a wide
      // margin — measured at roughly nine per cent of the whole frame per step
      // when the camera is low in a valley and every march step is inside
      // cloud. Deep in the deck it is also the most wasteful: this sample's
      // contribution is already multiplied by the transmittance in front of it,
      // and so is any error in its lighting, so a sample that can add three per
      // cent of the final colour does not need the same five-step shadow march
      // as the lit rim. The budget follows transmittance down to a floor of two
      // steps, which is enough to keep a gradient rather than a flat fill.
      int lightBudget = max(2, int(ceil(float(uLightSteps) * (0.35 + 0.65 * transmittance))));
      float opticalToSun = lightOpticalDepth(p, uDetailLevel * 0.4, lightBudget);
      vec3 direct = min(multipleScattering(opticalToSun, mu), vec3(6.0));
      // Beer-powder. The darkening at a cloud's edge when the sun is behind the
      // viewer is a real effect and it is what stops a lit face reading flat.
      float powder = 1.0 - exp(-density * stepLength * 3.4);
      float powderBoost = 1.0 + powder * smoothstep(0.05, 0.92, mu) * 0.92;

      float h = clamp((p.y - uCloudBase) / max(uCloudTop - uCloudBase, 1.0), 0.0, 1.0);
      // Sky and ground fill. A cloud droplet's single-scatter albedo is about
      // 0.98, so an unlit base is not charcoal, it is a dimmer white — and over
      // a snowfield the bounce from below is strong enough to see. The old term
      // used 16-36% of the sky colour and multiplied the *direct* light by a
      // hard-coded height ramp, which is a fake, and between them they made
      // every base read as flat grey.
      vec3 skyFill = mix(uHorizonColor, uZenithColor, 0.30) * (0.52 + 0.48 * h);
      vec3 groundBounce = vec3(0.34, 0.37, 0.42) * (1.0 - h) * 0.30;
      vec3 ambient = (skyFill + groundBounce) * uAmbientScale;

      vec3 luminance =
        uSunColor * uSunIntensity * direct * powderBoost * uDirectScale + ambient;

      float stepTransmittance = exp(-density * stepLength);
      scattering += transmittance * luminance * (1.0 - stepTransmittance);
      transmittance *= stepTransmittance;
    } else {
      // Six empty fine samples in a row means this cloud is behind us. Going
      // back to the wide stride is what buys the budget for the next one; the
      // run has to be longer than the rewind (half a search stride, so a little
      // over two refine steps) or the march would drop straight back out again
      // before it ever reached the boundary it detected.
      clearRun++;
      if (clearRun > CLEAR_RUN_EXIT) refining = false;
    }
    t += stepLength;
  }

  float alpha = 1.0 - transmittance;
  // Aerial perspective on the cloud itself. Without it a distant bank keeps its
  // full contrast and sits in front of the sky it should already be dissolving
  // into, which reads as a cut-out.
  if (foundCloud && alpha > 0.0) {
    float aerial = 1.0 - exp(-firstCloudDistance * 0.000032);
    scattering = mix(scattering, uHorizonColor * alpha * uAmbientScale * 1.15, aerial * 0.72);
  }
  float horizonFade = 1.0 - smoothstep(uMaxDistance * 0.80, uMaxDistance, firstCloudDistance);
  return vec4(scattering * horizonFade, alpha * horizonFade);
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

export const CLOUD_SHADOW_FRAGMENT = /* glsl */ `
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
    vec2 sampleXz = xz + sunOffset;
    // Spelled out rather than vec3(vec2, float): that constructor builds
    // (x, z, y), so the marching height landed in the z slot and the world z
    // landed in the height slot. cloudDensityLod then rejected almost every
    // sample against the slab and the shadow map came back uniformly lit.
    optical += cloudDensityLod(vec3(sampleXz.x, y, sampleXz.y), uDetailLevel) * stepLength;
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

function textureBytesPerChannel(type) {
  if (type === THREE.HalfFloatType) return 2;
  if (type === THREE.UnsignedByteType) return 1;
  throw new TypeError(`Unsupported cloud render-target texture type: ${type}`);
}

function renderTargetBytes(target) {
  const samples = Math.max(1, target.samples || 1);
  return target.textures.reduce((total, texture) => (
    total + target.width * target.height * 4 *
      textureBytesPerChannel(texture.type) * samples
  ), 0);
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
      // Filled in by initialize(); the volumes need a renderer to generate.
      uCloudShape: { value: null },
      uCloudDetail: { value: null },
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
      uStepAngle: { value: 0.045 },
      uStepMin: { value: 35 },
      uStepMax: { value: 850 },
      uMarchRange: { value: 26000 },
      uDirectScale: { value: 0.5 },
      uAmbientScale: { value: 0.5 },
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
      fragmentShader: CLOUD_SHADOW_FRAGMENT,
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

  resetHistory(_reason) {
    this._historyValid = false;
    this._historyFrames = 0;
    this.uniforms.get('uCloudWarmup').value = 0;
  }

  getResourceReport() {
    const historyTarget = this._temporalTargets[0];
    const historyTexture = historyTarget.textures[0];
    const shadowTexture = this._shadowTarget.texture;
    const historyBytes = this._temporalTargets.reduce(
      (total, target) => total + renderTargetBytes(target),
      0,
    );
    const shadowBytes = renderTargetBytes(this._shadowTarget);
    const resources = [
      {
        name: 'temporal-history',
        width: historyTarget.width,
        height: historyTarget.height,
        channels: 4,
        bytesPerChannel: textureBytesPerChannel(historyTexture.type),
        layers: 1,
        samples: Math.max(1, historyTarget.samples || 1),
        attachments: historyTarget.textures.length,
        history: this._temporalTargets.length,
        bytes: historyBytes,
      },
      {
        name: 'cloud-shadow',
        width: this._shadowTarget.width,
        height: this._shadowTarget.height,
        channels: 4,
        bytesPerChannel: textureBytesPerChannel(shadowTexture.type),
        layers: 1,
        samples: Math.max(1, this._shadowTarget.samples || 1),
        attachments: this._shadowTarget.textures.length,
        history: 1,
        bytes: shadowBytes,
      },
    ];

    return {
      backend: 'current',
      renderTargetCount: this._temporalTargets.length + 1,
      textureCount: this._temporalTargets.reduce(
        (total, target) => total + target.textures.length,
        this._shadowTarget.textures.length,
      ),
      resources,
      totalBytes: historyBytes + shadowBytes,
    };
  }

  initialize(renderer) {
    // The noise volumes need a renderer, so they are built here rather than in
    // the constructor. One-time cost behind the loading screen.
    if (renderer && !this._noise) {
      this._noise = new CloudNoise().build(renderer);
      this._sharedUniforms.uCloudShape.value = this._noise.shape ?? null;
      this._sharedUniforms.uCloudDetail.value = this._noise.detail ?? null;
      // The terrain compiles the same density code for its cloud shadows and
      // takes its cloud uniforms from Environment, so it needs the volumes too.
      const env = this.environment?.uniforms;
      if (env) {
        if (env.uCloudShape) env.uCloudShape.value = this._noise.shape;
        if (env.uCloudDetail) env.uCloudDetail.value = this._noise.detail;
      }
    }

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

  /**
   * Stop rendering the sky; keep casting shadows.
   *
   * The billboard field draws the visible clouds now. This volume stays because
   * the terrain reads its transmittance map, and because both are placed from
   * evaluateCloudColumn the two agree about where the weather is. Shadow-only
   * skips the whole primary march, which was all of the cost.
   */
  setShadowOnly(on) {
    this._shadowOnly = Boolean(on);
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

  /**
   * Per-tier march budget.
   *
   * `steps` is now a budget shared between a wide search stride and a narrow
   * sampling stride rather than a fixed schedule, so it buys much more than it
   * used to: a ray that crosses mostly clear air spends a few dozen strides
   * getting there and the rest inside the cloud it finds. It rose again here
   * because the search half is nearly free and the refine half is what makes a
   * cloud look like one.
   *
   * `stepMin` is the near-field *search* stride, and the refine stride is 22% of
   * it — so 90 here means the first cloud in front of the camera is sampled
   * every 20 m. It must not be derived from the march span: doing that made the
   * near-field stride 197 m along any near-horizontal ray, which is what erased
   * the cloud you were flying through.
   *
   * `march` is how far cloud is integrated at all — beyond it the deck is aerial
   * perspective, which is both cheaper and more honest than undersampling 46 km
   * of slab.
   */
  setQuality(tier) {
    const name = tier.name ?? 'high';
    // `checker` is 1 — every pixel marched every frame — everywhere but phone.
    // It was 2 (one pixel in four) because the procedural march could not be
    // afforded any other way, and reconstructing the other three from history
    // is exactly what produced the stipple the deck was reported for. Reading
    // the shape from a texture made the march cheap enough that the pattern is
    // no longer worth its cost: measured inside a dense bank, dropping it took
    // spatial noise from 1.66 to 0.53 of 255 for 3% more frame time, because
    // the march is no longer what the frame is spending its time on.
    //
    // `scale` stays at half resolution. Raising it to 0.7 and 1.0 cost 7.85 and
    // 15.08 ms against 4.46, and measured *no* noise improvement — the cloud
    // buffer is not what limits sharpness now.
    const DEFAULT = {
      scale: 0.5, steps: 112, light: 5, detail: 0.95, checker: 1, temporal: 0.38,
      strength: 1, march: 26000, stepMin: 90, stepAngle: 0.055, stepMax: 1200,
    };
    const quality = {
      phone: {
        scale: 0.24, steps: 40, light: 2, detail: 0.30, checker: 2, temporal: 0.42,
        strength: 0.45, march: 13000, stepMin: 220, stepAngle: 0.13, stepMax: 1400,
      },
      low: {
        scale: 0.32, steps: 56, light: 3, detail: 0.45, checker: 1, temporal: 0.40,
        strength: 0.65, march: 17000, stepMin: 170, stepAngle: 0.105, stepMax: 1400,
      },
      medium: {
        scale: 0.40, steps: 80, light: 4, detail: 0.75, checker: 1, temporal: 0.39,
        strength: 0.85, march: 21000, stepMin: 125, stepAngle: 0.075, stepMax: 1300,
      },
      high: DEFAULT,
    }[name] ?? DEFAULT;

    this._resolutionScale = quality.scale;
    this._marchUniforms.uSteps.value = quality.steps;
    this._marchUniforms.uLightSteps.value = quality.light;
    this._marchUniforms.uMaxDistance.value = tier.cloudDistance ?? 46000;
    this.uniforms.get('uCloudMaxDistance').value = this._marchUniforms.uMaxDistance.value;
    this._marchUniforms.uCheckerPeriod.value = quality.checker;
    this._marchUniforms.uTemporalAlpha.value = quality.temporal;
    this._marchUniforms.uMarchRange.value = Math.min(
      quality.march,
      this._marchUniforms.uMaxDistance.value,
    );
    this._marchUniforms.uStepMin.value = quality.stepMin;
    this._marchUniforms.uStepAngle.value = quality.stepAngle;
    this._marchUniforms.uStepMax.value = quality.stepMax;
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
    // visible march, terrain shadows and live shadow map use the same ceiling —
    // and the same floor. The ceiling was already raised to CLOUD_CONSTANTS.TOP
    // here; the base was not, so Environment's 4600 won and quietly undid the
    // reason CLOUD_CONSTANTS.BASE is 5200. At 4600 the deck sits among the
    // ridges and cloud and snowfield merge into one white mass, which is the
    // documented defect that constant exists to fix.
    if (env.uCloudTop) env.uCloudTop.value = Math.max(env.uCloudTop.value, CLOUD_CONSTANTS.TOP);
    if (env.uCloudBase) env.uCloudBase.value = Math.max(env.uCloudBase.value, CLOUD_CONSTANTS.BASE);
    if (env.uCloudDensity) {
      env.uCloudDensity.value = Math.min(env.uCloudDensity.value, CLOUD_EXTINCTION);
    }
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

  /**
   * The shadow stripe on its own, without the primary march.
   *
   * Same eighth-of-the-map-per-frame schedule the full path uses, so the
   * terrain sees exactly the transmittance it saw before.
   */
  _renderShadowOnly(renderer) {
    const previousTarget = renderer.getRenderTarget();
    const previousAutoClear = renderer.autoClear;
    const previousXr = renderer.xr.enabled;
    const previousMaterial = this._fullscreenMesh.material;
    const previousShadowScissorTest = this._shadowTarget.scissorTest;
    renderer.getClearColor(this._savedClearColor);
    const previousClearAlpha = renderer.getClearAlpha();
    try {
      renderer.xr.enabled = false;
      const shadowMoved = this._updateShadowCenter();
      this._shadowTarget.scissorTest = false;
      renderer.autoClear = true;
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
    this._shadowStripe = (this._shadowStripe + 1) % 8;
    this.shadowContract.version += 1;
  }

  update(renderer, inputBuffer, dt = 0) {
    if (this._shadowOnly) {
      this._syncEnvironment(dt);
      this._renderShadowOnly(renderer);
      return;
    }
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
    // Long enough to cover every checker cell, but never so short that the deck
    // steps into view. With the checkerboard gone period^2 + 2 is three frames,
    // and a third of the cloud appearing on the first one is a visible pop —
    // the ramp is about the eye, not about the sampling pattern.
    const warmupFrames = Math.max(6, period * period + 2);
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
    this._noise?.dispose();
    this._noise = null;
    this._sharedUniforms.uCloudShape.value = null;
    this._sharedUniforms.uCloudDetail.value = null;
  }
}
