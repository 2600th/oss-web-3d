// Decode frames grabbed by `__cap.grab()` (tools/vfx/capture.js) and saved as
// the JSON output of a devtools evaluate_script call: an object
// { name: 'data:image/jpeg;base64,...' }.
//   node tools/vfx/save-grab.mjs <grab.json> <outDir> [prefix]
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const [, , src, dir, prefix = ''] = process.argv;
const s = readFileSync(src, 'utf8');
const re = /"([\w.-]+)"\s*:\s*"data:image\/jpeg;base64,([A-Za-z0-9+/=]+)"/g;
let m, n = 0;
while ((m = re.exec(s))) {
  const out = join(dir, `${prefix}${m[1]}.jpeg`);
  writeFileSync(out, Buffer.from(m[2], 'base64'));
  console.log(out);
  n++;
}
if (!n) { console.error('no frames in', src, s.slice(0, 300)); process.exit(1); }
unlinkSync(src);
