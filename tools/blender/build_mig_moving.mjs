/**
 * Rudder and airbrakes for the shipped MiG-21 airframes.
 *
 *   node tools/blender/build_mig_moving.mjs [--check]
 *
 * tools/blender/build_mig_surfaces.py cut the stabilators, ailerons and flaps
 * onto pivots but left the rudder and the airbrakes in the airframe mesh. In
 * this mesh both are already separate panels (edge-connected islands; see
 * tools/blender/probe_mig_moving.mjs), so instead of rebuilding the whole
 * chain from the Sketchfab source (which would drop the later texture and
 * model passes baked into the shipped files) this script works on the shipped
 * GLBs in place:
 *
 *   public/models/mig21.glb, mig21_hostile.glb, mig21_hostile_lod1.glb
 *
 * For each panel it moves the faces into a new primitive under
 *
 *   <name>_hinge   fixed frame on the hinge line: local +X along the hinge
 *     <name>       the animated pivot (identity at rest): rotation.x
 *       <name>_<mesh>  the faces, with the original node's transform
 *
 * so every moving surface in the file turns on its own `rotation.x`, the same
 * convention as the stabs/ailerons/flaps:
 *
 *   rudder        hinge on the fin's rudder post (leans aft ~40 deg);
 *                 + = trailing edge to the RIGHT (nose right)
 *   airbrake_L/R  the two forward airbrakes under the nose, aft of the nose
 *                 gear bay, hinged at their front edge; + = open (aft edge
 *                 swings out into the airflow)
 *
 * The real MiG-21 also has a ventral airbrake ahead of the ventral fin; this
 * mesh has no panel for it, so it is not animated.
 *
 * Idempotent: a file that already has a `rudder` node is left alone.
 * `--check` only reports what would be cut.
 */
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import { statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FILES = ['public/models/mig21.glb', 'public/models/mig21_hostile.glb', 'public/models/mig21_hostile_lod1.glb'];
const CHECK = process.argv.includes('--check');

await Promise.all([MeshoptDecoder.ready, MeshoptEncoder.ready]);
const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });

// Panels by the bounding box of their island (runtime model space: metres,
// nose -Z, +Y up), with a few cm of slack for LOD1's decimation. Measured with
// probe_mig_moving.mjs on mig21.glb:
//   rudder      (-0.036, 0.170, 5.657) .. (0.037, 1.674, 7.606)   132 faces
//   airbrake_R  ( 0.445, -1.087, -3.158) .. (0.532, -1.023, -2.562) 58 faces (and mirror)
const PANELS = {
  rudder: { min: [-0.06, 0.14, 5.6], max: [0.06, 1.69, 7.63], minSize: [0, 1.3, 1.7] },
  airbrake_L: { min: [-0.56, -1.11, -3.19], max: [-0.42, -1.0, -2.53], minSize: [0.05, 0.03, 0.5] },
  airbrake_R: { min: [0.42, -1.11, -3.19], max: [0.56, -1.0, -2.53], minSize: [0.05, 0.03, 0.5] },
};
// Meshes that may carry panel faces (the decal sheet has none on these panels).
const CANDIDATES = new Set(['airframe']);

// ---------------------------------------------------------------- math
const mul = (m, p) => [
  m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
  m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
  m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => scale(a, 1 / Math.hypot(...a));
const mean = (pts) => scale(pts.reduce(add, [0, 0, 0]), 1 / pts.length);

/** Quaternion [x, y, z, w] of the rotation whose columns are X, Y, Z. */
function quatFromBasis(X, Y, Z) {
  const m00 = X[0], m10 = X[1], m20 = X[2], m01 = Y[0], m11 = Y[1], m21 = Y[2], m02 = Z[0], m12 = Z[1], m22 = Z[2];
  const tr = m00 + m11 + m22;
  let x, y, z, w;
  if (tr > 0) {
    const s = 0.5 / Math.sqrt(tr + 1);
    w = 0.25 / s; x = (m21 - m12) * s; y = (m02 - m20) * s; z = (m10 - m01) * s;
  } else if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    w = (m21 - m12) / s; x = 0.25 * s; y = (m01 + m10) / s; z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    w = (m02 - m20) / s; x = (m01 + m10) / s; y = 0.25 * s; z = (m12 + m21) / s;
  } else {
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
    w = (m10 - m01) / s; x = (m02 + m20) / s; y = (m12 + m21) / s; z = 0.25 * s;
  }
  const n = Math.hypot(x, y, z, w);
  return [x / n, y / n, z / n, w / n];
}

