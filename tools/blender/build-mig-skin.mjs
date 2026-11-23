/**
 * MiG-21 skin pass: baked ambient occlusion, a panel-line / rivet normal map,
 * weathering and a roughness / metalness map for the whole MiG family.
 *
 *   node tools/blender/build-mig-skin.mjs [--only=mig21.glb] [--rebake] [--debug]
 *   node tools/blender/write-catalog.mjs          (afterwards: byte sizes)
 *
 * Inputs are the GLBs as they stood before this pass (commit BASE), read from
 * git into node_modules/.cache/mig-skin/in/ on first run, so the script can be
 * re-run any number of times and always writes the same files:
 *
 *   public/models/mig21.glb               player, IAF markings
 *   public/models/mig21_hostile.glb       hostile, unmarked
 *   public/models/mig21_hostile_lod1.glb  hostile beyond 600 m
 *   public/models/mig21-low.glb           old low-poly player (not loaded by the game)
 *
 * What it does, per skin material (airframe, drop tanks, stores, pylons, gear
 * doors, ventral parts):
 *
 *   1. Rasterises the mesh into the atlas: every texel gets its model-space
 *      position and normal (metres, nose -Z, +Y up), so the weathering is
 *      painted in 3D and is continuous across UV seams and across materials.
 *   2. AO: ray-traced, cosine-weighted, 3 m reach, against every opaque
 *      triangle of the jet with the control surfaces at neutral (the glass and
 *      the decal cards do not occlude). Baked once on mig21.glb and shared by
 *      the other files, which have the same UV layout.
 *   3. Normal map: the albedo already carries the panel lines and rivets as
 *      thin dark marks. A black top-hat filter isolates marks narrower than a
 *      few texels (not the edges of roundels or stains), they become a height
 *      field (grooves, dimples) and its gradient is added to the source normal
 *      map. Relief and painted line therefore register exactly.
 *   4. Weathering in the albedo: panel-to-panel tone, exhaust soot and heat
 *      staining on the rear fuselage, gun soot aft of the GSh-23 muzzles, oil
 *      and hydraulic streaks that start on panel lines and run aft, walkway
 *      scuffs on the wing roots, leading-edge erosion with chipping, belly
 *      grime, dirt in occluded cavities.
 *   5. ORM texture (glTF occlusion / roughness / metalness in R / G / B). It
 *      replaces the source's KHR_materials_specular map, which was only a
 *      bare-metal mask and tinted the paint's specular to black.
 *
 * The player airframe atlas goes from 1024 to 2048 px (base colour and
 * normal), with the panel lines redrawn from the line mask so they are crisp
 * when magnified; everything else keeps its size.
 *
 * Cockpit interior and seat: ORM only (the AO is the point: the tub, the
 * coaming and the canopy frame shade the panel). Their base colour and normal
 * map bytes are not touched.
 *
 * Markings: nothing is added. The player keeps the roundels and fin flash it
 * shipped with, the hostiles stay unmarked.
 */
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import sharp from 'sharp';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBVH, bakeAO } from './mig-skin-trace.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BASE = '852e0dce64ed48c6a17f9d80541ef1530d780bb5'; // the GLBs before this pass
const CACHE = path.join(ROOT, 'node_modules/.cache/mig-skin');
const ARG = (k) => process.argv.find((a) => a.startsWith(`--${k}`));
const ONLY = ARG('only')?.split('=')[1];
const REBAKE = !!ARG('rebake');
const DEBUG = !!ARG('debug');

// The first file is the canonical one: AO and streak seeds are baked on it.
const FILES = [
  { file: 'mig21.glb', role: 'player', upscale: { airframe: 2 } },
  { file: 'mig21_hostile.glb', role: 'hostile' },
  { file: 'mig21_hostile_lod1.glb', role: 'hostile' },
  { file: 'mig21-low.glb', role: 'player' },
];

// mig21-low.glb still has the exporter's node names
const ALIAS = {
  Object_13: 'airframe', Object_9: 'cockpit_interior', Object_8: 'cockpit_seat', Object_30: 'canopy_glass', Object_28: 'stores',
  Object_23: 'underside', Object_27: 'details_alpha', Object_12: 'pylons', Object_26: 'gear_doors', Object_5: 'ventral',
  Object_2: 'ventral_fairing', Object_7: 'strake', Object_3: 'glass_misc', Object_11: 'pitot',
};
const PARTS = ['cockpit_interior', 'cockpit_seat', 'canopy_glass', 'details_alpha', 'glass_misc', 'ventral_fairing', 'gear_doors', 'airframe', 'underside', 'stores', 'pylons', 'ventral', 'strake', 'pitot'];
const partOf = (nodeName) => {
  const n = ALIAS[nodeName] ?? nodeName;
  return PARTS.find((p) => n === p || n.endsWith(`_${p}`)) ?? n;
};

// How much of each weathering layer a part takes (`underside` is the drop tanks).
const SKIN = {
  airframe: { wear: 1, streaks: 1, belly: 1, tone: 1, soot: 1, relief: 1 },
  underside: { wear: 0.7, streaks: 0.4, belly: 0.6, tone: 0.6, soot: 0, relief: 1 },
  stores: { wear: 0.25, streaks: 0, belly: 0.3, tone: 0.3, soot: 0, relief: 0.7 },
  pylons: { wear: 0.8, streaks: 0.6, belly: 0.7, tone: 0.5, soot: 0, relief: 1 },
  gear_doors: { wear: 0.6, streaks: 1, belly: 1, tone: 0.6, soot: 0.5, relief: 1 },
  ventral: { wear: 0.8, streaks: 0.8, belly: 0.8, tone: 0.6, soot: 0.6, relief: 1 },
  ventral_fairing: { wear: 0.8, streaks: 0.6, belly: 0.8, tone: 0.4, soot: 1, relief: 1 },
  strake: { wear: 1, streaks: 0.4, belly: 0.8, tone: 0.4, soot: 0.6, relief: 1 },
};
const COCKPIT = new Set(['cockpit_interior', 'cockpit_seat']);
const AO_MAX = 1024; // AO bake resolution cap (longest side)

