// Kinematic flight for AI aircraft. The AI says where it wants to point and how
// much throttle; this turns the velocity vector toward it under a G limit and
// a turn-rate ceiling, and runs a small energy model (thrust, drag, climb,
// turn bleed) so an AI that turns hard for long gets slow and has to extend —
// the same trade the player's flight model makes, without a stick to fly.
import { Vector3, Quaternion, Matrix4 } from 'three';

const G = 9.80665;
const _axis = new Vector3();
const _lat = new Vector3();
const _up = new Vector3();
const _right = new Vector3();
const _back = new Vector3();
const _m = new Matrix4();
const _q = new Quaternion();
const _prev = new Vector3();

export const AIRFRAMES = {
  bandit:  { maxG: 6.2, turnRate: 0.36, accel: 26, maxSpeed: 400, bleed: 3.4, roll: 3.2 },
  veteran: { maxG: 7.2, turnRate: 0.42, accel: 29, maxSpeed: 420, bleed: 3.2, roll: 3.8 },
  ace:     { maxG: 8.6, turnRate: 0.52, accel: 34, maxSpeed: 450, bleed: 2.8, roll: 4.6 },
};

export class AiFlight {
  constructor(airframe = AIRFRAMES.bandit) {
    this.cfg = airframe;
    this.position = new Vector3();
    this.velocity = new Vector3(0, 0, -240);
    this.quaternion = new Quaternion();
    this.forward = new Vector3(0, 0, -1);
    this.up = new Vector3(0, 1, 0);
    this.speed = 240;
    this.gLoad = 1;
    this.throttle = 0.8;
    /** 1 = undamaged; scales turn and thrust. */
    this.condition = 1;
  }

  reset(position, heading, speed = 240) {
    this.position.copy(position);
    this.forward.set(Math.sin(heading), 0, -Math.cos(heading));
    this.speed = speed;
    this.velocity.copy(this.forward).multiplyScalar(speed);
    this.up.set(0, 1, 0);
    this._orient();
  }

  /**
   * @param {number} dt
   * @param {Vector3} desired  direction to fly toward (need not be unit)
   * @param {number} throttle  0..1.25 (above 1 = reheat)
   * @param {number} [gScale]  0..1 fraction of the airframe's G to use
   */
  step(dt, desired, throttle, gScale = 1) {
    const c = this.cfg;
    const cond = 0.55 + 0.45 * this.condition;
    this.throttle = throttle;
    const speed = this.speed;
    // Low-speed authority: a slow jet cannot point its nose.
    const authority = Math.min(1, Math.max(0.25, (speed - 70) / 130));
    const maxRate = Math.min(c.turnRate * authority, (c.maxG * gScale * cond * G) / Math.max(speed, 80));

    _prev.copy(this.forward);
    const dl = desired.length();
    let rate = 0;
    if (dl > 1e-6) {
      const cos = Math.min(1, Math.max(-1, this.forward.dot(desired) / dl));
      const angle = Math.acos(cos);
      if (angle > 1e-4) {
        _axis.crossVectors(this.forward, desired);
        if (_axis.lengthSq() < 1e-10) _axis.set(0, 1, 0); // dead astern: pick a side
        _axis.normalize();
        const turn = Math.min(angle, maxRate * dt);
        this.forward.applyAxisAngle(_axis, turn).normalize();
        rate = turn / dt;
      }
    }

    // Energy.
    this.gLoad = Math.hypot(1, (rate * speed) / G);
    const thrust = c.accel * throttle * cond;
    const drag = c.accel * (speed / c.maxSpeed) ** 2;
    const dv = thrust - drag - G * this.forward.y - c.bleed * (this.gLoad - 1);
    this.speed = Math.min(c.maxSpeed * 1.08, Math.max(60, speed + dv * dt));

    this.velocity.copy(this.forward).multiplyScalar(this.speed);
    this.position.addScaledVector(this.velocity, dt);

    // Bank: lift points along (turn acceleration + 1 g up), smoothed.
    _lat.subVectors(this.forward, _prev).multiplyScalar(this.speed / Math.max(dt, 1e-4));
    _lat.y += G;
    _lat.addScaledVector(this.forward, -_lat.dot(this.forward));
    if (_lat.lengthSq() > 1e-6) {
      _lat.normalize();
      this.up.lerp(_lat, 1 - Math.exp(-c.roll * dt)).normalize();
    }
    this._orient();
  }

  _orient() {
    _back.copy(this.forward).negate();
    _right.crossVectors(this.up, _back);
    if (_right.lengthSq() < 1e-8) _right.set(1, 0, 0);
    _right.normalize();
    _up.crossVectors(_back, _right).normalize();
    _m.makeBasis(_right, _up, _back);
    this.quaternion.copy(_q.setFromRotationMatrix(_m));
    this.up.copy(_up);
  }
}
