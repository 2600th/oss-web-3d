/**
 * Normalise the `game.hud` snapshot (docs/v2/ARCHITECTURE.md) into a shape
 * the renderer can trust, filling gaps from the flight model.
 *
 * Gameplay writes `game.hud` in update(); every field is optional. Attitude
 * (heading / pitch / roll) is always derived from the flight model when one is
 * present, because the contract does not fix angle units and the flight model
 * is the authority anyway. Units here: metres, m/s, degrees.
 */

const RAD = 180 / Math.PI;

export function attitudeFromFlight(flight, out) {
  const f = flight.forward;
  const r = flight.right;
  const u = flight.up;
  out.heading = ((Math.atan2(f.x, -f.z) * RAD) % 360 + 360) % 360;
  out.pitch = Math.asin(Math.max(-1, Math.min(1, f.y))) * RAD;
  // bank: positive = right wing down
  out.roll = Math.atan2(-r.y, u.y) * RAD;
  return out;
}

const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/**
 * @param raw     game.hud (may be {} or undefined)
 * @param flight  game.flight (may be undefined in tests)
 * @param out     reused output object
 */
export function normalizeHud(raw = {}, flight = null, out = {}) {
  raw = raw || {};
  if (flight?.forward) attitudeFromFlight(flight, out);
  else {
    // No flight model: accept the snapshot's values, assuming degrees if any
    // magnitude exceeds 2*pi, radians otherwise.
    const h = num(raw.heading, 0);
    const looksRad = Math.abs(h) <= Math.PI * 2 + 0.01 && Math.abs(num(raw.pitch, 0)) <= Math.PI / 2 + 0.01;
    const k = looksRad && raw.angleUnits !== 'deg' ? RAD : 1;
    out.heading = (((h * k) % 360) + 360) % 360;
    out.pitch = num(raw.pitch, 0) * k;
    out.roll = num(raw.roll, 0) * k;
  }
  out.speed = num(raw.speed, num(flight?.airspeed, 0));
  out.altitude = num(raw.altitude, num(flight?.altitude, 0));
  out.agl = num(raw.agl, num(flight?.agl, 9999));
  out.gLoad = num(raw.gLoad, num(flight?.gLoad, 1));
  out.throttle = num(raw.throttle, num(flight?.throttleSmoothed ?? flight?.throttle, 0));
  out.reheat = raw.reheat ?? flight?.reheat ?? false;
  out.stall = raw.stall ?? flight?.stalling ?? false;
  out.aoa = num(raw.aoa, num(flight?.angleOfAttack, 0) * RAD);
  out.health = Math.min(1, Math.max(0, num(raw.health, 1)));
  out.hasHealth = typeof raw.health === 'number';
  out.score = num(raw.score, 0);
  out.hasScore = typeof raw.score === 'number';
  out.time = num(raw.time, null);
  out.timeLimit = num(raw.timeLimit, null);
  out.weapon = raw.weapon ?? null;
  out.gun = raw.gun ?? null;
  out.flares = raw.flares ?? null;
  out.lock = raw.lock ?? null;
  out.targets = Array.isArray(raw.targets) ? raw.targets : EMPTY;
  out.threats = Array.isArray(raw.threats) ? raw.threats : EMPTY;
  out.warning = raw.warning ?? deriveWarning(out, flight);
  out.objective = raw.objective ?? null;
  out.mission = raw.mission ?? null;
  out.radar = raw.radar ?? null;
  out.crashed = flight?.crashed ?? false;
  return out;
}

const EMPTY = Object.freeze([]);

/**
 * Fallback warning when gameplay does not set one: ground proximity from AGL
 * and sink rate, then stall. Priority: pullup > terrain > stall.
 */
export function deriveWarning(d, flight) {
  if (!flight || flight.crashed) return 'none';
  const vy = flight.velocity?.y ?? 0;
  const agl = d.agl;
  // time to impact at current sink rate
  if (vy < -5 && agl / -vy < 6) return 'pullup';
  if (agl < 120) return 'terrain';
  if (d.stall) return 'stall';
  return 'none';
}
