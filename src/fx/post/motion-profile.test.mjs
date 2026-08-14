import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { computeMotionProfile } from './motionProfile.js';

globalThis.window ??= { matchMedia: () => ({ matches: false }) };
globalThis.document ??= {};
const { Game } = await import('../../game/Game.js');

const BASE = {
  airspeed: 260,
  angularX: 0,
  angularY: 0,
  dt: 1 / 60,
  flying: true,
  reconActive: false,
  reducedMotion: false,
};

test('opening-speed straight flight produces bounded radial edge displacement', () => {
  const profile = computeMotionProfile(BASE);
  assert.ok(profile.radialPixels >= 1.5 && profile.radialPixels <= 2.5);
  assert.equal(profile.angularX, 0);
  assert.equal(profile.angularY, 0);
  assert.ok(profile.edgeStart >= 0.4 && profile.edgeStart <= 0.5);
  assert.ok(profile.combinedPixels <= 6);
});

test('high-speed straight flight remains inside the 380 m/s edge-displacement band', () => {
  const profile = computeMotionProfile({ ...BASE, airspeed: 380 });
  assert.ok(profile.radialPixels >= 2.5 && profile.radialPixels <= 4);
});

test('recon, reduced motion, and non-flight states disable every blur component', () => {
  for (const override of [
    { reconActive: true },
    { reducedMotion: true },
    { flying: false },
  ]) {
    const profile = computeMotionProfile({ ...BASE, ...override, angularX: 0.02, angularY: -0.01 });
    assert.deepEqual(
      { amount: profile.amount, radial: profile.radialPixels, x: profile.angularX, y: profile.angularY },
      { amount: 0, radial: 0, x: 0, y: 0 },
    );
  }
});

test('angular blur uses angular velocity and is frame-rate invariant', () => {
  const angularRate = 1.2;
  const profiles = [30, 60, 120].map((fps) => computeMotionProfile({
    ...BASE,
    airspeed: 0,
    dt: 1 / fps,
    angularX: angularRate / fps,
    angularY: -angularRate * 0.5 / fps,
  }));

  const magnitudes = profiles.map((profile) => Math.hypot(profile.angularX, profile.angularY));
  assert.ok(Math.max(...magnitudes) - Math.min(...magnitudes) < 0.1);
  assert.ok(profiles.every((profile) => profile.amount > 0));
});

test('combined radial and angular displacement never exceeds six pixels', () => {
  const profile = computeMotionProfile({
    ...BASE,
    airspeed: 900,
    angularX: 2,
    angularY: -2,
    dt: 1 / 120,
  });
  assert.ok(profile.combinedPixels <= 6);
  assert.ok(Math.hypot(profile.angularX, profile.angularY) + profile.radialPixels <= 6 + 1e-9);
});

test('invalid timing and telemetry fail closed without NaN', () => {
  const profile = computeMotionProfile({ ...BASE, dt: 0, airspeed: Number.NaN, angularX: Infinity });
  for (const value of Object.values(profile)) assert.ok(Number.isFinite(value));
  assert.ok(profile.combinedPixels <= 6);
});

test('profile calculation reuses a caller-owned output object', () => {
  const output = {};
  const first = computeMotionProfile(BASE, output);
  const second = computeMotionProfile({ ...BASE, airspeed: 380 }, output);
  assert.equal(first, output);
  assert.equal(second, output);
});

function makePostGame() {
  const camera = new THREE.PerspectiveCamera(58, 16 / 9, 4, 750000);
  camera.updateMatrixWorld(true);
  const profiles = [];
  const game = Object.create(Game.prototype);
  Object.assign(game, {
    engine: {
      camera,
      setSunScreenPosition() {},
      setMotionBlur: (profile) => profiles.push(profile),
      setHeatDistortion() {},
      setLensArtifacts() {},
    },
    environment: { sunDir: new THREE.Vector3(0, 0.7, -0.7).normalize() },
    state: 'flying',
    reconActive: false,
    flight: { airspeed: 260, throttleSmoothed: 0.92 },
    chase: { reducedMotion: false },
    _reducedMotion: false,
    _motionWasReconActive: false,
    _postCrashImpulse: 0,
    _sunWorld: new THREE.Vector3(),
    _sunNdc: new THREE.Vector3(),
    _cameraForward: new THREE.Vector3(0, 0, -1),
    _cameraForwardNow: new THREE.Vector3(),
    _cameraDelta: new THREE.Vector3(),
    _cameraRight: new THREE.Vector3(),
    _cameraUp: new THREE.Vector3(),
    _motionInput: {},
    _motionProfile: {},
  });
  return { game, camera, profiles };
}

