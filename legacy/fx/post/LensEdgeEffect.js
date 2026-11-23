import { Uniform, Vector2 } from 'three';
import { Effect, EffectAttribute } from 'postprocessing';

const fragment = /* glsl */ `
  uniform vec2 uInvResolution;
  uniform float uAmount;

  void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
    vec2 fromCenter = uv * 2.0 - 1.0;
    float edge = smoothstep(0.28, 1.15, dot(fromCenter, fromCenter));
    vec2 offset = fromCenter * uInvResolution * uAmount * edge;
    float red = texture2D(inputBuffer, uv + offset).r;
    float blue = texture2D(inputBuffer, uv - offset).b;
    outputColor = vec4(red, inputColor.g, blue, inputColor.a);
  }
`;

/** Sub-pixel lens separation, compiled out of the phone and low tiers. */
export class LensEdgeEffect extends Effect {
  constructor(amount = 0.45) {
    super('LensEdgeEffect', fragment, {
      attributes: EffectAttribute.CONVOLUTION,
      uniforms: new Map([
        ['uInvResolution', new Uniform(new Vector2(1, 1))],
        ['uAmount', new Uniform(amount)],
      ]),
    });
  }

  set amount(value) {
    this.uniforms.get('uAmount').value = value;
  }

  get amount() {
    return this.uniforms.get('uAmount').value;
  }

  setSize(width, height) {
    this.uniforms.get('uInvResolution').value.set(1 / Math.max(1, width), 1 / Math.max(1, height));
  }
}
