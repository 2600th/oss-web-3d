// Periodic eroded detail heightfield.
//
// One 512^2 tile, generated deterministically: ridged fractal noise with domain
// warping on a wrapping lattice, then particle-based hydraulic erosion (the
// droplet scheme described by Hans T. Beyer, "Implementation of a method for
// hydraulic erosion", 2015) with wrap-around, then a high-pass so the tile
// carries no energy below ~3 cycles and can be layered at several scales without
// a visible repeat. The runtime samples it (CPU and GPU, identically) for
// sub-DEM displacement and for the mountains beyond the DEM.
//
// Output: Uint16Array, value = 32768 + h * 20000 with h roughly in [-1, 1].

function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash2(i, j, seed) {
  let h = Math.imul(i, 0x27d4eb2d) ^ Math.imul(j, 0x165667b1) ^ seed;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Periodic gradient noise, `period` lattice cells across the unit square, ~[-1,1]. */
function pnoise(u, v, period, seed) {
  const x = u * period;
  const y = v * period;
  const i = Math.floor(x);
  const j = Math.floor(y);
  const fx = x - i;
  const fy = y - j;
  const sx = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const sy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const g = (a, b, dx, dy) => {
    const ang = hash2(((a % period) + period) % period, ((b % period) + period) % period, seed) * Math.PI * 2;
    return Math.cos(ang) * dx + Math.sin(ang) * dy;
  };
  const a = g(i, j, fx, fy);
  const b = g(i + 1, j, fx - 1, fy);
  const c = g(i, j + 1, fx, fy - 1);
  const d = g(i + 1, j + 1, fx - 1, fy - 1);
  return (a + (b - a) * sx + (c + (d - c) * sx - (a + (b - a) * sx)) * sy) * 1.5;
}

export function buildDetailTile(N = 512) {
  const h = new Float32Array(N * N);
  // --- ridged multifractal with a periodic domain warp
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    let u = i / N;
    let v = j / N;
    const wu = pnoise(u, v, 3, 11) * 0.035 + pnoise(u, v, 7, 12) * 0.012;
    const wv = pnoise(u, v, 3, 13) * 0.035 + pnoise(u, v, 7, 14) * 0.012;
    u += wu; v += wv;
    let sum = 0;
    let amp = 1;
    let weight = 1;
    let period = 4;
    for (let o = 0; o < 6; o++) {
      let r = 1 - Math.abs(pnoise(u, v, period, 100 + o));
      r *= r;
      r *= weight;
      weight = Math.min(1, Math.max(0, r * 1.6));
      sum += r * amp;
      amp *= 0.5;
      period *= 2;
    }
    h[j * N + i] = sum * 26; // in texels: relief ~ 40 texels across the tile
  }

  // --- hydraulic erosion (droplets), wrapping
  const rnd = mulberry32(1999);
  const R = 3;
  const brush = [];
  let bsum = 0;
  for (let b = -R; b <= R; b++) for (let a = -R; a <= R; a++) {
    const d = Math.hypot(a, b);
    if (d > R) continue;
    brush.push(a, b, 1 - d / R);
    bsum += 1 - d / R;
  }
  const wrap = (x) => ((x % N) + N) % N;
  const sampleGrad = (x, y, out) => {
    const i = Math.floor(x);
    const j = Math.floor(y);
    const fx = x - i;
    const fy = y - j;
    const i0 = wrap(i);
    const i1 = wrap(i + 1);
    const j0 = wrap(j);
    const j1 = wrap(j + 1);
    const a = h[j0 * N + i0];
    const b = h[j0 * N + i1];
    const c = h[j1 * N + i0];
    const d = h[j1 * N + i1];
    out.gx = (b - a) * (1 - fy) + (d - c) * fy;
    out.gy = (c - a) * (1 - fx) + (d - b) * fx;
    out.h = a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy;
  };
  const g = { gx: 0, gy: 0, h: 0 };
  const DROPS = 260000;
  for (let n = 0; n < DROPS; n++) {
    let x = rnd() * N;
    let y = rnd() * N;
    let dx = 0;
    let dy = 0;
    let speed = 1;
    let water = 1;
    let sediment = 0;
    for (let life = 0; life < 56; life++) {
      sampleGrad(x, y, g);
      const h0 = g.h;
      dx = dx * 0.06 - g.gx * 0.94;
      dy = dy * 0.06 - g.gy * 0.94;
      const len = Math.hypot(dx, dy);
      if (len < 1e-7) break;
      dx /= len; dy /= len;
      const ox = x;
      const oy = y;
      x += dx; y += dy;
      sampleGrad(x, y, g);
      const dh = g.h - h0;
      const cap = Math.max(-dh, 0.01) * speed * water * 5;
      const i = wrap(Math.floor(ox));
      const j = wrap(Math.floor(oy));
      if (sediment > cap || dh > 0) {
        const dep = dh > 0 ? Math.min(dh, sediment) : (sediment - cap) * 0.3;
        sediment -= dep;
        const fx = ox - Math.floor(ox);
        const fy = oy - Math.floor(oy);
        h[j * N + i] += dep * (1 - fx) * (1 - fy);
        h[j * N + wrap(i + 1)] += dep * fx * (1 - fy);
        h[wrap(j + 1) * N + i] += dep * (1 - fx) * fy;
        h[wrap(j + 1) * N + wrap(i + 1)] += dep * fx * fy;
      } else {
        const er = Math.min((cap - sediment) * 0.3, -dh);
        for (let q = 0; q < brush.length; q += 3) {
          h[wrap(j + brush[q + 1]) * N + wrap(i + brush[q])] -= (er * brush[q + 2]) / bsum;
        }
        sediment += er;
      }
      speed = Math.sqrt(Math.max(0, speed * speed - dh * 4));
      water *= 0.985;
    }
  }

  // --- high-pass: remove everything below ~3 cycles per tile (separable periodic box blurs)
  const blur = (src, radius) => {
    const tmp = new Float32Array(N * N);
    const out = new Float32Array(N * N);
    const w = 2 * radius + 1;
    for (let j = 0; j < N; j++) {
      let acc = 0;
      for (let a = -radius; a <= radius; a++) acc += src[j * N + wrap(a)];
      for (let i = 0; i < N; i++) {
        tmp[j * N + i] = acc / w;
        acc += src[j * N + wrap(i + radius + 1)] - src[j * N + wrap(i - radius)];
      }
    }
    for (let i = 0; i < N; i++) {
      let acc = 0;
      for (let a = -radius; a <= radius; a++) acc += tmp[wrap(a) * N + i];
      for (let j = 0; j < N; j++) {
        out[j * N + i] = acc / w;
        acc += tmp[wrap(j + radius + 1) * N + i] - tmp[wrap(j - radius) * N + i];
      }
    }
    return out;
  };
  let low = h;
  for (let p = 0; p < 3; p++) low = blur(low, 36);
  let mean = 0;
  for (let k = 0; k < h.length; k++) { h[k] -= low[k]; mean += h[k]; }
  mean /= h.length;
  const abs = new Float32Array(h.length);
  for (let k = 0; k < h.length; k++) { h[k] -= mean; abs[k] = Math.abs(h[k]); }
  abs.sort();
  const norm = abs[Math.floor(abs.length * 0.995)];
  const SCALE = 20000;
  const data = new Uint16Array(N * N);
  for (let k = 0; k < h.length; k++) {
    data[k] = Math.min(65535, Math.max(0, Math.round(32768 + (h[k] / norm) * SCALE)));
  }
  return { data, scale: 1 / SCALE, size: N };
}
