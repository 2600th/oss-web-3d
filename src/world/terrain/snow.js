// Snow line and snow cover: the numbers the terrain shader (material.js) and
// the CPU twin (`siteSnow` in src/assets/system.js, which paints the berms
// under emplacements) both build from, so the two cannot drift apart.
//
//   line  = LINE + ASPECT * n.z - CURV * clamp(curv, CURV_LO, CURV_HI)
//           + MACRO * macro + DETAIL * hDet + STREAK * streak
//   raw   = smoothstep(-BAND, BAND, alt - line)
//           * (1 - smoothstep(SHED_LO, SHED_HI, tan + SHED_DET * hDet))
//           - smoothstep(STEEP_LO, STEEP_HI, tan) * STEEP
//   cover = smoothstep(COVER_LO, COVER_HI, raw + local terms)
//
// n.z: the ground normal's south component (sun-facing slopes hold less);
// curv: DEM curvature (> 0 hollow); macro: the detail field's 5.2 km mask
// layer; hDet: the unit sub-DEM detail height; streak: the fall-line streak
// term (gullies hold snow, ribs shed it).
export const SNOW = {
  LINE: 4760,
  ASPECT: 380,
  CURV: 1500,
  CURV_LO: -0.12,
  CURV_HI: 0.2,
  MACRO: 230,
  DETAIL: 55,
  STREAK: 160,
  BAND: 90,
  SHED_LO: 0.8,
  SHED_HI: 1.35,
  SHED_DET: 0.22,
  STEEP_LO: 0.45,
  STEEP_HI: 0.95,
  STEEP: 0.3,
  COVER_LO: 0.32,
  COVER_HI: 0.68,
  /** [terrain-2] patchiness: metres of line shift from the 60 m noise near the line. */
  PATCH: 70,
};

const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Altitude of the snow line (m) for the given local terms (CPU twin of the shader). */
export function snowLine({ nz = 0, curv = 0, macro = 0, hDet = 0, streak = 0, patch = 0 }) {
  return SNOW.LINE + nz * SNOW.ASPECT - Math.max(SNOW.CURV_LO, Math.min(SNOW.CURV_HI, curv)) * SNOW.CURV
    + macro * SNOW.MACRO + hDet * SNOW.DETAIL + streak * SNOW.STREAK + patch * SNOW.PATCH;
}

/** Snow cover 0..1 (before the shader's per-pixel height and cavity terms, whose mean is ~0). */
export function snowCover({ alt, tan = 0, ...terms }) {
  const raw = smooth(-SNOW.BAND, SNOW.BAND, alt - snowLine(terms))
    * (1 - smooth(SNOW.SHED_LO, SNOW.SHED_HI, tan + (terms.hDet ?? 0) * SNOW.SHED_DET))
    - smooth(SNOW.STEEP_LO, SNOW.STEEP_HI, tan) * SNOW.STEEP;
  return smooth(SNOW.COVER_LO, SNOW.COVER_HI, raw);
}
