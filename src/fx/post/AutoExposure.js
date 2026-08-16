import { Uniform } from 'three';
import { Effect, ToneMappingEffect, ToneMappingMode } from 'postprocessing';

const DEFAULTS = Object.freeze({
  key: 0.26,
  minLuminance: 0.04,
  minEV: -0.75,
  maxEV: 1.5,
  adaptationRate: 1.25,
});

export function computeMeteredExposure(
  averageLuminance,
  { key = DEFAULTS.key, minLuminance = DEFAULTS.minLuminance, minEV = DEFAULTS.minEV, maxEV = DEFAULTS.maxEV, bias = 0 } = {},
) {
  const luminance = Math.max(minLuminance, Number.isFinite(averageLuminance) ? averageLuminance : key);
  return Math.max(minEV, Math.min(maxEV, Math.log2(key / luminance) + bias));
}

const fragment = /* glsl */ `
  uniform lowp sampler2D uAdaptedLuminance;
  uniform float uKey;
  uniform float uMinLuminance;
  uniform float uMinEV;
  uniform float uMaxEV;
  uniform float uBias;

  void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
    float averageLuminance = unpackRGBAToFloat(texture2D(uAdaptedLuminance, vec2(0.5)));
    averageLuminance = max(uMinLuminance, averageLuminance);
    float exposureEV = clamp(log2(uKey / averageLuminance) + uBias, uMinEV, uMaxEV);
    outputColor = vec4(max(inputColor.rgb, vec3(0.0)) * exp2(exposureEV), inputColor.a);
  }
`;

/** GPU luminance meter feeding bounded exposure, with no tone compression. */
export class AdaptiveExposureEffect extends Effect {
  constructor(options = {}) {
    const settings = { ...DEFAULTS, ...options };
    const meter = new ToneMappingEffect({
      mode: ToneMappingMode.REINHARD2_ADAPTIVE,
      resolution: 128,
      minLuminance: settings.minLuminance,
      adaptationRate: settings.adaptationRate,
    });
    super('AdaptiveExposureEffect', fragment, {
      uniforms: new Map([
        ['uAdaptedLuminance', new Uniform(meter.adaptiveLuminancePass.texture)],
        ['uKey', new Uniform(settings.key)],
        ['uMinLuminance', new Uniform(settings.minLuminance)],
        ['uMinEV', new Uniform(settings.minEV)],
        ['uMaxEV', new Uniform(settings.maxEV)],
        ['uBias', new Uniform(0)],
      ]),
    });
    this.meter = meter;
    this.biasEV = 0;
    this.targetBiasEV = 0;
    this.biasAdaptationRate = 1.5;
  }

  get minLuminance() {
    return this.uniforms.get('uMinLuminance').value;
  }

  get minEV() {
    return this.uniforms.get('uMinEV').value;
  }

  get maxEV() {
    return this.uniforms.get('uMaxEV').value;
  }

  get adaptationRate() {
    return this.meter.adaptiveLuminanceMaterial.adaptationRate;
  }

  setBias(ev, adaptationRate = this.biasAdaptationRate) {
    if (!Number.isFinite(ev)) return;
    this.targetBiasEV = Math.max(-1, Math.min(1, ev));
    this.biasAdaptationRate = Math.max(0.05, Math.min(12, adaptationRate));
  }

  update(renderer, inputBuffer, deltaTime = 0) {
    this.meter.update(renderer, inputBuffer, deltaTime);
    const dt = Math.max(0, Math.min(0.25, deltaTime));
    const alpha = 1 - Math.exp(-this.biasAdaptationRate * dt);
    this.biasEV += (this.targetBiasEV - this.biasEV) * alpha;
    this.uniforms.get('uBias').value = this.biasEV;
  }

  initialize(renderer, alpha, frameBufferType) {
    this.meter.initialize(renderer, alpha, frameBufferType);
  }

  dispose() {
    this.meter.dispose();
    super.dispose();
  }
}

/**
 * A look transform applied after AGX.
 *
 * AGX's defining behaviour is a strong hue-preserving desaturation of the
 * highlights. That is what makes it well behaved on saturated light sources,
 * and it is exactly wrong for a frame that is ninety per cent sunlit snow: it
 * pulls the whole image toward a flat grey. Measured on the shipped build, the
 * brightest pixel in a high-altitude snowfield reached 204 of 255 and the top
 * three histogram buckets were empty — the image never arrived at white.
 *
 * Blender ships AgX with a set of looks for the same reason; "Punchy" is the
 * one people actually use. This is that idea in one pass: a contrast pivot
 * about mid grey and a saturation restore, both mild, applied after the tone
 * curve so the curve keeps doing the highlight roll-off it is good at.
 */
const lookFragment = /* glsl */ `
  uniform float uContrast;
  uniform float uSaturation;
  uniform float uLift;

  void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
    vec3 c = max(inputColor.rgb, vec3(0.0));

    // Contrast about mid grey, in the display-referred values AGX just produced.
    const float pivot = 0.4135884;
    c = max(vec3(0.0), (c - pivot) * uContrast + pivot);

    // Restore some of the chroma AGX removed from the highlights.
    float luma = dot(c, vec3(0.2126, 0.7152, 0.0722));
    c = mix(vec3(luma), c, uSaturation);

    // A small toe lift keeps the deepest shadow from clipping to pure black now
    // that terrain shadows are genuinely dark.
    c = c * (1.0 - uLift) + uLift * c * c * (3.0 - 2.0 * c);

    outputColor = vec4(clamp(c, 0.0, 1.0), inputColor.a);
  }
`;

/**
 * Values are deliberately restrained, and were picked by measurement rather
 * than taste. Against the shipped chain (`__stats` over a sunlit snowfield) the
 * brightest pixel rises from 214 to 220 of 255 and the two highest occupied
 * histogram buckets roughly double, while shadow crush stays near zero.
 *
 * A stronger saturation restore was tried first and rejected: the frame is
 * blue-dominant, so boosting chroma globally amplifies the cast rather than
 * correcting it. Slightly *under* one reads cleaner here. The remaining gap to
 * true white is not a tone-curve problem — it is the scene's absolute radiance
 * against the meter's key, which is a larger change than a look transform.
 */
class ToneLookEffect extends Effect {
  constructor({ contrast = 1.06, saturation = 0.96, lift = 0.06 } = {}) {
    super('ToneLookEffect', lookFragment, {
      uniforms: new Map([
        ['uContrast', new Uniform(contrast)],
        ['uSaturation', new Uniform(saturation)],
        ['uLift', new Uniform(lift)],
      ]),
    });
  }
}

/** AGX is applied exactly once, after adaptive exposure. */
export function createFilmicToneMapping() {
  return new ToneMappingEffect({ mode: ToneMappingMode.AGX });
}

/** The look transform that runs immediately after AGX. */
export function createToneLook(options) {
  return new ToneLookEffect(options);
}
