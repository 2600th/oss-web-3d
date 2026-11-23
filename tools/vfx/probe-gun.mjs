/**
 * Measure the MiG-21's gun muzzle on the shipped GLB (read-only).
 *
 *   node tools/vfx/probe-gun.mjs [public/models/mig21.glb]
 *
 * Prints every mesh's bounds in runtime model space (metres, nose -Z, +Y up),
 * then slices the meshes under the forward fuselage every 0.1 m from the
 * front so the gun gondola and its barrel ends can be read off. The muzzle
 * (`GUN_MUZZLE` in src/vfx/core/ring.js), used by both combat's bullet origin
 * and the VFX muzzle flash, takes its value from this.
 */
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dequantize } from '@gltf-transform/functions';
import { MeshoptDecoder } from 'meshoptimizer';

const [, , src = 'public/models/mig21.glb', xMax = '0.45', yMax = '-0.85'] = process.argv;
await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
const doc = await io.read(src);
await doc.transform(dequantize());

const mul = (m, p) => [
  m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
  m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
  m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
];
const f3 = (v) => `(${v.map((x) => x.toFixed(3)).join(', ')})`;

const meshes = [];
for (const node of doc.getRoot().listNodes()) {
  const mesh = node.getMesh();
  if (!mesh) continue;
  const M = node.getWorldMatrix();
  const pts = [];
  for (const prim of mesh.listPrimitives()) {
    const pos = prim.getAttribute('POSITION');
    const t = [0, 0, 0];
    for (let i = 0; i < pos.getCount(); i++) { pos.getElement(i, t); pts.push(mul(M, t)); }
  }
  const min = [1e9, 1e9, 1e9], max = [-1e9, -1e9, -1e9];
  for (const p of pts) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], p[k]); max[k] = Math.max(max[k], p[k]); }
  meshes.push({ name: node.getName(), pts, min, max });
  console.log(`mesh ${node.getName().padEnd(28)} min=${f3(min)} max=${f3(max)} verts=${pts.length}`);
}

const XM = Number(xMax), YM = Number(yMax);
for (const m of meshes) {
  const c = m.pts.filter((p) => Math.abs(p[0]) < XM && p[1] < YM && p[2] < 0.5 && p[2] > -5.5);
  if (!c.length) continue;
  c.sort((a, b) => a[2] - b[2]);
  const front = c[0][2];
  console.log(`\n${m.name}: ${c.length} verts under the forward fuselage; front z=${front.toFixed(3)}`);
  for (let z = Math.floor(front * 10) / 10; z < 0.5; z += 0.1) {
    const s = c.filter((p) => p[2] >= z && p[2] < z + 0.1);
    if (!s.length) continue;
    const ys = s.map((p) => p[1]), xs = s.map((p) => p[0]);
    console.log(`   z ${z.toFixed(2)}..${(z + 0.1).toFixed(2)}  n=${String(s.length).padStart(5)}  x ${Math.min(...xs).toFixed(3)}..${Math.max(...xs).toFixed(3)}  y ${Math.min(...ys).toFixed(3)}..${Math.max(...ys).toFixed(3)}`);
  }
}
