import * as THREE from 'three/webgpu';
import { terrainHeight } from '../world/terrain/heightfield.js';

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _up = new THREE.Vector3();

/**
 * Camera rig. Foundation provides the chase view; the camera owner adds the
 * cockpit / HUD-only first-person views, look-around, target-lock framing,
 * missile cam, kill cam and shake.
 *
 * Modes: 'chase' | 'cockpit' | 'hud'. `extraShake` is an additive 0..1 trauma.
 */
export class CameraRig {
  constructor(camera) {
    this.camera = camera;
    this.mode = 'chase';
    this.position = new THREE.Vector3();
    this.quat = new THREE.Quaternion();
    this.trauma = 0;
    this.baseFov = 62;
    this._lagQuat = new THREE.Quaternion();
    this._initialised = false;
  }

  reset(flight) {
    this._lagQuat.copy(flight.orientation);
    this._initialised = true;
  }

  addTrauma(t) { this.trauma = Math.min(1, this.trauma + t); }

  update(dt, flight, aircraft) {
    if (!this._initialised) this.reset(flight);
    const cam = this.camera;
    // Orientation lags the aircraft slightly so rolls read on screen.
    this._lagQuat.slerp(flight.orientation, 1 - Math.exp(-7 * dt));

    if (this.mode === 'chase') {
      const dist = 17 + Math.min(flight.airspeed, 600) * 0.008;
      _v.set(0, 3.6, dist).applyQuaternion(this._lagQuat);
      this.position.copy(flight.position).add(_v);
      const ground = terrainHeight(this.position.x, this.position.z) + 4;
      if (this.position.y < ground) this.position.y = ground;
      _up.set(0, 1, 0).applyQuaternion(this._lagQuat);
      _v.set(0, 0, -60).applyQuaternion(flight.orientation).add(flight.position);
      cam.position.copy(this.position);
      cam.up.copy(_up);
      cam.lookAt(_v);
    } else {
      // first-person: eye at cockpit socket, aligned with the airframe
      _v.copy(aircraft?.sockets.cockpit.position ?? _v.set(0, 0.95, -3.1)).applyQuaternion(flight.orientation);
      cam.position.copy(flight.position).add(_v);
      cam.quaternion.copy(flight.orientation);
    }

    // speed FOV
    const fov = this.baseFov + Math.min(Math.max(flight.airspeed - 200, 0), 400) * 0.02;
    cam.fov += (fov - cam.fov) * (1 - Math.exp(-3 * dt));

    // shake
    if (this.trauma > 0) {
      const s = this.trauma * this.trauma;
      const t = performance.now() * 0.001;
      _q.setFromEuler(new THREE.Euler(
        Math.sin(t * 37.1) * 0.02 * s, Math.sin(t * 41.7 + 1) * 0.02 * s, Math.sin(t * 29.3 + 2) * 0.03 * s,
      ));
      cam.quaternion.multiply(_q);
      this.trauma = Math.max(0, this.trauma - dt * 1.4);
    }
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
  }
}
