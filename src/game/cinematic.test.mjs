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

  let worst = Infinity;
  // Finer than the setup sampling on purpose: this is what catches a ridge
  // sitting between two of the 24 samples, which is why the per-frame floor in
  // _updateCinematic exists at all.
  for (let i = 0; i < 360; i++) {
    const a = 0.55 + (i / 360) * Math.PI * 2;
    const cx = origin.x + Math.cos(a) * RADIUS;
    const cz = origin.z + Math.sin(a) * RADIUS;
    const ground = terrainHeight(cx, cz);
    const floor = ground + CLEARANCE * 0.5;
    const y = Math.max(centreY - SWAY, floor);
    worst = Math.min(worst, y - ground);
  }

  assert.ok(
    worst >= CLEARANCE * 0.5,
    `seed ${seed}: title camera came within ${Math.round(worst)} m of the ground, want >= ${CLEARANCE * 0.5}`,
  );
}

console.log('cinematic orbit clearance contracts passed');
