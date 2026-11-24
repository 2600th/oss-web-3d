// Simulation of everything that flies and explodes: missiles, rockets, bombs,
// bullets, flares, damage. No rendering, no DOM — node-testable. The combat
// system wraps this with the player's weapons, the HUD and the visuals.
import { Vector3, Quaternion } from 'three';
import { G, pnAcceleration, steerVelocity, segmentPointDistSq, flareDecoys } from './guidance.js';
import { WEAPONS, damageAgainst } from './weapons.js';
import { DIFFICULTY } from '../game/difficulty.js';

const MAX_BULLETS = 768;
/** Seconds a rail-launched missile flies unguided while it clears the launcher. */
const RAIL_CLEAR = 0.15;
const _a = new Vector3();
const _d = new Vector3();
const _p = new Vector3();
const _n = new Vector3();
const _fwd = new Vector3(0, 0, -1);
const _t = { t: 0 };

/** A missile's flare susceptibility at a difficulty (radar missiles stay immune). */
export function flareChanceFor(weapon, team, d = DIFFICULTY.normal) {
  const base = weapon.flareChance ?? 0;
  if (!(base > 0) || team !== 'hostile') return base;
  return Math.min(0.95, Math.max(0.05, base + d.flare));
}

let nextId = 1;
export const newId = (prefix) => `${prefix}${nextId++}`;

export class CombatWorld {
  /**
   * @param {object} o
   * @param {{emit:Function}} o.events
   * @param {(x:number,z:number)=>number} o.terrainHeight
   * @param {()=>number} [o.rng]
   */
  constructor({ events, terrainHeight, rng = Math.random }) {
    this.events = events;
    this.terrainHeight = terrainHeight;
    this.rng = rng;
    /** Every damageable entity, the player included. */
    this.targets = [];
    this.missiles = [];
    this.flares = [];
    this.player = null;
    this.stats = { gunFired: 0, gunHits: 0, mslFired: 0, mslHits: 0, kills: 0, airKills: 0, groundKills: 0, damageTaken: 0 };
    this.god = false;
    /** Scales damage to the player and hostile missiles (game/difficulty.js). */
    this.difficulty = DIFFICULTY.normal;
    /** Weather for the sortie (missions/conditions.js), or null. */
    this.conditions = null;
    /** 0..1, how deep in cloud the player is (from the environment, when it knows). */
    this.playerInCloud = 0;

    this.bullets = {
      n: 0,
      px: new Float32Array(MAX_BULLETS), py: new Float32Array(MAX_BULLETS), pz: new Float32Array(MAX_BULLETS),
      vx: new Float32Array(MAX_BULLETS), vy: new Float32Array(MAX_BULLETS), vz: new Float32Array(MAX_BULLETS),
      life: new Float32Array(MAX_BULLETS), damage: new Float32Array(MAX_BULLETS),
      hostile: new Uint8Array(MAX_BULLETS), owner: new Array(MAX_BULLETS),
    };
    this._tick = 0;
  }

  reset() {
    for (const m of this.missiles) m.alive = false;
    for (const f of this.flares) f.alive = false;
    this.missiles.length = 0;
    this.flares.length = 0;
    this.targets.length = 0;
    this.bullets.n = 0;
    for (const k of Object.keys(this.stats)) this.stats[k] = 0;
    if (this.player) this.targets.push(this.player);
  }

  addTarget(e) {
    e.id ??= newId('t');
    e.alive = e.alive !== false;
    e.maxHealth ??= e.health ?? 100;
    e.health ??= e.maxHealth;
    e.radius ??= 10;
    e.class ??= 'ground';
    e.armor ??= e.class === 'air' ? 'air' : 'medium';
    e.team ??= 'hostile';
    e.velocity ??= new Vector3();
    e.incoming = 0;
    if (!this.targets.includes(e)) this.targets.push(e);
    return e;
  }

  removeTarget(e) {
    const i = this.targets.indexOf(e);
    if (i >= 0) this.targets.splice(i, 1);
  }

  /** Is this aircraft hidden from infra-red by cloud right now? */
  cloaked(e) {
    const c = this.conditions?.cloud;
    if (c && e.position.y > c.base && e.position.y < c.top) return true;
    return e === this.player && this.playerInCloud > 0.6;
  }

  // ------------------------------------------------------------- launch --

