// Build the runtime terrain packs from the two SRTM 1-arcsecond tiles
// (Mapzen/AWS "skadi" open data, see THIRD_PARTY_NOTICES).
//
//   node tools/terrain/build-dem.mjs [--src <dir with N34E075.hgt.gz, N34E076.hgt.gz>]
//
// Outputs (public/assets/terrain):
//   kargil-hi.stp   3073^2 heights (~29 m, native SRTM1) + derived planes
//   kargil-lo.stp   2049^2 heights (~44 m) + derived planes   (low / medium tiers)
//   dem.json        bounds, world mapping, pack list, river report
//
// Each pack holds (see tools/terrain/pack.mjs for the container):
//   height  uint16, HEIGHT_UNIT metres, rivers already carved into it
//   river   uint8 signed distance to the nearest river bank (see RIVER_SDF_*)
//   flowx/flowz uint8 downstream direction; its length encodes the fall of the bed (half resolution)
//   ao      uint8 cosine-weighted sky visibility (half resolution)
//   drain   uint8 log10 flow accumulation (half resolution)
//   outer   uint16 metres, the whole 2 x 1 degree tile area at low resolution
//   tile    uint16 512^2 periodic eroded detail heightfield (procedural)
//
// Pipeline: mosaic -> bicubic resample -> priority-flood depression fill
// (Barnes, Lehman & Mulla 2014) -> D8 flow accumulation -> channel extraction ->
// smoothed centrelines -> bank distance field + bed carving -> horizon-scan
// sky visibility. World convention: +X east, +Z south, +Y up, origin at the
// crop centre, 1 unit = 1 metre.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writePack } from './pack.mjs';
import { buildDetailTile } from './detail-tile.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const SRC = arg('--src') ?? process.env.SRTM_DIR ?? join(ROOT, 'assets/source/terrain');
const OUT = join(ROOT, 'public/assets/terrain');

// Drass / Tololing / Tiger Hill in the west through Kargil to Batalik in the east.
const BOUNDS = { west: 75.6, east: 76.58, south: 34.1, north: 34.9 };
// Everything the two tiles cover; used at low resolution beyond the crop.
const OUTER = { west: 75.0, east: 77.0, south: 34.0, north: 35.0 };
const LON0 = (BOUNDS.west + BOUNDS.east) / 2;
const LAT0 = (BOUNDS.north + BOUNDS.south) / 2;
const MX = 111320 * Math.cos((LAT0 * Math.PI) / 180); // metres per degree of longitude
const MZ = 110574;
const worldX = (lon) => (lon - LON0) * MX;
const worldZ = (lat) => (LAT0 - lat) * MZ;
const lonOf = (x) => x / MX + LON0;
const latOf = (z) => LAT0 - z / MZ;

export const HEIGHT_UNIT = 0.5; // metres per uint16 step in the height plane
export const RIVER_SDF_MIN = -40; // metres at byte 0 (inside the river)
export const RIVER_SDF_STEP = 0.5; // metres per byte step  -> +87.5 m at 255

const SETS = [
  { id: 'hi', res: 3073, outer: [1537, 769] },
  { id: 'lo', res: 2049, outer: [1025, 513] },
];
const FLOW_BASE = 0.35; // length of the stored flow vector on a level reach
const FLOW_FALL_MAX = 0.09; // fall (m per m) at which the stored flow vector reaches length 1
const DRAIN_MIN = -0.3; // log10 km^2 below which drainage is not recorded (hillslope noise)
const OUTER_UNIT = 2; // metres per step in the outer plane
const FLOW_RES = 3073; // rivers are always derived on the native-resolution grid

