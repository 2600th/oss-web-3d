// Terrain queries for placing things: ridge/peak sites for positions, valley
// floors for roads. Everything is derived from the CPU heightfield (the DEM is
// static, so results are deterministic) and nothing here deforms terrain —
// units are sited where the ground is already buildable.
import { terrainHeight } from '../world/terrain/heightfield.js';

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Slope (rise over run) at a point, over a baseline of `e` metres. */
export function slopeAt(x, z, e = 30, height = terrainHeight) {
  const dx = height(x + e, z) - height(x - e, z);
  const dz = height(x, z + e) - height(x, z - e);
  return Math.hypot(dx, dz) / (2 * e);
}

/**
 * Best site near (x, z) within `radius`.
 *   'peak'    highest ground
 *   'ridge'   high ground that is flat enough to build on
 *   'valley'  lowest ground
 *   'flat'    flattest ground, mild preference for the centre
 */
export function findSite(x, z, radius, mode = 'ridge', { step = 90, height = terrainHeight } = {}) {
  let best = null;
  let bestScore = -Infinity;
  for (let dz = -radius; dz <= radius; dz += step) {
    for (let dx = -radius; dx <= radius; dx += step) {
      const r = Math.hypot(dx, dz);
      if (r > radius) continue;
      const px = x + dx, pz = z + dz;
      const h = height(px, pz);
      let score;
      if (mode === 'peak') score = h;
      else if (mode === 'valley') score = -h - slopeAt(px, pz, 60, height) * 200;
      else if (mode === 'flat') score = -slopeAt(px, pz, 40, height) * 1000 - r * 0.02;
      else score = h - slopeAt(px, pz, 40, height) * 900 - r * 0.03;
      if (score > bestScore) { bestScore = score; best = { x: px, z: pz, y: h }; }
    }
  }
  return best ?? { x, z, y: height(x, z) };
}

/**
 * `count` points scattered around a centre, each on the flattest ground near a
 * seeded random offset, kept `minSep` apart.
 */
export function scatterSites(cx, cz, count, { rMin = 40, rMax = 220, minSep = 28, seed = 1, height = terrainHeight } = {}) {
  const rng = mulberry32(seed);
  const out = [];
  for (let tries = 0; out.length < count && tries < count * 30; tries++) {
    const a = rng() * Math.PI * 2;
    const r = rMin + (rMax - rMin) * Math.sqrt(rng());
    const s = findSite(cx + Math.cos(a) * r, cz + Math.sin(a) * r, 24, 'flat', { step: 12, height });
    if (out.some((o) => Math.hypot(o.x - s.x, o.z - s.z) < minSep)) continue;
    if (Math.hypot(s.x - cx, s.z - cz) < rMin * 0.6) continue;
    out.push(s);
  }
  return out;
}

/**
 * A road along a valley floor.
 *
 * Starting at (x, z) heading `heading` (rad, 0 = north, clockwise), repeatedly
 * step forward and pick, from a fan of candidate headings, the one that lands
 * on the lowest ground — with a penalty on turning so the track follows the
 * valley's axis instead of hunting side gullies. That is what a track cut by
 * hand does too: it stays on the floor and takes the gentlest line.
 *
 * @returns {{x:number,y:number,z:number}[]} polyline on the terrain
 */
export function traceValleyRoad(x, z, heading, { length = 9000, step = 160, fan = 55, height = terrainHeight } = {}) {
  const pts = [{ x, z, y: height(x, z) }];
  let h = heading;
  const n = Math.round(length / step);
  for (let i = 0; i < n; i++) {
    let best = h;
    let bestScore = Infinity;
    for (let a = -fan; a <= fan; a += 11) {
      const c = h + (a * Math.PI) / 180;
      const px = x + Math.sin(c) * step;
      const pz = z - Math.cos(c) * step;
      // Look two steps on as well, so a one-step dip does not win.
      const far = height(x + Math.sin(c) * step * 2.5, z - Math.cos(c) * step * 2.5);
      const score = height(px, pz) + far * 0.6 + Math.abs(a) * 0.9;
      if (score < bestScore) { bestScore = score; best = c; }
    }
    h = best;
    x += Math.sin(h) * step;
    z -= Math.cos(h) * step;
    pts.push({ x, z, y: height(x, z) });
  }
  return pts;
}

/** Position at distance `d` along a polyline (clamped). Writes {x,y,z,heading}. */
export function alongPath(path, d, out = {}) {
  let i = 0;
  let rem = Math.max(0, d);
  while (i < path.length - 2) {
    const seg = Math.hypot(path[i + 1].x - path[i].x, path[i + 1].z - path[i].z);
    if (rem <= seg) break;
    rem -= seg;
    i++;
  }
  const a = path[i], b = path[i + 1] ?? a;
  const seg = Math.hypot(b.x - a.x, b.z - a.z) || 1;
  const t = Math.min(1, rem / seg);
  out.x = a.x + (b.x - a.x) * t;
  out.z = a.z + (b.z - a.z) * t;
  out.y = a.y + (b.y - a.y) * t;
  out.heading = Math.atan2(b.x - a.x, -(b.z - a.z));
  return out;
}

export function pathLength(path) {
  let l = 0;
  for (let i = 1; i < path.length; i++) l += Math.hypot(path[i].x - path[i - 1].x, path[i].z - path[i - 1].z);
  return l;
}
