import test from 'node:test';
import assert from 'node:assert/strict';

const navigationModule = await import('./NavigationHint.js').catch(() => ({}));
const visibilityModule = await import('./TerrainVisibility.js').catch(() => ({}));
const {
  NAV_PHASE,
  NavigationHintTracker,
  altitudeCue,
  navigationPhase,
  rangeTrend,
  signedBearingDelta,
} = navigationModule;
const { terrainVisibility } = visibilityModule;

test('bearing delta wraps across north and chooses right at the 180-degree tie', () => {
  assert.equal(signedBearingDelta(359, 1), 2);
  assert.equal(signedBearingDelta(1, 359), -2);
  assert.equal(signedBearingDelta(0, 180), 180);
  assert.equal(signedBearingDelta(180, 0), 180);
});

test('distance boundaries enter search and acquisition at exactly 8 km and 3 km', () => {
  assert.equal(navigationPhase(8000.01), NAV_PHASE.TRANSIT);
  assert.equal(navigationPhase(8000), NAV_PHASE.SEARCH);
  assert.equal(navigationPhase(3000.01), NAV_PHASE.SEARCH);
  assert.equal(navigationPhase(3000), NAV_PHASE.ACQUISITION);
  assert.equal(navigationPhase(null), NAV_PHASE.COMPLETE);
});

test('range trend retains the previous direction inside the inclusive deadband', () => {
  assert.equal(rangeTrend(3, null), 'CLOSING');
  assert.equal(rangeTrend(-3, null), 'OPENING');
  assert.equal(rangeTrend(2, 'OPENING'), 'OPENING');
  assert.equal(rangeTrend(-2, 'CLOSING'), 'CLOSING');
  assert.equal(rangeTrend(0, null), null);
});

test('altitude cue describes target height relative to the aircraft', () => {
  assert.equal(altitudeCue(1), 'ABOVE');
  assert.equal(altitudeCue(-1), 'BELOW');
  assert.equal(altitudeCue(0), 'LEVEL');
});

test('terrain visibility preserves the recon soft-clearance scale', () => {
  const from = { x: 0, y: 100, z: 0 };
  const to = { x: 100, y: 100, z: 0 };
  assert.equal(terrainVisibility(from, to, () => 50), 1);
  assert.equal(terrainVisibility(from, to, () => 100), 0);
  assert.equal(terrainVisibility(from, to, () => 80), 0.5);
});

test('masked acquisition exposes no precise projection and keeps only its last valid edge anchor', () => {
  const tracker = new NavigationHintTracker();
  const edgeNdc = { x: -1, y: 0.25 };
  tracker.update({
    targetId: 'raven', rangeMetres: 2500, headingDeg: 20, targetBearingDeg: 5,
    closingSpeed: 20, altitudeDeltaMetres: -300, projected: { x: -0.4, y: 0.2 },
    edgeNdc, terrainVisibility: 1,
  });

  const masked = tracker.update({
    targetId: 'raven', rangeMetres: 2400, headingDeg: 20, targetBearingDeg: 5,
    closingSpeed: 20, altitudeDeltaMetres: -300, projected: { x: 0.1, y: 0.1 },
    edgeNdc: { x: 1, y: 0.1 }, terrainVisibility: 0,
  });

  assert.equal(masked.projected, null);
  assert.deepEqual(masked.edgeNdc, edgeNdc);
  assert.equal(masked.label, 'RIDGE MASKED');
  assert.equal(masked.masked, true);
});

test('changing target identity clears cached trend, edge anchor, and recon fade', () => {
  const tracker = new NavigationHintTracker();
  tracker.update({
    targetId: 'raven', rangeMetres: 2000, headingDeg: 0, targetBearingDeg: 20,
    closingSpeed: 10, altitudeDeltaMetres: 0, projected: { x: 0.2, y: 0.1 },
    edgeNdc: { x: 1, y: 0.1 }, terrainVisibility: 1, reconActive: true, dt: 0.5,
  });

  const next = tracker.update({
    targetId: 'falcon', rangeMetres: 2000, headingDeg: 0, targetBearingDeg: 20,
    closingSpeed: 0, altitudeDeltaMetres: 0, projected: { x: 0.4, y: 0.1 },
    edgeNdc: { x: -1, y: -0.2 }, terrainVisibility: 0, reconActive: true, dt: 0.2,
  });

  assert.equal(next.trend, null);
  assert.equal(next.edgeNdc, null);
  assert.equal(next.reconPresentation, 'dimmed');
});

