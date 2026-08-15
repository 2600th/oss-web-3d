import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

globalThis.window ??= { matchMedia: () => ({ matches: false }) };
// ReconCamera allocates a 2D canvas for the exposure encoder at construction.
globalThis.document = {
  createElement: () => ({
    width: 0,
    height: 0,
    getContext: () => ({
      createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
      putImageData() {},
    }),
    toBlob() {},
  }),
};

const { Game } = await import('./Game.js');
const { ChaseCamera } = await import('../flight/ChaseCamera.js');
const { ReconCamera } = await import('./ReconCamera.js');
const { FlightModel } = await import('../flight/FlightModel.js');
const { terrainHeight } = await import('../world/heightfield.js');

const STEP = 1 / 60;

/**
 * A Game reduced to exactly what _updateCameraRig touches, driving the real
 * chase and recon rigs against a real airframe over real terrain.
 */
function makeRig() {
  const camera = new THREE.PerspectiveCamera(58, 16 / 9, 1, 60000);
  const flight = new FlightModel();
  const start = new THREE.Vector3(21000, 0, 6000);
  start.y = terrainHeight(start.x, start.z) + 1200;
  flight.reset(start, Math.PI * 0.62, 260);

  const game = Object.create(Game.prototype);
  Object.assign(game, {
    engine: { camera },
    flight,
    chase: new ChaseCamera(camera),
    recon: new ReconCamera(camera),
    mission: { posts: [], target: null },
    input: { consumePress: () => false },
    reconActive: false,
    evaluation: null,
    _reconBlend: 0,
    _chasePosition: new THREE.Vector3(),
    _chaseQuaternion: new THREE.Quaternion(),
    _chaseFov: 58,
    _reconPosition: new THREE.Vector3(),
    _reconQuaternion: new THREE.Quaternion(),
  });
  game.chase.reset(flight);
  return { game, camera, flight };
}

/**
 * Run the rig and report the largest single-frame change in view direction and
 * in field of view. Those two numbers are what "abrupt" means: a cut puts the
 * entire transition into one of them.
 */
function worstStep({ frames, reconActive, rig = makeRig() }) {
  const { game, camera, flight } = rig;
  const forward = new THREE.Vector3();
  const previousForward = camera.getWorldDirection(new THREE.Vector3()).clone();
  let previousFov = camera.fov;
  let previousPosition = camera.position.clone();
  let worstAngle = 0;
  let worstFovRatio = 1;
  let worstJump = 0;

  for (let i = 0; i < frames; i++) {
    game.reconActive = typeof reconActive === 'function' ? reconActive(i) : reconActive;
    flight.update(STEP, { pitch: 0, roll: 0, yaw: 0, throttle: 0.82, brake: 0 });
    game._updateCameraRig(STEP, flight);

    camera.getWorldDirection(forward);
    worstAngle = Math.max(worstAngle, forward.angleTo(previousForward));
    const ratio = camera.fov / previousFov;
    worstFovRatio = Math.max(worstFovRatio, ratio > 1 ? ratio : 1 / ratio);
    // Measured against the airframe, so the aircraft's own 4 m per frame of
    // travel is not counted as camera motion.
    const jump = camera.position.distanceTo(previousPosition) -
      flight.velocity.length() * STEP;
    worstJump = Math.max(worstJump, jump);

    previousForward.copy(forward);
    previousFov = camera.fov;
    previousPosition.copy(camera.position);
  }
  return { worstAngle, worstFovRatio, worstJump, blend: game._reconBlend, game };
}

test('entering and leaving recon never moves the view in a single frame', () => {
  // 40 frames of chase to settle, then hold recon, then release it. Both edges
  // and the full travel in each direction are inside the window.
  const result = worstStep({
    frames: 40 + 60 + 60,
    reconActive: (i) => i >= 40 && i < 100,
  });

  // A cut was most of a right angle, a 4x lens change and 31 m of dolly in one
  // frame. An eased 0.26-0.36 s transition cannot exceed a small fraction of it.
  assert.ok(
    result.worstAngle < THREE.MathUtils.degToRad(12),
    `view swung ${THREE.MathUtils.radToDeg(result.worstAngle).toFixed(1)} degrees in one frame`,
  );
  assert.ok(
    result.worstFovRatio < 1.35,
    `field of view changed by a factor of ${result.worstFovRatio.toFixed(2)} in one frame`,
  );
  assert.ok(
    result.worstJump < 6,
    `camera jumped ${result.worstJump.toFixed(1)} m relative to the airframe in one frame`,
  );
});

test('the blend resolves fully in both directions', () => {
  const entering = worstStep({ frames: 40 + 40, reconActive: (i) => i >= 40 });
  assert.equal(entering.blend, 1, 'holding recon must reach the optic exactly');

  const leaving = worstStep({ frames: 40 + 40 + 40, reconActive: (i) => i >= 40 && i < 80 });
  assert.equal(leaving.blend, 0, 'releasing recon must return to the chase exactly');
});

test('a settled recon view is the recon pose, not a blend of the two', () => {
  const rig = makeRig();
  const { game, camera, flight } = rig;
  for (let i = 0; i < 90; i++) {
    game.reconActive = i >= 20;
    flight.update(STEP, { pitch: 0, roll: 0, yaw: 0, throttle: 0.82, brake: 0 });
    game._updateCameraRig(STEP, flight);
  }
  // The nose installation sits 5.4 m ahead of the airframe origin, so a settled
  // recon view is in front of the aircraft rather than behind it. Any residual
  // chase weight would put it 26 m astern.
  const ahead = camera.position.clone().sub(flight.position).dot(flight.forward);
  assert.ok(ahead > 4, `settled recon camera sat ${ahead.toFixed(1)} m along the nose axis`);
  assert.equal(camera.fov, game.recon._fovSmoothed);
});

test('a settled chase view is unaffected by the recon rig ever having run', () => {
  const rig = makeRig();
  const { game, camera, flight } = rig;
  for (let i = 0; i < 140; i++) {
    game.reconActive = i >= 20 && i < 60;
    flight.update(STEP, { pitch: 0, roll: 0, yaw: 0, throttle: 0.82, brake: 0 });
    game._updateCameraRig(STEP, flight);
  }
  const behind = camera.position.clone().sub(flight.position).dot(flight.forward);
  assert.ok(behind < -15, `settled chase camera sat ${behind.toFixed(1)} m along the nose axis`);
  assert.ok(camera.fov > 40, `chase field of view returned as ${camera.fov.toFixed(1)} degrees`);
});
