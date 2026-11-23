// Offline generator for the VFX textures (run: `node tools/vfx/gen-textures.mjs`).
//
//  public/assets/vfx/smoke6_a.png  RGBA = light from +X (right), +Y (top), +Z (front, toward camera), alpha
//  public/assets/vfx/smoke6_b.png  RGBA = light from -X (left),  -Y (bottom), -Z (back),              core thickness
//  public/assets/vfx/noise.png     RGBA = tileable perlin fbm, billow (inverted worley), fine perlin, fine worley
//
// The smoke atlas is a real "six-way lightmap" set (the technique used by Unity
// VFX Graph / Houdini-baked smoke): each of the 4x4 cells is a small procedural
// density volume, lit from the six axis directions with self-shadowing, then
// integrated along the view axis. At runtime the six maps are weighted by the
// sun direction in sprite space, which gives smoke a lit and a shadowed side,
// rim light when backlit, and a soft interior — with one texture fetch pair.
// Lighting channels are stored premultiplied by alpha.
import sharp from 'sharp';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '../../public/assets/vfx');
mkdirSync(OUT, { recursive: true });

// ---------- deterministic rng / hashing ----------
function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hash3(x, y, z, s) {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 2147483647) ^ Math.imul(s, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
const mod = (a, n) => ((a % n) + n) % n;
const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
const lerp = (a, b, t) => a + (b - a) * t;
const sat = (x) => Math.min(1, Math.max(0, x));
const smooth = (a, b, x) => { const t = sat((x - a) / (b - a)); return t * t * (3 - 2 * t); };

/** Periodic gradient noise, period `p` lattice cells, returns ~[-1, 1]. */
function perlin(x, y, z, p, seed) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const u = fade(xf), v = fade(yf), w = fade(zf);
  let acc = 0;
  for (let c = 0; c < 8; c++) {
    const dx = c & 1, dy = (c >> 1) & 1, dz = (c >> 2) & 1;
    const hx = mod(xi + dx, p), hy = mod(yi + dy, p), hz = mod(zi + dz, p);
    const a = hash3(hx, hy, hz, seed) * Math.PI * 2;
    const ct = hash3(hx, hy, hz, seed + 17) * 2 - 1;
    const st = Math.sqrt(1 - ct * ct);
    const g = (Math.cos(a) * st) * (xf - dx) + (Math.sin(a) * st) * (yf - dy) + ct * (zf - dz);
    acc += g * (dx ? u : 1 - u) * (dy ? v : 1 - v) * (dz ? w : 1 - w);
  }
  return acc * 1.6;
}
/** Periodic Worley F1, returns distance in cells (0..~1). */
function worley(x, y, z, p, seed) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  let best = 9;
  for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const cx = xi + dx, cy = yi + dy, cz = zi + dz;
    const hx = mod(cx, p), hy = mod(cy, p), hz = mod(cz, p);
    const px = cx + hash3(hx, hy, hz, seed), py = cy + hash3(hx, hy, hz, seed + 5), pz = cz + hash3(hx, hy, hz, seed + 11);
    const d = (px - x) ** 2 + (py - y) ** 2 + (pz - z) ** 2;
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}

// ---------- six-way smoke atlas ----------
const CELLS = 4;         // 4x4 puff variants
const N = 112;           // voxels per axis
const CELL_PX = 192;

