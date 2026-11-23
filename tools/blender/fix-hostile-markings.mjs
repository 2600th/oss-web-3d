/**
 * Hostile MiG-21 skin touch-up (runs on the built public/models/mig21_hostile*.glb).
 *
 *   node tools/blender/fix-hostile-markings.mjs
 *
 * build-mig-variants.mjs paints the removed national markings with flat camo:
 * from a chase camera every former roundel was a smooth, grime-free disc on a
 * weathered wing, and anti-aliased slivers of the green fin flash / roundel
 * centres survived at the mask edges. This pass, per skin texture:
 *
 *   1. finds the marking areas from the player atlas (same UV layout): orange
 *      rings with the green inside / beside them, filled to their ellipse;
 *   2. inside them, multiplies the (correct) camo colour by the fine grime and
 *      panel detail of a clean donor patch beside the marking, as a luminance
 *      ratio against its own blur, clamped so donor panel lines stay faint;
 *   3. replaces any texel that is still saturated green by the median of the
 *      grey texels around it.
 *
 * Only the base-colour textures change; everything else in the GLB is kept.
 * Re-running is harmless (the masks come from the player atlas, the donor
 * detail is a ratio, so a second pass changes almost nothing).
 */
import { statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { io, sharp } from './gltf-pipeline.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PLAYER = join(ROOT, 'public/models/mig21.glb');
const TARGETS = ['public/models/mig21_hostile.glb', 'public/models/mig21_hostile_lod1.glb'].map((p) => join(ROOT, p));
// Painted skin only: the cockpit (turquoise), the seat and the stores (missile
// bands) keep their colours. Material names are the source model's ids.
const SKIN = ['95e5e633', 'b5786402', 'a03a1592', '90615672', 'f0e90a15', '75f68695', 'b5643b4b', '0f81b598'];

function hsv(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d > 0) {
    if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h = (h * 60 + 360) % 360;
  }
  return [h, mx > 0 ? d / mx : 0, mx];
}

function components(mask, W, H) {
  const lab = new Int32Array(W * H).fill(-1);
  const comps = [];
  const stack = [];
  for (let s = 0; s < W * H; s++) {
    if (!mask[s] || lab[s] >= 0) continue;
    const c = { id: comps.length, count: 0, x0: W, y0: H, x1: 0, y1: 0 };
    lab[s] = c.id;
    stack.push(s);
    while (stack.length) {
      const p = stack.pop();
      const x = p % W, y = (p / W) | 0;
      c.count++;
      if (x < c.x0) c.x0 = x; if (x > c.x1) c.x1 = x; if (y < c.y0) c.y0 = y; if (y > c.y1) c.y1 = y;
      for (const q of [p - 1, p + 1, p - W, p + W]) {
        if (q < 0 || q >= W * H || Math.abs((q % W) - x) > 1) continue;
        if (mask[q] && lab[q] < 0) { lab[q] = c.id; stack.push(q); }
      }
    }
    comps.push(c);
  }
  return { lab, comps };
}

async function raw(img, W, H) {
  let s = sharp(Buffer.from(img)).ensureAlpha();
  if (W) s = s.resize(W, H, { kernel: 'lanczos3' });
  return s.raw().toBuffer({ resolveWithObject: true });
}

/** Marking ellipses (in 0..1 texture space) from the player atlas texture. */
async function markingsOf(img) {
  const { data, info } = await raw(img);
  const W = info.width, H = info.height;
  const orange = new Uint8Array(W * H), green = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const [h, s, v] = hsv(data[i * 4] / 255, data[i * 4 + 1] / 255, data[i * 4 + 2] / 255);
    if (h > 5 && h < 42 && s > 0.45 && v > 0.45) orange[i] = 1;
    if (h > 75 && h < 175 && s > 0.28 && v > 0.2) green[i] = 1;
  }
  const O = components(orange, W, H).comps.filter((c) => c.count > 6);
  const G = components(green, W, H).comps.filter((c) => c.count > 6);
  const out = [];
  for (const o of O) {
    let { x0, x1, y0, y1 } = o;
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, sz = Math.max(x1 - x0, y1 - y0) + 1;
    let roundel = false;
    for (const g of G) {
      const gx = (g.x0 + g.x1) / 2, gy = (g.y0 + g.y1) / 2;
      if (gx > o.x0 && gx < o.x1 && gy > o.y0 && gy < o.y1) roundel = true;
      else if (Math.abs(gx - cx) < sz * 1.6 && Math.abs(gy - cy) < sz * 1.6 && g.count < o.count * 3) {
        x0 = Math.min(x0, g.x0); x1 = Math.max(x1, g.x1); y0 = Math.min(y0, g.y0); y1 = Math.max(y1, g.y1);
      }
    }
    const pad = 6;
    out.push({ x0: (x0 - pad) / W, x1: (x1 + pad) / W, y0: (y0 - pad) / H, y1: (y1 + pad) / H, ellipse: roundel });
  }
  return out;
}

function boxBlurLum(L, W, H, r) {
  const tmp = new Float32Array(W * H), out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let s = 0, n = 0;
    for (let k = -r; k <= r; k++) { const xx = x + k; if (xx >= 0 && xx < W) { s += L[y * W + xx]; n++; } }
    tmp[y * W + x] = s / n;
  }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let s = 0, n = 0;
    for (let k = -r; k <= r; k++) { const yy = y + k; if (yy >= 0 && yy < H) { s += tmp[yy * W + x]; n++; } }
    out[y * W + x] = s / n;
  }
  return out;
}

