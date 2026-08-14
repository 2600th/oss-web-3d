import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

globalThis.window ??= { matchMedia: () => ({ matches: false }) };
globalThis.document ??= {};

const GameModule = await import('../Game.js');
const { Game } = GameModule;
const { NavigationHintTracker, NAV_PHASE } = await import('../NavigationHint.js');
const { Engine } = await import('../../core/Engine.js');
const { Settings } = await import('../../core/Settings.js');

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
  const game = Object.create(Game.prototype);
  Object.assign(game, {
    engine: { camera },
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
  return { game, mission, updates, get targetReads() { return targetReads; } };
}

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
    chase: { update() {} },
    terrain: { update() {} },
    fx: { update() {} },
    audio: { update() {} },
    settings: { tier: { terrainBudget: 1 } },
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
    audio: { start() {}, resume() {}, resetEngine() {}, music: { play() {} } },
    input: { touchRecon: false, releaseTouch() {} },
  });
  fixture.game.mission.begin = () => {};
  fixture.game.hud.show = () => {};
  fixture.game.flight.reset = () => {};
  fixture.game.launch();
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

  game.restart();
  assert.deepEqual(released, photos);
  assert.equal(oldDisposed, true);
  game.mission.dispose();
});

test('crash dispatches GPU burst and post impulse exactly once per event', () => {
  const game = Object.create(Game.prototype);
  game.flight = { impactSpeed: 160, position: new THREE.Vector3(), velocity: new THREE.Vector3() };
  game.mission = { fail: () => {} };
  game.audio = { impact: () => {} };
  let bursts = 0;
  game.fx = { crash: (flight, strength) => { bursts++; assert.equal(flight, game.flight); assert.equal(strength, 0.5); } };
  game._postCrashImpulse = 0;

  game.onCrash();
  assert.equal(bursts, 1);
  assert.ok(game._postCrashImpulse >= 0.5);
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
  game.engine = { applySettings() {} };
  game.terrain = { setQuality() { throw new Error('old terrain must not be retuned before rebuild'); } };
  game.water = { setQuality() {} };
  game.fx = { setQuality() {} };
  game.screens = { setQuality() {} };
  game._disposeWaterRefraction = () => {};
  let rebuild;
  game._rebuildTerrain = (next, old) => { rebuild = [next, old]; };

  game.setQuality('low');
  assert.deepEqual(rebuild, [129, 257]);
  assert.equal(game.flight, flight);
  assert.equal(game.mission, mission);
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
  let cloudDetach = 0;
  game.engine = { scene: { environment: null }, setClouds: () => cloudDetach++ };

  game.dispose();
  game.dispose();
  assert.equal(cloudDetach, 1);
  for (const name of ['water', 'mission', 'recon', 'aircraft', 'fx', 'terrain', 'sky', 'environment', 'screens', 'hud', 'audio']) {
    assert.equal(counts.get(name), 1, name);
  }
});
