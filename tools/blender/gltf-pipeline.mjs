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

/**
 * Compress a document in place. `maxTexture` caps texture size (px).
 * `normalTexture` / `ormTexture` cap the normal and occlusion-roughness-metal
 * maps separately (default: `maxTexture`); normal maps get `normalQuality`,
 * because WebP blocking shows in specular highlights long before it shows in
 * base colour.
 */
export async function optimize(doc, { maxTexture = 1024, normalTexture = maxTexture, ormTexture = maxTexture, quality = 86, normalQuality = 90, weldFirst = true } = {}) {
  const steps = [dedup(), prune({ keepAttributes: false, keepLeaves: true, keepExtras: true })];
  if (weldFirst) steps.push(weld());
  const webp = (slots, size, q) => textureCompress({ encoder: sharp, targetFormat: 'webp', slots, resize: [size, size], resizeFilter: 'lanczos3', quality: q });
  steps.push(
    webp(/^(?!normalTexture|metallicRoughnessTexture|occlusionTexture)/, maxTexture, quality),
    webp(/^normalTexture$/, normalTexture, normalQuality),
    webp(/^(metallicRoughnessTexture|occlusionTexture)$/, ormTexture, quality),
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
