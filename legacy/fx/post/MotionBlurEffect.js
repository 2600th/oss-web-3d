import { Uniform, Vector2 } from 'three';
import { Effect, EffectAttribute } from 'postprocessing';

export const MOTION_BLUR_FRAGMENT = /* glsl */ `
  uniform vec2 uAngularPixels;
  uniform vec2 uInvResolution;
  uniform vec2 uOpticalCenter;
  uniform float uRadialPixels;
  uniform float uAmount;
  uniform float uEdgeStart;

  vec2 clampCombinedPixels(vec2 pixels) {
    float magnitude = length(pixels);
    return pixels * min(1.0, 6.0 / max(magnitude, 0.0001));
  }

  void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
    vec2 fromCenter = uv - uOpticalCenter;
    vec2 pixelDirection = fromCenter / max(uInvResolution, vec2(0.000001));
    vec2 radialDirection = length(pixelDirection) > 0.0001
      ? normalize(pixelDirection)
      : vec2(0.0);
    float normalizedRadius = length(fromCenter) / 0.70710678;
    float edgeMask = smoothstep(uEdgeStart, 0.75, normalizedRadius);
    vec2 combinedPixels = clampCombinedPixels(
      uAngularPixels + radialDirection * uRadialPixels * edgeMask
    );
    vec2 offset = combinedPixels * uInvResolution * uAmount;
    vec3 color = inputColor.rgb * 0.4;
    color += texture2D(inputBuffer, clamp(uv - offset, 0.0, 1.0)).rgb * 0.3;
    color += texture2D(inputBuffer, clamp(uv + offset, 0.0, 1.0)).rgb * 0.3;
    outputColor = vec4(color, inputColor.a);
  }
`;

export class MotionBlurEffect extends Effect {
  constructor() {
    const angularPixels = new Vector2();
    super('MotionBlurEffect', MOTION_BLUR_FRAGMENT, {
      attributes: EffectAttribute.CONVOLUTION,
      uniforms: new Map([
        ['uAngularPixels', new Uniform(angularPixels)],
        ['uInvResolution', new Uniform(new Vector2(1, 1))],
        ['uOpticalCenter', new Uniform(new Vector2(0.5, 0.5))],
        ['uRadialPixels', new Uniform(0)],
        ['uAmount', new Uniform(0)],
        ['uEdgeStart', new Uniform(0.45)],
      ]),
    });
    this.angularPixels = angularPixels;
  }

  /**
   * @param {object} motion
   * @param {{x: number, y: number}} [motion.opticalCenter] where the radial
   *   streaks converge, in [0,1] UV. This uniform was declared and read by the
   *   shader from the start but never written, so the blur always streaked from
   *   the exact centre of the frame — wrong in every banked turn and through the
   *   whole recon transition, which are the two moments it exists for. The right
   *   point is where the velocity vector meets the screen.
   */
  setMotion({
    angularX = 0, angularY = 0, radialPixels = 0, amount = 0, edgeStart = 0.45,
    opticalCenter = null,
  } = {}) {
    if (opticalCenter
      && Number.isFinite(opticalCenter.x) && Number.isFinite(opticalCenter.y)) {
      // Clamped generously rather than to [0,1]: when the aircraft is yawed the
      // vanishing point genuinely leaves the frame, and pinning it to the edge
      // would bend the streaks the wrong way.
      this.uniforms.get('uOpticalCenter').value.set(
        Math.max(-1, Math.min(2, opticalCenter.x)),
        Math.max(-1, Math.min(2, opticalCenter.y)),
      );
    }
    const x = Number.isFinite(angularX) ? angularX : 0;
    const y = Number.isFinite(angularY) ? angularY : 0;
    let radial = Math.max(0, Number.isFinite(radialPixels) ? radialPixels : 0);
    const combined = Math.hypot(x, y) + radial;
    const scale = combined > 6 ? 6 / combined : 1;
    this.angularPixels.set(x * scale, y * scale);
    radial *= scale;
    this.uniforms.get('uRadialPixels').value = radial;
    this.uniforms.get('uEdgeStart').value = Math.max(0.4, Math.min(0.5, edgeStart));
    this.amount = amount;
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
