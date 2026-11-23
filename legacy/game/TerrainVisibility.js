import { terrainHeight } from '../world/heightfield.js';
import { POST_RADIUS } from './ObservationPost.js';

/**
 * Metres of standoff at each end, so neither endpoint occludes itself.
 *
 * The far margin is the objective's own scuffed footprint: ground inside the
 * camp is the camp's ground and must never be read as an occluder. Tying it to
 * POST_RADIUS keeps the two in step — the previous 10%-of-range margin was
 * roughly right at 600 m and catastrophically wrong at 3 km.
 */
const NEAR_STANDOFF = 60;
const FAR_STANDOFF = POST_RADIUS;

/** Target spacing between samples, in metres. Narrower than any real ridge. */
const SAMPLE_SPACING = 70;

/**
 * Shared terrain line-of-sight visibility, from 0 (blocked) to 1 (clear).
 * Endpoint margins keep a low aircraft and ground objective from occluding
 * themselves; the 40 m soft edge preserves degraded ridge-skimming shots.
 *
 * The margins are fixed distances, not fractions of the range. They used to be
 * 5% and 10% of the sight line, which meant the blind spot grew with distance:
 * at 3 km the last 300 m went untested, so a post standing directly behind a
 * ridge returned a clear line and a perfect plate. The occluder this guards
 * against — the ground the objective is standing on — is a fixed size, so the
 * standoff that clears it is too.
 */
export function terrainVisibility(from, to, heightAt = terrainHeight) {
  const span = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z);
  if (span < 1) return 1;

  // Metric standoffs, but never more than the fraction the old code used, so a
  // short sight line still gets marched instead of being waved through. At
  // 100 m this reproduces the original 5%/10% margins exactly; at 3 km it is
  // 60 m and 58 m instead of 150 m and 300 m.
  const first = Math.min(NEAR_STANDOFF, span * 0.05) / span;
  const last = 1 - Math.min(FAR_STANDOFF, span * 0.10) / span;

  // Sample spacing is held near constant in metres rather than splitting every
  // sight line into the same 30 pieces. A fixed count meant spacing grew with
  // range — 200 m apart at 6 km — so the march stepped clean over any ridge
  // narrower than that and reported a blocked objective as clear.
  //
  // Cost: up to one call per uncaptured post that is actually inside the recon
  // frame — five in the worst case, and only while the optic is up — plus one
  // for the HUD's current target. At the 128-sample cap that is roughly three
  // times the old fixed 31, against a correctness bug that awarded impossible
  // photographs, so the trade is worth making; but it is not "one or two".
  const steps = Math.min(128, Math.max(30, Math.ceil((span * (last - first)) / SAMPLE_SPACING)));
  let clearance = Infinity;

  for (let i = 0; i <= steps; i++) {
    const t = first + ((last - first) * i) / steps;
    const x = from.x + (to.x - from.x) * t;
    const y = from.y + (to.y - from.y) * t;
    const z = from.z + (to.z - from.z) * t;
    clearance = Math.min(clearance, y - heightAt(x, z));
  }

  if (clearance <= 0) return 0;
  return Math.min(clearance / 40, 1);
}
