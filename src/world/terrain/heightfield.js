// CPU heightfield: the authority for gameplay queries (collision, AGL, AI
// terrain avoidance, target placement). The GPU terrain samples the same DEM
// texture with the same bilinear filter, so CPU and GPU agree to the metre on
// the DEM itself; any procedural detail added on the GPU must be mirrored here
// via `detailHeight` (keep both in step).
//
// World convention: +X east, +Z south (north is -Z), +Y up, metres.

const state = {
  ready: false,
  res: 0,
  data: null, // Float32Array of heights, row 0 = north (minZ)
  minX: 0, maxX: 0, minZ: 0, maxZ: 0,
  cellX: 1, cellZ: 1,
  heightMin: 0, heightMax: 0,
  meta: null,
};

export const DEM = state;

/** Margin (m) over which the DEM blends into the procedural surround. */
export const EDGE_BLEND = 9000;

export async function loadDEM(base = './assets/terrain/') {
  const [meta, buf] = await Promise.all([
    fetch(`${base}dem.json`).then((r) => r.json()),
    fetch(`${base}dem.u16`).then((r) => r.arrayBuffer()),
  ]);
  initDEM(meta, new Uint16Array(buf));
  return state;
}

/** Initialise from already-loaded data (also used by node tests). */
export function initDEM(meta, u16) {
  const n = meta.resolution;
  const f = new Float32Array(n * n);
  for (let i = 0; i < f.length; i++) f[i] = u16[i];
  Object.assign(state, {
    ready: true,
    res: n,
    data: f,
    u16,
    meta,
    minX: meta.worldBounds.minX,
    maxX: meta.worldBounds.maxX,
    minZ: meta.worldBounds.minZ,
    maxZ: meta.worldBounds.maxZ,
    cellX: meta.cellMetres[0],
    cellZ: meta.cellMetres[1],
    heightMin: meta.heightMin,
    heightMax: meta.heightMax,
  });
}

function demSample(x, z) {
  const { res, data } = state;
  const fx = Math.min(Math.max((x - state.minX) / state.cellX, 0), res - 1.0001);
  const fz = Math.min(Math.max((z - state.minZ) / state.cellZ, 0), res - 1.0001);
  const ix = Math.floor(fx);
  const iz = Math.floor(fz);
  const tx = fx - ix;
  const tz = fz - iz;
  const k = iz * res + ix;
  const a = data[k];
  const b = data[k + 1];
  const c = data[k + res];
  const d = data[k + res + 1];
  return (a + (b - a) * tx) + ((c + (d - c) * tx) - (a + (b - a) * tx)) * tz;
}

/** Signed distance (m) inside the DEM rectangle; negative outside. */
export function demInset(x, z) {
  return Math.min(x - state.minX, state.maxX - x, z - state.minZ, state.maxZ - z);
}

/** Base surround height outside the DEM: a low plateau so the edge never cliffs. */
export const SURROUND_HEIGHT = 3600;

export function terrainHeight(x, z) {
  if (!state.ready) return 0;
  const h = demSample(x, z);
  const inset = demInset(x, z);
  if (inset >= EDGE_BLEND) return h;
  // Fade the clamped DEM edge toward the surround so the world has no wall.
  const t = Math.max(0, Math.min(1, inset / EDGE_BLEND));
  const s = t * t * (3 - 2 * t);
  return SURROUND_HEIGHT + (h - SURROUND_HEIGHT) * s;
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
      for (let i = 0; i < 8; i++) {
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
