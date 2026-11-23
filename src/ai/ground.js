// Ground units: air defences (AAA, flak, shoulder-launched and radar SAMs),
// radar, fortified positions, supply dumps and road convoys. Data table +
// small behaviours. No rendering dependencies.
import { Vector3, Group } from 'three';
import { terrainHeight } from '../world/terrain/heightfield.js';
import { clearLine } from '../combat/los.js';
import { DIFFICULTY } from '../game/difficulty.js';
import { leadPoint } from '../combat/guidance.js';
import { WEAPONS } from '../combat/weapons.js';
import { alongPath, pathLength } from './sites.js';

export const GROUND = {
  aaa:     { name: 'AA GUN',     health: 55,  armor: 'medium', radius: 7,  score: 150, behaviour: 'aaa', range: 2500 },
  flak:    { name: 'FLAK',       health: 85,  armor: 'medium', radius: 8,  score: 200, behaviour: 'flak', range: 5000, minRange: 900 },
  manpads: { name: 'SAM TEAM',   health: 28,  armor: 'soft',   radius: 6,  score: 200, behaviour: 'manpads', range: 3800, minRange: 500, lockTime: 3.0, reload: 16, weapon: 'e_manpads', rounds: 3 },
  sam:     { name: 'SAM SITE',   health: 95,  armor: 'medium', radius: 9,  score: 350, behaviour: 'sam', range: 8500, minRange: 1400, lockTime: 4.2, reload: 15, weapon: 'e_sam', radarFloor: 150 },
  radar:   { name: 'RADAR',      health: 70,  armor: 'medium', radius: 9,  score: 300 },
  bunker:  { name: 'BUNKER',     health: 260, armor: 'hard',   radius: 12, score: 300 },
  sangar:  { name: 'SANGAR',     health: 80,  armor: 'hard',   radius: 8,  score: 150 },
  supply:  { name: 'SUPPLY DUMP', health: 70, armor: 'soft',   radius: 12, score: 300, explosion: 'huge', secondary: { radius: 95, damage: 160 } },
  tent:    { name: 'TENT',       health: 26,  armor: 'soft',   radius: 6,  score: 60, explosion: 'medium' },
  truck:   { name: 'TRUCK',      health: 34,  armor: 'soft',   radius: 6,  score: 120, explosion: 'medium' },
  post:    { name: 'OBSERVATION POST', health: 1e9, armor: 'hard', radius: 10, score: 0, invulnerable: true, lockable: false, team: 'neutral' },
};

/**
 * Anti-aircraft gunnery (Normal difficulty; see game/difficulty.js for scaling).
 *
 * Measured with the flying bot before this table existed: guns led a
 * constant-velocity target perfectly with a small fixed error, so an attack
 * run flown straight at a position (which is what a lock-on needs) cost about
 * 55 points of a 100-point airframe per mission from AAA alone, flak another
 * 50, and no mission was survivable. Two changes make ground fire a threat
 * you can read and answer instead of a tax:
 *   - the crew's lead lags the target (`trackLag`): fire converges on an
 *     aircraft that flies straight and falls behind one that manoeuvres;
 *   - each engagement starts wide and is walked on (`aaaRanging` per burst),
 *     so the first tracers are the warning, not the hit.
 */
export const AA = {
  trackLag: 0.9,          // s, first-order lag on the velocity used for lead
  aaaError: 0.105,        // rad, half-width of the first burst's aiming error
  aaaRanging: 0.85,       // error multiplier per following burst ...
  aaaRangingFloor: 0.6,   // ... down to this fraction
  aaaBurst: [0.9, 0.6],   // s, base + random
  aaaPause: [2.0, 1.6],   // s between bursts, base + random
  flakError: [38, 0.018], // m at the gun + m per metre of range (per axis, half-width)
  flakRadius: 55,         // m, burst radius (damage falls off linearly to 0)
  flakDamage: 6.5,
  flakPause: [1.9, 1.5],  // s between shells, base + random
  flakSpeed: 820,         // m/s, shell
};

/** Aiming error half-width (rad) of an AA gun's n-th burst of an engagement. */
export function aaaBurstError(n, d = DIFFICULTY.normal) {
  return (AA.aaaError * Math.max(AA.aaaRangingFloor, AA.aaaRanging ** n)) / d.accuracy;
}

const _aim = new Vector3();
const _v = new Vector3();
const _muzzle = new Vector3();