/** Column-major 4x4 from a rigid frame (origin, basis). */
const frameMatrix = (o, X, Y, Z) => [...X, 0, ...Y, 0, ...Z, 0, ...o, 1];
/** Inverse of a rigid frame matrix. */
function invRigid(m) {
  const X = [m[0], m[1], m[2]], Y = [m[4], m[5], m[6]], Z = [m[8], m[9], m[10]], o = [m[12], m[13], m[14]];
  return [X[0], Y[0], Z[0], 0, X[1], Y[1], Z[1], 0, X[2], Y[2], Z[2], 0, -dot(X, o), -dot(Y, o), -dot(Z, o), 1];
}
function mat4mul(a, b) {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
}

/** Smallest-variance direction of a point set (panel normal), by power iteration on the inverse-ish. */
function planeNormal(pts) {
  const c = mean(pts);
  const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const p of pts) {
    const d = sub(p, c);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) C[i][j] += d[i] * d[j];
  }
  // largest two eigenvectors by power iteration, normal = their cross product
  const power = (M, deflate) => {
    let v = norm([0.3, 0.5, 0.8]);
    for (let it = 0; it < 200; it++) {
      let w = [0, 1, 2].map((i) => dot(M[i], v));
      if (deflate) w = sub(w, scale(deflate, dot(w, deflate)));
      v = norm(w);
    }
    return v;
  };
  const e1 = power(C);
  const e2 = power(C, e1);
  return norm(cross(e1, e2));
}

// ---------------------------------------------------------------- islands
function islands(prim, M) {
  const pos = prim.getAttribute('POSITION');
  const idx = prim.getIndices();
  const n = pos.getCount();
  const P = new Array(n);
  const key = new Map();
  const canon = new Int32Array(n);
  const t = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    pos.getElement(i, t);
    P[i] = mul(M, t);
    const k = P[i].map((v) => Math.round(v * 2000)).join(',');
    if (!key.has(k)) key.set(k, i);
    canon[i] = key.get(k);
  }
  const parent = new Int32Array(n).map((_, i) => i);
  const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  const tri = idx.getArray();
  for (let f = 0; f < tri.length; f += 3) {
    const a = find(canon[tri[f]]);
    parent[find(canon[tri[f + 1]])] = a;
    parent[find(canon[tri[f + 2]])] = a;
  }
  const isl = new Map();
  for (let f = 0; f < tri.length; f += 3) {
    const r = find(canon[tri[f]]);
    if (!isl.has(r)) isl.set(r, { faces: [], min: [1e9, 1e9, 1e9], max: [-1e9, -1e9, -1e9] });
    const s = isl.get(r);
    s.faces.push(f / 3);
    for (let k = 0; k < 3; k++) {
      const p = P[tri[f + k]];
      for (let a = 0; a < 3; a++) { s.min[a] = Math.min(s.min[a], p[a]); s.max[a] = Math.max(s.max[a], p[a]); }
    }
  }
  return { list: [...isl.values()], P, tri };
}

const within = (s, R) => [0, 1, 2].every((a) => s.min[a] >= R.min[a] && s.max[a] <= R.max[a]);
const bigEnough = (s, R) => [0, 1, 2].every((a) => s.max[a] - s.min[a] >= R.minSize[a]);

