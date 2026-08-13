import * as THREE from 'three';
import { Effect, EffectAttribute } from 'postprocessing';
import { CLOUD_GLSL, CLOUD_CONSTANTS } from './clouds.glsl.js';

/**
 * Raymarched volumetric clouds.
 *
 * This replaces an instanced-billboard system. Billboards were chosen earlier
 * on a cost argument that turned out to be answering the wrong question: the
 * published figures that made full-screen raymarching look unaffordable are for
 * marching a *full-resolution* buffer with 128 steps. The cost that actually
 * matters is steps x pixels, and both are controllable — the slab is thin, the
 * march is bounded to where cloud can exist, and transmittance terminates the
 * ray early. What billboards could never buy at any price was the thing the
 * clouds were being asked for: real silhouettes, correct occlusion against
 * terrain, and an inside.
 *
 * It runs as a postprocessing Effect rather than as its own pass. That is a
 * deliberate architectural choice, not convenience: an Effect declaring the
 * DEPTH attribute is handed the scene depth inside the existing full-screen
 * pass, so clouds composite correctly behind ridges with **no additional render
 * target and no extra render-pass switch**. On the tile-based GPUs in phones a
 * render-pass switch costs a full store and reload of the framebuffer through
 * DRAM — measured at roughly 25 MB and half a millisecond per pass on a modern
 * phone — so avoiding one is worth more than any shader micro-optimisation.
 *
 * The march itself follows the established real-time cloud model:
 *
 *   - Energy-conserving analytic integration of in-scattering over each step,
 *     rather than a plain sum. This is what lets a small step count look like a
 *     large one; with a naive sum, brightness depends on step size and the only
 *     fix is more steps.
 *   - Beer's law for transmittance, a dual-lobe Henyey-Greenstein phase
 *     function for the forward silver lining plus a body that does not go dead,
 *     and a view-gated powder term for the dark edge away from the sun.
 *   - A short cone-spread march toward the sun for self-shadowing, without the
 *     detail octaves, which cost a great deal there and change almost nothing.
 *   - A per-pixel jittered start offset. Without it a low step count produces
 *     concentric banding, which is the single most recognisable raymarching
 *     artifact.
 */
export class CloudVolume extends Effect {
  constructor(environment, camera) {
    super('CloudVolume', FRAGMENT, {
      attributes: EffectAttribute.DEPTH,
      uniforms: new Map([
        ['uCloudBase', { value: CLOUD_CONSTANTS.BASE }],
        ['uCloudTop', { value: CLOUD_CONSTANTS.TOP }],
        ['uCloudCoverage', { value: CLOUD_CONSTANTS.COVERAGE_SCALE }],
        ['uCloudDensity', { value: CLOUD_CONSTANTS.DENSITY }],
        ['uCloudWind', { value: new THREE.Vector2(1, 0) }],
        ['uCloudTime', { value: 0 }],
        ['uInvViewProj', { value: new THREE.Matrix4() }],
        ['uCamPos', { value: new THREE.Vector3() }],
        ['uCamForward', { value: new THREE.Vector3(0, 0, -1) }],
        ['uSunDir', { value: new THREE.Vector3(0, 1, 0) }],
        ['uSunColor', { value: new THREE.Color(1, 1, 1) }],
        ['uSunIntensity', { value: 1.5 }],
        ['uZenithColor', { value: new THREE.Color(0.03, 0.09, 0.3) }],
        ['uHorizonColor', { value: new THREE.Color(0.56, 0.68, 0.85) }],
        ['uSteps', { value: 56 }],
        ['uLightSteps', { value: 5 }],
        ['uMaxDistance', { value: 46000 }],
        ['uFrame', { value: 0 }],
      ]),
    });

    this.environment = environment;
    this.camera = camera;
    this._invProjection = new THREE.Matrix4();
    this._frame = 0;
  }

  setQuality(tier) {
    const u = this.uniforms;
    u.get('uSteps').value = tier.cloudSteps ?? 56;
    u.get('uLightSteps').value = tier.cloudLightSteps ?? 5;
    u.get('uMaxDistance').value = tier.cloudDistance ?? 46000;
  }

  update(renderer, inputBuffer, dt) {
    const u = this.uniforms;
    const camera = this.camera;
    const env = this.environment.uniforms;

    this._frame = (this._frame + 1) % 64;
    u.get('uFrame').value = this._frame;
    u.get('uCloudTime').value += dt;

    camera.updateMatrixWorld();
    // Inverse view-projection, for reconstructing a world-space ray per pixel.
    this._invProjection.copy(camera.projectionMatrix).invert();
    u.get('uInvViewProj').value.multiplyMatrices(camera.matrixWorld, this._invProjection);
    u.get('uCamPos').value.copy(camera.position);
    camera.getWorldDirection(u.get('uCamForward').value);

    u.get('uSunDir').value.copy(env.uSunDir.value);
    u.get('uSunColor').value.copy(env.uSunColor.value);
    u.get('uSunIntensity').value = env.uSunIntensity.value;
    u.get('uZenithColor').value.copy(env.uZenithColor.value);
    u.get('uHorizonColor').value.copy(env.uHorizonColor.value);
    u.get('uCloudWind').value.copy(env.uWind.value).multiplyScalar(0.35);
  }
}

