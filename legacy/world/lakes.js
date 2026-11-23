import { terrainHeight } from './heightfield.js';

/**
 * Deterministic glacial-lake placement.
 *
 * The world is analytic and unbounded, so there is no heightmap to flood-fill
 * and no global pass that could pick "the" lake basins. Everything here is a
 * pure function of world coordinates: a lattice of candidate cells, each of
 * which independently decides whether it owns a lake and what that lake looks
 * like. Two players a hundred kilometres apart, or the same player returning an
 * hour later, get bit-identical results, and nothing depends on which region
 * happened to be evaluated first.
 *
 * The measurements quoted below come from a 100 x 100 km sweep of the real
 * height field (`.agent/lake-map.mjs` reproduces them), not from intuition —
 * "is there flat enclosed ground in this world at all?" was the open question
 * and it had to be answered before the rule could be designed. The answer:
 * local relief over an 800 m span is 114 m at the 5th percentile and 353 m at
 * the median, so genuinely flat ground is rare and the rule has to hunt for it
 * rather than assume it.
 */

/**
 * Lattice pitch, metres.
 *
 * One candidate per cell, so this is the upper bound on lake density. Measured
 * against the height field: 3000 m yields 1.62 lakes/100 km2, 2400 m yields
 * 2.19, and 2000 m yields 3.16 but with markedly worse basins — at that pitch
 * the descent starts finding shoulders rather than floors, and the fraction of
 * painted surface that is not hydrologically connected to the basin floor rises
 * from 0.19% to 1.84% with one lake 91% disconnected. 2400 m is the knee.
 */
export const LAKE_SPACING = 2400;

/** Radii are stored per bearing; 16 is what the instance attributes carry. */
export const LAKE_BEARINGS = 16;

/**
 * Shared collision/render shoreline resolution. The survey remains deliberately
 * cheap at sixteen bearings; this denser polygon is a smooth, conservative
 * reconstruction of those samples and is the single outline queried by both
 * gameplay and Water's batch builder.
 */
export const LAKE_SURFACE_SEGMENTS = 128;

const JITTER = 0.4; // candidate offset within its cell, as a fraction of pitch
const GATE = 210; // reject outright above this much relief over a 600 m ring
const DESCENT_ROUNDS = 4;
const REACH = 1600; // metres of outward ray used for rim and flood extent
const WALK = 80; // ray sample pitch; a dam thinner than this cannot hold water
const FREEBOARD = 0.55; // fraction of floor-to-spill the lake is allowed to fill
const MIN_DEPTH = 7;
const MAX_DEPTH = 55;
const MIN_MEAN_RADIUS = 120;
const MAX_LEVEL = 5200; // above this a basin is a snowfield, not a lake

const STEPS = Math.ceil(REACH / WALK);
const TAU = Math.PI * 2;

/**
 * Integer lattice hash, same construction as the one in heightfield.js and for
 * the same reason: fract-based hashes on coordinates this large lose most of
 * their mantissa. This one uses different multipliers so lake jitter is not
 * correlated with terrain features.
 */
function hash2(ix, iy) {
  let n = (Math.imul(ix, 2654435761) ^ Math.imul(iy, 1013904223)) >>> 0;
  n = Math.imul(n ^ (n >>> 16), 2246822519) >>> 0;
  n = Math.imul(n ^ (n >>> 13), 3266489917) >>> 0;
  n = (n ^ (n >>> 16)) >>> 0;
  return (n >>> 8) / 16777215;
}

const COS = new Float64Array(LAKE_BEARINGS);
const SIN = new Float64Array(LAKE_BEARINGS);
for (let i = 0; i < LAKE_BEARINGS; i++) {
  const a = (i / LAKE_BEARINGS) * TAU;
  COS[i] = Math.cos(a);
  SIN[i] = Math.sin(a);
}

// Eight-neighbour offsets, used by both the flatness gate and the descent.
const D8C = [1, 0.70710678, 0, -0.70710678, -1, -0.70710678, 0, 0.70710678];
const D8S = [0, 0.70710678, 1, 0.70710678, 0, -0.70710678, -1, -0.70710678];

// Scratch reused by every candidate evaluation, so a rejected candidate — which
// is the overwhelmingly common case — allocates nothing at all.
const _rays = new Float64Array(LAKE_BEARINGS * (STEPS + 1));
const _radii = new Float64Array(LAKE_BEARINGS);

