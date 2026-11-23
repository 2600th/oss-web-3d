// CPU heightfield: the authority for gameplay queries (collision, AGL, AI
// terrain avoidance, target placement).
//
// height(x, z) = base(x, z) + amp(x, z) * detail(x, z)
//   base    the SRTM DEM (rivers already carved in by the build tool), handing
//           over at its edge to a coarser DEM of the surrounding tiles and then
//           to procedural mountains, so the world has no wall and no plateau
//   detail  sub-DEM displacement from a periodic eroded tile (see detail.js)
//   amp     metres of that displacement: large on steep rock, ~0 on river beds
//
// Terrain.js evaluates the same function on the GPU from the same data (same
// bilinear filters, same constants from detail.js); `window.__verifyTerrain()`
// reads the GPU result back and compares. Keep the two in step.
//
// World convention: +X east, +Z south (north is -Z), +Y up, metres.
import { loadPack } from './pack.js';
import { DETAIL, SURROUND, AMP_MAX, AMP_OUTSIDE, INNER_BLEND, OUTER_BLEND, TILE_SIZE } from './detail.js';

const state = {
  ready: false,
  res: 0,
  data: null, // Float32Array of heights (m), row 0 = north (minZ)
  minX: 0, maxX: 0, minZ: 0, maxZ: 0,
  cellX: 1, cellZ: 1,
  heightMin: 0, heightMax: 0,
  meta: null,
  // --- pack extras (null when initialised from a bare height grid)
  amp: null, ampRes: 0, // Uint8Array, detail amplitude at every second DEM node
  river: null, // Uint8Array res^2, signed distance to the nearest river bank
  riverMin: -40, riverStep: 0.5,
  outer: null, outerW: 0, outerH: 0, // Float32Array, coarse DEM of the surrounding tiles
  outerMinX: 0, outerMaxX: 0, outerMinZ: 0, outerMaxZ: 0,
  tile: null, // Float32Array TILE_SIZE^2, detail tile in [-1, 1]
  planes: null, // raw planes, for the renderer to build textures from
};

export const DEM = state;

/** Margin (m) inside the DEM edge over which it hands over to the surround. */
export const EDGE_BLEND = INNER_BLEND;
/** Mean height of the procedural surround (kept for callers that want a rough floor). */
export const SURROUND_HEIGHT = SURROUND.BASE;

/** Which pack a quality tier loads: native 29 m SRTM for high/ultra, 44 m below. */
export function packForTier(tier) {
  return tier === 'high' || tier === 'ultra' ? 'hi' : 'lo';
}

function guessTier() {
  if (typeof location === 'undefined') return 'high';
  const p = new URLSearchParams(location.search);
  const q = p.get('quality');
  if (q) return q;
  // Mirrors engine/Quality.pickTier, which cannot run before the renderer exists.
  const webgpu = !p.has('webgl') && typeof navigator !== 'undefined' && !!navigator.gpu;
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  return !webgpu || coarse ? 'low' : 'high';
}

export async function loadDEM(base = './assets/terrain/', { set = packForTier(guessTier()) } = {}) {
  const pack = await loadPack(`${base}kargil-${set}.stp`);
  initTerrain(pack.meta, pack.planes);
  state.packBytes = pack.bytes;
  state.packSet = set;
  return state;
}

/** Initialise from a bare grid of heights in metres (node tests, tools). */
export function initDEM(meta, u16) {
  initTerrain({ ...meta, heightUnit: 1 }, { height: { data: u16 } });
}

/** Initialise from a decoded terrain pack. */
export function initTerrain(meta, planes) {
  const n = meta.resolution;
  const unit = meta.heightUnit ?? 1;
  const src = planes.height.data;
  const f = new Float32Array(n * n);
  for (let i = 0; i < f.length; i++) f[i] = src[i] * unit;
  Object.assign(state, {
    ready: true,
    res: n,
    data: f,
    meta,
    planes,
    minX: meta.worldBounds.minX,
    maxX: meta.worldBounds.maxX,
    minZ: meta.worldBounds.minZ,
    maxZ: meta.worldBounds.maxZ,
    cellX: meta.cellMetres[0],
    cellZ: meta.cellMetres[1],
    heightMin: meta.heightMin,
    heightMax: meta.heightMax,
    amp: null, ampRes: 0, river: null, outer: null, tile: null,
  });
  if (planes.river) {
    state.river = planes.river.data;
    state.riverMin = meta.riverSdf.min;
    state.riverStep = meta.riverSdf.step;
  }
  if (planes.outer) {
    const o = planes.outer;
    const of = new Float32Array(o.w * o.h);
    const ou = meta.outerUnit ?? 1;
    for (let i = 0; i < of.length; i++) of[i] = o.data[i] * ou;
    Object.assign(state, {
      outer: of, outerW: o.w, outerH: o.h,
      outerMinX: meta.outerBounds.minX, outerMaxX: meta.outerBounds.maxX,
      outerMinZ: meta.outerBounds.minZ, outerMaxZ: meta.outerBounds.maxZ,
    });
  }
  if (planes.tile) {
    const t = planes.tile.data;
    const tf = new Float32Array(t.length);
    const s = meta.tile.heightScale;
    for (let i = 0; i < tf.length; i++) tf[i] = (t[i] - 32768) * s;
    state.tile = tf;
    buildAmp();
  }
}

