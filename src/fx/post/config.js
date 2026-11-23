/**
 * Post-chain settings per quality tier. PostFX reads `postConfig(tier)` at
 * build time; a tier change rebuilds the pipeline.
 *
 * aa:        'traa' (temporal, needs the velocity MRT) | 'fxaa' | 'smaa' | 'none'
 * mbSamples: reconstruction motion-blur taps (0 = off)
 * mbTile:    blur radius clamp / tile size in px (multiple of 4)
 * sharpen:   post-TAA contrast-adaptive sharpen strength (0 = off)
 * meter:     auto-exposure meter resolution (first reduction level)
 * flareGrid: sun-occlusion samples per axis (n x n around the sun)
 * water:     screen-water simulation size [w, h] (null = off)
 * dof:       depth of field for cinematic / kill cams
 * streaks:   transonic airflow streaks
 */
export const POST_TIERS = {
  low: {
    aa: 'fxaa', mbSamples: 0, mbTile: 16, bloom: true, bloomRadius: 0.5, sharpen: 0,
    flare: true, flareGrid: 4, dirt: false, chromatic: 0, grain: 0.6,
    meter: [32, 18], water: [320, 180], dof: false, streaks: true,
  },
  medium: {
    aa: 'traa', mbSamples: 10, mbTile: 24, bloom: true, bloomRadius: 0.55, sharpen: 0.22,
    flare: true, flareGrid: 6, dirt: true, chromatic: 0.7, grain: 1,
    meter: [64, 36], water: [400, 225], dof: true, streaks: true,
  },
  high: {
    aa: 'traa', mbSamples: 14, mbTile: 32, bloom: true, bloomRadius: 0.6, sharpen: 0.25,
    flare: true, flareGrid: 8, dirt: true, chromatic: 1, grain: 1,
    meter: [64, 36], water: [480, 270], dof: true, streaks: true,
  },
  ultra: {
    aa: 'traa', mbSamples: 18, mbTile: 40, bloom: true, bloomRadius: 0.6, sharpen: 0.25,
    flare: true, flareGrid: 8, dirt: true, chromatic: 1, grain: 1,
    meter: [64, 36], water: [640, 360], dof: true, streaks: true,
  },
};

export function postConfig(tier) {
  const base = POST_TIERS[tier?.name] ?? POST_TIERS.high;
  const cfg = { ...base };
  // The shared Quality tier flags win: a tier that turns TAA or motion blur
  // off elsewhere must not get it here.
  if (tier && tier.taa === false && cfg.aa === 'traa') cfg.aa = 'fxaa';
  if (tier && tier.motionBlur === false) cfg.mbSamples = 0;
  if (tier && tier.bloom === false) cfg.bloom = false;
  const q = typeof location !== 'undefined' ? new URLSearchParams(location.search) : null;
  const aa = q?.get('aa');
  if (aa && ['traa', 'fxaa', 'smaa', 'none'].includes(aa)) cfg.aa = aa;
  if (q?.has('nowater')) cfg.water = null;
  if (q?.has('nodof')) cfg.dof = false;
  return cfg;
}
