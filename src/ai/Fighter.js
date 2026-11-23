// One hostile fighter: AiFlight (how it moves) + brain (what it wants) +
// weapons, registered with combat as a target. No rendering dependencies; the
// AI system attaches the model to `entity.object3d`.
import { Vector3, Group } from 'three';
import { terrainHeight, maxHeightAlong } from '../world/terrain/heightfield.js';
import { clearLine } from '../combat/los.js';
import { leadPoint } from '../combat/guidance.js';
import { WEAPONS } from '../combat/weapons.js';
import { AiFlight, AIRFRAMES } from './aiFlight.js';
import { SKILLS, newMemory, decide, steer, employ } from './brain.js';
import { DIFFICULTY, scaleSkill } from '../game/difficulty.js';

const _to = new Vector3();
const _des = new Vector3();
const _lead = new Vector3();
const _v = new Vector3();
const _v2 = new Vector3();
const _tf = new Vector3();
const _right = new Vector3();

/**
 * Rough air and the gun: seconds a pilot needs to settle the pipper between
 * bursts, `(turbulence - from) * perUnit` (0 below moderate air, 1 s in a storm).
 */
export const ROUGH_AIR = { from: 0.5, perUnit: 2 };
export const gunSettle = (turbulence) => Math.max(0, turbulence - ROUGH_AIR.from) * ROUGH_AIR.perUnit;

/** States a `dark` pilot (skill override) flies without afterburner. */
const DARK_MODES = new Set(['patrol', 'formation', 'intercept', 'bracket', 'pure', 'lead', 'lag']);

const DEFAULT_HEALTH = { bandit: 60, veteran: 100, ace: 190 };
const DEFAULT_SCORE = { bandit: 400, veteran: 650, ace: 2000 };

export class Fighter {
  /**
   * @param {object} def { skill, name, isAce, health, score, role, leader (Fighter),
   *                       slot {x,y,z}, route [{x,y,z}], tags, isTarget, ace (data) }
   */
  constructor(def, rng = Math.random) {
    const type = def.skill ?? 'bandit';
    /** The pilot as written; `skill` is this at the current difficulty. */
    this.baseSkill = { ...SKILLS[type], ...(def.skillOverrides ?? {}) };
    this.skill = scaleSkill(this.baseSkill, def.difficulty ?? DIFFICULTY.normal);
    this.flight = new AiFlight({ ...AIRFRAMES[def.airframe ?? type], ...(def.airframeOverrides ?? {}) });
    this.mem = newMemory();
    this.mem.missiles = this.skill.missiles;
    this.mem.flares = this.skill.flares;
    this.mem.think = rng() * this.skill.reaction;
    this.rng = rng;
    this.role = def.role ?? 'lead';
    this.leader = def.leader ?? null;
    this.slot = def.slot ?? { x: 0, y: 0, z: 0 };
    this.route = def.route ?? null;
    this.routeIndex = 0;
    /** Named pilot data (missions/cast.js ACES entry) for radio lines, or null. */
    this.pilot = def.ace ?? null;
    /** Set only for the flight lead: the one the HUD marks and calls "LEAD". */
    this.ace = def.ace?.lead ? def.ace : null;
    this.time = rng() * 10;
    this.gunFiring = false;
    this._gunAcc = 0;
    this._terrainTimer = 0;
    this._terrainDanger = false;
    this._throttle = 0.8;
    this._g = 1;
    this._sit = null;
    this._missile = null;
    this.locking = false;

    const f = this.flight;
    this.entity = {
      kind: def.isAce ? 'ace' : 'fighter', class: 'air', armor: 'air', team: 'hostile',
      name: def.name ?? 'BANDIT', isAce: def.isAce === true, elite: !!def.ace, isTarget: def.isTarget === true,
      position: f.position, velocity: f.velocity, quaternion: f.quaternion,
      alive: true, health: def.health ?? DEFAULT_HEALTH[type], radius: 10,
      score: def.score ?? DEFAULT_SCORE[type], tags: def.tags ?? [], explosion: 'medium',
      object3d: new Group(), engine: { throttle: 0.8, reheat: 0 }, fighter: this,
      onDamage: () => {
        this.mem.aware = true;
        f.condition = Math.max(0.2, this.entity.health / this.entity.maxHealth);
      },
    };
  }

  setDifficulty(d) { this.skill = scaleSkill(this.baseSkill, d); }

  /** Nearest missile tracking this aircraft, or null. */
  _nearestMissile(world) {
    if (!this.entity.incoming) return null;
    let best = null, bd = Infinity;
    for (const m of world.missiles) {
      if (!m.alive || m.target !== this.entity) continue;
      const d = m.position.distanceToSquared(this.flight.position);
      if (d < bd) { bd = d; best = m; }
    }
    return best;
  }