  /**
   * Launch a missile / rocket / bomb.
   * @param {object} o {weapon (id or def), owner, target?, position, direction, velocity? (inherited), guide? ()=>bool}
   */
  fireMissile({ weapon, owner, target = null, position, direction, velocity = null, guide = null }) {
    const w = typeof weapon === 'string' ? WEAPONS[weapon] : weapon;
    const dir = _d.copy(direction).normalize();
    const inherited = velocity ? velocity.length() : 0;
    const vel = new Vector3();
    if (w.type === 'bomb') vel.copy(velocity ?? dir);
    // A rail-launched missile leaves with the launcher's whole velocity: the
    // jet flies its path at some angle of attack to the nose, and taking only
    // the speed (pointed down the nose) made every missile climb away from
    // the rail at ~15 m/s. Rockets stay on the pod axis (the CCIP solution in
    // guidance.rocketImpact assumes it); slow launchers get the old kick.
    else if (w.type === 'missile' && velocity && inherited >= 80) vel.copy(velocity).addScaledVector(dir, w.launchBoost ?? 0);
    else vel.copy(dir).multiplyScalar(Math.max(inherited, 80) + (w.launchBoost ?? 0));
    const kind = w.type === 'bomb' ? 'bomb' : w.type === 'rocket' ? 'rocket'
      : w.kind ?? (target && target.class !== 'air' ? 'agm' : 'aam');
    const m = {
      id: newId('m'), kind, weapon: w, owner, team: owner?.team ?? 'hostile', target,
      position: position.clone(), velocity: vel, quaternion: new Quaternion(),
      alive: true, age: 0, lost: 0, motor: w.type !== 'bomb', guide,
      speed: vel.length(), lastRange: Infinity, isMissile: true,
      // fired off an airframe: a moment of unguided separation along the rail
      rail: w.type === 'missile' && velocity && inherited >= 80 ? dir.clone() : null,
    };
    // Hostile missiles turn harder / softer with the difficulty.
    if (w.maxG && m.team === 'hostile') m.maxG = w.maxG * this.difficulty.missile;
    m.quaternion.setFromUnitVectors(_fwd, dir);
    this.missiles.push(m);
    if (owner === this.player && w.type === 'missile') this.stats.mslFired++;
    this.events.emit('missile:launch', { missile: m });
    return m;
  }

  /** One bullet. `hostile` bullets only ever test against the player. */
  fireBullet(owner, position, velocity, damage, life) {
    const b = this.bullets;
    if (b.n >= MAX_BULLETS) return;
    const i = b.n++;
    b.px[i] = position.x; b.py[i] = position.y; b.pz[i] = position.z;
    b.vx[i] = velocity.x; b.vy[i] = velocity.y; b.vz[i] = velocity.z;
    b.life[i] = life; b.damage[i] = damage;
    b.hostile[i] = owner?.team === 'hostile' ? 1 : 0;
    b.owner[i] = owner;
    if (owner === this.player) this.stats.gunFired++;
  }

  /** Drop a flare from `owner`; every IR missile tracking it gets one roll. */
  releaseFlare(owner, position, velocity) {
    const flare = {
      id: newId('f'), kind: 'flare', owner, team: owner.team, position: position.clone(),
      velocity: velocity.clone(), alive: true, age: 0, life: 4.2, class: 'air', radius: 2, isFlare: true,
    };
    this.flares.push(flare);
    this.events.emit('flare:release', { flare });
    const fwd = _n.copy(owner.velocity);
    if (fwd.lengthSq() < 1) fwd.set(0, 0, -1); else fwd.normalize();
    for (const m of this.missiles) {
      if (!m.alive || m.target !== owner) continue;
      _d.copy(m.velocity).normalize();
      if (flareDecoys({
        missilePos: m.position, missileDir: _d, seekerCos: Math.cos(m.weapon.seekerCone ?? 0.8),
        targetPos: owner.position, targetForward: fwd, flarePos: flare.position,
        flareChance: flareChanceFor(m.weapon, m.team, this.difficulty), roll: this.rng(),
      })) {
        m.target = flare;
        m.decoyed = true;
      }
    }
    return flare;
  }

  /** Timed AA shell burst. */
  flak(position, radius, damage, owner) {
    this.events.emit('explosion', { position: position.clone(), size: 'small', kind: 'flak' });
    const p = this.player;
    if (p?.alive && owner?.team !== p.team) {
      const d = p.position.distanceTo(position);
      if (d < radius) this.damage(p, damage * (1 - d / radius), { weapon: { type: 'flak', id: 'flak' }, source: owner, position });
    }
  }

  // ------------------------------------------------------------- damage --

