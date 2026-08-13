import { Effect } from 'postprocessing';

/**
 * Triangular-distributed interleaved-gradient dither, applied last.
 *
 * A high-altitude sky is the worst case an 8-bit framebuffer sees: a smooth
 * gradient across most of the frame, with no texture detail to hide the steps.
 * Quantising it produces visible bands, and once seen they are the single most
 * reliable tell that something was rendered in a browser rather than shipped.
 *
 * Three choices here, all deliberate:
 *
 * Interleaved gradient noise rather than an ordered Bayer matrix. Bayer leaves
 * a regular cross-hatch that is itself visible on a large flat gradient, and it
 * crawls when the camera moves. IGN is a single dot-product-and-fract, needs no
 * lookup texture (this project ships no assets), and looks like film grain
 * rather than like a pattern.
 *
 * Triangular distribution rather than uniform. Uniform dither of one LSB leaves
 * the noise level dependent on where the signal sits between two quantisation
 * steps, so flat regions still show structure. Subtracting two independent
 * samples gives a triangular PDF, which decouples the noise from the signal at
 * the cost of one extra fract.
 *
 * Applied after tone mapping, in the final pass. Dither added before tone
 * mapping is compressed by the curve along with everything else, which is
 * exactly the amplitude it needed to keep.
 *
 * Cost is a handful of ALU with no extra render target, which matters on the
 * tile-based GPUs in phones where a full-screen pass costs real bandwidth.
 */
const fragment = /* glsl */ `
  uniform float uStrength;

  float ign(vec2 p) {
    return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
  }

  void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
    vec2 p = uv * resolution;
    // Two decorrelated samples; their difference is triangular on [-1, 1].
    float n = ign(p) - ign(p + vec2(37.0, 17.0));
    outputColor = vec4(inputColor.rgb + n * uStrength, inputColor.a);
  }
`;

export class DitherEffect extends Effect {
  /** @param {number} strength amplitude in output units; 1/255 is one 8-bit step */
  constructor(strength = 1 / 255) {
    super('DitherEffect', fragment, {
      uniforms: new Map([['uStrength', { value: strength }]]),
    });
  }

  get strength() {
    return this.uniforms.get('uStrength').value;
  }

  set strength(v) {
    this.uniforms.get('uStrength').value = v;
  }
}
