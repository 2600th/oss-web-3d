import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Input } from './Input.js';
import { ChaseCamera } from '../flight/ChaseCamera.js';
import { FlightModel } from '../flight/FlightModel.js';

class Target {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, fn) { this.listeners.set(type, fn); }
  removeEventListener(type, fn) { if (this.listeners.get(type) === fn) this.listeners.delete(type); }
  fire(type, event) { this.listeners.get(type)?.(event); }
}

{
  const oldNavigator = globalThis.navigator;
  let samples = 0;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {
    getGamepads() { samples++; return [{ connected: true, axes: [0, 0, 0], buttons: [] }]; },
  }});
  const target = new Target();
  const input = new Input(target);
  let prevented = false;
  target.fire('keydown', { code: 'ControlLeft', repeat: false, ctrlKey: true, altKey: false, metaKey: false, preventDefault() { prevented = true; } });
  input.update(0.1);
  assert.ok(input.throttle < 0.72, 'Control must reach the throttle-down binding');
  assert.equal(prevented, false, 'modifier shortcuts must not be intercepted');
  assert.equal(samples, 1, 'gamepad state must be snapshotted once per frame');
  input.dispose();
  assert.equal(target.listeners.size, 0, 'Input must remove all listeners it owns');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: oldNavigator });
}

{
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
  const chase = new ChaseCamera(camera);
  const flight = {
    position: new THREE.Vector3(21000, 7000, 6000),
    forward: new THREE.Vector3(0, 0, -1), right: new THREE.Vector3(1, 0, 0), up: new THREE.Vector3(0, 1, 0),
    velocity: new THREE.Vector3(0, 0, -260), airspeed: 260, agl: 900, gLoad: 1, reheat: false,
  };
  chase.reset(flight);
  assert.ok(chase.lookAt.distanceTo(flight.position) < 100, 'reset must snap aim near the aircraft, not ease from world origin');
  camera.fov = 12;
  chase.update(1 / 60, flight);
  assert.ok(camera.fov > 50, 'repossessing the camera after recon must restore chase FOV in one frame');
}

{
  const flight = new FlightModel();
  flight.position.set(0, -10000, 0);
  flight.velocity.set(0, 0, 500);
  assert.equal(flight.checkTerrainCollision(1 / 30), true, 'collision must inspect the segment just travelled');
  assert.equal(flight.velocity.length(), 0, 'impact must stop the simulated aircraft');
}

console.log('input, chase and flight lifecycle contracts passed');
