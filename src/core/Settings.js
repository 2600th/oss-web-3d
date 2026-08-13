/**
 * Quality tiers. Picked automatically from a short frame-time probe on first
 * run, overridable from the pause menu, persisted in localStorage.
 *
 * The knobs are ordered by cost: pixel ratio dominates, then cloud fill, then
 * the postprocessing chain. Terrain triangle count is deliberately *not* a
 * knob — the clipmap is already fixed-cost and dropping levels would shrink
 * the view distance, which is the one thing this experience cannot afford.
 */

export const TIERS = {
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
export function guessTier(renderer) {
  const gl = renderer.getContext();
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const name = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : '';
  const lower = name.toLowerCase();

  const integrated = /(intel|uhd graphics|iris|adreno|mali|apple a\d|powervr)/.test(lower);
  const strong = /(rtx|radeon rx|geforce gtx 1[06-9]|arc a|apple m[1-9])/.test(lower);

  if (strong) return 'high';
  if (integrated) return 'medium';
  if (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 4) return 'medium';
  return 'high';
}
