import test from 'node:test';
import assert from 'node:assert/strict';
import { lookFor, evBias, darkness, twilightGain, TWILIGHT_GAIN } from './look.js';
import { decodeStars, starColor, milkyWayAt } from '../atmosphere/night/textures.js';
import { readFileSync } from 'node:fs';

test('daylight look is the identity', () => {
  const l = lookFor(45, 0);
  assert.equal(l.night, 0);
  assert.equal(l.ev, 0);
  assert.equal(l.maxEV, 2.2);
  assert.equal(l.grade.saturation, 1);
  assert.deepEqual(l.grade.shadowTint, [1, 1, 1]);
});

test('exposure key: warm lift at golden hour, keyed down at night, continuous', () => {
  assert.ok(evBias(4) > 0.2);
  assert.ok(evBias(-20) < -1);
  for (let e = 30; e > -30; e -= 0.25) {
    assert.ok(Math.abs(evBias(e) - evBias(e - 0.25)) < 0.08, `ev jump at ${e}`);
    assert.ok(darkness(e - 0.25) >= darkness(e));
  }
  const moon = lookFor(-30, 1), dark = lookFor(-30, 0);
  assert.equal(moon.night, 1);
  assert.ok(moon.maxEV > 4 && moon.grade.shadowTint[2] > 1.05 && moon.grade.saturation < 0.9);
  assert.ok(Math.abs(dark.ev - moon.ev) <= 0.25);
});

test('twilight compression is monotonic and only acts near and below the horizon', () => {
  assert.equal(twilightGain(10), 1);
  assert.equal(twilightGain(1.5), 1);
  let prev = 1;
  for (let e = 1.5; e >= -12; e -= 0.1) {
    const g = twilightGain(e);
    assert.ok(g >= prev - 1e-9, `gain dips at ${e}`);
    assert.ok(g / prev < 1.25, `gain jumps at ${e}`);
    prev = g;
  }
  assert.ok(Math.abs(twilightGain(-40) - TWILIGHT_GAIN[TWILIGHT_GAIN.length - 1][1]) < 1e-9);
});

test('star catalogue: packed file decodes, brightest first, Sirius where it should be', () => {
  const buf = readFileSync(new URL('../../../public/assets/sky/stars.bin', import.meta.url));
  const cat = decodeStars(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  assert.ok(cat.count > 8000 && cat.count < 9500, `count ${cat.count}`);
  for (let i = 1; i < cat.count; i++) assert.ok(cat.mag[i] >= cat.mag[i - 1] - 1e-6);
  // Sirius: V -1.44, RA 101.287, Dec -16.716
  assert.ok(Math.abs(cat.mag[0] + 1.44) < 0.05);
  const ra = Math.atan2(cat.dir[1], cat.dir[0]) * 180 / Math.PI;
  const dec = Math.asin(cat.dir[2]) * 180 / Math.PI;
  assert.ok(Math.abs(ra - 101.287) < 0.02 && Math.abs(dec + 16.716) < 0.02, `sirius at ${ra}, ${dec}`);
  assert.equal(decodeStars(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), 2200).count, 2200);
});

test('star colours and the Milky Way model', () => {
  const blue = starColor(-0.2), red = starColor(1.6);
  assert.ok(blue[2] > blue[0] && red[0] > red[2]);
  // bright toward the galactic centre, dark at the poles and in the anticentre
  assert.ok(milkyWayAt(2, -4) > 4 * milkyWayAt(180, 40));
  assert.ok(milkyWayAt(0, 80) < 0.02);
});