test('recon hides broad cues immediately and bounds acquisition dimming to 0.65 seconds', () => {
  const tracker = new NavigationHintTracker();
  const base = {
    targetId: 'raven', headingDeg: 0, targetBearingDeg: 20, closingSpeed: 5,
    altitudeDeltaMetres: 100, projected: { x: 0.2, y: 0.1 },
    edgeNdc: { x: 1, y: 0.1 }, terrainVisibility: 1, reconActive: true,
  };

  assert.equal(tracker.update({ ...base, rangeMetres: 5000, dt: 0.01 }).reconPresentation, 'hidden');
  assert.equal(tracker.update({ ...base, rangeMetres: 2500, dt: 0.64 }).reconPresentation, 'dimmed');
  assert.equal(tracker.update({ ...base, rangeMetres: 2500, dt: 0.01 }).reconPresentation, 'hidden');

  tracker.reset();
  assert.equal(tracker.update({ ...base, rangeMetres: 2500, reconFramed: true }).reconPresentation, 'hidden');
});

test('complete state clears all target guidance and recon presentation', () => {
  const tracker = new NavigationHintTracker();
  tracker.update({
    targetId: 'raven', rangeMetres: 1000, headingDeg: 0, targetBearingDeg: 5,
    closingSpeed: 5, altitudeDeltaMetres: 0, projected: { x: 0, y: 0 },
    edgeNdc: { x: 1, y: 0 }, terrainVisibility: 1,
  });
  const complete = tracker.update({ targetId: null, complete: true });

  assert.equal(complete.phase, NAV_PHASE.COMPLETE);
  assert.equal(complete.targetId, null);
  assert.equal(complete.bearingDelta, null);
  assert.equal(complete.trend, null);
  assert.equal(complete.projected, null);
  assert.equal(complete.edgeNdc, null);
  assert.equal(complete.reconPresentation, 'hidden');
});

test('null range clears guidance even while the previous target ID is still supplied', () => {
  const tracker = new NavigationHintTracker();
  tracker.update({
    targetId: 'raven', rangeMetres: 1000, headingDeg: 0, targetBearingDeg: 5,
    closingSpeed: 5, altitudeDeltaMetres: 0, projected: { x: 0, y: 0 },
    edgeNdc: { x: 1, y: 0 }, terrainVisibility: 1,
  });

  const complete = tracker.update({
    targetId: 'raven', rangeMetres: null, headingDeg: 0, targetBearingDeg: 5,
    closingSpeed: 5, altitudeDeltaMetres: 0, projected: { x: 0.3, y: 0.2 },
    edgeNdc: { x: -1, y: 0.2 }, terrainVisibility: 1,
  });

  assert.deepEqual(complete, {
    targetId: null,
    phase: NAV_PHASE.COMPLETE,
    bearingDelta: null,
    trend: null,
    altitude: null,
    projected: null,
    edgeNdc: null,
    masked: false,
    label: null,
    reconPresentation: 'hidden',
  });
});

test('NaN range clears guidance even when a new non-null target ID is supplied', () => {
  const tracker = new NavigationHintTracker();
  const complete = tracker.update({
    targetId: 'falcon', rangeMetres: Number.NaN, headingDeg: 90, targetBearingDeg: 180,
    closingSpeed: -10, altitudeDeltaMetres: 200, projected: { x: -0.3, y: 0.1 },
    edgeNdc: { x: 1, y: 0.1 }, terrainVisibility: 1,
  });

  assert.equal(complete.targetId, null);
  assert.equal(complete.phase, NAV_PHASE.COMPLETE);
  assert.equal(complete.trend, null);
  assert.equal(complete.projected, null);
  assert.equal(complete.edgeNdc, null);
});