  /** Apply damage. Returns true when it killed the target. */
  damage(target, amount, { weapon = null, source = null, position = null } = {}) {
    if (!target.alive || amount <= 0 || target.invulnerable) return false;
    if (target === this.player) {
      if (this.god) return false;
      amount *= this.difficulty.damage;
      target.health = Math.max(0, target.health - amount);
      this.stats.damageTaken += amount;
      // `damage` is in hit points (player health is 100). Feedback reads
      // `fraction` (of full health) and `severity` (0..1, square-root curve:
      // a stray round ~0.37, a SAM hit ~1) so a graze and a missile do not
      // feel the same.
      const fraction = amount / (target.maxHealth || 100);
      this.events.emit('player:hit', {
        damage: amount, health: target.health / target.maxHealth, source, position: (position ?? target.position).clone(),
        weapon: weapon?.id ?? null, fraction, severity: Math.min(1, Math.sqrt(fraction / 0.25)),
      });
      if (target.health <= 0) {
        target.alive = false;
        this.events.emit('explosion', { position: target.position.clone(), size: 'medium', kind: 'air', velocity: target.velocity.clone() });
        this.events.emit('player:destroyed', {
          position: target.position.clone(), velocity: target.velocity.clone(), cause: weapon?.kind ?? weapon?.type ?? 'unknown',
        });
        return true;
      }
      return false;
    }
    target.health -= amount;
    target.lastHitBy = source;
    target.lastHitWeapon = weapon?.id ?? null;
    target.onDamage?.(amount, source);
    if (target.health > 0) {
      this.events.emit('target:hit', { target, damage: amount, source, weapon: weapon?.id ?? null });
      return false;
    }
    this.kill(target, source);
    return true;
  }

  kill(target, killer = null) {
    if (!target.alive) return;
    target.health = 0;
    target.alive = false;
    const byPlayer = killer === this.player;
    if (byPlayer) {
      this.stats.kills++;
      if (target.class === 'air') this.stats.airKills++; else this.stats.groundKills++;
    }
    this.events.emit('explosion', {
      position: target.position.clone(), size: target.explosion ?? (target.class === 'air' ? 'medium' : 'large'),
      kind: target.class === 'air' ? 'air' : 'ground', velocity: target.velocity.clone(),
    });
    this.events.emit('target:destroyed', {
      target, killer, position: target.position.clone(), score: byPlayer ? (target.score ?? 0) : 0,
    });
    target.onDestroyed?.(killer);
    // Secondary: a dump or a fuel truck takes its neighbours with it.
    if (target.secondary) this._splash(target.position, target.secondary.radius, target.secondary.damage, WEAPONS.bomb, killer, target, target.team === 'hostile' ? 'friendly' : 'hostile');
  }

  _splash(position, radius, base, weapon, source, exclude, sourceTeam) {
    for (const t of [...this.targets]) {
      if (!t.alive || t === exclude || t.team === sourceTeam) continue;
      const d = t.position.distanceTo(position) - t.radius * 0.5;
      if (d >= radius) continue;
      const fall = 1 - Math.max(0, d) / radius;
      this.damage(t, damageAgainst(weapon, t.armor, base) * fall, { weapon, source, position });
    }
  }

  _detonate(m, reason, direct = null) {
    m.alive = false;
    m.motor = false;
    const w = m.weapon;
    if (reason === 'hit' || reason === 'ground') {
      const size = w.type === 'bomb' ? 'large' : w.type === 'rocket' ? 'small' : (w.blast > 28 ? 'medium' : 'small');
      this.events.emit('explosion', {
        position: m.position.clone(), size, kind: reason === 'ground' ? 'ground' : 'missile', velocity: m.velocity.clone(),
      });
      const killsBefore = this.stats.kills;
      const healthBefore = direct ? direct.health : 0;
      if (direct?.alive && !direct.isFlare) this.damage(direct, damageAgainst(w, direct.armor), { weapon: w, source: m.owner, position: m.position });
      if (w.blast) this._splash(m.position, w.blast, w.damage, w, m.owner, direct, m.team);
      if (m.owner === this.player && w.type === 'missile' && (this.stats.kills > killsBefore || (direct && direct.health < healthBefore))) this.stats.mslHits++;
    }
    this.events.emit('missile:end', { missile: m, reason });
  }

  // --------------------------------------------------------------- step --

