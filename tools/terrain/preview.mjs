// Debug preview of a terrain pack: hillshade with the river mask overlaid.
//   node tools/terrain/preview.mjs [hi|lo] [out.png] [size]
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { readPack } from './pack.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const id = process.argv[2] ?? 'hi';
const out = process.argv[3] ?? `terrain-${id}.png`;
const S = +(process.argv[4] ?? 1536);
const { meta, planes } = readPack(readFileSync(join(ROOT, `public/assets/terrain/kargil-${id}.stp`)));
const n = meta.resolution;
const H = planes.height.data;
const R = planes.river.data;
const px = Buffer.alloc(S * S * 3);
const cell = meta.cellMetres[0];
for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
  const x = Math.min(n - 2, Math.max(1, Math.round((i / (S - 1)) * (n - 1))));
  const z = Math.min(n - 2, Math.max(1, Math.round((j / (S - 1)) * (n - 1))));
  const k = z * n + x;
  const dx = ((H[k + 1] - H[k - 1]) * meta.heightUnit) / (2 * cell);
  const dz = ((H[k + n] - H[k - n]) * meta.heightUnit) / (2 * cell);
  const l = Math.hypot(dx, 1, dz);
  const sh = Math.max(0, (dx * 0.5 + 0.7 + dz * 0.5) / l) * 1.1;
  const hgt = H[k] * meta.heightUnit;
  let r = sh * 200;
  let g = sh * 190;
  let b = sh * 175;
  if (hgt > 5000) { r = g = b = sh * 255; }
  const e = R[k] * meta.riverSdf.step + meta.riverSdf.min;
  if (e < 25) { r = 20; g = 150; b = 255; }
  px[(j * S + i) * 3] = Math.min(255, r);
  px[(j * S + i) * 3 + 1] = Math.min(255, g);
  px[(j * S + i) * 3 + 2] = Math.min(255, b);
}
await sharp(px, { raw: { width: S, height: S, channels: 3 } }).png().toFile(out);
console.log(out, meta.heightMin, meta.heightMax);
