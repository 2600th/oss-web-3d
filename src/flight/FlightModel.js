import * as THREE from 'three';
import { terrainHeight, terrainNormal } from '../world/heightfield.js';

/**
 * Arcade flight model with real aerodynamic bones.
 *
 * The split is deliberate:
 *
 *   Attitude is *rate controlled*. The stick commands body rates, which the
 *   airframe reaches through a first-order lag. That is what makes the aircraft
 *   feel responsive and learnable rather than like a simulator you fight.
 *
 *   Velocity is *physical*. Thrust, drag and gravity are genuine forces in
 *   newtons against a real mass, air density falls off with altitude, and the
 *   velocity vector is dragged toward the nose by a grip term standing in for
 *   lift. That is what makes it feel like an aircraft and not a spaceship:
 *   you carry energy through a turn, you sink when slow, and you have to trade
 *   height for speed.
 *
 * Numbers are MiG-21-shaped (8.7 t, 23 m² wing, 38/68 kN dry/reheat), then bent
 * where authenticity and playability disagreed — the real jet's sustained turn
 * rate at 250 m/s is about 20 deg/s, which is not a game.
 */

const GRAVITY = 9.80665;
const SEA_LEVEL_DENSITY = 1.225;
const SCALE_HEIGHT = 8500; // metres; standard atmosphere exponential fit

export const AIRCRAFT = {
  mass: 8700,
  wingArea: 23,
  thrustDry: 38000,
  thrustReheat: 71000,
  dragCoefficient: 0.0271,
  airbrakeDrag: 0.075,

  // Attitude authority, radians/second at full deflection and full authority.
  maxRollRate: 3.5,
  maxPitchRate: 1.05,
  maxYawRate: 0.42,

  // First-order lag on reaching commanded rate. Roll is crisp, pitch has mass.
  rollAgility: 5.2,
  pitchAgility: 3.4,
  yawAgility: 2.8,

  // Aerodynamic damping — the airframe resists rotation more at speed.
  rateDamping: 2.1,

  stallSpeed: 92,
  cornerSpeed: 235, // above this you have full control authority
  maxSpeed: 610,

  /**
   * Structural/pilot G limit. This is what stops a rate-controlled aircraft
   * from behaving like a cursor: because the velocity vector chases the nose,
   * a fixed pitch rate produces load proportional to airspeed, and an
   * unrestrained 1.05 rad/s pull at 300 m/s was measured at 19 G. Capping the
   * commanded rate at nLimit·g/v also reproduces corner speed for free — turn
   * rate peaks in the middle of the envelope and falls off at both ends, which
   * is the single most recognisable thing about how a fast jet handles.
   */
  gLimit: 11.5,

  // How hard the velocity vector is pulled onto the nose, per second.
  gripLow: 0.35,
  gripHigh: 2.9,
};

const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _n = { x: 0, y: 1, z: 0 };

export function airDensity(altitude) {
  return SEA_LEVEL_DENSITY * Math.exp(-Math.max(altitude, 0) / SCALE_HEIGHT);
}

export class FlightModel {
  constructor() {
    this.position = new THREE.Vector3();
    this.velocity = new THREE.Vector3();
    this.orientation = new THREE.Quaternion();

    /** Body rates: x = pitch, y = yaw, z = roll (rad/s). */
    this.rates = new THREE.Vector3();

    this.forward = new THREE.Vector3(0, 0, -1);
    this.up = new THREE.Vector3(0, 1, 0);
    this.right = new THREE.Vector3(1, 0, 0);

    this.throttle = 0.72;
    this.reheat = false;
    this.airspeed = 0;
    this.machish = 0;
    this.altitude = 0;
    this.agl = 0;
    this.groundHeight = 0;
    this.gLoad = 1;
    this.angleOfAttack = 0;
    this.stalling = false;
    this.stallFactor = 0;
    this.crashed = false;
    this.throttleSmoothed = 0.72;

    this._prevVelocity = new THREE.Vector3();
  }

  reset(position, headingRadians = 0, speed = 250) {
    this.position.copy(position);
    this.orientation.setFromEuler(new THREE.Euler(0, headingRadians, 0, 'YXZ'));
    this._refreshAxes();
    this.velocity.copy(this.forward).multiplyScalar(speed);
    this.rates.set(0, 0, 0);
    this.throttle = 0.78;
    this.throttleSmoothed = 0.78;
    this.crashed = false;
    this.stalling = false;
    this.stallFactor = 0;
    this.gLoad = 1;
    this._prevVelocity.copy(this.velocity);
    this._updateDerived();
  }

