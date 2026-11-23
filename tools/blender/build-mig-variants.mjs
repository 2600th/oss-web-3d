/**
 * Enemy MiG-21 variants from public/models/mig21.glb:
 *
 *   public/models/mig21_hostile.glb       full airframe, hostile two-tone grey
 *   (LOD1 is made from the raw copy by tools/blender/build_mig_lod1.py)
 *
 * Both are baked to the runtime conventions (metres, nose -Z, +Y up, origin at
 * the bbox centre) exactly as src/flight/Aircraft.js normalises the player
 * model, so they load with loadModel() without any fix-up.
 *
 * Repaint: every skin texture is re-coloured texel by texel. Each texel's 3D
 * position is found by rasterising the triangles that use it in UV space, so
 * the camo pattern is continuous across UV seams (3D noise, mirrored in x).
 * National markings (roundels, fin flashes) and the green dielectric panels
 * are detected by colour and painted over.
 *
 *   node tools/blender/build-mig-variants.mjs
 */
import { getBounds } from '@gltf-transform/core';
import { dequantize } from '@gltf-transform/functions';
import { statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { io, optimize, countTriangles, sharp } from './gltf-pipeline.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = path.join(ROOT, 'public/models/mig21.glb');
const OUT0 = path.join(ROOT, 'public/models/mig21_hostile.glb');
const EVID = path.join(ROOT, 'assets/authoring/build/hostile_tex');
const REAL_LENGTH = 15.76;

// Node names in mig21.glb -> readable names (identified with tools/blender/inspect_mig.py).
const NODE_NAMES = {
  Object_13: 'airframe',
  Object_9: 'cockpit_interior',
  Object_8: 'cockpit_seat',
  Object_30: 'canopy_glass',
  Object_28: 'stores',
  Object_23: 'underside',
  Object_27: 'details_alpha',
  Object_12: 'flaps',
  Object_26: 'gear_doors',
  Object_5: 'ventral',
  Object_2: 'ventral_fairing',
  Object_7: 'strake',
  Object_3: 'glass_misc',
  Object_11: 'pitot',
};

// Hostile scheme (sRGB 0..1)
const UPPER_A = [0.30, 0.33, 0.37]; // dark blue-grey
const UPPER_B = [0.52, 0.55, 0.58]; // medium grey
const UNDER = [0.66, 0.69, 0.71]; // light grey
const DIELECTRIC = [0.24, 0.25, 0.26];

// ---------------------------------------------------------------- noise
function hash(x, y, z) {
  let h = (x * 374761393 + y * 668265263 + z * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
const fade = (t) => t * t * (3 - 2 * t);
function vnoise(x, y, z) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = fade(x - xi), yf = fade(y - yi), zf = fade(z - zi);
  let r = 0;
  for (let dz = 0; dz < 2; dz++) for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
    const w = (dx ? xf : 1 - xf) * (dy ? yf : 1 - yf) * (dz ? zf : 1 - zf);
    r += w * hash(xi + dx, yi + dy, zi + dz);
  }
  return r;
}
const fbm = (x, y, z) => 0.6 * vnoise(x, y, z) + 0.3 * vnoise(x * 2.1 + 7, y * 2.1, z * 2.1) + 0.1 * vnoise(x * 4.3, y * 4.3 + 3, z * 4.3);
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

function rgb2hsv(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d > 1e-5) {
    if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return [h, mx ? d / mx : 0, mx];
}

// ---------------------------------------------------------------- helpers
function mulMat4Vec3(m, v) {
  return [
    m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12],
    m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13],
    m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14],
  ];
}

