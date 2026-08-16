import assert from 'node:assert/strict';
import { terrainVisibility } from './TerrainVisibility.js';

// The sight line is what decides whether a photograph counts. It also backs the
// navigation cue, so a wrong answer both awards an impossible plate and tells
// the pilot a blocked objective is in the clear.

const flat = () => 0;

{
  const from = { x: 0, y: 1200, z: 0 };
  const to = { x: 3000, y: 1000, z: 0 };
  assert.equal(terrainVisibility(from, to, flat), 1, 'clear air over flat ground must read clear');
}

{
  // A wall 200 m short of the objective, at 3 km range. The far margin used to
  // be a tenth of the range, so the last 300 m of every long sight line went
  // untested and a post directly behind a ridge returned a perfect plate.
  const from = { x: 0, y: 1000, z: 0 };
  const to = { x: 3000, y: 1000, z: 0 };
  const ridgeNearTarget = (x) => (x > 2780 && x < 2860 ? 2000 : 0);
  assert.equal(
    terrainVisibility(from, to, ridgeNearTarget),
    0,
    'a ridge close to the objective must still block the shot at long range',
  );
}

{
  // The same wall at the same absolute distance from the target, but with the
  // aircraft twice as far away. A proportional margin scales the blind spot with
  // range; a metric one does not.
  const from = { x: -3000, y: 1000, z: 0 };
  const to = { x: 3000, y: 1000, z: 0 };
  const ridgeNearTarget = (x) => (x > 2780 && x < 2860 ? 2000 : 0);
  assert.equal(
    terrainVisibility(from, to, ridgeNearTarget),
    0,
    'the blind spot must not grow with range',
  );
}

{
  // The objective sits on the ground, so the ground under it must not occlude
  // it. This is what the far standoff is actually for.
  const from = { x: 0, y: 1400, z: 0 };
  const to = { x: 2000, y: 900, z: 0 };
  const groundUnderTarget = (x) => (x > 1960 ? 900 : 0);
  assert.equal(
    terrainVisibility(from, to, groundUnderTarget),
    1,
    'ground at the objective must not occlude the objective',
  );
}

{
  // Likewise the aircraft must not be occluded by the ground it is flying over.
  const from = { x: 0, y: 40, z: 0 };
  const to = { x: 2500, y: 1500, z: 0 };
  const groundUnderAircraft = (x) => (x < 40 ? 39 : 0);
  assert.equal(
    terrainVisibility(from, to, groundUnderAircraft),
    1,
    'ground at the aircraft must not occlude the aircraft',
  );
}

{
  // A sight line shorter than the metric standoffs still gets marched — the
  // standoffs fall back to the proportional margins the soft-clearance contract
  // in navigation-hint.test.mjs depends on.
  const from = { x: 0, y: 100, z: 0 };
  const to = { x: 100, y: 100, z: 0 };
  assert.equal(terrainVisibility(from, to, () => 100), 0, 'a short blocked line still reads blocked');
  assert.equal(terrainVisibility(from, to, () => 80), 0.5, 'the 40 m soft edge survives at short range');
}

console.log('terrain visibility sight-line contracts passed');
