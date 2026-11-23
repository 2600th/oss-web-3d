import { Uniform, Vector2 } from 'three';
import { Effect, EffectAttribute } from 'postprocessing';

const fragment = /* glsl */ `
  uniform vec2 uSun;
  uniform float uVisibility;
  uniform float uIntensity;

  void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
    vec2 ray = (uv - uSun) * 0.075;
    vec3 shafts = vec3(0.0);
    float weight = 0.18;
    for (int i = 1; i <= 5; i++) {
      vec2 sampleUv = clamp(uv - ray * float(i), vec2(0.001), vec2(0.999));
      vec3 sampleColor = texture2D(inputBuffer, sampleUv).rgb;
      float source = max(max(sampleColor.r, sampleColor.g), sampleColor.b);
      shafts += sampleColor * smoothstep(0.72, 1.4, source) * weight;
      weight *= 0.78;
    }
    float onScreen = step(0.0, uSun.x) * step(uSun.x, 1.0) * step(0.0, uSun.y) * step(uSun.y, 1.0);
    outputColor = vec4(inputColor.rgb + shafts * uIntensity * uVisibility * onScreen, inputColor.a);
  }
`;

export class SunShaftEffect extends Effect {
  constructor() {
    const sun = new Vector2(0.5, 0.5);
    super('SunShaftEffect', fragment, {
      attributes: EffectAttribute.CONVOLUTION,
      uniforms: new Map([
        ['uSun', new Uniform(sun)],
        ['uVisibility', new Uniform(0)],
        ['uIntensity', new Uniform(0.16)],
      ]),
    });
    this.sunPosition = sun;
  }

  setSunPosition(x, y, visibility = 1) {
    this.sunPosition.set(x, y);
    this.visibility = visibility;
  }

  set visibility(value) {
    this.uniforms.get('uVisibility').value = Math.max(0, Math.min(1, value));
  }

  get visibility() {
    return this.uniforms.get('uVisibility').value;
  }

  set intensity(value) {
    this.uniforms.get('uIntensity').value = Math.max(0, Math.min(0.5, value));
  }

  get intensity() {
    return this.uniforms.get('uIntensity').value;
  }
}
