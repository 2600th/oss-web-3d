// Terrain queries for placing things: ridge/peak sites for positions, valley
// floors for roads. Everything is derived from the CPU heightfield (the DEM is
// static, so results are deterministic) and nothing here deforms terrain —
// units are sited where the ground is already buildable.
import { terrainHeight, riverEdge } from '../world/terrain/heightfield.js';

/**
 * [ground polish] Roads and units keep to the dry bank. `riverEdge` is metres
 * from the nearest river bank (negative in the water, 1e9 where there is no
 * river data). Everything that scores "lowest" or "flattest" ground also
 * finds the riverbed, so those scores pay this, in metres of height:
 * nothing past `bank`, a smooth quadratic ramp up to 20 m at the waterline
 * (enough to keep off a wide floodplain's edge, not enough to push a road up
 * a gorge wall: the flat strip by the water is better than a side-hill),
 * and a hard 400 m + 30 per metre inside the water.
 */
export const ROAD_BANK = 25;
export function bankPenalty(e, bank = ROAD_BANK) {
  if (e < 0) return 400 - e * 30;
  if (e >= bank) return 0;
  const t = 1 - e / bank;
  return 20 * t * t;
}

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
 * Steepest 6 m slope over an emplacement-sized pad (centre and four points
 * `r` metres out): a site on a convex shoulder can be gentle at its centre
 * and still fall away 3 m across the footprint.
 */
export function padSlope(x, z, r = 4, height = terrainHeight) {
  return Math.max(
    slopeAt(x, z, 6, height),
    slopeAt(x + r, z, 6, height), slopeAt(x - r, z, 6, height),
    slopeAt(x, z + r, 6, height), slopeAt(x, z - r, 6, height),
  );
}

/**
 * Best site near (x, z) within `radius`.
 *   'peak'    highest ground
 *   'ridge'   high ground that is flat enough to build on
 *   'valley'  lowest ground
 *   'flat'    flattest ground, mild preference for the centre
 */
