// Heightfield shadow sweep (worker).
//
// For a sun direction, one pass over the DEM computes at every texel how far the
// ground lies below the shadow boundary cast by everything between it and the
// sun: positive = in shadow by that many metres, negative = lit with that much
// clearance. Sweeping one texel line at a time from the sun side, each texel
// takes the boundary height from its sunward neighbours (interpolated across the
// minor axis) lowered by the sun's descent over one step:
//
//   S(p) = max(h, S)(p + step toward sun) - |step| * tan(elevation)
//
// O(texels), exact for any azimuth up to the interpolation, and it yields a
// signed, smooth field that the shader thresholds — so ridge shadows many
// kilometres long cost one texture fetch per pixel.
import { SHADOW_MIN, SHADOW_STEP } from './shadowConst.js';

let H = null;
let n = 0;
let cellX = 1;
let cellZ = 1;

function sweep(dir) {
  const out = new Uint8Array(n * n);
  const horiz = Math.hypot(dir[0], dir[2]);
  if (dir[1] <= 0.002) { out.fill(255); return out; }
  if (horiz < 1e-4) return out; // sun at the zenith: nothing is shadowed
  const tan = dir[1] / horiz;
  const gx = dir[0] / horiz / cellX; // texels per metre travelled toward the sun
  const gz = dir[2] / horiz / cellZ;
  const majorX = Math.abs(gx) >= Math.abs(gz);
  const sign = (majorX ? gx : gz) > 0 ? 1 : -1;
  const minor = majorX ? gz / Math.abs(gx) : gx / Math.abs(gz); // texels across per line
  const stepLen = majorX ? Math.hypot(cellX, minor * cellZ) : Math.hypot(cellZ, minor * cellX);
  const drop = stepLen * tan;
  let prev = new Float32Array(n).fill(-1e9); // max(h, S) on the sunward line
  let cur = new Float32Array(n);
  const inv = 1 / SHADOW_STEP;
  for (let q = 0; q < n; q++) {
    const line = sign > 0 ? n - 1 - q : q;
    for (let c = 0; c < n; c++) {
      const f = c + minor;
      const c0 = Math.floor(f);
      let s = -1e9;
      if (q > 0 && c0 >= 0 && c0 < n - 1) {
        const t = f - c0;
        s = prev[c0] + (prev[c0 + 1] - prev[c0]) * t - drop;
      } else if (q > 0 && c0 === n - 1 && f === c0) {
        s = prev[c0] - drop;
      }
      const k = majorX ? c * n + line : line * n + c;
      const h = H[k];
      const v = (s - h - SHADOW_MIN) * inv;
      out[k] = v <= 0 ? 0 : v >= 255 ? 255 : v;
      cur[c] = s > h ? s : h;
    }
    const tmp = prev; prev = cur; cur = tmp;
  }
  return out;
}

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'init') {
    H = m.heights; n = m.res; cellX = m.cellX; cellZ = m.cellZ;
  } else if (m.type === 'sweep') {
    const data = sweep(m.dir);
    self.postMessage({ type: 'done', id: m.id, data }, [data.buffer]);
  }
};
