// DEV ONLY. A simple pilot that plays a sortie through the same input path a
// player uses (assisted-controller intents + input actions), so missions can
// be flown start-to-finish in automated verification. Not shipped: loaded
// only from dev/index.js behind `import.meta.env.DEV`.
import { Vector3 } from 'three';
import { maxHeightAlong, terrainHeight } from '../../world/terrain/heightfield.js';
import { wrapPi } from '../Autopilot.js';
import { leadPoint } from '../../combat/guidance.js';
import { OPTIC } from '../../missions/recon.js';

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const CLIMB_MAX = (68 * Math.PI) / 180;
const _v = new Vector3();
const _lead = new Vector3();

export class Bot {
  constructor(game, { god = false } = {}) {
    this.game = game;
    this.intent = { turn: 0, climb: 0, yaw: 0, speed: 0, boost: false, brake: 0, throttle: 0.8 };
    this.state = 'attack';
    this.timer = 0;
    this.fireTimer = 0;
    this.flareTimer = 0;
    this.egressBearing = 0;
    this.god = god;
    this.log = [];
  }

  /** Point the flight path at a world position (plus an elevation offset). */
  _aim(f, pos, elevOffset = 0, gain = 1.5) {
    const dx = pos.x - f.position.x, dz = pos.z - f.position.z, dy = pos.y - f.position.y;
    const bearing = Math.atan2(dx, -dz);
    const heading = Math.atan2(f.forward.x, -f.forward.z);
    const horiz = Math.hypot(dx, dz);
    const elev = Math.atan2(dy, horiz) + elevOffset;
    this.intent.turn = clamp(wrapPi(bearing - heading) * gain, -1, 1);
    // Close the error between where the *nose* points and the target line by
    // moving the flight path the same amount.
    const nose = Math.asin(clamp(f.forward.y, -1, 1));
    const path = Math.asin(clamp(f.velocity.y / Math.max(f.airspeed, 1), -1, 1));
    this.intent.climb = clamp((path + (elev - nose) * 1.2) / CLIMB_MAX, -0.7, 0.9);
  }

  _hold(f, bearing, altitude) {
    const heading = Math.atan2(f.forward.x, -f.forward.z);
    this.intent.turn = clamp(wrapPi(bearing - heading) * 1.4, -1, 1);
    this.intent.climb = clamp((altitude - f.position.y) / 600 - f.velocity.y / 250, -0.4, 0.7);
  }

  _terrainGuard(f) {
    const p = f.position, v = f.velocity;
    const look = 5;
    const ridge = maxHeightAlong(p.x, p.z, p.x + v.x * look, p.z + v.z * look, 8);
    const predicted = Math.min(p.y, p.y + v.y * look);
    if (predicted < ridge + 230 || f.agl < 260) { this.intent.climb = 0.95; this.intent.brake = 0; return true; }
    return false;
  }

  _chooseTarget(combat, f) {
    let best = null, bestScore = Infinity;
    for (const t of combat.world.targets) {
      if (!t.alive || t === combat.player || t.team === 'friendly') continue;
      const d = t.position.distanceTo(f.position);
      let s;
      if (t.class === 'air') {
        if (t.team !== 'hostile') continue;
        const hunting = t.fighter?.mem.aware && this.game.systems.ai.hostile;
        if (!hunting && !t.isTarget) continue;
        s = d - (hunting ? 60000 : 0) - (t.isTarget ? 5000 : 0);
      } else if (t.kind === 'post') {
        if (t.captured) continue;
        s = d;
      } else {
        // Mission targets, plus any air defence that is close enough to hurt.
        const shooter = !!t.unit?.def.behaviour && d < 4500;
        if (!t.isTarget && !shooter) continue;
        s = d + (t.kind === 'truck' ? -8000 : 0) - (shooter ? 2500 : 0);
      }
      if (s < bestScore) { bestScore = s; best = t; }
    }
    return best;
  }

  update(dt, f, game) {
    const combat = game.systems.combat;
    const input = game.input;
    const hud = game.hud;
    const intent = this.intent;
    if (this.god) combat.world.god = true;
    intent.turn = 0; intent.climb = 0; intent.brake = 0; intent.throttle = 0.86; intent.boost = false;
    input.setAction('fireGun', false);
    input.setAction('optic', false);
    this.timer -= dt; this.fireTimer -= dt; this.flareTimer -= dt;
    if (!combat.active || !combat.player.alive) return;

    // Defensive: flares on any threat, and a hard break when it is close.
    const threats = hud.threats ?? [];
    let breaking = false;
    if (threats.length) {
      if (this.flareTimer <= 0) { input.pressAction('flares'); this.flareTimer = 1.4; }
      const near = threats.reduce((a, b) => (a.distance < b.distance ? a : b));
      if (near.distance < 2200) {
        intent.turn = near.bearing >= 0 ? -1 : 1; // put it on the beam, turning away from its side
        intent.climb = -0.1;
        intent.brake = near.distance < 900 ? 1 : 0;
        intent.throttle = 1;
        breaking = true;
      }
    }

    const t = this._chooseTarget(combat, f);
    if (t && combat.target !== t) combat.setTarget(t);

    if (!breaking) {
      if (!t) {
        const mk = hud.objective?.marker;
        if (mk) this._hold(f, Math.atan2(mk.x - f.position.x, -(mk.z - f.position.z)), Math.max(terrainHeight(mk.x, mk.z), terrainHeight(f.position.x, f.position.z)) + 1300);
        else this._hold(f, Math.atan2(f.forward.x, -f.forward.z), f.position.y);
        intent.throttle = 1;
      } else if (t.class === 'air') this._air(dt, f, t, combat, input);
      else if (t.kind === 'post') this._photo(f, t, input);
      else this._ground(dt, f, t, combat, input, hud);
    }
    this._terrainGuard(f);
  }

