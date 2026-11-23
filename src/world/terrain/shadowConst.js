/**
 * Encoding of the shadow-sweep texture (shadowWorker.js -> shadowSweep.js).
 *
 * [ground polish] The texel is a half float holding, in metres, how far the
 * ground lies below the shadow boundary cast toward it (positive = shadowed),
 * clamped to [SHADOW_MIN, SHADOW_MAX]. It was an 8-bit `byte * 0.25 - 16`,
 * which saturated 47.75 m above the ground: anything higher (a unit on a
 * ridge under a low sun, an aircraft in a valley's shadow at dawn) could not
 * be shadowed by the terrain. Half floats keep 0.002 m steps around the
 * terrain's own shadow edge (|v| < 4 m) and still resolve 4 m at 8 km, so the
 * relative error stays under 0.1 % at every height: no bands at any range.
 */
export const SHADOW_MIN = -64;
export const SHADOW_MAX = 8000;
/** @deprecated the 8-bit step; kept so old imports resolve. The texture is in metres now. */
export const SHADOW_STEP = 0.25;

const _f = new Float32Array(1);
const _u = new Uint32Array(_f.buffer);

/** IEEE 754 binary16 bits of `v` (round to nearest even; normals, subnormals, inf). */
export function toHalfBits(v) {
  _f[0] = v;
  const x = _u[0];
  const sign = (x >>> 16) & 0x8000;
  const exp = (x >>> 23) & 0xff;
  let mant = x & 0x7fffff;
  if (exp === 0xff) return sign | 0x7c00 | (mant ? 0x200 : 0); // inf / nan
  let e = exp - 127 + 15;
  if (e >= 0x1f) return sign | 0x7c00; // overflow
  if (e <= 0) {
    if (e < -10) return sign; // underflow to zero
    mant |= 0x800000; // subnormal: implicit bit
    const shift = 14 - e;
    let m = mant >>> shift;
    const rem = mant & ((1 << shift) - 1);
    const half = 1 << (shift - 1);
    if (rem > half || (rem === half && (m & 1))) m++;
    return sign | m;
  }
  let m = mant >>> 13;
  const rem = mant & 0x1fff;
  if (rem > 0x1000 || (rem === 0x1000 && (m & 1))) {
    m++;
    if (m === 0x400) { m = 0; e++; if (e >= 0x1f) return sign | 0x7c00; }
  }
  return sign | (e << 10) | m;
}

/** Float value of binary16 bits (tests, CPU mirrors). */
export function fromHalfBits(h) {
  const s = h & 0x8000 ? -1 : 1;
  const e = (h >>> 10) & 0x1f;
  const m = h & 0x3ff;
  if (e === 0) return s * m * 2 ** -24;
  if (e === 0x1f) return m ? NaN : s * Infinity;
  return s * (1 + m / 1024) * 2 ** (e - 15);
}

/** Sweep value (metres below the boundary) as stored: clamped, binary16 bits. */
export function encodeShadow(v) {
  return toHalfBits(v <= SHADOW_MIN ? SHADOW_MIN : v >= SHADOW_MAX ? SHADOW_MAX : v);
}