await Promise.all([MeshoptDecoder.ready, MeshoptEncoder.ready]);
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });

// ---------------------------------------------------------------- small maths
const clamp = (x, a = 0, b = 1) => (x < a ? a : x > b ? b : x);
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const mix = (a, b, t) => a + (b - a) * t;
function hash3(x, y, z) {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(z, 2147483647)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
function hash1(i) {
  let h = Math.imul(i | 0, 2654435761);
  h = Math.imul(h ^ (h >>> 15), 2246822519);
  return ((h ^ (h >>> 13)) >>> 0) / 4294967295;
}
function vnoise(x, y, z) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  let xf = x - xi, yf = y - yi, zf = z - zi;
  xf = xf * xf * (3 - 2 * xf); yf = yf * yf * (3 - 2 * yf); zf = zf * zf * (3 - 2 * zf);
  const c = (dx, dy, dz) => hash3(xi + dx, yi + dy, zi + dz);
  const x00 = mix(c(0, 0, 0), c(1, 0, 0), xf), x10 = mix(c(0, 1, 0), c(1, 1, 0), xf);
  const x01 = mix(c(0, 0, 1), c(1, 0, 1), xf), x11 = mix(c(0, 1, 1), c(1, 1, 1), xf);
  return mix(mix(x00, x10, yf), mix(x01, x11, yf), zf);
}
const fbm = (x, y, z) => 0.55 * vnoise(x, y, z) + 0.3 * vnoise(x * 2.07 + 7.1, y * 2.07 + 1.3, z * 2.07) + 0.15 * vnoise(x * 4.3, y * 4.3 + 3.7, z * 4.3 + 9.2);
const mul4 = (m, v) => [m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12], m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13], m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14]];
const rot4 = (m, v) => [m[0] * v[0] + m[4] * v[1] + m[8] * v[2], m[1] * v[0] + m[5] * v[1] + m[9] * v[2], m[2] * v[0] + m[6] * v[1] + m[10] * v[2]];

// ---------------------------------------------------------------- image helpers (Float32, one channel)
function blur(src, W, H, sigma) {
  if (sigma < 0.2) return src.slice();
  const r = Math.max(1, Math.ceil(sigma * 2.5));
  const k = new Float32Array(2 * r + 1);
  let s = 0;
  for (let i = -r; i <= r; i++) { k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma)); s += k[i + r]; }
  for (let i = 0; i < k.length; i++) k[i] /= s;
  const tmp = new Float32Array(W * H), out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let a = 0;
    for (let i = -r; i <= r; i++) a += src[y * W + clamp(x + i, 0, W - 1)] * k[i + r];
    tmp[y * W + x] = a;
  }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let a = 0;
    for (let i = -r; i <= r; i++) a += tmp[clamp(y + i, 0, H - 1) * W + x] * k[i + r];
    out[y * W + x] = a;
  }
  return out;
}
/** Square max (sign > 0) or min filter of radius r, separable. */
function morph(src, W, H, r, sign) {
  const f = sign > 0 ? Math.max : Math.min;
  const tmp = new Float32Array(W * H), out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let a = src[y * W + x];
    for (let i = 1; i <= r; i++) a = f(a, src[y * W + clamp(x - i, 0, W - 1)], src[y * W + clamp(x + i, 0, W - 1)]);
    tmp[y * W + x] = a;
  }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let a = tmp[y * W + x];
    for (let i = 1; i <= r; i++) a = f(a, tmp[clamp(y - i, 0, H - 1) * W + x], tmp[clamp(y + i, 0, H - 1) * W + x]);
    out[y * W + x] = a;
  }
  return out;
}
async function readRGB(buf, W, H, kernel = 'lanczos3', sharpen = false) {
  let p = sharp(Buffer.from(buf)).resize(W, H, { fit: 'fill', kernel });
  if (sharpen) p = p.sharpen({ sigma: 0.9, m1: 0.5, m2: 1.2 });
  const { data, info } = await p.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const rgb = new Float32Array(W * H * 3), a = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    rgb[i * 3] = data[i * 4] / 255; rgb[i * 3 + 1] = data[i * 4 + 1] / 255; rgb[i * 3 + 2] = data[i * 4 + 2] / 255;
    a[i] = data[i * 4 + 3];
  }
  return { rgb, alpha: a, channels: info.channels };
}
async function readGray(buf, W, H) {
  const data = await sharp(Buffer.from(buf)).resize(W, H, { fit: 'fill', kernel: 'linear' }).greyscale().raw().toBuffer();
  const g = new Float32Array(W * H);
  const ch = data.length / (W * H);
  for (let i = 0; i < W * H; i++) g[i] = data[i * ch] / 255;
  return g;
}
const toU8 = (v) => Math.round(clamp(v) * 255);
async function debugGray(name, g, W, H) {
  if (!DEBUG) return;
  mkdirSync(path.join(CACHE, 'debug'), { recursive: true });
  const b = Buffer.alloc(W * H);
  for (let i = 0; i < W * H; i++) b[i] = toU8(g[i]);
  await sharp(b, { raw: { width: W, height: H, channels: 1 } }).png().toFile(path.join(CACHE, 'debug', `${name}.png`));
}
async function debugRGB(name, rgb, W, H) {
  if (!DEBUG) return;
  mkdirSync(path.join(CACHE, 'debug'), { recursive: true });
  const b = Buffer.alloc(W * H * 3);
  for (let i = 0; i < W * H * 3; i++) b[i] = toU8(rgb[i]);
  await sharp(b, { raw: { width: W, height: H, channels: 3 } }).png().toFile(path.join(CACHE, 'debug', `${name}.png`));
}

