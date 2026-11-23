/**
 * Shading helpers shared by every effect material in src/fx/gpu.
 *
 * softFade, gradient4 and the fresnel term are adapted from
 * LinearAbiltyCastingThreeJS (MIT), src/shaders/lib/common.glsl.js. The
 * scattering model below is not from the reference: that project is a stylised
 * ability sandbox where every particle is emissive, and this one has to sit
 * inside a physically-scaled linear HDR scene where a smoke puff is a *lit
 * surface* with an albedo, not a light source.
 *
 * Declares the frame uniforms it reads (uSunColor, uSunIntensity, uSunDir,
 * uFxAmbient, uSceneDepth, uCameraNear, uCameraFar, uResolution) so a material
 * only has to concatenate this chunk and pass sharedUniforms().
 */
export const FX_COMMON_GLSL = /* glsl */ `
#ifndef FX_COMMON_INCLUDED
#define FX_COMMON_INCLUDED

#include <packing>

uniform vec3 uSunColor;
uniform float uSunIntensity;
uniform vec3 uSunDir;
uniform vec3 uFxAmbient;
uniform vec2 uResolution;
uniform float uCameraNear;
uniform float uCameraFar;

/**
 * The sun in view space.
 *
 * Derived from the built-in viewMatrix rather than uploaded as a second
 * uniform, because the CPU-side value would be a frame stale: the camera's
 * inverse world matrix is only refreshed inside renderer.render(), well after
 * the effects have had their update() call. At 300 m/s with a chase camera that
 * showed as billboard lighting lagging a hard roll.
 */
vec3 fxSunDirView() { return normalize((viewMatrix * vec4(uSunDir, 0.0)).xyz); }

#ifdef FX_SOFT_DEPTH
uniform sampler2D uSceneDepth;
uniform float uSoftFade;

/**
 * Soft-particle fade against the opaque scene depth.
 *
 * Returns 0 where the billboard is level with geometry and 1 once it is
 * uSoftFade metres in front of it, which is what stops a plume from showing the
 * polygon it was clipped by as a hard line across a ridge.
 *
 * Compile-gated rather than always on: sampling depth costs a fetch per fragment
 * on the most fill-bound thing in the frame, and this project only has a scene
 * depth texture to sample once the post stack renders one.
 */
float fxSoftFade(float fragViewZ) {
  vec2 uv = gl_FragCoord.xy / uResolution;
  float d = texture(uSceneDepth, uv).x;
  float sceneViewZ = perspectiveDepthToViewZ(d, uCameraNear, uCameraFar);
  return clamp((fragViewZ - sceneViewZ) / max(uSoftFade, 1e-4), 0.0, 1.0);
}
#else
float fxSoftFade(float fragViewZ) { return 1.0; }
#endif

/** Four-stop lifetime gradient: core, mid, edge, tail. */
vec3 fxGradient4(vec3 c0, vec3 c1, vec3 c2, vec3 c3, float t) {
  t = clamp(t, 0.0, 1.0);
  vec3 a = mix(c0, c1, smoothstep(0.0, 0.34, t));
  vec3 b = mix(a, c2, smoothstep(0.30, 0.68, t));
  return mix(b, c3, smoothstep(0.64, 1.0, t));
}

/** Schlick-ish rim term. */
float fxFresnel(vec3 viewDir, vec3 normal, float power) {
  return pow(clamp(1.0 - abs(dot(normalize(viewDir), normalize(normal))), 0.0, 1.0), power);
}

/**
 * Linear radiance of an optically thin white condensate -- ice crystals, snow
 * lifted off a crest, dust, exhaust smoke.
 *
 * Three terms, and each is there because leaving it out breaks a specific shot:
 *
 *  - Wrapped diffuse rather than clamped Lambert. A snow puff transmits, so its
 *    shadowed side is a dim version of its lit side, not black. Clamped Lambert
 *    put a hard terminator across every particle and made a plume read as a pile
 *    of spheres.
 *  - A forward-scatter lobe on the view/sun angle. Looking toward the sun
 *    through a contrail is the brightest that contrail ever gets, and it is the
 *    single cue that separates ice from a white line drawn on the sky.
 *  - Explicit sky ambient. With the sun at 46 degrees, anything facing away from
 *    it is lit only by the dome, and against snow that fill is most of what you
 *    see.
 *
 * nDotL is against a view-space normal, so callers hand in uSunDirView.
 */
vec3 fxScatter(vec3 albedo, float nDotL, float forward) {
  vec3 sun = uSunColor * uSunIntensity;
  float direct = mix(0.30, 1.0, nDotL * 0.5 + 0.5);
  direct += forward * forward * 1.7;
  return albedo * (sun * direct + uFxAmbient);
}

#endif
`;
