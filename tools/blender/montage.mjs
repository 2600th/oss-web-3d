// node tools/blender/montage.mjs <out.jpg> <cols> <cellW> <cellH> <image>...
// Tiles screenshots into one sheet (evidence before/after pairs and review sheets).
import sharp from 'sharp';

const [out, cols, w, h, ...files] = process.argv.slice(2);
const C = +cols, W = +w, H = +h, rows = Math.ceil(files.length / C);
const comps = await Promise.all(files.map(async (f, i) => ({
  input: await sharp(f).resize(W, H, { fit: 'cover' }).toBuffer(),
  left: (i % C) * W,
  top: Math.floor(i / C) * H,
})));
await sharp({ create: { width: C * W, height: rows * H, channels: 3, background: '#000' } })
  .composite(comps).jpeg({ quality: 85 }).toFile(out);
console.log('wrote', out);