  step(dt) {
    this._tick++;
    this._stepMissiles(dt);
    this._stepBullets(dt);
    for (let i = this.flares.length - 1; i >= 0; i--) {
      const f = this.flares[i];
      f.age += dt;
      f.velocity.multiplyScalar(1 - 1.1 * dt);
      f.velocity.y -= G * 0.6 * dt;
      f.position.addScaledVector(f.velocity, dt);
      if (f.age > f.life || f.position.y < this.terrainHeight(f.position.x, f.position.z)) {
        f.alive = false;
        this.flares.splice(i, 1);
      }
    }
    for (let i = this.targets.length - 1; i >= 0; i--) {
      const t = this.targets[i];
      if (!t.alive && t !== this.player) this.targets.splice(i, 1);
    }
  }

  _stepMissiles(dt) {
    for (let i = this.missiles.length - 1; i >= 0; i--) {
      const m = this.missiles[i];
      if (m.alive) this._stepMissile(m, dt);
      if (!m.alive) this.missiles.splice(i, 1);
    }
    // Who is being tracked right now (AI reads `incoming` to decide to evade).
    for (const t of this.targets) t.incoming = 0;
    for (const m of this.missiles) if (m.target && !m.target.isFlare) m.target.incoming = (m.target.incoming ?? 0) + 1;
  }

  _stepMissile(m, dt) {
    const w = m.weapon;
    m.age += dt;
    _p.copy(m.position);

    if (w.type === 'bomb') {
      m.velocity.y -= G * dt;
      m.velocity.multiplyScalar(1 - (w.drag ?? 0) * dt);
    } else {
      let pulled = 0;
      if (w.type === 'missile') {
        let tgt = m.target;
        if (tgt) {
          let ok = tgt.alive;
          if (ok) {
            _d.subVectors(tgt.position, m.position);
            const range = _d.length();
            const cos = _d.dot(m.velocity) / Math.max(range * m.speed, 1e-6);
            // The seeker needs the target in its gimbal cone (after a short
            // launch grace so a high-off-boresight shot can come round).
            if (m.age > 0.35 && cos < Math.cos(w.seekerCone)) ok = false;
            if (ok && m.guide && !m.guide(m)) ok = false;
            // An infra-red seeker cannot hold a target inside solid cloud.
            if (ok && w.guidance === 'ir' && tgt.class === 'air' && !tgt.isFlare && this.cloaked(tgt) && this.rng() < (this.conditions?.irLoss ?? 0.3) * dt) ok = false;
          }
          if (!ok) {
            m.target = tgt = null;
          }
        }
        if (m.rail && m.age < RAIL_CLEAR) {
          // Clearing the launcher: the seeker is not steering yet and the
          // missile has none of the jet's lift, so it sags a little under it.
          m.velocity.y -= G * dt;
        } else if (tgt) {
          // Aim a little above a ground target so the last metres are not spent in the slope.
          if (tgt.class !== 'air' && !tgt.isFlare) { _n.copy(tgt.position); _n.y += 5; pnAcceleration(_a, m.position, m.velocity, _n, tgt.velocity, w.nav); }
          else pnAcceleration(_a, m.position, m.velocity, tgt.position, tgt.velocity, w.nav);
          _a.y += G; // hold altitude against gravity
          pulled = steerVelocity(m.velocity, _a, (m.maxG ?? w.maxG) * Math.min(1, 0.25 + m.age * 2.5), dt);
        } else {
          m.lost += dt;
          if (m.lost > 1.4) return this._detonate(m, 'miss');
        }
      } else {
        m.velocity.y -= G * (w.gravity ?? 0.5) * dt;
      }
      m.motor = m.age < w.burn;
      let speed = m.velocity.length();
      if (m.motor) speed = Math.min(w.maxSpeed, speed + w.accel * dt);
      else speed -= speed * w.coastDrag * dt;
      speed -= pulled * 2.2 * dt;
      m.speed = speed;
      m.velocity.setLength(Math.max(speed, 1));
      if (w.type === 'missile' && !m.motor && speed < 230) return this._detonate(m, 'fuel');
    }

    m.position.addScaledVector(m.velocity, dt);
    _d.copy(m.velocity).normalize();
    // Off the rail the body still points down the rail, then weathervanes
    // onto its flight path (the jet's angle of attack, in the first frames).
    if (m.rail && m.age < RAIL_CLEAR * 2) _d.lerp(m.rail, 1 - m.age / (RAIL_CLEAR * 2)).normalize();
    m.quaternion.setFromUnitVectors(_fwd, _d);
    if (m.age > w.life) return this._detonate(m, 'fuel');

    // Proximity fuse.
    if (m.target && m.target.alive) {
      const t = m.target;
      const r = (t.radius ?? 5) + w.fuse;
      const d2 = segmentPointDistSq(_p, m.position, t.position);
      if (d2 < r * r) {
        if (t.isFlare) return this._detonate(m, 'miss');
        return this._detonate(m, 'hit', t);
      }
      const range = Math.sqrt(d2);
      // Flew past inside the blast radius: fuse anyway (splash only).
      if (range > m.lastRange + 0.5 && m.lastRange < w.blast && !t.isFlare) return this._detonate(m, 'hit', null);
      m.lastRange = range;
    } else if (m.age > 0.25 && w.type !== 'missile') {
      for (const t of this.targets) {
        if (!t.alive || t.team === m.team) continue;
        const r = t.radius + w.fuse;
        if (segmentPointDistSq(_p, m.position, t.position) < r * r) return this._detonate(m, 'hit', t);
      }
    }

    if (m.position.y <= this.terrainHeight(m.position.x, m.position.z)) {
      m.position.y = this.terrainHeight(m.position.x, m.position.z);
      // Struck the ground at the foot of its (ground) target: that is a hit.
      const t = m.target;
      if (t && t.alive && !t.isFlare && t.class !== 'air' && m.position.distanceTo(t.position) < t.radius + w.fuse + 9) return this._detonate(m, 'hit', t);
      return this._detonate(m, 'ground');
    }
  }

