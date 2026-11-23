// DEV ONLY. A pilot that flies a sortie through the same path a player's
// hands take: it writes the assisted controller's intent (turn / climb /
// brake / throttle) and presses input actions (missile, gun, flares, weapon
// switch, optic). It never repositions the aircraft and takes damage like
// anyone else. Used to measure whether the missions are winnable and fair.
// Not shipped: loaded only from dev/index.js behind `import.meta.env.DEV`.
//
// It is meant to play like a competent, slightly mechanical human:
//   - navigates to the objective marker over the ridges, not through them
//   - picks targets (hunting fighters first, then the radar that feeds the
//     SAMs, then mission targets and whatever air defence covers them)
//   - ground attack: set up, run in on the nose, lock, fire, break off, re-attack
//   - air combat: pursuit, lock, missile; gun inside a kilometre
//   - missile defence: flares after a human reaction delay, beam it, then a
//     high-G break as it arrives
//   - terrain: a look-ahead fan over the track; climbs, and turns for the low
//     side when the wall is too steep to out-climb
import { Vector3 } from 'three';
import { maxHeightAlong, terrainHeight } from '../../world/terrain/heightfield.js';
import { clearLine } from '../../combat/los.js';
import { wrapPi } from '../Autopilot.js';
import { leadPoint } from '../../combat/guidance.js';
import { OPTIC } from '../../missions/recon.js';

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const D = Math.PI / 180;
const CLIMB_MAX = 68 * D; // AssistController combat profile: full stick = this flight path
const PROBES = [120, 260, 450, 700, 1000, 1400, 1900, 2500, 3200, 4000];
const _v = new Vector3();
const _lead = new Vector3();
const _a = new Vector3();

export const BOT_DEFAULTS = {
  god: false,
  /** Seconds between a threat appearing and the first flare / the break. */
  reaction: 0.6,
  /** false: never flares (evasion trials). */
  flares: true,
  /** false: never breaks for a missile (evasion trials). */
  evade: true,
  /** Use rockets / bombs on hard targets when carried. */
  specials: true,
};

export class Bot {
  constructor(game, opts = {}) {
    this.game = game;
    this.opts = { ...BOT_DEFAULTS, ...opts };
    this.god = this.opts.god;
    this.intent = { turn: 0, climb: 0, yaw: 0, speed: 0, boost: false, brake: 0, throttle: 0.8 };
    this.state = 'nav';
    this.current = null;
    this.timer = 0;
    this.fireTimer = 0;
    this.flareTimer = 0;
    this.switchTimer = 0;
    this.threatAge = 0;
    this.egressBearing = 0;
    this.runs = 0;
    /** Counters for the run report. */
    this.stats = { flares: 0, breaks: 0, passes: 0, terrainSaves: 0, gunBursts: 0 };
  }

  // ------------------------------------------------------------ helpers --

  _heading(f) { return Math.atan2(f.forward.x, -f.forward.z); }
  _track(f) { return f.airspeed > 20 ? Math.atan2(f.velocity.x, -f.velocity.z) : this._heading(f); }
  _path(f) { return Math.asin(clamp(f.velocity.y / Math.max(f.airspeed, 1), -1, 1)); }

  /** Put the nose on a world point (plus an elevation offset in radians). */
  _aim(f, pos, elevOffset = 0, gain = 2.2) {
    const dx = pos.x - f.position.x, dz = pos.z - f.position.z, dy = pos.y - f.position.y;
    const err = wrapPi(Math.atan2(dx, -dz) - this._heading(f));
    this.intent.turn = clamp(err * gain, -1, 1);
    const elev = Math.atan2(dy, Math.hypot(dx, dz)) + elevOffset;
    // The stick commands the flight path; close the nose error by moving the
    // path the same amount.
    const nose = Math.asin(clamp(f.forward.y, -1, 1));
    this.intent.climb = clamp((this._path(f) + (elev - nose) * 1.3) / CLIMB_MAX, -0.8, 0.95);
    return err;
  }

