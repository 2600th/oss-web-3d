import test from 'node:test';
import assert from 'node:assert/strict';
import {
  julianDate, julianDateLocal, calendarDate, sunEquatorial, moonEquatorial, skyState, sunEvents,
  horizontal, equatorialToWorld, directionFromHorizontal, EQUATORIAL_TO_GALACTIC, SITE,
} from './astro.js';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} expected ${b} +- ${tol}, got ${a}`);
const KARGIL = { year: 1999, month: 6, day: 21 };

test('julian date', () => {
  assert.equal(julianDate(2000, 1, 1, 12), 2451545.0);
  assert.equal(julianDate(1999, 1, 1, 0), 2451179.5);
  near(julianDate(1957, 10, 4, 19.44), 2436116.31, 1e-6); // Meeus 7.a
  const c = calendarDate(julianDate(1999, 6, 21, 6.5));
  assert.deepEqual([c.year, c.month, c.day], [1999, 6, 21]);
  near(c.hours, 6.5, 1e-6);
});

test('sun position matches Meeus example 25.a (1992-10-13 0h TD)', () => {
  const s = sunEquatorial(2448908.5);
  near(s.ra, 198.38, 0.02, 'ra');
  near(s.dec, -7.785, 0.02, 'dec');
});

test('moon position matches Meeus example 47.a (1992-04-12 0h TD)', () => {
  const m = moonEquatorial(2448724.5);
  near(m.lambda, 133.167, 0.35, 'longitude');
  near(m.beta, -3.229, 0.25, 'latitude');
  near(m.ra, 134.688, 0.4, 'ra');
  near(m.dec, 13.768, 0.3, 'dec');
  near(m.distance, 368410, 2500, 'distance km');
});

// Reference values for 34.5 N 76.1 E on 1999-06-21 (NOAA solar calculator,
// UTC+5:30): declination 23.44 deg, equation of time -1.7 min, solar noon
// 12:27, sunrise 05:13, sunset 19:41, noon elevation 78.9 deg, sunrise
// azimuth 60.5 deg, sunset azimuth 299.5 deg.
test('sun over Kargil on 1999-06-21 matches the NOAA solar calculator', () => {
  const ev = sunEvents(KARGIL, 34.5, 76.1, 5.5);
  near(ev.noon, 12 + 27.3 / 60, 1.5 / 60, 'solar noon');
  near(ev.sunrise, 5 + 13 / 60, 2.5 / 60, 'sunrise');
  near(ev.sunset, 19 + 41.5 / 60, 2.5 / 60, 'sunset');
  near(ev.noonElevation, 78.94, 0.05, 'noon elevation');
  near(ev.sunset - ev.sunrise, 14.47, 0.05, 'day length');

  const noon = skyState(julianDateLocal(KARGIL, ev.noon), 34.5, 76.1);
  near(noon.sun.dec, 23.44, 0.01, 'declination');
  near(noon.sun.equationOfTime, -1.7, 0.25, 'equation of time');
  near(noon.sun.azimuth, 180, 0.3, 'noon azimuth');

  const rise = skyState(julianDateLocal(KARGIL, ev.sunrise), 34.5, 76.1);
  near(rise.sun.azimuth, 60.5, 0.5, 'sunrise azimuth');
  const set = skyState(julianDateLocal(KARGIL, ev.sunset), 34.5, 76.1);
  near(set.sun.azimuth, 299.5, 0.5, 'sunset azimuth');

  // 09:00 IST: hour angle -51.83 deg -> elevation 43.8, azimuth 89.5 (spherical triangle)
  const nine = skyState(julianDateLocal(KARGIL, 9), 34.5, 76.1);
  near(nine.sun.elevation, 43.8, 0.3, '09:00 elevation');
  near(nine.sun.azimuth, 89.5, 0.4, '09:00 azimuth');
  // local midnight: the sun is 32 deg under the northern horizon
  const night = skyState(julianDateLocal(KARGIL, 0.45), 34.5, 76.1);
  near(night.sun.elevation, -(90 - 34.5 - 23.44), 0.1, 'midnight depression');
});

test('moon phases of June 1999', () => {
  // new 13 June 19:03 UTC, first quarter 20 June 18:13, full 28 June 21:37
  const newMoon = skyState(julianDate(1999, 6, 13, 19.05));
  assert.ok(newMoon.moon.phase < 0.005, `new moon fraction ${newMoon.moon.phase}`);
  const quarter = skyState(julianDate(1999, 6, 20, 18.22));
  near(quarter.moon.phase, 0.5, 0.02, 'first quarter');
  assert.ok(quarter.moon.waxing);
  near(quarter.moon.age, 0.25, 0.01, 'quarter age');
  const full = skyState(julianDate(1999, 6, 28, 21.62));
  assert.ok(full.moon.phase > 0.995, `full moon fraction ${full.moon.phase}`);
  near(full.moon.age, 0.5, 0.01, 'full age');
  // a full moon stands opposite the sun: up at local midnight, low in summer
  const mid = skyState(julianDateLocal({ year: 1999, month: 6, day: 29 }, 0.5));
  assert.ok(mid.moon.elevation > 20 && mid.moon.elevation < 40, `full moon midnight elevation ${mid.moon.elevation}`);
  assert.ok(mid.sun.elevation < -25);
});

test('the star matrix agrees with the horizontal transform', () => {
  const jd = julianDateLocal(KARGIL, 23.3);
  const m = equatorialToWorld(jd);
  for (const [ra, dec] of [[101.287, -16.716], [279.23, 38.78], [37.95, 89.26], [266.4, -29.0]]) {
    const q = [Math.cos(dec * Math.PI / 180) * Math.cos(ra * Math.PI / 180), Math.cos(dec * Math.PI / 180) * Math.sin(ra * Math.PI / 180), Math.sin(dec * Math.PI / 180)];
    const w = [0, 1, 2].map((r) => m[r * 3] * q[0] + m[r * 3 + 1] * q[1] + m[r * 3 + 2] * q[2]);
    const h = horizontal(ra, dec, jd);
    const e = directionFromHorizontal(h.elevation, h.azimuth);
    for (let k = 0; k < 3; k++) near(w[k], e[k], 1e-9);
  }
  // Polaris sits at the latitude's elevation, due north (-Z)
  const p = horizontal(37.95, 89.26, jd);
  near(p.elevation, SITE.lat, 0.8, 'pole star elevation');
  assert.ok(p.azimuth < 2 || p.azimuth > 358);
});

test('galactic frame: the centre and the pole land where they should', () => {
  const g = EQUATORIAL_TO_GALACTIC;
  const to = (ra, dec) => {
    const r = ra * Math.PI / 180, d = dec * Math.PI / 180;
    const q = [Math.cos(d) * Math.cos(r), Math.cos(d) * Math.sin(r), Math.sin(d)];
    return [0, 1, 2].map((k) => g[k * 3] * q[0] + g[k * 3 + 1] * q[1] + g[k * 3 + 2] * q[2]);
  };
  const c = to(266.405, -28.936); // Sgr A*
  near(c[0], 1, 1e-4);
  const p = to(192.859, 27.128); // north galactic pole
  near(p[2], 1, 1e-4);
  // late June, 01:00 local: the galactic centre is up in the south over Kargil
  const h = horizontal(266.405, -28.936, julianDateLocal({ year: 1999, month: 6, day: 14 }, 1));
  assert.ok(h.elevation > 20 && h.azimuth > 160 && h.azimuth < 215, `galactic centre el ${h.elevation} az ${h.azimuth}`);
});
