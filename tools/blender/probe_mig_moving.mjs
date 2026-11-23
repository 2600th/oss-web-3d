/**
 * Probe for the rudder and airbrake panels of the shipped MiG-21 GLBs.
 *
 * Lists the nodes, then every edge-connected island (after welding by
 * position) of each mesh whose bounding box lies inside a region of interest,
 * in runtime model space (metres, nose -Z, +Y up). Used to pick the panels
 * tools/blender/build_mig_moving.mjs cuts onto pivot nodes.
 *
 *   node tools/blender/probe_mig_moving.mjs [public/models/mig21.glb] [region]
 *   region: fin | belly | all (default all)
 */
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dequantize } from '@gltf-transform/functions';
import { MeshoptDecoder } from 'meshoptimizer';

const [, , src = 'public/models/mig21.glb', which = 'all'] = process.argv;
await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
const doc = await io.read(src);
await doc.transform(dequantize());

const REGIONS = {
  fin: { x: [-0.3, 0.3], y: [-0.1, 1.8], z: [5.4, 8.2] },
  belly: { x: [-1.2, 1.2], y: [-2.0, -0.3], z: [-5.0, 6.0] },
};

const mul = (m, p) => [
  m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
  m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
  m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
];

export function meshIslands(prim, matrix) {
  const pos = prim.getAttribute('POSITION');
  const idx = prim.getIndices();
  const n = pos.getCount();
  const P = new Array(n);
  const key = new Map();
  const canon = new Int32Array(n);
  const t = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    pos.getElement(i, t);
    P[i] = mul(matrix, t);
    const k = P[i].map((v) => Math.round(v * 2000)).join(',');
    if (!key.has(k)) key.set(k, i);
    canon[i] = key.get(k);
  }
  const parent = new Int32Array(n).map((_, i) => i);
  const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  const tri = idx ? idx.getArray() : Array.from({ length: n }, (_, i) => i);
  for (let f = 0; f < tri.length; f += 3) {
    const a = find(canon[tri[f]]), b = find(canon[tri[f + 1]]), c = find(canon[tri[f + 2]]);
    parent[b] = a; parent[find(c)] = find(a);
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
  return { islands: [...isl.values()], P, tri };
}

const inside = (s, R) => ['x', 'y', 'z'].every((ax, a) => s.min[a] >= R[ax][0] && s.max[a] <= R[ax][1]);
const f3 = (v) => v.map((x) => x.toFixed(3)).join(', ');

const scene = doc.getRoot().getDefaultScene() ?? doc.getRoot().listScenes()[0];
scene.traverse((node) => {
  const m = node.getMesh();
  console.log(`node ${node.getName()} mesh=${m?.getName() ?? '-'} t=(${f3(node.getTranslation())}) children=${node.listChildren().length}`);
});
scene.traverse((node) => {
  const mesh = node.getMesh();
  if (!mesh) return;
  const M = node.getWorldMatrix();
  mesh.listPrimitives().forEach((prim, pi) => {
    const { islands } = meshIslands(prim, M);
    for (const [name, R] of Object.entries(REGIONS)) {
      if (which !== 'all' && which !== name) continue;
      for (const s of islands) {
        if (!inside(s, R)) continue;
        console.log(`${name} ${node.getName()}#${pi} mat=${prim.getMaterial()?.getName()} faces=${s.faces.length} min=(${f3(s.min)}) max=(${f3(s.max)})`);
      }
    }
  });
});
