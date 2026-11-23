/**
 * Offline terrain preview. Renders a hillshaded map + a horizon profile from the
 * JS mirror of the height field, so terrain shaping can be iterated in seconds
 * instead of through the browser.
 *
 *   node tools/preview-terrain.mjs [spanKm] [centreX] [centreZ]
 */
import sharp from 'sharp';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { terrainHeight } from '../src/world/heightfield.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(root, '.agent/terrain-preview.png');

const spanKm = Number(process.argv[2] ?? 70);
const cx = Number(process.argv[3] ?? 0);
const cz = Number(process.argv[4] ?? 0);

const N = Number(process.env.N ?? 560);
const span = spanKm * 1000;
const step = span / N;

const h = new Float64Array(N * N);
let min = Infinity;
let max = -Infinity;
let sum = 0;
const hist = new Array(16).fill(0);

for (let j = 0; j < N; j++) {
  const z = cz - span / 2 + j * step;
  for (let i = 0; i < N; i++) {
    const x = cx - span / 2 + i * step;
    const v = terrainHeight(x, z);
    h[j * N + i] = v;
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
  }
}
for (let k = 0; k < h.length; k++) {
  hist[Math.min(15, Math.max(0, Math.floor(((h[k] - min) / (max - min)) * 16)))]++;
}

// Hillshade with a low sun so ridgelines read clearly.
const sun = [0.55, 0.45, -0.7];
const sl = Math.hypot(...sun);
sun.forEach((v, i) => (sun[i] = v / sl));

const rgb = Buffer.alloc(N * N * 3);
for (let j = 0; j < N; j++) {
  for (let i = 0; i < N; i++) {
    const k = j * N + i;
    const hl = h[j * N + Math.max(0, i - 1)];
    const hr = h[j * N + Math.min(N - 1, i + 1)];
    const hd = h[Math.max(0, j - 1) * N + i];
    const hu = h[Math.min(N - 1, j + 1) * N + i];
    let nx = hl - hr;
    let ny = 2 * step;
    let nz = hd - hu;
    const inv = 1 / Math.hypot(nx, ny, nz);
    nx *= inv;
    ny *= inv;
    nz *= inv;
    const lam = Math.max(0, nx * sun[0] + ny * sun[1] + nz * sun[2]);
    const shade = 0.16 + 0.84 * lam;

    const alt = (h[k] - min) / (max - min);
    const snow = Math.min(1, Math.max(0, (h[k] - 4500) / 900)) * (1 - Math.min(1, (1 - ny) / 0.55));
    let r = 0.30 + 0.35 * alt;
    let g = 0.26 + 0.30 * alt;
    let b = 0.22 + 0.26 * alt;
    r = r * (1 - snow) + 0.97 * snow;
    g = g * (1 - snow) + 0.98 * snow;
    b = b * (1 - snow) + 1.0 * snow;

    rgb[k * 3] = Math.min(255, r * shade * 255 * 1.35);
    rgb[k * 3 + 1] = Math.min(255, g * shade * 255 * 1.35);
    rgb[k * 3 + 2] = Math.min(255, b * shade * 255 * 1.35);
  }
}

await sharp(rgb, { raw: { width: N, height: N, channels: 3 } })
  .png()
  .toFile(OUT);

const pct = (n) => ((n / h.length) * 100).toFixed(1).padStart(5);
console.log(`span ${spanKm} km  centre ${cx},${cz}   step ${step.toFixed(0)} m`);
console.log(`min ${min.toFixed(0)} m   max ${max.toFixed(0)} m   mean ${(sum / h.length).toFixed(0)} m`);
console.log('altitude histogram (low -> high):');
console.log(hist.map((n) => pct(n)).join(''));
const sorted = Float64Array.from(h).sort();
const q = (p) => sorted[Math.floor(p * (sorted.length - 1))].toFixed(0);
console.log(
  `p05 ${q(0.05)}  p25 ${q(0.25)}  p50 ${q(0.5)}  p75 ${q(0.75)}  p95 ${q(0.95)}  p99 ${q(0.99)}`,
);
console.log(`wrote ${path.relative(root, OUT)}`);
