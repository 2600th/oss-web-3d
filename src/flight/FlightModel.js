import * as THREE from 'three';
import { terrainHeight } from '../world/heightfield.js';
import { REHEAT_THRESHOLD } from './burner.js';

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

  /**
   * Induced-drag denominator, pi·AR·e for a delta wing (AR 2.2, e 0.78).
   *
   * Drag used to be parasitic plus a small angle-of-attack term, which meant a
   * hard turn cost almost nothing: the aircraft held 266 m/s all the way round
   * and the turn rate never improved, because turn rate at fixed load is
   * inversely proportional to speed. Lift-induced drag grows with the *square*
   * of the load factor, so a real turn bleeds energy hard and the rate climbs
   * as it does. That trade — height and speed for degrees per second — is the
   * whole of fighter energy management, and without this term the game has
   * none of it.
   */
  inducedDragSpan: Math.PI * 2.2 * 0.78,

  /**
   * Maximum lift coefficient the wing can actually generate.
   *
   * Without this the induced-drag term is a runaway: demanding load at low
   * speed asks for a lift coefficient no wing can produce, which raises drag,
   * which lowers speed, which raises the demanded coefficient again. Measured
   * on the first build of the term — a high-sensitivity turn wound itself from
   * 266 m/s down to 130 and reported 1682 G. A real wing simply stalls instead,
   * and 1.5 is the delta's rough ceiling.
   */
  maxLiftCoefficient: 1.5,

  // Attitude authority, radians/second at full deflection and full authority.
  maxRollRate: 4.2,
  maxPitchRate: 1.05,
  maxYawRate: 0.42,

  // First-order lag on reaching commanded rate. Roll is crisp, pitch has mass.
  //
  // Roll was 5.2 (tau 0.19 s) against a 3.5 rad/s ceiling, which put a 72-degree
  // bank about 1.2 s away. A bank that takes over a second to establish is the
  // difference between "aim the aircraft" and "ask the aircraft"; every arcade
  // flight game in this lineage establishes one in roughly half a second, and
  // 7.4 rad/s of lag against a 4.2 rad/s ceiling is what that costs.
  rollAgility: 7.4,
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
   *
   * 9.0 rather than the previous 11.5 because the HUD shows this number. A
   * limit the assist could not reach was harmless; the assist now commands load
   * directly, so an 11.5 ceiling meant ordinary turns reading 9-11 G and the
   * gauge stopped meaning anything. 9 is the recognisable fighter figure and
   * the assist's own demand ladder tops out exactly on it.
   */
  gLimit: 9.0,

  // How hard the velocity vector is pulled onto the nose, per second.
  gripLow: 0.35,
  gripHigh: 2.9,
};