/** Rasterise all triangles textured by `texture` into a per-texel 3D position/normal map. */
function rasterise(doc, texture, W, H, toModel) {
  const pos = new Float32Array(W * H * 3);
  const nrm = new Float32Array(W * H * 3);
  const cov = new Uint8Array(W * H);
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const wm = node.getWorldMatrix();
    for (const prim of mesh.listPrimitives()) {
      const mat = prim.getMaterial();
      if (!mat || mat.getBaseColorTexture() !== texture) continue;
      const P = prim.getAttribute('POSITION');
      const T = prim.getAttribute('TEXCOORD_' + (mat.getBaseColorTextureInfo().getTexCoord() || 0));
      if (!T) continue;
      const I = prim.getIndices();
      const n = I ? I.getCount() : P.getCount();
      const a = [], b = [];
      const tp = [[], [], []], tu = [[], [], []];
      for (let i = 0; i < n; i += 3) {
        for (let k = 0; k < 3; k++) {
          const idx = I ? I.getScalar(i + k) : i + k;
          tp[k] = toModel(mulMat4Vec3(wm, P.getElement(idx, a)));
          const uv = T.getElement(idx, b);
          tu[k] = [(uv[0] - Math.floor(uv[0] * 0.999999)) * W - 0.5, (uv[1] - Math.floor(uv[1] * 0.999999)) * H - 0.5];
        }
        // face normal (model space)
        const e1 = tp[1].map((v, j) => v - tp[0][j]), e2 = tp[2].map((v, j) => v - tp[0][j]);
        let fn = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
        const L = Math.hypot(...fn) || 1;
        fn = fn.map((v) => v / L);
        const [p0, p1, p2] = tu;
        const minx = Math.max(0, Math.floor(Math.min(p0[0], p1[0], p2[0])));
        const maxx = Math.min(W - 1, Math.ceil(Math.max(p0[0], p1[0], p2[0])));
        const miny = Math.max(0, Math.floor(Math.min(p0[1], p1[1], p2[1])));
        const maxy = Math.min(H - 1, Math.ceil(Math.max(p0[1], p1[1], p2[1])));
        const den = (p1[1] - p2[1]) * (p0[0] - p2[0]) + (p2[0] - p1[0]) * (p0[1] - p2[1]);
        if (Math.abs(den) < 1e-9) continue;
        for (let y = miny; y <= maxy; y++) for (let x = minx; x <= maxx; x++) {
          const w0 = ((p1[1] - p2[1]) * (x - p2[0]) + (p2[0] - p1[0]) * (y - p2[1])) / den;
          const w1 = ((p2[1] - p0[1]) * (x - p2[0]) + (p0[0] - p2[0]) * (y - p2[1])) / den;
          const w2 = 1 - w0 - w1;
          if (w0 < -0.02 || w1 < -0.02 || w2 < -0.02) continue;
          const o = y * W + x;
          cov[o] = 1;
          for (let j = 0; j < 3; j++) {
            pos[o * 3 + j] = w0 * tp[0][j] + w1 * tp[1][j] + w2 * tp[2][j];
            nrm[o * 3 + j] = fn[j];
          }
        }
      }
    }
  }
  // dilate coverage a few texels so filtering/mips at island borders stay in colour
  for (let it = 0; it < 6; it++) {
    const add = [];
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const o = y * W + x;
      if (cov[o]) continue;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
        const q = yy * W + xx;
        if (cov[q]) { add.push([o, q]); break; }
      }
    }
    for (const [o, q] of add) {
      cov[o] = 1;
      for (let j = 0; j < 3; j++) { pos[o * 3 + j] = pos[q * 3 + j]; nrm[o * 3 + j] = nrm[q * 3 + j]; }
    }
  }
  return { pos, nrm, cov };
}

/** Connected components of a boolean mask; returns [{count, x0,y0,x1,y1}]. */
function components(mask, W, H) {
  const lab = new Int32Array(W * H).fill(-1);
  const out = [];
  const st = [];
  for (let i = 0; i < W * H; i++) {
    if (!mask[i] || lab[i] >= 0) continue;
    const c = { count: 0, x0: W, y0: H, x1: 0, y1: 0, id: out.length };
    st.push(i);
    lab[i] = c.id;
    while (st.length) {
      const p = st.pop();
      const x = p % W, y = (p / W) | 0;
      c.count++;
      c.x0 = Math.min(c.x0, x); c.x1 = Math.max(c.x1, x); c.y0 = Math.min(c.y0, y); c.y1 = Math.max(c.y1, y);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
        const q = yy * W + xx;
        if (mask[q] && lab[q] < 0) { lab[q] = c.id; st.push(q); }
      }
    }
    out.push(c);
  }
  return { comps: out, lab };
}