// ---------------------------------------------------------------- scene
/** Model-space triangles of a document, grouped by material, plus the occluder soup. */
function readScene(doc) {
  const root = doc.getRoot();
  const scene = root.getDefaultScene() || root.listScenes()[0];
  const baked = root.listNodes().some((n) => n.getExtras()?.baked || n.getExtras()?.lod !== undefined);
  // un-baked source layout (mig21-low.glb): nose +Z, arbitrary scale, as src/flight/Aircraft.js normalises it
  let map = (p) => p, mapN = (n) => n;
  if (!baked) {
    const lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
    const v = [];
    for (const n of root.listNodes()) for (const p of n.getMesh()?.listPrimitives() ?? []) {
      const P = p.getAttribute('POSITION'), wm = n.getWorldMatrix();
      for (let i = 0; i < P.getCount(); i++) {
        const w = mul4(wm, P.getElement(i, v));
        for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], w[k]); hi[k] = Math.max(hi[k], w[k]); }
      }
    }
    const c = lo.map((a, i) => (a + hi[i]) / 2), s = 15.76 / (hi[2] - lo[2]);
    map = (p) => [-s * (p[0] - c[0]), s * (p[1] - c[1]), -s * (p[2] - c[2])];
    mapN = (n) => [-n[0], n[1], -n[2]];
  }
  const byMat = new Map(); // material -> {part, P: [], N: [], UV: []}
  const occ = [];
  const a = [], b = [];
  for (const node of root.listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const wm = node.getWorldMatrix();
    for (const prim of mesh.listPrimitives()) {
      const mat = prim.getMaterial();
      const P = prim.getAttribute('POSITION'), N = prim.getAttribute('NORMAL'), T = prim.getAttribute('TEXCOORD_0');
      const I = prim.getIndices();
      const n = I ? I.getCount() : P.getCount();
      const opaque = mat?.getAlphaMode() !== 'BLEND';
      let rec = byMat.get(mat);
      if (!rec) byMat.set(mat, (rec = { part: partOf(node.getName()), P: [], N: [], UV: [] }));
      for (let i = 0; i < n; i++) {
        const idx = I ? I.getScalar(i) : i;
        const p = map(mul4(wm, P.getElement(idx, a)));
        let nn = N ? mapN(rot4(wm, N.getElement(idx, b))) : [0, 1, 0];
        const L = Math.hypot(nn[0], nn[1], nn[2]) || 1;
        nn = [nn[0] / L, nn[1] / L, nn[2] / L];
        rec.P.push(p[0], p[1], p[2]);
        rec.N.push(nn[0], nn[1], nn[2]);
        if (T) { const uv = T.getElement(idx, b); rec.UV.push(uv[0], uv[1]); } else rec.UV.push(0, 0);
        if (opaque) occ.push(p[0], p[1], p[2]);
      }
    }
  }
  return { byMat, occ: new Float32Array(occ), scene };
}

/** Per-texel model position / normal for the triangles of one material. */
function rasterise(rec, W, H) {
  const pos = new Float32Array(W * H * 3), nrm = new Float32Array(W * H * 3), cov = new Uint8Array(W * H);
  const { P, N, UV } = rec;
  const wrap = (u) => u - Math.floor(u * 0.999999);
  for (let t = 0; t < P.length / 9; t++) {
    const u0 = wrap(UV[t * 6]) * W - 0.5, v0 = wrap(UV[t * 6 + 1]) * H - 0.5;
    const u1 = wrap(UV[t * 6 + 2]) * W - 0.5, v1 = wrap(UV[t * 6 + 3]) * H - 0.5;
    const u2 = wrap(UV[t * 6 + 4]) * W - 0.5, v2 = wrap(UV[t * 6 + 5]) * H - 0.5;
    const den = (v1 - v2) * (u0 - u2) + (u2 - u1) * (v0 - v2);
    if (Math.abs(den) < 1e-9) continue;
    const minx = Math.max(0, Math.floor(Math.min(u0, u1, u2))), maxx = Math.min(W - 1, Math.ceil(Math.max(u0, u1, u2)));
    const miny = Math.max(0, Math.floor(Math.min(v0, v1, v2))), maxy = Math.min(H - 1, Math.ceil(Math.max(v0, v1, v2)));
    // a texel just outside the edge still belongs to the island (bilinear footprint)
    const tol = Math.min(0.5, 1.2 / Math.sqrt(Math.abs(den)));
    for (let y = miny; y <= maxy; y++) for (let x = minx; x <= maxx; x++) {
      const w0 = ((v1 - v2) * (x - u2) + (u2 - u1) * (y - v2)) / den;
      const w1 = ((v2 - v0) * (x - u2) + (u0 - u2) * (y - v2)) / den;
      const w2 = 1 - w0 - w1;
      if (w0 < -tol || w1 < -tol || w2 < -tol) continue;
      const inside = w0 >= 0 && w1 >= 0 && w2 >= 0;
      const o = y * W + x;
      if (cov[o] === 2 && !inside) continue;
      cov[o] = inside ? 2 : 1;
      const c0 = clamp(w0), c1 = clamp(w1), c2 = clamp(w2), cs = c0 + c1 + c2;
      let nx = 0, ny = 0, nz = 0;
      for (let j = 0; j < 3; j++) pos[o * 3 + j] = (c0 * P[t * 9 + j] + c1 * P[t * 9 + 3 + j] + c2 * P[t * 9 + 6 + j]) / cs;
      nx = c0 * N[t * 9] + c1 * N[t * 9 + 3] + c2 * N[t * 9 + 6];
      ny = c0 * N[t * 9 + 1] + c1 * N[t * 9 + 4] + c2 * N[t * 9 + 7];
      nz = c0 * N[t * 9 + 2] + c1 * N[t * 9 + 5] + c2 * N[t * 9 + 8];
      const L = Math.hypot(nx, ny, nz) || 1;
      nrm[o * 3] = nx / L; nrm[o * 3 + 1] = ny / L; nrm[o * 3 + 2] = nz / L;
    }
  }
  return { pos, nrm, cov };
}

/** Grow covered texels outward so filtering and mips at island borders stay in colour. */
function dilate(cov, W, H, iters, copy) {
  const filled = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) filled[i] = cov[i] ? 1 : 0;
  for (let it = 0; it < iters; it++) {
    const add = [];
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const o = y * W + x;
      if (filled[o]) continue;
      if (x > 0 && filled[o - 1]) add.push(o, o - 1);
      else if (x < W - 1 && filled[o + 1]) add.push(o, o + 1);
      else if (y > 0 && filled[o - W]) add.push(o, o - W);
      else if (y < H - 1 && filled[o + W]) add.push(o, o + W);
    }
    if (!add.length) break;
    for (let k = 0; k < add.length; k += 2) { filled[add[k]] = 1; copy(add[k], add[k + 1]); }
  }
  return filled;
}

