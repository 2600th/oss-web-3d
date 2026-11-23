// Per-texel ground data derived from the DEM at full resolution (pure, no
// three.js: runs in groundWorker.js and in the tests).
//
// One RGBA8 texel per DEM node, stored as the third layer of the terrain's
// `land` array texture (textures.js) next to `surf` and `river`:
//
//   R  near sky visibility: a horizon scan over the first ~230 m (29 m steps
//      on the hi pack) measured *above the local tangent plane*, so a plain
//      slope is 1 and only concave ground (gully floors, the foot of a slope,
//      valley bottoms under their walls) is occluded. The pack's own `ao`
//      plane is a half-resolution scan from 58 m to 3.7 km that already
//      carries the slope's own occlusion; the shader multiplies the two.
//   G  debris fan: ground of moderate slope with much steeper ground above it
//      within ~150 m: where scree, talus and boulders come to rest
//   B  moisture: the metres beside every mapped channel and the seepage lines
//      of the larger side nallahs, thinning with height
//   A  irrigated-field suitability: flat alluvial ground near a river, low
//      enough to farm, outside the bed
//
// Everything is smooth at the scale of a texel so it filters well.

const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Horizon scan geometry: 8 directions, steps in texels. */
export const NEAR_DIRS = 8;
export const NEAR_STEPS = [1, 2, 3, 5, 8];

/**
 * @param {object} o
 * @param {Float32Array} o.H        heights (m), n x n, row 0 = minZ
 * @param {number} o.n
 * @param {number} o.cellX, o.cellZ metres per texel
 * @param {Uint8Array} [o.river]    bank distance, n x n: metres = byte * riverStep + riverMin
 * @param {number} [o.riverMin], [o.riverStep]
 * @param {Uint8Array} [o.drain]    half resolution log10 km^2 code (0 = none)
 * @param {number} [o.drainMin], [o.drainMax] log10 range of the drain code
 * @returns {Uint8Array} n * n * 4
 */
export function buildGroundData({ H, n, cellX, cellZ, river = null, riverMin = -40, riverStep = 0.5, drain = null, drainMin = -0.3, drainMax = 5 }) {
  const out = new Uint8Array(n * n * 4);
  const m = (n - 1) / 2 + 1;
  // direction table: integer offsets per step and 1 / horizontal distance
  const offs = [];
  const dirs = [];
  for (let d = 0; d < NEAR_DIRS; d++) {
    const a = ((d + 0.5) / NEAR_DIRS) * Math.PI * 2;
    const dx = Math.cos(a);
    const dz = Math.sin(a);
    dirs.push(dx, dz);
    for (const s of NEAR_STEPS) {
      const di = Math.round(dx * s);
      const dj = Math.round(dz * s);
      offs.push(di, dj, 1 / Math.hypot(di * cellX, dj * cellZ));
    }
  }
  const S = NEAR_STEPS.length;
  const fan = new Float32Array(n * n);
  const wet = new Float32Array(n * n);
  const field = new Float32Array(n * n);
  const vis = new Float32Array(n * n);
  const tanAt = new Float32Array(n * n);

  for (let j = 0; j < n; j++) {
    const jm = j > 0 ? j - 1 : j;
    const jp = j < n - 1 ? j + 1 : j;
    for (let i = 0; i < n; i++) {
      const k = j * n + i;
      const h0 = H[k];
      const im = i > 0 ? i - 1 : i;
      const ip = i < n - 1 ? i + 1 : i;
      const gx = (H[j * n + ip] - H[j * n + im]) / ((ip - im) * cellX || 1);
      const gz = (H[jp * n + i] - H[jm * n + i]) / ((jp - jm) * cellZ || 1);
      const tan = Math.hypot(gx, gz);
      tanAt[k] = tan;
      let v = 0;
      let up = 0;
      for (let d = 0; d < NEAR_DIRS; d++) {
        const along = gx * dirs[d * 2] + gz * dirs[d * 2 + 1]; // the tangent plane's rise this way
        let t = -1e9;
        for (let s = 0; s < S; s++) {
          const o = (d * S + s) * 3;
          let ii = i + offs[o];
          let jj = j + offs[o + 1];
          ii = ii < 0 ? 0 : ii >= n ? n - 1 : ii;
          jj = jj < 0 ? 0 : jj >= n ? n - 1 : jj;
          const r = (H[jj * n + ii] - h0) * offs[o + 2];
          if (r > t) t = r;
        }
        if (t > up) up = t;
        const rel = Math.max(0, t - Math.max(along, 0));
        v += 1 / (1 + rel * rel);
      }
      vis[k] = v / NEAR_DIRS;
      // steep ground above, gentler ground here, and a clear break between them
      fan[k] = smooth(0.5, 0.95, up) * (1 - smooth(0.6, 0.95, tan)) * smooth(0.1, 0.35, up - tan);

      // moisture: beside channels, and the seepage lines of larger side nallahs
      let w = 0;
      if (river) {
        const edge = river[k] * riverStep + riverMin;
        w = smooth(70, 3, edge);
      }
      if (drain) {
        const hi = Math.min(m - 1, i >> 1);
        const hj = Math.min(m - 1, j >> 1);
        const code = drain[hj * m + hi];
        if (code > 0) {
          const lg = drainMin + (code / 255) * (drainMax - drainMin);
          w = Math.max(w, smooth(0.2, 1.6, lg) * 0.75 * (1 - smooth(0.4, 0.85, tan)));
        }
      }
      wet[k] = w * (1 - smooth(3900, 4700, h0));

      // irrigated fields: flat, low, near a river but out of its bed
      if (river) {
        const edge = river[k] * riverStep + riverMin;
        field[k] = smooth(14, 32, edge) * smooth(900, 250, edge) * (1 - smooth(3450, 3750, h0));
      }
    }
  }
  // fields want flat ground over a few texels, not one level texel on a slope
  const flat = blur(tanAt, n, 2);
  for (let k = 0; k < n * n; k++) field[k] *= 1 - smooth(0.04, 0.11, flat[k]);
  const fanB = blur(fan, n, 1);
  const wetB = blur(wet, n, 1);
  const fieldB = blur(field, n, 1);
  for (let k = 0; k < n * n; k++) {
    out[k * 4] = Math.round(Math.min(1, vis[k]) * 255);
    out[k * 4 + 1] = Math.round(Math.min(1, fanB[k]) * 255);
    out[k * 4 + 2] = Math.round(Math.min(1, wetB[k]) * 255);
    out[k * 4 + 3] = Math.round(Math.min(1, fieldB[k]) * 255);
  }
  return out;
}

/** Separable box blur (radius r, edge-clamped) into a new array. */
export function blur(f, n, r) {
  const tmp = new Float32Array(n * n);
  const res = new Float32Array(n * n);
  const w = 2 * r + 1;
  for (let j = 0; j < n; j++) {
    const row = j * n;
    for (let i = 0; i < n; i++) {
      let a = 0;
      for (let o = -r; o <= r; o++) a += f[row + Math.min(n - 1, Math.max(0, i + o))];
      tmp[row + i] = a / w;
    }
  }
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      let a = 0;
      for (let o = -r; o <= r; o++) a += tmp[Math.min(n - 1, Math.max(0, j + o)) * n + i];
      res[j * n + i] = a / w;
    }
  }
  return res;
}

/** Neutral texel used until the worker has filled the layer (open, dry, no fan, no field). */
export const GROUND_NEUTRAL = [255, 0, 0, 0];