  /** Fly a compass bearing (radians) at an altitude. */
  _hold(f, bearing, altitude) {
    this.intent.turn = clamp(wrapPi(bearing - this._heading(f)) * 1.6, -1, 1);
    const gamma = clamp((altitude - f.position.y) / 1400, -0.3, 0.42);
    this.intent.climb = gamma / CLIMB_MAX;
  }

  /** Fly toward a point at a safe height over whatever is on the way. */
  _goto(f, x, z, altitude) {
    const dx = x - f.position.x, dz = z - f.position.z;
    const d = Math.hypot(dx, dz) || 1;
    const look = Math.min(d, 6000);
    const ridge = maxHeightAlong(f.position.x, f.position.z, f.position.x + (dx / d) * look, f.position.z + (dz / d) * look, 12);
    this._hold(f, Math.atan2(dx, -dz), Math.max(altitude, ridge + 450));
    return d;
  }

  _speed(f, want) {
    const v = f.airspeed;
    const i = this.intent;
    if (v < want - 20) i.throttle = 1;
    else if (v < want + 15) i.throttle = 0.82;
    else if (v < want + 50) i.throttle = 0.35;
    else { i.throttle = 0.15; i.brake = Math.max(i.brake, 1); }
  }

  /** Flight-path angle needed to clear the ground along a heading by `margin`. */
  _requiredPath(f, heading, margin, reach = Infinity) {
    const p = f.position;
    const sx = Math.sin(heading), sz = -Math.cos(heading);
    let req = -1.5, prev = 0;
    for (const d of PROBES) {
      if (prev > reach) break;
      const h = maxHeightAlong(p.x + sx * prev, p.z + sz * prev, p.x + sx * d, p.z + sz * d, 3);
      const a = Math.atan2(h + margin - p.y, Math.max(prev, 90));
      if (a > req) req = a;
      prev = d;
    }
    return req;
  }

  /**
   * Last word on the stick: never accept a flight path that meets the ground.
   * Returns true when it overrode the intent.
   */
  _terrain(f, margin = 220, horizon = 16) {
    const i = this.intent;
    const track = this._track(f);
    // Only ground that is `horizon` seconds away matters: an attack run points
    // the nose at a hillside on purpose and pulls off in time.
    const reach = f.airspeed * horizon;
    // Where the turn in hand is taking the aircraft matters as much as where
    // it points now.
    const ahead = track + i.turn * 0.35;
    const req = Math.max(this._requiredPath(f, track, margin, reach), this._requiredPath(f, ahead, margin * 0.8, reach));
    const need = req + (horizon < 8 ? 2 : 5) * D;
    let over = false;
    if (i.climb * CLIMB_MAX < need) {
      i.climb = clamp(need / CLIMB_MAX, -1, 1);
      over = need > this._path(f) + 3 * D;
    }
    if (req > 20 * D) {
      // Too steep to out-climb in this air: go for the low side as well.
      let best = 0, bestReq = req;
      for (const off of [-80, -40, 40, 80]) {
        const r = this._requiredPath(f, track + off * D, margin, reach);
        if (r < bestReq - 2 * D) { bestReq = r; best = off; }
      }
      if (best) i.turn = Math.sign(best);
      i.throttle = 1; i.brake = req > 32 * D && f.airspeed > 200 ? 1 : 0;
      over = true;
    }
    if (f.agl < 160) { i.climb = Math.max(i.climb, 0.55); i.throttle = 1; over = true; }
    if (over && i.climb > 0.25) { i.throttle = 1; if (req < 32 * D) i.brake = 0; }
    if (over && !this._wasOver) this.stats.terrainSaves++;
    this._wasOver = over;
    return over;
  }

  /** Damage already in the air toward a target (don't waste missiles). */
  _pending(combat, t) {
    let dmg = 0;
    for (const m of combat.world.missiles) if (m.alive && m.owner === combat.player && m.target === t) dmg += m.weapon.damage * (t.armor === 'hard' ? 0.7 : t.armor === 'soft' ? 1.6 : 1);
    return dmg;
  }

