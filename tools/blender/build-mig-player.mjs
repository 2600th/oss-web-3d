/**
 * Player MiG-21 (IAF markings) with moving control surfaces:
 *
 *   assets/authoring/build/mig21_split_raw.glb  (tools/blender/build_mig_surfaces.py)
 *     -> public/models/mig21.glb                (webp, quantized, meshopt)
 *
 * The output is baked to the runtime conventions (root node `mig21`,
 * extras.baked = 1), so Aircraft.js and loadModel skip their normalisation.
 *
 *   node tools/blender/build-mig-player.mjs
 */
import { statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { io, optimize, countTriangles } from './gltf-pipeline.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = path.join(ROOT, 'assets/authoring/build/mig21_split_raw.glb');
const OUT = path.join(ROOT, 'public/models/mig21.glb');

export const MIG_ATTRIBUTION = {
  title: 'MiG-21 Bison - derivative of "MiG-21 Bison Indian (War Thunder)"',
  author: 'KojfDiscord (https://sketchfab.com/KojfDiscord); control surfaces cut by Safed Sagar contributors',
  source: 'https://sketchfab.com/3d-models/mig-21-bison-indian-war-thunder-eaefc619a50047a0acf4af12cd269b92',
  license: 'CC BY 4.0 (http://creativecommons.org/licenses/by/4.0/)',
  changes: 'baked to metres / nose -Z; stabilators, ailerons and flaps separated onto pivot nodes',
};

const doc = await io.read(SRC);
const asset = doc.getRoot().getAsset();
asset.extras = { ...(asset.extras || {}), ...MIG_ATTRIBUTION };
asset.generator = 'Safed Sagar tools/blender (Blender 5.2 + glTF-Transform)';
const rootNode = doc.getRoot().listNodes().find((n) => n.getName() === 'mig21');
if (!rootNode?.getExtras()?.baked) throw new Error('mig21_split_raw.glb: root node `mig21` with extras.baked missing');
await optimize(doc, { maxTexture: 1024 });
await io.write(OUT, doc);
console.log(`${path.relative(ROOT, OUT)} tris=${countTriangles(doc)} bytes=${statSync(OUT).size}`);