// Catchment the crop cannot see: rivers that enter across the boundary. Area in
// km^2 is approximate (it only sets the drawn width); the entry is snapped to
// the lowest boundary cell within 4 km of the given point.
const INFLOWS = [
  { name: 'Indus', lon: 76.58, lat: 34.55, area: 60000, search: 14000 },
  { name: 'Suru', lon: 75.97, lat: 34.1, area: 2400, search: 8000 },
  { name: 'Shingo', lon: 75.6, lat: 34.72, area: 3500, search: 14000 },
  { name: 'Drass', lon: 75.6, lat: 34.33, area: 260, search: 8000 },
];
// Named points used only to report which channel is which.
const LANDMARKS = [
  { name: 'Drass town (Drass river)', lon: 75.76, lat: 34.43 },
  { name: 'Kargil (Suru)', lon: 76.126, lat: 34.557 },
  { name: 'Kaksar (Shingo)', lon: 75.93, lat: 34.6 },
  { name: 'Batalik (Indus)', lon: 76.33, lat: 34.63 },
];
const CHANNEL_KM2 = 28; // catchment above which a channel is drawn as water
const riverWidth = (km2) => Math.max(20, 3 + 15 * Math.log10(km2)); // metres, exaggerated for readability from a jet

// ---------------------------------------------------------------- mosaic
const SIDE = 3601;
const MW = 7201;
const MH = 3601;
function loadMosaic() {
  const m = new Int16Array(MW * MH);
  for (const [lon, file] of [[75, 'N34E075.hgt.gz'], [76, 'N34E076.hgt.gz']]) {
    const path = join(SRC, file);
    if (!existsSync(path)) throw new Error(`missing ${path} (pass --src <dir>)`);
    const raw = gunzipSync(readFileSync(path));
    if (raw.length !== SIDE * SIDE * 2) throw new Error(`${file}: unexpected size ${raw.length}`);
    const x0 = (lon - 75) * 3600;
    for (let j = 0; j < SIDE; j++) for (let i = 0; i < SIDE; i++) {
      m[j * MW + x0 + i] = raw.readInt16BE((j * SIDE + i) * 2);
    }
  }
  let voids = 0;
  for (let k = 0; k < m.length; k++) if (m[k] === -32768) { voids++; m[k] = m[k > 0 ? k - 1 : k + 1]; }
  return { m, voids };
}

function makeSampler(m) {
  const at = (i, j) => m[Math.min(MH - 1, Math.max(0, j)) * MW + Math.min(MW - 1, Math.max(0, i))];
  const w = new Float64Array(8);
  const cr = (t, o) => { // Catmull-Rom weights
    const t2 = t * t;
    const t3 = t2 * t;
    w[o] = -0.5 * t3 + t2 - 0.5 * t;
    w[o + 1] = 1.5 * t3 - 2.5 * t2 + 1;
    w[o + 2] = -1.5 * t3 + 2 * t2 + 0.5 * t;
    w[o + 3] = 0.5 * t3 - 0.5 * t2;
  };
  return (lon, lat) => {
    const fx = (lon - 75) * 3600;
    const fy = (35 - lat) * 3600;
    const ix = Math.floor(fx);
    const iy = Math.floor(fy);
    cr(fx - ix, 0);
    cr(fy - iy, 4);
    let acc = 0;
    for (let b = 0; b < 4; b++) {
      let row = 0;
      for (let a = 0; a < 4; a++) row += w[a] * at(ix - 1 + a, iy - 1 + b);
      acc += w[4 + b] * row;
    }
    return acc;
  };
}

function buildGrid(sample, b, nx, nz) {
  const g = new Float32Array(nx * nz);
  for (let j = 0; j < nz; j++) {
    const lat = b.north - (j / (nz - 1)) * (b.north - b.south);
    for (let i = 0; i < nx; i++) {
      g[j * nx + i] = sample(b.west + (i / (nx - 1)) * (b.east - b.west), lat);
    }
  }
  return g;
}