async function fix(img, marks) {
  const { data, info } = await raw(img);
  const W = info.width, H = info.height;
  const L = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) L[i] = 0.2126 * data[i * 4] + 0.7152 * data[i * 4 + 1] + 0.0722 * data[i * 4 + 2];
  const B = boxBlurLum(L, W, H, Math.max(2, Math.round(W / 256)));
  const mask = new Uint8Array(W * H);
  const rects = marks.map((m) => ({ x0: Math.floor(m.x0 * W), x1: Math.ceil(m.x1 * W), y0: Math.floor(m.y0 * H), y1: Math.ceil(m.y1 * H), ellipse: m.ellipse }));
  for (const r of rects) {
    const ex = (r.x1 - r.x0) / 2, ey = (r.y1 - r.y0) / 2, mx = (r.x0 + r.x1) / 2, my = (r.y0 + r.y1) / 2;
    for (let y = Math.max(0, r.y0); y <= Math.min(H - 1, r.y1); y++) for (let x = Math.max(0, r.x0); x <= Math.min(W - 1, r.x1); x++) {
      if (r.ellipse && ((x - mx) / ex) ** 2 + ((y - my) / ey) ** 2 > 1) continue;
      mask[y * W + x] = 1;
    }
  }
  const out = Buffer.from(data);
  let touched = 0;
  for (const r of rects) {
    const w = r.x1 - r.x0 + 4, h = r.y1 - r.y0 + 4;
    // donor: the first clean, opaque side (right, left, below, above)
    const offs = [[w, 0], [-w, 0], [0, h], [0, -h]];
    let off = null;
    for (const [dx, dy] of offs) {
      let ok = 0, n = 0;
      for (let y = r.y0; y <= r.y1; y += 2) for (let x = r.x0; x <= r.x1; x += 2) {
        const xx = x + dx, yy = y + dy;
        n++;
        if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
        const q = yy * W + xx;
        if (!mask[q] && data[q * 4 + 3] > 200 && L[q] > 40) ok++;
      }
      if (n && ok / n > 0.85) { off = [dx, dy]; break; }
    }
    if (!off) continue;
    const ex = (r.x1 - r.x0) / 2, ey = (r.y1 - r.y0) / 2, mx = (r.x0 + r.x1) / 2, my = (r.y0 + r.y1) / 2;
    for (let y = Math.max(0, r.y0); y <= Math.min(H - 1, r.y1); y++) for (let x = Math.max(0, r.x0); x <= Math.min(W - 1, r.x1); x++) {
      const i = y * W + x;
      if (!mask[i]) continue;
      const q = (y + off[1]) * W + (x + off[0]);
      const ratio = Math.min(1.12, Math.max(0.82, L[q] / Math.max(1, B[q])));
      // feather the last few texels into the untouched paint
      const e = r.ellipse ? Math.sqrt(((x - mx) / ex) ** 2 + ((y - my) / ey) ** 2) : Math.max(Math.abs(x - mx) / ex, Math.abs(y - my) / ey);
      const k = 1 - Math.min(1, Math.max(0, (e - 0.85) / 0.15)) * 0.5;
      const f = 1 + (ratio - 1) * k;
      for (let c = 0; c < 3; c++) out[i * 4 + c] = Math.min(255, Math.round(data[i * 4 + c] * f));
      touched++;
    }
  }
  // left-over green slivers
  let slivers = 0;
  for (let y = 2; y < H - 2; y++) for (let x = 2; x < W - 2; x++) {
    const i = y * W + x;
    const [h, s, v] = hsv(out[i * 4] / 255, out[i * 4 + 1] / 255, out[i * 4 + 2] / 255);
    if (!(h > 70 && h < 180 && s > 0.2 && v > 0.12)) continue;
    const grey = [];
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const q = i + dy * W + dx;
      const [, s2] = hsv(out[q * 4] / 255, out[q * 4 + 1] / 255, out[q * 4 + 2] / 255);
      if (s2 < 0.15) grey.push(q);
    }
    if (grey.length < 4) continue;
    grey.sort((a, b) => L[a] - L[b]);
    const m = grey[grey.length >> 1];
    for (let c = 0; c < 3; c++) out[i * 4 + c] = out[m * 4 + c];
    slivers++;
  }
  const webp = await sharp(out, { raw: { width: W, height: H, channels: 4 } }).webp({ quality: 88, alphaQuality: 100, effort: 6 }).toBuffer();
  return { webp, touched, slivers, W, H };
}

const player = await io.read(PLAYER);
const playerTex = new Map();
for (const m of player.getRoot().listMaterials()) if (m.getBaseColorTexture()) playerTex.set(m.getName(), m.getBaseColorTexture());

for (const file of TARGETS) {
  const before = statSync(file).size;
  const doc = await io.read(file);
  const done = new Set();
  for (const m of doc.getRoot().listMaterials()) {
    const t = m.getBaseColorTexture();
    const p = playerTex.get(m.getName());
    if (!t || !p || done.has(t) || !SKIN.some((k) => m.getName().startsWith(k))) continue;
    done.add(t);
    const marks = await markingsOf(p.getImage());
    const r = await fix(t.getImage(), marks);
    if (!marks.length && !r.slivers) continue;
    t.setImage(new Uint8Array(r.webp)).setMimeType('image/webp');
    console.log(file.split(/[\\/]/).pop(), m.getName().slice(0, 8), `${r.W}x${r.H}`, 'markings', marks.length, 'texels', r.touched, 'slivers', r.slivers);
  }
  await io.write(file, doc);
  console.log(file.split(/[\\/]/).pop(), before, '->', statSync(file).size, 'B');
}
