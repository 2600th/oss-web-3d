const REFERENCE_LAYERS = [
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

const REFERENCE_PROFILE = {
  name: 'takram-reference',
  haze: true,
  coverage: 0.4,
  localWeatherRepeat: [100, 100],
  localWeatherVelocity: [0.001, 0],
  altitudeTranslation: { cumulus: 0, cirrus: 0 },
  layers: REFERENCE_LAYERS,
};

const HIMALAYAN_CAMERA_CLEARANCE = 501;

function deepFreeze(value) {
  if (value == null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function cloneProfile(profile) {
  return deepFreeze({
    ...profile,
    localWeatherRepeat: [...profile.localWeatherRepeat],
    localWeatherVelocity: [...profile.localWeatherVelocity],
    altitudeTranslation: { ...profile.altitudeTranslation },
    layers: profile.layers.map(layer => ({ ...layer })),
  });
}

function requireFiniteContext(context) {
  const values = [context?.terrainMin, context?.terrainMax, context?.cameraAltitude];
  if (!values.every(Number.isFinite)) {
    throw new TypeError('Takram Himalayan profile context values must be finite');
  }
  if (context.terrainMin > context.terrainMax) {
    throw new RangeError('Takram Himalayan terrainMin must not exceed terrainMax');
  }
}

deepFreeze(REFERENCE_PROFILE);

export const TAKRAM_PROFILE_NAMES = Object.freeze([
  'takram-reference',
  'takram-himalayan',
]);

export function deriveHimalayanCloudProfile(context) {
  requireFiniteContext(context);
  const cumulusOffset = Math.round(Math.max(
    context.terrainMax + 350 - REFERENCE_LAYERS[0].altitude,
    context.cameraAltitude + HIMALAYAN_CAMERA_CLEARANCE - REFERENCE_LAYERS[0].altitude,
  ) * 1000) / 1000;
  const translatedGreenTop = REFERENCE_LAYERS[1].altitude
    + cumulusOffset
    + REFERENCE_LAYERS[1].height;
  const cirrusOffset = Math.round(Math.max(
    0,
    translatedGreenTop + 300 - REFERENCE_LAYERS[2].altitude,
  ) * 1000) / 1000;
  const layers = REFERENCE_LAYERS.map((layer, index) => ({
    ...layer,
    altitude: index < 2
      ? layer.altitude + cumulusOffset
      : index === 2
        ? layer.altitude + cirrusOffset
        : layer.altitude,
  }));
  return cloneProfile({
    ...REFERENCE_PROFILE,
    name: 'takram-himalayan',
    haze: false,
    altitudeTranslation: { cumulus: cumulusOffset, cirrus: cirrusOffset },
    layers,
  });
}

export function getTakramCloudProfile(name, context) {
  if (name === 'takram-reference') return cloneProfile(REFERENCE_PROFILE);
  if (name === 'takram-himalayan') {
    if (context == null) {
      throw new TypeError('Takram Himalayan profile context is required');
    }
    return deriveHimalayanCloudProfile(context);
  }
  throw new RangeError(`Unknown Takram cloud profile: ${String(name)}`);
}

export function nearestLayerBoundaryDistance(layers, altitude) {
  if (!Number.isFinite(altitude)) return Number.NaN;
  let nearest = Number.POSITIVE_INFINITY;
  for (const layer of layers) {
    if (!(layer.height > 0 && layer.densityScale > 0)) continue;
    nearest = Math.min(
      nearest,
      Math.abs(altitude - layer.altitude),
      Math.abs(altitude - (layer.altitude + layer.height)),
    );
  }
  return nearest;
}

export function validateTakramProfileScenario(profile, sample) {
  requireFiniteContext(sample);
  const nearestBoundaryDistance = nearestLayerBoundaryDistance(
    profile.layers,
    sample.cameraAltitude,
  );
  const reasons = [];
  if (!(nearestBoundaryDistance >= 500)) {
    reasons.push('camera-near-zero-density-boundary');
  }
  if (
    profile.name === 'takram-himalayan'
    && profile.layers.slice(0, 2).some(layer => layer.altitude < sample.terrainMax + 350)
  ) {
    reasons.push('cumulus-insufficient-terrain-clearance');
  }
  return {
    eligible: reasons.length === 0,
    nearestBoundaryDistance,
    reasons,
  };
}