const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * Detail amplitude at every second DEM node: steep rock is craggy, valley
 * floors and snowfields are smooth, river beds are flat.
 */
function buildAmp() {
  const n = state.res;
  const m = (n - 1) / 2 + 1;
  const H = state.data;
  const raw = new Float32Array(m * m);
  const span = 2;
  for (let j = 0; j < m; j++) {
    const z = j * 2;
    const z0 = Math.max(0, z - span);
    const z1 = Math.min(n - 1, z + span);
    for (let i = 0; i < m; i++) {
      const x = i * 2;
      const x0 = Math.max(0, x - span);
      const x1 = Math.min(n - 1, x + span);
      const dx = (H[z * n + x1] - H[z * n + x0]) / ((x1 - x0) * state.cellX);
      const dz = (H[z1 * n + x] - H[z0 * n + x]) / ((z1 - z0) * state.cellZ);
      const tan = Math.hypot(dx, dz);
      const alt = H[z * n + x];
      let a = 0.8 + 8.8 * smooth(0.22, 1.15, tan);
      a *= 1 - 0.65 * smooth(4900, 5400, alt) * (1 - smooth(0.55, 0.95, tan)); // snowfields
      if (state.river) a *= smooth(12, 90, state.river[z * n + x] * state.riverStep + state.riverMin);
      raw[j * m + i] = a;
    }
  }
  const amp = new Uint8Array(m * m);
  for (let j = 0; j < m; j++) for (let i = 0; i < m; i++) {
    let acc = 0;
    for (let b = -1; b <= 1; b++) for (let a = -1; a <= 1; a++) {
      const w = (2 - Math.abs(a)) * (2 - Math.abs(b));
      acc += w * raw[Math.min(m - 1, Math.max(0, j + b)) * m + Math.min(m - 1, Math.max(0, i + a))];
    }
    amp[j * m + i] = Math.min(255, Math.round((acc / 16 / AMP_MAX) * 255));
  }
  state.amp = amp;
  state.ampRes = m;
}

function bilinear(data, w, h, fx, fz) {
  fx = Math.min(Math.max(fx, 0), w - 1.0001);
  fz = Math.min(Math.max(fz, 0), h - 1.0001);
  const ix = Math.floor(fx);
  const iz = Math.floor(fz);
  const tx = fx - ix;
  const tz = fz - iz;
  const k = iz * w + ix;
  const a = data[k];
  const b = data[k + 1];
  const c = data[k + w];
  const d = data[k + w + 1];
  const top = a + (b - a) * tx;
  return top + ((c + (d - c) * tx) - top) * tz;
}

const TMASK = TILE_SIZE - 1;
/** Detail tile at tile coordinates (u, v), filtered the way the GPU sampler filters it. */
function tileAt(L, x, z) {
  const t = state.tile;
  const fu = ((x * L.cos - z * L.sin) / L.size + L.ox) * TILE_SIZE - 0.5;
  const fv = ((x * L.sin + z * L.cos) / L.size + L.oz) * TILE_SIZE - 0.5;
  const iu = Math.floor(fu);
  const iv = Math.floor(fv);
  const tu = fu - iu;
  const tv = fv - iv;
  const u0 = iu & TMASK;
  const u1 = (iu + 1) & TMASK;
  const v0 = (iv & TMASK) * TILE_SIZE;
  const v1 = ((iv + 1) & TMASK) * TILE_SIZE;
  const a = t[v0 + u0];
  const b = t[v0 + u1];
  const c = t[v1 + u0];
  const d = t[v1 + u1];
  const top = a + (b - a) * tu;
  return top + ((c + (d - c) * tu) - top) * tv;
}

/** Unit-amplitude sub-DEM displacement at (x, z); multiply by the local amplitude. */
export function detailHeight(x, z) {
  if (!state.tile) return 0;
  const m = smooth(-DETAIL.MASK_EDGE, DETAIL.MASK_EDGE, tileAt(DETAIL.MASK, x, z));
  const a = tileAt(DETAIL.A, x, z);
  const ab = a + (tileAt(DETAIL.B, x, z) - a) * m;
  const c = tileAt(DETAIL.C, x, z);
  return ab + DETAIL.C_GAIN * c
    + DETAIL.LEDGE * smooth(DETAIL.LEDGE_LO, DETAIL.LEDGE_HI, ab) * smooth(DETAIL.LEDGE_GATE_LO, DETAIL.LEDGE_GATE_HI, c);
}

