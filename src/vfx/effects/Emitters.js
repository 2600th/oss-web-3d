import * as THREE from 'three/webgpu';
import { terrainHeight } from '../../world/terrain/heightfield.js';
import { clamp, saturate } from '../core/ring.js';
import { rnd, randDir, readPose, makePose, isAlive } from './util.js';
import { makePath, emitAlong, sizeForRate } from '../core/fxmath.js';

const _d = new THREE.Vector3();
const _f = new THREE.Vector3();
const _t = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();

/** Integer number of emissions this frame for a continuous `rate` (per second). */
function emitCount(item, key, rate, dt) {
  const acc = (item[key] ?? Math.random()) + rate * dt;
  const n = Math.floor(acc);
  item[key] = acc - n;
  return n;
}

/**
 * Everything that emits over time while following something: missile motors,
 * flares, fires and their smoke columns, damaged aircraft, falling wrecks,
 * and plain attached trails.
 */
export class Emitters {
  constructor(vfx) {
    this.vfx = vfx;
    this.missiles = new Map();
    this.flares = new Map();
    this.damaged = new Map();
    this.trails = new Set();
    this.fires = [];
    this.wrecks = [];
    this.pending = [];       // target:destroyed waiting one frame for combat's own `explosion`
    this.recentBlasts = [];
    this.pose = makePose();
  }

  count() {
    return { missiles: this.missiles.size, flares: this.flares.size, fires: this.fires.length, wrecks: this.wrecks.length, damaged: this.damaged.size, trails: this.trails.size };
  }

  _style(name, scale = 1) {
    const s = typeof name === 'string' ? (this.vfx.TRAILS[name] ?? this.vfx.TRAILS.aam) : name;
    return { ...s, radius: s.radius * scale, growth: s.growth * scale, spacing: s.spacing * this.vfx.cfg.spacing };
  }

  // ---------------- generic attached trail ----------------
  attachTrail(entity, style = 'aam') {
    const item = { entity, trail: this.vfx.ribbons.create(this._style(style)), pose: makePose(), ended: false };
    item.end = () => { item.ended = true; item.trail.end(); this.trails.delete(item); };
    this.trails.add(item);
    return item;
  }

  // ---------------- missiles ----------------
  missile(entity) {
    if (this.missiles.has(entity)) return this.missiles.get(entity);
    const kind = entity.kind ?? 'aam';
    if (kind === 'bomb') return null;
    const big = kind === 'sam' ? 2.1 : kind === 'rocket' ? 0.6 : 1;
    const item = { entity, kind, big, trail: this.vfx.ribbons.create(this._style(kind)), age: 0, pose: makePose() };
    this.missiles.set(entity, item);
    // ignition puff
    if (readPose(entity, item.pose, 0)) {
      const p = item.pose.position, v = item.pose.velocity, { lit, glow, L, G } = this.vfx;
      for (let i = 0; i < 5; i++) {
        randDir(_d);
        lit.spawn(L.shed, p.x, p.y, p.z, v.x * 0.6 + _d.x * 6, v.y * 0.6 + _d.y * 6, v.z * 0.6 + _d.z * 6, rnd(1.2, 2.4), 0.8 * big, rnd(4, 6.5) * big, 0.9, 0.9, 0.9, 0.5, 0.4);
      }
      glow.spawn(G.flash, p.x, p.y, p.z, v.x, v.y, v.z, 0.1, 3 * big, 6 * big, 1, 0.8, 0.5, 1, 5);
      this.vfx.lights.flash(p, 1, 0.7, 0.4, 2500 * big, 140, 0.25);
    }
    return item;
  }

  endMissile(entity) {
    const item = this.missiles.get(entity);
    if (!item) return;
    item.trail.end();
    this.missiles.delete(entity);
  }

