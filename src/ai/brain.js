// Fighter AI decisions: basic fighter manoeuvres as a small priority-ordered
// state machine, plus the steering each state implies. Pure (node-testable):
// the Fighter glue gathers a `situation`, this decides, AiFlight flies it.
//
// States
//   patrol     fly the route, not yet aware
//   formation  hold station on the leader
//   intercept  lead-collision course at range
//   bracket    wingman swings wide so the pair arrives from two sides
//   pure       nose on the target (missile parameters)
//   lead       nose ahead of the target (guns)
//   lag        nose behind the target (kills closure, avoids the overshoot)
//   yoyo       high yo-yo: trade closure for height, then come back down (aces)
//   break      maximum-rate turn into the attacker
//   scissors   slow reversing turns to force an overshoot
//   evade      beam the missile, then a last-ditch break; flares
//   extend     unload, burner, separate and climb; re-enter when fast again
//   recover    terrain: climb, nothing else matters
import { Vector3 } from 'three';
import { leadPoint } from '../combat/guidance.js';

const D = Math.PI / 180;

/** Pilot skill. Airframe limits live in aiFlight.js AIRFRAMES. */
export const SKILLS = {
  bandit: {
    reaction: 0.55, detect: 13000, engage: 9000,
    mslRange: 3000, mslMin: 700, mslCone: 14 * D, lockTime: 2.6, mslCooldown: 13, missiles: 2, weapon: 'e_aam',
    gunRange: 650, gunCone: 4 * D, gunError: 0.02,
    flareChance: 0.2, flares: 6, breakG: 0.85, minFight: 175, extendTime: 7,
    vertical: 0, jink: 0, aggression: 0.5,
  },
  veteran: {
    reaction: 0.35, detect: 16000, engage: 10000,
    mslRange: 3400, mslMin: 650, mslCone: 17 * D, lockTime: 2.0, mslCooldown: 10, missiles: 4, weapon: 'e_aam',
    gunRange: 750, gunCone: 4.5 * D, gunError: 0.014,
    flareChance: 0.4, flares: 10, breakG: 0.95, minFight: 170, extendTime: 6,
    vertical: 0.25, jink: 0.3, aggression: 0.7,
  },
  ace: {
    reaction: 0.18, detect: 22000, engage: 12000,
    mslRange: 4200, mslMin: 550, mslCone: 26 * D, lockTime: 1.1, mslCooldown: 6, missiles: 8, weapon: 'e_aam_ace',
    gunRange: 850, gunCone: 5 * D, gunError: 0.009,
    flareChance: 0.6, flares: 24, breakG: 1, minFight: 160, extendTime: 4.5,
    vertical: 0.6, jink: 0.8, aggression: 1,
  },
};

export function newMemory() {
  return {
    mode: 'patrol', timer: 0, think: 0, side: 1, sideTimer: 0, aware: false,
    lock: 0, mslCooldown: 2, missiles: 0, flares: 0, flareCooldown: 0, gunBurst: 0, yoyo: 0,
  };
}

/**
 * Pick a state.
 *
 * @param {object} s situation
 *   range, closure        metres, m/s (positive = closing)
 *   angleOff              rad, my nose to the target (0 = pointing at it)
 *   aspect                rad, target's nose to me (0 = it is pointing at me)
 *   speed, agl            mine
 *   terrainDanger         bool, the lookahead says climb now
 *   missile               null | {range} nearest missile tracking me
 *   lockedBy              'none' | 'acquiring' | 'locked' (the player's lock on me)
 *   role                  'lead' | 'wing'; leaderEngaged, leaderAlive
 *   hasRoute              bool
 * @param {object} m memory (mutated: mode, timer, side, aware)
 * @param {object} k skill
 * @param {number} dt seconds since the last decision
 * @param {()=>number} rng
 */
