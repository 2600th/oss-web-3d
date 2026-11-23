/**
 * MiG-21 control-surface animation (pure logic; no three.js imports, so it is
 * unit-tested in node).
 *
 * The airframes (public/models/mig21*.glb, tools/blender/build_mig_surfaces.py)
 * carry pivot nodes on the hinge lines: stab_L/R (all-moving tailplanes),
 * aileron_L/R and flap_L/R. Each turns on rotation.x; + = trailing edge down.
 *
 * Throws are the MiG-21's published limits, rate-limited like hydraulic
 * actuators and then smoothed with a short first-order lag so a keyboard tap
 * does not snap a 3 m tailplane:
 *   stabilator  16.5 deg TE up (pull) / 7.5 deg TE down (push), 40 deg/s
 *   ailerons    +-20 deg, 80 deg/s (no tailerons on the MiG-21: the stabs move
 *               together, roll is ailerons only)
 *   flaps       25 deg (take-off setting) below ~120 m/s, 12 deg/s
 * The rudder and airbrakes are fused into the skin of this model and do not move.
 */

const D = Math.PI / 180;

export const THROWS = {
  stab: { up: 16.5 * D, down: 7.5 * D, rate: 40 * D },
  aileron: { travel: 20 * D, rate: 80 * D },
  flap: { down: 25 * D, rate: 12 * D },
};

export const SURFACE_NODES = ['stab_L', 'stab_R', 'aileron_L', 'aileron_R', 'flap_L', 'flap_R'];

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

/**
 * Pilot demands -> target deflections (radians, + = trailing edge down).
 * @param {{pitch?: number, roll?: number, flap?: number}} d
 *   pitch: -1..1, + = pull (nose up); roll: -1..1, + = roll right; flap: 0..1
 */
export function surfaceTargets({ pitch = 0, roll = 0, flap = 0 } = {}, out = {}) {
  const p = clamp(pitch, -1, 1);
  const r = clamp(roll, -1, 1);
  out.stab = p >= 0 ? -p * THROWS.stab.up : -p * THROWS.stab.down;
  // roll right: left wing rises -> left aileron trailing edge DOWN, right one up
  out.aileronL = r * THROWS.aileron.travel;
  out.aileronR = -r * THROWS.aileron.travel;
  out.flap = clamp(flap, 0, 1) * THROWS.flap.down;
  return out;
}

/** Flap schedule: take-off/landing setting at low airspeed (m/s), up in combat. */
export function flapDemand(airspeed) {
  return smoothstep(125, 95, airspeed);
}

/**
 * Demands from the player's flight model. `rates` (body rad/s; x = pitch up,
 * z = roll LEFT) chase the stick times the current authority, so their ratio
 * is the stick position the jet is actually flying.
 */
export function demandsFromFlight(flight, out = {}) {
  const r = flight.rates;
  const pa = Math.max(flight.pitchAuthority ?? 0.6, 0.15);
  const ra = Math.max(flight.rollAuthority ?? 3, 0.5);
  out.pitch = r ? clamp(r.x / pa, -1, 1) : 0;
  out.roll = r ? clamp(-r.z / ra, -1, 1) : 0;
  out.flap = flapDemand(flight.airspeed ?? 250);
  if (flight.crashed || flight.destroyed) { out.pitch = 0; out.roll = 0; }
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

/**
 * Drives the six pivot nodes of one airframe. Construct with any object that
 * has `getObjectByName` (a THREE.Object3D). Missing nodes are skipped, so an
 * un-split model (or LOD1) is simply left alone.
 */
export class SurfaceRig {
  constructor(root) {
    this.nodes = {};
    for (const n of SURFACE_NODES) {
      const o = root?.getObjectByName?.(n);
      if (o) this.nodes[n] = o;
    }
    this.ok = Object.keys(this.nodes).length > 0;
    this.state = { stab: { cmd: 0, pos: 0 }, aileronL: { cmd: 0, pos: 0 }, aileronR: { cmd: 0, pos: 0 }, flap: { cmd: 0, pos: 0 } };
    this._t = {};
  }

  /** @param {{pitch, roll, flap}} demands */
  update(dt, demands) {
    if (!this.ok) return;
    const t = surfaceTargets(demands, this._t);
    const s = this.state;
    const stab = actuate(s.stab, t.stab, THROWS.stab.rate, dt);
    const al = actuate(s.aileronL, t.aileronL, THROWS.aileron.rate, dt);
    const ar = actuate(s.aileronR, t.aileronR, THROWS.aileron.rate, dt);
    const fl = actuate(s.flap, t.flap, THROWS.flap.rate, dt, 0.2);
    const n = this.nodes;
    if (n.stab_L) n.stab_L.rotation.x = stab;
    if (n.stab_R) n.stab_R.rotation.x = stab;
    if (n.aileron_L) n.aileron_L.rotation.x = al;
    if (n.aileron_R) n.aileron_R.rotation.x = ar;
    if (n.flap_L) n.flap_L.rotation.x = fl;
    if (n.flap_R) n.flap_R.rotation.x = fl;
  }

  /** Snap to neutral (respawn). */
  reset(demands = {}) {
    const t = surfaceTargets(demands, this._t);
    const s = this.state;
    s.stab.cmd = s.stab.pos = t.stab;
    s.aileronL.cmd = s.aileronL.pos = t.aileronL;
    s.aileronR.cmd = s.aileronR.pos = t.aileronR;
    s.flap.cmd = s.flap.pos = t.flap;
    this.update(0, demands);
  }
}
