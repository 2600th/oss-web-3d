import { Uniform, Vector2 } from 'three';
import { Effect, EffectAttribute } from 'postprocessing';

const fragment = /* glsl */ `
  uniform vec2 uVelocity;
  uniform vec2 uInvResolution;
  uniform float uAmount;

  void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
    vec2 offset = uVelocity * uInvResolution * uAmount;
    vec3 color = inputColor.rgb * 0.4;
    color += texture2D(inputBuffer, clamp(uv - offset, 0.0, 1.0)).rgb * 0.3;
    color += texture2D(inputBuffer, clamp(uv + offset, 0.0, 1.0)).rgb * 0.3;
    outputColor = vec4(color, inputColor.a);
  }
`;

export class MotionBlurEffect extends Effect {
  constructor() {
    const velocity = new Vector2();
    super('MotionBlurEffect', fragment, {
      attributes: EffectAttribute.CONVOLUTION,
      uniforms: new Map([
        ['uVelocity', new Uniform(velocity)],
        ['uInvResolution', new Uniform(new Vector2(1, 1))],
        ['uAmount', new Uniform(0)],
      ]),
    });
    this.velocity = velocity;
  }

  setVelocity(x, y) {
    this.velocity.set(x, y);
  }

  set amount(value) {
    this.uniforms.get('uAmount').value = Math.max(0, Math.min(1, value));
  }

  get amount() {
    return this.uniforms.get('uAmount').value;
  }

  setSize(width, height) {
    this.uniforms.get('uInvResolution').value.set(1 / Math.max(1, width), 1 / Math.max(1, height));
  }
}
