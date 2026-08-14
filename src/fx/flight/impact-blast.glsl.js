import { FX_NOISE_GLSL } from '../gpu/noise.glsl.js';

/**
 * A short-lived pressure shell: bounded FBM distorts the silhouette while a
 * rising threshold erodes it instead of fading the whole sphere uniformly.
 * The displacement/dissolve treatment is adapted from the MIT-licensed burst
 * and noise techniques in LinearAbiltyCastingThreeJS; this shader is purpose
 * built for the terrain-impact lifecycle rather than copying its burst class.
 */
export const IMPACT_SHELL_VERTEX = /* glsl */ `
  uniform float uAge;
  uniform float uStrength;

  out vec3 vObjectNormal;
  out float vShellNoise;

  ${FX_NOISE_GLSL}

  void main() {
    vObjectNormal = normalize(normal);
    float shellNoise = fxFbm3(vObjectNormal * 2.35 + vec3(0.0, uAge * 0.42, uAge * 0.21));
    vShellNoise = shellNoise * 0.5 + 0.5;
    float displacement = (0.10 + shellNoise * 0.22) * uStrength * (1.0 - uAge * 0.55);
    vec3 transformed = position + vObjectNormal * displacement;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(transformed, 1.0);
  }
`;

export const IMPACT_SHELL_FRAGMENT = /* glsl */ `
  uniform float uAge;
  uniform float uStrength;

  in vec3 vObjectNormal;
  in float vShellNoise;
  out vec4 outColor;

  void main() {
    float fresnel = pow(1.0 - abs(dot(normalize(vObjectNormal), vec3(0.0, 0.0, 1.0))), 1.7);
    float dissolveThreshold = smoothstep(0.28, 1.0, uAge);
    float dissolve = smoothstep(dissolveThreshold - 0.16, dissolveThreshold + 0.10, vShellNoise);
    float alpha = (0.28 + fresnel * 0.72) * dissolve * (1.0 - smoothstep(0.70, 1.0, uAge));
    if (alpha < 0.004) discard;

    vec3 whiteCore = vec3(1.85, 1.42, 0.82);
    vec3 amberEdge = vec3(1.15, 0.22, 0.025);
    vec3 color = mix(whiteCore, amberEdge, smoothstep(0.05, 0.82, uAge));
    outColor = vec4(color * uStrength, alpha * uStrength);
  }
`;

export const IMPACT_RING_VERTEX = /* glsl */ `
  out vec2 vRingUv;

  void main() {
    vRingUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

export const IMPACT_RING_FRAGMENT = /* glsl */ `
  uniform float uAge;
  uniform float uStrength;

  in vec2 vRingUv;
  out vec4 outColor;

  void main() {
    float across = abs(vRingUv.y - 0.5) * 2.0;
    float crest = 1.0 - smoothstep(0.08, 0.92, across);
    float tail = 1.0 - smoothstep(0.16, 1.0, uAge);
    float alpha = crest * tail * uStrength;
    if (alpha < 0.004) discard;
    vec3 color = mix(vec3(1.75, 0.34, 0.035), vec3(2.4, 1.45, 0.62), crest);
    outColor = vec4(color, alpha);
  }
`;
