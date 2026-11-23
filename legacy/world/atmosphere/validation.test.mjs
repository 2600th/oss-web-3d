/**
 * Physical-model contracts for the atmosphere.
 *
 * These are the properties the Hillaire model has to hold for the sky to be a
 * simulation rather than a gradient: the ozone tent peaks where it should, both
 * media thin out with altitude, the ray-sphere boundaries agree with their
 * closed forms, and a low sun really does lose more blue than red on the way in.
 *
 * They were written as a standalone script of top-level asserts — `node
 * src/world/atmosphere/validation.mjs`, printing a line and exiting 0. Nothing
 * ran it. It was not in package.json, not in `node --test "src/**\/*.test.mjs"`,
 * and no module imported it, so twelve real contracts had been silently unchecked
 * since they were written. The assertions are unchanged; they are just in the
 * suite now.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { ATMOSPHERE_GLSL } from '../atmosphere.glsl.js';
import {
  ATM,
  distanceToAtmosphereBoundary,
  distanceToGroundBoundary,
  mediumAtAltitude,
  ozoneDensity,
  sunTransmittance,
} from './constants.js';

const near = (actual, expected, tolerance, message) => {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: ${actual}`);
};

test('ozone is a tent function peaking at its layer centre', () => {
  near(ozoneDensity(ATM.ozoneCenterKm), 1, 1e-7, 'ozone peaks at its layer centre');
  near(ozoneDensity(ATM.ozoneCenterKm - ATM.ozoneHalfWidthKm), 0, 1e-7, 'ozone tent lower edge');
  near(ozoneDensity(ATM.ozoneCenterKm + ATM.ozoneHalfWidthKm), 0, 1e-7, 'ozone tent upper edge');
});

test('both media thin with altitude, and aerosol faster than molecular', () => {
  const sea = mediumAtAltitude(0);
  const high = mediumAtAltitude(8);
  assert.ok(high.rayleighDensity < sea.rayleighDensity, 'Rayleigh density falls with altitude');
  assert.ok(
    high.mieDensity < high.rayleighDensity,
    'aerosol density falls faster than molecular density',
  );
});

test('ray-sphere boundaries match their closed forms', () => {
  near(
    distanceToAtmosphereBoundary(ATM.groundRadiusKm, 1),
    ATM.topRadiusKm - ATM.groundRadiusKm,
    1e-7,
    'vertical top-boundary distance',
  );
  near(distanceToGroundBoundary(ATM.groundRadiusKm + 1, -1), 1, 1e-7, 'vertical ground distance');
  assert.equal(distanceToGroundBoundary(ATM.groundRadiusKm + 1, 1), Infinity);
});

test('a lower sun loses more light, and more blue than red', () => {
  const lowSun = sunTransmittance(4500, 0.15);
  const highSun = sunTransmittance(4500, 0.8);
  assert.ok(
    highSun.every((value, i) => value > lowSun[i]),
    'higher sun has less atmospheric extinction',
  );
  assert.ok(
    highSun[0] > highSun[2],
    'molecular extinction removes more blue than red from direct sun',
  );
});

test('the LUT cache states its render-target capability policy and cross-fade', async () => {
  const lutModule = await import('./lut.js');
  assert.equal(
    typeof lutModule.selectAtmosphereRenderTargetType,
    'function',
    'atmosphere cache exposes its render-target capability policy',
  );
  assert.equal(lutModule.selectAtmosphereRenderTargetType(true), THREE.HalfFloatType);
  assert.equal(lutModule.selectAtmosphereRenderTargetType(false), THREE.UnsignedByteType);
  assert.equal(lutModule.lutBlendFactor(0, 280), 0);
  assert.equal(lutModule.lutBlendFactor(280, 280), 1);
});

test('sky irradiance is integrated over a sun-oriented hemisphere', () => {
  const irradianceBody = ATMOSPHERE_GLSL.match(/vec3 atm_skyIrradiance[\s\S]*?\n}/)?.[0] ?? '';
  assert.match(irradianceBody, /dot\(uSunDir, N\)/, 'irradiance probes are oriented relative to the sun');
  assert.ok(
    (irradianceBody.match(/atm_skyColor\(/g) ?? []).length >= 5,
    'irradiance integrates multiple directions over the oriented hemisphere',
  );
  assert.match(ATMOSPHERE_GLSL, /uAtmLutBlend/, 'dynamic LUT replacement is cross-faded');
});
