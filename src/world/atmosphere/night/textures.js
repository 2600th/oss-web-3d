/**
 * Procedural night-sky textures, generated on the CPU at start-up (pure JS, no
 * three import; original to this project, no third-party image data).
 *
 *   milkyWay(w, h)  RGBA8 equirectangular map in galactic coordinates
 *                   (u = longitude / 360 + 0.5, v = latitude / 180 + 0.5):
 *                   the disc, the bulge toward Sagittarius, the Great Rift
 *                   and the Cygnus / Carina star clouds, as fbm on the sphere.
 *   moonAlbedo(n)   R8 disc albedo: bright highlands, dark maria, a few rays.
 */

function hash3(x, y, z) {
  let h = (x * 374761393 + y * 668265263 + z * 2147483647) | 0;
  h = (h ^ (h >>> 13)) * 1274126177 | 0;
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}

const fade = (t) => t * t * (3 - 2 * t);

export function valueNoise3(x, y, z) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const u = fade(x - xi), v = fade(y - yi), w = fade(z - zi);
  const l = (a, b, t) => a + (b - a) * t;
  return l(
    l(l(hash3(xi, yi, zi), hash3(xi + 1, yi, zi), u), l(hash3(xi, yi + 1, zi), hash3(xi + 1, yi + 1, zi), u), v),
    l(l(hash3(xi, yi, zi + 1), hash3(xi + 1, yi, zi + 1), u), l(hash3(xi, yi + 1, zi + 1), hash3(xi + 1, yi + 1, zi + 1), u), v),
    w,
  );
}

export function fbm3(x, y, z, octaves = 5, gain = 0.5) {
  let a = 0.5, s = 0, n = 0;
  for (let i = 0; i < octaves; i++) {
    s += a * valueNoise3(x, y, z);
    n += a;
    x = x * 2.03 + 17.1; y = y * 2.03 + 3.7; z = z * 2.03 + 9.2;
    a *= gain;
  }
  return s / n;
}

const D2R = Math.PI / 180;
const gauss = (x, s) => Math.exp(-(x * x) / (s * s));
const wrap180 = (d) => ((d + 540) % 360) - 180;

/** Milky Way brightness 0..1 at galactic longitude / latitude (degrees). */
export function milkyWayAt(l, b) {
  const lr = l * D2R, br = b * D2R;
  const x = Math.cos(br) * Math.cos(lr), y = Math.cos(br) * Math.sin(lr), z = Math.sin(br);
  const lc = wrap180(l); // 0 at the galactic centre
  // the band: thin disc everywhere, fat bulge within ~25 degrees of the centre
  const warp = (fbm3(x * 3 + 5, y * 3, z * 3, 3) - 0.5) * 7;
  const bb = b - 1.2 * Math.sin(lr) + warp;
  const along = 0.3 + 0.7 * gauss(lc, 75) + 0.22 * gauss(wrap180(l - 78), 16) + 0.2 * gauss(wrap180(l + 75), 18); // + Cygnus, Carina
  const disc = gauss(bb, 7.5) * along;
  const halo = gauss(bb, 20) * 0.22 * along;
  const bulge = gauss(lc, 20) * gauss(b, 13) * 0.9;
  // star clouds: mid-frequency clumps that break the band up
  const clump = 0.45 + 1.1 * Math.pow(fbm3(x * 9, y * 9, z * 9, 5), 1.6);
  let v = (disc + halo) * clump + bulge * (0.7 + 0.5 * fbm3(x * 14, y * 14, z * 14, 4));
  // dust: the Great Rift from the centre up through Aquila to Cygnus, plus the Coalsack and filaments
  const riftB = 1.5 + 4.5 * Math.sin((lc - 10) * D2R * 2.2);
  const riftW = lc > -25 && lc < 95 ? 1 : gauss(lc < -25 ? lc + 25 : lc - 95, 12);
  const dustN = fbm3(x * 11 + 40, y * 11, z * 11 + 7, 5);
  const rift = gauss(b - riftB, 3.2) * riftW * (0.45 + 1.0 * dustN);
  const filaments = Math.max(0, fbm3(x * 26 + 3, y * 26 + 11, z * 26, 4) - 0.52) * 3.2 * gauss(b, 12);
  const coalsack = gauss(wrap180(l + 57), 3.5) * gauss(b + 1, 3);
  v *= 1 - Math.min(0.88, rift * 0.95 + filaments * 0.6 + coalsack * 0.8);
  return Math.max(0, v);
}

