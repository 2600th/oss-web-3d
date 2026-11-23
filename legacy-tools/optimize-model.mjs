/**
 * One-shot asset pipeline for the MiG-21 GLB.
 *
 * The source model is a Sketchfab export: 17.4 MB, 29 separate meshes, 16
 * materials that all use the deprecated KHR_materials_pbrSpecularGlossiness
 * extension (three.js dropped support for it years ago, so the model would
 * render untextured/flat without conversion), and 33 loose JPEG/PNG textures.
 *
 * This converts it into something a browser can pull down and draw quickly:
 *   spec/gloss -> metal/rough, dedup + prune, weld, join compatible meshes,
 *   textures -> WebP capped at 1024, vertex reorder + quantize + Meshopt.
 *
 * Run with: npm run optimize:model
 */
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTMeshoptCompression } from '@gltf-transform/extensions';
import {
  dedup,
  prune,
  flatten,
  join,
  weld,
  metalRough,
  textureCompress,
  reorder,
  quantize,
} from '@gltf-transform/functions';
import { MeshoptEncoder } from 'meshoptimizer';
import sharp from 'sharp';
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(root, 'assets/source/mig-21_bison_indian_war_thunder.glb');
const DST = path.join(root, 'public/models/mig21.glb');

const mb = (p) => (statSync(p).size / 1048576).toFixed(2) + ' MB';

await MeshoptEncoder.ready;

const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'meshopt.encoder': MeshoptEncoder });
const document = await io.readBinary(new Uint8Array(readFileSync(SRC)));

// Sketchfab wraps the model in a node whose name has a corrupt UTF-8 prefix.
// Rename everything so runtime lookups are predictable.
document.getRoot().listNodes().forEach((node, i) => {
  const name = node.getName();
  // eslint-disable-next-line no-control-regex
  if (/[�]/.test(name)) node.setName(`airframe_${i}`);
});

await document.transform(
  metalRough(),
  dedup(),
  flatten(),
  join({ keepNamed: false }),
  weld(),
  prune({ keepAttributes: false, keepLeaves: false }),
  textureCompress({
    encoder: sharp,
    targetFormat: 'webp',
    resize: [1024, 1024],
    resizeFilter: 'lanczos3',
    quality: 88,
  }),
  reorder({ encoder: MeshoptEncoder, target: 'performance' }),
  quantize({
    quantizePosition: 14,
    quantizeNormal: 10,
    quantizeTexcoord: 12,
    quantizeColor: 8,
  }),
);

document
  .createExtension(EXTMeshoptCompression)
  .setRequired(true)
  .setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });

writeFileSync(DST, await io.writeBinary(document));

const r = document.getRoot();
console.log(`source : ${mb(SRC)}`);
console.log(`output : ${mb(DST)}  ->  ${path.relative(root, DST)}`);
console.log(
  `meshes ${r.listMeshes().length}  materials ${r.listMaterials().length}  textures ${r.listTextures().length}`,
);
