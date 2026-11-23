/**
 * Small ephemeris: sun, moon and the rotation of the star sphere for a place
 * and an instant. Pure JS (no three import), unit-tested in astro.test.mjs.
 *
 * Sun and moon follow the low-precision series of the Astronomical Almanac
 * (sun to about 0.01 degrees, moon to about 0.3 degrees between 1950 and 2050),
 * which is far below what a game sky can show. Positions are geometric: no
 * refraction (the atmosphere model does not bend rays either).
 *
 * World frame (docs/v2/ARCHITECTURE.md): +X east, +Y up, +Z south.
 */

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
const mod = (x, m) => ((x % m) + m) % m;
const sind = (d) => Math.sin(d * D2R);
const cosd = (d) => Math.cos(d * D2R);

/** Kargil sector, DEM centre. Indian Standard Time. */
export const SITE = Object.freeze({ lat: 34.5, lon: 76.09, tz: 5.5 });
/** Summer solstice of the Kargil war. */
export const DEFAULT_DATE = Object.freeze({ year: 1999, month: 6, day: 21 });

/** Julian date of a UTC calendar instant (Gregorian). `hours` may be any real. */
export function julianDate(year, month, day, hours = 0) {
  let y = year, m = month;
  if (m <= 2) { y -= 1; m += 12; }
  const a = Math.floor(y / 100);
  const b = 2 - a + Math.floor(a / 4);
  return Math.floor(365.25 * (y + 4716)) + Math.floor(30.6001 * (m + 1)) + day + b - 1524.5 + hours / 24;
}

/** Julian date of local civil time `hours` on a local calendar date. */
export function julianDateLocal(date, hours, tz = SITE.tz) {
  return julianDate(date.year, date.month, date.day, hours - tz);
}

/** Calendar date {year, month, day, hours} (UTC) of a Julian date. */
export function calendarDate(jd) {
  const z = Math.floor(jd + 0.5);
  const f = jd + 0.5 - z;
  let a = z;
  if (z >= 2299161) {
    const al = Math.floor((z - 1867216.25) / 36524.25);
    a = z + 1 + al - Math.floor(al / 4);
  }
  const b = a + 1524;
  const c = Math.floor((b - 122.1) / 365.25);
  const d = Math.floor(365.25 * c);
  const e = Math.floor((b - d) / 30.6001);
  const day = b - d - Math.floor(30.6001 * e);
  const month = e < 14 ? e - 1 : e - 13;
  const year = month > 2 ? c - 4716 : c - 4715;
  return { year, month, day, hours: f * 24 };
}

/** Obliquity of the ecliptic, degrees. */
export const obliquity = (jd) => 23.439 - 0.0000004 * (jd - 2451545.0);

/** Greenwich mean sidereal time, degrees. */
export function gmst(jd) {
  const d = jd - 2451545.0;
  const t = d / 36525;
  return mod(280.46061837 + 360.98564736629 * d + 0.000387933 * t * t, 360);
}

function eclipticToEquatorial(lambda, beta, eps) {
  const sl = sind(lambda), cl = cosd(lambda), sb = sind(beta), cb = cosd(beta);
  const se = sind(eps), ce = cosd(eps);
  const x = cb * cl;
  const y = cb * sl * ce - sb * se;
  const z = cb * sl * se + sb * ce;
  return { ra: mod(Math.atan2(y, x) * R2D, 360), dec: Math.asin(Math.max(-1, Math.min(1, z))) * R2D };
}

/** Sun: { ra, dec, lambda } in degrees, distance in AU, equation of time in minutes. */
export function sunEquatorial(jd) {
  const d = jd - 2451545.0;
  const L = mod(280.460 + 0.9856474 * d, 360);
  const g = mod(357.528 + 0.9856003 * d, 360);
  const lambda = mod(L + 1.915 * sind(g) + 0.020 * sind(2 * g), 360);
  const eq = eclipticToEquatorial(lambda, 0, obliquity(jd));
  let eot = L - eq.ra;
  if (eot > 180) eot -= 360; else if (eot < -180) eot += 360;
  return { ...eq, lambda, distance: 1.00014 - 0.01671 * cosd(g) - 0.00014 * cosd(2 * g), equationOfTime: eot * 4 };
}

/** Moon (geocentric): { ra, dec, lambda, beta } degrees, parallax degrees, distance km. */
export function moonEquatorial(jd) {
  const t = (jd - 2451545.0) / 36525;
  const lambda = mod(218.32 + 481267.881 * t
    + 6.29 * sind(135.0 + 477198.87 * t) - 1.27 * sind(259.3 - 413335.36 * t)
    + 0.66 * sind(235.7 + 890534.22 * t) + 0.21 * sind(269.9 + 954397.74 * t)
    - 0.19 * sind(357.5 + 35999.05 * t) - 0.11 * sind(186.5 + 966404.03 * t), 360);
  const beta = 5.13 * sind(93.3 + 483202.02 * t) + 0.28 * sind(228.2 + 960400.89 * t)
    - 0.28 * sind(318.3 + 6003.15 * t) - 0.17 * sind(217.6 - 407332.21 * t);
  const parallax = 0.9508 + 0.0518 * cosd(135.0 + 477198.87 * t) + 0.0095 * cosd(259.3 - 413335.36 * t)
    + 0.0078 * cosd(235.7 + 890534.22 * t) + 0.0028 * cosd(269.9 + 954397.74 * t);
  const eq = eclipticToEquatorial(lambda, beta, obliquity(jd));
  return { ...eq, lambda, beta, parallax, distance: 6378.14 / sind(parallax) };
}