  _situation(ctx) {
    const f = this.flight;
    const t = ctx.player;
    const s = this._sit ?? (this._sit = {});
    _to.subVectors(t.position, f.position);
    const range = _to.length() || 1;
    s.range = range;
    s.targetAlive = t.alive && ctx.hostile !== false;
    s.angleOff = Math.acos(Math.min(1, Math.max(-1, _to.dot(f.forward) / range)));
    _tf.copy(t.velocity);
    if (_tf.lengthSq() < 1) _tf.set(0, 0, -1); else _tf.normalize();
    s.aspect = Math.acos(Math.min(1, Math.max(-1, -_to.dot(_tf) / range)));
    _v.subVectors(t.velocity, f.velocity);
    s.closure = -_to.dot(_v) / range;
    _right.crossVectors(f.forward, f.up);
    s.targetSide = _to.dot(_right);
    s.speed = f.speed;
    s.agl = f.position.y - terrainHeight(f.position.x, f.position.z);
    s.terrainDanger = this._terrainDanger;
    const m = this._missile = this._nearestMissile(ctx.world);
    s.missile = m ? { range: m.position.distanceTo(f.position) } : null;
    s.lockedBy = this.entity.lockedByPlayer ?? 'none';
    s.alerted = ctx.alerted === true;
    s.visibility = ctx.conditions?.visibility ?? 1;
    // The player is inside a solid cloud layer: an infra-red lock on him takes
    // 2.5x as long (as the player's own lock on a clouded target does) and a
    // gunner cannot see far enough into it to lay a burst. Only the target's
    // cloud counts: hostile pilots hold in the layer by design, and letting
    // their own cover blind them too left them unable to shoot at all (in a
    // trial, not one missile in four sorties).
    s.inCloud = ctx.world?.cloaked?.(t) === true;
    s.role = this.role;
    s.leaderAlive = !!this.leader?.entity.alive;
    s.leaderEngaged = !!this.leader && !['patrol', 'formation', 'intercept'].includes(this.leader.mem.mode);
    s.hasRoute = !!this.route;
    s.los = range < 6000 ? clearLine(f.position, t.position, 110) : false;
    s.token = ctx.tokens.has(this);
    leadPoint(_lead, f.position, f.velocity, t.position, t.velocity, WEAPONS.e_gun.muzzle);
    _v.subVectors(_lead, f.position);
    s.leadAngle = Math.acos(Math.min(1, Math.max(-1, _v.normalize().dot(f.forward))));
    return s;
  }

  _checkTerrain() {
    const f = this.flight;
    const p = f.position, v = f.velocity;
    const look = 4.5;
    const ex = p.x + v.x * look, ez = p.z + v.z * look;
    const ridge = maxHeightAlong(p.x, p.z, ex, ez, 6);
    const margin = this._terrainDanger ? 420 : 170;
    const predicted = Math.min(p.y, p.y + v.y * look);
    this._terrainDanger = predicted < ridge + margin;
  }

