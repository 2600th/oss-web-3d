/**
 * One seed describes one whole sortie: where it is, and what the light is doing.
 *
 * The terrain is a pure function of world coordinates and is effectively
 * infinite, and findPostSites() already took an origin — so the only thing that
 * ever made every sortie identical was a hardcoded START at (21000, 6000).
 * Moving the origin is all it takes to make the world new.
 *
 * Moving the sun with it is nearly free for a reason worth writing down: the
 * transmittance and multiple-scattering LUTs are parameterised by *sun zenith*
 * rather than baked against a fixed sun, so they never need rebuilding, and the
 * sky-view and aerial LUTs already regenerate on their own cadence. The only
 * real cost is re-baking the terrain's ray-marched shadow pass, and that is
 * already a budgeted incremental job. So a sortie can pick its own hour of the
 * morning for almost nothing.
 */

/**
 * Deterministic 32-bit mix. Same seed, same sortie, on every machine — which is
 * the property the leaderboard depends on.
 */
function hash(seed, salt) {
  let h = (seed ^ salt) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/** Unit float in [0, 1) from a seed and a salt. */
function unit(seed, salt) {
  return hash(seed, salt) / 4294967296;
}

/**
 * The seed everyone flying today shares.
 *
 * A daily seed is what makes a fastest-sortie board mean anything: it compares
 * pilots on the same terrain, the same five positions and the same light,
 * instead of on whatever the generator happened to hand each of them.
 */
export function dailySeed(now = Date.now()) {
  return Math.floor(now / 86400000);
}

/**
 * Everything a sortie needs that is not the aircraft.
 *
 * The origin walks a wide annulus rather than a disc so consecutive seeds do
 * not land on ground a previous one already covered, and so no seed sits at the
 * world origin where the noise field is least interesting.
 */
export function sortieParams(seed) {
  const safeSeed = Number.isFinite(seed) ? Math.abs(Math.trunc(seed)) >>> 0 : 0;
  const angle = unit(safeSeed, 0x9e3779b9) * Math.PI * 2;
  // 40-240 km out. The annulus is bounded because the clipmap's GPU heights and
  // the JS mirror that gameplay queries drift apart as world coordinates grow:
  // measured with __verifyTerrain, worst-texel disagreement runs about 0.6 m at
  // 20-130 km and reaches 3.3 m by 590 km, against a 12 m ground-clearance
  // margin. Mean error stays under half a metre throughout, and the spread
  // tracks local steepness more than distance — but there is no reason to spend
  // the headroom. 200 km of annulus is already vast next to a 30 km sortie.
  const radius = 40000 + unit(safeSeed, 0x85ebca6b) * 200000;
  return {
    seed: safeSeed,
    origin: {
      x: Math.round(Math.cos(angle) * radius),
      z: Math.round(Math.sin(angle) * radius),
    },
    // 12 to 38 degrees. Low enough that the baked shadow march has something to
    // record — at the old fixed 46 it had almost nothing — and high enough that
    // valleys do not go solid black and the objectives stay findable.
    sunElevationDeg: 12 + unit(safeSeed, 0xc2b2ae35) * 26,
    sunAzimuthDeg: unit(safeSeed, 0x27d4eb2f) * 360,
    // Around the shipped 0.00055 default, so a sortie can be clear or bring a
    // deck in without ever closing the valleys completely.
    cloudCoverage: 0.00028 + unit(safeSeed, 0x165667b1) * 0.00062,
  };
}

/** Human-readable sortie identity, for the briefing and the record card. */
export function sortieLabel(seed) {
  return `SEED ${String(seed >>> 0).padStart(6, '0')}`;
}

/**
 * Resolve the seed for this session.
 *
 * `?seed=N` pins one, so a sortie can be shared or re-flown; otherwise it is
 * today's.
 */
export function resolveSeed(search = '', now = Date.now()) {
  const requested = Number(new URLSearchParams(search).get('seed'));
  if (Number.isFinite(requested) && requested !== 0) return Math.abs(Math.trunc(requested)) >>> 0;
  return dailySeed(now);
}