  _select(combat, input, wantSp) {
    if ((combat.current === 'sp') === wantSp || this.switchTimer > 0) return;
    input.pressAction('switchWeapon');
    this.switchTimer = 0.4;
  }

  // ------------------------------------------------------------ targets --

  _chooseTarget(combat, f) {
    const ai = this.game.systems.ai;
    const pos = f.position;
    let best = null, bestScore = Infinity;
    let liveSam = false;
    for (const t of combat.world.targets) if (t.alive && t.kind === 'sam') { liveSam = true; break; }
    const cur = this.current;
    for (const t of combat.world.targets) {
      if (!t.alive || t === combat.player || t.team === 'friendly') continue;
      const d = t.position.distanceTo(pos);
      let s;
      if (t.class === 'air') {
        if (t.team !== 'hostile' || !ai.hostile) continue;
        const hunting = t.fighter?.mem.aware;
        if (!hunting && !t.isTarget) continue;
        // Something that is coming for us outranks everything inside 12 km.
        if (hunting && d < 12000) s = d - 100000 - (1 - t.health / t.maxHealth) * 1500;
        else if (t.isTarget) s = d - 60000;
        else continue;
      } else if (t.kind === 'post') {
        if (t.captured) continue;
        s = d - 20000;
      } else {
        const unit = t.unit;
        const shooter = !!unit?.def.behaviour;
        if (t.kind === 'radar' && liveSam && d < 11000) s = d - 30000;
        else if (t.isTarget) s = d + (t.kind === 'truck' ? -9000 : 0);
        // Air defence close to what we are working on is worth a missile.
        else if (shooter && t.kind !== 'sam' && d < 5200 && cur && cur.class !== 'air' && t.position.distanceTo(cur.position) < 900) s = d - 1200;
        else continue;
      }
      if (t === cur) s -= 1500; // stay on it
      if (s < bestScore) { bestScore = s; best = t; }
    }
    return best;
  }

  // ------------------------------------------------------------- update --

  update(dt, f, game) {
    const combat = game.systems.combat;
    const input = game.input;
    const hud = game.hud;
    const intent = this.intent;
    if (this.god) combat.world.god = true;
    intent.turn = 0; intent.climb = 0; intent.brake = 0; intent.throttle = 0.86; intent.boost = false;
    input.setAction('fireGun', false);
    input.setAction('optic', false);
    this.timer -= dt; this.fireTimer -= dt; this.flareTimer -= dt; this.switchTimer -= dt;
    if (!combat.active || !combat.player.alive || f.crashed) return;

    const defending = this._defend(dt, f, hud, input);

    let t = this.current;
    const best = this._chooseTarget(combat, f);
    const keep = t && t.alive && !t.captured && t.class !== 'air' && t.kind !== 'post' && best?.class !== 'air'
      && (this.state === 'run' || this.state === 'egress') && t.position.distanceTo(f.position) < 8000;
    if (!keep && t !== best) { t = best; this.state = 'nav'; }
    this.current = t;
    if (t && combat.target !== t) combat.setTarget(t);

    let margin = 220;
    if (!defending) {
      if (!t) this._idle(f, hud);
      else if (t.class === 'air') { this.state = 'air'; this._air(dt, f, t, combat, input); margin = 170; }
      else if (t.kind === 'post') { this.state = 'photo'; this._photo(f, t, input); margin = 150; }
      else margin = this._ground(dt, f, t, combat, input, hud);
    } else margin = 150;
    this._terrain(f, margin, this.state === 'run' ? 4.2 : this.state === 'air' || this.state === 'photo' ? 8 : 16);
  }

  // ------------------------------------------------------------- states --

