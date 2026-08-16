import * as THREE from 'three';
import { terrainHeight, terrainSlope } from '../world/heightfield.js';
import { ObservationPost, POST_RADIUS } from './ObservationPost.js';

/**
 * Sortie state: where the observation posts are, which have been photographed,
 * and whether the mission is running, won or lost.
 *
 * Post siting is a search over the height field rather than random scatter,
 * because *where* a position sits is what makes finding it feel like
 * reconnaissance instead of a treasure hunt. A real high-altitude OP wants
 * height over a valley, a shoulder flat enough to build on, and a view of the
 * ground it is watching. Those three conditions put the posts on exactly the
 * ridgelines and passes a pilot would think to search.
 */

const MIN_ALTITUDE = 4250;
const MAX_ALTITUDE = 5700;
const MAX_SLOPE = 0.30; // buildable ground
const MIN_SEPARATION = 7000;
const SEARCH_MIN_RANGE = 7000;
const SEARCH_MAX_RANGE = 27000;

export class Mission {
  constructor(scene, origin, postCount = 5, seed = null) {
    this.scene = scene;
    this.origin = origin.clone();
    this.postCount = postCount;
    /**
     * The sortie seed. The leaderboard scopes its board to this, because the
     * daily seed moves the course — across eight consecutive days the route
     * measured 63-109 km — so ranking bare seconds compares different flights.
     */
    this.seed = Number.isFinite(seed) ? seed : null;
    this.posts = [];

    this.state = 'briefing'; // briefing | active | complete | failed
    this.elapsed = 0;
    this.photosTaken = 0;
    this.distanceFlown = 0;
    this.bestApproach = Infinity;
    this.targetIndex = 0;
    this._targetId = null;

    this._lastPosition = origin.clone();

    for (const site of findPostSites(origin, postCount)) {
      const post = new ObservationPost(this.posts.length, site.position, site.seed);
      this.posts.push(post);
      scene.add(post.group);
    }
  }

  get captured() {
    return this.posts.filter((p) => p.captured).length;
  }

  get complete() {
    // The length check is not redundant: an empty post list would otherwise
    // report complete on the first frame and end the sortie before it started.
    return this.posts.length > 0 && this.captured >= this.posts.length;
  }

  /** The post the HUD is currently steering toward. */
  get target() {
    const pending = this.posts.filter((p) => !p.captured);
    if (pending.length === 0) return null;
    const selected = pending.find((post) => post.id === this._targetId);
    if (selected) return selected;

    let next = null;
    if (this._targetId != null) {
      const previousIndex = this.posts.findIndex((post) => post.id === this._targetId);
      for (let offset = 1; offset <= this.posts.length; offset++) {
        const candidate = this.posts[(previousIndex + offset + this.posts.length) % this.posts.length];
        if (!candidate.captured) {
          next = candidate;
          break;
        }
      }
    }
    next ??= pending[((this.targetIndex % pending.length) + pending.length) % pending.length];
    this._targetId = next.id;
    return next;
  }

  cycleTarget(direction = 1) {
    const pending = this.posts.filter((p) => !p.captured);
    if (pending.length <= 1) return;
    const current = this.target;
    const currentIndex = Math.max(0, pending.indexOf(current));
    this.targetIndex = (currentIndex + direction + pending.length) % pending.length;
    this._targetId = pending[this.targetIndex].id;
  }

  begin() {
    this.state = 'active';
    this.elapsed = 0;
  }

  fail(reason) {
    if (this.state !== 'active') return;
    this.state = 'failed';
    this.failReason = reason;
  }

  /**
   * @param {number} dt      wall seconds since the last frame
   * @param {THREE.Vector3} aircraftPosition
   * @param {number} [simDt] seconds the flight model actually integrated this
   *   frame. The fixed-step loop caps at MAX_STEPS and drops the remainder, so
   *   below about 20 fps the aircraft flies less far than the wall clock says.
   *   Ranking sorties on wall time made leaderboard entries incomparable across
   *   hardware — a slower machine covered less ground per recorded second.
   */
  update(dt, aircraftPosition, simDt = dt) {
    if (this.state !== 'active') return;
    this.elapsed += simDt;
    this.distanceFlown += this._lastPosition.distanceTo(aircraftPosition);
    this._lastPosition.copy(aircraftPosition);

    for (const post of this.posts) {
      if (post.captured) continue;
      const d = aircraftPosition.distanceTo(post.position);
      if (d < this.bestApproach) this.bestApproach = d;
    }

    if (this.complete) this.state = 'complete';
  }

  /** Bearing (degrees) and slant range (metres) from the aircraft to a post. */
  bearingTo(post, from) {
    const dx = post.position.x - from.x;
    const dz = post.position.z - from.z;
    // Heading convention: 0 = -Z (north), increasing clockwise.
    let bearing = Math.atan2(dx, -dz) * (180 / Math.PI);
    if (bearing < 0) bearing += 360;
    return { bearing, range: Math.hypot(dx, dz, post.position.y - from.y) };
  }

  dispose() {
    for (const post of this.posts) {
      this.scene.remove(post.group);
      post.dispose();
    }
    this.posts.length = 0;
  }
}

/**
 * Score a candidate site. Returns null if the ground is unusable.
 *
 * `overlook` is the important term: the drop to the lowest ground within about
 * a kilometre and a half. It is what separates a genuine ridgeline position
 * that commands a valley from a random flat spot on a high plateau.
 */
