import { Uniform, Vector2 } from 'three';
import { Effect, EffectAttribute } from 'postprocessing';

const fragment = /* glsl */ `
  uniform vec2 uInvResolution;
  uniform float uAmount;
  uniform float uTime;
  uniform vec2 uCentre;

  void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
    // Centred on the exhaust, not on a fixed point in the frame. This was
    // vec2(0.5, 0.7) — the middle of the screen, slightly low — so the shimmer
    // sat wherever the aircraft was not, in every banked turn and throughout
    // the recon transition.
    float wake = 1.0 - smoothstep(0.35, 0.82, distance(uv, uCentre));
    float shimmer = sin(uv.y * 83.0 + uTime * 11.0) * sin(uv.x * 47.0 - uTime * 7.0);
    vec2 offset = vec2(shimmer, shimmer * 0.22) * uInvResolution * 2.0 * uAmount * wake;
    outputColor = texture2D(inputBuffer, clamp(uv + offset, 0.0, 1.0));
  }
`;

export class HeatDistortionEffect extends Effect {
  constructor() {
    super('HeatDistortionEffect', fragment, {
      attributes: EffectAttribute.CONVOLUTION,
      uniforms: new Map([
        ['uInvResolution', new Uniform(new Vector2(1, 1))],
        ['uAmount', new Uniform(0)],
        ['uTime', new Uniform(0)],
        ['uCentre', new Uniform(new Vector2(0.5, 0.7))],
      ]),
    });
    this._time = 0;
  }

  set amount(value) {
    this.uniforms.get('uAmount').value = Math.max(0, Math.min(1, value));
  }

  get amount() {
    return this.uniforms.get('uAmount').value;
  }

  /** Screen-space centre of the exhaust plume, in [0,1] UV. */
  setCentre(x, y) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    this.uniforms.get('uCentre').value.set(
      Math.max(-0.5, Math.min(1.5, x)),
      Math.max(-0.5, Math.min(1.5, y)),
    );
  }

  setSize(width, height) {
    this.uniforms.get('uInvResolution').value.set(1 / Math.max(1, width), 1 / Math.max(1, height));
  }

  update(_renderer, _inputBuffer, deltaTime = 0) {
    this._time = (this._time + Math.max(0, Math.min(0.25, deltaTime))) % 4096;
    this.uniforms.get('uTime').value = this._time;
  }
}