  _idle(f, hud) {
    this.state = 'nav';
    const mk = hud.objective?.marker;
    if (mk) this._goto(f, mk.x, mk.z, terrainHeight(mk.x, mk.z) + 1200);
    else {
      // Nothing to do: stay inside the map.
      const out = Math.abs(f.position.x) > 38000 || Math.abs(f.position.z) > 38000;
      const b = out ? Math.atan2(-f.position.x, f.position.z) : this._heading(f);
      this._hold(f, b, Math.max(f.position.y, terrainHeight(f.position.x, f.position.z) + 1200));
    }
    this._speed(f, 300);
  }

  /** Missile defence. Returns true while it owns the stick. */
  _defend(dt, f, hud, input) {
    const threats = hud.threats ?? [];
    if (!threats.length) { this.threatAge = 0; return false; }
    this.threatAge += dt;
    if (this.threatAge < this.opts.reaction) return false;
    let near = threats[0];
    for (const th of threats) if (th.distance < near.distance) near = th;
    const m = near.missile;
    const tti = near.distance / Math.max(m?.speed ?? 600, 200);
    const ir = m?.weapon?.guidance !== 'radar';
    if (this.opts.flares && ir && near.distance < 4200 && this.flareTimer <= 0) {
      input.pressAction('flares');
      this.flareTimer = 1.35;
      this.stats.flares++;
    }
    if (!this.opts.evade || this.god || tti > 5) return false;
    const i = this.intent;
    const b = near.bearing; // degrees, + = right
    // Put it on the beam: turn away while it is ahead of the wing line, into
    // it once it is behind.
    i.turn = b >= 0 ? (b < 90 ? -1 : 1) : (b > -90 ? 1 : -1);
    i.climb = ir ? -0.12 : -0.3; // radar SAM: get down among the ridges
    i.throttle = 1;
    i.brake = tti < 1.6 ? 1 : 0; // last-ditch high-G break
    if (!this._breaking) this.stats.breaks++;
    this._breaking = true;
    this.state = 'defend';
    return true;
  }

  _air(dt, f, t, combat, input) {
    this._breaking = false;
    const d = t.position.distanceTo(f.position);
    const sp = combat.sp;
    const wantSp = sp.def.type === 'missile' && sp.ammo > 0 && d < sp.def.lockRange * 1.05 && !(sp.def.id === 'lraam' && d < 1500 && combat.msl.ammo > 0);
    this._select(combat, input, wantSp || combat.msl.ammo <= 0);
    const tof = leadPoint(_lead, f.position, f.velocity, t.position, t.velocity, 1050, 0.35);
    const gunTime = d < 1500 && Number.isFinite(tof);
    this._aim(f, gunTime ? _lead : t.position, gunTime ? 0 : 0.02, 2.6);
    _v.subVectors(t.position, f.position).normalize();
    const off = Math.acos(clamp(_v.dot(f.forward), -1, 1));
    // Energy: fast to close, corner speed in the turn, do not overshoot.
    _a.subVectors(t.velocity, f.velocity);
    const closure = -_v.dot(_a);
    if (d > 3000) this._speed(f, 330);
    else if (d < 700 && closure > 40) this._speed(f, Math.max(180, t.velocity.length() - 20));
    else this._speed(f, 265);
    // High-G turn when it is well off the nose and close.
    if (off > 55 * D && d < 3000 && f.airspeed > 215) this.intent.brake = 1;
    // Keep some height in hand when the fight goes low.
    if (f.agl < 600 && this.intent.climb < 0) this.intent.climb *= 0.3;

    const w = combat.weapon.def;
    if (combat.lock.state === 'locked' && this.fireTimer <= 0 && combat.weapon.ammo > 0 && this._pending(combat, t) < t.health + 30) {
      input.pressAction('fireMissile');
      this.fireTimer = w.id === 'lraam' ? 2.5 : 1.1;
    }
    if (gunTime && d < 1150 && combat.gun.ammo > 0) {
      _v.subVectors(_lead, f.position).normalize();
      if (Math.acos(clamp(_v.dot(f.forward), -1, 1)) < 2.6 * D) { input.setAction('fireGun', true); if (!this._gun) this.stats.gunBursts++; this._gun = true; return; }
    }
    this._gun = false;
  }

