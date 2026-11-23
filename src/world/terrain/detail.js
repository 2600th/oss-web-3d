// Shared description of everything the height function adds to the raw DEM.
// heightfield.js (CPU) and Terrain.js (TSL) both build from these numbers, so
// the two cannot drift apart: change a constant here and both follow.
//
// The detail tile is a 512^2 periodic eroded heightfield with values in about
// [-1, 1] (tools/terrain/detail-tile.mjs). A "layer" samples it at world
// position p as tile(rot(p) / size + offset).

export const TILE_SIZE = 512;

const layer = (size, angle, ox = 0, oz = 0) => ({
  size, angle, cos: Math.cos(angle), sin: Math.sin(angle), ox, oz,
});

/**
 * Sub-DEM displacement. With ab = mix(A, B, mask):
 *   height added = amp(x,z) * (ab + C_GAIN * C
 *                  + LEDGE * smoothstep(LEDGE_LO, LEDGE_HI, ab) * smoothstep(LEDGE_GATE_LO, LEDGE_GATE_HI, C))
 * The ledge term turns one contour band of the eroded field into a step, broken
 * up by the finer layer, which reads as rock ribs and outcrops standing out of
 * the scree rather than as continuous contour lines.
 */
export const DETAIL = {
  A: layer(768, 0.0),
  B: layer(613, 1.1, 0.37, 0.11),
  /** Low-frequency selector between A and B: hides the repeat of either. */
  MASK: layer(5200, 0.5, 0.21, 0.63),
  MASK_EDGE: 0.3,
  C: layer(192, 2.3, 0.71, 0.29),
  C_GAIN: 0.28,
  LEDGE: 0.5,
  LEDGE_LO: 0.1,
  LEDGE_HI: 0.3,
  LEDGE_GATE_LO: -0.15,
  LEDGE_GATE_HI: 0.45,
  /** Shading-only layer (too small to displace; it only bends the normal). */
  D: layer(47, 0.9, 0.13, 0.57),
  D_GAIN: 0.07,
};

/** Metres of displacement at amp byte 255. */
export const AMP_MAX = 10;
/** Displacement amplitude (m) outside the DEM, where there is no slope data. */
export const AMP_OUTSIDE = 5;

/** Procedural mountains beyond the measured terrain. */
export const SURROUND = {
  BASE: 4450,
  L0: layer(88000, 0.35, 0.18, 0.44),
  G0: 2300,
  L1: layer(29000, 1.3, 0.61, 0.07),
  G1: 900,
  L2: layer(9500, 2.1, 0.33, 0.79),
  G2: 260,
};

/** Width (m) of the seam where the inner DEM hands over to the outer one. */
export const INNER_BLEND = 1200;
/** Width (m) over which the outer DEM fades into procedural mountains. */
export const OUTER_BLEND = 9000;

/** Tile coordinates (in tiles) of world point (x, z) for a layer. */
export function layerUV(L, x, z, out) {
  out[0] = (x * L.cos - z * L.sin) / L.size + L.ox;
  out[1] = (x * L.sin + z * L.cos) / L.size + L.oz;
  return out;
}
