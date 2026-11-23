/**
 * Physical atmosphere model, pure JS (no three import, so it is unit-testable in
 * node and shared by CPU and GPU).
 *
 * Follows Hillaire 2020, "A Scalable and Production Ready Sky and Atmosphere
 * Rendering Technique" (EGSR), with Bruneton's transmittance parametrisation:
 *   - transmittance LUT (r, mu) -> T to the top of the atmosphere
 *   - multiple-scattering LUT (muS, r) -> isotropic infinite-order term Psi_ms
 * Both depend only on the medium, not on sun or camera, so they are built once on
 * the CPU (about 100 ms) and uploaded as textures; the per-frame sky-view and
 * aerial-perspective LUTs are GPU passes that sample them (Atmosphere.js).
 *
 * Units: kilometres, per-kilometre coefficients. r is the distance from the planet
 * centre, mu the cosine of the angle between a ray and the local zenith.
 */

export const DEFAULT_ATMOSPHERE = Object.freeze({
  Rg: 6360,
  Rt: 6460,
  rayleigh: [5.802e-3, 13.558e-3, 33.1e-3],
  rayleighH: 8,
  mieScattering: 3.996e-3,
  mieAbsorption: 0.444e-3,
  mieH: 1.2,
  mieG: 0.8,
  /** Multiplies Mie density: haze. 1 = clean continental air. */
  haze: 1,
  ozone: [0.65e-3, 1.881e-3, 0.085e-3],
  ozoneCentre: 25,
  ozoneHalfWidth: 15,
  groundAlbedo: 0.3,
});

export const T_LUT_W = 256;
export const T_LUT_H = 64;
export const MS_LUT_SIZE = 32;

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

/** Extinction and scattering at altitude h (km). Writes 3+3 values into out. */
export function medium(a, h, out) {
  const dR = Math.exp(-h / a.rayleighH);
  const dM = Math.exp(-h / a.mieH) * a.haze;
  const dO = Math.max(0, 1 - Math.abs(h - a.ozoneCentre) / a.ozoneHalfWidth);
  const mS = a.mieScattering * dM;
  const mE = (a.mieScattering + a.mieAbsorption) * dM;
  for (let c = 0; c < 3; c++) {
    const rS = a.rayleigh[c] * dR;
    out[c] = rS + mE + a.ozone[c] * dO; // extinction
    out[3 + c] = rS + mS; // scattering (Rayleigh + Mie)
    out[6 + c] = rS; // Rayleigh scattering alone
  }
  out[9] = mS;
  return out;
}

export function distanceToTop(a, r, mu) {
  const disc = r * r * (mu * mu - 1) + a.Rt * a.Rt;
  return Math.max(0, -r * mu + Math.sqrt(Math.max(0, disc)));
}

export function distanceToGround(a, r, mu) {
  const disc = r * r * (mu * mu - 1) + a.Rg * a.Rg;
  if (disc < 0 || mu >= 0) return -1;
  return Math.max(0, -r * mu - Math.sqrt(disc));
}

/** Cosine of the zenith angle of the geometric horizon seen from radius r. */
export function horizonMu(a, r) {
  return -Math.sqrt(Math.max(0, 1 - (a.Rg / r) * (a.Rg / r)));
}

const texCoord = (x, n) => 0.5 / n + x * (1 - 1 / n);
const unitRange = (u, n) => clamp((u - 0.5 / n) / (1 - 1 / n), 0, 1);

/** Bruneton 2017 transmittance mapping (r, mu) -> (u, v), texel-centre corrected. */
export function transmittanceUv(a, r, mu, out = [0, 0]) {
  const H = Math.sqrt(a.Rt * a.Rt - a.Rg * a.Rg);
  const rho = Math.sqrt(Math.max(0, r * r - a.Rg * a.Rg));
  const d = distanceToTop(a, r, mu);
  const dMin = a.Rt - r;
  const dMax = rho + H;
  out[0] = texCoord(clamp((d - dMin) / (dMax - dMin), 0, 1), T_LUT_W);
  out[1] = texCoord(rho / H, T_LUT_H);
  return out;
}

