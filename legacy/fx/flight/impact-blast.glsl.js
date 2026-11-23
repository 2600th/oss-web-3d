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

  out vec3 vViewNormal;
  out float vShellNoise;

  ${FX_NOISE_GLSL}

  void main() {
    vec3 objectNormal = normalize(normal);
    vViewNormal = normalize(normalMatrix * objectNormal);
    float shellNoise = fxFbm3(objectNormal * 2.35 + vec3(0.0, uAge * 0.42, uAge * 0.21));
    vShellNoise = shellNoise * 0.5 + 0.5;
    float displacement = (0.10 + shellNoise * 0.22) * uStrength * (1.0 - uAge * 0.55);
    vec3 transformed = position + objectNormal * displacement;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(transformed, 1.0);
  }
`;

export const IMPACT_SHELL_FRAGMENT = /* glsl */ `
  uniform float uAge;
  uniform float uStrength;

  in vec3 vViewNormal;
  in float vShellNoise;
  out vec4 outColor;

  void main() {
    float fresnel = pow(1.0 - abs(dot(normalize(vViewNormal), vec3(0.0, 0.0, 1.0))), 2.2);
    float dissolveThreshold = smoothstep(0.16, 0.88, uAge);
    float dissolve = smoothstep(dissolveThreshold - 0.18, dissolveThreshold + 0.08, vShellNoise);
    float pressureEnvelope = 1.0 - smoothstep(0.18, 1.0, uAge);
    float alpha = (0.025 + fresnel * 0.22) * dissolve * pressureEnvelope;
    if (alpha < 0.004) discard;

    vec3 hotAmber = vec3(1.05, 0.38, 0.08);
    vec3 emberEdge = vec3(0.65, 0.08, 0.01);
    vec3 color = mix(hotAmber, emberEdge, smoothstep(0.05, 0.82, uAge));
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
    float crest = 1.0 - smoothstep(0.04, 0.72, across);
    float tail = 1.0 - smoothstep(0.10, 1.0, uAge);
    float alpha = crest * tail * uStrength * 0.28;
    if (alpha < 0.004) discard;
    vec3 color = mix(vec3(0.72, 0.10, 0.015), vec3(1.10, 0.42, 0.10), crest);
    outColor = vec4(color, alpha);
  }
`;
