/**
 * Decode a meshopt/quantized/webp GLB into a plain GLB that Blender imports
 * cleanly (float attributes, PNG textures). Prints a node/mesh/material summary.
 *
 *   node tools/blender/decode-glb.mjs <in.glb> <out.glb>
 */
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dequantize, textureCompress } from '@gltf-transform/functions';
import { MeshoptDecoder } from 'meshoptimizer';
import sharp from 'sharp';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const [, , src, dst] = process.argv;
if (!src || !dst) {
  console.error('usage: node tools/blender/decode-glb.mjs <in.glb> <out.glb>');
  process.exit(1);
}
await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
const doc = await io.read(src);
await doc.transform(dequantize(), textureCompress({ encoder: sharp, targetFormat: 'png' }));
for (const ext of doc.getRoot().listExtensionsUsed()) {
  const n = ext.extensionName;
  if (n === 'EXT_meshopt_compression' || n === 'KHR_mesh_quantization' || n === 'EXT_texture_webp') ext.dispose();
}
const r = doc.getRoot();
for (const n of r.listNodes()) {
  const m = n.getMesh();
  let tris = 0;
  if (m) for (const p of m.listPrimitives()) tris += (p.getIndices()?.getCount() ?? p.getAttribute('POSITION').getCount()) / 3;
  console.log(
    `node ${n.getName()} mesh=${m?.getName() ?? '-'} tris=${tris} t=${n.getTranslation().map((v) => v.toFixed(2))} ` +
      `r=${n.getRotation().map((v) => v.toFixed(3))} s=${n.getScale().map((v) => v.toFixed(3))} children=${n.listChildren().length}`,
  );
}
for (const m of r.listMaterials()) {
  const t = m.getBaseColorTexture();
  console.log(`mat ${m.getName()} base=${t?.getName() ?? '-'} ${t?.getSize() ?? ''} alpha=${m.getAlphaMode()} emissive=${!!m.getEmissiveTexture()}`);
}
mkdirSync(path.dirname(dst), { recursive: true });
await io.write(dst, doc);
console.log('wrote', dst);