  _air(dt, f, t, combat, input) {
    const d = t.position.distanceTo(f.position);
    // Prefer the dogfight / long-range special against aircraft when it has ammo.
    const sp = combat.sp;
    const wantSp = sp.def.type === 'missile' && sp.ammo > 0 && d < sp.def.lockRange;
    if ((combat.current === 'sp') !== wantSp) combat.switchWeapon();
    leadPoint(_lead, f.position, f.velocity, t.position, t.velocity, 1050);
    this._aim(f, d < 1500 ? _lead : t.position, 0.03);
    this.intent.throttle = d > 1800 ? 1 : 0.8;
    _v.subVectors(t.position, f.position).normalize();
    const off = Math.acos(clamp(_v.dot(f.forward), -1, 1));
    // High-G turn when the target is well off the nose and close.
    if (off > 0.9 && d < 2500 && f.airspeed > 230) this.intent.brake = 1;
    if (combat.lock.state === 'locked' && this.fireTimer <= 0) { input.pressAction('fireMissile'); this.fireTimer = 1.3; }
    _v.subVectors(_lead, f.position).normalize();
    if (d < 1300 && Math.acos(clamp(_v.dot(f.forward), -1, 1)) < 0.06) input.setAction('fireGun', true);
  }

  _photo(f, t, input) {
    const d = t.position.distanceTo(f.position);
    if (d > 5200) {
      this._hold(f, Math.atan2(t.position.x - f.position.x, -(t.position.z - f.position.z)), t.position.y + 950);
      this.intent.throttle = 1;
      return;
    }
    input.setAction('optic', true);
    // Put the depressed optic axis, not the nose, on the post.
    this._aim(f, t.position, OPTIC.depression - 0.03);
    this.intent.throttle = 0.7;
    if (d < 900) this.intent.climb = 0.6;
  }

  _ground(dt, f, t, combat, input, hud) {
    const dx = t.position.x - f.position.x, dz = t.position.z - f.position.z;
    const horiz = Math.hypot(dx, dz);
    const d = t.position.distanceTo(f.position);
    // Guided missiles do the bot's ground work (they only need the target in
    // the lock cone); rockets want a steadier hand than this pilot has.
    const rockets = false;
    if ((combat.current === 'sp') !== rockets) combat.switchWeapon();

    if (this.state === 'egress') {
      this._hold(f, this.egressBearing, t.position.y + 1700);
      this.intent.throttle = f.airspeed > 300 ? 0.6 : 1;
      if (this.timer <= 0 || horiz > 5000) this.state = 'attack';
      return;
    }
    if (horiz > 4600 || f.position.y < t.position.y + 500) {
      // Set up: get above it and point at it.
      this._hold(f, Math.atan2(dx, -dz), t.position.y + 1500);
      this.intent.throttle = f.airspeed > 290 ? 0.5 : 0.9;
      if (horiz < 2500 && f.position.y < t.position.y + 500) { this.state = 'egress'; this.timer = 26; this.egressBearing = Math.atan2(f.forward.x, -f.forward.z); }
      return;
    }
    // Too steep to make a pass from here: go out and come back.
    if ((f.position.y - t.position.y) / Math.max(horiz, 1) > 0.8) {
      this.state = 'egress'; this.timer = 26; this.egressBearing = Math.atan2(f.forward.x, -f.forward.z);
      return;
    }
    // Run in: slow enough to aim.
    this.intent.throttle = f.airspeed > 270 ? 0.3 : 0.75;
    this.intent.brake = f.airspeed > 310 ? 1 : 0;
    if (rockets) {
      this._aim(f, t.position, 0.02);
      const ccip = hud.weapon?.ccip;
      if (ccip) {
        const miss = Math.hypot(ccip.x - t.position.x, ccip.z - t.position.z);
        if (miss < Math.max(38, t.radius * 1.6) && d < 3200 && this.fireTimer <= 0) { input.pressAction('fireMissile'); this.fireTimer = 1.0; }
      }
    } else {
      this._aim(f, t.position, 0.0);
      if (combat.lock.state === 'locked' && this.fireTimer <= 0) { input.pressAction('fireMissile'); this.fireTimer = 0.7; }
    }
    _v.subVectors(t.position, f.position).normalize();
    if (d < 1500 && Math.acos(clamp(_v.dot(f.forward), -1, 1)) < 0.035) input.setAction('fireGun', true);
    if (d < 1150 || f.agl < 330) {
      this.state = 'egress';
      this.timer = 26;
      this.egressBearing = Math.atan2(f.forward.x, -f.forward.z);
    }
  }
}