export function transmittanceRMu(a, u, v, out = [0, 0]) {
  const H = Math.sqrt(a.Rt * a.Rt - a.Rg * a.Rg);
  const rho = H * unitRange(v, T_LUT_H);
  const r = Math.sqrt(rho * rho + a.Rg * a.Rg);
  const dMin = a.Rt - r;
  const dMax = rho + H;
  const d = dMin + unitRange(u, T_LUT_W) * (dMax - dMin);
  out[0] = r;
  out[1] = d === 0 ? 1 : clamp((H * H - rho * rho - d * d) / (2 * r * d), -1, 1);
  return out;
}

/** Transmittance from (r, mu) to the top of the atmosphere by direct integration. */
export function integrateTransmittance(a, r, mu, steps = 40, out = [0, 0, 0]) {
  const d = distanceToTop(a, r, mu);
  const dt = d / steps;
  const m = new Float64Array(10);
  let o0 = 0, o1 = 0, o2 = 0;
  for (let i = 0; i <= steps; i++) {
    const t = i * dt;
    const ri = Math.sqrt(t * t + 2 * r * mu * t + r * r);
    medium(a, Math.max(0, ri - a.Rg), m);
    const w = i === 0 || i === steps ? 0.5 : 1;
    o0 += m[0] * w; o1 += m[1] * w; o2 += m[2] * w;
  }
  out[0] = Math.exp(-o0 * dt); out[1] = Math.exp(-o1 * dt); out[2] = Math.exp(-o2 * dt);
  return out;
}

/** Float32 RGBA transmittance LUT, T_LUT_W x T_LUT_H. */
export function buildTransmittanceLut(a) {
  const data = new Float32Array(T_LUT_W * T_LUT_H * 4);
  const rm = [0, 0];
  const T = [0, 0, 0];
  for (let j = 0; j < T_LUT_H; j++) {
    for (let i = 0; i < T_LUT_W; i++) {
      transmittanceRMu(a, (i + 0.5) / T_LUT_W, (j + 0.5) / T_LUT_H, rm);
      integrateTransmittance(a, rm[0], rm[1], 40, T);
      const o = (j * T_LUT_W + i) * 4;
      data[o] = T[0]; data[o + 1] = T[1]; data[o + 2] = T[2]; data[o + 3] = 1;
    }
  }
  return data;
}

function bilinear(data, w, h, u, v, out) {
  const x = clamp(u * w - 0.5, 0, w - 1);
  const y = clamp(v * h - 0.5, 0, h - 1);
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, w - 1), y1 = Math.min(y0 + 1, h - 1);
  const fx = x - x0, fy = y - y0;
  const a = (y0 * w + x0) * 4, b = (y0 * w + x1) * 4, c = (y1 * w + x0) * 4, d = (y1 * w + x1) * 4;
  for (let k = 0; k < 3; k++) {
    out[k] = (data[a + k] * (1 - fx) + data[b + k] * fx) * (1 - fy) + (data[c + k] * (1 - fx) + data[d + k] * fx) * fy;
  }
  return out;
}

const _uv = [0, 0];

/** Transmittance to the sun from (r, muS), zero when the planet is in the way. */
export function sampleTransmittance(a, lut, r, mu, out = [0, 0, 0]) {
  const rr = clamp(r, a.Rg + 1e-4, a.Rt);
  // Soft terminator over ~0.6 degrees so the planet's shadow edge does not alias.
  const vis = clamp((mu - horizonMu(a, rr)) / 0.01 + 0.5, 0, 1);
  if (vis <= 0) { out[0] = out[1] = out[2] = 0; return out; }
  transmittanceUv(a, rr, mu, _uv);
  bilinear(lut, T_LUT_W, T_LUT_H, _uv[0], _uv[1], out);
  out[0] *= vis; out[1] *= vis; out[2] *= vis;
  return out;
}

/** MS LUT coordinates: u from the sun zenith cosine, v from altitude. */
export function multiScatterUv(a, r, muS, out = [0, 0]) {
  out[0] = texCoord(clamp(muS * 0.5 + 0.5, 0, 1), MS_LUT_SIZE);
  out[1] = texCoord(clamp((r - a.Rg) / (a.Rt - a.Rg), 0, 1), MS_LUT_SIZE);
  return out;
}

