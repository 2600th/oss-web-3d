// Terrain-following autopilot that flies the player's aircraft through the
// assisted controller (it produces the same `intent` the stick does). Used for
// the title / menu flyby; the dev test bot builds on the same steering.
import { maxHeightAlong, terrainHeight } from '../world/terrain/heightfield.js';
import { traceValleyRoad, alongPath, pathLength } from '../ai/sites.js';

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const wrapPi = (a) => {
  a = (a + Math.PI) % (Math.PI * 2);
  if (a < 0) a += Math.PI * 2;
  return a - Math.PI;
};

/**
 * Steer toward a compass bearing and an altitude; writes turn/climb into
 * `intent`. Shared by the flyby and the bot.
 */
export function steerIntent(intent, flight, bearing, altitude, { turnGain = 2.0, maxTurn = 1, maxClimb = 0.5, maxDive = 0.35 } = {}) {
  const heading = Math.atan2(flight.forward.x, -flight.forward.z);
  intent.turn = clamp(wrapPi(bearing - heading) * turnGain, -maxTurn, maxTurn);
  // Never fly into what is ahead: look six seconds down the velocity vector.
  const p = flight.position, v = flight.velocity;
  const ahead = maxHeightAlong(p.x, p.z, p.x + v.x * 6, p.z + v.z * 6, 8) + 260;
  const target = Math.max(altitude, ahead);
  intent.climb = clamp((target - p.y) / 700 - v.y / 260, -maxDive, target > altitude ? 0.9 : maxClimb);
  return intent;
}

export class Autopilot {
  /** @param {{x,y,z}[]} path polyline to shuttle along */
  constructor(path, { agl = 620, lookahead = 1900 } = {}) {
    this.path = path;
    this.length = pathLength(path);
    this.agl = agl;
    this.lookahead = lookahead;
    this.s = 0;
    this.dir = 1;
    this.intent = { turn: 0, climb: 0, yaw: 0, speed: 0, boost: false, brake: 0, throttle: 0.78 };
    this._o = {};
  }

  /** The Drass valley, west from the mission start line: the title flyby. */
  static valleyFlyby() {
    const path = traceValleyRoad(-16000, 9100, (270 * Math.PI) / 180, { length: 15000, step: 200 });
    return new Autopilot(path);
  }

  start() {
    const a = alongPath(this.path, 0, {});
    return { x: a.x, z: a.z, alt: a.y + this.agl, heading: (a.heading * 180) / Math.PI, speed: 215 };
  }

  update(dt, flight) {
    // Advance the carrot to stay `lookahead` in front of the aircraft.
    const o = this._o;
    for (let i = 0; i < 4; i++) {
      alongPath(this.path, this.s, o);
      if (Math.hypot(o.x - flight.position.x, o.z - flight.position.z) > this.lookahead) break;
      this.s += this.dir * 300;
      if (this.s >= this.length) { this.s = this.length; this.dir = -1; }
      if (this.s <= 0) { this.s = 0; this.dir = 1; }
    }
    const bearing = Math.atan2(o.x - flight.position.x, -(o.z - flight.position.z));
    const floor = terrainHeight(flight.position.x, flight.position.z);
    steerIntent(this.intent, flight, bearing, Math.max(o.y, floor) + this.agl, { maxTurn: 0.55 });
    this.intent.throttle = 0.74;
    return this.intent;
  }
}
