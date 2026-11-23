/**
 * Shared glTF post-processing for every asset this area ships:
 * dedup/prune, textures -> WebP (capped), vertex reorder, quantize, meshopt.
 * Also counts triangles so the asset reports and catalog stay honest.
 */
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTMeshoptCompression } from '@gltf-transform/extensions';
import { dedup, prune, textureCompress, reorder, quantize, weld } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';

await Promise.all([MeshoptDecoder.ready, MeshoptEncoder.ready, MeshoptSimplifier.ready]);

export { MeshoptSimplifier, sharp };

export const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });

export function countTriangles(doc) {
  let tris = 0;
  for (const scene of doc.getRoot().listScenes()) {
    scene.traverse((node) => {
      const mesh = node.getMesh();
      if (!mesh) return;
      for (const p of mesh.listPrimitives()) {
        if (p.getMode() !== 4) continue;
        tris += (p.getIndices()?.getCount() ?? p.getAttribute('POSITION').getCount()) / 3;
      }
    });
  }
  return tris;
}

/** Compress a document in place. `maxTexture` caps texture size (px). */
export async function optimize(doc, { maxTexture = 1024, quality = 86, weldFirst = true } = {}) {
  const steps = [dedup(), prune({ keepAttributes: false, keepLeaves: true, keepExtras: true })];
  if (weldFirst) steps.push(weld());
  steps.push(
    textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [maxTexture, maxTexture], resizeFilter: 'lanczos3', quality }),
    reorder({ encoder: MeshoptEncoder, target: 'performance' }),
    quantize({ quantizePosition: 14, quantizeNormal: 10, quantizeTexcoord: 12, quantizeColor: 8 }),
  );
  await doc.transform(...steps);
  doc
    .createExtension(EXTMeshoptCompression)
    .setRequired(true)
    .setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });
  return doc;
}