  /** Recon: stand off, run in on a line that can see the post, frame it, break away. */
  _photo(f, t, input) {
    const dx = t.position.x - f.position.x, dz = t.position.z - f.position.z;
    const horiz = Math.hypot(dx, dz);
    const d = t.position.distanceTo(f.position);
    if (this.photo?.target !== t) this.photo = { target: t, phase: 'setup', timer: 0 };
    const ph = this.photo;
    if (ph.phase === 'out') {
      ph.timer -= 1 / 30;
      this._hold(f, ph.bearing, Math.max(t.position.y + 900, f.position.y));
      this._speed(f, 280);
      if (ph.timer <= 0 || horiz > 4300) { ph.phase = 'setup'; this.ip = null; }
      return;
    }
    const bearingErr = Math.abs(wrapPi(Math.atan2(dx, -dz) - this._heading(f)));
    if (ph.phase === 'setup') {
      const placed = horiz > 2600 && horiz < OPTIC.hardMax - 300 && bearingErr < 35 * D && f.position.y > t.position.y + 200
        && clearLine(f.position, _v.copy(t.position).setY(t.position.y + 10), 60);
      if (placed) ph.phase = 'frame';
      else {
        if (horiz < 2200 && bearingErr < 80 * D) { ph.phase = 'out'; ph.timer = 14; ph.bearing = this._heading(f); return; }
        if (!this.ip || this.ip.target !== t) this.ip = this._planIp(f, t) ?? { x: t.position.x, y: t.position.y + 1000, z: t.position.z, target: t, none: true };
        const ip = this.ip;
        const dIp = this._goto(f, ip.x, ip.z, ip.y);
        if (dIp < 1300 || ip.reached) {
          ip.reached = true;
          this.intent.turn = clamp(wrapPi(Math.atan2(dx, -dz) - this._heading(f)) * 2, -1, 1);
          if (horiz > 7500) ip.reached = false;
        }
        this._speed(f, 290);
        return;
      }
    }
    input.setAction('optic', true);
    // Put the depressed optic axis, not the nose, on the post.
    this._aim(f, t.position, OPTIC.depression - 0.02);
    this._speed(f, 215);
    if (d < 1100 || bearingErr > 70 * D) { ph.phase = 'out'; ph.timer = 14; ph.bearing = this._heading(f); }
  }

  /**
   * Where to start an attack run from: 4.6 km out on a bearing that can see
   * the target (a position dug into a ridge is masked from half the compass).
   * Nearest such point wins. Null when nothing sees it.
   */
  _planIp(f, t) {
    const tp = t.position;
    let best = null, bestCost = Infinity;
    for (let k = 0; k < 16; k++) {
      const b = k * 22.5 * D;
      const x = tp.x + Math.sin(b) * 4600, z = tp.z - Math.cos(b) * 4600;
      const y = Math.max(tp.y + 850, terrainHeight(x, z) + 450);
      _a.set(x, y, z);
      _v.copy(tp); _v.y += 10;
      if (!clearLine(_a, _v, 60)) continue;
      // The run itself must have air under it, not just a sight line.
      let ok = true;
      for (let u = 0.2; u < 0.8 && ok; u += 0.15) {
        const px = x + (tp.x - x) * u, pz = z + (tp.z - z) * u, py = y + (tp.y - y) * u;
        if (py < terrainHeight(px, pz) + 110) ok = false;
      }
      if (!ok) continue;
      const cost = Math.hypot(x - f.position.x, z - f.position.z) + Math.max(0, y - f.position.y) * 3;
      if (cost < bestCost) { bestCost = cost; best = { x, y, z, target: t }; }
    }
    return best;
  }

