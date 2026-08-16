import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

globalThis.window ??= { matchMedia: () => ({ matches: false }) };
globalThis.document ??= {};

const GameModule = await import('../Game.js');
const { Game } = GameModule;
const { NavigationHintTracker, NAV_PHASE } = await import('../NavigationHint.js');
const { CAPTURE_THRESHOLD } = await import('../ReconCamera.js');
const { Engine } = await import('../../core/Engine.js');
const { Settings } = await import('../../core/Settings.js');
const { Input } = await import('../../core/Input.js');

class InputTarget {
  constructor() {
    this.listeners = new Map();
    this.document = {
      addEventListener() {},
      removeEventListener() {},
    };
  }

  addEventListener(type, fn) { this.listeners.set(type, fn); }
  removeEventListener(type, fn) {
    if (this.listeners.get(type) === fn) this.listeners.delete(type);
  }
}

function withNavigator(getGamepads, run) {
  const oldNavigator = globalThis.navigator;
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { getGamepads },
  });
  try {
    return run();
  } finally {
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: oldNavigator });
  }
}

function makeNavigationGame({
  posts = [
    {
      id: 'A', captured: false,
      position: new THREE.Vector3(0, 0, -1000),
      aimPoint: new THREE.Vector3(0, 0, -1000),
    },
    {
      id: 'B', captured: false,
      position: new THREE.Vector3(800, 200, -1200),
      aimPoint: new THREE.Vector3(800, 200, -1200),
    },
  ],
  flightPosition = new THREE.Vector3(0, 0, 0),
  velocity = new THREE.Vector3(0, 0, -120),
  reconActive = false,
  evaluation = null,
} = {}) {
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 1, 10000);
  camera.position.copy(flightPosition);
  camera.lookAt(flightPosition.x, flightPosition.y, flightPosition.z - 1);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);

  let targetReads = 0;
  const mission = {
    posts,
    targetIndex: 0,
    get target() {
      targetReads++;
      return this.posts.find((post) => !post.captured) ?? null;
    },
    get captured() { return this.posts.filter((post) => post.captured).length; },
    get complete() { return this.posts.length > 0 && this.captured === this.posts.length; },
    bearingTo(post, from) {
      const dx = post.position.x - from.x;
      const dz = post.position.z - from.z;
      const bearing = (Math.atan2(dx, -dz) * 180 / Math.PI + 360) % 360;
      return { bearing, range: from.distanceTo(post.position) };
    },
    cycleTarget() {
      const first = this.posts.shift();
      this.posts.push(first);
    },
  };

  const updates = [];
  const tensions = [];
  const game = Object.create(Game.prototype);
  Object.assign(game, {
    engine: { camera },
    // _updateHud is where the target range is known, so it is also where the
    // score is told how close the run in is.
    audio: { setTension: (range, hasTarget) => tensions.push({ range, hasTarget }) },
    flight: {
      position: flightPosition.clone(),
      velocity: velocity.clone(),
      orientation: new THREE.Quaternion(),
      airspeed: velocity.length(), altitude: flightPosition.y,
      throttleSmoothed: 0.7, reheat: false, stalling: false, gLoad: 1,
    },
    mission,
    reconActive,
    evaluation,
    recon: { zoomIndex: 0, flash: 0 },
    terrainWarning: false,
    navigationHint: new NavigationHintTracker(),
    _navigationAimWorld: new THREE.Vector3(),
    _navigationCameraSpace: new THREE.Vector3(),
    _navigationNdc: new THREE.Vector3(),
    _navigationToTarget: new THREE.Vector3(),
    _navigationEdgeNdc: new THREE.Vector2(),
    hud: { update: (dt, snapshot) => updates.push(snapshot) },
  });
  return { game, mission, updates, tensions, get targetReads() { return targetReads; } };
}

test('the score is told the same target range the navigation cue is drawing', () => {
  const fixture = makeNavigationGame();
  fixture.game._updateHud(1 / 60);
  const cued = fixture.updates.at(-1);
  const scored = fixture.tensions.at(-1);
  assert.equal(scored.hasTarget, true);
  assert.equal(scored.range, cued.targetRange, 'music and HUD must not disagree about the range');

  const done = makeNavigationGame({
    posts: [{
      id: 'A', captured: true,
      position: new THREE.Vector3(0, 0, -1000),
      aimPoint: new THREE.Vector3(0, 0, -1000),
    }],
  });
  done.game._updateHud(1 / 60);
  assert.equal(done.tensions.at(-1).hasTarget, false, 'a finished mission must release the tension');
});

test('water refraction dimensions are bounded and disabled on low tiers', () => {
  assert.equal(typeof GameModule.waterRefractionSize, 'function');
  assert.deepEqual(GameModule.waterRefractionSize(3840, 2160, 'high'), [960, 540]);
  assert.deepEqual(GameModule.waterRefractionSize(1280, 720, 'medium'), [640, 360]);
  assert.equal(GameModule.waterRefractionSize(1920, 1080, 'low'), null);
  assert.equal(GameModule.waterRefractionSize(390, 844, 'phone'), null);
});

test('raw refraction render excludes water and restores renderer state', () => {
  assert.equal(typeof Engine.prototype.renderSceneToTarget, 'function');
  const oldTarget = { name: 'old' };
  const target = { isWebGLRenderTarget: true };
  const hidden = { visible: true };
  const scene = {};
  const camera = {};
  const calls = [];
  const engine = Object.create(Engine.prototype);
  engine.renderer = {
    getRenderTarget: () => oldTarget,
    setRenderTarget: (value) => calls.push(['target', value]),
    clear: () => calls.push(['clear']),
    render: (s, c) => calls.push(['render', s, c, hidden.visible]),
  };

  Engine.prototype.renderSceneToTarget.call(engine, target, scene, camera, hidden);

  assert.deepEqual(calls, [
    ['target', target],
    ['clear'],
    ['render', scene, camera, false],
    ['target', oldTarget],
  ]);
  assert.equal(hidden.visible, true);
});