export function milkyWay(w = 768, h = 384) {
  const data = new Uint8Array(w * h * 4);
  for (let j = 0; j < h; j++) {
    const b = ((j + 0.5) / h - 0.5) * 180;
    for (let i = 0; i < w; i++) {
      const l = ((i + 0.5) / w - 0.5) * 360;
      const v = Math.min(1, milkyWayAt(l, b) * 0.95);
      // warm, old stars in the bulge; cooler, younger arms
      const warm = gauss(wrap180(l), 30) * gauss(b, 16);
      const o = (j * w + i) * 4;
      const g = Math.pow(v, 0.9);
      data[o] = Math.round(255 * Math.min(1, g * (0.86 + 0.14 * warm)));
      data[o + 1] = Math.round(255 * Math.min(1, g * (0.9 + 0.02 * warm)));
      data[o + 2] = Math.round(255 * Math.min(1, g * (1.0 - 0.22 * warm)));
      data[o + 3] = 255;
    }
  }
  return { data, width: w, height: h };
}

/** Lunar disc albedo, n x n, 0..255. Maria sit in the upper left like the real near side. */
export function moonAlbedo(n = 128) {
  const data = new Uint8Array(n * n);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = (i + 0.5) / n * 2 - 1, y = (j + 0.5) / n * 2 - 1;
      const r2 = x * x + y * y;
      const z = Math.sqrt(Math.max(0, 1 - r2));
      const m = fbm3(x * 2.1 + 3.3, y * 2.1 + 1.7, z * 2.1, 4);
      const where = gauss(x + 0.25, 0.75) * gauss(y - 0.3, 0.7); // maria cluster north-west
      const mare = Math.min(1, Math.max(0, (m - 0.5 + 0.2 * where) * 7)) * (0.35 + 0.65 * where);
      const detail = fbm3(x * 9 + 8, y * 9, z * 9, 4) - 0.5;
      // Tycho-like ray crater in the south
      const cx = x - 0.12, cy = y + 0.62;
      const ray = gauss(Math.hypot(cx, cy), 0.07) * 0.5;
      const a = 0.92 - 0.42 * mare + 0.16 * detail + ray;
      data[j * n + i] = Math.round(255 * Math.min(1, Math.max(0.2, a)));
    }
  }
  return { data, width: n, height: n };
}

/** Star colour (linear RGB, max component 1) from a B-V index. */
const BV_TABLE = [
  [-0.4, 0.55, 0.66, 1.0], [-0.2, 0.66, 0.76, 1.0], [0.0, 0.8, 0.86, 1.0], [0.3, 0.96, 0.96, 1.0],
  [0.6, 1.0, 0.94, 0.84], [1.0, 1.0, 0.82, 0.62], [1.5, 1.0, 0.68, 0.42], [2.0, 1.0, 0.56, 0.28],
];
export function starColor(bv, out = [1, 1, 1]) {
  const t = BV_TABLE;
  if (bv <= t[0][0]) { out[0] = t[0][1]; out[1] = t[0][2]; out[2] = t[0][3]; return out; }
  for (let i = 1; i < t.length; i++) {
    if (bv <= t[i][0]) {
      const f = (bv - t[i - 1][0]) / (t[i][0] - t[i - 1][0]);
      for (let k = 0; k < 3; k++) out[k] = t[i - 1][k + 1] + (t[i][k + 1] - t[i - 1][k + 1]) * f;
      return out;
    }
  }
  const l = t[t.length - 1];
  out[0] = l[1]; out[1] = l[2]; out[2] = l[3];
  return out;
}

/** Decode public/assets/sky/stars.bin (see tools/sky/build-stars.mjs). */
export function decodeStars(buffer, max = Infinity) {
  const dv = new DataView(buffer);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== 'STR1') throw new Error('stars.bin: bad magic');
  const count = Math.min(dv.getUint32(4, true), max);
  const dir = new Float32Array(count * 3);
  const mag = new Float32Array(count);
  const bv = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const o = 8 + i * 6;
    const ra = dv.getUint16(o, true) / 65536 * 2 * Math.PI;
    const dec = dv.getInt16(o + 2, true) / 32767 * Math.PI / 2;
    dir[i * 3] = Math.cos(dec) * Math.cos(ra);
    dir[i * 3 + 1] = Math.cos(dec) * Math.sin(ra);
    dir[i * 3 + 2] = Math.sin(dec);
    mag[i] = dv.getUint8(o + 4) / 25 - 2;
    bv[i] = dv.getUint8(o + 5) / 100 - 0.5;
  }
  return { count, dir, mag, bv };
}
