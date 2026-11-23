/**
 * Model-space bounds of every mesh node of a MiG GLB, and cross-sections of
 * the airframe along the fuselage (to place the weathering in
 * tools/blender/build-mig-skin.mjs).
 *
 *   node tools/blender/probe-mig-bounds.mjs public/models/mig21.glb
 */
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';

await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
const doc = await io.read(process.argv[2]);
const mul = (m, v) => [m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12], m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13], m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14]];
const slices = new Map(); // z bucket (0.5 m) -> {x, y0, y1} of `airframe`
for (const n of doc.getRoot().listNodes()) {
  const mesh = n.getMesh();
  if (!mesh) continue;
  const wm = n.getWorldMatrix();
  const lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
  const v = [];
  for (const p of mesh.listPrimitives()) {
    const P = p.getAttribute('POSITION');
    for (let i = 0; i < P.getCount(); i++) {
      const w = mul(wm, P.getElement(i, v));
      for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], w[k]); hi[k] = Math.max(hi[k], w[k]); }
      if (n.getName() === 'airframe') {
        const zb = Math.round(w[2] * 2) / 2;
        const s = slices.get(zb) ?? { x: 0, y0: 1e9, y1: -1e9 };
        s.x = Math.max(s.x, Math.abs(w[0])); s.y0 = Math.min(s.y0, w[1]); s.y1 = Math.max(s.y1, w[1]);
        slices.set(zb, s);
      }
    }
  }
  console.log(n.getName().padEnd(26), 'x', lo[0].toFixed(2), hi[0].toFixed(2), ' y', lo[1].toFixed(2), hi[1].toFixed(2), ' z', lo[2].toFixed(2), hi[2].toFixed(2));
}
console.log('airframe slices (z: half-width, y range)');
for (const z of [...slices.keys()].sort((a, b) => a - b)) {
  const s = slices.get(z);
  console.log(String(z).padStart(6), s.x.toFixed(2), s.y0.toFixed(2), s.y1.toFixed(2));
}