const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();

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
    this.altitude = 0;
    this.agl = 0;
    this.groundHeight = 0;
    this.gLoad = 1;
    this.angleOfAttack = 0;
    this.stalling = false;
    this.stallFactor = 0;
    this.crashed = false;
    this.throttleSmoothed = 0.72;

    /**
     * The rate ceilings this frame's control inputs are actually scaled by.
     *
     * Published because AssistController has to command in radians per second —
     * it computes the pitch rate a coordinated turn needs from g, bank and true
     * airspeed — and then normalise that into the -1..1 stick this model
     * expects. Re-deriving the caps there would duplicate the authority curve,
     * the high-speed stiffening and the G limit in a second place, and the two
     * copies would drift the first time either is tuned.
     */
    this.pitchAuthority = AIRCRAFT.maxPitchRate;
    this.rollAuthority = AIRCRAFT.maxRollRate;

    /** Where the aircraft entered the terrain clearance envelope, once crashed. */
    this.impactPoint = new THREE.Vector3();
    this.impactVelocity = new THREE.Vector3();
    this.impactNormal = new THREE.Vector3(0, 1, 0);
    this.impactSpeed = 0;

    this._prevVelocity = new THREE.Vector3();
  }

  reset(position, headingRadians = 0, speed = 250) {
    this.position.copy(position);
    this.orientation.setFromEuler(_e.set(0, headingRadians, 0, 'YXZ'));
    this._refreshAxes();
    this.velocity.copy(this.forward).multiplyScalar(speed);
    this.rates.set(0, 0, 0);
    this.throttle = 0.78;
    this.throttleSmoothed = 0.78;
    this.crashed = false;
    this.stalling = false;
    this.stallFactor = 0;
    this.gLoad = 1;
    this.impactVelocity.set(0, 0, 0);
    this.impactNormal.set(0, 1, 0);
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
    // On the *smoothed* lever, and at the same threshold the visual burner
    // uses. This read the raw lever while burner.js ramped the flame from the
    // smoothed one at 0.84, so slamming the throttle open delivered reheat
    // thrust a beat before the flame appeared, and the two disagreed either
    // side of the detent. The comment directly above says the thrust should lag
    // the lever; now it does.
    this.reheat = this.throttleSmoothed > REHEAT_THRESHOLD;

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
    const rollCap = AIRCRAFT.maxRollRate * authority;
    this.pitchAuthority = pitchCap;
    this.rollAuthority = rollCap;

    const targetPitch = -control.pitch * pitchCap;
    const targetRoll = -control.roll * rollCap;
    const targetYaw = -control.yaw * Math.min(AIRCRAFT.maxYawRate * authority, gLimitedRate * 0.5);

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
    // Module-scope Euler, like every other scratch object here. This ran at
    // 120 Hz and was the only allocation left in the physics step.
    _e.set(this.rates.x * dt, this.rates.y * dt, this.rates.z * dt, 'XYZ');
    _q.setFromEuler(_e);
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

    // Lift-induced drag. The load factor is read from the body pitch rate the
    // airframe actually reached this step — omega·V is the centripetal
    // acceleration the wing is producing — rather than from the previous
    // frame's gLoad, which lags by a step and feeds back on itself.
    const liftLoad = 1 + (Math.abs(this.rates.x) * speed) / GRAVITY;
    const liftCoefficient = Math.min(
      (liftLoad * AIRCRAFT.mass * GRAVITY) / Math.max(q, 1),
      AIRCRAFT.maxLiftCoefficient,
    );
    const cd =
      AIRCRAFT.dragCoefficient +
      (liftCoefficient * liftCoefficient) / AIRCRAFT.inducedDragSpan +
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
   * Ground collision along the segment the aircraft has just flown.
   *
   * update() advances the position by velocity * dt before this runs, so the
   * step just travelled is exactly [position - velocity*dt, position]. That is
   * what gets sampled, and the reconstruction is exact rather than an estimate:
   * the integrator moved the aircraft with this very velocity.
   *
   * It used to sample [position, position + velocity*dt] instead — forward,
   * into a step that had not happened yet, extrapolated with a velocity that
   * the next call to update() was about to change. So the segment actually
   * traversed was never tested by anyone: it was only ever approximated, one
   * call early, by an extrapolation whose error is the acceleration term. A
   * caller stepping at frame rate rather than at the 120 Hz physics rate leaves
   * a hole the size of a whole frame of travel — 16 m at 500 m/s and 30 fps,
   * against a 12 m clearance — and a jet can pass clean through a ridge with
   * both endpoint tests reporting clear air. The docstring claimed the opposite
   * ("samples slightly ahead ... as well as underneath"), which is why it stood.
   *
   * Sample spacing is held to half the clearance so the test cannot step over
   * the envelope it is enforcing, whatever dt the caller passes.
   */
  checkTerrainCollision(dt, clearance = 12) {
    if (this.crashed) return false;

    const travel = this.velocity.length() * dt;
    const steps = Math.min(24, Math.max(4, Math.ceil(travel / (clearance * 0.5))));
    // March from where the step began (t = -dt) forward to the aircraft (t = 0),
    // so the breach reported is the point of *entry*. Marching the other way
    // would return the far side of a ridge already flown through, and the
    // wreck would be planted beyond the hill it hit. i = 0 duplicates the
    // previous call's last sample, which is the correct overlap: it is the only
    // way an aircraft that has just been repositioned can be tested at all.
    for (let i = 0; i <= steps; i++) {
      const t = dt * (i / steps - 1);
      const x = this.position.x + this.velocity.x * t;
      const y = this.position.y + this.velocity.y * t;
      const z = this.position.z + this.velocity.z * t;
      if (y - terrainHeight(x, z) < clearance) {
        this.crashed = true;
        this.impactPoint.set(x, terrainHeight(x, z), z);
        this.impactVelocity.copy(this.velocity);
        const epsilon = 4;
        const left = terrainHeight(x - epsilon, z);
        const right = terrainHeight(x + epsilon, z);
        const back = terrainHeight(x, z - epsilon);
        const front = terrainHeight(x, z + epsilon);
        this.impactNormal.set(left - right, epsilon * 2, back - front).normalize();
        this.impactSpeed = this.impactVelocity.length();
        // Put the aircraft on the ground it just hit. update() returns early
        // once crashed, so without this the jet hangs wherever the step left it
        // — which, now that the whole traversed segment is tested, can be well
        // past the ridge, in clear air on the far side — and holds that pose
        // for the two seconds before the failure screen. The breach point is
        // the honest place for the wreck: it is on the face the aircraft
        // actually flew into, a third of the clearance envelope above the rock
        // so the airframe rests on the slope rather than buried in it.
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