test('lens artifacts support allocation-free positional updates', () => {
  const engine = Object.create(Engine.prototype);
  engine.clouds = null;
  engine.radiancePass = { enabled: false };
  engine.lensArtifacts = { flare: 0, dirt: 0, visibility: 1 };
  Engine.prototype.setLensArtifacts.call(engine, 0.35, 0.12);
  assert.equal(engine.lensArtifacts.flare, 0.35);
  assert.equal(engine.lensArtifacts.dirt, 0.12);
  assert.equal(engine.radiancePass.enabled, true);
});

test('settings option setters clamp, persist, and retain assisted-control choices', () => {
  const settings = Object.create(Settings.prototype);
  settings.masterVolume = 0.8;
  settings.musicVolume = 0.75;
  settings.controlMode = 'assisted';
  settings.controlSensitivity = 'normal';
  settings.autoThrottle = true;
  settings.verticalMode = 'upToClimb';
  settings.assistedNoticeSeen = false;
  let saves = 0;
  settings.save = () => saves++;

  settings.setMasterVolume(4);
  settings.setMusicVolume(-2);
  settings.setControlMode('direct');
  settings.setControlSensitivity('high');
  settings.setAutoThrottle(false);
  settings.setVerticalMode('upToDive');
  settings.setAssistedNoticeSeen(true);

  assert.equal(settings.masterVolume, 1);
  assert.equal(settings.musicVolume, 0);
  assert.equal(settings.controlMode, 'direct');
  assert.equal(settings.controlSensitivity, 'high');
  assert.equal(settings.autoThrottle, false);
  assert.equal(settings.verticalMode, 'upToDive');
  assert.equal(settings.assistedNoticeSeen, true);
  assert.equal(saves, 7);
});

function makeControlGame(mode = 'assisted') {
  const resets = { input: 0, launch: 0, assist: 0 };
  const intent = { turn: 0.5, climb: -0.25, speed: 0, boost: false, brake: 0, throttle: 0.72 };
  const input = {
    intent,
    reconHeld: false,
    releaseAll() { resets.input++; },
    resetForLaunch() { resets.launch++; },
    consumePress() { return false; },
  };
  const output = { pitch: 0.1, roll: 0.2, yaw: 0.05, throttle: 0.82, brake: 0 };
  const calls = [];
  const assist = {
    update(...args) { calls.push(args); return output; },
    reset() { resets.assist++; },
  };
  const game = Object.create(Game.prototype);
  Object.assign(game, {
    settings: { controlMode: mode, controlSensitivity: 'normal', autoThrottle: true },
    input,
    flight: { marker: 'flight' },
    assist,
    reconActive: false,
    accumulator: 0.03,
    _controlMode: mode,
    _assistOptions: { sensitivity: 'normal', autoThrottle: true, reconActive: false },
    _neutralFlightControl: { pitch: 0, roll: 0, yaw: 0, throttle: 0.8, brake: 0 },
  });
  return { game, input, intent, output, calls, resets };
}

test('Direct passes the exact input object while Assisted reuses one controller and options object', () => {
  const direct = makeControlGame('direct');
  assert.equal(direct.game._flightControlForStep(1 / 120), direct.input);
  assert.equal(direct.calls.length, 0);

  const assisted = makeControlGame('assisted');
  const first = assisted.game._flightControlForStep(1 / 120);
  const options = assisted.calls[0][3];
  const second = assisted.game._flightControlForStep(1 / 120);
  assert.equal(first, assisted.output);
  assert.equal(second, assisted.output, 'fixed substeps must reuse the controller output');
  assert.equal(assisted.calls[0][1], assisted.intent);
  assert.equal(assisted.calls[0][2], assisted.game.flight);
  assert.equal(assisted.calls[1][3], options, 'fixed substeps must reuse the options object');
});

test('Assisted recon toggles once per Space edge while Direct preserves held recon', () => {
  const assisted = makeControlGame('assisted');
  let pending = true;
  assisted.input.consumePress = (code) => code === 'Space' && pending && (pending = false, true);
  assisted.game._updateReconMode();
  assert.equal(assisted.game.reconActive, true);
  assisted.game._updateReconMode();
  assert.equal(assisted.game.reconActive, true, 'a held key must not toggle a second time');

  const direct = makeControlGame('direct');
  direct.input.reconHeld = true;
  direct.game._updateReconMode();
  assert.equal(direct.game.reconActive, true);
  direct.input.reconHeld = false;
  direct.game._updateReconMode();
  assert.equal(direct.game.reconActive, false);
});

