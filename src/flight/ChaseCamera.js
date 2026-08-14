import * as THREE from 'three';
import { terrainHeight, maxHeightAlong } from '../world/heightfield.js';

/**
 * Cinematic chase camera.
 *
 * Everything here is exponential smoothing of the form
 *   x += (target - x) * (1 - exp(-lambda * dt))
 * rather than the usual `lerp(x, target, 0.1)`. The naive version makes camera
 * response depend on frame rate, so the same manoeuvre feels different at 45
 * and 144 fps — which is precisely the sort of inconsistency you can feel but
 * cannot name.
 *
 * The boom is anchored to a *blend* of the airframe's own axes and world up.
 * Rigidly bolting the camera to the aircraft makes rolls nauseating and hides
 * the horizon; fully world-aligned makes the aircraft feel weightless. Around
 * 78% airframe reads as "camera operator chasing a jet".
 */

const _boom = new THREE.Vector3();
const _target = new THREE.Vector3();
const _look = new THREE.Vector3();
const _up = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();

const BASE_FOV = 58;
const NORMAL_FOV_BOOST = 16;
const REDUCED_MOTION_FOV_BOOST = 6;
const REHEAT_FOV_BOOST = 1;
const MAX_FOV_RATE = 18;

/**
 * Chase-lens target for the current true airspeed.
 *
 * The response begins below the sortie's normal cruise speed, so launch does
 * not spend its first minute looking almost static. Keeping this calculation
 * pure also gives comfort settings and camera cuts one authoritative target.
 */
export function speedFovTarget(speed, reheat = false, reducedMotion = false) {
  const finiteSpeed = Number.isFinite(speed) ? speed : 0;
  const speedT = THREE.MathUtils.clamp((finiteSpeed - 120) / 300, 0, 1);
  const maximumBoost = reducedMotion ? REDUCED_MOTION_FOV_BOOST : NORMAL_FOV_BOOST;
  const speedBoost = maximumBoost * Math.pow(speedT, 0.8);
  const reheatBoost = reheat ? REHEAT_FOV_BOOST : 0;
  const cap = reducedMotion ? BASE_FOV + REDUCED_MOTION_FOV_BOOST : 75;
  return Math.min(cap, BASE_FOV + speedBoost + reheatBoost);
}

export class ChaseCamera {
  constructor(camera) {
    this.camera = camera;

    this.distance = 26;
    this.height = 6.0;
    this.lookAhead = 62;

    this.baseFov = BASE_FOV;
    this.maxFovBoost = NORMAL_FOV_BOOST;
    this.reducedMotion = false;

    /** Damped camera-to-aircraft offset, in world space. */
    this.offset = new THREE.Vector3();
    this.position = new THREE.Vector3();
    this.lookAt = new THREE.Vector3();
    this.upVector = new THREE.Vector3(0, 1, 0);

    this.shake = 0;
    this._shakeTime = 0;
    this._initialised = false;
    this._fov = this.baseFov;
    // The FOV value this camera last wrote. NaN until the first update, so the
    // first frame always counts as a repossession and snaps. See update().
    this._fovApplied = NaN;
    this._rollLag = 0;
  }

  setReducedMotion(enabled) {
    this.reducedMotion = Boolean(enabled);
  }

  /**
   * Cut to the aircraft. Every damped quantity is snapped, not just the boom.
   *
   * Clearing _initialised used to snap the offset only, which left `lookAt` at
   * wherever it was — (0, 0, 0) on the first sortie — while the aim point is
   * 21 km out over the range. At the 9.0 lambda used below that is a ~0.4 s
   * whip across the entire world on every launch, which is the first thing the
   * player sees. A cut is not a transition and nothing about it should ease.
   */
  reset(flight) {
    this._initialised = false;
    this.update(0.016, flight, 0);
  }