  _refreshAxes() {
    this.forward.set(0, 0, -1).applyQuaternion(this.orientation);
    this.up.set(0, 1, 0).applyQuaternion(this.orientation);
    this.right.set(1, 0, 0).applyQuaternion(this.orientation);
  }

  _updateDerived() {
    this.airspeed = this.velocity.length();
    this.altitude = this.position.y;
    this.groundHeight = terrainHeight(this.position.x, this.position.z);
    this.agl = this.altitude - this.groundHeight;
    // "Mach" here is only ever shown as an indicator; a true speed of sound
    // model would need temperature, and nothing in the experience needs it.
    this.machish = this.airspeed / 300;
  }

  /**
   * @param {number} dt      seconds
   * @param {object} control {pitch, roll, yaw, throttle, brake} in -1..1 / 0..1
   */
  update(dt, control) {
    if (this.crashed) return;

    this.throttle = control.throttle;
    // Engines spool; the sound and the thrust both need to lag the lever.
    this.throttleSmoothed += (this.throttle - this.throttleSmoothed) * (1 - Math.exp(-2.4 * dt));
    this.reheat = this.throttle > 0.86;

    const speed = this.velocity.length();

    // ---- control authority -------------------------------------------------
    // Below corner speed the surfaces have less to bite on. This is the single
    // most important term for making the aircraft feel like it has a flight
    // envelope instead of a joystick.
    const authority = clamp(
      0.16 + 0.84 * smoothstep(AIRCRAFT.stallSpeed * 0.55, AIRCRAFT.cornerSpeed, speed),
      0,
      1,
    );
    // Very high speed stiffens control, which stops the jet from becoming a
    // twitchy dart when it is doing 550 m/s.
    const highSpeedStiffen = 1 - 0.42 * smoothstep(AIRCRAFT.cornerSpeed * 1.6, AIRCRAFT.maxSpeed, speed);

    // Load-limited pitch rate. Below ~100 m/s the aerodynamic cap bites first;
    // above it, G does.
    const gLimitedRate = (AIRCRAFT.gLimit * GRAVITY) / Math.max(speed, 60);
    const pitchCap = Math.min(AIRCRAFT.maxPitchRate * authority * highSpeedStiffen, gLimitedRate);

    const targetPitch = -control.pitch * pitchCap;
    const targetRoll = -control.roll * AIRCRAFT.maxRollRate * authority;
    const targetYaw = -control.yaw * Math.min(AIRCRAFT.maxYawRate * authority, gLimitedRate * 0.5);
    this.turnRateLimit = pitchCap;

    this.rates.x += (targetPitch - this.rates.x) * (1 - Math.exp(-AIRCRAFT.pitchAgility * dt));
    this.rates.z += (targetRoll - this.rates.z) * (1 - Math.exp(-AIRCRAFT.rollAgility * dt));
    this.rates.y += (targetYaw - this.rates.y) * (1 - Math.exp(-AIRCRAFT.yawAgility * dt));

    // ---- stall -------------------------------------------------------------
    // A soft, recoverable departure: authority bleeds away, the nose drops and
    // the wings drift level. Nothing here is punishing; it just makes low speed
    // feel dangerous, which is the point.
    this.stallFactor = 1 - smoothstep(AIRCRAFT.stallSpeed * 0.72, AIRCRAFT.stallSpeed * 1.5, speed);
    this.stalling = this.stallFactor > 0.25;

    // ---- integrate attitude ------------------------------------------------
    _q.setFromEuler(new THREE.Euler(this.rates.x * dt, this.rates.y * dt, this.rates.z * dt, 'XYZ'));
    this.orientation.multiply(_q).normalize();
    this._refreshAxes();

    if (this.stallFactor > 0.01) {
      // Gravity acting on a wing that is no longer flying: pitch down, roll out.
      const drop = this.stallFactor * 0.9 * dt;
      _q.setFromAxisAngle(this.right, -drop * 0.55);
      this.orientation.premultiply(_q);
      // Level the wings by rotating about the world-up projection.
      const bank = Math.atan2(this.right.y, this.up.y);
      _q.setFromAxisAngle(this.forward, bank * drop * 1.2);
      this.orientation.premultiply(_q);
      this.orientation.normalize();
      this._refreshAxes();
    }

    // ---- forces ------------------------------------------------------------
    const rho = airDensity(this.position.y);
    const densityRatio = rho / SEA_LEVEL_DENSITY;
    const q = 0.5 * rho * speed * speed * AIRCRAFT.wingArea;

    // Thrust falls off with air density, which is why the jet feels heavy high
    // up and why diving to gain speed is a real tactic here.
    const thrustMax =
      (this.reheat ? AIRCRAFT.thrustReheat : AIRCRAFT.thrustDry) * (0.42 + 0.58 * densityRatio);
    const thrust = thrustMax * clamp(this.throttleSmoothed, 0, 1);

    // Angle of attack, used for induced drag and for the visual pitch of the
    // airframe relative to its flight path.
    if (speed > 1) {
      _v.copy(this.velocity).divideScalar(speed);
      this.angleOfAttack = Math.asin(clamp(-_v.dot(this.up), -1, 1));
    } else {
      this.angleOfAttack = 0;
    }

    const cd =
      AIRCRAFT.dragCoefficient +
      0.14 * this.angleOfAttack * this.angleOfAttack +
      AIRCRAFT.airbrakeDrag * control.brake;

    const accel = _v2.set(0, 0, 0);
    accel.addScaledVector(this.forward, thrust / AIRCRAFT.mass);
    if (speed > 0.01) {
      const dragAccel = (q * cd) / AIRCRAFT.mass;
      accel.addScaledVector(this.velocity, -dragAccel / speed);
    }
    accel.y -= GRAVITY;

    this.velocity.addScaledVector(accel, dt);

    // ---- grip (lift, expressed as flight-path convergence) ------------------
    // Rather than resolving a lift vector, rotate the velocity toward the nose.
    // The two are equivalent for a coordinated aircraft, but this formulation
    // never blows up at low speed and gives direct control over how much the
    // aircraft "carries" through a turn.
    const newSpeed = this.velocity.length();
    if (newSpeed > 1) {
      const gripBase = THREE.MathUtils.lerp(
        AIRCRAFT.gripLow,
        AIRCRAFT.gripHigh,
        smoothstep(AIRCRAFT.stallSpeed, AIRCRAFT.cornerSpeed * 1.25, newSpeed),
      );
      const grip = gripBase * (1 - this.stallFactor * 0.85) * (0.45 + 0.55 * densityRatio);
      _v.copy(this.velocity).divideScalar(newSpeed);
      const t = 1 - Math.exp(-grip * dt);
      _v.lerp(this.forward, t).normalize();
      this.velocity.copy(_v).multiplyScalar(newSpeed);
    }

    if (newSpeed > AIRCRAFT.maxSpeed) {
      this.velocity.multiplyScalar(AIRCRAFT.maxSpeed / newSpeed);
    }

    this.position.addScaledVector(this.velocity, dt);

    // ---- readouts ----------------------------------------------------------
    _v.subVectors(this.velocity, this._prevVelocity).divideScalar(Math.max(dt, 1e-4));
    _v.y += GRAVITY; // specific force, i.e. what the pilot and the airframe feel
    this.gLoad = _v.length() / GRAVITY;
    this._prevVelocity.copy(this.velocity);

    this._updateDerived();
  }