/**
 * Evaluate one lattice cell. Returns null, or fills `out` and returns it.
 *
 * The pipeline is ordered strictly by cost, because 85% of cells are rejected
 * by the first nine height evaluations and only the survivors are worth the
 * ~320 the rim survey costs.
 */
function evalCell(ix, iz, out) {
  let px = (ix + 0.5) * LAKE_SPACING + (hash2(ix, iz) - 0.5) * 2 * JITTER * LAKE_SPACING;
  let pz = (iz + 0.5) * LAKE_SPACING + (hash2(ix + 8191, iz - 5347) - 0.5) * 2 * JITTER * LAKE_SPACING;
  let h0 = terrainHeight(px, pz);

  // Is there anything like flat ground here? Cheap and brutal.
  let lo = h0;
  let hi = h0;
  for (let k = 0; k < 8; k++) {
    const h = terrainHeight(px + D8C[k] * 300, pz + D8S[k] * 300);
    if (h < lo) lo = h;
    if (h > hi) hi = h;
  }
  if (hi - lo > GATE) return null;

  // Walk downhill to the basin floor. Without this the lake sits wherever the
  // jitter happened to land, which on this terrain is usually a shoulder: the
  // rim survey then reports a spill level barely above the start and almost
  // every candidate is rejected for being too shallow.
  for (let round = 0; round < DESCENT_ROUNDS; round++) {
    const r = 420 * Math.pow(0.55, round);
    let bx = px;
    let bz = pz;
    let bh = h0;
    for (let k = 0; k < 8; k++) {
      const qx = px + D8C[k] * r;
      const qz = pz + D8S[k] * r;
      const h = terrainHeight(qx, qz);
      if (h < bh) {
        bh = h;
        bx = qx;
        bz = qz;
      }
    }
    px = bx;
    pz = bz;
    h0 = bh;
  }

  // Canonical ownership. The descent frequently leaves the cell it started in,
  // and neighbouring cells frequently descend into the same basin — which
  // without this test emits the same lake two or three times, drawn as
  // overlapping alpha-blended planes at slightly different levels. Letting only
  // the cell that physically contains the floor claim it makes the answer a
  // property of the basin rather than of the query, so it survives being asked
  // from any region at any time. The cost is the basins whose owning cell
  // descends elsewhere; measured, that is what separates the 2.19 lakes per
  // 100 km2 this produces from the ~3 the lattice could theoretically支持.
  if (Math.floor(px / LAKE_SPACING) !== ix || Math.floor(pz / LAKE_SPACING) !== iz) return null;
  if (h0 > MAX_LEVEL) return null;

  // Rim survey. To escape along a straight bearing water must clear every point
  // on it, so the barrier that way is the highest point along the ray; the
  // spill level is the lowest barrier over all bearings. Real escape routes
  // curve, so this over-estimates — which is why the lake is only filled to
  // FREEBOARD of it rather than to the brim.
  let spill = Infinity;
  for (let b = 0; b < LAKE_BEARINGS; b++) {
    const base = b * (STEPS + 1);
    _rays[base] = h0;
    let mx = h0;
    for (let s = 1; s <= STEPS; s++) {
      const h = terrainHeight(px + COS[b] * s * WALK, pz + SIN[b] * s * WALK);
      _rays[base + s] = h;
      if (h > mx) mx = h;
    }
    if (mx < spill) spill = mx;
  }
  if (spill - h0 < MIN_DEPTH / FREEBOARD) return null;

  const level = h0 + Math.min((spill - h0) * FREEBOARD, MAX_DEPTH);
  if (level - h0 < MIN_DEPTH) return null;
  if (level > MAX_LEVEL) return null;

  // Flood extent: first crossing above the level along each bearing, linearly
  // interpolated inside the bracketing pair. Reuses the rim survey's samples,
  // so the shape costs nothing beyond what the spill test already paid.
  for (let b = 0; b < LAKE_BEARINGS; b++) {
    const base = b * (STEPS + 1);
    let r = REACH;
    for (let s = 1; s <= STEPS; s++) {
      const h = _rays[base + s];
      if (h > level) {
        const prev = _rays[base + s - 1];
        const f = (level - prev) / Math.max(h - prev, 1e-3);
        r = (s - 1 + Math.min(Math.max(f, 0), 1)) * WALK;
        break;
      }
    }
    _radii[b] = r;
  }

  // Spike suppression. A radius far larger than both neighbours means that ray
  // slipped down an outlet the adjacent bearings never saw, and the rendered
  // polygon then paints water on the far side of a saddle. Measured on the
  // height field, clamping spikes cuts the worst single lake's disconnected
  // fraction from 47% to 8.7% and the population figure from 0.35% to 0.19%,
  // at the price of trimming a few genuinely long fjord arms.
  for (let pass = 0; pass < 2; pass++) {
    for (let b = 0; b < LAKE_BEARINGS; b++) {
      const a = _radii[(b + LAKE_BEARINGS - 1) % LAKE_BEARINGS];
      const c = _radii[(b + 1) % LAKE_BEARINGS];
      _radii[b] = Math.min(_radii[b], 2 * Math.min(a, c) + 110);
    }
  }

  let sum = 0;
  let rMax = 0;
  for (let b = 0; b < LAKE_BEARINGS; b++) {
    sum += _radii[b];
    if (_radii[b] > rMax) rMax = _radii[b];
  }
  if (sum / LAKE_BEARINGS < MIN_MEAN_RADIUS) return null;

  out.x = px;
  out.z = pz;
  out.floor = h0;
  out.level = level;
  out.rMax = rMax;
  out.rMean = sum / LAKE_BEARINGS;
  out.radii.set(_radii);
  return out;
}