  _updateMissiles(dt) {
    const v = this.vfx, { lit, glow, L, G } = v;
    const cam = v.shared.u.camPos.value;
    for (const [entity, item] of this.missiles) {
      if (!isAlive(entity) || !readPose(entity, item.pose, dt)) { this.endMissile(entity); continue; }
      item.age += dt;
      const motor = entity.motor ?? entity.thrusting ?? entity.burning ?? entity.boosting ?? true;
      if (!motor) { if (item.trail.active) item.trail.end(); continue; }
      const { position: p, velocity: vel } = item.pose;
      if (vel.lengthSq() > 1) _f.copy(vel).normalize(); else _f.set(0, 0, -1).applyQuaternion(item.pose.quaternion);
      const big = item.big, back = (entity.length ?? 3) * 0.5;
      const tx = p.x - _f.x * back, ty = p.y - _f.y * back, tz = p.z - _f.z * back;
      _t.set(tx, ty, tz);
      item.trail.push(_t);
      const life = Math.max(dt * 2.5, 0.04);
      glow.spawn(G.glow, tx, ty, tz, vel.x, vel.y, vel.z, life, 1.8 * big, 1.8 * big, 1, 0.88, 0.66, 1, 55);
      glow.spawn(G.beacon, tx, ty, tz, vel.x, vel.y, vel.z, life, 8 * big, 8 * big, 1, 0.62, 0.3, 1, 1.6);
      glow.spawn(G.motor, tx, ty, tz, vel.x, vel.y, vel.z, life, 1.1 * big, 1.1 * big, 1, 0.75, 0.42, 1, 14);
      v.lights.request(tx, ty, tz, 1, 0.7, 0.4, 1600 * big, 130);
      const dist = cam.distanceTo(p);
      // close up, the motor is a 3-5 m white-yellow tongue, not a dot
      if (dist < 700) {
        const fl = Math.max(dt * 1.6, 0.03);
        glow.spawn(G.motorFlame, tx - _f.x * 1.2 * big, ty - _f.y * 1.2 * big, tz - _f.z * 1.2 * big, vel.x - _f.x * 80, vel.y - _f.y * 80, vel.z - _f.z * 80,
          fl, 0.55 * big, 0.45 * big, 1, 0.82, 0.55, 1, 9);
      }
      if (dist < 1200) {
        const n = emitCount(item, '_puff', 26 * v.cfg.rate, dt);
        for (let i = 0; i < n; i++) {
          randDir(_d);
          const s = Math.random() * dt;
          lit.spawn(L.shed, tx - vel.x * s, ty - vel.y * s, tz - vel.z * s, vel.x * 0.12 + _d.x * 3, vel.y * 0.12 + _d.y * 3, vel.z * 0.12 + _d.z * 3,
            rnd(1.4, 2.8), 0.7 * big, rnd(3.2, 5) * big, 0.92, 0.92, 0.93, 0.42, 0);
        }
        if (dist < 400) v.heat(_t, _a.copy(_t).addScaledVector(_f, -9 * big), 1.3 * big, 0.6);
      }
    }
  }

  // ---------------- flares ----------------
  flare(entity) {
    if (this.flares.has(entity)) return this.flares.get(entity);
    const item = { entity, trail: this.vfx.ribbons.create(this._style('flare')), age: 0, burn: entity.burnTime ?? entity.life ?? 4.5, pose: makePose() };
    this.flares.set(entity, item);
    return item;
  }

  _updateFlares(dt) {
    const v = this.vfx, { glow, G } = v;
    for (const [entity, item] of this.flares) {
      item.age += dt;
      if (!isAlive(entity) || item.age > item.burn || !readPose(entity, item.pose, dt)) {
        item.trail.end();
        this.flares.delete(entity);
        continue;
      }
      const { position: p, velocity: vel } = item.pose;
      const k = saturate((item.burn - item.age) / 0.8) * saturate(item.age / 0.08 + 0.3);
      const life = Math.max(dt * 2.5, 0.04);
      glow.spawn(G.glow, p.x, p.y, p.z, vel.x, vel.y, vel.z, life, 2.2, 2.2, 1, 0.95, 0.85, 1, 160 * k);
      glow.spawn(G.flare, p.x, p.y, p.z, vel.x, vel.y, vel.z, life, 12, 12, 1, 0.9, 0.72, 1, 16 * k);
      glow.spawn(G.beacon, p.x, p.y, p.z, vel.x, vel.y, vel.z, life, 34, 34, 1, 0.72, 0.42, 1, 1.3 * k);
      const n = emitCount(item, '_spark', 45 * v.cfg.rate, dt);
      for (let i = 0; i < n; i++) {
        randDir(_d);
        glow.spawn(G.ember, p.x, p.y, p.z, vel.x * 0.5 + _d.x * 7, vel.y * 0.5 + _d.y * 7, vel.z * 0.5 + _d.z * 7, rnd(0.35, 1.0), rnd(0.1, 0.18), 0.03, 1, 0.82, 0.5, 1, rnd(6, 14) * k);
      }
      item.trail.strength = 0.4 + 0.6 * k;
      item.trail.push(p);
      v.lights.request(p.x, p.y, p.z, 1, 0.86, 0.66, 5200 * k, 280);
    }
  }

