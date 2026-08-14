import { Uniform, Vector2 } from 'three';
import { Effect } from 'postprocessing';

const PROFILES = {
  phone: { saturation: 1.06, contrast: 1.04, vignette: 0.1, grain: 0, chromaticAberration: 0 },
  low: { saturation: 1.08, contrast: 1.055, vignette: 0.11, grain: 0, chromaticAberration: 0 },
  medium: { saturation: 1.1, contrast: 1.07, vignette: 0.13, grain: 0.3 / 255, chromaticAberration: 0.32 },
  high: { saturation: 1.12, contrast: 1.08, vignette: 0.14, grain: 0.42 / 255, chromaticAberration: 0.45 },
};

const fragment = /* glsl */ `
  uniform float uSaturation;
  uniform float uContrast;
  uniform float uVignette;
  uniform float uGrain;
  uniform float uTime;

  float grainNoise(vec2 p, float t) {
    return fract(sin(dot(p + vec2(t * 23.17, t * 7.91), vec2(12.9898, 78.233))) * 43758.5453);
  }

  void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
    vec3 color = max(inputColor.rgb, vec3(0.0));
    float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));

    color = mix(vec3(luma), color, uSaturation);
    color = (color - 0.5) * uContrast + 0.5;

    // Cool shadow density and a very light warm shoulder keep snow white while
    // separating rock, haze and sunlit ridges without a LUT asset.
    float shadow = 1.0 - smoothstep(0.05, 0.58, luma);
    float highlight = smoothstep(0.55, 0.98, luma);
    color *= mix(vec3(1.0), vec3(0.965, 0.995, 1.045), shadow * 0.32);
    color *= mix(vec3(1.0), vec3(1.025, 1.008, 0.982), highlight * 0.28);

    vec2 edgeCoord = uv * 2.0 - 1.0;
    float edge = smoothstep(0.18, 1.25, dot(edgeCoord, edgeCoord));
    color *= 1.0 - edge * uVignette;

    float noise = grainNoise(gl_FragCoord.xy, uTime) - 0.5;
    // Grain disappears in clipped whites and deep blacks, like exposure noise
    // rather than a grey screen overlay.
    float grainMask = smoothstep(0.02, 0.2, luma) * (1.0 - smoothstep(0.78, 1.0, luma));
    color += noise * uGrain * grainMask;
    outputColor = vec4(max(color, vec3(0.0)), inputColor.a);
  }
`;

export class CinematicGradeEffect extends Effect {
  constructor() {
    const resolution = new Vector2(1, 1);
    super('CinematicGradeEffect', fragment, {
      uniforms: new Map([
        ['uSaturation', new Uniform(1)],
        ['uContrast', new Uniform(1)],
        ['uVignette', new Uniform(0)],
        ['uGrain', new Uniform(0)],
        ['uTime', new Uniform(0)],
      ]),
    });
    this.resolution = resolution;
    this.chromaticAberration = 0;
    this.grain = 0;
    this._time = 0;
    this.setQuality({ name: 'high' });
  }

  setQuality(tier) {
    const profile = PROFILES[tier?.name] ?? PROFILES.high;
    this.uniforms.get('uSaturation').value = profile.saturation;
    this.uniforms.get('uContrast').value = profile.contrast;
    this.uniforms.get('uVignette').value = profile.vignette;
    this.uniforms.get('uGrain').value = profile.grain;
    this.chromaticAberration = profile.chromaticAberration;
    this.grain = profile.grain;
  }

  setSize(width, height) {
    this.resolution.set(width, height);
  }

  update(_renderer, _inputBuffer, deltaTime = 0) {
    this._time = (this._time + Math.min(Math.max(deltaTime, 0), 0.25)) % 4096;
    this.uniforms.get('uTime').value = this._time;
  }

  sanitizeSample(rgb) {
    return rgb.map((channel) => Math.max(0, channel));
  }
}
