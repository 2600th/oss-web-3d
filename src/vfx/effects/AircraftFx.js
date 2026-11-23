import * as THREE from 'three/webgpu';
import { Shells } from '../core/Shells.js';
import { plumeState, vapourAmount, vapourCone, speedOfSound, saturate, smoothstep, lerp } from '../core/ring.js';
import { rnd, randDir, readPose, makePose, isAlive } from './util.js';

const _d = new THREE.Vector3();
const _p = new THREE.Vector3();
const _p2 = new THREE.Vector3();
const _back = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _up = new THREE.Vector3();
const _right = new THREE.Vector3();
const _v = new THREE.Vector3();

// MiG-21-sized defaults for entities that do not carry sockets (model space: nose -Z)
const DEFAULT_SOCKETS = {
  nozzle: new THREE.Vector3(0, 0.05, 7.4),
  wingtipL: new THREE.Vector3(-3.4, -0.05, 1.6),
  wingtipR: new THREE.Vector3(3.4, -0.05, 1.6),
  gun: new THREE.Vector3(0, -0.6, -2.5),
};

function socket(entity, name) {
  const s = entity?.sockets?.[name];
  if (s?.isVector3) return s;
  if (s?.isObject3D) return s.position;
  return DEFAULT_SOCKETS[name];
}

/**
 * Per-aircraft effects: afterburner plume with shock diamonds, nozzle glow and
 * heat haze, wingtip vortices, high-altitude contrail, wing vapour in hard
 * turns, the transonic vapour cone, and the gun (tracers, muzzle flash,
 * smoke). Also the camera-relative streaks when flying inside cloud.
 */
export class AircraftFx {
  constructor(vfx) {
    this.vfx = vfx;
    const game = vfx.game;
    this.items = new Map();
    this.plumes = new Shells(vfx.shared, 48, 'plume');
    this.cones = new Shells(vfx.shared, 12, 'vapour');
    this.plumes.mesh.renderOrder = 2;
    this.cones.mesh.renderOrder = 1;
    vfx.scene.add(this.plumes.mesh, this.cones.mesh);

    // The player is always present; combat does not need to announce it.
    const flight = game.flight;
    this.player = {
      isPlayer: true, id: 'player', kind: 'player', team: 'player', alive: true,
      get position() { return flight.position; },
      get quaternion() { return flight.orientation; },
      get velocity() { return flight.velocity; },
      get engine() { return { throttle: flight.throttleSmoothed, reheat: flight.reheat }; },
      get gLoad() { return flight.gLoad; },
      get aoa() { return flight.angleOfAttack; },
      sockets: game.player.sockets,
    };
    this.add(this.player);
  }

  _isPlayer(entity) {
    const g = this.vfx.game;
    return !entity || entity === this.player || entity.isPlayer === true || entity === g.player || entity === g.flight
      || entity.kind === 'player' || (entity.object3d && entity.object3d === g.player.group);
  }

  _resolve(entity) {
    if (this._isPlayer(entity)) return this.items.get(this.player);
    return this.items.get(entity) ?? this.add(entity);
  }

  add(entity) {
    if (entity !== this.player && this._isPlayer(entity)) return this.items.get(this.player);
    if (this.items.has(entity)) return this.items.get(entity);
    const item = {
      entity, pose: makePose(), plume: plumeState(0.7, false), vortexL: null, vortexR: null, contrail: null,
      firing: false, g: 1, wasReheat: 0, seed: Math.random(),
    };
    this.items.set(entity, item);
    return item;
  }

  remove(entity) {
    const item = this.items.get(entity);
    if (!item || entity === this.player) return;
    this._endTrails(item);
    this.items.delete(entity);
  }

  _endTrails(item) {
    item.vortexL?.end(); item.vortexR?.end(); item.contrail?.end();
    item.vortexL = item.vortexR = item.contrail = null;
  }

  gun(entity, firing) {
    const item = this._resolve(entity);
    if (item) item.firing = firing;
  }

  /** One muzzle flash (also usable for ground guns). */
  muzzleFlash(pos, dir, vel = null, scale = 1) {
    const { glow, lit, G, L, lights } = this.vfx;
    const vx = vel?.x ?? 0, vy = vel?.y ?? 0, vz = vel?.z ?? 0;
    glow.spawn(G.flash, pos.x + dir.x * 0.5 * scale, pos.y + dir.y * 0.5 * scale, pos.z + dir.z * 0.5 * scale, vx, vy, vz,
      0.035, rnd(1.2, 2.0) * scale, rnd(1.8, 2.8) * scale, 1, 0.82, 0.5, 1, rnd(14, 26));
    glow.spawn(G.jet, pos.x + dir.x * scale, pos.y + dir.y * scale, pos.z + dir.z * scale, vx + dir.x * 30, vy + dir.y * 30, vz + dir.z * 30,
      0.05, 0.9 * scale, 0.4 * scale, 1, 0.7, 0.3, 1, 5);
    if (Math.random() < 0.5) {
      lit.spawn(L.shed, pos.x, pos.y, pos.z, vx * 0.5 + dir.x * 8, vy * 0.5 + dir.y * 8, vz * 0.5 + dir.z * 8, rnd(0.5, 1), 0.3 * scale, 1.8 * scale, 0.6, 0.6, 0.6, 0.3);
    }
    lights.request(pos.x, pos.y, pos.z, 1, 0.8, 0.5, 600 * scale * rnd(0.5, 1), 45);
  }

