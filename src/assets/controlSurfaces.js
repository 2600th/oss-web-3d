/**
 * MiG-21 control-surface animation (pure logic; no three.js imports, so it is
 * unit-tested in node).
 *
 * The airframes (public/models/mig21*.glb) carry pivot nodes on the hinge
 * lines, each turning on its own rotation.x:
 *   stab_L/R, aileron_L/R, flap_L/R   + = trailing edge down
 *       (tools/blender/build_mig_surfaces.py)
 *   rudder                            + = trailing edge RIGHT (nose right)
 *   airbrake_L/R                      + = open (aft edge out into the airflow)
 *       (tools/blender/build_mig_moving.mjs; the pivot sits under a fixed
 *        `<name>_hinge` frame whose +X is the hinge line)
 *
 * Throws are the MiG-21's published limits, rate-limited like hydraulic
 * actuators and then smoothed with a short first-order lag so a keyboard tap
 * does not snap a 3 m tailplane:
 *   stabilator  16.5 deg TE up (pull) / 7.5 deg TE down (push), 40 deg/s
 *   ailerons    +-20 deg, 80 deg/s (no tailerons on the MiG-21: the stabs move
 *               together, roll is ailerons only)
 *   flaps       25 deg (take-off setting) below ~120 m/s, 12 deg/s
 *   rudder      +-25 deg at low speed, washed out to about +-8 deg near the
 *               top of the envelope (the real jet's rudder travel is limited at
 *               high dynamic pressure), 60 deg/s
 *   airbrakes   35 deg, about 1 s to open (35 deg/s); above ~300 m/s air
 *               loads blow them back toward 60 % of full travel
 * The ventral airbrake ahead of the ventral fin has no panel on this mesh.
 */

const D = Math.PI / 180;

export const THROWS = {
  stab: { up: 16.5 * D, down: 7.5 * D, rate: 40 * D },
  aileron: { travel: 20 * D, rate: 80 * D },
  flap: { down: 25 * D, rate: 12 * D },
  rudder: { travel: 25 * D, highSpeed: 8 * D, rate: 60 * D },
  airbrake: { open: 35 * D, blowback: 0.6, rate: 35 * D },
};

/** Yaw rate (rad/s) the flight model gives at full pedal (FlightModel AIRCRAFT.maxYawRate). */
export const MAX_YAW_RATE = 0.42;

export const SURFACE_NODES = ['stab_L', 'stab_R', 'aileron_L', 'aileron_R', 'flap_L', 'flap_R', 'rudder', 'airbrake_L', 'airbrake_R'];

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

/** Rudder travel (rad) available at an airspeed (m/s). */
export function rudderTravel(airspeed = 200) {
  const k = smoothstep(150, 420, airspeed);
  return THROWS.rudder.travel + (THROWS.rudder.highSpeed - THROWS.rudder.travel) * k;
}

/** Airbrake opening (rad) reached at an airspeed (m/s) for a full command. */
export function airbrakeTravel(airspeed = 200) {
  const k = smoothstep(300, 480, airspeed);
  return THROWS.airbrake.open * (1 - (1 - THROWS.airbrake.blowback) * k);
}

/**
 * Pilot demands -> target deflections (radians).
 * @param {{pitch?: number, roll?: number, flap?: number, yaw?: number, airbrake?: number, airspeed?: number}} d
 *   pitch: -1..1, + = pull (nose up); roll: -1..1, + = roll right; flap: 0..1;
 *   yaw: -1..1, + = nose right; airbrake: 0..1; airspeed m/s (travel limits)
 */
export function surfaceTargets({ pitch = 0, roll = 0, flap = 0, yaw = 0, airbrake = 0, airspeed = 200 } = {}, out = {}) {
  const p = clamp(pitch, -1, 1);
  const r = clamp(roll, -1, 1);
  out.stab = p >= 0 ? -p * THROWS.stab.up : -p * THROWS.stab.down;
  // roll right: left wing rises -> left aileron trailing edge DOWN, right one up
  out.aileronL = r * THROWS.aileron.travel;
  out.aileronR = -r * THROWS.aileron.travel;
  out.flap = clamp(flap, 0, 1) * THROWS.flap.down;
  // nose right: trailing edge right
  out.rudder = clamp(yaw, -1, 1) * rudderTravel(airspeed);
  out.airbrake = clamp(airbrake, 0, 1) * airbrakeTravel(airspeed);
  return out;
}

/** Flap schedule: take-off/landing setting at low airspeed (m/s), up in combat. */
export function flapDemand(airspeed) {
  return smoothstep(125, 95, airspeed);
}

/**
 * Demands from the player's flight model. `rates` (body rad/s; x = pitch up,
 * z = roll LEFT) chase the stick times the current authority, so their ratio
 * is the stick position the jet is actually flying. The rudder follows the
 * commanded yaw (pilot pedal plus the assist's coordinating yaw,
 * `flight.yawCommand`), else the yaw rate; the airbrakes follow `flight.airbrake`.
 */
export function demandsFromFlight(flight, out = {}) {
  const r = flight.rates;
  const pa = Math.max(flight.pitchAuthority ?? 0.6, 0.15);
  const ra = Math.max(flight.rollAuthority ?? 3, 0.5);
  out.pitch = r ? clamp(r.x / pa, -1, 1) : 0;
  out.roll = r ? clamp(-r.z / ra, -1, 1) : 0;
  out.yaw = typeof flight.yawCommand === 'number' ? clamp(flight.yawCommand, -1, 1) : r ? clamp(-r.y / MAX_YAW_RATE, -1, 1) : 0;
  out.airbrake = clamp(flight.airbrake ?? 0, 0, 1);
  out.airspeed = flight.airspeed ?? 250;
  out.flap = flapDemand(out.airspeed);
  if (flight.crashed || flight.destroyed) { out.pitch = 0; out.roll = 0; out.yaw = 0; }
  return out;
}