test('steady post updates reuse the same profile object without querying media state', () => {
  const fixture = makePostGame();
  const originalMatchMedia = window.matchMedia;
  let mediaQueries = 0;
  window.matchMedia = () => (mediaQueries++, { matches: false });
  try {
    fixture.game._updatePostEffects(1 / 60);
    fixture.game._updatePostEffects(1 / 60);
  } finally {
    window.matchMedia = originalMatchMedia;
  }
  assert.equal(fixture.profiles.length, 2);
  assert.equal(fixture.profiles[0], fixture.profiles[1]);
  assert.equal(mediaQueries, 0);
});

test('same-frame recon shutter disables the previous motion pass before capture render', () => {
  const order = [];
  const game = Object.create(Game.prototype);
  const post = { bestScore: 0, captured: false };
  game._motionProfile = {};
  game.engine = { setMotionBlur: (profile) => order.push(['motion', profile.amount]) };
  game.recon = {
    capture: () => (order.push(['capture']), { pending: true }),
    retainShot() {},
  };
  game.mission = { photosTaken: 0 };
  game.hud = { showPhoto() {} };
  game.audio = { shutter() {}, confirm() {} };

  game._takePhoto({ post, score: 0.2 });
  assert.deepEqual(order.slice(0, 2), [['motion', 0], ['capture']]);
});

test('launch resets the angular baseline after the chase camera cut', () => {
  const fixture = makePostGame();
  const game = fixture.game;
  game.navigationHint = { reset() {} };
  game.screens = { hideAll() {} };
  game.flight = { reset() {}, airspeed: 260 };
  game._startPosition = () => new THREE.Vector3();
  game.chase = {
    baseFov: 58,
    reset() {
      fixture.camera.lookAt(1, 0, 0);
      fixture.camera.updateMatrixWorld(true);
    },
  };
  game.terrain = { prime() {} };
  game.fx = { reset() {} };
  game.audio = { start() {}, resume() {}, resetEngine() {}, music: { play() {} } };
  game.input = { touchRecon: false, releaseTouch() {} };
  game.mission = { begin() {} };
  game.hud = { show() {} };

  game.launch();
  const direction = new THREE.Vector3();
  fixture.camera.getWorldDirection(direction);
  assert.ok(game._cameraForward.distanceTo(direction) < 1e-9);
  assert.equal(fixture.profiles.at(-1).amount, 0);
});

test('leaving recon cuts the angular baseline instead of emitting a six-pixel spike', () => {
  const fixture = makePostGame();
  fixture.game._motionWasReconActive = true;
  fixture.game.reconActive = false;
  fixture.camera.lookAt(1, 0, 0);
  fixture.camera.updateMatrixWorld(true);

  fixture.game._updatePostEffects(1 / 60);
  const profile = fixture.profiles.at(-1);
  assert.equal(profile.angularX, 0);
  assert.equal(profile.angularY, 0);
  assert.ok(profile.radialPixels >= 1.5 && profile.radialPixels <= 2.5);
});

test('reduced-motion preference is cached once and its listener is removable', () => {
  const originalMatchMedia = window.matchMedia;
  let queries = 0;
  let removed = 0;
  const query = {
    matches: true,
    addEventListener() {},
    removeEventListener(type, listener) {
      assert.equal(type, 'change');
      assert.equal(listener, this.listener);
      removed++;
    },
  };
  query.addEventListener = (type, listener) => {
    assert.equal(type, 'change');
    query.listener = listener;
  };
  window.matchMedia = () => (queries++, query);
  const game = Object.create(Game.prototype);
  game.chase = { setReducedMotion() {} };
  try {
    game._installMotionPreference();
    assert.equal(game._reducedMotion, true);
    game._disposeMotionPreference();
  } finally {
    window.matchMedia = originalMatchMedia;
  }
  assert.equal(queries, 1);
  assert.equal(removed, 1);
});