  tracer(pos, vel) {
    const { glow, G } = this.vfx;
    glow.spawn(G.tracer, pos.x, pos.y, pos.z, vel.x, vel.y, vel.z, 1.6, 0.34, 0.26, 1, 0.74, 0.3, 1, 48);
  }

  update(dt) {
    const v = this.vfx, { lit, glow, L, G } = v;
    const cam = v.shared.u.camPos.value;
    this.plumes.begin();
    this.cones.begin();
    for (const [entity, item] of this.items) {
      if (entity !== this.player && !isAlive(entity)) { this.remove(entity); continue; }
      if (!readPose(entity, item.pose, dt)) continue;
      const { position: pos, quaternion: q, velocity: vel } = item.pose;
      const crashed = entity === this.player && v.game.flight.crashed;
      if (crashed) { this._endTrails(item); continue; }
      _fwd.set(0, 0, -1).applyQuaternion(q);
      _back.copy(_fwd).negate();
      _up.set(0, 1, 0).applyQuaternion(q);
      _right.set(1, 0, 0).applyQuaternion(q);
      const speed = vel.length();
      const dist = cam.distanceTo(pos);
      const near = dist < 9000;

      // ---- engine: plume, glow, light, haze ----
      const eng = entity.engine ?? { throttle: 0.8, reheat: false };
      const target = plumeState(eng.throttle, eng.reheat);
      const k = 1 - Math.exp(-9 * dt);
      const pl = item.plume;
      for (const key of ['length', 'diamonds', 'core', 'glow', 'reheat']) pl[key] = lerp(pl[key], target[key], k);
      _p.copy(socket(entity, 'nozzle')).applyQuaternion(q).add(pos);
      if (near) {
        const flick = 0.9 + 0.1 * Math.sin(v.shared.time * 47 + item.seed * 9);
        this.plumes.add(_p, _back, pl.length * flick, 0.5, pl.core * 0.9, pl.diamonds, pl.glow, 0);
        this.plumes.add(_p, _back, pl.length * 0.82 * flick, 0.5, pl.core * 1.3, pl.diamonds, pl.glow, 1);
        const life = Math.max(dt * 2.5, 0.04);
        glow.spawn(G.glow, _p.x, _p.y, _p.z, vel.x, vel.y, vel.z, life, 1.1, 1.1, 1, 0.62, 0.3, 1, 0.2 + pl.glow * 4);
        if (pl.reheat > 0.05) {
          glow.spawn(G.halo, _p.x + _back.x * 2, _p.y + _back.y * 2, _p.z + _back.z * 2, vel.x, vel.y, vel.z, life, 9, 9, 1, 0.5, 0.2, 1, 0.5 * pl.reheat);
          v.lights.request(_p.x + _back.x * 2.5, _p.y + _back.y * 2.5, _p.z + _back.z * 2.5, 1, 0.6, 0.3, 1100 * pl.reheat, 70);
        }
        if (dist < 500) v.heat(_p, _p2.copy(_p).addScaledVector(_back, 5 + pl.length * 1.6), 1.15, 0.45 + 0.55 * pl.glow);
        // reheat lighting: a short pop of flame
        if (target.reheat > 0 && item.wasReheat === 0) {
          glow.spawn(G.flash, _p.x, _p.y, _p.z, vel.x, vel.y, vel.z, 0.12, 2, 5, 1, 0.7, 0.35, 1, 5);
          for (let i = 0; i < 6; i++) {
            randDir(_d);
            glow.spawn(G.spark, _p.x, _p.y, _p.z, vel.x + _back.x * 60 + _d.x * 12, vel.y + _back.y * 60 + _d.y * 12, vel.z + _back.z * 60 + _d.z * 12, rnd(0.2, 0.5), 0.1, 0.02, 1, 0.7, 0.3, 1, 8);
          }
        }
      }
      item.wasReheat = target.reheat;

      // ---- aerodynamics: vortices, wing vapour, vapour cone, contrail ----
      let g = entity.gLoad;
      if (typeof g !== 'number') {
        _v.copy(item.pose.accel); _v.y += 9.81;
        g = _v.length() / 9.81;
        if (!(g < 20)) g = 1;
      }
      item.g = lerp(item.g, g, 1 - Math.exp(-6 * dt));
      let aoa = entity.aoa;
      if (typeof aoa !== 'number') aoa = speed > 30 ? Math.asin(Math.min(1, Math.abs(_v.copy(vel).divideScalar(speed).dot(_up)))) : 0;
      const amount = near ? vapourAmount(item.g, aoa, speed, pos.y) : 0;

      if (amount > 0.12) {
        if (!item.vortexL) {
          item.vortexL = v.ribbons.create(v.emitters._style('vortex'));
          item.vortexR = v.ribbons.create(v.emitters._style('vortex'));
        }
        item.vortexL.strength = item.vortexR.strength = amount;
        item.vortexL.push(_p2.copy(socket(entity, 'wingtipL')).applyQuaternion(q).add(pos));
        item.vortexR.push(_p2.copy(socket(entity, 'wingtipR')).applyQuaternion(q).add(pos));
      } else if (item.vortexL) {
        item.vortexL.end(); item.vortexR.end();
        item.vortexL = item.vortexR = null;
      }

      if (amount > 0.3 && dist < 2500) {
        const n = Math.floor(320 * amount * v.cfg.rate * dt + Math.random());
        const span = Math.abs(socket(entity, 'wingtipR').x);
        for (let i = 0; i < n; i++) {
          const side = Math.random() < 0.5 ? -1 : 1;
          _p2.set(side * rnd(0.7, span * 0.9), 0.32, rnd(0.2, 2.2)).applyQuaternion(q).add(pos);
          const s = Math.random() * dt;
          lit.spawn(L.wisp, _p2.x - vel.x * s, _p2.y - vel.y * s, _p2.z - vel.z * s, vel.x * 0.9 + _up.x * 3, vel.y * 0.9 + _up.y * 3, vel.z * 0.9 + _up.z * 3,
            rnd(0.1, 0.2), rnd(0.4, 0.7), rnd(1.2, 2.0), 1.25, 1.25, 1.3, 0.2 * amount);
        }
      }

      const mach = speed / speedOfSound(pos.y);
      const cone = near ? vapourCone(mach) : 0;
      if (cone > 0.02) {
        _p2.copy(pos).addScaledVector(_fwd, 0.5);
        this.cones.add(_p2, _back, 5.5, 1, cone, 1.3, 4.6, 0);
      }

      const contrail = smoothstep(7600, 8400, pos.y) * saturate((eng.throttle ?? 0.8) * 1.4);
      if (contrail > 0.05) {
        item.contrail ??= v.ribbons.create(v.emitters._style('contrail'));
        item.contrail.strength = contrail;
        item.contrail.push(_p2.copy(_p).addScaledVector(_back, 6));
      } else if (item.contrail) { item.contrail.end(); item.contrail = null; }

      // ---- gun ----
      if (item.firing) {
        _p2.copy(socket(entity, 'gun')).applyQuaternion(q).add(pos);
        item._tr = (item._tr ?? 0) + 24 * dt;
        while (item._tr >= 1) {
          item._tr -= 1;
          const s = Math.random() * dt;
          randDir(_d);
          _v.copy(_fwd).multiplyScalar(880).add(vel).addScaledVector(_d, 3);
          glow.spawn(G.tracer, _p2.x + _v.x * s, _p2.y + _v.y * s, _p2.z + _v.z * s, _v.x, _v.y, _v.z, 1.6, 0.34, 0.26, 1, 0.74, 0.3, 1, 48);
        }
        if (Math.random() < 0.8) this.muzzleFlash(_p2, _fwd, vel, 1);
      }
    }
    this.plumes.end();
    this.cones.end();
    this._cloudStreaks(dt);
  }

