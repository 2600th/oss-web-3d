/**
 * Quality tiers. Every system reads its budget from here so a tier change is
 * one switch. `ultra` targets a desktop discrete GPU at 1440p/60+; `low` targets
 * integrated GPUs and phones, including the WebGL2 fallback backend.
 *
 * `ssao`: near-field GTAO on indirect light (src/fx/post/ambientOcclusion.js);
 * WebGPU only, sized per tier in src/fx/post/config.js (`ao`).
 */
export const QUALITY = {
  low: {
    name: 'low', maxPixelRatio: 1, shadowMapSize: 1024, shadowCascades: 2,
    terrainGrid: 96, terrainLevels: 9, cloudSteps: 32, cloudScale: 0.25,
    particlesMax: 20000, bloom: true, motionBlur: false, ssao: false, taa: false,
  },
  medium: {
    name: 'medium', maxPixelRatio: 1.25, shadowMapSize: 2048, shadowCascades: 3,
    terrainGrid: 128, terrainLevels: 10, cloudSteps: 48, cloudScale: 0.35,
    // [realism] ssao on medium is the cheap variant (aircraft and units only,
    // 160 m, 8 samples; src/fx/post/config.js): under 0.07 ms at 1440p
    particlesMax: 60000, bloom: true, motionBlur: true, ssao: true, taa: true,
  },
  high: {
    name: 'high', maxPixelRatio: 1.5, shadowMapSize: 2048, shadowCascades: 4,
    terrainGrid: 160, terrainLevels: 11, cloudSteps: 64, cloudScale: 0.5,
    particlesMax: 120000, bloom: true, motionBlur: true, ssao: true, taa: true,
  },
  ultra: {
    name: 'ultra', maxPixelRatio: 2, shadowMapSize: 4096, shadowCascades: 4,
    terrainGrid: 192, terrainLevels: 12, cloudSteps: 96, cloudScale: 0.5,
    particlesMax: 250000, bloom: true, motionBlur: true, ssao: true, taa: true,
  },
};

export function pickTier(backend) {
  const q = new URLSearchParams(location.search).get('quality');
  if (q && QUALITY[q]) return q;
  // [ui] The player's saved choice (src/core/Settings.js, key `tier`; null =
  // auto). Read here because terrain buffers are sized from the tier before
  // any system exists, so a settings change can only fully apply on reload.
  try {
    const saved = JSON.parse(localStorage.getItem('safed-sagar.settings.v3') ?? 'null')?.tier;
    if (saved && QUALITY[saved]) return saved;
  } catch { /* storage unavailable: fall through to auto */ }
  if (backend !== 'webgpu') return 'low';
  const coarse = matchMedia('(pointer: coarse)').matches;
  if (coarse) return 'low';
  return 'high';
}
