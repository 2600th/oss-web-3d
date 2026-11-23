// Packs a bright-star catalogue for the night sky (src/world/atmosphere/night).
//
//   node tools/sky/build-stars.mjs <dir with d3-celestial's data/*.json> [limit mag]
//
// Source: the star tables shipped with d3-celestial (npm `d3-celestial`,
// BSD-3-Clause, (c) Olaf Frohn), compiled from the Hipparcos / XHIP catalogue:
// stars.6.json (V <= 6) and stars.8.json (V <= 8). We keep V <= 6.5, the same
// limit as the Yale Bright Star Catalogue (about 8900 stars), J2000 positions.
//
// Output: public/assets/sky/stars.bin
//   "STR1", uint32 count, then count records sorted brightest first:
//     uint16 ra   (0..65535 -> 0..360 deg)
//     int16  dec  (-32767..32767 -> -90..90 deg)
//     uint8  mag  ((V + 2) * 25)
//     uint8  bv   ((B-V + 0.5) * 100)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = process.argv[2];
const limit = Number(process.argv[3] ?? 6.5);
if (!src) { console.error('usage: build-stars.mjs <d3-celestial data dir> [limit]'); process.exit(1); }
const seen = new Map();
for (const f of ['stars.6.json', 'stars.8.json']) {
  const j = JSON.parse(readFileSync(join(src, f), 'utf8'));
  for (const s of j.features) {
    const mag = Number(s.properties.mag);
    if (!(mag <= limit) || seen.has(s.id)) continue;
    let [ra, dec] = s.geometry.coordinates;
    if (ra < 0) ra += 360;
    const bv = Number(s.properties.bv);
    seen.set(s.id, { ra, dec, mag, bv: Number.isFinite(bv) ? bv : 0.6 });
  }
}
const stars = [...seen.values()].sort((a, b) => a.mag - b.mag);
const buf = Buffer.alloc(8 + stars.length * 6);
buf.write('STR1', 0, 'ascii');
buf.writeUInt32LE(stars.length, 4);
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
stars.forEach((s, i) => {
  const o = 8 + i * 6;
  buf.writeUInt16LE(Math.round(s.ra / 360 * 65536) % 65536, o);
  buf.writeInt16LE(Math.round(clamp(s.dec, -90, 90) / 90 * 32767), o + 2);
  buf.writeUInt8(clamp(Math.round((s.mag + 2) * 25), 0, 255), o + 4);
  buf.writeUInt8(clamp(Math.round((s.bv + 0.5) * 100), 0, 255), o + 5);
});
const out = join(dirname(fileURLToPath(import.meta.url)), '../../public/assets/sky/stars.bin');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, buf);
console.log(`${stars.length} stars (V <= ${limit}), brightest V=${stars[0].mag} at ra ${stars[0].ra.toFixed(3)} dec ${stars[0].dec.toFixed(3)}; ${buf.length} bytes -> ${out}`);
