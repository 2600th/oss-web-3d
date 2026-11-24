/**
 * Pure maths for the crepuscular-ray passes (src/fx/post/godRays.js); no
 * three.js, unit-tested in src/fx/post-math.test.mjs.
 */

/**
 * Emitter-mask taps, as offsets in mask texels from the texel centre, for a
 * mask at `scale` of the frame: a 4x4 grid one source pixel apart (at scale
 * 1/4), shifted by half a source pixel so that every tap lands on the corner
 * shared by four source pixels and its bilinear fetch is the mean of that 2x2
 * footprint. The 16 footprints overlap (stride one pixel): see
 * footprintEmission() for why that matters.
 */
export function emitterTaps(scale = 0.25) {
  const taps = [];
  for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) taps.push([(i + 0.5) / 4 - 0.5 + scale / 2, (j + 0.5) / 4 - 0.5 + scale / 2]);
  return taps;
}

/**
 * One row of the emitter mask, summed: the light a row of source pixels with
 * exposed luminances `lums` emits when it is gathered in 2-pixel footprints
 * `stride` pixels apart, each emitting min(max(mean - floor, 0), cap), per
 * footprint of coverage (so the two strides are comparable).
 *
 * stride 2 is what the mask used to do (side-by-side footprints): a feature
 * two pixels wide and far brighter than the cap fills one footprint or
 * straddles two, and emits `cap` or `2 * cap` depending on which. The sun's
 * disc and every thin lit cloud rim are such features, and the frame they are
 * read from moves by a sub-pixel amount every frame.
 * stride 1 (overlapping footprints, what emitterTaps() lays out): the same
 * feature always touches three footprints. Same mean brightness as stride 2
 * averaged over all alignments, none of the alignment dependence.
 */
export function footprintEmission(lums, stride, floor, cap) {
  let sum = 0;
  for (let i = 0; i + 1 < lums.length; i += stride) {
    sum += Math.min(Math.max((lums[i] + lums[i + 1]) / 2 - floor, 0), cap);
  }
  return sum * stride / 2;
}

/** Weight of the newest frame in the emitter accumulation (about 7 frames of memory). */
export const EMITTER_BLEND = 0.14;

/** Blend weight for this frame: 1 restarts the history (cut, resize, first frame after a gap). */
export function emitterBlend(restart) {
  return restart ? 1 : EMITTER_BLEND;
}

/**
 * Mip level of the emitter mask to read for a march whose taps are
 * `stepTexels` mask texels apart: the level whose texel is one step long
 * (level L texels are 2^L wide), so that with trilinear filtering consecutive
 * taps overlap and no emitter between two taps is stepped over. Never below 0.
 */
export function rayMarchLod(stepTexels) {
  return Math.log2(Math.max(stepTexels, 1));
}

/**
 * Share of an emitter one mask texel wide that a march with taps `stepTexels`
 * apart collects, as a function of where the emitter sits between two taps
 * (`phase` 0..1), reading the mask at mip `lod` with linear filtering between
 * texels (a tent of half-width 2^lod around each tap). 1 / stepTexels is the
 * true share. At level 0 the share swings between 0 and 1 with the phase (a
 * tap hits the emitter or steps over it); at rayMarchLod() it is constant.
 */
export function rayTapShare(stepTexels, phase, lod) {
  const half = Math.max(1, 2 ** lod); // tent half-width in texels
  let sum = 0;
  for (let k = -4; k <= 4; k++) {
    const d = Math.abs((k + phase) * stepTexels); // distance from tap k to the emitter
    sum += Math.max(0, 1 - d / half) / half; // tent, normalised to unit area
  }
  return sum;
}