function surveyRadius(lake, angle) {
  const f = (angle / TAU) * LAKE_BEARINGS;
  const i = Math.floor(f) % LAKE_BEARINGS;
  const t = f - Math.floor(f);
  const im1 = (i + LAKE_BEARINGS - 1) % LAKE_BEARINGS;
  const i1 = (i + 1) % LAKE_BEARINGS;
  const i2 = (i + 2) % LAKE_BEARINGS;
  // Both anchors are lower bounds on the two survey rays enclosing this arc.
  // Smoothstep has zero derivative at each survey bearing, eliminating the
  // radial jumps that previously became hundred-metre shoreline spikes.
  const a = Math.min(lake.radii[im1], lake.radii[i], lake.radii[i1]);
  const b = Math.min(lake.radii[i], lake.radii[i1], lake.radii[i2]);
  const s = t * t * (3 - 2 * t);
  return a + (b - a) * s;
}

/** Radius of the exact dense shoreline polygon at a bearing. */
function radiusAt(lake, dx, dz) {
  let ang = Math.atan2(dz, dx);
  if (ang < 0) ang += TAU;
  const f = (ang / TAU) * LAKE_SURFACE_SEGMENTS;
  const segment = Math.floor(f) % LAKE_SURFACE_SEGMENTS;
  const local = f - Math.floor(f);
  const delta = TAU / LAKE_SURFACE_SEGMENTS;
  const a0 = segment * delta;
  const a1 = (segment + 1) * delta;
  const r0 = surveyRadius(lake, a0);
  const r1 = surveyRadius(lake, a1 === TAU ? 0 : a1);

  // Ray/edge intersection in polar form. Returning the polygon intersection,
  // rather than the smooth generating curve, makes the CPU query bit-for-bit
  // the same boundary as the finite triangles submitted to the GPU.
  const phi = local * delta;
  const denominator = r1 * Math.sin(delta - phi) + r0 * Math.sin(phi);
  return (r0 * r1 * Math.sin(delta)) / Math.max(denominator, 1e-9);
}

const SURFACE_SAFETY = 2.5;
const SURFACE_SUBDIVISIONS = 7;
const SURFACE_CACHE = new WeakMap();

function surfaceEdgeIsWet(lake, positions, ia, ib, vertexCount, cache) {
  const lo = Math.min(ia, ib);
  const hi = Math.max(ia, ib);
  const key = lo * vertexCount + hi;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const ao = ia * 3;
  const bo = ib * 3;
  const ax = positions[ao];
  const az = positions[ao + 2];
  const bx = positions[bo];
  const bz = positions[bo + 2];
  for (let step = 1; step < SURFACE_SUBDIVISIONS; step++) {
    const f = step / SURFACE_SUBDIVISIONS;
    if (terrainHeight(ax + (bx - ax) * f, az + (bz - az) * f) >= lake.level - SURFACE_SAFETY) {
      cache.set(key, false);
      return false;
    }
  }
  cache.set(key, true);
  return true;
}