/**
 * Hillaire's multiple-scattering LUT: for each (muS, altitude) integrate
 * second-order scattering L2 and the transfer factor f_ms over the sphere with an
 * isotropic phase function; Psi = L2 / (1 - f_ms) is the infinite-order sum.
 */
export function buildMultiScatterLut(a, tLut, { dirs = 8, steps = 20 } = {}) {
  const N = MS_LUT_SIZE;
  const data = new Float32Array(N * N * 4);
  const m = new Float64Array(10);
  const Ts = [0, 0, 0];
  const iso = 1 / (4 * Math.PI);
  const nDirs = dirs * dirs;
  for (let j = 0; j < N; j++) {
    const r = a.Rg + clamp(unitRange((j + 0.5) / N, N), 0, 1) * (a.Rt - a.Rg) * 0.9999 + 0.001;
    for (let i = 0; i < N; i++) {
      const muS = unitRange((i + 0.5) / N, N) * 2 - 1;
      const sx = Math.sqrt(Math.max(0, 1 - muS * muS));
      const L2 = [0, 0, 0];
      const F = [0, 0, 0];
      for (let di = 0; di < dirs; di++) {
        for (let dj = 0; dj < dirs; dj++) {
          const cosT = 1 - 2 * (di + 0.5) / dirs;
          const sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT));
          const phi = 2 * Math.PI * (dj + 0.5) / dirs;
          const dx = sinT * Math.cos(phi), dy = cosT, dz = sinT * Math.sin(phi);
          const tG = distanceToGround(a, r, dy);
          const tMax = tG >= 0 ? tG : distanceToTop(a, r, dy);
          const dt = tMax / steps;
          const T = [1, 1, 1];
          for (let s = 0; s < steps; s++) {
            const t = (s + 0.3) * dt;
            const px = dx * t, py = r + dy * t, pz = dz * t;
            const pr = Math.sqrt(px * px + py * py + pz * pz);
            medium(a, Math.max(0, pr - a.Rg), m);
            const muSp = (px * sx + py * muS) / pr;
            sampleTransmittance(a, tLut, pr, muSp, Ts);
            for (let c = 0; c < 3; c++) {
              const ext = Math.max(m[c], 1e-9);
              const stepT = Math.exp(-ext * dt);
              const integ = (1 - stepT) / ext;
              L2[c] += T[c] * m[3 + c] * Ts[c] * iso * integ;
              F[c] += T[c] * m[3 + c] * integ;
              T[c] *= stepT;
            }
          }
          if (tG >= 0) {
            const gx = dx * tG, gy = r + dy * tG, gz = dz * tG;
            const gr = Math.sqrt(gx * gx + gy * gy + gz * gz);
            const nl = Math.max(0, (gx * sx + gy * muS) / gr);
            sampleTransmittance(a, tLut, a.Rg + 1e-3, nl, Ts);
            for (let c = 0; c < 3; c++) L2[c] += T[c] * Ts[c] * nl * a.groundAlbedo / Math.PI;
          }
        }
      }
      const o = (j * N + i) * 4;
      for (let c = 0; c < 3; c++) {
        const l = L2[c] / nDirs;
        const f = F[c] / nDirs;
        data[o + c] = l / (1 - Math.min(f, 0.999));
      }
      data[o + 3] = 1;
    }
  }
  return data;
}

export const rayleighPhase = (c) => (3 / (16 * Math.PI)) * (1 + c * c);

/** Cornette-Shanks phase function. */
export function miePhase(c, g) {
  const g2 = g * g;
  return (3 / (8 * Math.PI)) * ((1 - g2) * (1 + c * c)) / ((2 + g2) * Math.pow(Math.max(1e-4, 1 + g2 - 2 * g * c), 1.5));
}

/**
 * Sky radiance per unit solar irradiance seen from altitude h (km) along `dir`
 * (unit, y up), sun direction `sun`. The same integral the GPU sky-view LUT does;
 * used on the CPU for ambient colours and in tests.
 */