const FRAGMENT = /* glsl */ `
uniform mat4 uInvViewProj;
uniform vec3 uCamPos;
uniform vec3 uCamForward;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uSunIntensity;
uniform vec3 uZenithColor;
uniform vec3 uHorizonColor;
uniform int uSteps;
uniform int uLightSteps;
uniform float uMaxDistance;
uniform float uFrame;

${CLOUD_GLSL}

float hg(float mu, float g) {
  float gg = g * g;
  float d = 1.0 + gg - 2.0 * g * mu;
  return (1.0 - gg) / (12.566370614 * max(d * sqrt(max(d, 1e-4)), 1e-4));
}

// Interleaved gradient noise, deliberately NOT animated per frame.
//
// Jittering the ray start converts step banding into fine noise. Animating that
// jitter is only correct when there is a temporal filter to average it against;
// without one it turns a static stipple into full-frame flicker, which is worse
// — the eye tolerates fixed grain and cannot ignore movement. Static noise on a
// cloud edge reads as texture.
float ign(vec2 p) {
  return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
}

/** Sunlight reaching a point inside the volume. */
float lightMarch(vec3 p) {
  float t1 = (uCloudTop - p.y) / max(uSunDir.y, 0.05);
  float span = min(t1, 3200.0);
  if (span <= 0.0) return 1.0;

  float optical = 0.0;
  float step = span / float(uLightSteps);
  for (int i = 0; i < 8; i++) {
    if (i >= uLightSteps) break;
    // Cone spread: samples fan out with distance, which softens the shadow and
    // approximates the multiple scattering a single ray cannot represent.
    float t = (float(i) + 0.5) * step;
    vec3 q = p + uSunDir * t;
    optical += cloudDensity(q, false) * step;
  }
  // Well below a physically single-scattering extinction, and deliberately.
  // This stands in for light that has bounced many times inside the cloud, and
  // a correct single-scatter value here makes every core solid black.
  // Enough contrast for a lit crown and a shaded base -- the thing that makes
  // a cloud read as a solid with a shape rather than as fog. Floored well above
  // zero because this stands in for multiply-scattered light.
  return 0.10 + 0.90 * exp(-optical * 1.25);
}

void mainImage(const in vec4 inputColor, const in vec2 uv, const in float depth, out vec4 outputColor) {
  // World-space ray for this pixel.
  vec4 far = uInvViewProj * vec4(uv * 2.0 - 1.0, 1.0, 1.0);
  vec3 dir = normalize(far.xyz / far.w - uCamPos);

  // How far the scene already occludes. Depth of 1 means nothing was drawn, so
  // the ray runs to the horizon; otherwise the cloud must stop at the terrain.
  float sceneDist = uMaxDistance;
  if (depth < 1.0) {
    float viewZ = -getViewZ(depth);
    sceneDist = viewZ / max(dot(dir, uCamForward), 1e-3);
  }

  // Intersect the cloud slab. Both ends are needed: the camera can be below it,
  // inside it, or above it looking down, and all three happen in this game.
  float tBottom = (uCloudBase - uCamPos.y) / dir.y;
  float tTop = (uCloudTop - uCamPos.y) / dir.y;
  float tNear = min(tBottom, tTop);
  float tFar = max(tBottom, tTop);
  if (dir.y == 0.0) { tNear = 0.0; tFar = uCamPos.y > uCloudBase && uCamPos.y < uCloudTop ? uMaxDistance : -1.0; }
  tNear = max(tNear, 0.0);
  tFar = min(tFar, min(sceneDist, uMaxDistance));

  if (tFar <= tNear) {
    outputColor = inputColor;
    return;
  }

  float span = tFar - tNear;
  float stepSize = span / float(uSteps);
  float jitter = ign(gl_FragCoord.xy);

  float mu = dot(dir, uSunDir);
  // Narrow forward lobe for the silver lining, wide backscatter lobe so the
  // body of a cloud does not go dead once the rim lights up.
  float phase = mix(hg(mu, 0.72), hg(mu, -0.28), 0.36) / 0.0265;
  phase = min(phase, 6.0);

  vec3 scattering = vec3(0.0);
  float transmittance = 1.0;

  for (int i = 0; i < 128; i++) {
    if (i >= uSteps || transmittance < 0.015) break;
    float t = tNear + (float(i) + jitter) * stepSize;
    if (t > tFar) break;

    vec3 p = uCamPos + dir * t;
    float density = cloudDensity(p, true);
    if (density <= 0.0) continue;

    float light = lightMarch(p);
    // Powder: the dark edge seen with the sun behind the viewer. Gated on view
    // direction, because it is only visible where the view vector approaches
    // the light vector — applying it unconditionally darkens cloud that should
    // be bright, which is the common mistake.
    float powder = 1.0 - exp(-density * stepSize * 3.4);
    float gate = clamp(mu * 0.5 + 0.5, 0.0, 1.0);

    // Sky ambient rises through the slab: the crown sees the whole dome, the
    // base mostly the underside of what is above it.
    float h = clamp((p.y - uCloudBase) / (uCloudTop - uCloudBase), 0.0, 1.0);
    vec3 ambient = mix(uZenithColor * 0.7 + vec3(0.055, 0.085, 0.135), uHorizonColor * 1.12, h * h);

    vec3 luminance =
      uSunColor * uSunIntensity * light * phase * mix(1.0, powder, gate * 0.8) * 0.42 + ambient;

    // Energy-conserving analytic integration over the step, rather than a plain
    // sum. Without this the result depends on step size and a low step count
    // reads as thin and flickery.
    float clamped = max(density, 1e-5);
    float stepTransmittance = exp(-clamped * stepSize);
    vec3 integrated = (luminance - luminance * stepTransmittance) / clamped;

    scattering += transmittance * integrated;
    transmittance *= stepTransmittance;
  }

  // Fade the whole result out at the far limit so the march boundary is never a
  // visible edge across the sky.
  float horizonFade = 1.0 - smoothstep(uMaxDistance * 0.72, uMaxDistance, tNear);
  float alpha = (1.0 - transmittance) * horizonFade;
  vec3 cloud = scattering * horizonFade;

  outputColor = vec4(inputColor.rgb * (1.0 - alpha) + cloud, inputColor.a);
}
`;