function surfaceTriangleIsWet(lake, positions, depths, ia, ib, ic, vertexCount, edgeCache) {
  const da = depths[ia];
  const db = depths[ib];
  const dc = depths[ic];
  if (da <= SURFACE_SAFETY || db <= SURFACE_SAFETY || dc <= SURFACE_SAFETY) return false;

  const ao = ia * 3;
  const bo = ib * 3;
  const co = ic * 3;
  const ax = positions[ao];
  const az = positions[ao + 2];
  const bx = positions[bo];
  const bz = positions[bo + 2];
  const cx = positions[co];
  const cz = positions[co + 2];
  const ab = Math.hypot(ax - bx, az - bz);
  const bc = Math.hypot(bx - cx, bz - cz);
  const ca = Math.hypot(cx - ax, cz - az);
  if (Math.min(da, db, dc) >= SURFACE_SAFETY + 0.9 * Math.max(ab, bc, ca)) return true;

  if (!surfaceEdgeIsWet(lake, positions, ia, ib, vertexCount, edgeCache)) return false;
  if (!surfaceEdgeIsWet(lake, positions, ib, ic, vertexCount, edgeCache)) return false;
  if (!surfaceEdgeIsWet(lake, positions, ic, ia, vertexCount, edgeCache)) return false;
  for (let row = 1; row < SURFACE_SUBDIVISIONS; row++) {
    for (let column = 1; column < SURFACE_SUBDIVISIONS - row; column++) {
      const wb = column / SURFACE_SUBDIVISIONS;
      const wc = row / SURFACE_SUBDIVISIONS;
      const wa = 1 - wb - wc;
      const x = ax * wa + bx * wb + cx * wc;
      const z = az * wa + bz * wb + cz * wc;
      if (terrainHeight(x, z) >= lake.level - SURFACE_SAFETY) return false;
    }
  }
  return true;
}

/**
 * Canonical terrain-safe surface topology shared by rendering and CPU queries.
 * Cached per deterministic lake record and radial tier; rebuilding a Water
 * batch only copies these arrays and never resamples terrain.
 */
export function lakeSurfaceMesh(lake, radialRings = 12) {
  const rings = Math.max(2, radialRings | 0);
  let tiers = SURFACE_CACHE.get(lake);
  if (!tiers) {
    tiers = new Map();
    SURFACE_CACHE.set(lake, tiers);
  }
  const cached = tiers.get(rings);
  if (cached && cached.x === lake.x && cached.z === lake.z && cached.level === lake.level) return cached;

  const vertexCount = 1 + rings * LAKE_SURFACE_SEGMENTS;
  const positions = new Float32Array(vertexCount * 3);
  const depths = new Float32Array(vertexCount);
  const shores = new Float32Array(vertexCount);
  const maxTriangles = LAKE_SURFACE_SEGMENTS * (1 + (rings - 1) * 2);
  const indices = new Uint32Array(maxTriangles * 3);
  const accepted = new Uint8Array(maxTriangles);
  const edgeCache = new Map();
  let vertexCursor = 0;
  let indexCursor = 0;
  let triangleCursor = 0;

  positions[0] = lake.x;
  positions[1] = lake.level;
  positions[2] = lake.z;
  depths[0] = Math.max(lake.level - terrainHeight(lake.x, lake.z), 0);
  shores[0] = lake.rMean;
  vertexCursor++;

  for (let ring = 1; ring <= rings; ring++) {
    const scale = Math.sin((ring / rings) * Math.PI * 0.5);
    for (let segment = 0; segment < LAKE_SURFACE_SEGMENTS; segment++) {
      const angle = (segment / LAKE_SURFACE_SEGMENTS) * TAU;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const boundaryRadius = radiusAt(lake, cos, sin);
      const radius = boundaryRadius * scale;
      const x = lake.x + cos * radius;
      const z = lake.z + sin * radius;
      const offset = vertexCursor * 3;
      positions[offset] = x;
      positions[offset + 1] = lake.level;
      positions[offset + 2] = z;
      depths[vertexCursor] = ring === rings ? 0 : Math.max(lake.level - terrainHeight(x, z), 0);
      shores[vertexCursor] = Math.max(boundaryRadius - radius, 0);
      vertexCursor++;
    }
  }

  const emit = (a, b, c) => {
    const wet = surfaceTriangleIsWet(lake, positions, depths, a, b, c, vertexCount, edgeCache);
    accepted[triangleCursor++] = wet ? 1 : 0;
    if (!wet) return;
    indices[indexCursor++] = a;
    indices[indexCursor++] = b;
    indices[indexCursor++] = c;
  };
  const firstRing = 1;
  for (let segment = 0; segment < LAKE_SURFACE_SEGMENTS; segment++) {
    emit(0, firstRing + ((segment + 1) % LAKE_SURFACE_SEGMENTS), firstRing + segment);
  }
  for (let ring = 1; ring < rings; ring++) {
    const inner = 1 + (ring - 1) * LAKE_SURFACE_SEGMENTS;
    const outer = inner + LAKE_SURFACE_SEGMENTS;
    for (let segment = 0; segment < LAKE_SURFACE_SEGMENTS; segment++) {
      const next = (segment + 1) % LAKE_SURFACE_SEGMENTS;
      emit(inner + segment, outer + next, outer + segment);
      emit(inner + segment, inner + next, outer + next);
    }
  }

  const mesh = {
    x: lake.x,
    z: lake.z,
    level: lake.level,
    radialRings: rings,
    vertexCount,
    positions,
    depths,
    shores,
    accepted,
    indices: indices.subarray(0, indexCursor),
  };
  tiers.set(rings, mesh);
  return mesh;
}