/**
 * Demands for an aircraft without a flight model of its own (AI kinematic
 * flight), from its body rates (see bodyRates) and its speed change.
 * `cfg`: { turnRate (rad/s at full pull), roll (rad/s at full stick), yawRate }.
 * The airbrakes come out when the jet is slowing harder than drag alone
 * would (deceleration above ~6 m/s^2) and stay out while it keeps braking.
 */
export function demandsFromRates(rates, speed, accel, cfg = {}, out = {}) {
  out.pitch = clamp(rates.x / (cfg.turnRate ?? 0.4), -1, 1);
  out.roll = clamp(-rates.z / (cfg.roll ?? 3.5), -1, 1);
  out.yaw = clamp(-rates.y / (cfg.yawRate ?? MAX_YAW_RATE), -1, 1);
  out.airspeed = speed ?? 250;
  out.flap = flapDemand(out.airspeed);
  out.airbrake = smoothstep(4, 9, -(accel ?? 0));
  return out;
}

/**
 * Body angular rates from two orientations (quaternions as {x,y,z,w}), for
 * aircraft without a flight model of their own (AI kinematic flight).
 * Writes {x: pitch up, y: yaw left, z: roll left} in rad/s.
 */
export function bodyRates(qPrev, qNow, dt, out = { x: 0, y: 0, z: 0 }) {
  if (!(dt > 0)) { out.x = out.y = out.z = 0; return out; }
  // d = conj(qPrev) * qNow
  const ax = -qPrev.x, ay = -qPrev.y, az = -qPrev.z, aw = qPrev.w;
  const bx = qNow.x, by = qNow.y, bz = qNow.z, bw = qNow.w;
  let x = aw * bx + ax * bw + ay * bz - az * by;
  let y = aw * by - ax * bz + ay * bw + az * bx;
  let z = aw * bz + ax * by - ay * bx + az * bw;
  let w = aw * bw - ax * bx - ay * by - az * bz;
  if (w < 0) { x = -x; y = -y; z = -z; w = -w; }
  const s = Math.hypot(x, y, z);
  const angle = 2 * Math.atan2(s, w);
  const k = s > 1e-9 ? angle / s / dt : 2 / dt;
  out.x = x * k;
  out.y = y * k;
  out.z = z * k;
  return out;
}

/** Rate-limited + lagged actuator: one step toward `target`. */
export function actuate(state, target, rate, dt, tau = 0.06) {
  const step = rate * dt;
  const cmd = state.cmd + clamp(target - state.cmd, -step, step);
  state.cmd = cmd;
  state.pos += (cmd - state.pos) * (1 - Math.exp(-dt / tau));
  return state.pos;
}

const KEYS = ['stab', 'aileronL', 'aileronR', 'flap', 'rudder', 'airbrake'];

/**
 * Drives the pivot nodes of one airframe. Construct with any object that
 * has `getObjectByName` (a THREE.Object3D). Missing nodes are skipped, so an
 * un-split model (or one cut before the rudder and airbrakes) is driven as
 * far as it goes.
 */
export class SurfaceRig {
  constructor(root) {
    this.nodes = {};
    for (const n of SURFACE_NODES) {
      const o = root?.getObjectByName?.(n);
      if (o) this.nodes[n] = o;
    }
    this.ok = Object.keys(this.nodes).length > 0;
    this.state = {};
    for (const k of KEYS) this.state[k] = { cmd: 0, pos: 0 };
    this._t = {};
  }

  /** @param {{pitch, roll, flap, yaw?, airbrake?, airspeed?}} demands */
  update(dt, demands) {
    if (!this.ok) return;
    const t = surfaceTargets(demands, this._t);
    const s = this.state;
    const stab = actuate(s.stab, t.stab, THROWS.stab.rate, dt);
    const al = actuate(s.aileronL, t.aileronL, THROWS.aileron.rate, dt);
    const ar = actuate(s.aileronR, t.aileronR, THROWS.aileron.rate, dt);
    const fl = actuate(s.flap, t.flap, THROWS.flap.rate, dt, 0.2);
    const ru = actuate(s.rudder, t.rudder, THROWS.rudder.rate, dt);
    const ab = actuate(s.airbrake, t.airbrake, THROWS.airbrake.rate, dt, 0.1);
    const n = this.nodes;
    if (n.stab_L) n.stab_L.rotation.x = stab;
    if (n.stab_R) n.stab_R.rotation.x = stab;
    if (n.aileron_L) n.aileron_L.rotation.x = al;
    if (n.aileron_R) n.aileron_R.rotation.x = ar;
    if (n.flap_L) n.flap_L.rotation.x = fl;
    if (n.flap_R) n.flap_R.rotation.x = fl;
    if (n.rudder) n.rudder.rotation.x = ru;
    if (n.airbrake_L) n.airbrake_L.rotation.x = ab;
    if (n.airbrake_R) n.airbrake_R.rotation.x = ab;
  }

  /** Snap to the demanded pose (respawn). */
  reset(demands = {}) {
    const t = surfaceTargets(demands, this._t);
    for (const k of KEYS) this.state[k].cmd = this.state[k].pos = t[k];
    this.update(0, demands);
  }
}
