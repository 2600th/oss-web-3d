/**
 * Optimise a raw Blender-exported GLB for the game (webp, quantize, meshopt).
 *
 *   node tools/blender/optimize-glb.mjs <in.glb> <out.glb> [--tex 1024] [--extras '{"license":"MIT"}']
 *
 * Prints `<out> <triangles> <bytes>` so build scripts can collect stats.
 */
import { statSync } from 'node:fs';
import { io, optimize, countTriangles } from './gltf-pipeline.mjs';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const [src, dst] = args;
const doc = await io.read(src);
const extras = JSON.parse(opt('--extras', '{}'));
const asset = doc.getRoot().getAsset();
asset.extras = { ...(asset.extras || {}), ...extras };
asset.generator = 'Safed Sagar tools/blender (Blender 5.2 + glTF-Transform)';
await optimize(doc, { maxTexture: Number(opt('--tex', 1024)) });
await io.write(dst, doc);
console.log(`OPT ${dst} ${countTriangles(doc)} ${statSync(dst).size}`);