  /** Inside cloud: pale streaks and grey wisps rushing past the camera. */
  _cloudStreaks(dt) {
    const v = this.vfx, { glow, lit, G, L } = v;
    const inCloud = saturate(v.game.env?.inCloud ?? 0);
    if (inCloud < 0.03) return;
    const u = v.shared.u, cam = u.camPos.value, cv = u.camVel.value;
    const speed = cv.length();
    if (speed < 20) return;
    _fwd.copy(cv).divideScalar(speed);
    const n = Math.floor(160 * inCloud * v.cfg.rate * dt + Math.random());
    for (let i = 0; i < n; i++) {
      randDir(_d);
      const ahead = rnd(0.25, 0.9) * speed;
      const lat = rnd(6, 45);
      _d.addScaledVector(_fwd, -_d.dot(_fwd)).normalize();
      const x = cam.x + _fwd.x * ahead + _d.x * lat, y = cam.y + _fwd.y * ahead + _d.y * lat, z = cam.z + _fwd.z * ahead + _d.z * lat;
      if (i % 3 === 0) lit.spawn(L.wisp, x, y, z, 0, 0, 0, rnd(0.5, 0.9), rnd(6, 12), rnd(10, 18), 0.95, 0.96, 1, 0.1 * inCloud);
      else glow.spawn(G.streak, x, y, z, 0, 0, 0, rnd(0.4, 0.8), rnd(0.05, 0.12), 0.05, 0.85, 0.9, 1, 1, 0.22 * inCloud);
    }
  }

  dispose() {
    this.plumes.dispose();
    this.cones.dispose();
  }
}