test('Assisted gamepad RB toggles recon once per rising edge while Direct remains held', () => {
  const pad = {
    connected: true,
    axes: [0, 0, 0],
    buttons: Array.from({ length: 6 }, () => ({ value: 0 })),
  };
  withNavigator(() => [pad], () => {
    const input = new Input(new InputTarget());
    const assisted = makeControlGame('assisted');
    assisted.game.input = input;

    pad.buttons[5].value = 1;
    input.update(1 / 60);
    assisted.game._updateReconMode();
    assert.equal(input.modality, 'gamepad');
    assert.equal(assisted.game.reconActive, true, 'first RB press opens recon');

    input.update(1 / 60);
    assisted.game._updateReconMode();
    assert.equal(assisted.game.reconActive, true, 'held RB does not toggle recon again');

    pad.buttons[5].value = 0;
    input.update(1 / 60);
    assisted.game._updateReconMode();
    assert.equal(assisted.game.reconActive, true, 'RB release leaves Assisted recon latched open');

    pad.buttons[5].value = 1;
    input.update(1 / 60);
    assisted.game._updateReconMode();
    assert.equal(assisted.game.reconActive, false, 'a fresh RB press closes recon');
    input.dispose();

    const directInput = new Input(new InputTarget());
    const direct = makeControlGame('direct');
    direct.game.input = directInput;
    directInput.update(1 / 60);
    direct.game._updateReconMode();
    assert.equal(direct.game.reconActive, true, 'Direct recon follows held RB');
    directInput.update(1 / 60);
    direct.game._updateReconMode();
    assert.equal(direct.game.reconActive, true, 'Direct recon stays active while RB remains held');
    pad.buttons[5].value = 0;
    directInput.update(1 / 60);
    direct.game._updateReconMode();
    assert.equal(direct.game.reconActive, false, 'Direct recon closes on RB release');
    directInput.dispose();
  });
});

test('Assisted touch recon follows each tap edge instead of the legacy held latch', () => {
  const fixture = makeControlGame('assisted');
  fixture.input.modality = 'touch';
  fixture.input.touchRecon = false;
  fixture.game._touchReconWas = false;

  fixture.input.touchRecon = true;
  fixture.input.consumePress = (code) => code === 'Space';
  fixture.game._updateReconMode();
  assert.equal(fixture.game.reconActive, true, 'first touch tap opens recon exactly once despite also producing Space');

  fixture.input.touchRecon = false;
  fixture.input.consumePress = () => false;
  fixture.game._updateReconMode();
  assert.equal(fixture.game.reconActive, false, 'second touch tap must close recon without requiring a third tap');
});

test('mode switches clean held state, reset accumulation, and synchronize touch mode', () => {
  const fixture = makeControlGame('assisted');
  const modes = [];
  fixture.game.touchControls = { setMode: (mode) => modes.push(mode) };
  fixture.game.settings.controlMode = 'direct';
  fixture.game._syncControlMode();
  assert.deepEqual(fixture.resets, { input: 1, launch: 0, assist: 1 });
  assert.equal(fixture.game.accumulator, 0);
  assert.equal(fixture.game.reconActive, false);
  assert.deepEqual(modes, ['direct']);
});

test('malformed assisted output falls back to one finite neutral control object', () => {
  const fixture = makeControlGame('assisted');
  fixture.game.assist.update = () => ({ pitch: NaN, roll: Infinity, yaw: 0, throttle: 1, brake: 0 });
  const first = fixture.game._flightControlForStep(1 / 120);
  const second = fixture.game._flightControlForStep(1 / 120);
  assert.equal(first, fixture.game._neutralFlightControl);
  assert.equal(second, first);
  assert.deepEqual(first, { pitch: 0, roll: 0, yaw: 0, throttle: 0.8, brake: 0 });
});

test('control lifecycle cleanup covers pause, launch hook, blur, and disposal', () => {
  const fixture = makeControlGame('assisted');
  fixture.game.state = 'flying';
  fixture.game.hud = { show() {} };
  fixture.game.screens = { show() {}, pauseLayer: {} };
  fixture.game.pause();
  assert.deepEqual(fixture.resets, { input: 1, launch: 0, assist: 1 });

  class EventTargetStub {
    constructor() { this.listeners = new Map(); }
    addEventListener(type, fn) { this.listeners.set(type, fn); }
    removeEventListener(type, fn) { if (this.listeners.get(type) === fn) this.listeners.delete(type); }
    fire(type) { this.listeners.get(type)?.(); }
  }
  const target = new EventTargetStub();
  const visibility = new EventTargetStub();
  visibility.hidden = false;
  fixture.game._installControlLifecycle(target, visibility);
  target.fire('blur');
  assert.deepEqual(fixture.resets, { input: 2, launch: 0, assist: 2 });
  visibility.hidden = true;
  visibility.fire('visibilitychange');
  assert.deepEqual(fixture.resets, { input: 3, launch: 0, assist: 3 });
  fixture.game._disposeControlLifecycle();
  assert.equal(target.listeners.size, 0);
  assert.equal(visibility.listeners.size, 0);
});

test('sortie launch uses the explicit throttle reset while pause remains a preserving hard release', () => {
  const fixture = makeControlGame('direct');
  Object.assign(fixture.game, {
    state: 'flying',
    navigationHint: { reset() {} },
    screens: { hideAll() {}, show() {}, pauseLayer: {} },
    flight: { reset() {}, position: new THREE.Vector3() },
    chase: { baseFov: 58, reset() {} },
    reconActive: false,
    terrain: { prime() {} },
    fx: { reset() {} },
    audio: { start() {}, resume() {}, resetEngine() {}, setTension() {}, music: { play() {} } },
    mission: { begin() {} },
    hud: { show() {} },
    engine: { camera: { fov: 58, updateProjectionMatrix() {} } },
    _startPosition: () => new THREE.Vector3(),
    _resetMotionBaseline() {},
  });

  fixture.game.pause();
  assert.deepEqual(fixture.resets, { input: 1, launch: 0, assist: 1 });
  fixture.game.resume();
  fixture.game.launch();
  assert.deepEqual(fixture.resets, { input: 1, launch: 1, assist: 2 });
});

