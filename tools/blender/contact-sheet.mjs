/**
 * Compose thumbnails (tools/blender/render_thumbs.py) into a labelled
 * contact sheet with triangle counts and file sizes.
 *
 *   node tools/blender/contact-sheet.mjs <thumbdir> <out.png> [cols]
 */
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { io, countTriangles } from './gltf-pipeline.mjs';

const [, , dir, out, colsArg] = process.argv;
const cols = Number(colsArg || 6);
const W = 320, H = 240, LABEL = 40;
const ORDER = (process.env.ORDER || '').split(',').filter(Boolean);
let files = readdirSync(dir).filter((f) => f.endsWith('.png'));
if (ORDER.length) files = ORDER.map((id) => `${id}.png`).filter((f) => files.includes(f));
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const tiles = [];
for (const [i, f] of files.entries()) {
  const id = f.replace(/\.png$/, '');
  const glb = path.join('public/models', `${id}.glb`);
  let meta = '';
  try {
    const doc = await io.read(glb);
    meta = `${countTriangles(doc).toLocaleString('en')} tris · ${(statSync(glb).size / 1024).toFixed(0)} KB`;
  } catch {}
  const img = await sharp(path.join(dir, f)).resize(W, H).toBuffer();
  const svg = Buffer.from(
    `<svg width="${W}" height="${LABEL}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#1d2126"/>` +
      `<text x="8" y="17" font-family="Segoe UI, Arial, sans-serif" font-size="15" font-weight="600" fill="#f0f2f4">${esc(id)}</text>` +
      `<text x="8" y="34" font-family="Segoe UI, Arial, sans-serif" font-size="12" fill="#a9b1ba">${esc(meta)}</text></svg>`,
  );
  const x = (i % cols) * W, y = Math.floor(i / cols) * (H + LABEL);
  tiles.push({ input: img, left: x, top: y }, { input: svg, left: x, top: y + H });
}
const rows = Math.ceil(files.length / cols);
await sharp({ create: { width: cols * W, height: rows * (H + LABEL), channels: 3, background: '#15181c' } })
  .composite(tiles)
  .png()
  .toFile(out);
console.log('wrote', out, files.length, 'tiles');