  /**
   * Something burning while it moves fast (a hit aircraft, a falling wreck):
   * dense soot that billows out behind, fire licking at the source and torn
   * off along the motion, embers. `s` scales sizes, `heat` 0..1 the fire.
   *
   * The soot is laid down per metre travelled, not per second: at 250 m/s a
   * per-second emitter beads into separate clumps whenever the frame time
   * wobbles. Spacing is about a third of a young puff's width, so neighbours
   * always overlap; a lower tier lays fewer, bigger puffs (size x 1/sqrt(rate)).
   */
  _burn(item, p, vel, s, heat, dt) {
    const v = this.vfx, { lit, glow, L, G } = v;
    const rate = v.cfg.rate;
    const k = sizeForRate(rate);
    const speed = vel.length();
    const spacing = (1.5 * s * k) / Math.sqrt(rate);
    item._sootPath ??= makePath();
    let j = 0;
    const puff = (x, y, z, f) => {
      randDir(_d);
      const hot = j++ % 4 === 0 ? rnd(0.6, 1.2) * (0.5 + 0.5 * heat) : 0;
      lit.spawn(L.soot, x + _d.x * 0.5 * s, y + _d.y * 0.5 * s, z + _d.z * 0.5 * s,
        vel.x * 0.42 + _d.x * 6, vel.y * 0.42 + _d.y * 6 + 1, vel.z * 0.42 + _d.z * 6,
        rnd(2.4, 4.6), rnd(1.3, 2.0) * s * k, rnd(7.5, 12) * s * k, 0.05, 0.047, 0.045, 0.93, hot, (1 - f) * dt);
    };
    emitAlong(item._sootPath, p.x, p.y, p.z, spacing, 64, puff);
    // a slow or hovering source still smokes (per second, at the rate a
    // 60 m/s source would get from the spacing above)
    if (speed < 60) {
      const n = emitCount(item, '_soot', ((60 - speed) / spacing) * 0.6, dt);
      for (let i = 0; i < n; i++) puff(p.x, p.y, p.z, Math.random());
    }
    // fire: stretched tongues close to the source, brighter with heat,
    // spread over the stretch of path flown this frame (spawned at the
    // source alone, each frame's tongues bunched into one bright bead)
    const prev = item._prevP ??= p.clone();
    if (prev.distanceToSquared(p) > 400 * 400) prev.copy(p);
    let n = emitCount(item, '_fire', (70 + 60 * heat) * rate, dt);
    for (let i = 0; i < n; i++) {
      randDir(_d);
      const b = Math.random();
      const bx = p.x + (prev.x - p.x) * b, by = p.y + (prev.y - p.y) * b, bz = p.z + (prev.z - p.z) * b;
      glow.spawn(G.fire, bx + _d.x * 0.4 * s, by + _d.y * 0.4 * s, bz + _d.z * 0.4 * s,
        vel.x * 0.8 + _d.x * 5, vel.y * 0.8 + _d.y * 5, vel.z * 0.8 + _d.z * 5,
        rnd(0.07, 0.16), rnd(1.2, 2.0) * s, rnd(2.2, 3.2) * s, 1, 0.52, 0.17, 1, rnd(1.2, 2.6) * (0.6 + 0.4 * heat), b * dt);
    }
    prev.copy(p);
    n = emitCount(item, '_emb', (8 + 10 * heat) * rate, dt);
    for (let i = 0; i < n; i++) {
      randDir(_d);
      glow.spawn(G.ember, p.x, p.y, p.z, vel.x * 0.6 + _d.x * 10, vel.y * 0.6 + _d.y * 10, vel.z * 0.6 + _d.z * 10, rnd(0.5, 1.5), rnd(0.1, 0.22), 0.03, 1, 0.6, 0.2, 1, rnd(5, 12));
    }
    const life = Math.max(dt * 2.5, 0.04);
    glow.spawn(G.glow, p.x, p.y, p.z, vel.x, vel.y, vel.z, life, 2.2 * s, 2.2 * s, 1, 0.5, 0.15, 1, 3 + 5 * heat);
    glow.spawn(G.halo, p.x, p.y, p.z, vel.x, vel.y, vel.z, life, 7 * s, 7 * s, 1, 0.42, 0.12, 1, 0.3 + 0.3 * heat);
    v.lights.request(p.x, p.y, p.z, 1, 0.55, 0.22, (1400 + 1200 * heat) * s, 110);
  }

