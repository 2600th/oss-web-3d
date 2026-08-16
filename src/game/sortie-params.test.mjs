import assert from 'node:assert/strict';
import { dailySeed, resolveSeed, sortieLabel, sortieParams } from './sortieParams.js';
import { findPostSites } from './Mission.js';
import * as THREE from 'three';

// Before this existed, START was a constant at (21000, 6000) and findPostSites
// is a pure deterministic search, so every sortie anyone ever flew placed the
// same five posts in the same five spots in the same route order. The terrain
// is infinite and deterministic; the game used one fixed 20 km neighbourhood of
// it forever.

{
  const a = sortieParams(12345);
  const b = sortieParams(12345);
  assert.deepEqual(a, b, 'a seed must describe exactly one sortie');
}

{
  const a = sortieParams(1);
  const b = sortieParams(2);
  const moved = Math.hypot(a.origin.x - b.origin.x, a.origin.z - b.origin.z);
  assert.ok(moved > 20000, `adjacent seeds must land in different country, moved only ${Math.round(moved)} m`);
}

{
  // The whole point is that the light varies too, not just the map.
  const elevations = new Set();
  for (let s = 0; s < 200; s++) {
    const p = sortieParams(s);
    assert.ok(
      p.sunElevationDeg >= 12 && p.sunElevationDeg <= 38,
      `seed ${s} put the sun at ${p.sunElevationDeg.toFixed(1)}, outside the flyable band`,
    );
    assert.ok(p.sunAzimuthDeg >= 0 && p.sunAzimuthDeg < 360);
    assert.ok(p.cloudCoverage > 0 && p.cloudCoverage < 0.0012, 'coverage must stay inside the weather model');
    elevations.add(Math.round(p.sunElevationDeg));
  }
  assert.ok(elevations.size > 15, `sun elevation must actually vary, saw ${elevations.size} distinct values`);
}

{
  // A daily seed is what lets a leaderboard compare pilots at all.
  const morning = Date.UTC(2026, 7, 16, 6, 0, 0);
  const evening = Date.UTC(2026, 7, 16, 23, 30, 0);
  const nextDay = Date.UTC(2026, 7, 17, 6, 0, 0);
  assert.equal(dailySeed(morning), dailySeed(evening), 'one UTC day is one world');
  assert.notEqual(dailySeed(morning), dailySeed(nextDay), 'the world turns over at the day boundary');
}

{
  const now = Date.UTC(2026, 7, 16, 6, 0, 0);
  assert.equal(resolveSeed('?seed=4242', now), 4242, 'an explicit seed pins the sortie');
  assert.equal(resolveSeed('', now), dailySeed(now), 'no seed means today');
  assert.equal(resolveSeed('?seed=abc', now), dailySeed(now), 'a bad seed falls back to today');
  assert.equal(resolveSeed('?seed=-7', now), 7, 'a negative seed is still a seed');
}

{
  assert.equal(sortieLabel(42), 'SEED 000042');
}

{
  // The siting search has to survive wherever a seed drops it. Mission's own
  // suite already covers a few fixed origins; this covers seeded ones.
  for (const seed of [1, 7, 99, 1234, 88888]) {
    const { origin } = sortieParams(seed);
    const sites = findPostSites(new THREE.Vector3(origin.x, 0, origin.z), 5);
    assert.equal(sites.length, 5, `seed ${seed} must still yield five objectives`);
    const distinct = new Set(sites.map((s) => `${s.position.x},${s.position.z}`));
    assert.equal(distinct.size, 5, `seed ${seed} must yield five distinct objectives`);
    for (const site of sites) {
      assert.ok(Number.isFinite(site.position.y), `seed ${seed} produced a site with no ground under it`);
    }
  }
}

console.log('sortie parameter contracts passed');
