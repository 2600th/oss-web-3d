/**
 * Local contrast of HUD ink against its immediate surround.
 *
 *   node tools/hud/hud-contrast.mjs <screenshot.png> <capture.json> [--json out.json]
 *
 * `screenshot.png` is the composited page (scene + HUD) at DPR 1;
 * `capture.json` is what the in-page helper (tools/hud/hud-capture.js) returns for the same frozen frame: the HUD canvas as a PNG data
 * URL plus named regions {name, x0, y0, x1, y1} in CSS px.
 *
 * Per region: ink pixels are those the HUD canvas paints opaque (alpha > 0.5)
 * in a light or coloured ink (brightest channel > 110; the halo and the plates
 * are near-black); the surround is every other pixel within 2 px of ink, so it
 * holds the halo and whatever scene shows through or past it. Both are read
 * from the screenshot as WCAG relative luminance. Ink is taken at its core
 * (75th percentile: hairlines and 10 px glyphs are mostly anti-aliased edge).
 * Reported:
 *   contrast  (ink core + 0.05) / (median surround + 0.05)
 *   worst     (median ink + 0.05) / (90th-percentile surround + 0.05)
 */
import sharp from 'sharp';
import { readFileSync, writeFileSync } from 'node:fs';

const [shotPath, capPath] = process.argv.slice(2);
const jsonOut = process.argv.includes('--json') ? process.argv[process.argv.indexOf('--json') + 1] : null;
if (!shotPath || !capPath) {
  console.error('usage: node tools/hud/hud-contrast.mjs <screenshot.png> <capture.json> [--json out.json]');
  process.exit(1);
}
let cap = JSON.parse(readFileSync(capPath, 'utf8'));
if (typeof cap === 'string') cap = JSON.parse(cap);
const hudBuf = Buffer.from(cap.png.replace(/^data:image\/png;base64,/, ''), 'base64');

const shot = await sharp(shotPath).removeAlpha().raw().toBuffer({ resolveWithObject: true });
const hud = await sharp(hudBuf).ensureAlpha().resize(shot.info.width, shot.info.height, { kernel: 'nearest' }).raw().toBuffer({ resolveWithObject: true });
const W = shot.info.width;
const H = shot.info.height;
const S = shot.data;
const U = hud.data;

const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const LUT = Float32Array.from({ length: 256 }, (_, i) => lin(i));
const lum = (k) => 0.2126 * LUT[S[k * 3]] + 0.7152 * LUT[S[k * 3 + 1]] + 0.0722 * LUT[S[k * 3 + 2]];
const isInk = (k) => U[k * 4 + 3] > 128 && Math.max(U[k * 4], U[k * 4 + 1], U[k * 4 + 2]) > 110;
const pct = (a, p) => { if (!a.length) return NaN; a.sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(p * a.length))]; };

const rows = [];
for (const r of cap.regions) {
  const x0 = Math.max(0, Math.floor(r.x0)), y0 = Math.max(0, Math.floor(r.y0));
  const x1 = Math.min(W - 1, Math.ceil(r.x1)), y1 = Math.min(H - 1, Math.ceil(r.y1));
  const ink = [];
  const ring = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const k = y * W + x;
    if (isInk(k)) { ink.push(lum(k)); continue; }
    let near = false;
    for (let dy = -2; dy <= 2 && !near; dy++) for (let dx = -2; dx <= 2; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
      if (isInk(yy * W + xx)) { near = true; break; }
    }
    if (near) ring.push(lum(k));
  }
  if (ink.length < 12) { rows.push({ name: r.name, n: ink.length }); continue; }
  const iCore = pct(ink.slice(), 0.75), sMed = pct(ring.slice(), 0.5);
  const iMed = pct(ink.slice(), 0.5), sHi = pct(ring.slice(), 0.9);
  rows.push({ name: r.name, n: ink.length, ink: +iCore.toFixed(3), surround: +sMed.toFixed(3), contrast: +((iCore + 0.05) / (sMed + 0.05)).toFixed(2), worst: +((iMed + 0.05) / (sHi + 0.05)).toFixed(2) });
}
const pad = (v, n) => String(v ?? '-').padEnd(n);
console.log(pad('region', 22) + pad('ink px', 8) + pad('L ink', 8) + pad('L sur', 8) + pad('contrast', 10) + 'worst');
for (const r of rows) console.log(pad(r.name, 22) + pad(r.n, 8) + pad(r.ink, 8) + pad(r.surround, 8) + pad(r.contrast, 10) + (r.worst ?? '-'));
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(rows, null, 2));