  // ---------------- fires ----------------
  fire(pos, { size = 3, duration = Infinity, smoke = 1 } = {}) {
    const max = this.vfx.cfg.fires;
    if (this.fires.length >= max) {
      // retire the oldest finite fire first, otherwise the oldest of all
      let k = this.fires.findIndex((f) => Number.isFinite(f.duration));
      if (k < 0) k = 0;
      this.fires.splice(k, 1);
    }
    const f = { pos: pos.clone(), size, duration, smoke, age: 0, stop: () => { f.duration = Math.min(f.duration, f.age + 6); } };
    this.fires.push(f);
    return f;
  }

  _updateFires(dt) {
    const v = this.vfx, { lit, glow, L, G } = v;
    const cam = v.shared.u.camPos.value;
    for (let i = this.fires.length - 1; i >= 0; i--) {
      const f = this.fires[i];
      f.age += dt;
      if (f.age > f.duration) { this.fires.splice(i, 1); continue; }
      const dist = cam.distanceTo(f.pos);
      if (dist > 50000) continue;
      const lod = (dist > 14000 ? 0.4 : dist > 5000 ? 0.7 : 1) * v.cfg.rate;
      const k = Number.isFinite(f.duration) ? saturate((f.duration - f.age) / 10) : 1;
      const s = f.size, p = f.pos;
      // the burn dies down over the first minutes, the smoke keeps going
      const burn = k * (0.45 + 0.55 * Math.exp(-f.age / 90));
      // The column: dense oily smoke rolling off the fire, and above it the
      // older smoke - paler, much bigger, a minute old - which is what makes
      // it tower and lean away downwind (visible from across the valley).
      let n = emitCount(f, '_col', (2.6 + s * 0.35) * f.smoke * lod * (0.5 + 0.5 * k), dt);
      for (let j = 0; j < n; j++) {
        const a = rnd(Math.PI * 2), r = rnd(s * 0.6);
        lit.spawn(L.column, p.x + Math.cos(a) * r, p.y + s * 0.6, p.z + Math.sin(a) * r, rnd(-1, 1), rnd(6, 10) + s * 0.5, rnd(-1, 1),
          rnd(20, 30), s * rnd(1.5, 2.2), s * rnd(7, 10) + 8, 0.042, 0.04, 0.038, 0.9, rnd(0, 1.3) * burn);
      }
      n = emitCount(f, '_top', (0.9 + s * 0.14) * f.smoke * lod * (0.5 + 0.5 * k), dt);
      for (let j = 0; j < n; j++) {
        const a = rnd(Math.PI * 2), r = rnd(s * 0.8);
        lit.spawn(L.columnTop, p.x + Math.cos(a) * r, p.y + s, p.z + Math.sin(a) * r, rnd(-1.5, 1.5), rnd(5, 8) + s * 0.4, rnd(-1.5, 1.5),
          rnd(44, 62), s * rnd(2.0, 3.0), s * rnd(13, 19) + 26, 0.1, 0.098, 0.096, 0.6);
      }
      if (dist < 7000 && burn > 0.02) {
        n = emitCount(f, '_fl', 13 * lod, dt);
        for (let j = 0; j < n; j++) {
          const a = rnd(Math.PI * 2), r = rnd(s * 0.75);
          lit.spawn(L.flame, p.x + Math.cos(a) * r, p.y + s * 0.2, p.z + Math.sin(a) * r, rnd(-1.5, 1.5), rnd(2, 5) + s * 0.5, rnd(-1.5, 1.5),
            rnd(0.5, 1.1), s * rnd(0.6, 1.1), s * rnd(0.9, 1.5), 0.09, 0.085, 0.08, 0.8, rnd(1.2, 2.5) * burn);
        }
        n = emitCount(f, '_em', 5 * lod, dt);
        for (let j = 0; j < n; j++) {
          glow.spawn(G.ember, p.x + rnd(-s, s) * 0.5, p.y + s * 0.5, p.z + rnd(-s, s) * 0.5, rnd(-2, 2), rnd(6, 13), rnd(-2, 2), rnd(1.2, 2.8), rnd(0.1, 0.2), 0.03, 1, 0.6, 0.2, 1, rnd(4, 9) * burn);
        }
        const life = Math.max(dt * 2.5, 0.04);
        glow.spawn(G.halo, p.x, p.y + s * 0.8, p.z, 0, 0, 0, life, s * 7, s * 7, 1, 0.42, 0.1, 1, 0.55 * burn * rnd(0.8, 1));
        v.heat(_a.set(p.x, p.y + s * 0.5, p.z), _b.set(p.x, p.y + s * 5, p.z), s * 1.8, 0.85 * burn);
      }
      if (burn > 0.02) v.lights.request(p.x, p.y + s, p.z, 1, 0.5, 0.2, s * s * 240 * burn * rnd(0.75, 1), s * 45 + 60);
    }
  }