  update(dt, ctx) {
    const e = this.entity;
    if (!e.alive) return;
    const f = this.flight;
    const k = this.skill;
    const m = this.mem;
    this.time += dt;

    this._terrainTimer -= dt;
    if (this._terrainTimer <= 0) { this._terrainTimer = 0.2; this._checkTerrain(); }

    m.think -= dt;
    if (m.think <= 0) {
      const step = k.reaction;
      m.think += step;
      const s = this._situation(ctx);
      const before = m.mode;
      decide(s, m, k, step, this.rng);
      if (m.mode !== before && (m.mode === 'pure' || m.mode === 'lead' || m.mode === 'bracket') && !this._engaged) {
        this._engaged = true;
        ctx.events.emit('ai:engage', { entity: e, fighter: this });
      }
      const act = employ(s, m, k, step, this.rng);
      this.locking = act.locking;
      if (act.flare) {
        _v.copy(f.position).addScaledVector(f.forward, -9);
        _v2.copy(f.velocity).multiplyScalar(0.5).addScaledVector(f.up, -25);
        ctx.world.releaseFlare(e, _v, _v2);
      }
      if (act.missile && ctx.player.alive) {
        _v.copy(f.position).addScaledVector(f.forward, 8).addScaledVector(f.up, -1.2);
        ctx.world.fireMissile({ weapon: k.weapon, owner: e, target: ctx.player, position: _v, direction: f.forward, velocity: f.velocity });
        ctx.events.emit('ai:fire', { entity: e, fighter: this });
      }
      // In violent air (a storm) the pipper will not sit still: after each
      // burst the pilot has to settle it again before the next one.
      if (act.gun) {
        const settle = gunSettle(ctx.conditions?.turbulence ?? 0);
        if (settle <= 0) m.gunBurst = 0.55; // smooth air: hold the trigger down
        else if ((m.gunRest ?? 0) <= 0) { m.gunBurst = 0.55; m.gunRest = 0.55 + settle; }
      }
    }

    // Steering (every frame, from the current state).
    const wp = this.route ? this.route[this.routeIndex] : null;
    if (wp && Math.hypot(wp.x - f.position.x, wp.z - f.position.z) < 700) this.routeIndex = (this.routeIndex + 1) % this.route.length;
    const s = this._sit;
    const range = s?.range ?? 1e9;
    const st = steer(_des, m.mode, {
      position: f.position, velocity: f.velocity, forward: f.forward,
      targetPos: ctx.player.position, targetVel: ctx.player.velocity,
      missilePos: this._missile?.alive ? this._missile.position : null,
      leaderPos: this.leader?.flight.position, leaderForward: this.leader?.flight.forward, slot: this.slot,
      waypoint: wp, side: m.side,
      verticalBias: k.vertical > 0 && range > 900 && range < 2600 && f.speed > 250 ? k.vertical * 0.3 : 0,
    }, k);
    // Aces jink when someone is saddled up behind them.
    if (k.jink > 0 && s && s.angleOff > 2 && s.aspect < 0.5 && range < 1300) {
      _right.crossVectors(f.forward, f.up);
      _des.normalize().addScaledVector(_right, Math.sin(this.time * 3.1) * k.jink * 0.7).addScaledVector(f.up, Math.cos(this.time * 2.3) * k.jink * 0.35);
    }
    // Weather: a pilot who is defensive goes for the cloud layer, where an
    // infra-red seeker cannot hold him.
    const layer = ctx.conditions?.cloud;
    if (layer && (m.mode === 'evade' || m.mode === 'extend' || m.mode === 'break')) {
      _des.normalize();
      _des.y = Math.max(-0.5, Math.min(0.5, ((layer.base + layer.top) * 0.5 - f.position.y) / 1200));
    }
    // Never descend into the floor outside of a committed attack.
    const agl = f.position.y - terrainHeight(f.position.x, f.position.z);
    if (agl < 380 && _des.y < 0) { _des.normalize(); _des.y = Math.max(_des.y, 0.15); }
    // A night fighter running dark keeps out of burner until he has to fight
    // for his life (missions/spotting.js: a burner shows from far off).
    if (k.dark && DARK_MODES.has(m.mode)) st.throttle = Math.min(st.throttle, 1);
    f.step(dt, _des, st.throttle, st.g);
    e.engine.throttle = Math.min(1, st.throttle);
    e.engine.reheat = st.throttle > 1 ? 1 : 0;

    // Gun.
    m.gunBurst = Math.max(0, m.gunBurst - dt);
    m.gunRest = Math.max(0, (m.gunRest ?? 0) - dt);
    const firing = m.gunBurst > 0 && ctx.player.alive;
    if (firing !== this.gunFiring) {
      this.gunFiring = firing;
      ctx.events.emit('weapon:gun', { firing, entity: e });
    }
    if (firing) {
      const w = WEAPONS.e_gun;
      this._gunAcc += dt * w.rate;
      while (this._gunAcc >= 1) {
        this._gunAcc -= 1;
        leadPoint(_lead, f.position, f.velocity, ctx.player.position, ctx.player.velocity, w.muzzle);
        _v.subVectors(_lead, f.position).normalize();
        const r = this.rng;
        // Rough air spoils a gun solution for them exactly as it does for the
        // player (storm: twice the scatter).
        const err = k.gunError * (1 + (ctx.conditions?.turbulence ?? 0));
        _v.x += (r() - 0.5) * 2 * err; _v.y += (r() - 0.5) * 2 * err; _v.z += (r() - 0.5) * 2 * err;
        _v.normalize().multiplyScalar(w.muzzle).add(f.velocity);
        _v2.copy(f.position).addScaledVector(f.forward, 8);
        ctx.world.fireBullet(e, _v2, _v, w.damage, w.life);
      }
    }

    // Flew into the mountain: a manoeuvre kill if the player was working on it.
    if (agl < 6) ctx.world.kill(e, e.lastHitBy ?? (s && s.range < 2500 ? ctx.player : null));

    e.object3d.position.copy(f.position);
    e.object3d.quaternion.copy(f.quaternion);
  }
}