// ---------------------------------------------------------------- flow routing
class Heap {
  constructor(cap) { this.k = new Float64Array(cap); this.v = new Int32Array(cap); this.n = 0; }
  push(key, val) {
    let i = this.n++;
    const { k, v } = this;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= key) break;
      k[i] = k[p]; v[i] = v[p]; i = p;
    }
    k[i] = key; v[i] = val;
  }
  pop() {
    const { k, v } = this;
    const top = v[0];
    this.topKey = k[0];
    const n = --this.n;
    if (n > 0) {
      const key = k[n];
      const val = v[n];
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && k[c + 1] < k[c]) c++;
        if (k[c] >= key) break;
        k[i] = k[c]; v[i] = v[c]; i = c;
      }
      k[i] = key; v[i] = val;
    }
    return top;
  }
}

const DX = [1, 1, 0, -1, -1, -1, 0, 1];
const DZ = [0, 1, 1, 1, 0, -1, -1, -1];

/** Priority-flood fill with epsilon, D8 directions on the filled surface, accumulation in km^2. */
function flowRoute(H, n, cellX, cellZ, minX, minZ, inflows) {
  const N = n * n;
  const F = new Float64Array(N);
  const seen = new Uint8Array(N);
  const order = new Int32Array(N);
  const outlet = new Uint8Array(N);
  const heap = new Heap(N);
  for (let i = 0; i < n; i++) {
    for (const k of [i, (n - 1) * n + i, i * n, i * n + n - 1]) {
      if (seen[k]) continue;
      // The boundary is where water leaves, except around a river that enters
      // there: those cells are flooded from inside like any other.
      const x = minX + (k % n) * cellX;
      const z = minZ + Math.floor(k / n) * cellZ;
      if (inflows.some((f) => Math.hypot(x - f.x, z - f.z) < f.closed)) continue;
      outlet[k] = 1;
      seen[k] = 1; F[k] = H[k]; heap.push(F[k], k);
    }
  }
  const dist = DX.map((dx, d) => Math.hypot(dx * cellX, DZ[d] * cellZ));
  const EPS = 0.0002; // metres of forced fall per metre across filled flats
  let count = 0;
  while (heap.n > 0) {
    const c = heap.pop();
    order[count++] = c;
    const ci = c % n;
    const cj = (c - ci) / n;
    for (let d = 0; d < 8; d++) {
      const i = ci + DX[d];
      const j = cj + DZ[d];
      if (i < 0 || j < 0 || i >= n || j >= n) continue;
      const k = j * n + i;
      if (seen[k]) continue;
      seen[k] = 1;
      F[k] = Math.max(H[k], F[c] + EPS * dist[d]);
      heap.push(F[k], k);
    }
  }
  const dir = new Int8Array(N).fill(-1);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const c = j * n + i;
    if (outlet[c]) continue;
    let best = 0;
    let bd = -1;
    for (let d = 0; d < 8; d++) {
      const ii = i + DX[d];
      const jj = j + DZ[d];
      if (ii < 0 || jj < 0 || ii >= n || jj >= n) continue;
      const s = (F[c] - F[jj * n + ii]) / dist[d];
      if (s > best) { best = s; bd = d; }
    }
    dir[c] = bd;
  }
  const acc = new Float64Array(N).fill((cellX * cellZ) / 1e6);
  for (const f of inflows) acc[f.cell] += f.area;
  for (let q = N - 1; q >= 0; q--) {
    const c = order[q];
    const d = dir[c];
    if (d >= 0) acc[c + DZ[d] * n + DX[d]] += acc[c];
  }
  return { F, dir, acc };
}