  // ---------------- damaged aircraft ----------------
  damage(entity, level) {
    level = saturate(level);
    let item = this.damaged.get(entity);
    if (level < 0.3) { this.clearDamage(entity); return; }
    if (!item) { item = { entity, level, trail: null, tier: 0, pose: makePose() }; this.damaged.set(entity, item); }
    item.level = level;
  }

  clearDamage(entity) {
    const item = this.damaged.get(entity);
    if (!item) return;
    item.trail?.end();
    this.damaged.delete(entity);
  }

  _updateDamage(dt) {
    const v = this.vfx, { lit, L } = v;
    for (const [entity, item] of this.damaged) {
      if (!isAlive(entity) || !readPose(entity, item.pose, dt)) { this.clearDamage(entity); continue; }
      const { position: p, velocity: vel, quaternion: q } = item.pose;
      const tier = item.level >= 0.65 ? 2 : 1;
      if (tier !== item.tier) {
        item.trail?.end();
        item.trail = v.ribbons.create(this._style(tier === 2 ? 'damageHeavy' : 'damageLight'));
        item.tier = tier;
        item._sootPath = null;
      }
      _t.set(rnd(-0.4, 0.4), 0.3, 2.5).applyQuaternion(q).add(p);
      item.trail.strength = tier === 2 ? 1 : saturate((item.level - 0.3) / 0.35) * 0.7 + 0.3;
      item.trail.push(_t);
      if (tier === 2) {
        this._burn(item, _t, vel, 1, saturate((item.level - 0.65) / 0.3), dt);
      } else {
        // light damage: a thin grey stream with some body to it
        const n = emitCount(item, '_puff', 16 * v.cfg.rate, dt);
        for (let i = 0; i < n; i++) {
          randDir(_d);
          const b = Math.random() * dt;
          lit.spawn(L.shed, _t.x - vel.x * b, _t.y - vel.y * b, _t.z - vel.z * b, vel.x * 0.4 + _d.x * 3, vel.y * 0.4 + _d.y * 3, vel.z * 0.4 + _d.z * 3,
            rnd(1.2, 2.2), 0.8, rnd(3, 4.5), 0.5, 0.5, 0.51, 0.35 * item.trail.strength);
        }
      }
    }
  }

