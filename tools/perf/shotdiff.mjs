// Compare two sets of reference frames captured with the same script (clips
// named <tag>-<view> under captures/). Prints, per view, the mean absolute
// difference as a share of full scale and the share of pixels that differ by
// more than `thr` levels. Run it on two captures of the same build first: that
// is the noise floor (TRAA, cloud dither, particles).
//   node tools/perf/shotdiff.mjs ref-a new [thr=8] [dir=captures]
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const [a, b, thrArg, dir = 'captures'] = process.argv.slice(2);
const thr = Number(thrArg ?? 8);
const views = fs.readdirSync(dir).filter((d) => d.startsWith(a + '-')).map((d) => d.slice(a.length + 1));
const last = (d) => { const f = fs.readdirSync(d).filter((x) => /\.(png|jpg)$/.test(x)).sort(); return path.join(d, f[f.length - 1]); };
const load = (f) => sharp(f).removeAlpha().raw().toBuffer({ resolveWithObject: true });
let worst = 0;
for (const v of views) {
  const da = path.join(dir, `${a}-${v}`);
  const db = path.join(dir, `${b}-${v}`);
  if (!fs.existsSync(db)) { console.log(`${v.padEnd(10)} missing in ${b}`); continue; }
  const [A, B] = await Promise.all([load(last(da)), load(last(db))]);
  if (A.info.width !== B.info.width || A.info.height !== B.info.height) { console.log(`${v.padEnd(10)} size mismatch`); continue; }
  let sum = 0;
  let over = 0;
  let lumA = 0;
  let lumB = 0;
  const n = A.data.length;
  for (let i = 0; i < n; i += 3) {
    const d0 = Math.abs(A.data[i] - B.data[i]);
    const d1 = Math.abs(A.data[i + 1] - B.data[i + 1]);
    const d2 = Math.abs(A.data[i + 2] - B.data[i + 2]);
    sum += (d0 + d1 + d2) / 3;
    if (Math.max(d0, d1, d2) > thr) over++;
    lumA += A.data[i] + A.data[i + 1] + A.data[i + 2];
    lumB += B.data[i] + B.data[i + 1] + B.data[i + 2];
  }
  const px = n / 3;
  const mean = sum / px / 255 * 100;
  worst = Math.max(worst, mean);
  console.log(`${v.padEnd(10)} mean diff ${mean.toFixed(3)} %   pixels over ${thr}: ${(over / px * 100).toFixed(2)} %   brightness ${((lumB - lumA) / lumA * 100).toFixed(2)} %`);
}
console.log(`worst mean diff ${worst.toFixed(3)} %`);