function pointInSurfaceTriangle(x, z, positions, ia, ib, ic) {
  const ax = positions[ia * 3];
  const az = positions[ia * 3 + 2];
  const bx = positions[ib * 3];
  const bz = positions[ib * 3 + 2];
  const cx = positions[ic * 3];
  const cz = positions[ic * 3 + 2];
  const v0x = cx - ax;
  const v0z = cz - az;
  const v1x = bx - ax;
  const v1z = bz - az;
  const v2x = x - ax;
  const v2z = z - az;
  const d00 = v0x * v0x + v0z * v0z;
  const d01 = v0x * v1x + v0z * v1z;
  const d11 = v1x * v1x + v1z * v1z;
  const d20 = v2x * v0x + v2z * v0z;
  const d21 = v2x * v1x + v2z * v1z;
  const denominator = d00 * d11 - d01 * d01;
  const v = (d11 * d20 - d01 * d21) / denominator;
  const w = (d00 * d21 - d01 * d20) / denominator;
  const u = 1 - v - w;
  return u >= -1e-7 && v >= -1e-7 && w >= -1e-7;
}

/** True only where the canonical accepted render topology covers the point. */
export function lakeSurfaceContains(lake, x, z, radialRings = 12) {
  const dx = x - lake.x;
  const dz = z - lake.z;
  const distance = Math.hypot(dx, dz);
  const boundary = radiusAt(lake, dx, dz);
  if (distance > boundary) return false;
  const mesh = lakeSurfaceMesh(lake, radialRings);
  const ratio = boundary > 1e-9 ? distance / boundary : 0;
  if (distance <= 1e-4) {
    for (let candidate = 0; candidate < LAKE_SURFACE_SEGMENTS; candidate++) {
      if (mesh.accepted[candidate] === 1) return true;
    }
    return false;
  }
  let segmentAngle = Math.atan2(dz, dx);
  if (segmentAngle < 0) segmentAngle += TAU;
  const segment = Math.floor((segmentAngle / TAU) * LAKE_SURFACE_SEGMENTS) % LAKE_SURFACE_SEGMENTS;
  const candidateSegments = [
    segment,
    (segment + LAKE_SURFACE_SEGMENTS - 1) % LAKE_SURFACE_SEGMENTS,
    (segment + 1) % LAKE_SURFACE_SEGMENTS,
  ];
  const firstScale = Math.sin((1 / mesh.radialRings) * Math.PI * 0.5);
  if (ratio <= firstScale + 1e-5) {
    for (const candidate of candidateSegments) {
      const candidateNext = (candidate + 1) % LAKE_SURFACE_SEGMENTS;
      if (
        mesh.accepted[candidate] === 1 &&
        pointInSurfaceTriangle(x, z, mesh.positions, 0, 1 + candidateNext, 1 + candidate)
      ) return true;
    }
  }

  let innerRing = 1;
  while (
    innerRing < mesh.radialRings - 1 &&
    ratio > Math.sin(((innerRing + 1) / mesh.radialRings) * Math.PI * 0.5)
  ) innerRing++;
  if (innerRing >= mesh.radialRings) return false;
  const minRing = Math.max(1, innerRing - 1);
  const maxRing = Math.min(mesh.radialRings - 1, innerRing + 1);
  for (let ring = minRing; ring <= maxRing; ring++) {
    const inner = 1 + (ring - 1) * LAKE_SURFACE_SEGMENTS;
    const outer = inner + LAKE_SURFACE_SEGMENTS;
    for (const candidate of candidateSegments) {
      const candidateNext = (candidate + 1) % LAKE_SURFACE_SEGMENTS;
      const mask =
        LAKE_SURFACE_SEGMENTS + (ring - 1) * LAKE_SURFACE_SEGMENTS * 2 + candidate * 2;
      if (
        mesh.accepted[mask] === 1 &&
        pointInSurfaceTriangle(
          x,
          z,
          mesh.positions,
          inner + candidate,
          outer + candidateNext,
          outer + candidate,
        )
      ) return true;
      if (
        mesh.accepted[mask + 1] === 1 &&
        pointInSurfaceTriangle(
          x,
          z,
          mesh.positions,
          inner + candidate,
          inner + candidateNext,
          outer + candidateNext,
        )
      ) return true;
    }
  }
  return false;
}