test('touch controls receive the current flight mode when attached', () => {
  const fixture = makeControlGame('assisted');
  const modes = [];
  fixture.game.setTouchControls({ setMode: (mode) => modes.push(mode) });
  assert.deepEqual(modes, ['assisted']);
});

test('HUD navigation reads the authoritative mission target once and advances directly after capture', () => {
  const fixture = makeNavigationGame();
  fixture.game._updateHud(1 / 60);
  assert.equal(fixture.targetReads, 1);
  assert.equal(fixture.updates.at(-1).navigation.targetId, 'A');

  fixture.mission.posts[0].captured = true;
  fixture.game._updateHud(1 / 60);
  assert.equal(fixture.targetReads, 2, 'each HUD update must read mission.target exactly once');
  assert.equal(fixture.updates.at(-1).navigation.targetId, 'B');
  assert.equal(fixture.updates.at(-1).navigation.trend, 'CLOSING');
  assert.equal(fixture.updates.at(-1).navigation.altitude, 'ABOVE');
});

test('a securing exposure advances navigation from A to B exactly once', () => {
  const fixture = makeNavigationGame();
  const [postA] = fixture.mission.posts;
  const secured = { post: postA, score: CAPTURE_THRESHOLD, range: 900 };
  const confirmations = [];
  Object.assign(fixture.game, {
    recon: {
      zoomIndex: 0,
      flash: 0,
      capture: () => ({ url: 'shot', grade: 'A', dataUrl: 'blob:shot' }),
      retainShot() {},
      releaseShot() {},
    },
    audio: { shutter() {}, setTension() {}, confirm: () => confirmations.push('secured') },
  });
  fixture.game.mission.photosTaken = 0;
  fixture.game.hud.showPhoto = () => {};

  fixture.game._updateHud(1 / 60);
  fixture.game._takePhoto(secured);
  fixture.game._updateHud(1 / 60);
  fixture.game._takePhoto(secured);
  fixture.game._updateHud(1 / 60);

  assert.deepEqual(
    fixture.updates.slice(-3).map((snapshot) => snapshot.navigation.targetId),
    ['A', 'B', 'B'],
  );
  assert.deepEqual(confirmations, ['secured']);
});

test('Tab remains the target-selection authority consumed by the flight update', () => {
  const fixture = makeNavigationGame();
  let tabPending = true;
  Object.assign(fixture.game, {
    input: {
      reconHeld: false,
      consumePress(code) {
        if (code !== 'Tab' || !tabPending) return false;
        tabPending = false;
        return true;
      },
    },
    accumulator: 0,
    aircraft: { update() {} },
    // baseFov and setZoomScale: surface detail fades on world distance, so the
    // flight update tells the terrain how much narrower the optic currently is.
    chase: { update() {}, baseFov: 58 },
    terrain: { update() {}, setZoomScale() {} },
    fx: { update() {} },
    audio: { update() {}, setTension() {} },
    settings: { tier: { terrainBudget: 1 } },
    // The camera rig runs every frame now, and returns immediately only when
    // the recon blend has fully settled back onto the chase.
    _reconBlend: 0,
  });
  fixture.game.mission.update = () => {};

  fixture.game._updateFlight(0);

  assert.equal(fixture.updates.at(-1).navigation.targetId, 'B');
});

test('HUD navigation projects only front/on-screen objectives and masks terrain only inside 3 km', () => {
  const near = {
    id: 'near', captured: false,
    position: new THREE.Vector3(0, -10000, -2000),
    aimPoint: new THREE.Vector3(0, -10000, -2000),
  };
  const nearFixture = makeNavigationGame({
    posts: [near],
    flightPosition: new THREE.Vector3(0, -10000, 0),
    velocity: new THREE.Vector3(0, 0, -100),
  });
  nearFixture.game._updateHud(1 / 60);
  const masked = nearFixture.updates.at(-1);
  assert.equal(masked.navigation.projected, null);
  assert.equal(masked.navigation.masked, true);

  const far = {
    id: 'far', captured: false,
    position: new THREE.Vector3(0, -10000, -4000),
    aimPoint: new THREE.Vector3(0, -10000, -4000),
  };
  const farFixture = makeNavigationGame({
    posts: [far],
    flightPosition: new THREE.Vector3(0, -10000, 0),
  });
  farFixture.game._updateHud(1 / 60);
  assert.deepEqual(farFixture.updates.at(-1).navigation.projected, { x: 0, y: 0 });
  assert.equal(farFixture.updates.at(-1).navigation.masked, false);

  const behind = {
    id: 'behind', captured: false,
    position: new THREE.Vector3(0, 0, 1000),
    aimPoint: new THREE.Vector3(0, 0, 1000),
  };
  const behindFixture = makeNavigationGame({ posts: [behind] });
  behindFixture.game._updateHud(1 / 60);
  assert.equal(behindFixture.updates.at(-1).navigation.projected, null);
});