/** Channels above the threshold as smoothed polylines with width and water level. */
function traceRivers({ F, dir, acc }, n, cellX, cellZ, minX, minZ) {
  const N = n * n;
  const isCh = (c) => acc[c] >= CHANNEL_KM2;
  const fed = new Uint8Array(N);
  for (let c = 0; c < N; c++) {
    if (!isCh(c) || dir[c] < 0) continue;
    fed[c + DZ[dir[c]] * n + DX[dir[c]]] = 1;
  }
  const heads = [];
  for (let c = 0; c < N; c++) if (isCh(c) && !fed[c]) heads.push(c);
  heads.sort((a, b) => acc[b] - acc[a]);
  const visited = new Uint8Array(N);
  const lines = [];
  for (const h of heads) {
    const cells = [];
    let c = h;
    for (;;) {
      cells.push(c);
      if (visited[c]) break; // joined an existing channel: keep the junction cell
      visited[c] = 1;
      if (dir[c] < 0) break;
      c += DZ[dir[c]] * n + DX[dir[c]];
    }
    if (cells.length < 6) continue;
    const m = cells.length;
    const px = new Float64Array(m);
    const pz = new Float64Array(m);
    const w = new Float64Array(m);
    const ws = new Float64Array(m);
    for (let i = 0; i < m; i++) {
      const cc = cells[i];
      px[i] = minX + (cc % n) * cellX;
      pz[i] = minZ + Math.floor(cc / n) * cellZ;
      w[i] = riverWidth(acc[cc]);
      ws[i] = F[cc];
    }
    // The D8 path is a staircase: low-pass it, leaving both ends pinned so
    // tributaries still meet the channel they join.
    const smooth = (a, passes, pin) => {
      const t = new Float64Array(m);
      for (let p = 0; p < passes; p++) {
        for (let i = 0; i < m; i++) {
          const k = pin ? Math.min(1, Math.min(i, m - 1 - i) / 4) : 1;
          const l = a[Math.max(0, i - 1)];
          const r = a[Math.min(m - 1, i + 1)];
          t[i] = a[i] + k * ((l + 2 * a[i] + r) / 4 - a[i]);
        }
        a.set(t);
      }
    };
    smooth(px, 10, true);
    smooth(pz, 10, true);
    smooth(w, 24, false);
    for (let i = 1; i < m; i++) ws[i] = Math.min(ws[i], ws[i - 1]); // water never runs uphill
    smooth(ws, 6, false);
    for (let i = 1; i < m; i++) ws[i] = Math.min(ws[i], ws[i - 1]);
    // Fall of the water surface (m per m), over ~8 vertices so SRTM steps do not read as waterfalls.
    const fall = new Float64Array(m);
    for (let i = 0; i < m; i++) {
      const a = Math.max(0, i - 4);
      const b = Math.min(m - 1, i + 4);
      let len = 0;
      for (let q = a; q < b; q++) len += Math.hypot(px[q + 1] - px[q], pz[q + 1] - pz[q]);
      fall[i] = len > 0 ? Math.max(0, (ws[a] - ws[b]) / len) : 0;
    }
    smooth(fall, 4, false);
    lines.push({ px, pz, w, ws, fall, m, head: h, area: acc[cells[m - 1]] });
  }
  return lines;
}

/** Nearest-bank fields on an n x n grid over the crop. */
function rasteriseRivers(lines, n, cellX, cellZ, minX, minZ) {
  const N = n * n;
  const edge = new Float32Array(N).fill(1e9); // distance to the bank, negative in the water
  const level = new Float32Array(N);
  const fx = new Float32Array(N);
  const fz = new Float32Array(N);
  const REACH = 110;
  for (const L of lines) {
    for (let s = 0; s < L.m - 1; s++) {
      const ax = L.px[s];
      const az = L.pz[s];
      const bx = L.px[s + 1];
      const bz = L.pz[s + 1];
      const ex = bx - ax;
      const ez = bz - az;
      const len2 = ex * ex + ez * ez;
      if (len2 < 1e-6) continue;
      const len = Math.sqrt(len2);
      const r = Math.max(L.w[s], L.w[s + 1]) / 2 + REACH;
      const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - r - minX) / cellX));
      const i1 = Math.min(n - 1, Math.ceil((Math.max(ax, bx) + r - minX) / cellX));
      const j0 = Math.max(0, Math.floor((Math.min(az, bz) - r - minZ) / cellZ));
      const j1 = Math.min(n - 1, Math.ceil((Math.max(az, bz) + r - minZ) / cellZ));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const qx = minX + i * cellX - ax;
        const qz = minZ + j * cellZ - az;
        const t = Math.min(1, Math.max(0, (qx * ex + qz * ez) / len2));
        const d = Math.hypot(qx - ex * t, qz - ez * t);
        const e = d - (L.w[s] + (L.w[s + 1] - L.w[s]) * t) / 2;
        const k = j * n + i;
        if (e < edge[k]) {
          edge[k] = e;
          level[k] = L.ws[s] + (L.ws[s + 1] - L.ws[s]) * t;
          // direction scaled by FLOW_BASE..1 so its length carries the fall of the bed
          const mag = FLOW_BASE + (1 - FLOW_BASE) * Math.min(1, (L.fall[s] + (L.fall[s + 1] - L.fall[s]) * t) / FLOW_FALL_MAX);
          fx[k] = (ex / len) * mag;
          fz[k] = (ez / len) * mag;
        }
      }
    }
  }
  return { edge, level, fx, fz };
}

const smoothstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/** Cut a flat bed (the water surface) and banks into the heights. */
function carve(H, r, cell) {
  const WATER_DROP = 1.5; // water sits this far below the filled valley floor
  const flat = cell * 0.45; // keep the bed level a little past the bank so the shoreline lies on flat ground
  let cut = 0;
  for (let k = 0; k < H.length; k++) {
    const e = r.edge[k];
    if (e > 100) continue;
    const ws = r.level[k] - WATER_DROP;
    const o = Math.max(0, e - flat);
    // gravel bar, then a bank, then a floodplain rising gently into the valley side
    const target = ws + 1.6 * smoothstep(0, cell, o) + 0.14 * Math.max(0, o - cell * 0.5);
    if (e <= flat) { H[k] = ws; cut++; continue; }
    const floor = ws + 0.8 * smoothstep(0, cell, o);
    H[k] = Math.max(floor, Math.min(H[k], target));
  }
  return cut;
}

// ---------------------------------------------------------------- derived planes
function halve(n) { return (n - 1) / 2 + 1; }

/** Cosine-weighted sky visibility from a horizon scan (0 = buried, 1 = open). */
function skyVisibility(H, n, cellX, cellZ) {
  const m = halve(n);
  const out = new Uint8Array(m * m);
  const DIRS = 16;
  const STEPS = [1, 2, 3, 4, 6, 8, 11, 15, 20, 27, 36, 48, 64];
  const cx = cellX * 2;
  const cz = cellZ * 2;
  const offs = [];
  for (let d = 0; d < DIRS; d++) {
    const a = ((d + 0.5) / DIRS) * Math.PI * 2;
    for (const s of STEPS) {
      const di = Math.round(Math.cos(a) * s);
      const dj = Math.round(Math.sin(a) * s);
      offs.push(di, dj, 1 / Math.hypot(di * cx, dj * cz));
    }
  }
  const S = STEPS.length;
  for (let j = 0; j < m; j++) for (let i = 0; i < m; i++) {
    const h0 = H[j * 2 * n + i * 2];
    let vis = 0;
    for (let d = 0; d < DIRS; d++) {
      let tan = 0;
      for (let s = 0; s < S; s++) {
        const o = (d * S + s) * 3;
        const ii = Math.min(m - 1, Math.max(0, i + offs[o]));
        const jj = Math.min(m - 1, Math.max(0, j + offs[o + 1]));
        const t = (H[jj * 2 * n + ii * 2] - h0) * offs[o + 2];
        if (t > tan) tan = t;
      }
      vis += 1 / (1 + tan * tan);
    }
    out[j * m + i] = Math.round((vis / DIRS) * 255);
  }
  // 3x3 binomial blur, then 7 bits: removes SRTM speckle that would otherwise
  // dominate the packed size, invisible in use.
  const sm = new Uint8Array(m * m);
  for (let j = 0; j < m; j++) for (let i = 0; i < m; i++) {
    let a = 0;
    for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++) {
      a += out[Math.min(m - 1, Math.max(0, j + b)) * m + Math.min(m - 1, Math.max(0, i + c))] * (2 - Math.abs(b)) * (2 - Math.abs(c));
    }
    sm[j * m + i] = Math.round(a / 16 / 2) * 2;
  }
  return sm;
}