async function repaint(doc, texture, toModel, report) {
  const img = texture.getImage();
  const { data, info } = await sharp(Buffer.from(img)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height;
  const { pos, nrm, cov } = rasterise(doc, texture, W, H, toModel);

  // marking detection
  const orange = new Uint8Array(W * H), green = new Uint8Array(W * H);
  let lumSum = 0, lumN = 0;
  for (let i = 0; i < W * H; i++) {
    const r = data[i * 4] / 255, g = data[i * 4 + 1] / 255, b = data[i * 4 + 2] / 255;
    const [h, s, v] = rgb2hsv(r, g, b);
    if (h > 5 && h < 42 && s > 0.45 && v > 0.45) orange[i] = 1;
    if (h > 75 && h < 175 && s > 0.28 && v > 0.2) green[i] = 1;
    if (s < 0.15 && v > 0.35 && v < 0.92) { lumSum += v; lumN++; }
  }
  const ref = lumN ? lumSum / lumN : 0.6;
  const force = new Uint8Array(W * H); // 1 = marking, 2 = dielectric
  const O = components(orange, W, H).comps.filter((c) => c.count > 6);
  const Gc = components(green, W, H);
  const G = Gc.comps.filter((c) => c.count > 6);
  const usedG = new Set();
  let markings = 0;
  for (const o of O) {
    const cx = (o.x0 + o.x1) / 2, cy = (o.y0 + o.y1) / 2;
    const sw = o.x1 - o.x0 + 1, sh = o.y1 - o.y0 + 1;
    let x0 = o.x0, x1 = o.x1, y0 = o.y0, y1 = o.y1;
    let roundel = false;
    for (const g of G) {
      const gx = (g.x0 + g.x1) / 2, gy = (g.y0 + g.y1) / 2;
      const inside = gx > o.x0 && gx < o.x1 && gy > o.y0 && gy < o.y1;
      const near = Math.abs(gx - cx) < Math.max(sw, sh) * 1.6 && Math.abs(gy - cy) < Math.max(sw, sh) * 1.6 && g.count < o.count * 3;
      if (inside) { roundel = true; usedG.add(g.id); }
      else if (near) { usedG.add(g.id); x0 = Math.min(x0, g.x0); x1 = Math.max(x1, g.x1); y0 = Math.min(y0, g.y0); y1 = Math.max(y1, g.y1); }
    }
    const pad = 5;
    x0 -= pad; y0 -= pad; x1 += pad; y1 += pad;
    const ex = (x1 - x0) / 2, ey = (y1 - y0) / 2, mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
    for (let y = Math.max(0, y0); y <= Math.min(H - 1, y1); y++) for (let x = Math.max(0, x0); x <= Math.min(W - 1, x1); x++) {
      if (roundel && ((x - mx) / ex) ** 2 + ((y - my) / ey) ** 2 > 1) continue;
      force[y * W + x] = 1;
    }
    markings++;
  }
  let dielectric = 0;
  for (const g of G) {
    if (usedG.has(g.id)) continue;
    dielectric++;
    for (let y = g.y0; y <= g.y1; y++) for (let x = g.x0; x <= g.x1; x++) {
      const i = y * W + x;
      if (Gc.lab[i] === g.id) force[i] = 2;
    }
  }
  // grow the dielectric mask by 1px to catch anti-aliased edges
  for (let i = 0; i < W * H; i++) {
    if (force[i] !== 2) continue;
    for (const d of [1, -1, W, -W]) if (force[i + d] === 0 && green[i + d] === 0) force[i + d] = 3;
  }

  const outBuf = Buffer.alloc(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    const r = data[i * 4] / 255, g = data[i * 4 + 1] / 255, b = data[i * 4 + 2] / 255;
    const [, s, v] = rgb2hsv(r, g, b);
    let o = [r, g, b];
    if (cov[i]) {
      const px = Math.abs(pos[i * 3]), py = pos[i * 3 + 1], pz = pos[i * 3 + 2];
      const ny = nrm[i * 3 + 1];
      // upper/under split by surface normal (model +Y up) and height
      const under = smooth(-0.15, -0.45, ny) * smooth(0.3, -0.2, py);
      const blot = smooth(0.47, 0.53, fbm(px * 0.62 + 11.3, py * 0.62, pz * 0.45));
      const up = UPPER_A.map((c, j) => c + (UPPER_B[j] - c) * blot);
      const camo = up.map((c, j) => c + (UNDER[j] - c) * under);
      const paintW = smooth(0.2, 0.32, v) * (1 - smooth(0.16, 0.26, s));
      const k = Math.min(1.15, Math.max(0.35, v / ref));
      if (force[i] === 1) {
        o = camo.map((c) => c * (0.96 + 0.06 * vnoise(i % W * 0.3, (i / W) * 0.3, 0)));
      } else if (force[i] >= 2) {
        o = DIELECTRIC.map((c) => c * Math.min(1.3, Math.max(0.6, v / 0.45)));
      } else if (paintW > 0) {
        o = o.map((c, j) => c + (camo[j] * k - c) * paintW);
      }
    }
    outBuf[i * 4] = Math.round(Math.min(1, o[0]) * 255);
    outBuf[i * 4 + 1] = Math.round(Math.min(1, o[1]) * 255);
    outBuf[i * 4 + 2] = Math.round(Math.min(1, o[2]) * 255);
    outBuf[i * 4 + 3] = data[i * 4 + 3];
  }
  const png = await sharp(outBuf, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer();
  texture.setImage(new Uint8Array(png)).setMimeType('image/png');
  report.push(`${texture.getName() || texture.getURI() || 'tex'} ${W}x${H}: markings=${markings} dielectric=${dielectric} ref=${ref.toFixed(2)}`);
  return png;
}

// ---------------------------------------------------------------- build
async function load() {
  const doc = await io.read(SRC);
  await doc.transform(dequantize());
  for (const n of doc.getRoot().listNodes()) if (NODE_NAMES[n.getName()]) n.setName(NODE_NAMES[n.getName()]);
  return doc;
}

/** The Aircraft.js normalisation as a 4x4 (column-major) + a point mapper. */
function normaliser(doc) {
  const scene = doc.getRoot().getDefaultScene() || doc.getRoot().listScenes()[0];
  const { min, max } = getBounds(scene);
  const c = min.map((v, i) => (v + max[i]) / 2);
  const size = max.map((v, i) => v - min[i]);
  const axis = size.indexOf(Math.max(...size));
  if (axis !== 2) throw new Error('expected the source model to be longest along Z');
  const s = REAL_LENGTH / size[2];
  // M = RotY(pi) * S * T(-c):  x' = -s(x-cx), y' = s(y-cy), z' = -s(z-cz)
  const M = [-s, 0, 0, 0, 0, s, 0, 0, 0, 0, -s, 0, s * c[0], -s * c[1], s * c[2], 1];
  const map = (p) => [-s * (p[0] - c[0]), s * (p[1] - c[1]), -s * (p[2] - c[2])];
  return { scene, M, map, s, c };
}

function bakeRoot(doc, name, scene, M, extras) {
  const root = doc.createNode(name).setMatrix(M);
  for (const child of scene.listChildren()) {
    scene.removeChild(child);
    root.addChild(child);
  }
  scene.addChild(root);
  root.setExtras(extras);
  return root;
}

const ATTRIBUTION = {
  title: 'MiG-21 (hostile livery) - derivative of "MiG-21 Bison Indian (War Thunder)"',
  author: 'KojfDiscord (https://sketchfab.com/KojfDiscord); repaint by Safed Sagar contributors',
  source: 'https://sketchfab.com/3d-models/mig-21-bison-indian-war-thunder-eaefc619a50047a0acf4af12cd269b92',
  license: 'CC BY 4.0 (http://creativecommons.org/licenses/by/4.0/)',
  changes: 'national markings removed, skin re-coloured in a fictional two-tone grey scheme, baked to metres / nose -Z, LOD1 simplified',
};

const report = [];
const doc = await load();
const { scene, M, map } = normaliser(doc);
const SKIN_TEX_OF = new Set(['airframe', 'underside', 'flaps', 'gear_doors', 'ventral', 'ventral_fairing', 'strake']);
const skinTextures = new Set();
for (const n of doc.getRoot().listNodes()) {
  if (!SKIN_TEX_OF.has(n.getName())) continue;
  for (const p of n.getMesh()?.listPrimitives() ?? []) {
    const t = p.getMaterial()?.getBaseColorTexture();
    if (t) skinTextures.add(t);
  }
}
let ti = 0;
const { mkdirSync, writeFileSync } = await import('node:fs');
mkdirSync(EVID, { recursive: true });
for (const t of skinTextures) {
  const png = await repaint(doc, t, map, report);
  writeFileSync(path.join(EVID, `skin_${ti++}.png`), png);
}
bakeRoot(doc, 'mig21_hostile', scene, M, { ...ATTRIBUTION, lod: 0 });
doc.getRoot().getAsset().extras = ATTRIBUTION;

report.push(`lod0 tris ${countTriangles(doc)}`);
// un-optimised copy for the Blender LOD1 step (tools/blender/build_mig_lod1.py)
await io.write(path.join(ROOT, 'assets/authoring/build/mig21_hostile_raw.glb'), doc);
await optimize(doc, { maxTexture: 1024, weldFirst: false });
await io.write(OUT0, doc);
const kb = (p) => (statSync(p).size / 1024).toFixed(0) + ' KB';
report.push(`${path.relative(ROOT, OUT0)} ${kb(OUT0)}`);
console.log(report.join('\n'));