/** Procedural mountains beyond all measured terrain. */
function surround(x, z) {
  if (!state.tile) return SURROUND.BASE;
  return SURROUND.BASE
    + SURROUND.G0 * tileAt(SURROUND.L0, x, z)
    + SURROUND.G1 * tileAt(SURROUND.L1, x, z)
    + SURROUND.G2 * tileAt(SURROUND.L2, x, z);
}

/** Height (m) outside the inner DEM: coarse real terrain fading to procedural. */
function outside(x, z) {
  const p = surround(x, z);
  if (!state.outer) return p;
  const inset = Math.min(x - state.outerMinX, state.outerMaxX - x, z - state.outerMinZ, state.outerMaxZ - z);
  if (inset <= 0) return p;
  const o = bilinear(
    state.outer, state.outerW, state.outerH,
    ((x - state.outerMinX) / (state.outerMaxX - state.outerMinX)) * (state.outerW - 1),
    ((z - state.outerMinZ) / (state.outerMaxZ - state.outerMinZ)) * (state.outerH - 1),
  );
  return p + (o - p) * smooth(0, OUTER_BLEND, inset);
}

/** Signed distance (m) inside the DEM rectangle; negative outside. */
export function demInset(x, z) {
  return Math.min(x - state.minX, state.maxX - x, z - state.minZ, state.maxZ - z);
}

export function terrainHeight(x, z) {
  if (!state.ready) return 0;
  const inset = demInset(x, z);
  const gx = (x - state.minX) / state.cellX;
  const gz = (z - state.minZ) / state.cellZ;
  let h;
  let amp = AMP_OUTSIDE;
  if (inset >= INNER_BLEND) {
    h = bilinear(state.data, state.res, state.res, gx, gz);
    if (state.amp) amp = bilinear(state.amp, state.ampRes, state.ampRes, gx * 0.5, gz * 0.5) * (AMP_MAX / 255);
  } else {
    h = outside(x, z);
    if (inset > 0) {
      const t = smooth(0, INNER_BLEND, inset);
      h += (bilinear(state.data, state.res, state.res, gx, gz) - h) * t;
      if (state.amp) amp += (bilinear(state.amp, state.ampRes, state.ampRes, gx * 0.5, gz * 0.5) * (AMP_MAX / 255) - amp) * t;
    }
  }
  if (!state.tile) return h;
  return h + amp * detailHeight(x, z);
}

/** Distance (m) to the nearest river bank: negative in the water, large far away. */
export function riverEdge(x, z) {
  if (!state.river || demInset(x, z) <= 0) return 1e9;
  const b = bilinear(state.river, state.res, state.res, (x - state.minX) / state.cellX, (z - state.minZ) / state.cellZ);
  return b * state.riverStep + state.riverMin;
}

/** True where the surface at (x, z) is river water. */
export function isWater(x, z) {
  return riverEdge(x, z) < 0;
}

/** Water surface height (m) at (x, z), or -Infinity where there is no water. */
export function waterHeight(x, z) {
  return riverEdge(x, z) < 0 ? terrainHeight(x, z) : -Infinity;
}

/** Highest terrain along a segment (for camera/AI clearance). */
export function maxHeightAlong(x0, z0, x1, z1, samples = 8) {
  let m = -Infinity;
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const h = terrainHeight(x0 + (x1 - x0) * t, z0 + (z1 - z0) * t);
    if (h > m) m = h;
  }
  return m;
}

export function terrainNormal(x, z, out, e = 20) {
  const l = terrainHeight(x - e, z);
  const r = terrainHeight(x + e, z);
  const b = terrainHeight(x, z - e);
  const f = terrainHeight(x, z + e);
  out.set(l - r, 2 * e, b - f).normalize();
  return out;
}

/** Ray-march the heightfield. Returns distance to hit or Infinity. */
export function raycastTerrain(ox, oy, oz, dx, dy, dz, maxDist = 20000, step = 40) {
  let t = 0;
  let prevT = 0;
  while (t < maxDist) {
    const y = oy + dy * t;
    const h = terrainHeight(ox + dx * t, oz + dz * t);
    if (y <= h) {
      // refine
      let lo = prevT;
      let hi = t;
      for (let i = 0; i < 10; i++) {
        const mid = (lo + hi) / 2;
        if (oy + dy * mid <= terrainHeight(ox + dx * mid, oz + dz * mid)) hi = mid; else lo = mid;
      }
      return hi;
    }
    prevT = t;
    t += Math.max(step, (y - h) * 0.5);
  }
  return Infinity;
}

/** Line-of-sight test between two points. */
export function lineOfSight(a, b, samples = 32) {
  for (let i = 1; i < samples; i++) {
    const t = i / samples;
    const x = a.x + (b.x - a.x) * t;
    const y = a.y + (b.y - a.y) * t;
    const z = a.z + (b.z - a.z) * t;
    if (y < terrainHeight(x, z)) return false;
  }
  return true;
}
