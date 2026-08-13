/**
 * Quality tiers. Picked automatically from a short frame-time probe on first
 * run, overridable from the pause menu, persisted in localStorage.
 *
 * The knobs are ordered by cost: pixel ratio dominates, then cloud fill, then
 * the postprocessing chain.
 *
 * terrainRes is the exception and has to be set before Terrain is built, since
 * it fixes buffer sizes and shader constants. Dropping clipmap *levels* is
 * still refused — that shrinks view distance, the one thing this experience
 * cannot afford — but grid resolution is fair game: it costs vertices, not
 * range. Desktop measured 257 as free (the renderer is fragment-bound), and a
 * phone cannot afford the million triangles that produces.
 */

export const TIERS = {
  phone: {
    name: 'phone',
    label: 'Phone',
    pixelRatio: 0.7,
    maxPixelRatio: 1.0,
    bloom: false,
    smaa: false,
    cloudCount: 60,
    cloudLayers: 4,
    terrainDetail: 0.0,
    contrails: false,
    speedParticles: 120,
    terrainBudget: 1,
    terrainRes: 129,
    shadowSteps: 10,
  },
  low: {
    name: 'low',
    label: 'Low',
    pixelRatio: 0.75,
    maxPixelRatio: 1.0,
    bloom: false,
    smaa: false,
    cloudCount: 90,
    cloudLayers: 5,
    terrainDetail: 0.0,
    contrails: false,
    speedParticles: 220,
    terrainBudget: 2,
    terrainRes: 129,
    shadowSteps: 14,
  },
  medium: {
    name: 'medium',
    label: 'Medium',
    pixelRatio: 1.0,
    maxPixelRatio: 1.25,
    bloom: true,
    smaa: false,
    cloudCount: 190,
    cloudLayers: 7,
    terrainDetail: 0.7,
    contrails: true,
    speedParticles: 420,
    terrainBudget: 3,
    terrainRes: 193,
    shadowSteps: 18,
  },
  high: {
    name: 'high',
    label: 'High',
    pixelRatio: 1.0,
    maxPixelRatio: 1.5,
    bloom: true,
    smaa: true,
    cloudCount: 320,
    cloudLayers: 9,
    terrainDetail: 1.0,
    contrails: true,
    speedParticles: 700,
    terrainBudget: 4,
    terrainRes: 257,
    shadowSteps: 20,
  },
};

const KEY = 'safed-sagar.settings.v1';

export class Settings {
  constructor() {
    this.tierName = 'high';
    this.invertPitch = false;
    this.masterVolume = 0.8;
    this.musicVolume = 0.75;
    this.load();
  }

  get tier() {
    return TIERS[this.tierName] ?? TIERS.high;
  }

  setTier(name) {
    if (!TIERS[name]) return;
    this.tierName = name;
    this.save();
  }

  load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      if (TIERS[data.tierName]) this.tierName = data.tierName;
      if (typeof data.invertPitch === 'boolean') this.invertPitch = data.invertPitch;
      if (typeof data.masterVolume === 'number') this.masterVolume = data.masterVolume;
      if (typeof data.musicVolume === 'number') this.musicVolume = data.musicVolume;
      this.autoDetected = true;
    } catch {
      /* storage unavailable — defaults are fine */
    }
  }

  save() {
    try {
      localStorage.setItem(
        KEY,
        JSON.stringify({
          tierName: this.tierName,
          invertPitch: this.invertPitch,
          masterVolume: this.masterVolume,
          musicVolume: this.musicVolume,
        }),
      );
    } catch {
      /* ignore */
    }
  }
}

/**
 * Rough hardware guess used only when the player has never picked a tier.
 * Deliberately conservative: it is much better to start at medium and let the
 * adaptive resolution scaler climb than to open at high and stutter.
 */
/**
 * Is this a touch-first device?
 *
 * Deliberately a *capability* query rather than user-agent sniffing. The
 * pointer media query reports how accurate the primary input is, so a phone and
 * a tablet answer "coarse" while a laptop with a touchscreen still answers
 * "fine" — which is the distinction that matters, since that laptop wants the
 * desktop renderer and keyboard controls. maxTouchPoints is the fallback for
 * browsers that do not support the query.
 */
export function isTouchDevice() {
  const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false;
  const touch = (navigator.maxTouchPoints ?? 0) > 0;
  const noHover = window.matchMedia?.('(hover: none)').matches ?? false;
  return (coarse && touch) || (noHover && touch);
}

export function guessTier(renderer) {
  const gl = renderer.getContext();
  // WEBGL_debug_renderer_info is being withdrawn for fingerprinting reasons and
  // is already masked or absent in several browsers, so it is treated as a hint
  // when present rather than as the basis of the decision.
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const name = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : '';
  const lower = name.toLowerCase();

  // A phone is decided by input and screen, which are observable and not
  // masked. Getting this wrong in the safe direction costs some sharpness;
  // getting it wrong the other way hands a 1M-triangle scene to a phone.
  if (isTouchDevice()) {
    const wide = Math.max(window.screen?.width ?? 0, window.screen?.height ?? 0);
    const cores = navigator.hardwareConcurrency ?? 4;
    const roomy = wide >= 1024 && cores >= 6;
    return roomy ? 'low' : 'phone';
  }

  const integrated = /(intel|uhd graphics|iris|adreno|mali|apple a\d|powervr)/.test(lower);
  const strong = /(rtx|radeon rx|geforce (gtx|rtx) 1[06-9]|arc a|apple m[1-9])/.test(lower);

  if (strong) return 'high';
  if (integrated) return 'medium';
  if (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 4) return 'medium';
  return 'high';
}