test('navigation phase boundaries are exact and stable through visible-mask-visible acquisition', () => {
  const tracker = new NavigationHintTracker();
  const input = {
    targetId: 'A', headingDeg: 0, targetBearingDeg: 15,
    closingSpeed: 120, altitudeDeltaMetres: 0,
    projected: { x: 0.2, y: -0.1 }, edgeNdc: { x: 1, y: -0.5 },
    terrainVisibility: 1, reconActive: false, dt: 1 / 60,
  };
  assert.equal(tracker.update({ ...input, rangeMetres: 8000.01 }).phase, NAV_PHASE.TRANSIT);
  assert.equal(tracker.update({ ...input, rangeMetres: 8000 }).phase, NAV_PHASE.SEARCH);
  const visible = tracker.update({ ...input, rangeMetres: 3000 });
  assert.equal(visible.phase, NAV_PHASE.ACQUISITION);
  assert.deepEqual(visible.projected, input.projected);

  const masked = tracker.update({
    ...input,
    rangeMetres: 2999.99,
    projected: { x: -0.8, y: 0.75 },
    edgeNdc: { x: -1, y: 0.4 },
    terrainVisibility: 0,
  });
  assert.equal(masked.projected, null);
  assert.deepEqual(masked.edgeNdc, input.edgeNdc, 'masking retains only the last clear edge anchor');

  const clearAgain = tracker.update({
    ...input,
    rangeMetres: 2999,
    projected: { x: -0.3, y: 0.25 },
    edgeNdc: { x: -1, y: 0.4 },
  });
  assert.deepEqual(clearAgain.projected, { x: -0.3, y: 0.25 });
  assert.equal(clearAgain.masked, false);
});

test('an in-front offscreen objective receives an edge anchor but no precise projection', () => {
  const post = {
    id: 'edge', captured: false,
    position: new THREE.Vector3(6000, 0, -4000),
    aimPoint: new THREE.Vector3(6000, 0, -4000),
  };
  const fixture = makeNavigationGame({ posts: [post] });
  fixture.game._updateHud(1 / 60);
  const navigation = fixture.updates.at(-1).navigation;
  assert.equal(navigation.projected, null);
  assert.ok(navigation.edgeNdc);
  assert.ok(Math.abs(navigation.edgeNdc.x) === 1 || Math.abs(navigation.edgeNdc.y) === 1);
});

test('closing recon clears its acquisition handoff timer before the next opening', () => {
  const tracker = new NavigationHintTracker();
  const input = {
    targetId: 'A', rangeMetres: 2000, headingDeg: 0, targetBearingDeg: 0,
    closingSpeed: 0, altitudeDeltaMetres: 0, terrainVisibility: 1,
    projected: { x: 0, y: 0 }, edgeNdc: { x: 0, y: -1 }, reconFramed: false,
  };
  assert.equal(tracker.update({ ...input, reconActive: true, dt: 0.64 }).reconPresentation, 'dimmed');
  assert.equal(tracker.update({ ...input, reconActive: true, dt: 0.02 }).reconPresentation, 'hidden');
  assert.equal(tracker.update({ ...input, reconActive: false, dt: 0.5 }).reconPresentation, 'normal');
  assert.equal(
    tracker.update({ ...input, reconActive: true, dt: 0.01 }).reconPresentation,
    'dimmed',
    'reopening recon starts a fresh handoff instead of reusing the stale timeout',
  );
});

test('recon framing hides navigation and launch clears the prior trend history', () => {
  const fixture = makeNavigationGame({ reconActive: true });
  fixture.game.evaluation = { post: fixture.mission.posts[0], inFrame: true };
  fixture.game._updateHud(0.2);
  const framed = fixture.updates.at(-1);
  assert.equal(framed.navigation.reconPresentation, 'hidden');

  fixture.game.flight.velocity.set(0, 0, 0);
  Object.assign(fixture.game, {
    screens: { hideAll() {} },
    chase: { baseFov: 58, reset() {} },
    terrain: { prime() {} },
    fx: { reset() {} },
    audio: { start() {}, resume() {}, resetEngine() {}, setTension() {}, music: { play() {} } },
    input: { touchRecon: false, releaseTouch() {} },
  });
  fixture.game.mission.begin = () => {};
  fixture.game.hud.show = () => {};
  fixture.game.flight.reset = () => {};
  let launchResets = 0;
  const reset = fixture.game.navigationHint.reset.bind(fixture.game.navigationHint);
  fixture.game.navigationHint.reset = () => { launchResets++; reset(); };
  fixture.game.launch();
  assert.equal(launchResets, 1);
  fixture.game._updateHud(0.2);
  const restarted = fixture.updates.at(-1);
  assert.equal(restarted.navigation.trend, null);
});

test('all-complete missions emit the canonical complete navigation snapshot', () => {
  const posts = [{
    id: 'A', captured: true,
    position: new THREE.Vector3(0, 0, -1000),
    aimPoint: new THREE.Vector3(0, 0, -1000),
  }];
  const fixture = makeNavigationGame({ posts });
  fixture.game._updateHud(1 / 60);
  assert.equal(fixture.updates.at(-1).navigation.phase, NAV_PHASE.COMPLETE);
  assert.equal(fixture.updates.at(-1).navigation.targetId, null);
});

test('recon capture receives Engine so the final post chain is used', () => {
  const game = Object.create(Game.prototype);
  const post = { bestScore: 0, captured: false };
  const evaluation = { post, score: 0.2 };
  game.engine = { renderer: {}, scene: {} };
  let captureArgs;
  game.recon = {
    capture: (...args) => (captureArgs = args, { url: 'shot' }),
    retainShot() {},
  };
  game.mission = { photosTaken: 0 };
  game.hud = { showPhoto() {} };
  game.audio = { shutter() {}, confirm() {} };

  game._takePhoto(evaluation);
  assert.deepEqual(captureArgs, [game.engine, evaluation], 'navigation data must remain HUD-only and never enter recon capture');
});