  /**
   * Ground collision. Samples slightly ahead along the flight path as well as
   * underneath, because at 250 m/s a per-frame point test under the aircraft
   * misses a ridge entirely between frames.
   */
  checkTerrainCollision(dt, clearance = 12) {
    if (this.crashed) return false;
    const steps = 4;
    // Starts at i = 0, the current position. update() has already moved the
    // aircraft by the time this runs, so beginning at i = 1 skipped the whole
    // step just travelled: a jet that ended the frame inside a ridge went
    // undetected whenever the four predictive samples came out the far side.
    for (let i = 0; i <= steps; i++) {
      const t = (dt * i) / steps;
      const x = this.position.x + this.velocity.x * t;
      const y = this.position.y + this.velocity.y * t;
      const z = this.position.z + this.velocity.z * t;
      if (y - terrainHeight(x, z) < clearance) {
        this.crashed = true;
        this.impactPoint = new THREE.Vector3(x, terrainHeight(x, z), z);
        terrainNormal(x, z, 8, _n);
        this.impactNormal = new THREE.Vector3(_n.x, _n.y, _n.z);
        this.impactSpeed = this.velocity.length();
        // Put the aircraft on the ground it just hit. update() returns early
        // once crashed, so without this the jet hangs wherever the step left it
        // — often a hundred metres clear of the slope, in mid-air — and holds
        // that pose for the two seconds before the failure screen. Detecting
        // the impact a fraction of a second early is what buys the margin; the
        // aircraft still has to arrive.
        this.position.set(x, this.impactPoint.y + clearance * 0.35, z);
        this.velocity.set(0, 0, 0);
        // update() returns early once crashed, so this is the last chance to
        // recompute altitude, ground height, AGL and airspeed. Without it the
        // wreck holds the readings it had a moment before impact for the whole
        // two seconds before the failure screen, and the HUD, camera proximity,
        // FX and audio all keep consuming them.
        this._updateDerived();
        return true;
      }
    }
    return false;
  }
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function smoothstep(e0, e1, x) {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}