export function decide(s, m, k, dt, rng = Math.random) {
  m.timer = Math.max(0, m.timer - dt);
  m.sideTimer -= dt;
  const set = (mode, timer = 0) => {
    if (m.mode !== mode) { m.mode = mode; m.timer = timer; }
    return mode;
  };

  if (s.terrainDanger) return set('recover');
  if (s.missile) {
    if (m.mode !== 'evade') m.side = rng() < 0.5 ? -1 : 1;
    return set('evade');
  }
  if (!s.targetAlive) return set(s.role === 'wing' && s.leaderAlive ? 'formation' : 'patrol');

  if (!m.aware) {
    if (s.range < k.detect || s.lockedBy !== 'none' || s.alerted) m.aware = true;
    else return set(s.role === 'wing' && s.leaderAlive ? 'formation' : 'patrol');
  }

  // A committed extension is flown out unless the player gives up the chase.
  if (m.mode === 'extend' && m.timer > 0 && s.speed < 330) return 'extend';

  const targetBehind = s.angleOff > 105 * D;
  const targetPointing = s.aspect < 45 * D;

  // Defensive.
  if (targetBehind && targetPointing && s.range < 2400) {
    if (s.range < 800 && s.speed < 250 && k.jink > 0.2) {
      if (m.mode !== 'scissors' || m.sideTimer <= 0) { m.side = -m.side; m.sideTimer = 1.5 + rng() * 0.9; }
      return set('scissors');
    }
    if (m.mode !== 'break') m.side = s.targetSide >= 0 ? 1 : -1;
    return set('break');
  }
  if (s.lockedBy === 'locked' && s.range < 4200 && s.angleOff > 50 * D) {
    if (m.mode !== 'break') m.side = s.targetSide >= 0 ? 1 : -1;
    return set('break');
  }

  // Energy.
  if (s.speed < k.minFight && s.range > 500) return set('extend', k.extendTime);

  if (s.range > k.engage) {
    if (s.role === 'wing' && s.leaderAlive && !s.leaderEngaged) return set('formation');
    return set('intercept');
  }

  // Wingman brackets until the fight is joined.
  if (s.role === 'wing' && s.leaderAlive && s.range > 3200 && m.mode !== 'pure' && m.mode !== 'lead') return set('bracket');

  // Offensive.
  if (s.angleOff < 70 * D) {
    // Just flashed through the merge with nothing to shoot at: separate.
    if (s.range < 320 && s.closure > 90) {
      if (k.vertical > 0.5) { m.yoyo = 2.2; return set('yoyo', 2.2); }
      return set('lag');
    }
    if (m.mode === 'yoyo' && m.timer > 0) return 'yoyo';
    if (s.range < k.gunRange * 1.4) return set('lead');
    if (s.closure > 140 && s.range < 1500 && k.vertical > rng()) return set('yoyo', 1.8);
    return set('pure');
  }

  // Lost sight / overshot / neutral pass: low-skill pilots run out and come
  // back; good ones turn in the vertical and stay in the fight.
  if (s.range < 700 && targetBehind && !targetPointing && k.aggression < 0.6) return set('extend', k.extendTime * 0.7);
  return set('pure');
}

const _t = new Vector3();
const _los = new Vector3();
const _h = new Vector3();
const UP = new Vector3(0, 1, 0);

/**
 * Desired flight direction (written to `out`, not normalised) and throttle for
 * a state.
 *
 * @param {object} c  { position, velocity, forward, targetPos, targetVel,
 *                      missilePos?, leaderPos?, leaderForward?, slot?, waypoint?, side, yoyoUp }
 * @returns {{throttle:number, g:number}}
 */