export function findSite(x, z, radius, mode = 'ridge', { step = 90, height = terrainHeight, edge = riverEdge } = {}) {
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
      // [ground polish] lowest and flattest ground is the riverbed: pay to leave the bank
      else if (mode === 'valley') score = -h - slopeAt(px, pz, 60, height) * 200 - bankPenalty(edge(px, pz));
      else if (mode === 'flat') score = -slopeAt(px, pz, 40, height) * 1000 - r * 0.02 - bankPenalty(edge(px, pz), 12) * 60;
      // a building pad: flattest at the scale of one emplacement (6 m), then of its surroundings
      else if (mode === 'pad') score = -(slopeAt(px, pz, 6, height) * 2 + slopeAt(px, pz, 20, height)) * 1000 - r * 0.02 - bankPenalty(edge(px, pz), 12) * 60;
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
export function scatterSites(cx, cz, count, { rMin = 40, rMax = 220, minSep = 28, seed = 1, height = terrainHeight, edge = riverEdge } = {}) {
  const rng = mulberry32(seed);
  const out = [];
  const maxTries = count * 60;
  for (let tries = 0; out.length < count && tries < maxTries; tries++) {
    const a = rng() * Math.PI * 2;
    const r = rMin + (rMax - rMin) * Math.sqrt(rng());
    // [ground polish] flattest at the emplacement's own scale (6 m), searched on an
    // 8 m grid: "flattest over 40 m" picked shelves whose 6 m slope was still 25+ degrees
    const s = findSite(cx + Math.cos(a) * r, cz + Math.sin(a) * r, 24, 'pad', { step: 8, height, edge });
    // [ground polish] the flattest ground is often the river itself: never on or at the water
    if (edge(s.x, s.z) < 6) continue;
    // [art pass] "Flattest within 24 m" was still often a 35-45 degree face on the
    // ridges (units then hung off the hillside). Reject local slopes over ~20 degrees
    // at first, relaxing as tries run out so the count is kept. [ground polish] the
    // relaxation now stops near 31 degrees (was 45): past that the seat needs a berm
    // taller than the sangar it carries. The last quarter of the tries takes anything.
    const t = tries / maxTries;
    if (t < 0.75 && padSlope(s.x, s.z, 4, height) > 0.36 + 0.32 * (t / 0.75)) continue;
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
 * [ground polish] "Lowest ground" is the riverbed: the night convoys drove
 * in the Drass for kilometres. The trace above now only finds the valley's
 * axis (so the route keeps its direction and length); the road itself is
 * laid beside it. The axis is resampled every `spacing` metres and each
 * point may slide up to `reach` metres across it; a Viterbi pass picks the
 * offsets that minimise, in metres of height: the ground's height, the
 * water (bankPenalty: smooth inside `bank` metres of the bank, hard in the
 * river), a side-hill term, lateral moves (gentle turns only) and any water
 * crossed between points. So the road takes the dry terrace just above the
 * floodplain, never the river or the valley wall, and crosses the river only
 * where staying on one bank would cost more. Deterministic.
 *
 * @returns {{x:number,y:number,z:number}[]} polyline on the terrain
 */
export function traceValleyRoad(x, z, heading, {
  length = 9000, step = 160, fan = 55, height = terrainHeight, edge = riverEdge, bank = ROAD_BANK, spacing = 40, reach = 200,
} = {}) {
  const axis = [{ x, z }];
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
    axis.push({ x, z });
  }
  return layRoad(axis, { height, edge, bank, spacing, reach });
}

/** The road beside a valley axis: resample, then Viterbi over lateral offsets (see traceValleyRoad). */
function layRoad(axis, { height, edge, bank, spacing, reach }) {
  // resample with a unit normal per point (averaged at the axis's corners)
  const P = [];
  for (let i = 0; i < axis.length - 1; i++) {
    const a = axis[i], b = axis[i + 1];
    const dx = b.x - a.x, dz = b.z - a.z;
    const l = Math.hypot(dx, dz) || 1;
    const sub = Math.max(1, Math.round(l / spacing));
    for (let k = 0; k < sub; k++) P.push({ x: a.x + dx * k / sub, z: a.z + dz * k / sub, tx: dx / l, tz: dz / l });
  }
  if (!P.length) return axis.map((p) => ({ x: p.x, z: p.z, y: height(p.x, p.z) }));
  const end = axis[axis.length - 1];
  P.push({ x: end.x, z: end.z, tx: P[P.length - 1].tx, tz: P[P.length - 1].tz });
  for (let i = 1; i < P.length - 1; i++) {
    const tx = P[i - 1].tx + P[i].tx, tz = P[i - 1].tz + P[i].tz;
    const l = Math.hypot(tx, tz) || 1;
    P[i].nx = -tz / l; P[i].nz = tx / l;
  }
  P[0].nx = -P[0].tz; P[0].nz = P[0].tx;
  P[P.length - 1].nx = -P[P.length - 1].tz; P[P.length - 1].nz = P[P.length - 1].tx;

  const offs = [];
  for (let o = -reach; o <= reach + 1e-6; o += 10) offs.push(o);
  const m = offs.length;
  const maxShift = spacing * 1.5; // a lateral move steeper than ~56 degrees is not a road
  const wet = (px, pz) => bankPenalty(edge(px, pz), bank);
  const X = new Float64Array(P.length * m), Z = new Float64Array(P.length * m);
  const node = new Float64Array(P.length * m);
  for (let i = 0; i < P.length; i++) {
    for (let j = 0; j < m; j++) {
      const k = i * m + j;
      const px = P[i].x + P[i].nx * offs[j], pz = P[i].z + P[i].nz * offs[j];
      X[k] = px; Z[k] = pz;
      node[k] = height(px, pz) + wet(px, pz) + slopeAt(px, pz, 12, height) * 80 + Math.abs(offs[j]) * 0.05;
    }
  }
  let cost = node.slice(0, m);
  const from = new Int32Array(P.length * m);
  for (let i = 1; i < P.length; i++) {
    const next = new Float64Array(m).fill(Infinity);
    for (let j = 0; j < m; j++) {
      const k = i * m + j;
      for (let q = 0; q < m; q++) {
        const d = Math.abs(offs[j] - offs[q]);
        if (d > maxShift || cost[q] === Infinity) continue;
        const p = (i - 1) * m + q;
        // lateral moves cost a little, sharp ones a lot; water between the points is paid too
        const c = cost[q] + node[k] + d * 0.4 + Math.max(0, d - spacing * 0.6) * 4 + wet((X[p] + X[k]) / 2, (Z[p] + Z[k]) / 2);
        if (c < next[j]) { next[j] = c; from[k] = q; }
      }
    }
    cost = next;
  }
  let j = 0;
  for (let q = 1; q < m; q++) if (cost[q] < cost[j]) j = q;
  const pts = new Array(P.length);
  for (let i = P.length - 1; i >= 0; i--) {
    const k = i * m + j;
    pts[i] = { x: X[k], z: Z[k], y: height(X[k], Z[k]) };
    j = from[k];
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
