import assert from 'node:assert/strict';
import { FEATURED_SEEDS, sortieParams } from './sortieParams.js';
import { terrainHeight } from '../world/heightfield.js';

// The title-screen camera flies a slow 5.2 km orbit while the titles play.
//
// Its altitude used to be `terrainHeight(centre) + 2100` — the height of one
// point, for a shot that travels five kilometres away from it. That was tuned
// against a single hardcoded start position. Once a seed could move the sortie
// anywhere on a 40-240 km annulus, and the featured seeds were picked for close
// to 4 km of local relief, a ridge on the far side of the orbit was routinely
// higher than the ground at the centre and the camera flew through it: seven of
// the ten featured seeds, worst case 1,315 m below the surface.
//
// These constants mirror Game.js. Game.js is not importable here — it touches
// `window` at module load — so the orbit is reproduced rather than called.
const RADIUS = 5200;
const CLEARANCE = 2100;
const SAMPLES = 24;
const SWAY = 260;

function orbitCeiling(x, z) {
  let ceiling = terrainHeight(x, z);
  for (let i = 0; i < SAMPLES; i++) {
    const a = (i / SAMPLES) * Math.PI * 2;
    const h = terrainHeight(x + Math.cos(a) * RADIUS, z + Math.sin(a) * RADIUS);
    if (h > ceiling) ceiling = h;
  }
  return ceiling;
}

for (const seed of FEATURED_SEEDS) {
  const { origin } = sortieParams(seed);
  const centreY = orbitCeiling(origin.x, origin.z) + CLEARANCE;

  // Two separate questions, and the first one is the one that matters.
  //
  // The orbit ceiling is what this fix is: sample the terrain the whole circle
  // passes over, not just the point at its centre. The per-frame floor in
  // _updateCinematic is a backstop for a ridge between samples.
  //
  // Asserting only the clamped height was near-vacuous: `max(y, ground + 1050)
  // - ground >= 1050` is true algebraically for every sample whatever the
  // ceiling is, so the original version of this test passed on seven of the ten
  // seeds with the ceiling reverted to the old single-point height — including
  // four that were kilometres underground. Measure the *unclamped* orbit.
  let worstUnclamped = Infinity;
  let worstClamped = Infinity;
  for (let i = 0; i < 360; i++) {
    const a = 0.55 + (i / 360) * Math.PI * 2;
    const cx = origin.x + Math.cos(a) * RADIUS;
    const cz = origin.z + Math.sin(a) * RADIUS;
    const ground = terrainHeight(cx, cz);
    // Worst case of the vertical sway is the bottom of it.
    const unclamped = centreY - SWAY;
    worstUnclamped = Math.min(worstUnclamped, unclamped - ground);
    worstClamped = Math.min(worstClamped, Math.max(unclamped, ground + CLEARANCE * 0.5) - ground);
  }

  assert.ok(
    worstUnclamped >= CLEARANCE * 0.5,
    `seed ${seed}: the orbit ceiling alone leaves ${worstUnclamped.toFixed(1)} m of clearance, `
    + `want >= ${CLEARANCE * 0.5}. The ceiling is the fix; the per-frame floor is only a backstop.`,
  );
  assert.ok(
    worstClamped >= CLEARANCE * 0.5,
    `seed ${seed}: clamped clearance ${worstClamped.toFixed(1)} m`,
  );
}

{
  // The guard the assertion above depends on: with the pre-fix ceiling — the
  // height of the single centre point — the orbit really did go underground.
  // If this ever stops failing, the test above has stopped proving anything.
  let sawNegative = false;
  for (const seed of FEATURED_SEEDS) {
    const { origin } = sortieParams(seed);
    const naiveY = terrainHeight(origin.x, origin.z) + CLEARANCE;
    for (let i = 0; i < 360 && !sawNegative; i++) {
      const a = 0.55 + (i / 360) * Math.PI * 2;
      const ground = terrainHeight(origin.x + Math.cos(a) * RADIUS, origin.z + Math.sin(a) * RADIUS);
      if (naiveY - SWAY - ground < 0) sawNegative = true;
    }
  }
  assert.ok(sawNegative, 'the featured seeds must still include a case the naive ceiling gets wrong');
}

console.log('cinematic orbit clearance contracts passed');