  /** Another worthwhile ground target inside the lock cone, for the same pass. */
  _neighbour(combat, f, t) {
    let best = null, bestAng = 13 * D;
    for (const o of combat.world.targets) {
      if (!o.alive || o === t || o.class === 'air' || o.team !== 'hostile' || o.lockable === false) continue;
      if (!o.isTarget && !o.unit?.def.behaviour) continue;
      const d = o.position.distanceTo(f.position);
      if (d < 1900 || d > 4600 || this._pending(combat, o) >= o.health) continue;
      _v.subVectors(o.position, f.position).normalize();
      const ang = Math.acos(clamp(_v.dot(f.forward), -1, 1));
      if (ang < bestAng && clearLine(f.position, _a.copy(o.position).setY(o.position.y + 10), 80)) { bestAng = ang; best = o; }
    }
    return best;
  }

  _startEgress(f, t, seconds) {
    // Break off toward the lower ground, not along the ridge we just struck.
    const h = this._heading(f);
    const l = this._requiredPath(f, h - 45 * D, 300), r = this._requiredPath(f, h + 45 * D, 300);
    this.egressBearing = h + (l < r ? -45 : 45) * D;
    this.state = 'egress';
    this.timer = seconds;
    this.egressAge = 0;
    this.ip = null;
  }