// ---------------------------------------------------------------- hinge frames
function rudderFrame(pts) {
  const ys = pts.map((p) => p[1]);
  const y0 = Math.min(...ys), y1 = Math.max(...ys);
  const lead = (sel) => sel.reduce((a, p) => (p[2] < a[2] ? p : a));
  const lo = lead(pts.filter((p) => p[1] < y0 + 0.08));
  const hi = lead(pts.filter((p) => p[1] > y1 - 0.08));
  const X = norm([0, hi[1] - lo[1], hi[2] - lo[2]]); // up along the rudder post
  const Z = norm([0, -X[2], X[1]]); // aft, in the symmetry plane
  const Y = cross(Z, X); // = -X world: + rotation.x swings the trailing edge to +X (right)
  const o = add([0, lo[1], lo[2]], scale(Z, 0.03)); // the post sits just behind the rounded nose
  return { o, X, Y, Z };
}

function airbrakeFrame(pts, side) {
  let n = planeNormal(pts);
  const c = mean(pts);
  const out = norm([side * 1, -1, 0]); // away from the fuselage, below the nose
  if (dot(n, out) < 0) n = scale(n, -1);
  const Z = norm(sub([0, 0, 1], scale(n, n[2]))); // aft, in the panel plane
  const Y = scale(n, -1); // + rotation.x swings the aft edge to -Y = outward
  const X = cross(Y, Z);
  const zMin = Math.min(...pts.map((p) => p[2]));
  const front = pts.filter((p) => p[2] < zMin + 0.04);
  const f = mean(front);
  // hinge: on the panel plane at the front edge
  const o = sub(f, scale(n, dot(sub(f, c), n)));
  return { o, X, Y, Z };
}

// ---------------------------------------------------------------- surgery
function copyAccessor(doc, src, verts) {
  // Raw copy: the attributes are quantized (normalized ints) and getElement()
  // would hand back de-normalized floats.
  const arr = src.getArray();
  const size = src.getElementSize();
  const out = new arr.constructor(verts.length * size);
  verts.forEach((v, i) => { for (let k = 0; k < size; k++) out[i * size + k] = arr[v * size + k]; });
  return doc.createAccessor()
    .setType(src.getType())
    .setArray(out)
    .setNormalized(src.getNormalized())
    .setBuffer(src.getBuffer());
}

/**
 * Copy the faces of `faceSet` (face numbers in the primitive's ORIGINAL index
 * buffer, `tri`) into a new mesh. The original primitive is trimmed once, after
 * every panel has been copied (trimProtected), so face numbers stay valid.
 */
function extract(doc, prim, tri, faceSet, name) {
  const idx = prim.getIndices();
  const take = [];
  for (const f of [...faceSet].sort((a, b) => a - b)) take.push(tri[f * 3], tri[f * 3 + 1], tri[f * 3 + 2]);
  const map = new Map();
  const verts = [];
  const newIdx = take.map((v) => { if (!map.has(v)) { map.set(v, verts.length); verts.push(v); } return map.get(v); });
  const np = doc.createPrimitive().setMaterial(prim.getMaterial()).setMode(prim.getMode());
  for (const sem of prim.listSemantics()) np.setAttribute(sem, copyAccessor(doc, prim.getAttribute(sem), verts));
  const IT = verts.length > 65535 ? Uint32Array : Uint16Array;
  np.setIndices(doc.createAccessor().setType('SCALAR').setArray(new IT(newIdx)).setBuffer(idx.getBuffer()));
  return doc.createMesh(name).addPrimitive(np);
}

/** Drop the moved faces from the original primitive (fresh index accessor; the old one may be shared). */
function trim(doc, prim, tri, moved) {
  const idx = prim.getIndices();
  const keep = [];
  for (let f = 0; f < tri.length / 3; f++) if (!moved.has(f)) keep.push(tri[f * 3], tri[f * 3 + 1], tri[f * 3 + 2]);
  prim.setIndices(doc.createAccessor().setType('SCALAR').setArray(new tri.constructor(keep)).setBuffer(idx.getBuffer()));
  if (idx.listParents().every((p) => p.propertyType === 'Root')) idx.dispose();
}