function makeRecord() {
  return {
    x: 0,
    z: 0,
    floor: 0,
    level: 0,
    rMax: 0,
    rMean: 0,
    radii: new Float64Array(LAKE_BEARINGS),
    dist: 0,
  };
}

/**
 * Standalone cell query. Used by the offline map tool and by anything that
 * wants one lake without paying for a LakeField.
 */
export function lakeInCell(ix, iz) {
  return evalCell(ix, iz, makeRecord());
}

/**
 * Cached, amortised view of the lakes near a moving observer.
 *
 * Evaluating a cell costs about 60 microseconds, and the draw radius covers
 * roughly 470 of them, so doing the whole region in one go is a 28 ms hitch.
 * Instead the field walks a precomputed near-to-far cell order with a per-call
 * budget: the aircraft covers one lattice pitch every nine seconds, which is
 * three orders of magnitude more time than the ring edge needs.
 */
export class LakeField {
  /**
   * @param {object} [opts]
   * @param {number} [opts.drawDistance] metres of lake visibility
   * @param {number} [opts.maxLakes]     hard cap on simultaneously active lakes
   * @param {number} [opts.radialRings]  render-tier topology used by CPU queries
   */
  constructor({ drawDistance = 26000, maxLakes = 48, radialRings = 12 } = {}) {
    this.drawDistance = drawDistance;
    this.maxLakes = maxLakes;
    this.radialRings = radialRings;

    // key -> record | null. A null entry is a cell that has been evaluated and
    // holds no lake; it is as valuable to cache as a hit, because the rejects
    // are 90% of the traffic.
    this.cells = new Map();

    // Record pool. After warm-up nothing here allocates: discovering a lake
    // takes a record off the free list and evicting one puts it back.
    this._pool = [];
    this._poolCount = 0;

    this._span = -1;
    this._offsets = null;
    this._configureOffsets(drawDistance);

    this._cursor = 0;
    this._originX = NaN;
    this._originZ = NaN;

    this.active = new Array(maxLakes).fill(null);
    this.activeCount = 0;
    this.version = 0; // bumped whenever `active` changes; renderers watch it
    this._lastX = NaN;
    this._lastZ = NaN;
    this._dirty = true;

    this._scratch = makeRecord();
  }

