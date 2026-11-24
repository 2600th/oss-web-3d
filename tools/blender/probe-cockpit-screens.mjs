/**
 * Where the cockpit's painted display glass is, in aircraft model space.
 *
 *   node tools/blender/probe-cockpit-screens.mjs [--check <dir>]
 *
 * The displays of the player MiG are not modelled: they are drawn in the
 * cockpit atlas (material 14741d76..., mesh `cockpit_interior`) on flat panel
 * faces. This finds, for each display, the panel face that carries its art
 * and maps the art's rectangle (ART below, atlas pixels at 2048 px, read off
 * the atlas by eye on the --check crops) through that face's UVs to model
 * space. The result is the SCREENS table of tools/blender/build_cockpit.py:
 * an overlay quad built from it lies exactly on the painted glass, whatever
 * stands between the eye and the panel (the stick hides half of one display
 * and the gunsight box a third of another, which is how the three-pixel
 * ray-cast picks of the first version came to span two surfaces).
 *
 * Every face found is axis aligned and faces the pilot (normal +Z in three),
 * with a uniform UV scale (~1040 atlas px per metre), so each display is an
 * upright rectangle. The left and right gunsight displays share one piece of
 * art (the left face mirrors it), which is why one ART entry gives two rects.
 */
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { io, sharp } from './gltf-pipeline.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PLAYER = join(ROOT, 'public/models/mig21.glb');
const ATLAS_MATERIAL = '14741d76-e811-42f1-944c-dacd049162be';
const ATLAS = 2048;

// [x0, y0, x1, y1] of the painted glass, atlas pixels (y down), and the names
// of the overlay quads it becomes, ordered by model x (left to right).
const ART = [
  { art: [1540, 281.25, 1675, 412.5], names: ['mfd_screen'] },
  { art: [1700.6, 656, 1775, 730.4], names: ['aux_screen_c'] },
  { art: [1355.5, 1246.5, 1376, 1280.5], names: ['aux_screen_l', 'aux_screen_r'] },
  { art: [1868.6, 1522, 1933.6, 1585.7], names: ['aux_screen_tr'] },
];

const doc = await io.read(PLAYER);
const node = doc.getRoot().listNodes().find((n) => n.getName() === 'cockpit_interior');
if (!node) throw new Error('mig21.glb has no cockpit_interior node');
const M = node.getWorldMatrix();
const world = (p) => [0, 1, 2].map((r) => M[r] * p[0] + M[4 + r] * p[1] + M[8 + r] * p[2] + M[12 + r]);
const wrap = (v) => v - Math.floor(v);

const args = process.argv.slice(2);
const checkDir = args[0] === '--check' ? args[1] : null;
if (checkDir) {
  mkdirSync(checkDir, { recursive: true });
  const mat = doc.getRoot().listMaterials().find((m) => m.getName() === ATLAS_MATERIAL);
  const img = Buffer.from(mat.getBaseColorTexture().getImage());
  for (const { art, names } of ART) {
    const pad = 40, k = 6;
    const left = Math.floor(art[0] - pad), top = Math.floor(art[1] - pad);
    const w = Math.ceil(art[2] - art[0] + pad * 2), h = Math.ceil(art[3] - art[1] + pad * 2);
    const box = `<svg xmlns="http://www.w3.org/2000/svg" width="${w * k}" height="${h * k}"><rect x="${(art[0] - left) * k}" y="${(art[1] - top) * k}" width="${(art[2] - art[0]) * k}" height="${(art[3] - art[1]) * k}" fill="none" stroke="#ff2bd0" stroke-width="2"/></svg>`;
    await sharp(img).extract({ left, top, width: w, height: h }).resize(w * k, h * k, { kernel: 'nearest' })
      .composite([{ input: Buffer.from(box) }]).png().toFile(join(checkDir, `art_${names[0]}.png`));
  }
  console.log('check crops in', checkDir);
}

for (const { art, names } of ART) {
  const c = [(art[0] + art[2]) / 2 / ATLAS, (art[1] + art[3]) / 2 / ATLAS];
  const found = [];
  for (const prim of node.getMesh().listPrimitives()) {
    const pos = prim.getAttribute('POSITION'), uv = prim.getAttribute('TEXCOORD_0'), idx = prim.getIndices();
    for (let i = 0; i < idx.getCount(); i += 3) {
      const t = [0, 1, 2].map((k) => idx.getScalar(i + k));
      const P = t.map((j) => world(pos.getElement(j, [])));
      if (Math.max(...P.map((p) => Math.abs(p[2] - P[0][2]))) > 1e-4) continue; // faces the pilot
      const U = t.map((j) => uv.getElement(j, []));
      // UVs sit outside 0..1 (the atlas repeats): shift the art centre into this triangle's tile
      const sx = Math.floor(U[0][0]) + c[0], sy = Math.floor(U[0][1]) + c[1];
      const d = (U[1][0] - U[0][0]) * (U[2][1] - U[0][1]) - (U[2][0] - U[0][0]) * (U[1][1] - U[0][1]);
      if (Math.abs(d) < 1e-12) continue;
      const bary = (u, v) => {
        const a = ((u - U[0][0]) * (U[2][1] - U[0][1]) - (U[2][0] - U[0][0]) * (v - U[0][1])) / d;
        const b = ((U[1][0] - U[0][0]) * (v - U[0][1]) - (u - U[0][0]) * (U[1][1] - U[0][1])) / d;
        return [1 - a - b, a, b];
      };
      const w = bary(sx, sy);
      if (w.some((x) => x < -1e-6)) continue;
      const at = (px, py) => {
        const [w0, w1, w2] = bary(sx + px / ATLAS - c[0], sy + py / ATLAS - c[1]);
        return [0, 1, 2].map((k) => w0 * P[0][k] + w1 * P[1][k] + w2 * P[2][k]);
      };
      const q = [at(art[0], art[1]), at(art[2], art[1]), at(art[2], art[3]), at(art[0], art[3])];
      const xs = q.map((p) => p[0]), ys = q.map((p) => p[1]);
      const skew = Math.abs(q[0][1] - q[1][1]) + Math.abs(q[1][0] - q[2][0]); // 0 for an upright rectangle (metres; the mesh is quantised to ~0.1 mm)
      found.push({ x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys), z: P[0][2], skew, wrapU: wrap(U[0][0]) });
    }
  }
  found.sort((a, b) => a.x0 - b.x0);
  if (found.length !== names.length) throw new Error(`${names}: expected ${names.length} panel face(s) under the art, found ${found.length}`);
  found.forEach((f, i) => {
    if (f.skew > 1e-3) throw new Error(`${names[i]}: the art is not upright on its panel face (skew ${f.skew})`);
    const r = (v) => v.toFixed(4);
    // three (x, y, z) -> Blender (x, -z, y): x0, x1, z0, z1 and the panel depth y
    console.log(`'${names[i]}': (${r(f.x0)}, ${r(f.x1)}, ${r(f.y0)}, ${r(f.y1)}),  # panel at blender y=${r(-f.z)}; ${((f.x1 - f.x0) * 1000).toFixed(1)} x ${((f.y1 - f.y0) * 1000).toFixed(1)} mm`);
  });
}