  // ---------------- falling wrecks ----------------
  wreck(pos, vel, scale = 1) {
    if (this.wrecks.length >= 8) { const old = this.wrecks.shift(); old.trail.end(); this.vfx.explosions.releaseDebris(old.hulk, old); }
    const w = {
      pos: pos.clone(), vel: vel ? vel.clone() : new THREE.Vector3(), age: 0, scale,
      trail: this.vfx.ribbons.create(this._style('wreck', scale)),
    };
    // the hulk itself: a dark tumbling piece inside the fire
    w.hulk = this.vfx.explosions.spawnDebris(w.pos, w.vel, 2.6 * scale, w);
    this.wrecks.push(w);
    return w;
  }

  _updateWrecks(dt) {
    const v = this.vfx;
    for (let i = this.wrecks.length - 1; i >= 0; i--) {
      const w = this.wrecks[i];
      w.age += dt;
      w.vel.y -= 9.81 * dt;
      w.vel.multiplyScalar(Math.exp(-0.1 * dt));
      w.pos.addScaledVector(w.vel, dt);
      const gy = terrainHeight(w.pos.x, w.pos.z);
      if (w.pos.y <= gy + 1 || w.age > 45) {
        w.trail.end();
        v.explosions.releaseDebris(w.hulk, w);
        this.wrecks.splice(i, 1);
        if (w.pos.y <= gy + 1) {
          w.pos.y = gy;
          v.explosion(w.pos, Math.max(6, 14 * w.scale), 'ground', null);
          if (w.scale < 0.8) v.spawnFire(w.pos, { size: 2 * w.scale + 1, duration: 80 });
        }
        continue;
      }
      w.trail.push(w.pos);
      this._burn(w, w.pos, w.vel, w.scale, 1, dt);
    }
  }

  // ---------------- kills ----------------
  targetDestroyed({ target, position }) {
    const pos = position ?? target?.position;
    if (!pos) return;
    if (target) this.clearDamage(target);
    this.pending.push({ pos: pos.clone(), vel: target?.velocity?.isVector3 ? target.velocity.clone() : new THREE.Vector3(), kind: target?.kind ?? '', frames: 2 });
  }

  noteBlast(pos) {
    this.recentBlasts.push({ pos: pos.clone(), t: this.vfx.shared.time });
    if (this.recentBlasts.length > 16) this.recentBlasts.shift();
  }

  /** True when an explosion was already raised here in the last moments (combat emits its own). */
  hadBlast(pos, radius = 150, window = 0.6) {
    const now = this.vfx.shared.time;
    return this.recentBlasts.some((b) => now - b.t < window && b.pos.distanceToSquared(pos) < radius * radius);
  }

  _updatePending() {
    const v = this.vfx, now = v.shared.time;
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const k = this.pending[i];
      if (--k.frames > 0) continue;
      this.pending.splice(i, 1);
      const agl = k.pos.y - terrainHeight(k.pos.x, k.pos.z);
      const air = agl > 25 || /air|fighter|plane|jet|heli|bomber|ace/i.test(k.kind);
      // combat normally emits its own `explosion`; only add one if it did not
      const had = this.recentBlasts.some((b) => now - b.t < 0.6 && b.pos.distanceToSquared(k.pos) < 150 * 150);
      if (!had) v.explosion(k.pos, air ? 'large' : 'medium', air ? 'air' : 'ground', k.vel);
      if (air) {
        this.wreck(k.pos, k.vel, 1);
        for (let j = 0; j < 2; j++) {
          randDir(_d);
          this.wreck(k.pos, _t.copy(k.vel).multiplyScalar(rnd(0.5, 0.9)).addScaledVector(_d, rnd(20, 45)), rnd(0.4, 0.6));
        }
      }
    }
  }

  update(dt) {
    for (const item of this.trails) {
      if (!isAlive(item.entity) || !readPose(item.entity, item.pose, dt)) { item.end(); continue; }
      item.trail.push(item.pose.position);
    }
    this._updatePending();
    this._updateMissiles(dt);
    this._updateFlares(dt);
    this._updateFires(dt);
    this._updateDamage(dt);
    this._updateWrecks(dt);
  }
}