test('replacing a best photo releases the prior plate and retains the new pending shot', () => {
  const game = Object.create(Game.prototype);
  const oldShot = { dataUrl: 'blob:old' };
  const newShot = { dataUrl: null, pending: true };
  const post = { bestScore: 0.5, photo: oldShot, captured: false };
  const calls = [];
  game.engine = { renderer: {}, scene: {} };
  game.recon = {
    capture: () => newShot,
    retainShot: (shot) => calls.push(['retain', shot]),
    releaseShot: (shot) => calls.push(['release', shot]),
  };
  game.mission = { photosTaken: 0 };
  game.hud = { showPhoto() {} };
  game.audio = { shutter() {}, confirm() {} };

  game._takePhoto({ post, score: 0.75, range: 900 });
  assert.deepEqual(calls, [['release', oldShot], ['retain', newShot]]);
  assert.equal(post.photo, newShot);
  assert.equal(post.bestScore, 0.75);
});

test('mission restart releases every retained best plate before disposing the old mission', () => {
  const game = Object.create(Game.prototype);
  const photos = [{ dataUrl: 'blob:a' }, { dataUrl: 'blob:b' }];
  let oldDisposed = false;
  game.mission = {
    posts: [{ photo: photos[0] }, { photo: null }, { photo: photos[1] }],
    dispose() { oldDisposed = true; },
  };
  const released = [];
  game.recon = { releaseShot: (shot) => released.push(shot) };
  game.engine = { scene: new THREE.Scene() };
  game._startPosition = () => new THREE.Vector3(21000, 5000, 6000);
  game.screens = { setTargets() {} };
  game.hud = { setObjectiveCount() {} };
  game.launch = () => {};
  let navigationResets = 0;
  game.navigationHint = { reset: () => navigationResets++ };

  game.restart();
  assert.deepEqual(released, photos);
  assert.equal(oldDisposed, true);
  assert.equal(navigationResets, 1);
  game.mission.dispose();
});

test('crash copies the preserved impact into one stable event and hides the aircraft', () => {
  const game = Object.create(Game.prototype);
  game.flight = {
    impactPoint: new THREE.Vector3(4, 5100, -9),
    impactVelocity: new THREE.Vector3(120, -80, 20),
    impactNormal: new THREE.Vector3(0.1, 0.98, -0.16).normalize(),
    impactSpeed: 160,
  };
  game._impactEvent = {
    position: new THREE.Vector3(),
    velocity: new THREE.Vector3(),
    normal: new THREE.Vector3(),
    speed: 0,
    strength: 0,
  };
  game.mission = { fail: () => {} };
  game.audio = { impact: () => {} };
  const presentations = [];
  game.aircraft = { setCrashPresentation: (active) => presentations.push(active) };
  const dispatched = [];
  game.fx = { crash: (impact) => dispatched.push(impact) };
  game._postCrashImpulse = 0;

  game.onCrash();
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0], game._impactEvent);
  assert.notEqual(dispatched[0].position, game.flight.impactPoint);
  assert.notEqual(dispatched[0].velocity, game.flight.impactVelocity);
  assert.notEqual(dispatched[0].normal, game.flight.impactNormal);
  assert.ok(dispatched[0].position.equals(new THREE.Vector3(4, 5100, -9)));
  assert.ok(dispatched[0].velocity.equals(new THREE.Vector3(120, -80, 20)));
  assert.ok(dispatched[0].normal.equals(game.flight.impactNormal));
  assert.equal(dispatched[0].speed, 160);
  assert.equal(dispatched[0].strength, 0.5);
  assert.deepEqual(presentations, [true]);
  assert.ok(game._postCrashImpulse >= 0.5);
});

test('launch restores the aircraft and clears the impact presentation', () => {
  const fixture = makeControlGame('direct');
  const lifecycle = [];
  Object.assign(fixture.game, {
    navigationHint: { reset() {} },
    screens: { hideAll() {} },
    flight: { reset() {}, position: new THREE.Vector3() },
    chase: { baseFov: 58, reset() {} },
    terrain: { prime() {} },
    fx: { reset() {}, resetImpact: () => lifecycle.push('impact-reset') },
    aircraft: { setCrashPresentation: (active) => lifecycle.push(`aircraft:${active}`) },
    audio: { start() {}, resume() {}, resetEngine() {}, setTension() {}, music: { play() {} } },
    mission: { begin() {} },
    hud: { show() {} },
    engine: { camera: { fov: 58, updateProjectionMatrix() {} } },
    _startPosition: () => new THREE.Vector3(),
    _resetMotionBaseline() {},
  });

  fixture.game.launch();
  assert.deepEqual(lifecycle, ['impact-reset', 'aircraft:false']);
});

