import assert from 'node:assert/strict';
import test from 'node:test';

import {
  TAKRAM_PROFILE_NAMES,
  deriveHimalayanCloudProfile,
  getTakramCloudProfile,
  nearestLayerBoundaryDistance,
  validateTakramProfileScenario,
} from './TakramCloudProfiles.js';

const EXPECTED_REFERENCE_LAYERS = [
  {
    channel: 'r', altitude: 750, height: 650, densityScale: 0.2,
    shapeAmount: 1, shapeDetailAmount: 1, weatherExponent: 1,
    shapeAlteringBias: 0.35, coverageFilterWidth: 0.6, shadow: true,
  },
  {
    channel: 'g', altitude: 1000, height: 1200, densityScale: 0.2,
    shapeAmount: 1, shapeDetailAmount: 1, weatherExponent: 1,
    shapeAlteringBias: 0.35, coverageFilterWidth: 0.6, shadow: true,
  },
  {
    channel: 'b', altitude: 7500, height: 500, densityScale: 0.003,
    shapeAmount: 0.4, shapeDetailAmount: 0, weatherExponent: 1,
    shapeAlteringBias: 0.35, coverageFilterWidth: 0.5, shadow: false,
  },
  { channel: 'a', altitude: 0, height: 0, densityScale: 0, shadow: false },
];

test('reference profile reproduces pinned Takram vanilla cloud guidance', () => {
  const profile = getTakramCloudProfile('takram-reference');

  assert.deepEqual(TAKRAM_PROFILE_NAMES, ['takram-reference', 'takram-himalayan']);
  assert.equal(profile.name, 'takram-reference');
  assert.equal(profile.coverage, 0.4);
  assert.deepEqual(profile.localWeatherRepeat, [100, 100]);
  assert.deepEqual(profile.localWeatherVelocity, [0.001, 0]);
  assert.deepEqual(profile.layers, EXPECTED_REFERENCE_LAYERS);
  assert.equal(Object.isFrozen(profile), true);
  assert.equal(Object.isFrozen(profile.layers), true);
  assert.notStrictEqual(getTakramCloudProfile('takram-reference'), profile,
    'callers receive an independent clone and cannot mutate the source profile');
});

test('Himalayan profile translates only layer altitudes above terrain and camera', () => {
  const context = { terrainMin: 4700, terrainMax: 6300, cameraAltitude: 7235.246 };
  const profile = deriveHimalayanCloudProfile(context);
  const reference = getTakramCloudProfile('takram-reference');

  assert.equal(profile.name, 'takram-himalayan');
  assert.equal(profile.altitudeTranslation.cumulus, 6986.246);
  assert.equal(profile.altitudeTranslation.cirrus, 1986.246);
  assert.deepEqual(
    profile.layers.map(layer => layer.altitude),
    [7736.246, 7986.246, 9486.246, 0],
  );
  for (let index = 0; index < reference.layers.length; index += 1) {
    const { altitude: _referenceAltitude, ...referenceRest } = reference.layers[index];
    const { altitude: _translatedAltitude, ...translatedRest } = profile.layers[index];
    assert.deepEqual(translatedRest, referenceRest);
  }
  assert.equal(profile.coverage, reference.coverage);
  assert.deepEqual(profile.localWeatherRepeat, reference.localWeatherRepeat);
  assert.deepEqual(profile.localWeatherVelocity, reference.localWeatherVelocity);
  assert.ok(profile.layers[0].altitude >= context.terrainMax + 350);
  assert.ok(profile.layers[0].altitude >= context.cameraAltitude + 501);
  assert.ok(profile.layers[2].altitude >= profile.layers[1].altitude + profile.layers[1].height + 300);
});

test('scenario validation reports boundary and terrain eligibility without hiding failures', () => {
  const profile = deriveHimalayanCloudProfile({
    terrainMin: 4700,
    terrainMax: 6300,
    cameraAltitude: 7235.246,
  });
  const valid = validateTakramProfileScenario(profile, {
    terrainMin: 4700,
    terrainMax: 6300,
    cameraAltitude: 7235.246,
  });
  const boundaryFailure = validateTakramProfileScenario(profile, {
    terrainMin: 4700,
    terrainMax: 6300,
    cameraAltitude: profile.layers[0].altitude - 100,
  });

  assert.equal(nearestLayerBoundaryDistance(profile.layers, 7235.246), 501);
  assert.deepEqual(valid, {
    eligible: true,
    nearestBoundaryDistance: 501,
    reasons: [],
  });
  assert.equal(boundaryFailure.eligible, false);
  assert.ok(boundaryFailure.reasons.includes('camera-near-zero-density-boundary'));
  assert.equal(boundaryFailure.nearestBoundaryDistance, 100);
});

test('Himalayan clearance stays above 500 m after representative WGS84 reconstruction drift', () => {
  const context = { terrainMin: 4700, terrainMax: 6300, cameraAltitude: 7235.246 };
  const profile = deriveHimalayanCloudProfile(context);
  // The production geodetic reconstruction can raise a local-y camera by a
  // sub-millimetre equivalent. Preserve a deterministic one-metre margin.
  const reconstructedAltitude = context.cameraAltitude + 0.0004374;

  assert.ok(nearestLayerBoundaryDistance(profile.layers, reconstructedAltitude) >= 500);
  assert.equal(validateTakramProfileScenario(profile, {
    ...context,
    cameraAltitude: reconstructedAltitude,
  }).eligible, true);
});

test('profile selection rejects unknown names and missing Himalayan context', () => {
  assert.throws(() => getTakramCloudProfile('storm'), /Unknown Takram cloud profile/);
  assert.throws(() => getTakramCloudProfile('takram-himalayan'), /profile context/);
  assert.throws(
    () => deriveHimalayanCloudProfile({ terrainMin: 0, terrainMax: Number.NaN, cameraAltitude: 10 }),
    /finite/,
  );
});
