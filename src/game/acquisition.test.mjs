import assert from 'node:assert/strict';
import { ACQUISITION_SCORE, bearingSector, rangeBand, targetCue } from './acquisition.js';
import { CAPTURE_THRESHOLD } from './ReconCamera.js';

// The briefing asks the pilot to *locate* five positions whose locations are
// "unconfirmed", and the HUD used to hand over an exact bearing and slant range
// to all five from the first frame.

{
  assert.equal(bearingSector(0), 'NORTH');
  assert.equal(bearingSector(45), 'NORTH-EAST');
  assert.equal(bearingSector(90), 'EAST');
  assert.equal(bearingSector(180), 'SOUTH');
  assert.equal(bearingSector(270), 'WEST');
  assert.equal(bearingSector(359), 'NORTH', 'the compass wraps');
  assert.equal(bearingSector(-90), 'WEST', 'negative bearings normalise');
  assert.equal(bearingSector(NaN), null);
}

{
  // Every sector must be reachable, or the cue silently biases the search.
  const seen = new Set();
  for (let d = 0; d < 360; d++) seen.add(bearingSector(d));
  assert.equal(seen.size, 8, `expected all eight sectors, saw ${seen.size}`);
}

{
  assert.equal(rangeBand(900), 'UNDER 2 KM');
  assert.equal(rangeBand(4300), '4-6 KM');
  assert.equal(rangeBand(9900), '8-10 KM');
  assert.equal(rangeBand(17000), '15-20 KM');
  assert.equal(rangeBand(46000), '40-50 KM');
  assert.equal(rangeBand(NaN), null);
  assert.equal(rangeBand(-5), null);
}

{
  // Bands must contain the true range, or the cue lies.
  for (const m of [500, 2100, 5000, 9000, 12000, 27000, 33000, 61000]) {
    const band = rangeBand(m);
    if (band === 'UNDER 2 KM') { assert.ok(m < 2000); continue; }
    const [lo, hi] = band.replace(' KM', '').split('-').map(Number);
    const km = m / 1000;
    assert.ok(km >= lo && km <= hi, `${m} m fell outside its own band ${band}`);
  }
}

{
  const unacquired = targetCue({ acquired: false, bearingDeg: 163, rangeMetres: 17400 });
  assert.equal(unacquired.precise, false);
  assert.equal(unacquired.bearing, 'SOUTH');
  assert.equal(unacquired.range, '15-20 KM');
  assert.ok(!/\d{3}°/.test(unacquired.bearing), 'an unacquired target must not leak a precise bearing');

  const acquired = targetCue({ acquired: true, bearingDeg: 163, rangeMetres: 17400 });
  assert.equal(acquired.precise, true);
  assert.equal(acquired.bearing, 'BRG 163°');
  assert.equal(acquired.range, '17.4 KM');

  const close = targetCue({ acquired: true, bearingDeg: 5, rangeMetres: 640 });
  assert.equal(close.range, '640 M', 'inside a kilometre, metres read better than 0.6 KM');
  assert.equal(close.bearing, 'BRG 005°', 'bearings are three digits, like an instrument');
}

{
  // Acquisition is "I can see it", not "I have the photograph". If these ever
  // crossed, a position would confirm itself only at the moment it no longer
  // needed confirming.
  assert.ok(
    ACQUISITION_SCORE < CAPTURE_THRESHOLD,
    `acquisition ${ACQUISITION_SCORE} must sit below capture ${CAPTURE_THRESHOLD}`,
  );
}

console.log('acquisition cue contracts passed');