export function steer(out, mode, c, k) {
  const pos = c.position;
  switch (mode) {
    case 'recover':
      out.copy(c.forward); out.y = 0; out.normalize(); out.y = 0.9;
      return { throttle: 1.25, g: 1 };
    case 'patrol':
      if (c.waypoint) out.subVectors(c.waypoint, pos); else out.copy(c.forward).setY(0);
      return { throttle: 0.62, g: 0.45 };
    case 'formation': {
      // Slot relative to the leader's heading; chase it, matching speed.
      _h.copy(c.leaderForward).setY(0).normalize();
      _t.copy(c.leaderPos).addScaledVector(_h, c.slot.z).addScaledVector(_los.crossVectors(_h, UP), c.slot.x);
      _t.y += c.slot.y;
      out.subVectors(_t, pos);
      const d = out.length();
      // Far out of position: fly to the slot. Close: fly the leader's heading.
      if (d < 400) out.normalize().multiplyScalar(d / 400).add(c.leaderForward);
      return { throttle: d > 250 ? 1.05 : 0.62 + Math.min(0.3, d / 800), g: 0.6 };
    }
    case 'intercept': {
      const range = pos.distanceTo(c.targetPos);
      _t.copy(c.targetPos).addScaledVector(c.targetVel, Math.min(range / 520, 14));
      out.subVectors(_t, pos);
      return { throttle: 1.1, g: 0.7 };
    }
    case 'bracket': {
      _los.subVectors(c.targetPos, pos).setY(0).normalize();
      _h.crossVectors(_los, UP).multiplyScalar(c.side * 1800);
      _t.copy(c.targetPos).add(_h);
      _t.y += 400;
      out.subVectors(_t, pos);
      return { throttle: 1.15, g: 0.8 };
    }
    case 'lead': {
      leadPoint(_t, pos, c.velocity, c.targetPos, c.targetVel, 900);
      out.subVectors(_t, pos);
      return { throttle: 0.9, g: 1 };
    }
    case 'lag':
      _t.copy(c.targetPos).addScaledVector(c.targetVel, -0.9);
      out.subVectors(_t, pos);
      return { throttle: 0.45, g: 1 };
    case 'yoyo':
      // Pull up out of the target's plane, then fall back onto its tail.
      out.subVectors(c.targetPos, pos).normalize();
      out.y += 0.75;
      return { throttle: 0.9, g: 1 };
    case 'break': {
      // Turn into the attacker, nose slightly low to keep speed.
      _los.subVectors(c.targetPos, pos).setY(0).normalize();
      _h.copy(c.forward).setY(0).normalize();
      _t.crossVectors(_h, UP).multiplyScalar(c.side); // my right (side=1) / left
      out.copy(_t).addScaledVector(_los, 0.6).addScaledVector(_h, 0.15);
      out.y = -0.12;
      return { throttle: 1.25, g: k.breakG };
    }
    case 'scissors': {
      _h.copy(c.forward).setY(0).normalize();
      _t.crossVectors(_h, UP).multiplyScalar(c.side);
      out.copy(_h).multiplyScalar(0.35).add(_t);
      out.y = 0.08;
      return { throttle: 0.4, g: 1 };
    }
    case 'evade': {
      // Put the missile on the beam and descend; inside 700 m, break across it.
      const mp = c.missilePos ?? c.targetPos;
      _los.subVectors(mp, pos);
      const range = _los.length();
      _los.setY(0).normalize();
      _t.crossVectors(_los, UP).multiplyScalar(c.side);
      if (range < 700) { out.copy(_t).addScaledVector(_los, 0.5); out.y = 0.45; } else { out.copy(_t); out.y = -0.22; }
      return { throttle: 1.25, g: 1 };
    }
    case 'extend': {
      out.subVectors(pos, c.targetPos).setY(0).normalize().add(_h.copy(c.forward).setY(0).normalize());
      if (out.lengthSq() < 1e-4) out.copy(c.forward);
      out.normalize();
      out.y = 0.14;
      return { throttle: 1.25, g: 0.5 };
    }
    case 'pure':
    default:
      out.subVectors(c.targetPos, pos);
      if (c.verticalBias) { out.normalize(); out.y += c.verticalBias; }
      return { throttle: 1.05, g: 1 };
  }
}

/**
 * Weapon employment for this decision tick.
 * Mutates memory (lock build-up, cooldowns, ammunition).
 * @returns {{missile:boolean, gun:boolean, locking:boolean, flare:boolean}}
 */
export function employ(s, m, k, dt, rng = Math.random) {
  const out = { missile: false, gun: false, locking: false, flare: false };
  m.mslCooldown = Math.max(0, m.mslCooldown - dt);
  m.flareCooldown = Math.max(0, m.flareCooldown - dt);

  // Defensive flares: a roll per second while something is tracking.
  if (s.missile && m.flares > 0 && m.flareCooldown <= 0) {
    m.flareCooldown = 1.5;
    if (rng() < k.flareChance) { m.flares--; out.flare = true; }
  }

  const offensive = m.mode === 'pure' || m.mode === 'lead' || m.mode === 'intercept' || m.mode === 'bracket';
  const inParams = offensive && s.targetAlive && s.los && s.range < k.mslRange && s.range > k.mslMin && s.angleOff < k.mslCone;
  if (inParams && m.missiles > 0 && m.mslCooldown <= 0 && s.token) {
    m.lock += dt;
    out.locking = true;
    if (m.lock >= k.lockTime) {
      m.lock = 0;
      m.missiles--;
      m.mslCooldown = k.mslCooldown * (0.8 + rng() * 0.4);
      out.missile = true;
    }
  } else {
    m.lock = Math.max(0, m.lock - dt * 2);
  }

  out.gun = s.targetAlive && s.los && s.range < k.gunRange && s.leadAngle < k.gunCone && m.mode !== 'evade' && m.mode !== 'recover';
  return out;
}