  _stepBullets(dt) {
    const b = this.bullets;
    const player = this.player;
    for (let i = b.n - 1; i >= 0; i--) {
      const x0 = b.px[i], y0 = b.py[i], z0 = b.pz[i];
      b.vy[i] -= G * 0.35 * dt;
      const x1 = x0 + b.vx[i] * dt, y1 = y0 + b.vy[i] * dt, z1 = z0 + b.vz[i] * dt;
      b.px[i] = x1; b.py[i] = y1; b.pz[i] = z1;
      b.life[i] -= dt;
      let dead = b.life[i] <= 0;
      _p.set(x0, y0, z0);
      _d.set(x1, y1, z1);
      if (!dead) {
        if (b.hostile[i]) {
          if (player?.alive) {
            const r = player.radius;
            if (segmentPointDistSq(_p, _d, player.position) < r * r) {
              this.damage(player, b.damage[i], { weapon: WEAPONS.e_gun, source: b.owner[i], position: _d });
              dead = true;
            }
          }
        } else {
          for (const t of this.targets) {
            if (!t.alive || t.team !== 'hostile') continue;
            // Generous hit sphere: an arcade gun should reward a good pass.
            const r = Math.max(t.radius * 1.35, 11);
            if (Math.abs(t.position.x - x1) > 400 || Math.abs(t.position.z - z1) > 400) continue;
            if (segmentPointDistSq(_p, _d, t.position, _t) < r * r) {
              _n.set(x0 - x1, y0 - y1, z0 - z1).normalize();
              const hitPos = new Vector3(x0 + (x1 - x0) * _t.t, y0 + (y1 - y0) * _t.t, z0 + (z1 - z0) * _t.t);
              this.events.emit('weapon:gunHit', { position: hitPos, normal: _n.clone(), targetKind: t.kind });
              if (b.owner[i] === player) this.stats.gunHits++;
              this.damage(t, damageAgainst(WEAPONS.gun, t.armor, b.damage[i]), { weapon: WEAPONS.gun, source: b.owner[i], position: hitPos });
              dead = true;
              break;
            }
          }
        }
      }
      // Ground: staggered, a quarter of the bullets each step.
      if (!dead && ((i + this._tick) & 3) === 0) {
        const h = this.terrainHeight(x1, z1);
        if (y1 <= h) {
          dead = true;
          if (!b.hostile[i]) this.events.emit('weapon:gunHit', { position: new Vector3(x1, h, z1), normal: new Vector3(0, 1, 0), targetKind: 'ground' });
        }
      }
      if (dead) {
        const last = --b.n;
        if (i !== last) {
          b.px[i] = b.px[last]; b.py[i] = b.py[last]; b.pz[i] = b.pz[last];
          b.vx[i] = b.vx[last]; b.vy[i] = b.vy[last]; b.vz[i] = b.vz[last];
          b.life[i] = b.life[last]; b.damage[i] = b.damage[last];
          b.hostile[i] = b.hostile[last]; b.owner[i] = b.owner[last];
        }
      }
    }
  }
}