function bakePuff(index) {
  const rnd = mulberry32(1000 + index * 77);
  const blobs = [];
  const nb = 5 + Math.floor(rnd() * 4);
  for (let i = 0; i < nb; i++) {
    const r = i === 0 ? 0.7 : 0.3 + rnd() * 0.26;
    const d = i === 0 ? 0 : 0.22 + rnd() * 0.3;
    const a = rnd() * Math.PI * 2, e = (rnd() - 0.5) * 2.0;
    blobs.push([Math.cos(a) * Math.cos(e) * d, Math.sin(e) * d * 0.9, Math.sin(a) * Math.cos(e) * d, r]);
  }
  const seed = 31 + index * 13;
  const dens = new Float32Array(N * N * N);
  const P = 64;
  for (let k = 0; k < N; k++) for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const x = (i + 0.5) / N * 2 - 1, y = (j + 0.5) / N * 2 - 1, z = (k + 0.5) / N * 2 - 1;
    const rr = Math.hypot(x, y, z);
    if (rr > 0.98) continue;
    let base = -1;
    for (const b of blobs) {
      const v = 1 - Math.hypot(x - b[0], y - b[1], z - b[2]) / b[3];
      if (v > base) base = v;
    }
    if (base < -0.55) continue;
    // cauliflower billows: inverted worley at two scales + a little perlin
    const w1 = 1 - worley(x * 2.6 + 9, y * 2.6 + 9, z * 2.6 + 9, P, seed);
    const w2 = 1 - worley(x * 5.6 + 3, y * 5.6 + 3, z * 5.6 + 3, P, seed + 1);
    const pn = perlin(x * 9 + 20, y * 9 + 20, z * 9 + 20, P, seed + 2);
    const n = w1 * 0.62 + w2 * 0.3 + pn * 0.1;
    let d = smooth(0.0, 0.42, base * 0.75 + (n - 0.52) * 0.95);
    d *= smooth(0.98, 0.78, rr);
    dens[(k * N + j) * N + i] = d;
  }

  const K = 5.2 * (2 / N);           // extinction per voxel
  const trans = (s) => 0.72 * Math.exp(-K * s) + 0.28 * Math.exp(-K * s * 0.22); // + cheap multiple scattering
  // light transmittance for the six axis directions (cumulative optical depth)
  const T = [];
  const idx = (i, j, k) => (k * N + j) * N + i;
  for (let dir = 0; dir < 6; dir++) {
    const t = new Float32Array(N * N * N);
    const axis = dir >> 1, positive = (dir & 1) === 0; // 0:+x 1:-x 2:+y 3:-y 4:+z 5:-z
    for (let a = 0; a < N; a++) for (let b = 0; b < N; b++) {
      let sum = 0;
      for (let s = 0; s < N; s++) {
        const c = positive ? N - 1 - s : s; // march away from the light
        const id = axis === 0 ? idx(c, a, b) : axis === 1 ? idx(a, c, b) : idx(a, b, c);
        t[id] = trans(sum + dens[id] * 0.5);
        sum += dens[id];
      }
    }
    T.push(t);
  }
  // integrate along the view axis: camera at +z looking toward -z
  const out = new Float32Array(N * N * 8);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    let tv = 1, depth = 0;
    const L = [0, 0, 0, 0, 0, 0];
    for (let k = N - 1; k >= 0; k--) {
      const id = idx(i, j, k);
      const d = dens[id];
      if (d <= 0) continue;
      const a = 1 - Math.exp(-K * d * 1.7);
      for (let q = 0; q < 6; q++) L[q] += tv * a * T[q][id];
      tv *= 1 - a;
      depth += d;
    }
    const o = (j * N + i) * 8;
    out[o] = L[0]; out[o + 1] = L[2]; out[o + 2] = L[4]; out[o + 3] = 1 - tv;
    out[o + 4] = L[1]; out[o + 5] = L[3]; out[o + 6] = L[5]; out[o + 7] = sat(depth / (N * 0.42));
  }
  return out;
}

async function bakeSmoke() {
  const W = CELLS * N;
  const a = Buffer.alloc(W * W * 4), b = Buffer.alloc(W * W * 4);
  for (let c = 0; c < CELLS * CELLS; c++) {
    const puff = bakePuff(c);
    const cx = c % CELLS, cy = Math.floor(c / CELLS);
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const o = (j * N + i) * 8;
      // image rows go top-down; +Y of the volume is up
      const p = (((cy * N) + (N - 1 - j)) * W + cx * N + i) * 4;
      for (let q = 0; q < 4; q++) {
        a[p + q] = Math.round(sat(puff[o + q]) * 255);
        b[p + q] = Math.round(sat(puff[o + 4 + q]) * 255);
      }
    }
    process.stdout.write(`puff ${c + 1}/${CELLS * CELLS}\r`);
  }
  const size = CELLS * CELL_PX;
  for (const [buf, name] of [[a, 'smoke6_a.png'], [b, 'smoke6_b.png']]) {
    await sharp(buf, { raw: { width: W, height: W, channels: 4 } })
      .resize(size, size, { kernel: 'cubic' })
      .png({ compressionLevel: 9 })
      .toFile(resolve(OUT, name));
  }
}

// ---------- tileable noise ----------
async function bakeNoise() {
  const S = 256;
  const buf = Buffer.alloc(S * S * 4);
  const fbm = (x, y, p, seed, oct) => {
    let a = 0.5, f = 1, s = 0, n = 0;
    for (let o = 0; o < oct; o++) { s += a * perlin(x * f, y * f, 0.5, p * f, seed + o); n += a; a *= 0.5; f *= 2; }
    return s / n * 0.5 + 0.5;
  };
  const wfbm = (x, y, p, seed, oct) => {
    let a = 0.5, f = 1, s = 0, n = 0;
    for (let o = 0; o < oct; o++) { s += a * (1 - Math.min(1, worley(x * f, y * f, 0.5, p * f, seed + o))); n += a; a *= 0.5; f *= 2; }
    return s / n;
  };
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const u = x / S, v = y / S, p = (y * S + x) * 4;
    buf[p] = Math.round(sat(fbm(u * 4, v * 4, 4, 3, 5)) * 255);
    buf[p + 1] = Math.round(sat(wfbm(u * 5, v * 5, 5, 40, 3)) * 255);
    buf[p + 2] = Math.round(sat(fbm(u * 12, v * 12, 12, 80, 4)) * 255);
    buf[p + 3] = Math.round(sat(wfbm(u * 14, v * 14, 14, 120, 2)) * 255);
  }
  await sharp(buf, { raw: { width: S, height: S, channels: 4 } }).png({ compressionLevel: 9 }).toFile(resolve(OUT, 'noise.png'));
}

const t0 = Date.now();
await bakeSmoke();
await bakeNoise();
console.log(`\nvfx textures written to ${OUT} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