export function skyRadiance(a, tLut, msLut, hKm, dir, sun, steps = 24, out = [0, 0, 0]) {
  const r = a.Rg + Math.max(hKm, 1e-3);
  const tG = distanceToGround(a, r, dir[1]);
  const tMax = tG >= 0 ? tG : distanceToTop(a, r, dir[1]);
  const dt = tMax / steps;
  const cosV = dir[0] * sun[0] + dir[1] * sun[1] + dir[2] * sun[2];
  const pR = rayleighPhase(cosV);
  const pM = miePhase(cosV, a.mieG);
  const m = new Float64Array(10);
  const Ts = [0, 0, 0];
  const ms = [0, 0, 0];
  const T = [1, 1, 1];
  out[0] = out[1] = out[2] = 0;
  for (let s = 0; s < steps; s++) {
    const t = (s + 0.3) * dt;
    const px = dir[0] * t, py = r + dir[1] * t, pz = dir[2] * t;
    const pr = Math.sqrt(px * px + py * py + pz * pz);
    medium(a, Math.max(0, pr - a.Rg), m);
    const muS = (px * sun[0] + py * sun[1] + pz * sun[2]) / pr;
    sampleTransmittance(a, tLut, pr, muS, Ts);
    multiScatterUv(a, pr, muS, _uv);
    bilinear(msLut, MS_LUT_SIZE, MS_LUT_SIZE, _uv[0], _uv[1], ms);
    for (let c = 0; c < 3; c++) {
      const ext = Math.max(m[c], 1e-9);
      const stepT = Math.exp(-ext * dt);
      const S = (m[6 + c] * pR + m[9] * pM) * Ts[c] + m[3 + c] * ms[c];
      out[c] += T[c] * S * (1 - stepT) / ext;
      T[c] *= stepT;
    }
  }
  return out;
}

/**
 * Cosine-weighted irradiance from the sky hemisphere (per unit solar irradiance),
 * plus plain averages of the upper sky and of a band near the horizon.
 */
export function skyAmbient(a, tLut, msLut, hKm, sun) {
  const irradiance = [0, 0, 0];
  const zenith = [0, 0, 0];
  const horizon = [0, 0, 0];
  const L = [0, 0, 0];
  const nEl = 4, nAz = 8;
  let wSum = 0, zN = 0, hN = 0;
  for (let e = 0; e < nEl; e++) {
    const cosZ = (e + 0.5) / nEl; // uniform in cos(zenith) -> uniform solid angle
    const sinZ = Math.sqrt(1 - cosZ * cosZ);
    for (let k = 0; k < nAz; k++) {
      const phi = 2 * Math.PI * (k + 0.5) / nAz;
      skyRadiance(a, tLut, msLut, hKm, [sinZ * Math.cos(phi), cosZ, sinZ * Math.sin(phi)], sun, 16, L);
      for (let c = 0; c < 3; c++) {
        irradiance[c] += L[c] * cosZ;
        if (e >= nEl / 2) zenith[c] += L[c]; else horizon[c] += L[c];
      }
      wSum += 1;
      if (e >= nEl / 2) zN++; else hN++;
    }
  }
  // Uniform hemisphere sampling: E = (2 pi / N) * sum(L cos).
  for (let c = 0; c < 3; c++) {
    irradiance[c] *= (2 * Math.PI) / wSum;
    zenith[c] /= zN;
    horizon[c] /= hN;
  }
  return { irradiance, zenith, horizon };
}

/** Float32 -> IEEE half, for uploading the LUTs as filterable RGBA16F. */
export function toHalf(v) {
  _f32[0] = v;
  const x = _u32[0];
  const sign = (x >> 16) & 0x8000;
  let exp = ((x >> 23) & 0xff) - 112;
  const mant = x & 0x7fffff;
  if (exp <= 0) {
    if (exp < -10) return sign;
    const m = (mant | 0x800000) >> (1 - exp);
    return sign | ((m + 0x1000) >> 13);
  }
  if (exp >= 31) return sign | 0x7bff; // clamp, never emit inf
  return (sign | (exp << 10) | (mant >> 13)) + ((mant & 0x1000) ? 1 : 0);
}
const _f32 = new Float32Array(1);
const _u32 = new Uint32Array(_f32.buffer);

export function toHalfArray(f32) {
  const out = new Uint16Array(f32.length);
  for (let i = 0; i < f32.length; i++) out[i] = toHalf(f32[i]);
  return out;
}