  _configureOffsets(drawDistance) {
    const span = Math.ceil(drawDistance / LAKE_SPACING);
    if (span === this._span && this._offsets) return false;
    // Cell offsets in near-to-far order, so the budget is always spent on the
    // cells the player is about to fly over. Rebuilt only on a tier change.
    const offsets = [];
    for (let j = -span; j <= span; j++) {
      for (let i = -span; i <= span; i++) offsets.push([i, j, i * i + j * j]);
    }
    offsets.sort((a, b) => a[2] - b[2]);
    this._offsets = new Int32Array(offsets.length * 2);
    for (let k = 0; k < offsets.length; k++) {
      this._offsets[k * 2] = offsets[k][0];
      this._offsets[k * 2 + 1] = offsets[k][1];
    }
    this._span = span;
    return true;
  }

  /** Reconfigure discovery coverage without invalidating deterministic cells. */
  configure({
    drawDistance = this.drawDistance,
    maxLakes = this.maxLakes,
    radialRings = this.radialRings,
  } = {}) {
    const coverageChanged = this._configureOffsets(drawDistance);
    const capacityChanged = maxLakes !== this.maxLakes;
    const topologyChanged = radialRings !== this.radialRings;
    this.drawDistance = drawDistance;
    this.maxLakes = maxLakes;
    this.radialRings = radialRings;
    if (capacityChanged) {
      if (this.active.length > maxLakes) this.active.length = maxLakes;
      else while (this.active.length < maxLakes) this.active.push(null);
      this.activeCount = Math.min(this.activeCount, maxLakes);
    }
    if (coverageChanged || capacityChanged || topologyChanged) {
      this._cursor = 0;
      this._originX = NaN;
      this._originZ = NaN;
      this._lastX = NaN;
      this._lastZ = NaN;
      this._dirty = true;
      this.version++;
    }
    return coverageChanged || capacityChanged || topologyChanged;
  }

  _key(ix, iz) {
    // Single safe integer, so the Map never sees a freshly built string. Valid
    // to +/- 1.2e9 metres of origin, which is four orders past anything
    // reachable at 260 m/s.
    return iz * 1048576 + ix;
  }

  _take() {
    if (this._poolCount > 0) return this._pool[--this._poolCount];
    return makeRecord();
  }

  _give(record) {
    if (this._poolCount < this._pool.length) this._pool[this._poolCount++] = record;
    else {
      this._pool.push(record);
      this._poolCount++;
    }
  }

  /**
   * Advance discovery and refresh the active set.
   *
   * @param {number} x world X to centre on
   * @param {number} z world Z to centre on
   * @param {number} budget max cells to evaluate this call
   */
  update(x, z, budget = 8) {
    const ox = Math.floor(x / LAKE_SPACING);
    const oz = Math.floor(z / LAKE_SPACING);
    if (ox !== this._originX || oz !== this._originZ) {
      this._originX = ox;
      this._originZ = oz;
      this._cursor = 0;
    }

    let done = 0;
    const total = this._offsets.length >> 1;
    while (done < budget && this._cursor < total) {
      const k = this._cursor++;
      const ix = ox + this._offsets[k * 2];
      const iz = oz + this._offsets[k * 2 + 1];
      const key = this._key(ix, iz);
      if (this.cells.has(key)) continue;
      const found = evalCell(ix, iz, this._scratch);
      if (found) {
        const record = this._take();
        record.x = found.x;
        record.z = found.z;
        record.floor = found.floor;
        record.level = found.level;
        record.rMax = found.rMax;
        record.rMean = found.rMean;
        record.radii.set(found.radii);
        this.cells.set(key, record);
        this._dirty = true;
      } else {
        this.cells.set(key, null);
      }
      done++;
    }

    // Rebuilding the active set every frame would be pointless work: it can
    // only change when the observer has moved appreciably or a cell has just
    // been evaluated.
    const moved = !(Math.abs(x - this._lastX) < 150 && Math.abs(z - this._lastZ) < 150);
    if (this._dirty || moved) {
      this._lastX = x;
      this._lastZ = z;
      this._dirty = false;
      this._rebuildActive(x, z);
    }
    return done;
  }

