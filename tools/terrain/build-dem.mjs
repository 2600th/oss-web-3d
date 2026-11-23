// Build the runtime heightmap from the two SRTM 1-arcsecond tiles in
// assets/source/terrain (Mapzen/AWS "skadi" open data, see THIRD_PARTY_NOTICES).
//
//   node tools/terrain/build-dem.mjs
//
// Output: public/assets/terrain/dem.u16  (RES x RES little-endian uint16 metres,
//         row 0 = north edge, column 0 = west edge)
//         public/assets/terrain/dem.json (bounds and world mapping)
//
// World convention used by the game: +X east, +Z south (north is -Z), +Y up,
// origin at the centre of the crop, 1 unit = 1 metre.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const RES = 2049;
// Drass / Tololing / Tiger Hill in the west through Kargil to Batalik in the east.
const BOUNDS = { west: 75.6, east: 76.58, south: 34.1, north: 34.9 };
const TILES = [
  { lon: 75, file: 'N34E075.hgt.gz' },
  { lon: 76, file: 'N34E076.hgt.gz' },
];
const SIDE = 3601;

const tiles = TILES.map((t) => {
  const raw = gunzipSync(readFileSync(join(ROOT, 'assets/source/terrain', t.file)));
  if (raw.length !== SIDE * SIDE * 2) throw new Error(`${t.file}: unexpected size ${raw.length}`);
  const h = new Int16Array(SIDE * SIDE);
  for (let i = 0; i < h.length; i++) h[i] = raw.readInt16BE(i * 2);
  return { ...t, h };
});

// Sample the merged mosaic at (lon, lat) with void handling.
function sample(lon, lat) {
  const tile = tiles.find((t) => lon >= t.lon && lon < t.lon + 1) ?? tiles[tiles.length - 1];
  const fx = (lon - tile.lon) * 3600;
  const fy = (35 - lat) * 3600; // row 0 = 35N
  const x0 = Math.max(0, Math.min(SIDE - 2, Math.floor(fx)));
  const y0 = Math.max(0, Math.min(SIDE - 2, Math.floor(fy)));
  const tx = fx - x0;
  const ty = fy - y0;
  let acc = 0;
  let w = 0;
  const taps = [[0, 0, (1 - tx) * (1 - ty)], [1, 0, tx * (1 - ty)], [0, 1, (1 - tx) * ty], [1, 1, tx * ty]];
  for (const [dx, dy, ww] of taps) {
    const v = tile.h[(y0 + dy) * SIDE + x0 + dx];
    if (v === -32768) continue;
    acc += v * ww;
    w += ww;
  }
  return w > 1e-6 ? acc / w : NaN;
}

const out = new Uint16Array(RES * RES);
let voids = 0;
let min = Infinity;
let max = -Infinity;
for (let j = 0; j < RES; j++) {
  const lat = BOUNDS.north - (j / (RES - 1)) * (BOUNDS.north - BOUNDS.south);
  for (let i = 0; i < RES; i++) {
    const lon = BOUNDS.west + (i / (RES - 1)) * (BOUNDS.east - BOUNDS.west);
    let v = sample(lon, lat);
    if (Number.isNaN(v)) { voids++; v = 0; }
    out[j * RES + i] = Math.round(v);
  }
}
// Fill any voids from the nearest valid neighbour in the row.
if (voids) {
  for (let j = 0; j < RES; j++) for (let i = 0; i < RES; i++) {
    const k = j * RES + i;
    if (out[k] !== 0) continue;
    for (let r = 1; r < 64; r++) {
      const c = out[j * RES + Math.max(0, i - r)] || out[j * RES + Math.min(RES - 1, i + r)];
      if (c) { out[k] = c; break; }
    }
  }
}
for (const v of out) { if (v < min) min = v; if (v > max) max = v; }

const latMid = (BOUNDS.north + BOUNDS.south) / 2;
const width = (BOUNDS.east - BOUNDS.west) * 111320 * Math.cos((latMid * Math.PI) / 180);
const depth = (BOUNDS.north - BOUNDS.south) * 110574;
const buf = Buffer.from(out.buffer);
const dir = join(ROOT, 'public/assets/terrain');
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'dem.u16'), buf);
const meta = {
  id: 'kargil-drass-batalik-srtm1',
  resolution: RES,
  geographicBounds: BOUNDS,
  worldSize: [width, depth],
  worldBounds: { minX: -width / 2, maxX: width / 2, minZ: -depth / 2, maxZ: depth / 2 },
  cellMetres: [width / (RES - 1), depth / (RES - 1)],
  heightMin: min,
  heightMax: max,
  voidsFilled: voids,
  sha256: createHash('sha256').update(buf).digest('hex'),
  attribution: 'SRTM 1-arcsecond via Mapzen terrain tiles (AWS Open Data); courtesy USGS/NASA.',
  sources: TILES.map((t) => `https://elevation-tiles-prod.s3.amazonaws.com/skadi/N34/${t.file}`),
};
writeFileSync(join(dir, 'dem.json'), JSON.stringify(meta, null, 2) + '\n');
console.log(meta);