export class GroundUnit {
  constructor(type, x, z, def = {}, rng = Math.random) {
    const d = GROUND[type] ?? GROUND.bunker;
    this.type = type;
    this.def = d;
    this.rng = rng;
    this.group = def.group ?? null; // {radar: GroundUnit|null, alerted: bool}
    const y = terrainHeight(x, z);
    this.entity = {
      kind: type, class: 'ground', armor: d.armor, team: d.team ?? 'hostile', name: def.name ?? d.name,
      position: new Vector3(x, y + 2.5, z), velocity: new Vector3(),
      alive: true, health: def.health ?? d.health, radius: d.radius, score: def.score ?? d.score,
      isTarget: def.isTarget === true, tags: def.tags ?? [], explosion: d.explosion, secondary: d.secondary,
      invulnerable: d.invulnerable === true, lockable: d.lockable, object3d: new Group(), unit: this,
    };
    this.entity.object3d.position.set(x, y, z);
    this.entity.object3d.rotation.y = def.heading ?? rng() * Math.PI * 2;
    this.timer = 1 + rng() * 2;
    this.burst = 0;
    this.acc = 0;
    this.lock = 0;
    this.los = false;
    this.losTimer = rng() * 0.5;
    this.firing = false;
    this.locking = false;
    this.pending = []; // flak shells in flight: {t, position}
    /** The crew's estimate of the target's velocity (lags the real one). */
    this.track = new Vector3();
    this.tracking = false;
    this.idle = 0;
    this.bursts = 0;
    /** Missiles left (a shoulder-launch team carries a few; a SAM site reloads). */
    this.rounds = d.rounds ?? Infinity;
  }

  update(dt, ctx) {
    const e = this.entity;
    if (!e.alive) return;
    const b = this.def.behaviour;
    if (!b) return;
    const p = ctx.player;
    this.locking = false;
    const dist = p.position.distanceTo(e.position);
    const inRange = p.alive && ctx.hostile !== false && dist < this.def.range && dist > (this.def.minRange ?? 0);
    if (inRange) {
      this.losTimer -= dt;
      if (this.losTimer <= 0) {
        this.losTimer = 0.4;
        _muzzle.copy(e.position); _muzzle.y += 4;
        this.los = clearLine(_muzzle, p.position);
      }
    }
    const engaged = inRange && this.los;
    // Tracking: pick the target up, then follow its velocity with a lag.
    if (engaged) {
      if (!this.tracking) { this.track.copy(p.velocity); this.tracking = true; }
      else this.track.lerp(p.velocity, 1 - Math.exp(-dt / AA.trackLag));
      this.idle = 0;
    } else {
      this.idle += dt;
      // Lost for a few seconds: the next engagement is laid from scratch.
      if (this.idle > 3) { this.tracking = false; this.bursts = 0; }
    }
    if (b === 'aaa') this._aaa(dt, ctx, engaged, dist);
    else if (b === 'flak') this._flak(dt, ctx, engaged, dist);
    else this._sam(dt, ctx, engaged, dist);
    if (engaged) {
      // Cosmetic: face the target.
      e.object3d.rotation.y = Math.atan2(-(p.position.x - e.position.x), -(p.position.z - e.position.z));
    }
  }

  _setFiring(firing, ctx) {
    if (firing === this.firing) return;
    this.firing = firing;
    ctx.events.emit('weapon:gun', { firing, entity: this.entity });
  }

  _aaa(dt, ctx, engaged) {
    const w = WEAPONS.e_aaa;
    const diff = ctx.difficulty ?? DIFFICULTY.normal;
    this.timer -= dt;
    if (this.burst > 0) {
      this.burst -= dt;
      if (!engaged || this.burst <= 0) { this.burst = 0; this.timer = (AA.aaaPause[0] + this.rng() * AA.aaaPause[1]) / diff.aggression; }
    } else if (engaged && this.timer <= 0) {
      this.burst = AA.aaaBurst[0] + this.rng() * AA.aaaBurst[1];
      // Each burst is laid with its own aiming error: the first of an
      // engagement is wide, the following ones are walked on.
      const r = this.rng;
      this.bias = this.bias ?? new Vector3();
      this.bias.set(r() - 0.5, r() - 0.5, r() - 0.5).multiplyScalar(2 * aaaBurstError(this.bursts++, diff));
    }
    const firing = this.burst > 0 && engaged;
    this._setFiring(firing, ctx);
    if (!firing) return;
    this.acc += dt * w.rate;
    const p = ctx.player;
    _muzzle.copy(this.entity.position); _muzzle.y += 2;
    while (this.acc >= 1) {
      this.acc -= 1;
      leadPoint(_aim, _muzzle, this.entity.velocity, p.position, this.track, w.muzzle, 0.35);
      _v.subVectors(_aim, _muzzle).normalize();
      if (this.bias) _v.add(this.bias);
      const r = this.rng;
      _v.x += (r() - 0.5) * 2 * w.spread; _v.y += (r() - 0.5) * 2 * w.spread; _v.z += (r() - 0.5) * 2 * w.spread;
      _v.normalize().multiplyScalar(w.muzzle);
      ctx.world.fireBullet(this.entity, _muzzle, _v, w.damage, w.life);
    }
  }