  /**
   * Insertion-sorted nearest-N. N is 48, so this beats building an array and
   * calling sort() on it — and unlike sort() it touches no allocator at all.
   */
  _rebuildActive(x, z) {
    const limit = this.drawDistance;
    const active = this.active;
    let count = 0;
    let changed = false;
    this.cells.forEach((lake) => {
      if (!lake) return;
      const dx = lake.x - x;
      const dz = lake.z - z;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d - lake.rMax > limit) return;
      lake.dist = d;
      let i = count < this.maxLakes ? count : this.maxLakes - 1;
      if (count >= this.maxLakes && d >= active[i].dist) return;
      while (i > 0 && active[i - 1].dist > d) {
        active[i] = active[i - 1];
        i--;
      }
      if (active[i] !== lake) changed = true;
      active[i] = lake;
      if (count < this.maxLakes) count++;
    });
    if (count !== this.activeCount) changed = true;
    this.activeCount = count;
    if (changed) this.version++;
  }

  /** Evaluate the cell containing (ix, iz) through the cache. */
  _cell(ix, iz) {
    const key = this._key(ix, iz);
    const hit = this.cells.get(key);
    if (hit !== undefined) return hit;
    const found = evalCell(ix, iz, this._scratch);
    let record = null;
    if (found) {
      record = this._take();
      record.x = found.x;
      record.z = found.z;
      record.floor = found.floor;
      record.level = found.level;
      record.rMax = found.rMax;
      record.rMean = found.rMean;
      record.radii.set(found.radii);
      this._dirty = true;
    }
    this.cells.set(key, record);
    return record;
  }

  /**
   * Surface elevation of the lake covering (x, z), or -Infinity on dry land.
   *
   * A lake reaches at most JITTER * pitch + rMax from its cell centre, which is
   * 960 + 1600 m against a 2400 m pitch, so a 3x3 neighbourhood is a strict
   * superset of the cells that could possibly cover the point.
   */
  waterLevelAt(x, z, radialRings = this.radialRings) {
    const ix = Math.floor(x / LAKE_SPACING);
    const iz = Math.floor(z / LAKE_SPACING);
    let best = -Infinity;
    for (let j = -1; j <= 1; j++) {
      for (let i = -1; i <= 1; i++) {
        const lake = this._cell(ix + i, iz + j);
        if (!lake) continue;
        const dx = x - lake.x;
        const dz = z - lake.z;
        const d = Math.sqrt(dx * dx + dz * dz);
        if (d > lake.rMax) continue;
        if (d > radiusAt(lake, dx, dz)) continue;
        if (!lakeSurfaceContains(lake, x, z, radialRings)) continue;
        if (lake.level > best) best = lake.level;
      }
    }
    return best;
  }

  /** Metres of water over (x, z); 0 on dry land. */
  waterDepthAt(x, z, radialRings = this.radialRings) {
    const level = this.waterLevelAt(x, z, radialRings);
    if (level === -Infinity) return 0;
    return Math.max(0, level - terrainHeight(x, z));
  }

  /**
   * Drop cells that have fallen far outside the draw radius. Called rarely and
   * never on a schedule, because the Map is the only thing here that grows and
   * a 500 km sortie only adds a few thousand small entries.
   */
  prune(x, z) {
    const limit = (this._span + 4) * LAKE_SPACING;
    const cx = x;
    const cz = z;
    const doomed = this._doomed || (this._doomed = []);
    doomed.length = 0;
    this.cells.forEach((record, key) => {
      const ix = ((key % 1048576) + 1572864) % 1048576 - 524288;
      const iz = Math.round((key - ix) / 1048576);
      const dx = (ix + 0.5) * LAKE_SPACING - cx;
      const dz = (iz + 0.5) * LAKE_SPACING - cz;
      if (Math.abs(dx) > limit || Math.abs(dz) > limit) doomed.push(key);
    });
    for (let i = 0; i < doomed.length; i++) {
      const record = this.cells.get(doomed[i]);
      if (record) this._give(record);
      this.cells.delete(doomed[i]);
    }
    return doomed.length;
  }

  /** Empty every cached cell while retaining record storage for reuse. */
  clear() {
    this.cells.forEach((record) => {
      if (record) this._give(record);
    });
    this.cells.clear();
    for (let i = 0; i < this.activeCount; i++) this.active[i] = null;
    this.activeCount = 0;
    this._cursor = 0;
    this._originX = NaN;
    this._originZ = NaN;
    this._lastX = NaN;
    this._lastZ = NaN;
    this._dirty = true;
    this.version++;
  }

  dispose() {
    this.clear();
    this._pool.length = 0;
    this._poolCount = 0;
    if (this._doomed) this._doomed.length = 0;
  }
}

export { radiusAt as lakeRadiusAt };
