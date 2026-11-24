// The cockpit overlay's display faces (tools/blender/build_cockpit.py): each
// is an upright rectangle that reads left to right for the pilot, and lies a
// couple of millimetres in front of the panel face that carries its painted
// glass in mig21.glb. The first build had one lying like a shelf off the
// panel and one wrapped across the stick; this keeps a rebuild honest.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';

await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
const model = (file) => io.read(fileURLToPath(new URL(`../../public/models/${file}`, import.meta.url)));
const SCREENS = ['mfd_screen', 'aux_screen_c', 'aux_screen_l', 'aux_screen_r', 'aux_screen_tr'];
const EYE = [0, 0.22, -2.95];

function corners(node) {
  const M = node.getWorldMatrix();
  const prim = node.getMesh().listPrimitives()[0];
  const pos = prim.getAttribute('POSITION'), uv = prim.getAttribute('TEXCOORD_0');
  const out = [];
  for (let i = 0; i < pos.getCount(); i++) {
    const p = pos.getElement(i, []);
    out.push({ p: [0, 1, 2].map((r) => M[r] * p[0] + M[4 + r] * p[1] + M[8 + r] * p[2] + M[12 + r]), uv: uv.getElement(i, []) });
  }
  return out;
}

const overlay = await model('mig21_cockpit.glb');
const quads = new Map(SCREENS.map((name) => {
  const node = overlay.getRoot().listNodes().find((n) => n.getName() === name);
  assert.ok(node, `mig21_cockpit.glb: no ${name}`);
  return [name, corners(node)];
}));

for (const [name, q] of quads) {
  test(`${name}: an upright rectangle facing the pilot, texture upright and not mirrored`, () => {
    assert.equal(q.length, 4);
    const xs = q.map((c) => c.p[0]), ys = q.map((c) => c.p[1]), zs = q.map((c) => c.p[2]);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    assert.ok(Math.max(...zs) - Math.min(...zs) < 2e-4, 'stands upright across the nose axis (one z)');
    assert.ok(zs[0] < EYE[2], 'ahead of the eye');
    for (const c of q) {
      assert.ok(Math.min(Math.abs(c.p[0] - x0), Math.abs(c.p[0] - x1)) < 2e-4 && Math.min(Math.abs(c.p[1] - y0), Math.abs(c.p[1] - y1)) < 2e-4, 'axis-aligned corners');
      // glTF v runs down the image: the pilot's right (+x) is the image's right, up (+y) its top
      const right = c.p[0] > (x0 + x1) / 2, top = c.p[1] > (y0 + y1) / 2;
      const us = q.map((k) => k.uv[0]), vs = q.map((k) => k.uv[1]);
      assert.equal(c.uv[0] > (Math.min(...us) + Math.max(...us)) / 2, right, 'u grows to the pilot\'s right');
      assert.equal(c.uv[1] < (Math.min(...vs) + Math.max(...vs)) / 2, top, 'the image top is up');
    }
  });
}

test('every display face lies 1-3 mm in front of the panel face behind it', async () => {
  const mig = await model('mig21.glb');
  const node = mig.getRoot().listNodes().find((n) => n.getName() === 'cockpit_interior');
  const M = node.getWorldMatrix();
  const tris = [];
  for (const prim of node.getMesh().listPrimitives()) {
    const pos = prim.getAttribute('POSITION'), idx = prim.getIndices();
    for (let i = 0; i < idx.getCount(); i += 3) {
      const P = [0, 1, 2].map((k) => {
        const p = pos.getElement(idx.getScalar(i + k), []);
        return [0, 1, 2].map((r) => M[r] * p[0] + M[4 + r] * p[1] + M[8 + r] * p[2] + M[12 + r]);
      });
      if (Math.max(...P.map((p) => Math.abs(p[2] - P[0][2]))) < 1e-4) tris.push(P); // faces straight back at the pilot
    }
  }
  const inside = (P, x, y) => {
    const s = (a, b) => (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]);
    const d = [s(P[0], P[1]), s(P[1], P[2]), s(P[2], P[0])];
    return d.every((v) => v >= 0) || d.every((v) => v <= 0);
  };
  for (const [name, q] of quads) {
    const z = q[0].p[2];
    // the four corners (pulled in 2 mm) and the centre: the whole face is on one panel face
    const cx = q.reduce((a, c) => a + c.p[0], 0) / 4, cy = q.reduce((a, c) => a + c.p[1], 0) / 4;
    const probes = [[cx, cy], ...q.map((c) => [c.p[0] + Math.sign(cx - c.p[0]) * 0.002, c.p[1] + Math.sign(cy - c.p[1]) * 0.002])];
    for (const [x, y] of probes) {
      const behind = tris.filter((P) => P[0][2] < z && inside(P, x, y)).map((P) => z - P[0][2]);
      assert.ok(behind.length, `${name}: no panel face behind (${x.toFixed(3)}, ${y.toFixed(3)})`);
      const gap = Math.min(...behind);
      assert.ok(gap > 0.001 && gap < 0.003, `${name}: ${(gap * 1000).toFixed(2)} mm off its panel at (${x.toFixed(3)}, ${y.toFixed(3)})`);
    }
  }
});
