/**
 * Print a GLB's node tree, materials and textures (meshopt / webp aware).
 *
 *   node tools/blender/inspect-glb.mjs public/models/mig21.glb [more.glb ...]
 */
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';

await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
for (const f of process.argv.slice(2)) {
  const doc = await io.read(f);
  const r = doc.getRoot();
  console.log('==', f, r.listExtensionsUsed().map((e) => e.extensionName).join(','));
  const walk = (n, d) => {
    const m = n.getMesh();
    let tris = 0;
    const mats = new Set();
    const attrs = new Set();
    if (m) for (const p of m.listPrimitives()) {
      tris += (p.getIndices()?.getCount() ?? p.getAttribute('POSITION').getCount()) / 3;
      mats.add(p.getMaterial()?.getName());
      p.listSemantics().forEach((s) => attrs.add(s));
    }
    const t = n.getTranslation().map((v) => v.toFixed(2)).join(',');
    console.log(' '.repeat(d * 2) + n.getName(), `t=${t}`, m ? `tris=${tris} mats=[${[...mats]}] attrs=[${[...attrs]}]` : '', JSON.stringify(n.getExtras()).slice(0, 70));
    n.listChildren().forEach((c) => walk(c, d + 1));
  };
  r.listScenes()[0].listChildren().forEach((n) => walk(n, 0));
  for (const m of r.listMaterials()) {
    const b = m.getBaseColorTexture();
    console.log('mat', m.getName(), 'base=', b?.getName(), b?.getSize()?.join('x'), m.getBaseColorFactor().map((v) => v.toFixed(2)).join(','),
      m.getAlphaMode(), 'ds', m.getDoubleSided(), 'N', m.getNormalTexture()?.getName() ?? '-', 'ORM', m.getMetallicRoughnessTexture()?.getName() ?? '-',
      'AO', m.getOcclusionTexture()?.getName() ?? '-', 'r', m.getRoughnessFactor(), 'm', m.getMetallicFactor(), m.listExtensions().map((e) => e.extensionName).join(','));
  }
  let total = 0, gpu = 0;
  for (const t of r.listTextures()) {
    const s = t.getSize();
    total += t.getImage().byteLength;
    gpu += s[0] * s[1] * 4 * 4 / 3;
    console.log('tex', t.getName(), t.getMimeType(), s.join('x'), t.getImage().byteLength);
  }
  console.log(`textures: ${r.listTextures().length}, encoded ${total} B, GPU (RGBA8 + mips) ${Math.round(gpu)} B`);
}
