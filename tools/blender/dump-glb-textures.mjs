/**
 * Write every texture of a GLB as a PNG named after the material and slot
 * that use it, so the atlases can be looked at.
 *
 *   node tools/blender/dump-glb-textures.mjs public/models/mig21.glb <outDir>
 */
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import sharp from 'sharp';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const [, , src, out] = process.argv;
await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
const doc = await io.read(src);
mkdirSync(out, { recursive: true });
const users = new Map(); // material -> node names
for (const n of doc.getRoot().listNodes()) for (const p of n.getMesh()?.listPrimitives() ?? []) {
  const m = p.getMaterial();
  if (!users.has(m)) users.set(m, n.getName());
}
for (const m of doc.getRoot().listMaterials()) {
  const who = users.get(m) ?? m.getName();
  const spec = m.getExtension('KHR_materials_specular');
  const slots = {
    base: m.getBaseColorTexture(), normal: m.getNormalTexture(), orm: m.getMetallicRoughnessTexture(), ao: m.getOcclusionTexture(),
    emissive: m.getEmissiveTexture(), spec: spec?.getSpecularTexture?.(), speccol: spec?.getSpecularColorTexture?.(),
  };
  for (const [slot, t] of Object.entries(slots)) {
    if (!t) continue;
    const f = path.join(out, `${who}.${slot}.png`);
    await sharp(Buffer.from(t.getImage())).png().toFile(f);
    console.log(f, t.getSize().join('x'));
  }
}