/**
 * Equatorial -> horizontal. Returns { elevation, azimuth } in degrees, azimuth
 * from north (0) clockwise through east (90).
 */
export function horizontal(ra, dec, jd, lat = SITE.lat, lon = SITE.lon) {
  const H = gmst(jd) + lon - ra;
  const sinEl = sind(lat) * sind(dec) + cosd(lat) * cosd(dec) * cosd(H);
  const elevation = Math.asin(Math.max(-1, Math.min(1, sinEl))) * R2D;
  const south = cosd(dec) * cosd(H) * sind(lat) - sind(dec) * cosd(lat);
  const east = -cosd(dec) * sind(H);
  return { elevation, azimuth: mod(Math.atan2(east, -south) * R2D, 360) };
}

/** World-space unit vector [x, y, z] for an elevation / azimuth in degrees. */
export function directionFromHorizontal(elevation, azimuth, out = [0, 0, 0]) {
  const ce = cosd(elevation);
  out[0] = sind(azimuth) * ce;
  out[1] = sind(elevation);
  out[2] = -cosd(azimuth) * ce;
  return out;
}

/**
 * Row-major 3x3 matrix taking J2000 equatorial unit vectors
 * (cos dec cos ra, cos dec sin ra, sin dec) to world space, for the star sphere.
 */
export function equatorialToWorld(jd, lat = SITE.lat, lon = SITE.lon, out = new Array(9)) {
  const lst = (gmst(jd) + lon) * D2R;
  const c = Math.cos(lst), s = Math.sin(lst);
  const sl = sind(lat), cl = cosd(lat);
  // rotate about the pole by -LST: x' = c x + s y (toward the meridian), y' = -s x + c y (toward east)
  // world X (east) = y'; world Y (up) = x' cos(lat) + z sin(lat); world Z (south) = x' sin(lat) - z cos(lat)
  out[0] = -s; out[1] = c; out[2] = 0;
  out[3] = c * cl; out[4] = s * cl; out[5] = sl;
  out[6] = c * sl; out[7] = s * sl; out[8] = -cl;
  return out;
}

/**
 * Row-major 3x3 matrix taking J2000 equatorial unit vectors to galactic ones
 * (x toward the galactic centre, z toward the north galactic pole).
 */
export const EQUATORIAL_TO_GALACTIC = Object.freeze([
  -0.0548755604, -0.8734370902, -0.4838350155,
  0.4941094279, -0.4448296300, 0.7469822445,
  -0.8676661490, -0.1980763734, 0.4559837762,
]);

/**
 * Everything the sky needs for one instant.
 *   sun, moon: { elevation, azimuth, ra, dec } (degrees; the moon is topocentric)
 *   moon.phase: illuminated fraction 0..1; moon.waxing; moon.age (0..1, 0 = new, 0.5 = full)
 *   moon.elongation: degrees from the sun
 */
export function skyState(jd, lat = SITE.lat, lon = SITE.lon) {
  const s = sunEquatorial(jd);
  const m = moonEquatorial(jd);
  const sun = { ...s, ...horizontal(s.ra, s.dec, jd, lat, lon) };
  const mh = horizontal(m.ra, m.dec, jd, lat, lon);
  // topocentric parallax lowers the moon by up to a degree near the horizon
  mh.elevation -= m.parallax * cosd(mh.elevation);
  const cosE = sind(s.dec) * sind(m.dec) + cosd(s.dec) * cosd(m.dec) * cosd(s.ra - m.ra);
  const elongation = Math.acos(Math.max(-1, Math.min(1, cosE))) * R2D;
  const age = mod(m.lambda - s.lambda, 360) / 360;
  const moon = { ...m, ...mh, elongation, phase: (1 - cosE) / 2, age, waxing: age < 0.5 };
  return { jd, sun, moon, lst: mod(gmst(jd) + lon, 360) };
}

/**
 * Local civil times (hours) of sunrise, solar noon and sunset on a local date
 * (upper limb with standard refraction: centre at -0.833 degrees). Bisection
 * on the elevation, good to a few seconds. Returns NaN for a polar day/night.
 */
export function sunEvents(date, lat = SITE.lat, lon = SITE.lon, tz = SITE.tz, horizon = -0.833) {
  const el = (h) => {
    const jd = julianDateLocal(date, h, tz);
    const s = sunEquatorial(jd);
    return horizontal(s.ra, s.dec, jd, lat, lon).elevation;
  };
  // solar noon: maximum of the elevation, golden-section search around 12 h local mean time
  let a = 12 - (lon / 15 - tz) - 3, b = a + 6;
  for (let i = 0; i < 50; i++) {
    const m1 = a + (b - a) * 0.382, m2 = a + (b - a) * 0.618;
    if (el(m1) < el(m2)) a = m1; else b = m2;
  }
  const noon = (a + b) / 2;
  const cross = (lo, hi) => {
    if ((el(lo) - horizon) * (el(hi) - horizon) > 0) return NaN;
    const rising = el(hi) > el(lo);
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if ((el(mid) > horizon) === rising) hi = mid; else lo = mid;
    }
    return (lo + hi) / 2;
  };
  return { sunrise: cross(noon - 12, noon), noon, sunset: cross(noon, noon + 12), noonElevation: el(noon) };
}
