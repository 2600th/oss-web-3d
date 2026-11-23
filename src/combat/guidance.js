// Pure guidance / ballistics math. Works on anything with {x, y, z}; uses
// three's Vector3 only as a scratch type so it runs under node:test.
import { Vector3 } from 'three';

export const G = 9.80665;

const _r = new Vector3();
const _v = new Vector3();
const _w = new Vector3();
const _a = new Vector3();
const _d = new Vector3();

/**
 * True proportional navigation.
 *
 *   omega = (R x V) / |R|^2          line-of-sight rotation rate
 *   a     = N * Vc * (omega x R^)    lateral acceleration, perpendicular to LOS
 *
 * R = target - missile, V = targetVel - missileVel, Vc = closing speed.
 * A missile that nulls the LOS rate flies a collision course; N of 3-5 is the
 * textbook range. Returns `out` (m/s^2, unclamped).
 */
export function pnAcceleration(out, missilePos, missileVel, targetPos, targetVel, N = 4) {
  _r.subVectors(targetPos, missilePos);
  _v.subVectors(targetVel, missileVel);
  const r2 = Math.max(_r.lengthSq(), 1e-6);
  const range = Math.sqrt(r2);
  const closing = -_r.dot(_v) / range;
  _w.crossVectors(_r, _v).divideScalar(r2);
  _r.divideScalar(range);
  // Below a small closing speed PN has no authority; floor it so a tail chase
  // still steers toward the target instead of drifting.
  return out.crossVectors(_w, _r).multiplyScalar(N * Math.max(closing, 120));
}

/**
 * Turn `vel` by a lateral acceleration command, limited to `maxG`, keeping
 * speed unchanged. Returns the load actually pulled (G).
 */
export function steerVelocity(vel, accel, maxG, dt) {
  const speed = vel.length();
  if (speed < 1e-3) return 0;
  _d.copy(vel).divideScalar(speed);
  // Only the component perpendicular to the flight path can turn it.
  _a.copy(accel).addScaledVector(_d, -accel.dot(_d));
  let mag = _a.length();
  const limit = maxG * G;
  if (mag > limit) { _a.multiplyScalar(limit / mag); mag = limit; }
  vel.addScaledVector(_a, dt);
  vel.setLength(speed);
  return mag / G;
}

/** Angle (rad) between a forward vector and the direction from `from` to `to`. */
export function offBoresight(from, forward, to) {
  _r.subVectors(to, from);
  const d = _r.length();
  if (d < 1e-6) return 0;
  const f = Math.hypot(forward.x, forward.y, forward.z) || 1;
  return Math.acos(Math.min(1, Math.max(-1, _r.dot(forward) / (d * f))));
}

/**
 * Time for a projectile of constant `speed` fired now from `shooterPos` to meet
 * a target moving at constant velocity. `relVel` is target velocity minus the
 * velocity the projectile inherits from the shooter. Returns Infinity when
 * there is no solution.
 */
export function interceptTime(shooterPos, targetPos, relVel, speed) {
  _r.subVectors(targetPos, shooterPos);
  const a = relVel.x * relVel.x + relVel.y * relVel.y + relVel.z * relVel.z - speed * speed;
  const b = 2 * _r.dot(relVel);
  const c = _r.lengthSq();
  if (Math.abs(a) < 1e-6) return b < 0 ? -c / b : Infinity;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return Infinity;
  const s = Math.sqrt(disc);
  const t1 = (-b - s) / (2 * a);
  const t2 = (-b + s) / (2 * a);
  const t = Math.min(t1 > 0 ? t1 : Infinity, t2 > 0 ? t2 : Infinity);
  return t;
}

/**
 * Where to aim so a projectile meets the target (gun lead, AAA, flak).
 * Writes the aim point into `out`; returns time of flight (Infinity = none, in
 * which case `out` is the target's present position).
 */
export function leadPoint(out, shooterPos, shooterVel, targetPos, targetVel, speed, gravityDrop = 0) {
  _v.subVectors(targetVel, shooterVel);
  const t = interceptTime(shooterPos, targetPos, _v, speed);
  out.copy(targetPos);
  if (!Number.isFinite(t)) return Infinity;
  out.addScaledVector(_v, t);
  if (gravityDrop) out.y += 0.5 * G * t * t * gravityDrop;
  return t;
}

/**
 * Closest approach of a point moving along segment p0 -> p1 to a sphere centre.
 * Returns the squared distance; `tOut.t` (0..1) is where along the segment.
 */
export function segmentPointDistSq(p0, p1, c, tOut = null) {
  const dx = p1.x - p0.x, dy = p1.y - p0.y, dz = p1.z - p0.z;
  const l2 = dx * dx + dy * dy + dz * dz;
  let t = l2 > 1e-9 ? ((c.x - p0.x) * dx + (c.y - p0.y) * dy + (c.z - p0.z) * dz) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  if (tOut) tOut.t = t;
  const x = p0.x + dx * t - c.x, y = p0.y + dy * t - c.y, z = p0.z + dz * t - c.z;
  return x * x + y * y + z * z;
}

/**
 * Does a flare pull this missile off its target?
 *
 * The flare has to be inside the seeker's field of view and close enough to
 * the target to be confused with it. Probability scales with the weapon's
 * `flareChance` and is higher from the rear quarter (the seeker is staring at
 * the same hot nozzle the flare is imitating) and at longer missile range (a
 * seeker close in has already resolved the airframe).
 *
 * @param {number} roll uniform random in [0,1)
 */
export function flareDecoys({ missilePos, missileDir, seekerCos, targetPos, targetForward, flarePos, flareChance, roll }) {
  if (!(flareChance > 0)) return false;
  _r.subVectors(flarePos, missilePos);
  const d = _r.length();
  if (d < 1) return false;
  if (_r.dot(missileDir) / d < seekerCos) return false;
  _v.subVectors(flarePos, targetPos);
  if (_v.lengthSq() > 450 * 450) return false;
  _w.subVectors(targetPos, missilePos);
  const range = _w.length();
  // +1 when the missile is chasing the tail, -1 head-on.
  const tail = range > 1 ? _w.dot(targetForward) / range : 0;
  const aspect = 0.75 + 0.25 * tail;
  const rangeFactor = Math.min(1, 0.45 + range / 1800);
  return roll < flareChance * aspect * rangeFactor;
}

/** Ballistic impact point of a free-falling store (bomb CCIP), flat-earth step. */
export function ballisticImpact(out, pos, vel, groundHeight, { drag = 0, maxTime = 40, dt = 0.1 } = {}) {
  let x = pos.x, y = pos.y, z = pos.z, vx = vel.x, vy = vel.y, vz = vel.z;
  for (let t = 0; t < maxTime; t += dt) {
    vy -= G * dt;
    if (drag) { const k = 1 - drag * dt; vx *= k; vy *= k; vz *= k; }
    const nx = x + vx * dt, ny = y + vy * dt, nz = z + vz * dt;
    const h = groundHeight(nx, nz);
    if (ny <= h) {
      const f = (y - groundHeight(x, z)) / Math.max(1e-6, (y - groundHeight(x, z)) - (ny - h));
      out.set(x + (nx - x) * f, 0, z + (nz - z) * f);
      out.y = groundHeight(out.x, out.z);
      return t + dt * f;
    }
    x = nx; y = ny; z = nz;
  }
  out.set(x, y, z);
  return Infinity;
}