async function build(file) {
  const abs = path.join(ROOT, file);
  const doc = await io.read(abs);
  const scene = doc.getRoot().getDefaultScene() ?? doc.getRoot().listScenes()[0];
  const root = scene.listChildren().find((n) => n.getExtras()?.baked) ?? scene.listChildren()[0];
  if (doc.getRoot().listNodes().some((n) => n.getName() === 'rudder')) {
    console.log(`${file}: already has a rudder, skipped`);
    return;
  }
  const rootInv = invRigid(root.getWorldMatrix());
  const found = {}; // panel -> [{node, prim, faces:Set, pts}]
  for (const node of root.listChildren()) {
    const mesh = node.getMesh();
    if (!mesh || !CANDIDATES.has(node.getName())) continue;
    const M = mat4mul(rootInv, node.getWorldMatrix());
    for (const prim of mesh.listPrimitives()) {
      const { list, P, tri } = islands(prim, M);
      for (const [panel, R] of Object.entries(PANELS)) {
        const hits = list.filter((s) => within(s, R));
        if (!hits.length) continue;
        const main = hits.filter((s) => bigEnough(s, R));
        if (!main.length) continue;
        // the panel itself plus any small pieces lying inside its own bounds (hinge fairings, lips)
        const bb = { min: [0, 1, 2].map((a) => Math.min(...main.map((s) => s.min[a])) - 0.005), max: [0, 1, 2].map((a) => Math.max(...main.map((s) => s.max[a])) + 0.005) };
        const take = hits.filter((s) => within(s, bb));
        const faces = new Set(take.flatMap((s) => s.faces));
        const pts = [];
        for (const f of faces) for (let k = 0; k < 3; k++) pts.push(P[tri[f * 3 + k]]);
        (found[panel] ??= []).push({ node, prim, tri, faces, pts, islands: take.length, M });
      }
    }
  }
  for (const panel of Object.keys(PANELS)) {
    const recs = found[panel] ?? [];
    const nf = recs.reduce((a, r) => a + r.faces.size, 0);
    console.log(`${file}: ${panel} ${recs.length ? `${nf} faces in ${recs.reduce((a, r) => a + r.islands, 0)} islands` : 'NOT FOUND'}`);
  }
  if (CHECK) return;

  for (const [panel, recs] of Object.entries(found)) {
    const pts = recs.flatMap((r) => r.pts);
    const F = panel === 'rudder' ? rudderFrame(pts) : airbrakeFrame(pts, panel.endsWith('_L') ? -1 : 1);
    const H = frameMatrix(F.o, F.X, F.Y, F.Z);
    const hinge = doc.createNode(`${panel}_hinge`).setTranslation(F.o).setRotation(quatFromBasis(F.X, F.Y, F.Z));
    const pivot = doc.createNode(panel);
    hinge.addChild(pivot);
    root.addChild(hinge);
    for (const r of recs) {
      const mesh = extract(doc, r.prim, r.tri, r.faces, `${panel}_${r.node.getName()}`);
      const child = doc.createNode(`${panel}_${r.node.getName()}`).setMesh(mesh);
      child.setMatrix(mat4mul(invRigid(H), r.M));
      pivot.addChild(child);
    }
    const ax = F.X.map((v) => v.toFixed(3)).join(', ');
    console.log(`  ${panel}_hinge at (${F.o.map((v) => v.toFixed(3)).join(', ')}) axis (${ax})`);
  }
  // every panel is copied; now take the moved faces out of their source primitives
  const moved = new Map(); // prim -> {tri, faces}
  for (const recs of Object.values(found)) {
    for (const r of recs) {
      if (!moved.has(r.prim)) moved.set(r.prim, { tri: r.tri, faces: new Set() });
      for (const f of r.faces) moved.get(r.prim).faces.add(f);
    }
  }
  for (const [prim, { tri, faces }] of moved) trim(doc, prim, tri, faces);
  const ex = root.getExtras() ?? {};
  if (ex.surfaces) ex.surfaces = `${ex.surfaces}; rudder: rotation.x, + = trailing edge right; airbrake_L airbrake_R: rotation.x, + = open`;
  root.setExtras(ex);
  await io.write(abs, doc);
  console.log(`  wrote ${file} bytes=${statSync(abs).size}`);
}

for (const f of FILES) await build(f);