/** Resample an n-grid field to an m-grid over the same extent (bilinear, or max for line-like data). */
function resample(src, n, m, mode = 'linear') {
  const out = new Float32Array(m * m);
  const s = (n - 1) / (m - 1);
  for (let j = 0; j < m; j++) for (let i = 0; i < m; i++) {
    const fx = i * s;
    const fz = j * s;
    if (mode === 'max') {
      let best = -Infinity;
      const r = Math.max(1, Math.ceil(s / 2));
      for (let b = -r; b <= r; b++) for (let a = -r; a <= r; a++) {
        const ii = Math.min(n - 1, Math.max(0, Math.round(fx) + a));
        const jj = Math.min(n - 1, Math.max(0, Math.round(fz) + b));
        if (src[jj * n + ii] > best) best = src[jj * n + ii];
      }
      out[j * m + i] = best;
      continue;
    }
    const i0 = Math.min(n - 2, Math.floor(fx));
    const j0 = Math.min(n - 2, Math.floor(fz));
    const tx = fx - i0;
    const tz = fz - j0;
    const k = j0 * n + i0;
    out[j * m + i] = (src[k] * (1 - tx) + src[k + 1] * tx) * (1 - tz) + (src[k + n] * (1 - tx) + src[k + n + 1] * tx) * tz;
  }
  return out;
}

const toU8 = (f, fn) => { const o = new Uint8Array(f.length); for (let i = 0; i < f.length; i++) o[i] = Math.min(255, Math.max(0, Math.round(fn(f[i])))); return o; };
const toU16 = (f, unit) => { const o = new Uint16Array(f.length); for (let i = 0; i < f.length; i++) o[i] = Math.min(65535, Math.max(0, Math.round(f[i] / unit))); return o; };

