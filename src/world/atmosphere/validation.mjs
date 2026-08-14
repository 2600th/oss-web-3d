import assert from 'node:assert/strict';
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

near(ozoneDensity(ATM.ozoneCenterKm), 1, 1e-7, 'ozone peaks at its layer centre');
near(ozoneDensity(ATM.ozoneCenterKm - ATM.ozoneHalfWidthKm), 0, 1e-7, 'ozone tent lower edge');
near(ozoneDensity(ATM.ozoneCenterKm + ATM.ozoneHalfWidthKm), 0, 1e-7, 'ozone tent upper edge');

const sea = mediumAtAltitude(0);
const high = mediumAtAltitude(8);
assert.ok(high.rayleighDensity < sea.rayleighDensity, 'Rayleigh density falls with altitude');
assert.ok(high.mieDensity < high.rayleighDensity, 'aerosol density falls faster than molecular density');

near(
  distanceToAtmosphereBoundary(ATM.groundRadiusKm, 1),
  ATM.topRadiusKm - ATM.groundRadiusKm,
  1e-7,
  'vertical top-boundary distance',
);
near(distanceToGroundBoundary(ATM.groundRadiusKm + 1, -1), 1, 1e-7, 'vertical ground distance');
assert.equal(distanceToGroundBoundary(ATM.groundRadiusKm + 1, 1), Infinity);

const lowSun = sunTransmittance(4500, 0.15);
const highSun = sunTransmittance(4500, 0.8);
assert.ok(highSun.every((value, i) => value > lowSun[i]), 'higher sun has less atmospheric extinction');
assert.ok(highSun[0] > highSun[2], 'molecular extinction removes more blue than red from direct sun');

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

const irradianceBody = ATMOSPHERE_GLSL.match(/vec3 atm_skyIrradiance[\s\S]*?\n}/)?.[0] ?? '';
assert.match(irradianceBody, /dot\(uSunDir, N\)/, 'irradiance probes are oriented relative to the sun');
assert.ok(
  (irradianceBody.match(/atm_skyColor\(/g) ?? []).length >= 5,
  'irradiance integrates multiple directions over the oriented hemisphere',
);

assert.match(ATMOSPHERE_GLSL, /uAtmLutBlend/, 'dynamic LUT replacement is cross-faded');

console.log('Atmosphere physical-model validation passed.');