test('reduced motion keeps impact dispatch but attenuates only crash heat and zeroes blur', () => {
  const run = (reducedMotion) => {
    const game = Object.create(Game.prototype);
    const camera = new THREE.PerspectiveCamera(58, 16 / 9, 4, 750000);
    camera.updateMatrixWorld();
    const calls = { impacts: 0, heat: [], motion: [] };
    Object.assign(game, {
      flight: {
        impactPoint: new THREE.Vector3(),
        impactVelocity: new THREE.Vector3(0, -200, 10),
        impactNormal: new THREE.Vector3(0, 1, 0),
        impactSpeed: 200,
        airspeed: 0,
        throttleSmoothed: 0,
      },
      _impactEvent: {
        position: new THREE.Vector3(), velocity: new THREE.Vector3(), normal: new THREE.Vector3(),
        speed: 0, strength: 0,
      },
      mission: { fail() {} },
      aircraft: { setCrashPresentation() {} },
      fx: { crash: () => calls.impacts++ },
      audio: { impact() {} },
      _postCrashImpulse: 0,
      _reducedMotion: reducedMotion,
      state: 'flying',
      reconActive: false,
      environment: { sunDir: new THREE.Vector3(0, 0.7, -0.7).normalize() },
      engine: {
        camera,
        setSunScreenPosition() {},
        setMotionBlur: (profile) => calls.motion.push({ ...profile }),
        setHeatDistortion: (value) => calls.heat.push(value),
        setLensArtifacts() {},
      },
      _sunWorld: new THREE.Vector3(),
      _sunNdc: new THREE.Vector3(),
      _cameraForward: new THREE.Vector3(0, 0, -1),
      _cameraForwardNow: new THREE.Vector3(),
      _cameraDelta: new THREE.Vector3(),
      _cameraRight: new THREE.Vector3(),
      _cameraUp: new THREE.Vector3(),
      _motionWasReconActive: false,
    });
    game.onCrash();
    game._updatePostEffects(1 / 60);
    return calls;
  };

  const normal = run(false);
  const reduced = run(true);
  assert.equal(normal.impacts, 1);
  assert.equal(reduced.impacts, 1);
  assert.ok(normal.heat[0] > 0);
  assert.ok(reduced.heat[0] <= normal.heat[0] * 0.2 + 1e-12);
  assert.equal(reduced.motion[0].amount, 0);
  assert.equal(reduced.motion[0].combinedPixels, 0);
});

test('quality switch requests a terrain rebuild only when grid resolution changes', () => {
  const game = Object.create(Game.prototype);
  const flight = { marker: 'preserved' };
  const mission = { marker: 'preserved' };
  game.flight = flight;
  game.mission = mission;
  game.terrainResolution = 257;
  game.settings = {
    tierName: 'high',
    tier: { name: 'high', terrainRes: 257 },
    setTier(name) {
      this.tierName = name;
      this.tier = { name, terrainRes: name === 'low' ? 129 : 257 };
    },
  };
  // Scene consumers of the composer depth texture have to be re-declared on a
  // tier switch, so the fake engine models that part of the real interface.
  let declaredDepth = null;
  game.engine = {
    applySettings() {},
    setSceneDepthRequired(required) { declaredDepth = required; },
    composer: { stableDepthTexture: null },
  };
  game._waterDrawingSize = new THREE.Vector2(1280, 720);
  game.terrain = { setQuality() { throw new Error('old terrain must not be retuned before rebuild'); } };
  game.water = { setQuality() {} };
  game.fx = { setQuality() {} };
  game.screens = { setQuality() {} };
  game.cloudField = { setQuality() {}, setDepthTexture() {} };
  game.clouds = { setQuality() {}, setDepthTexture() {} };
  game._disposeWaterRefraction = () => {};
  let rebuild;
  game._rebuildTerrain = (next, old) => { rebuild = [next, old]; };

  game.setQuality('low');
  assert.deepEqual(rebuild, [129, 257]);
  assert.equal(game.flight, flight);
  assert.equal(game.mission, mission);
  assert.equal(declaredDepth, true, 'low tier still needs composer depth for soft particles');

  // The rebuild guard above has served its purpose; from here the question is
  // only what the phone tier declares about scene depth.
  game.terrainResolution = 129;
  game.terrain = { setQuality() {} };
  game.setQuality('phone');
  assert.equal(declaredDepth, false, 'phone declines soft depth: the define costs a fetch on the most fill-bound geometry');
});

test('low tier water path never performs a refraction prepass', () => {
  const game = Object.create(Game.prototype);
  let renders = 0;
  let clears = 0;
  game.settings = { tier: { name: 'low' } };
  game.engine = {
    camera: new THREE.PerspectiveCamera(),
    renderer: { getDrawingBufferSize: (out) => out.set(1280, 720) },
    renderSceneToTarget: () => renders++,
  };
  game._waterDrawingSize = new THREE.Vector2();
  game.water = {
    visible: true,
    visibleLakeCount: 3,
    update() {},
    clearRefractionSource: () => clears++,
  };
  game._updateWaterRefraction(1 / 60);
  assert.equal(renders, 0);
  assert.equal(clears, 1);
});

function makeRefractionGame({ tier = 'high', halfFloat = false } = {}) {
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 1, 2000);
  camera.position.set(0, 20, 0);
  camera.lookAt(0, 20, -1);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);

  const renderer = {
    capabilities: { isWebGL2: true },
    extensions: { has: (name) => halfFloat && name === 'EXT_color_buffer_float' },
    getDrawingBufferSize: (out) => out.set(1920, 1080),
  };
  const game = Object.create(Game.prototype);
  game.settings = { tier: { name: tier } };
  game.engine = {
    camera,
    scene: {},
    renderer,
    renderSceneToTarget: () => { game.renderCount++; },
  };
  game.renderCount = 0;
  game._waterDrawingSize = new THREE.Vector2();
  game._waterRefractionDimensions = [0, 0];
  game._waterRefractionTarget = null;
  game._waterRefractionSource = {};
  game._waterFrustum = new THREE.Frustum();
  game._waterViewProjection = new THREE.Matrix4();
  game._waterLakeBounds = new THREE.Sphere();
  game.water = {
    visible: true,
    visibleLakeCount: 1,
    field: {
      activeCount: 1,
      active: [{ x: 0, z: -100, level: 0, rMax: 20 }],
    },
    update() {},
    clearRefractionSource() {},
    setRefractionSource(source) { this.source = { ...source }; },
  };
  return game;
}

