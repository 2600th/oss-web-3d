import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_ATMOSPHERE as A, buildTransmittanceLut, buildMultiScatterLut, integrateTransmittance,
  sampleTransmittance, transmittanceUv, transmittanceRMu, skyRadiance, skyAmbient, toHalf,
  horizonMu, distanceToTop, MS_LUT_SIZE,
} from './model.js';

const tLut = buildTransmittanceLut(A);
const msLut = buildMultiScatterLut(A, tLut);

function fromHalf(h) {
  const s = (h & 0x8000) ? -1 : 1;
  const e = (h >> 10) & 31;
  const m = h & 1023;
  if (e === 0) return s * m * 2 ** -24;
  return s * (1 + m / 1024) * 2 ** (e - 15);
}

test('transmittance parametrisation round-trips', () => {
  for (const r of [A.Rg + 0.01, A.Rg + 3, A.Rg + 9, A.Rg + 60]) {
    for (const mu of [1, 0.6, 0.1, 0, Math.max(horizonMu(A, r) + 1e-3, -0.05)]) {
      const [u, v] = transmittanceUv(A, r, mu);
      const [r2, mu2] = transmittanceRMu(A, u, v);
      assert.ok(Math.abs(r2 - r) < 1e-3, `r ${r} -> ${r2}`);
      assert.ok(Math.abs(mu2 - mu) < 2e-3, `mu ${mu} -> ${mu2}`);
    }
  }
});

test('vertical transmittance from sea level matches the analytic optical depth', () => {
  const T = integrateTransmittance(A, A.Rg, 1, 400);
  const tau = (c) => A.rayleigh[c] * A.rayleighH + (A.mieScattering + A.mieAbsorption) * A.mieH + A.ozone[c] * A.ozoneHalfWidth;
  for (let c = 0; c < 3; c++) {
    // Exponential columns truncated at 100 km and curved geometry: allow 2 %.
    assert.ok(Math.abs(T[c] - Math.exp(-tau(c))) < 0.02, `channel ${c}: ${T[c]} vs ${Math.exp(-tau(c))}`);
  }
  assert.ok(T[0] > T[1] && T[1] > T[2], 'red survives better than blue');
});

test('LUT lookup agrees with direct integration', () => {
  for (const h of [0.5, 3, 5.5, 9]) {
    for (const mu of [1, 0.5, 0.15, 0.02]) {
      const a = sampleTransmittance(A, tLut, A.Rg + h, mu);
      const b = integrateTransmittance(A, A.Rg + h, mu, 200);
      for (let c = 0; c < 3; c++) assert.ok(Math.abs(a[c] - b[c]) < 0.012, `h=${h} mu=${mu} c=${c}: ${a[c]} vs ${b[c]}`);
    }
  }
});

test('the planet shadows the sun below the horizon', () => {
  const r = A.Rg + 5;
  assert.deepEqual(sampleTransmittance(A, tLut, r, horizonMu(A, r) - 0.02), [0, 0, 0]);
  assert.ok(sampleTransmittance(A, tLut, r, horizonMu(A, r) + 0.02)[0] > 0);
  assert.ok(distanceToTop(A, r, 1) > 94 && distanceToTop(A, r, 1) < 96);
});

test('multiple scattering LUT is finite, positive and brightest with a high sun', () => {
  const at = (i, j) => msLut[(j * MS_LUT_SIZE + i) * 4 + 2];
  for (let k = 0; k < msLut.length; k++) assert.ok(Number.isFinite(msLut[k]) && msLut[k] >= 0);
  assert.ok(at(MS_LUT_SIZE - 1, 1) > at(MS_LUT_SIZE / 2 + 2, 1), 'high sun > low sun');
  assert.ok(at(MS_LUT_SIZE - 1, 1) > at(2, 1) * 20, 'day >> night');
  assert.ok(at(MS_LUT_SIZE - 1, 1) < 0.2, 'bounded');
});

test('sky at 5 km: blue zenith, brighter and whiter horizon, darker than at sea level', () => {
  const el = 50 * Math.PI / 180;
  const sun = [Math.cos(el), Math.sin(el), 0];
  const zen = skyRadiance(A, tLut, msLut, 5, [0, 1, 0], sun, 48);
  const hor = skyRadiance(A, tLut, msLut, 5, [-0.9999, 0.012, 0], sun, 48);
  const zen0 = skyRadiance(A, tLut, msLut, 0.01, [0, 1, 0], sun, 48);
  assert.ok(zen[2] > zen[0] * 3, `zenith is deep blue: ${zen}`);
  assert.ok(hor[2] > zen[2] * 1.5, `horizon brighter than zenith: ${hor} vs ${zen}`);
  assert.ok(hor[0] / hor[2] > zen[0] / zen[2], 'horizon is less saturated');
  assert.ok(zen[2] < zen0[2], 'thinner air overhead at altitude');
  // Zenith luminance / sun illuminance is a few 1e-2 for a clear sky.
  assert.ok(zen[2] > 0.01 && zen[2] < 0.12, `zenith magnitude ${zen[2]}`);
});

test('sky irradiance is a plausible fraction of the direct sun', () => {
  const el = 50 * Math.PI / 180;
  const amb = skyAmbient(A, tLut, msLut, 4, [Math.cos(el), Math.sin(el), 0]);
  // Diffuse sky / direct normal irradiance is roughly 5-20 % under clear air.
  for (const c of amb.irradiance) assert.ok(c > 0.02 && c < 0.35, `irradiance ${amb.irradiance}`);
  assert.ok(amb.irradiance[2] > amb.irradiance[0]);
});

test('half-float packing round-trips within half precision', () => {
  for (const v of [0, 1, 0.5, 1e-3, 3.25e-5, 0.9997, 12.5, 70000]) {
    const back = fromHalf(toHalf(v));
    if (v > 65504) assert.ok(back <= 65504 && back > 60000);
    else assert.ok(Math.abs(back - v) <= Math.max(v * 1e-3, 1e-7), `${v} -> ${back}`);
  }
});
