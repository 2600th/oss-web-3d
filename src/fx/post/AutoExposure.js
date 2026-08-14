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

/** AGX is applied exactly once, after adaptive exposure. */
export function createFilmicToneMapping() {
  return new ToneMappingEffect({ mode: ToneMappingMode.AGX });
}