test('water refraction skips behind and off-frustum accepted lakes before target allocation', () => {
  const game = makeRefractionGame();
  const cachedFrustum = game._waterFrustum;
  const cachedBounds = game._waterLakeBounds;

  game.water.field.active[0] = { x: 0, z: 100, level: 0, rMax: 20 };
  game._updateWaterRefraction(1 / 60);
  assert.equal(game._waterRefractionTarget, null, 'a behind-camera lake must not allocate a target');

  game.water.field.active[0] = { x: 1000, z: -100, level: 0, rMax: 20 };
  game._updateWaterRefraction(1 / 60);
  assert.equal(game._waterRefractionTarget, null, 'an off-axis lake must not allocate a target');
  assert.equal(game.renderCount, 0);

  game.water.field.active[0] = { x: 0, z: -100, level: 0, rMax: 20 };
  game._updateWaterRefraction(1 / 60);
  assert.equal(game.renderCount, 1, 'an in-frustum accepted lake should receive refraction');
  assert.ok(game._waterRefractionTarget?.isWebGLRenderTarget);
  assert.equal(game._waterFrustum, cachedFrustum, 'frustum scratch must be reused');
  assert.equal(game._waterLakeBounds, cachedBounds, 'lake bounds scratch must be reused');
  game._disposeWaterRefraction();
});

test('high uses RGBA16F only with renderable float support while medium stays RGBA8', () => {
  const supported = makeRefractionGame({ tier: 'high', halfFloat: true });
  supported._updateWaterRefraction(1 / 60);
  assert.equal(supported._waterRefractionTarget.texture.type, THREE.HalfFloatType);
  assert.equal(supported._waterRefractionTarget.texture.internalFormat, 'RGBA16F');

  const highTarget = supported._waterRefractionTarget;
  supported.settings.tier.name = 'medium';
  supported._updateWaterRefraction(1 / 60);
  assert.notEqual(supported._waterRefractionTarget, highTarget, 'tier format change must rebuild the target');
  assert.equal(supported._waterRefractionTarget.texture.type, THREE.UnsignedByteType);
  supported._disposeWaterRefraction();

  const unsupported = makeRefractionGame({ tier: 'high', halfFloat: false });
  unsupported._updateWaterRefraction(1 / 60);
  assert.equal(unsupported._waterRefractionTarget.texture.type, THREE.UnsignedByteType);
  unsupported._disposeWaterRefraction();
});

test('steady post updates use setters without rebuilding the effect pass', () => {
  const game = Object.create(Game.prototype);
  const camera = new THREE.PerspectiveCamera(58, 16 / 9, 4, 750000);
  camera.updateMatrixWorld();
  const calls = [];
  game.engine = {
    camera,
    setSunScreenPosition: (...v) => calls.push(['sun', ...v]),
    setMotionBlur: (...v) => calls.push(['motion', ...v]),
    setHeatDistortion: (...v) => calls.push(['heat', ...v]),
    setLensArtifacts: (...v) => calls.push(['lens', ...v]),
    _buildEffectPass: () => { throw new Error('must not rebuild'); },
  };
  game.environment = { sunDir: new THREE.Vector3(0, 0.7, -0.7).normalize() };
  game.state = 'flying';
  game.flight = { airspeed: 260, throttleSmoothed: 0.92 };
  game._postCrashImpulse = 0;
  game._sunWorld = new THREE.Vector3();
  game._sunNdc = new THREE.Vector3();
  game._cameraForward = new THREE.Vector3(0, 0, -1);
  game._cameraForwardNow = new THREE.Vector3();
  game._cameraDelta = new THREE.Vector3();
  game._cameraRight = new THREE.Vector3();
  game._cameraUp = new THREE.Vector3();
  game._updatePostEffects(1 / 60);
  assert.deepEqual(calls.map((v) => v[0]), ['sun', 'motion', 'heat', 'lens']);
  assert.ok(calls.flat().slice(1).every((v) => typeof v !== 'number' || Number.isFinite(v)));
});

test('Game disposal is comprehensive and idempotent without disposing Engine', () => {
  const game = Object.create(Game.prototype);
  const counts = new Map();
  const disposable = (name) => ({ dispose: () => counts.set(name, (counts.get(name) ?? 0) + 1) });
  game._disposed = false;
  game._waterRefractionTarget = null;
  game._waterRefractionSource = {};
  game.water = Object.assign(disposable('water'), { clearRefractionSource() {}, removeFromParent() {} });
  game.mission = disposable('mission');
  game.recon = disposable('recon');
  game.aircraft = disposable('aircraft');
  game.fx = disposable('fx');
  game.terrain = Object.assign(disposable('terrain'), { group: { removeFromParent() {} } });
  game.sky = Object.assign(disposable('sky'), { mesh: { removeFromParent() {} } });
  game.environment = disposable('environment');
  game.screens = disposable('screens');
  game.hud = disposable('hud');
  game.audio = disposable('audio');
  game._skipHandlers = new Set([1]);
  game.input = { releaseTouch() {} };
  let navigationResets = 0;
  game.navigationHint = { reset: () => navigationResets++ };
  let cloudDetach = 0;
  game.engine = { scene: { environment: null }, setClouds: () => cloudDetach++ };

  game.dispose();
  game.dispose();
  assert.equal(cloudDetach, 1);
  assert.equal(navigationResets, 1);
  for (const name of ['water', 'mission', 'recon', 'aircraft', 'fx', 'terrain', 'sky', 'environment', 'screens', 'hud', 'audio']) {
    assert.equal(counts.get(name), 1, name);
  }
});