// ---------------------------------------------------------------- canonical data (AO, streak seeds)
const aoPath = (part) => path.join(CACHE, 'ao', `${part}.png`);
const SEEDS = path.join(CACHE, 'seeds.json');

async function bakeCanonicalAO(sceneData, sizes) {
  mkdirSync(path.join(CACHE, 'ao'), { recursive: true });
  let bvh = null;
  for (const [mat, rec] of sceneData.byMat) {
    if (!SKIN[rec.part] && !COCKPIT.has(rec.part)) continue;
    if (existsSync(aoPath(rec.part)) && !REBAKE) continue;
    const [bw, bh] = sizes.get(mat);
    const k = Math.min(1, AO_MAX / Math.max(bw, bh));
    const W = Math.round(bw * k), H = Math.round(bh * k);
    const t0 = Date.now();
    bvh ??= buildBVH(sceneData.occ);
    const { pos, nrm, cov } = rasterise(rec, W, H);
    const list = [];
    for (let i = 0; i < W * H; i++) if (cov[i]) list.push(i);
    const ao = await bakeAO(bvh, pos, nrm, Uint32Array.from(list), { rays: 96, tmax: 3, bias: 0.004 });
    // light denoise inside the islands, then bleed outward
    const sm = new Float32Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const o = y * W + x;
      if (!cov[o]) continue;
      let a = 0, w = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= W || yy >= H || !cov[yy * W + xx]) continue;
        const kk = (dx ? 1 : 2) * (dy ? 1 : 2);
        a += ao[yy * W + xx] * kk; w += kk;
      }
      sm[o] = a / w;
    }
    dilate(cov, W, H, 8, (o, q) => { sm[o] = sm[q]; });
    const b = Buffer.alloc(W * H);
    for (let i = 0; i < W * H; i++) b[i] = cov[i] || sm[i] ? toU8(sm[i]) : 255;
    await sharp(b, { raw: { width: W, height: H, channels: 1 } }).png().toFile(aoPath(rec.part));
    console.log(`  ao ${rec.part} ${W}x${H} texels=${list.length} ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }
}
const loadAO = (part, W, H) => readGray(readFileSync(aoPath(part)), W, H);

// ---------------------------------------------------------------- weathering (model space, metres)
const AXIS_Y = -0.62; // fuselage centre line
const SOOT = [0.062, 0.056, 0.052];
const OIL = [0.105, 0.078, 0.052];
const GRIME = [0.33, 0.29, 0.245];
const ALU = [0.63, 0.635, 0.64];
const PRIMER = [0.52, 0.5, 0.36]; // yellow-green zinc chromate showing at chipped edges

function streakBins(seeds) {
  const bins = new Map();
  seeds.forEach((s, i) => {
    for (let b = Math.floor((s.p[2] - 0.05) * 4); b <= Math.floor((s.p[2] + s.len) * 4); b++) {
      if (!bins.has(b)) bins.set(b, []);
      bins.get(b).push(i);
    }
  });
  return bins;
}
/** Streak density at a point: [dark oil, glossy fluid]. */
function streaksAt(seeds, bins, px, py, pz, out) {
  out[0] = 0; out[1] = 0;
  const list = bins.get(Math.floor(pz * 4));
  if (!list) return out;
  for (const i of list) {
    const s = seeds[i];
    const along = pz - s.p[2];
    const u = along / s.len;
    if (u < -0.03 || u > 1) continue;
    const dx = px - s.p[0], dy = py - (s.p[1] - s.sag * Math.max(0, along));
    const w = s.w * (1 + 1.4 * Math.max(0, u));
    const lat2 = (dx * dx + dy * dy) / (w * w);
    if (lat2 > 9) continue;
    const wob = 0.65 + 0.35 * vnoise(along * 38 + i * 7.3, i * 1.7, 0);
    const v = s.k * Math.exp(-lat2) * Math.pow(1 - Math.max(0, u), 0.8) * sstep(-0.03, 0.02, u) * wob;
    out[s.wet ? 1 : 0] = Math.max(out[s.wet ? 1 : 0], v);
  }
  return out;
}

/**
 * One skin material: returns the new base colour, normal map and ORM pixels.
 */
async function buildSkin({ rec, baseBuf, normalBuf, specBuf, bw, bh, up, native, role, seeds, collectSeeds, tag }) {
  const P = SKIN[rec.part];
  const W = bw * up, H = bh * up, n = W * H;
  const s = W / native; // texel scale against the atlas the art was drawn at
  const hostile = role === 'hostile';
  const { rgb, alpha, channels } = await readRGB(baseBuf, W, H, 'lanczos3', up > 1);
  const metalMask = specBuf ? await readGray(specBuf, W, H) : new Float32Array(n);
  const { pos, nrm, cov } = rasterise(rec, W, H);
  const ao = await loadAO(rec.part, W, H);

  // --- albedo analysis
  const L = new Float32Array(n), sat = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const r = rgb[i * 3], g = rgb[i * 3 + 1], b = rgb[i * 3 + 2];
    L[i] = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    sat[i] = mx > 1e-4 ? (mx - mn) / mx : 0;
  }
  // thin dark marks: black top-hat (closing - image)
  const r = Math.max(1, Math.round(1.6 * s));
  const hat = morph(morph(L, W, H, r, 1), W, H, r, -1);
  const mark = new Float32Array(n); // saturated paint: roundels, fin flash, stencils, dielectric green
  for (let i = 0; i < n; i++) mark[i] = sat[i] > 0.34 && L[i] > 0.1 ? 1 : 0;
  const markSoft = blur(mark, W, H, 1.5 * s);
  const line = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (!cov[i]) continue;
    const d = hat[i] - L[i];
    // relative to the local paint tone, so lines on dark camouflage count as much as on light grey
    line[i] = sstep(0.07, 0.42, d / Math.max(0.12, hat[i])) * (1 - sstep(0.02, 0.3, markSoft[i])) * sstep(0.1, 0.2, hat[i]);
  }
  await debugGray(`${tag}.line`, line, W, H);
  const wide = blur(L, W, H, 8 * s);

  // --- panels: regions enclosed by lines get a tone and a gloss of their own
  const panel = new Int32Array(n).fill(-1);
  const panelSize = [];
  {
    const stack = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      if (panel[i] >= 0 || !cov[i] || line[i] > 0.3) continue;
      const id = panelSize.length;
      let sp = 0, count = 0;
      stack[sp++] = i;
      panel[i] = id;
      while (sp) {
        const q = stack[--sp];
        count++;
        const x = q % W, y = (q / W) | 0;
        if (x > 0) { const o = q - 1; if (panel[o] < 0 && cov[o] && line[o] <= 0.3) { panel[o] = id; stack[sp++] = o; } }
        if (x < W - 1) { const o = q + 1; if (panel[o] < 0 && cov[o] && line[o] <= 0.3) { panel[o] = id; stack[sp++] = o; } }
        if (y > 0) { const o = q - W; if (panel[o] < 0 && cov[o] && line[o] <= 0.3) { panel[o] = id; stack[sp++] = o; } }
        if (y < H - 1) { const o = q + W; if (panel[o] < 0 && cov[o] && line[o] <= 0.3) { panel[o] = id; stack[sp++] = o; } }
      }
      panelSize.push(count);
    }
  }
  const bigPanel = 26000 * s * s; // larger than this is several panels leaking together

  // --- streak seeds: strong line texels on the sides and belly (canonical file only)
  if (collectSeeds) {
    const cand = [];
    for (let i = 0; i < n; i++) {
      if (line[i] < 0.6 || cov[i] !== 2 || ao[i] < 0.55) continue;
      const y = pos[i * 3 + 1], z = pos[i * 3 + 2], ny = nrm[i * 3 + 1];
      if (ny > 0.2 || z < -5.6 || z > 5.3 || y > -0.35) continue;
      cand.push(i);
    }
    const want = 190, p = want / cand.length;
    for (const i of cand) {
      if (hash1(i * 3 + 1) > p) continue;
      const h = (k) => hash1(i * 11 + k);
      const wet = h(2) < 0.3;
      collectSeeds.push({
        p: [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]].map((v) => +v.toFixed(4)),
        len: +(0.18 + h(3) * h(3) * 1.25).toFixed(3),
        w: +(0.006 + h(4) * 0.016).toFixed(4),
        k: +(0.3 + h(5) * 0.55).toFixed(3),
        sag: +((1 - Math.abs(nrm[i * 3 + 1])) * (0.05 + h(6) * 0.3)).toFixed(3),
        wet,
      });
    }
  }
  const bins = seeds ? streakBins(seeds) : null;

  // --- per-texel weathering
  const rough = new Float32Array(n), metal = new Float32Array(n);
  const st = [0, 0];
  const base0 = hostile ? 0.47 : 0.43;
  for (let i = 0; i < n; i++) {
    let cr = rgb[i * 3], cg = rgb[i * 3 + 1], cb = rgb[i * 3 + 2];
    const l = L[i];
    const mm = sstep(0.25, 0.6, metalMask[i]);
    const paint = (1 - sstep(0.2, 0.34, sat[i])) * (1 - mm) * sstep(0.1, 0.22, l);
    // roughness of the surface as painted
    let ro = base0 + clamp((wide[i] - l) * 1.5, -0.05, 0.22);
    ro = mix(ro, 0.37, sstep(0.3, 0.45, sat[i]) * (1 - mm)); // markings: newer, glossier paint
    ro = mix(ro, 0.62, (1 - sstep(0.06, 0.14, l)) * (1 - mm)); // black rubber, dark openings
    let me = 0;
    if (!cov[i]) { rough[i] = ro; metal[i] = mm * 0.9; continue; }
    const px = pos[i * 3], py = pos[i * 3 + 1], pz = pos[i * 3 + 2];
    const nx = nrm[i * 3], ny = nrm[i * 3 + 1], nz = nrm[i * 3 + 2];
    const a = ao[i];
    const rad = Math.hypot(px, py - AXIS_Y);

    // 1. panel tone and gloss; repainted patches
    if (P.tone > 0 && paint > 0) {
      const id = panel[i];
      let t = 0, g = 0;
      if (id >= 0 && panelSize[id] < bigPanel && panelSize[id] > 40 * s * s) { t = hash1(id * 7 + 3) * 2 - 1; g = hash1(id * 13 + 5) * 2 - 1; }
      const lf = fbm(px * 0.85 + 3.1, py * 0.85, pz * 0.6) * 2 - 1;
      const k = 1 + (t * 0.036 + lf * 0.03) * P.tone * paint;
      cr *= k; cg *= k; cb *= k * (1 + t * 0.006);
      ro += (g * 0.05 + lf * 0.07) * P.tone * paint;
    }

    // 2. bare metal (the source's specular mask): brushed, heat-tinted toward the nozzle
    if (mm > 0) {
      const br = 0.5 + 0.5 * vnoise(px * 9, py * 9, pz * 140);
      let mr = 0.3 + 0.16 * br, mk = 1.5;
      let tr = 1, tg = 1, tb = 1;
      const hot = sstep(4.9, 5.9, pz) * (rad < 0.8 ? 1 : 0);
      if (hot > 0) {
        // temper colours along the jet pipe: straw, bronze, purple, blue toward the hot end
        const u = clamp((pz - 5.2) / 1.25 + (fbm(px * 5, py * 5, pz * 1.5) - 0.5) * 0.5);
        const stops = [[0.7, 0.62, 0.46], [0.62, 0.47, 0.33], [0.47, 0.37, 0.42], [0.38, 0.41, 0.52], [0.38, 0.39, 0.4]];
        const f = u * (stops.length - 1), i0 = Math.min(stops.length - 2, Math.floor(f)), ft = f - i0;
        tr = mix(1, mix(stops[i0][0], stops[i0 + 1][0], ft) / 0.5, hot * 0.6);
        tg = mix(1, mix(stops[i0][1], stops[i0 + 1][1], ft) / 0.5, hot * 0.6);
        tb = mix(1, mix(stops[i0][2], stops[i0 + 1][2], ft) / 0.5, hot * 0.6);
        mr += 0.1 * hot;
        mk = 1.7;
      }
      cr = mix(cr, clamp(cr * mk * tr, 0, 0.9), mm); cg = mix(cg, clamp(cg * mk * tg, 0, 0.9), mm); cb = mix(cb, clamp(cb * mk * tb, 0, 0.9), mm);
      ro = mix(ro, mr, mm);
      me = mm * 0.92;
    }

    // 3. leading-edge erosion: anything that faces the airflow
    if (P.wear > 0) {
      const face = sstep(0.3, 0.62, -nz) * sstep(0.35, 0.7, a) * P.wear;
      if (face > 0.01) {
        const fine = vnoise(px * 95, py * 95, pz * 95), mid = vnoise(px * 23 + 5, py * 23, pz * 23), big = fbm(px * 3.1, py * 3.1 + 9, pz * 3.1);
        // dull sand-blasted band
        const dull = face * (0.55 + 0.45 * big) * paint;
        cr = mix(cr, cr * 1.07 + 0.012, dull); cg = mix(cg, cg * 1.07 + 0.012, dull); cb = mix(cb, cb * 1.07 + 0.012, dull);
        ro += 0.13 * dull;
        // chips down to primer, then to metal
        const chip = sstep(0.8, 0.88, fine * 0.5 + mid * 0.5 + face * 0.12 + big * 0.1) * face * paint * (hostile ? 0.7 : 1);
        if (chip > 0) {
          const deep = sstep(0.5, 0.9, chip) * sstep(0.45, 0.7, fine);
          cr = mix(cr, mix(PRIMER[0], ALU[0], deep), chip * 0.8); cg = mix(cg, mix(PRIMER[1], ALU[1], deep), chip * 0.8); cb = mix(cb, mix(PRIMER[2], ALU[2], deep), chip * 0.8);
          me = Math.max(me, chip * deep * 0.9);
          ro = mix(ro, mix(0.55, 0.3, deep), chip * 0.8);
        }
      }
    }

    // 4. walkway scuffs: wing roots, upper surface
    if (rec.part === 'airframe' && ny > 0.75 && py < -0.55 && py > -0.9) {
      const ax = Math.abs(px);
      const zone = sstep(0.55, 0.7, ax) * (1 - sstep(1.25, 1.75, ax)) * sstep(-0.4, 0.2, pz) * (1 - sstep(2.6, 3.1, pz)) * paint;
      if (zone > 0.01) {
        const patch = sstep(0.42, 0.62, fbm(px * 7, 3.3, pz * 5.5));
        const scratch = sstep(0.72, 0.8, vnoise(px * 160, 1.1, pz * 14 + px * 30)) * 0.6;
        const sc = zone * clamp(patch * 0.8 + scratch + 0.15);
        cr = mix(cr, cr * 0.84 + 0.01, sc); cg = mix(cg, cg * 0.83 + 0.008, sc); cb = mix(cb, cb * 0.8, sc);
        ro += 0.24 * sc;
      }
    }

    // 5. exhaust: soot on the last metre of the fuselage, the stabilator roots and under the fin
    if (P.soot > 0) {
      const aft = sstep(4.7, 6.35, pz) * (1 - sstep(0.72, 1.0, rad));
      if (aft > 0.01) {
        const th = Math.atan2(px, py - AXIS_Y);
        const stre = 0.45 + 0.55 * fbm(th * 4.2, 1.7, pz * 0.9);
        // inside the jet pipe (normal toward the axis) the metal is burnt, not caked
        const inward = (nx * px + ny * (py - AXIS_Y)) / Math.max(rad, 1e-3) < -0.3 ? 0.3 : 1;
        const so = clamp(aft * aft * stre * 0.75) * P.soot * (1 - mm * 0.5) * inward;
        cr = mix(cr, SOOT[0], so); cg = mix(cg, SOOT[1], so); cb = mix(cb, SOOT[2], so);
        ro = mix(ro, 0.82, so);
        me *= 1 - so * 0.6;
        // scorched paint band ahead of the soot
        const scorch = sstep(4.3, 5.2, pz) * (1 - sstep(5.3, 6.2, pz)) * (1 - sstep(0.72, 1.0, rad)) * paint * (0.5 + 0.5 * stre) * 0.22 * P.soot;
        cr = mix(cr, cr * 0.9 + 0.035, scorch); cg = mix(cg, cg * 0.82 + 0.02, scorch); cb = mix(cb, cb * 0.66, scorch);
        ro += scorch * 0.5;
      }
      // 6. gun: GSh-23 muzzles at the front of the belly pack (z -2.6), blast streaks running aft
      if (py < -0.95 && pz > -2.85 && pz < 1.2 && Math.abs(px) < 0.6) {
        const dz = pz + 2.62;
        const lat = Math.abs(px) - 0.07;
        const width = 0.075 + 0.11 * clamp(dz / 2.5);
        const core = Math.exp(-(lat * lat) / (width * width)) * sstep(-0.22, 0.05, dz) * Math.exp(-Math.max(0, dz) / 1.15);
        const fl = 0.55 + 0.45 * fbm(px * 14, 2.2, pz * 2.4);
        const gs = clamp(core * fl * 0.95) * P.soot;
        cr = mix(cr, SOOT[0] * 0.9, gs); cg = mix(cg, SOOT[1] * 0.9, gs); cb = mix(cb, SOOT[2] * 0.9, gs);
        ro = mix(ro, 0.86, gs);
        me *= 1 - gs * 0.7;
      }
    }

    // 7. oil and hydraulic streaks from panel lines
    if (P.streaks > 0 && bins && ny < 0.45) {
      streaksAt(seeds, bins, px, py, pz, st);
      const dry = st[0] * P.streaks * sstep(0.45, 0.2, ny), wet = st[1] * P.streaks * sstep(0.45, 0.2, ny);
      if (dry > 0.003) {
        cr = mix(cr, OIL[0], dry * 0.75); cg = mix(cg, OIL[1], dry * 0.75); cb = mix(cb, OIL[2], dry * 0.75);
        ro += dry * 0.3;
      }
      if (wet > 0.003) {
        cr = mix(cr, cr * 0.62 + 0.012, wet); cg = mix(cg, cg * 0.57 + 0.006, wet); cb = mix(cb, cb * 0.5, wet);
        ro = mix(ro, 0.2, wet * 0.9); // still wet: glossier than the paint around it
      }
    }

    // 8. belly grime: road dust and oil mist, heaviest along the centre line and aft of the wheel wells
    if (P.belly > 0 && ny < -0.15) {
      const down = sstep(0.15, 0.8, -ny);
      const str = fbm(px * 3.2, 5.5, pz * 0.55), fine = vnoise(px * 37, 0.7, pz * 6.5);
      const centre = 0.55 + 0.45 * Math.exp(-(px * px) / 0.9);
      const g = down * clamp(0.3 + 0.75 * str + 0.25 * (fine - 0.5)) * centre * (0.75 + 0.25 * sstep(-1, 1.5, pz)) * P.belly * (1 - mm * 0.6);
      const k = 0.34 * g;
      cr = mix(cr, cr * 0.7 + GRIME[0] * 0.14, k * 1.6 > 1 ? 1 : k * 1.6); cg = mix(cg, cg * 0.69 + GRIME[1] * 0.14, Math.min(1, k * 1.6)); cb = mix(cb, cb * 0.66 + GRIME[2] * 0.14, Math.min(1, k * 1.6));
      ro += 0.2 * g;
    }

    // 9. dirt held in cavities; also stands in for the direct-light shadowing AO cannot give
    {
      const cav = 1 - sstep(0.3, 0.86, a);
      const k = cav * 0.34 * (1 - mm * 0.4);
      cr *= 1 - k; cg *= 1 - k * 1.03; cb *= 1 - k * 1.08;
      ro += cav * 0.14;
    }

    // 10. panel lines: crisp when the atlas was upscaled (the relief is in the normal map)
    if (up > 1) {
      const k = sstep(0.3, 0.75, line[i]) * 0.34 * paint;
      cr *= 1 - k; cg *= 1 - k; cb *= 1 - k;
    }
    ro += line[i] * 0.12;

    rgb[i * 3] = clamp(cr); rgb[i * 3 + 1] = clamp(cg); rgb[i * 3 + 2] = clamp(cb);
    rough[i] = clamp(ro, 0.16, 0.96);
    metal[i] = clamp(me);
  }

  // --- normal map: grooves and dimples from the line mask, on top of the source map
  const h = blur(line, W, H, 0.55 * s);
  const src = normalBuf ? (await readRGB(normalBuf, W, H, 'cubic')).rgb : null;
  const nb = Buffer.alloc(n * 3);
  const K = 1.35 * s * P.relief;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    const hx = h[y * W + Math.min(W - 1, x + 1)] - h[y * W + Math.max(0, x - 1)];
    const hy = h[Math.min(H - 1, y + 1) * W + x] - h[Math.max(0, y - 1) * W + x];
    // height = -h (a line is a groove). glTF normal maps: +X right, +Y up the image.
    let nx = 0.5 * K * hx, ny = -0.5 * K * hy, nz = 1;
    if (src) {
      const sx = src[i * 3] * 2 - 1, sy = src[i * 3 + 1] * 2 - 1, sz = Math.max(0.2, src[i * 3 + 2] * 2 - 1);
      nx += sx / sz; ny += sy / sz;
    }
    const Ln = Math.hypot(nx, ny, nz);
    nb[i * 3] = toU8(nx / Ln * 0.5 + 0.5); nb[i * 3 + 1] = toU8(ny / Ln * 0.5 + 0.5); nb[i * 3 + 2] = toU8(nz / Ln * 0.5 + 0.5);
  }

  await debugRGB(`${tag}.base`, rgb, W, H);
  await debugGray(`${tag}.rough`, rough, W, H);
  await debugGray(`${tag}.metal`, metal, W, H);
  return { W, H, rgb, alpha, hasAlpha: channels === 4 && alpha.some((v) => v < 255), normal: nb, rough, metal, ao };
}

/** Pack occlusion / roughness / metalness at (W, H) from maps at (sw, sh). */
function packORM(W, H, ao, rough, metal, sw, sh) {
  const b = Buffer.alloc(W * H * 3);
  const fx = sw / W, fy = sh / H;
  const box = (m, x, y) => {
    let a = 0, c = 0;
    for (let yy = Math.floor(y * fy); yy < Math.max(Math.floor(y * fy) + 1, Math.floor((y + 1) * fy)); yy++) {
      for (let xx = Math.floor(x * fx); xx < Math.max(Math.floor(x * fx) + 1, Math.floor((x + 1) * fx)); xx++) { a += m[yy * sw + xx]; c++; }
    }
    return a / c;
  };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const o = (y * W + x) * 3;
    b[o] = toU8(box(ao, x, y)); b[o + 1] = toU8(box(rough, x, y)); b[o + 2] = toU8(box(metal, x, y));
  }
  return b;
}

const webp = (raw, W, H, ch, q, extra = {}) => sharp(raw, { raw: { width: W, height: H, channels: ch } }).webp({ quality: q, effort: 6, ...extra }).toBuffer();

// ---------------------------------------------------------------- per file
function fetchInput(file) {
  const p = path.join(CACHE, 'in', file);
  if (!existsSync(p)) {
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, execFileSync('git', ['show', `${BASE}:public/models/${file}`], { cwd: ROOT, maxBuffer: 1 << 28 }));
  }
  return p;
}

async function build({ file, role, upscale = {} }, canonical) {
  const doc = await io.read(fetchInput(file));
  const root = doc.getRoot();
  const sceneData = readScene(doc);
  const sizes = new Map();
  for (const [mat] of sceneData.byMat) { const t = mat?.getBaseColorTexture(); if (t) sizes.set(mat, t.getSize()); }
  const report = [];

  let canon = existsSync(SEEDS) ? JSON.parse(readFileSync(SEEDS, 'utf8')) : null;
  if (canonical) {
    await bakeCanonicalAO(sceneData, sizes);
    canon = { native: {}, seeds: [] };
    for (const [mat, rec] of sceneData.byMat) if (sizes.has(mat)) canon.native[rec.part] = sizes.get(mat)[0];
    // seeds come from the airframe's own line mask: a dry run of that material
    for (const [mat, rec] of sceneData.byMat) {
      if (rec.part !== 'airframe') continue;
      const [bw, bh] = sizes.get(mat);
      await buildSkin({ rec, baseBuf: mat.getBaseColorTexture().getImage(), normalBuf: null, specBuf: null, bw, bh, up: 1, native: bw, role, seeds: null, collectSeeds: canon.seeds, tag: 'seed' });
    }
    writeFileSync(SEEDS, JSON.stringify(canon));
    console.log(`  streak seeds: ${canon.seeds.length}`);
  }
  if (!canon) throw new Error('run mig21.glb first (canonical AO and seeds)');

  for (const [mat, rec] of sceneData.byMat) {
    const skin = SKIN[rec.part], cockpit = COCKPIT.has(rec.part);
    if (!mat || (!skin && !cockpit) || !sizes.has(mat)) continue;
    const baseTex = mat.getBaseColorTexture(), normalTex = mat.getNormalTexture();
    const specExt = mat.getExtension('KHR_materials_specular');
    const specTex = specExt?.getSpecularColorTexture?.() ?? specExt?.getSpecularTexture?.() ?? null;
    const [bw, bh] = sizes.get(mat);
    // the ORM takes the place (and the size) of the specular map
    const [ow, oh] = specTex?.getSize() ?? [Math.min(1024, bw), Math.min(1024, bh)];
    let ormRaw;
    if (cockpit) {
      const ao = await loadAO(rec.part, ow, oh);
      const lum = await readGray(baseTex.getImage(), ow, oh);
      const rough = new Float32Array(ow * oh), metal = new Float32Array(ow * oh);
      // painted panels satin; black instrument faces and rubber a little glossier / rougher by tone
      for (let i = 0; i < ow * oh; i++) rough[i] = clamp(0.66 + (0.3 - lum[i]) * 0.18 + (1 - ao[i]) * 0.1, 0.45, 0.9);
      ormRaw = packORM(ow, oh, ao, rough, metal, ow, oh);
    } else {
      const up = upscale[rec.part] ?? 1;
      const out = await buildSkin({
        rec, baseBuf: baseTex.getImage(), normalBuf: normalTex?.getImage() ?? null, specBuf: specTex?.getImage() ?? null,
        bw, bh, up, native: canon.native[rec.part] ?? bw, role, seeds: canon.seeds, collectSeeds: null, tag: `${path.basename(file, '.glb')}.${rec.part}`,
      });
      const { W, H } = out;
      let baseRaw;
      if (out.hasAlpha) {
        baseRaw = Buffer.alloc(W * H * 4);
        for (let i = 0; i < W * H; i++) { baseRaw[i * 4] = toU8(out.rgb[i * 3]); baseRaw[i * 4 + 1] = toU8(out.rgb[i * 3 + 1]); baseRaw[i * 4 + 2] = toU8(out.rgb[i * 3 + 2]); baseRaw[i * 4 + 3] = out.alpha[i]; }
      } else {
        baseRaw = Buffer.alloc(W * H * 3);
        for (let i = 0; i < W * H * 3; i++) baseRaw[i] = toU8(out.rgb[i]);
      }
      baseTex.setImage(new Uint8Array(await webp(baseRaw, W, H, out.hasAlpha ? 4 : 3, 88))).setMimeType('image/webp');
      const nimg = new Uint8Array(await webp(out.normal, W, H, 3, 92, { smartSubsample: true }));
      if (normalTex) normalTex.setImage(nimg).setMimeType('image/webp');
      else mat.setNormalTexture(doc.createTexture(`${rec.part}_normal`).setImage(nimg).setMimeType('image/webp'));
      // no texel on the skin is ever fully dark: light bounces inside a duct or a wheel well
      ormRaw = packORM(ow, oh, out.ao.map((v) => 0.14 + 0.86 * v), out.rough, out.metal, W, H);
    }
    const ormImg = new Uint8Array(await webp(ormRaw, ow, oh, 3, 90, { smartSubsample: true }));
    const orm = (specTex ?? doc.createTexture()).setName(`${rec.part}_orm`).setImage(ormImg).setMimeType('image/webp');
    mat.setExtension('KHR_materials_specular', null);
    mat.setOcclusionTexture(orm).setMetallicRoughnessTexture(orm).setRoughnessFactor(1).setMetallicFactor(1).setOcclusionStrength(1);
    report.push(`${rec.part} base ${mat.getBaseColorTexture().getSize().join('x')} orm ${ow}x${oh}`);
  }
  // textures nothing points at any more
  for (const t of root.listTextures()) if (t.listParents().length <= 1) t.dispose();
  const node0 = root.listNodes().find((n) => n.getExtras()?.baked || n.getExtras()?.lod !== undefined);
  if (node0) node0.setExtras({ ...node0.getExtras(), skin: 'ao + roughness + metalness in <part>_orm; tools/blender/build-mig-skin.mjs' });
  const out = path.join(ROOT, 'public/models', file);
  await io.write(out, doc);
  let gpu = 0;
  for (const t of root.listTextures()) { const s = t.getSize(); gpu += s[0] * s[1] * 4 * 4 / 3; }
  console.log(`${file}: ${statSync(out).size} B, ${root.listTextures().length} textures, GPU ${(gpu / 1048576).toFixed(1)} MiB\n  ${report.join('\n  ')}`);
}

for (const [i, f] of FILES.entries()) {
  if (ONLY && f.file !== ONLY && !(i === 0 && !existsSync(SEEDS))) continue;
  await build(f, i === 0);
}