  _flak(dt, ctx, engaged, dist) {
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const s = this.pending[i];
      s.t -= dt;
      if (s.t <= 0) {
        ctx.world.flak(s.position, AA.flakRadius, AA.flakDamage, this.entity);
        this.pending.splice(i, 1);
      }
    }
    this.timer -= dt;
    if (!engaged || this.timer > 0) return;
    const diff = ctx.difficulty ?? DIFFICULTY.normal;
    this.timer = (AA.flakPause[0] + this.rng() * AA.flakPause[1]) / diff.aggression;
    const p = ctx.player;
    const tof = dist / AA.flakSpeed;
    const err = (AA.flakError[0] + dist * AA.flakError[1]) / diff.accuracy;
    const r = this.rng;
    const position = new Vector3().copy(p.position).addScaledVector(this.track, tof);
    position.x += (r() - 0.5) * 2 * err; position.y += (r() - 0.5) * 2 * err; position.z += (r() - 0.5) * 2 * err;
    this.pending.push({ t: tof, position });
    ctx.events.emit('weapon:flak', { entity: this.entity, position });
  }

  _sam(dt, ctx, engaged, dist) {
    const d = this.def;
    const p = ctx.player;
    this.timer -= dt;
    let can = engaged && this.timer <= 0 && this.rounds > 0;
    const radarGuided = d.weapon === 'e_sam';
    if (can && radarGuided) {
      // Needs its radar, and cannot see under the radar floor.
      if (this.group?.radar && !this.group.radar.entity.alive) can = false;
      if (ctx.playerAgl < d.radarFloor) can = false;
    }
    if (!can) { this.lock = Math.max(0, this.lock - dt * 1.5); return; }
    const diff = ctx.difficulty ?? DIFFICULTY.normal;
    this.lock += dt;
    this.locking = true;
    if (this.lock < d.lockTime / diff.aggression) return;
    this.lock = 0;
    this.rounds--;
    this.timer = (d.reload * (0.85 + this.rng() * 0.3)) / diff.aggression;
    _muzzle.copy(this.entity.position); _muzzle.y += 4;
    _v.subVectors(p.position, _muzzle).normalize();
    _v.y = Math.max(_v.y, 0.35);
    const unit = this;
    // Command guidance: the missile only tracks while the site is alive, its
    // radar is alive and the site can still see the target. Put a ridge
    // between you and the launcher and the missile goes stupid.
    const guide = radarGuided ? (m) => {
      if (!unit.entity.alive || (unit.group?.radar && !unit.group.radar.entity.alive)) return false;
      m._gt = (m._gt ?? 0) + 1;
      if (m._gt % 15 === 0) m._los = clearLine(unit.entity.position, p.position);
      return m._los !== false;
    } : null;
    ctx.world.fireMissile({ weapon: d.weapon, owner: this.entity, target: p, position: _muzzle, direction: _v, guide });
    ctx.events.emit('ai:samLaunch', { entity: this.entity, radarGuided, dist });
  }
}

/** Trucks nose-to-tail along a road polyline. */
export class Convoy {
  constructor(path, trucks, { speed = 13, spacing = 55, loop = false } = {}) {
    this.path = path;
    this.length = pathLength(path);
    this.trucks = trucks;
    this.speed = speed;
    this.spacing = spacing;
    this.loop = loop;
    this.distance = spacing * trucks.length;
    this.arrived = false;
    this._o = {};
    this.place();
  }

  place() {
    this.trucks.forEach((u, i) => {
      const e = u.entity;
      if (!e.alive) return;
      const d = this.distance - i * this.spacing;
      const o = alongPath(this.path, d, this._o);
      e.position.set(o.x, o.y + 2, o.z);
      e.object3d.position.set(o.x, o.y, o.z);
      e.object3d.rotation.y = -o.heading;
      const moving = !this.arrived;
      e.velocity.set(Math.sin(o.heading) * this.speed * (moving ? 1 : 0), 0, -Math.cos(o.heading) * this.speed * (moving ? 1 : 0));
    });
  }

  update(dt) {
    if (this.arrived) return;
    this.distance += this.speed * dt;
    if (this.distance >= this.length) {
      if (this.loop) this.distance = this.spacing * this.trucks.length;
      else { this.distance = this.length; this.arrived = true; for (const u of this.trucks) u.entity.arrived = true; }
    }
    this.place();
  }
}