  /**
   * @param {number} dt
   * @param {FlightModel} flight
   * @param {number} extraShake  0..1 from impacts, terrain proximity, reheat
   */
  update(dt, flight, extraShake = 0) {
    const cut = !this._initialised;
    const speed = flight.airspeed;
    const speedT = THREE.MathUtils.clamp((speed - 120) / 380, 0, 1);

    // Airframe axes blended toward world up, so the boom leans with a roll but
    // never fully inverts with it.
    _up.copy(flight.up).lerp(UP_WORLD, 0.22).normalize();

    // Sit behind the aircraft, biased toward where it is actually going rather
    // than where its nose points. During a hard pull this opens the frame up
    // and shows the manoeuvre instead of pressing into the tailpipe.
    _boom.copy(flight.forward).lerp(_tmp.copy(flight.velocity).normalize(), 0.3).normalize();

    const dist = this.distance * (1 + 0.26 * speedT);

    // Smooth the *offset from the aircraft*, never the camera's world position.
    // Damping a world position against a target moving at 266 m/s leaves a
    // steady-state lag of speed/lambda — measured at 24 m of extra trail, which
    // shrank the aircraft to a speck and got worse the faster you flew. In the
    // aircraft's frame the same damping only smooths changes in the boom.
    _target
      .set(0, 0, 0)
      .addScaledVector(_boom, -dist)
      .addScaledVector(_up, this.height + 2.2 * speedT);

    if (cut) this.offset.copy(_target);
    else this.offset.lerp(_target, 1 - Math.exp(-5.5 * dt));

    this.position.copy(flight.position).add(this.offset);

    // Keep the boom out of the mountain. Sampling the ridge line between the
    // aircraft and the camera matters more than a point test: flying up a
    // valley wall, the rock behind you rises faster than the point under you.
    const ridge = maxHeightAlong(
      flight.position.x,
      flight.position.z,
      this.position.x,
      this.position.z,
      5,
    );
    const minY = Math.max(ridge, terrainHeight(this.position.x, this.position.z)) + 14;
    if (this.position.y < minY) {
      this.position.y = minY;
      this.offset.subVectors(this.position, flight.position);
    }

    // Aim ahead along the flight path so fast, low passes lead the terrain.
    _look
      .copy(flight.position)
      .addScaledVector(flight.forward, this.lookAhead * (0.55 + 0.75 * speedT))
      .addScaledVector(flight.up, 2.0);
    if (cut) this.lookAt.copy(_look);
    else this.lookAt.lerp(_look, 1 - Math.exp(-9.0 * dt));

    // A touch of roll lag: the camera rolls into a bank slightly after the jet.
    const bank = Math.atan2(flight.right.y, flight.up.y);
    if (cut) this._rollLag = bank;
    else this._rollLag += (bank - this._rollLag) * (1 - Math.exp(-4.2 * dt));
    this.upVector.copy(UP_WORLD).applyAxisAngle(flight.forward, -this._rollLag * 0.55).normalize();

    // ---- vibration ---------------------------------------------------------
    // Deliberately small and high frequency. Big camera shake in a flight game
    // destroys the sense of speed rather than adding to it, because the eye
    // loses the reference frame it was using to judge motion.
    const gShake = THREE.MathUtils.clamp((Math.abs(flight.gLoad) - 3.2) / 7, 0, 1);
    const speedShake = Math.pow(speedT, 2.2) * 0.5;
    const reheatShake = flight.reheat ? 0.22 : 0;
    const proximity = THREE.MathUtils.clamp(1 - flight.agl / 260, 0, 1) * 0.45;
    const amount = Math.min(1, gShake + speedShake + reheatShake + proximity + extraShake);
    if (cut) this.shake = amount;
    else this.shake += (amount - this.shake) * (1 - Math.exp(-7 * dt));

    this._shakeTime += dt * (26 + 40 * speedT);
    const s = this.shake * 0.5;
    const sx = Math.sin(this._shakeTime * 1.7) * Math.sin(this._shakeTime * 0.53) * s;
    const sy = Math.sin(this._shakeTime * 2.3 + 1.1) * Math.sin(this._shakeTime * 0.41) * s;

    this.camera.position.copy(this.position);
    this.camera.up.copy(this.upVector);
    _m.lookAt(this.camera.position, this.lookAt, this.upVector);
    _q.setFromRotationMatrix(_m);
    this.camera.quaternion.copy(_q);
    this.camera.rotateX(sy * 0.0032);
    this.camera.rotateY(sx * 0.0032);
    this.camera.rotateZ(sx * 0.0022);

    // Speed-linked FOV. Small — 16 degrees over the whole range — because the
    // effect works best when the player never consciously notices it.
    //
    // The camera is shared, and this class is not always the one holding it:
    // the game stops calling update() while the recon camera is up and drives
    // the same PerspectiveCamera down to a zoom step as narrow as 8.5 degrees,
    // and the title sequence parks it at 42. So `_fov` cannot be trusted as the
    // camera's state — after any of those it describes a lens nobody is
    // wearing, and easing from it wrote a 50-degree jump into a single frame on
    // every recon release.
    //
    // Detect the repossession by comparing the camera against the value we last
    // wrote, and cut rather than ease. Easing from the camera's actual FOV was
    // the other candidate and is worse in the one place it matters: releasing
    // recon already hard-cuts the viewpoint 26 m back behind the aircraft, and
    // sliding a telephoto open over a second and a half on top of that reads as
    // a lens fault rather than as a transition.
    const repossessed = this.camera.fov !== this._fovApplied;
    const targetFov = speedFovTarget(speed, flight.reheat, this.reducedMotion);
    if (cut || repossessed) this._fov = targetFov;
    else {
      const desiredStep = (targetFov - this._fov) * (1 - Math.exp(-5 * dt));
      const maxStep = MAX_FOV_RATE * Math.max(0, dt);
      this._fov += THREE.MathUtils.clamp(desiredStep, -maxStep, maxStep);
    }
    if (Math.abs(this.camera.fov - this._fov) > 0.01) {
      this.camera.fov = this._fov;
      this.camera.updateProjectionMatrix();
    }
    this._fovApplied = this.camera.fov;

    this.camera.updateMatrixWorld();
    this._initialised = true;
  }
}

const UP_WORLD = new THREE.Vector3(0, 1, 0);