function scoreSite(x, z) {
  const y = terrainHeight(x, z);
  if (y < MIN_ALTITUDE || y > MAX_ALTITUDE) return null;

  const slope = terrainSlope(x, z, 24);
  if (slope > MAX_SLOPE) return null;

  let lowest = Infinity;
  let higherNeighbours = 0;
  let prominence = 0;
  const samples = 12;
  for (let i = 0; i < samples; i++) {
    const a = (i / samples) * Math.PI * 2;
    const cos = Math.cos(a);
    const sin = Math.sin(a);

    const near = terrainHeight(x + cos * 260, z + sin * 260);
    prominence += y - near;
    if (near > y + 25) higherNeighbours++;

    const far = terrainHeight(x + cos * 1500, z + sin * 1500);
    if (far < lowest) lowest = far;
  }
  prominence /= samples;

  // A shoulder, not a summit and not a bowl: some ground above, most below.
  if (higherNeighbours > 5) return null;
  if (prominence < 8) return null;

  const overlook = y - lowest;
  if (overlook < 700) return null;

  return (
    Math.min(overlook, 2400) / 2400 +
    Math.min(prominence, 120) / 120 +
    (1 - slope / MAX_SLOPE) * 0.6
  );
}

/**
 * Deterministic search for well-sited posts around the mission origin. Walks a
 * coarse polar grid, keeps the best-scoring candidates, and enforces a minimum
 * separation so the sortie is a route rather than a single orbit.
 */
export function findPostSites(origin, count) {
  const candidates = [];
  const rings = 26;
  const spokes = 40;

  for (let r = 0; r < rings; r++) {
    const range = SEARCH_MIN_RANGE + ((SEARCH_MAX_RANGE - SEARCH_MIN_RANGE) * r) / (rings - 1);
    for (let s = 0; s < spokes; s++) {
      // Offset each ring so samples do not line up radially.
      const a = ((s + r * 0.37) / spokes) * Math.PI * 2;
      const x = origin.x + Math.cos(a) * range;
      const z = origin.z + Math.sin(a) * range;
      const score = scoreSite(x, z);
      if (score === null) continue;
      candidates.push({ x, z, score, range });
    }
  }

  candidates.sort((a, b) => b.score - a.score);

  const chosen = [];
  for (const c of candidates) {
    if (chosen.length >= count) break;
    let ok = true;
    for (const p of chosen) {
      if (Math.hypot(p.x - c.x, p.z - c.z) < MIN_SEPARATION) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    chosen.push(c);
  }

  // Relax separation if the terrain around this origin could not supply enough
  // well-separated sites, so a sortie always has its full set of objectives.
  let relax = MIN_SEPARATION;
  while (chosen.length < count && relax > 1500) {
    relax *= 0.7;
    for (const c of candidates) {
      if (chosen.length >= count) break;
      if (chosen.some((p) => Math.hypot(p.x - c.x, p.z - c.z) < relax)) continue;
      chosen.push(c);
    }
  }

  // Last resort: scoreSite rejects anything that is not a genuine overlook, so
  // on unusually gentle ground the candidate list itself can come up short and
  // no amount of relaxing separation will help. Widen the search on relaxed
  // criteria rather than returning a short list — the brief calls for four to
  // six objectives, and shipping three would be a silently wrong sortie. Zero
  // is worse still: mission.complete is `captured >= posts.length`, so an empty
  // set finishes the sortie the instant it begins.
  if (chosen.length < count) {
    const fallback = [];
    const rings = 34;
    const spokes = 52;
    for (let r = 0; r < rings && fallback.length < 4000; r++) {
      const range = SEARCH_MIN_RANGE + ((SEARCH_MAX_RANGE * 1.6 - SEARCH_MIN_RANGE) * r) / (rings - 1);
      for (let s = 0; s < spokes; s++) {
        const a = ((s + r * 0.37) / spokes) * Math.PI * 2;
        const x = origin.x + Math.cos(a) * range;
        const z = origin.z + Math.sin(a) * range;
        const h = terrainHeight(x, z);
        if (h < MIN_ALTITUDE - 900 || h > MAX_ALTITUDE + 900) continue;
        if (terrainSlope(x, z) > MAX_SLOPE * 1.8) continue;
        fallback.push({ x, z, score: -terrainSlope(x, z), range, h });
      }
    }
    fallback.sort((a, b) => b.h - a.h);
    let spacing = MIN_SEPARATION;
    while (chosen.length < count && spacing > 400) {
      for (const c of fallback) {
        if (chosen.length >= count) break;
        if (chosen.some((p) => Math.hypot(p.x - c.x, p.z - c.z) < spacing)) continue;
        chosen.push(c);
      }
      spacing *= 0.6;
    }
  }

  // Order them into a sensible route: nearest first, then nearest-neighbour.
  const route = [];
  const pool = [...chosen];
  let from = { x: origin.x, z: origin.z };
  while (pool.length) {
    let bestIndex = 0;
    let bestDistance = Infinity;
    for (let i = 0; i < pool.length; i++) {
      const d = Math.hypot(pool[i].x - from.x, pool[i].z - from.z);
      if (d < bestDistance) {
        bestDistance = d;
        bestIndex = i;
      }
    }
    const next = pool.splice(bestIndex, 1)[0];
    route.push(next);
    from = next;
  }

  return route.map((c, i) => ({
    position: new THREE.Vector3(c.x, terrainHeight(c.x, c.z), c.z),
    seed: Math.floor(Math.abs(c.x) * 7919 + Math.abs(c.z) * 104729 + i * 31),
  }));
}

export { POST_RADIUS };
