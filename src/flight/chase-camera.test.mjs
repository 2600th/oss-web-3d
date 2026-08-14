import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import * as ChaseCameraModule from './ChaseCamera.js';

const { ChaseCamera } = ChaseCameraModule;

function makeFlight(speed = 120, reheat = false) {
  return {
    position: new THREE.Vector3(21000, 7000, 6000),
    forward: new THREE.Vector3(0, 0, -1),
    right: new THREE.Vector3(1, 0, 0),
    up: new THREE.Vector3(0, 1, 0),
    velocity: new THREE.Vector3(0, 0, -speed),
    airspeed: speed,
    agl: 900,
    gLoad: 1,
    reheat,
  };
}

function makeRig(speed = 120) {
  const camera = new THREE.PerspectiveCamera(58, 16 / 9, 0.1, 100000);
  const chase = new ChaseCamera(camera);
  const flight = makeFlight(speed);
  chase.reset(flight);
  return { camera, chase, flight };
}

function simulateFov(fps, speed, seconds = 1) {
  const { camera, chase, flight } = makeRig(120);
  flight.airspeed = speed;
  flight.velocity.set(0, 0, -speed);
  for (let i = 0; i < fps * seconds; i++) chase.update(1 / fps, flight);
  return camera.fov;
}

test('speed FOV profile puts sortie speeds in the useful response range', () => {
  assert.equal(
    typeof ChaseCameraModule.speedFovTarget,
    'function',
    'ChaseCamera must export the production speed-FOV profile',
  );
  const { speedFovTarget } = ChaseCameraModule;
  const bands = [
    [200, 63, 64],
    [235, 65, 66],
    [260, 66, 68],
    [380, 71, 73],
  ];
  for (const [speed, minimum, maximum] of bands) {
    const fov = speedFovTarget(speed);
    assert.ok(fov >= minimum && fov <= maximum, `${speed} m/s produced ${fov.toFixed(3)} degrees`);
  }
});

test('speed FOV profile caps reheat and reduced-motion expansion', () => {
  const { speedFovTarget } = ChaseCameraModule;
  assert.ok(speedFovTarget(500, true) <= 75, 'reheat must never exceed the 75-degree comfort cap');
  const reduced = speedFovTarget(500, true, true);
  assert.ok(reduced >= 62 && reduced <= 64, `reduced-motion boost must stay within 4-6 degrees, got ${reduced}`);
});

test('speed FOV smoothing converges equivalently at 30, 60, and 120 fps', () => {
  const settled = [30, 60, 120].map((fps) => simulateFov(fps, 260));
  assert.ok(
    Math.max(...settled) - Math.min(...settled) < 0.2,
    `one-second convergence drifted by ${(Math.max(...settled) - Math.min(...settled)).toFixed(3)} degrees`,
  );
});

test('speed FOV smoothing never exceeds 18 degrees per second', () => {
  for (const fps of [30, 60, 120]) {
    const { camera, chase, flight } = makeRig(120);
    flight.airspeed = 500;
    flight.velocity.set(0, 0, -500);
    let previous = camera.fov;
    for (let i = 0; i < fps; i++) {
      chase.update(1 / fps, flight);
      const rate = Math.abs(camera.fov - previous) * fps;
      assert.ok(rate <= 18.000001, `${fps} fps produced ${rate.toFixed(4)} degrees/second`);
      previous = camera.fov;
    }
  }
});

test('reduced-motion setting immediately selects the comfort profile', () => {
  const { camera, chase, flight } = makeRig(500);
  flight.reheat = true;
  chase.setReducedMotion(true);
  chase.reset(flight);
  assert.ok(camera.fov <= 64, `reduced-motion reset produced ${camera.fov} degrees`);
});

test('external recon lenses still cut directly back to chase FOV', () => {
  const { camera, chase, flight } = makeRig(260);
  camera.fov = 12;
  chase.update(1 / 60, flight);
  const target = ChaseCameraModule.speedFovTarget(260);
  assert.ok(Math.abs(camera.fov - target) < 0.001, `recon release eased to ${camera.fov} instead of cutting to ${target}`);
});