// ---------------------------------------------------------------- main
function main() {
  const t0 = Date.now();
  const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
  const { m: mosaic, voids } = loadMosaic();
  const sample = makeSampler(mosaic);
  const width = (BOUNDS.east - BOUNDS.west) * MX;
  const depth = (BOUNDS.north - BOUNDS.south) * MZ;
  const minX = -width / 2;
  const minZ = -depth / 2;

  // --- rivers, on the native grid
  const n = FLOW_RES;
  const cellX = width / (n - 1);
  const cellZ = depth / (n - 1);
  const Hn = buildGrid(sample, BOUNDS, n, n);
  log('native grid', n);
  const inflows = INFLOWS.map((f) => {
    const x = worldX(f.lon);
    const z = worldZ(f.lat);
    let best = -1;
    let bh = Infinity;
    for (let q = 0; q < n; q++) for (const k of [q, (n - 1) * n + q, q * n, q * n + n - 1]) {
      const dx = minX + (k % n) * cellX - x;
      const dz = minZ + Math.floor(k / n) * cellZ - z;
      if (dx * dx + dz * dz > f.search * f.search) continue;
      if (Hn[k] < bh) { bh = Hn[k]; best = k; }
    }
    const info = { ...f, x: minX + (best % n) * cellX, z: minZ + Math.floor(best / n) * cellZ, closed: 3500, cell: best, height: bh, lonAt: lonOf(minX + (best % n) * cellX), latAt: latOf(minZ + Math.floor(best / n) * cellZ) };
    log(`inflow ${f.name}: boundary cell at ${info.lonAt.toFixed(3)}E ${info.latAt.toFixed(3)}N, ${bh.toFixed(0)} m`);
    return info;
  });
  const flow = flowRoute(Hn, n, cellX, cellZ, minX, minZ, inflows);
  log('flow routed');
  for (const f of inflows) {
    let c = f.cell;
    const path = [];
    let steps = 0;
    const where = (k) => `${lonOf(minX + (k % n) * cellX).toFixed(3)}E ${latOf(minZ + Math.floor(k / n) * cellZ).toFixed(3)}N ${Hn[k].toFixed(0)}m`;
    while (flow.dir[c] >= 0 && steps < 20000) {
      if (steps % 200 === 0) path.push(where(c));
      c += DZ[flow.dir[c]] * n + DX[flow.dir[c]];
      steps++;
    }
    f.exit = where(c);
    log(`  ${f.name} course: ${path.join(' > ')} > exit ${f.exit}`);
  }
  for (const f of inflows) {
    let c = f.cell;
    const path = [];
    let steps = 0;
    while (flow.dir[c] >= 0 && steps < 20000) {
      if (steps % 150 === 0) path.push();
      c += DZ[flow.dir[c]] * n + DX[flow.dir[c]];
      steps++;
    }
    f.exit = { lon: +lonOf(minX + (c % n) * cellX).toFixed(3), lat: +latOf(minZ + Math.floor(c / n) * cellZ).toFixed(3), height: Math.round(Hn[c]) };
    log();
  }
  const lines = traceRivers(flow, n, cellX, cellZ, minX, minZ);
  let km = 0;
  for (const L of lines) for (let i = 1; i < L.m; i++) km += Math.hypot(L.px[i] - L.px[i - 1], L.pz[i] - L.pz[i - 1]) / 1000;
  log(`channels: ${lines.length} polylines, ${km.toFixed(0)} km`);
  const landmarks = LANDMARKS.map((p) => {
    const ci = Math.round((worldX(p.lon) - minX) / cellX);
    const cj = Math.round((worldZ(p.lat) - minZ) / cellZ);
    let best = 0;
    for (let b = -140; b <= 140; b++) for (let a = -140; a <= 140; a++) {
      const k = Math.min(n - 1, Math.max(0, cj + b)) * n + Math.min(n - 1, Math.max(0, ci + a));
      if (flow.acc[k] > best) best = flow.acc[k];
    }
    log(`  ${p.name}: largest catchment within 4 km = ${best.toFixed(0)} km2, width ${riverWidth(best).toFixed(0)} m`);
    return { ...p, catchmentKm2: Math.round(best), widthM: Math.round(riverWidth(best)) };
  });
  const drainN = new Float32Array(n * n);
  for (let k = 0; k < drainN.length; k++) drainN[k] = Math.log10(flow.acc[k]);

  const tile = buildDetailTile(512);
  log('detail tile');

  const packs = [];
  mkdirSync(OUT, { recursive: true });
  for (const set of SETS) {
    const r = set.res;
    const cx = width / (r - 1);
    const cz = depth / (r - 1);
    const H = r === n ? Float32Array.from(Hn) : buildGrid(sample, BOUNDS, r, r);
    const riv = rasteriseRivers(lines, r, cx, cz, minX, minZ);
    const cut = carve(H, riv, Math.max(cx, cz));
    log(`${set.id}: carved ${cut} bed texels`);
    const h = halve(r);
    const ao = skyVisibility(H, r, cx, cz);
    log(`${set.id}: sky visibility`);
    const drain = resample(drainN, n, h, 'max');
    // Flow direction, half resolution; texels far from any river keep (0,0).
    const fxh = new Uint8Array(h * h);
    const fzh = new Uint8Array(h * h);
    for (let j = 0; j < h; j++) for (let i = 0; i < h; i++) {
      const k = j * 2 * r + i * 2;
      const near = riv.edge[k] < 100;
      fxh[j * h + i] = near ? Math.round(127.5 + 127 * riv.fx[k]) : 128;
      fzh[j * h + i] = near ? Math.round(127.5 + 127 * riv.fz[k]) : 128;
    }
    const [ow, oh] = set.outer;
    const outer = buildGrid(sample, OUTER, ow, oh);
    let hmin = Infinity;
    let hmax = -Infinity;
    for (const v of H) { if (v < hmin) hmin = v; if (v > hmax) hmax = v; }
    const meta = {
      id: `kargil-drass-batalik-srtm1-${set.id}`,
      version: 2,
      resolution: r,
      geographicBounds: BOUNDS,
      worldSize: [width, depth],
      worldBounds: { minX, maxX: -minX, minZ, maxZ: -minZ },
      cellMetres: [cx, cz],
      heightUnit: HEIGHT_UNIT,
      heightMin: Math.floor(hmin),
      heightMax: Math.ceil(hmax),
      riverSdf: { min: RIVER_SDF_MIN, step: RIVER_SDF_STEP },
      riverFlow: { base: FLOW_BASE, fallMax: FLOW_FALL_MAX },
      outerBounds: { minX: worldX(OUTER.west), maxX: worldX(OUTER.east), minZ: worldZ(OUTER.north), maxZ: worldZ(OUTER.south) },
      drain: { log10Min: DRAIN_MIN, log10Max: 5 },
      outerUnit: OUTER_UNIT,
      tile: { size: 512, heightScale: tile.scale },
    };
    const { buffer, entries } = writePack(meta, [
      { name: 'height', w: r, h: r, enc: 'delta16', data: toU16(H, HEIGHT_UNIT) },
      { name: 'river', w: r, h: r, enc: 'raw8', data: toU8(riv.edge, (e) => (e - RIVER_SDF_MIN) / RIVER_SDF_STEP) },
      { name: 'flowx', w: h, h, enc: 'raw8', data: fxh },
      { name: 'flowz', w: h, h, enc: 'raw8', data: fzh },
      { name: 'ao', w: h, h, enc: 'delta8', data: ao },
      { name: 'drain', w: h, h, enc: 'raw8', data: toU8(drain, (v) => ((v - DRAIN_MIN) / (5 - DRAIN_MIN)) * 255) },
      { name: 'outer', w: ow, h: oh, enc: 'delta16', data: toU16(outer, OUTER_UNIT) },
      { name: 'tile', w: 512, h: 512, enc: 'delta16', data: tile.data },
    ]);
    const file = `kargil-${set.id}.stp`;
    writeFileSync(join(OUT, file), buffer);
    log(`${file}: ${(buffer.length / 1e6).toFixed(2)} MB`, entries.map((e) => `${e.name}=${(e.length / 1e6).toFixed(2)}`).join(' '));
    packs.push({ id: set.id, file, bytes: buffer.length, resolution: r, cellMetres: [cx, cz], heightMin: meta.heightMin, heightMax: meta.heightMax, sha256: createHash('sha256').update(buffer).digest('hex') });
  }

  const hi = packs[0];
  const meta = {
    id: 'kargil-drass-batalik-srtm1',
    resolution: hi.resolution,
    geographicBounds: BOUNDS,
    worldSize: [width, depth],
    worldBounds: { minX, maxX: -minX, minZ, maxZ: -minZ },
    cellMetres: hi.cellMetres,
    heightMin: hi.heightMin,
    heightMax: hi.heightMax,
    voidsFilled: voids,
    packs,
    rivers: { thresholdKm2: CHANNEL_KM2, polylines: lines.length, lengthKm: Math.round(km), inflows: inflows.map(({ name, lonAt, latAt, area, height }) => ({ name, lon: +lonAt.toFixed(4), lat: +latAt.toFixed(4), areaKm2: area, height: Math.round(height) })), landmarks },
    attribution: 'SRTM 1-arcsecond via Mapzen terrain tiles (AWS Open Data); courtesy USGS/NASA.',
    sources: ['N34E075', 'N34E076'].map((t) => `https://elevation-tiles-prod.s3.amazonaws.com/skadi/N34/${t}.hgt.gz`),
  };
  writeFileSync(join(OUT, 'dem.json'), JSON.stringify(meta, null, 2) + '\n');
  log('done');
}

main();
