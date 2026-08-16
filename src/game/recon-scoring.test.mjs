import assert from 'node:assert/strict';
import { composeScore, energyTerm, gradeFor } from './ReconCamera.js';

// Measured on the shipped build with __recon(4, 1200, 4): framing 0.944,
// coverage 1.000, rangeQuality 1.000, angleQuality 1.000, visibility 1.000,
// score 0.983. Three of the four sub-scores pinned at exactly 1.0 for a naive
// scripted approach, so EXCELLENT was the default outcome and the grade taught
// the player nothing about the photograph they had just taken.
//
// The second problem was that nothing in the score depended on how the aircraft
// was being flown, so the optimal play was to loiter high and slow — the
// opposite of a 250 m/s reconnaissance run through valleys.

{
  // A blocked target scores nothing no matter how well it is framed.
  const blocked = composeScore({
    visibility: 0, framing: 1, coverage: 1, rangeQuality: 1, angleQuality: 1, energy: 1,
  });
  assert.equal(blocked, 0, 'line of sight gates the whole plate');
}

{
  // The weights have to sum to one, or a perfect plate cannot reach a perfect
  // score and every grade threshold silently shifts.
  const perfect = composeScore({
    visibility: 1, framing: 1, coverage: 1, rangeQuality: 1, angleQuality: 1, energy: 1,
  });
  assert.ok(Math.abs(perfect - 1) < 1e-9, `a perfect plate must score 1, got ${perfect}`);
}

{
  // Flying is now part of the photograph.
  const loitering = energyTerm(110, 2400);
  const committed = energyTerm(250, 420);
  assert.ok(
    committed > loitering + 0.4,
    `a fast low pass must out-score a high slow loiter: ${committed} vs ${loitering}`,
  );
  assert.ok(loitering < 0.35, 'loitering high and slow should score poorly on energy');
  assert.ok(committed > 0.85, 'the intended flight profile should score well on energy');
}

{
  // Suicidally low is not the answer either — the band closes at both ends.
  assert.ok(energyTerm(250, 20) < energyTerm(250, 420), 'scraping the ground is not rewarded');
  assert.ok(energyTerm(430, 420) < energyTerm(250, 420), 'past the airframe band, speed stops helping');
}

{
  // The whole point: a lazy pass must no longer be excellent, and a committed
  // one must be.
  const lazy = composeScore({
    visibility: 1, framing: 0.86, coverage: 0.8, rangeQuality: 0.9,
    angleQuality: 0.85, energy: energyTerm(110, 2400),
  });
  const committed = composeScore({
    visibility: 1, framing: 0.97, coverage: 0.95, rangeQuality: 0.98,
    angleQuality: 0.95, energy: energyTerm(250, 420),
  });
  assert.notEqual(gradeFor(lazy), 'EXCELLENT', `a lazy pass scored ${lazy.toFixed(3)}`);
  assert.equal(gradeFor(committed), 'EXCELLENT', `a committed pass scored ${committed.toFixed(3)}`);
}

{
  // Omitting flight state (the harness, and the navigation cue's speculative
  // scoring) must not zero the plate — it falls back to a neutral term.
  const withoutState = composeScore({
    visibility: 1, framing: 1, coverage: 1, rangeQuality: 1, angleQuality: 1,
  });
  assert.ok(withoutState > 0.7 && withoutState < 1, 'a missing energy term is neutral, not fatal');
}

console.log('recon scoring contracts passed');
