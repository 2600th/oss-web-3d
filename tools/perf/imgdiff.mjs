// Pixel difference between two screenshots (A/B checks that a perf change is
// invisible): mean absolute difference per channel (0..255), the share of
// pixels that differ by more than `thr`, and the max.
//   node tools/perf/imgdiff.mjs a.png b.png [thr=8]
import sharp from 'sharp';

const [a, b, thrArg] = process.argv.slice(2);
const thr = Number(thrArg ?? 8);
const load = (f) => sharp(f).removeAlpha().raw().toBuffer({ resolveWithObject: true });
const [A, B] = await Promise.all([load(a), load(b)]);
if (A.info.width !== B.info.width || A.info.height !== B.info.height) throw new Error('size mismatch');
let sum = 0;
let max = 0;
let over = 0;
const n = A.data.length;
for (let i = 0; i < n; i += 3) {
  const d = Math.max(Math.abs(A.data[i] - B.data[i]), Math.abs(A.data[i + 1] - B.data[i + 1]), Math.abs(A.data[i + 2] - B.data[i + 2]));
  sum += d;
  if (d > max) max = d;
  if (d > thr) over++;
}
const px = n / 3;
console.log(JSON.stringify({ width: A.info.width, height: A.info.height, meanAbs: +(sum / px).toFixed(3), maxAbs: max, pctOver: +((over / px) * 100).toFixed(3), thr }));