  /** Returns the terrain margin this phase of the attack wants. */
  _ground(dt, f, t, combat, input, hud) {
    this._breaking = false;
    const dx = t.position.x - f.position.x, dz = t.position.z - f.position.z;
    const horiz = Math.hypot(dx, dz);
    const d = t.position.distanceTo(f.position);
    const above = f.position.y - t.position.y;
    const sp = combat.sp;
    const hard = t.armor === 'hard';
    // Rockets are the fallback: this pilot's hands are steadier on a lock-on
    // than on a pipper (measured: 14-19 rocket passes did not clear M1 in 15 minutes).
    const rockets = this.opts.specials && sp.def.type === 'rocket' && sp.ammo > 0 && (this.opts.rockets || combat.msl.ammo <= 0);
    const bombs = this.opts.specials && sp.def.type === 'bomb' && sp.ammo > 0 && hard && t.radius >= 12;
    const noMissiles = combat.msl.ammo <= 0 && !rockets && !bombs;

    if (this.state === 'egress') {
      this.egressAge += dt;
      this._hold(f, this.egressBearing, Math.max(t.position.y + 1100, f.position.y));
      this._speed(f, 290);
      if (this.timer <= 0 || (this.egressAge > 6 && horiz > 5200 && above > 500)) this.state = 'nav';
      return 220;
    }

    // ---- bombs: a level pass over the top, release on the CCIP pipper ----
    if (bombs) {
      this._select(combat, input, true);
      if (this.state !== 'run') {
        if (horiz < 3200 && this.state === 'nav') { this._startEgress(f, t, 22); return 220; }
        this.state = 'run'; this.dropped = false; this.stats.passes++;
      }
      this._hold(f, Math.atan2(dx, -dz), t.position.y + 750);
      this.intent.turn = clamp(wrapPi(Math.atan2(dx, -dz) - this._heading(f)) * 3, -1, 1);
      this._speed(f, 240);
      const ccip = hud.weapon?.ccip;
      if (ccip && hud.weapon.type === 'bomb' && horiz < 4000 && this.fireTimer <= 0) {
        const miss = Math.hypot(ccip.x - t.position.x, ccip.z - t.position.z);
        if (miss < 32) { input.pressAction('fireMissile'); this.fireTimer = 0.5; this.dropped = true; }
      }
      if (horiz < 450 && (this.dropped || horiz < 160)) this._startEgress(f, t, 20);
      return 200;
    }

    // ---- missiles / rockets / gun: a diving pass on the nose --------------
    this._select(combat, input, rockets);
    if (this.state !== 'run') {
      // Set up: far enough out to have time on the target, above it, pointing
      // at it, with a clear line to it.
      const bearingErr = Math.abs(wrapPi(Math.atan2(dx, -dz) - this._heading(f)));
      const placed = horiz > 3000 && horiz < 6800 && above > 250 && above < horiz * 0.6 && bearingErr < 50 * D;
      if (placed && clearLine(f.position, _v.copy(t.position).setY(t.position.y + 10), 60)) {
        this.state = 'run';
        this.blind = 0;
        this.trim = 0;
        this.stats.passes++;
      } else {
        if (horiz < 2400 && bearingErr < 70 * D) { this._startEgress(f, t, 18); return 220; }
        if (!this.ip || this.ip.target !== t) this.ip = this._planIp(f, t) ?? { x: t.position.x, y: t.position.y + 1100, z: t.position.z, target: t, none: true };
        const ip = this.ip;
        const dIp = this._goto(f, ip.x, ip.z, ip.y);
        // At the start point (or with nowhere better to go): come round onto the target.
        if (dIp < 1300 || ip.reached) {
          ip.reached = true;
          this.intent.turn = clamp(wrapPi(Math.atan2(dx, -dz) - this._heading(f)) * 2, -1, 1);
          if (horiz > 7500) ip.reached = false;
        }
        this._speed(f, 290);
        this.state = 'nav';
        return 220;
      }
    }
    // Rockets fall, and the pipper is where they land: walk the pipper onto
    // the target the way a pilot does, by nudging the nose.
    let trim = 0;
    if (rockets) {
      const ccip = hud.weapon?.type === 'rocket' ? hud.weapon.ccip : null;
      if (ccip) {
        // Long or short, by range (on a crest the elevation of the impact
        // point says nothing: a long shot lands down the back slope).
        const hc = Math.hypot(ccip.x - f.position.x, ccip.z - f.position.z);
        const long = hc - horiz;
        // ... and high or low by angle (on a steep face a short shot lands
        // almost straight below the target).
        const high = Math.atan2(ccip.y - f.position.y, hc) - Math.atan2(t.position.y - f.position.y, horiz);
        this.trim = clamp(this.trim - clamp(long / 40 + high / (0.4 * D), -1, 1) * 2.4 * D * dt, -4 * D, 4 * D);
      } else this.trim = clamp(this.trim - 0.6 * D * dt, -4 * D, 4 * D); // pipper is off the hill: nose down
      trim = this.trim;
    }
    const err = this._aim(f, t.position, trim);
    // A run that cannot see its target is a waste of a pass: break off.
    if (clearLine(f.position, _v.copy(t.position).setY(t.position.y + 10), 80)) this.blind = 0;
    else if ((this.blind += dt) > 2.5) { this._startEgress(f, t, 14); return 220; }
    this._speed(f, noMissiles ? 250 : 235);
    if (rockets) {
      const ccip = hud.weapon?.ccip;
      if (ccip && hud.weapon.type === 'rocket' && d < 2800 && d > 900 && this.fireTimer <= 0) {
        const miss = Math.hypot(ccip.x - t.position.x, ccip.z - t.position.z, ccip.y - t.position.y);
        if (miss < Math.max(22, t.radius * 1.5)) { input.pressAction('fireMissile'); this.fireTimer = 0.95; }
      }
    } else if (combat.lock.state === 'locked' && this.fireTimer <= 0 && combat.weapon.ammo > 0 && this._pending(combat, t) < t.health) {
      input.pressAction('fireMissile');
      this.fireTimer = 0.4;
    } else if (!rockets && this._pending(combat, t) >= t.health && d > 1900) {
      // Enough is on its way to this one: use the rest of the pass on a
      // neighbour that is already in front of the nose.
      const next = this._neighbour(combat, f, t);
      if (next) { this.current = next; combat.setTarget(next); }
    }
    // Strafe soft things, and anything at all once the rails are empty.
    _v.subVectors(t.position, f.position).normalize();
    if (d < 1500 && (!hard || noMissiles) && combat.gun.ammo > 0 && Math.acos(clamp(_v.dot(f.forward), -1, 1)) < 2.2 * D) input.setAction('fireGun', true);
    const floor = noMissiles || rockets ? 950 : 1300;
    if (d < floor || above < 120 || Math.abs(err) > 1.2) this._startEgress(f, t, 20);
    return 110;
  }
}
