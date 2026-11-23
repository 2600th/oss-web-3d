import * as THREE from 'three/webgpu';
import { Shells } from '../core/Shells.js';
import { plumeState, vapourAmount, contrailAmount, vapourCone, speedOfSound, saturate, smoothstep, lerp } from '../core/ring.js';
import { rnd, randDir, readPose, makePose, isAlive } from './util.js';

const _d = new THREE.Vector3();
const _p = new THREE.Vector3();
const _p2 = new THREE.Vector3();
const _back = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _up = new THREE.Vector3();
const _right = new THREE.Vector3();
const _v = new THREE.Vector3();

// Effect anchors of the MiG-21 airframe, MEASURED from the vertices of
// mig21.glb after the game's normalisation (model space, metres, nose -Z,
// 15.76 m long; mig21_hostile is the same mesh). The `socketPositions` in the
// asset catalog and the wingtip sockets in flight/Aircraft.js are bounding-box
// guesses (the "nozzle" there is 0.66 m above and 1.16 m behind the real one,
// level with the fin tip), so effects are placed from this table instead.
const MIG21 = {
  nozzle: new THREE.Vector3(0, -0.61, 6.42),      // centre of the jet-pipe exit
  nozzleRadius: 0.45,                              // inner lip
  wingtipL: new THREE.Vector3(-3.6, -0.76, 3.3),   // tip, trailing edge
  wingtipR: new THREE.Vector3(3.6, -0.76, 3.3),
  wingRootL: new THREE.Vector3(-1.25, -0.5, 1.7),  // over the inner wing, where the vapour sheet sits
  wingRootR: new THREE.Vector3(1.25, -0.5, 1.7),
  gun: new THREE.Vector3(0, -0.6, -2.5),           // (not measured)
  // delta leading edge: root -> tip, and the wing plane height
  leRoot: [0.75, -1.1], leTip: [3.45, 2.16], wingY: -0.72,
};

/** Model-space anchor: an entity may override any of them with `entity.vfxSockets`. */
function socket(entity, name) {
  const s = entity?.vfxSockets?.[name];
  return s?.isVector3 ? s : MIG21[name];
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
      sheetL: null, sheetR: null, exhaust: null,
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
    item.sheetL?.end(); item.sheetR?.end(); item.exhaust?.end();
    item.vortexL = item.vortexR = item.contrail = item.sheetL = item.sheetR = item.exhaust = null;
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

  tracer(pos, vel) { this.vfx.tracers.fire(pos, vel); }

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
        // The exhaust is three things, all sized from the nozzle (0.44 m
        // radius on the MiG-21) and all scaled by engine state:
        //  - the nozzle ring: hot petals, dull red on dry thrust, bright in reheat
        //  - the plume: nothing to speak of dry; in reheat a short flame with
        //    shock diamonds (plumeState: about 8 m at full burner)
        //  - a small core glow up the pipe, plus a point of light that keeps
        //    a lit burner readable at range.
        const R = entity.nozzleRadius ?? MIG21.nozzleRadius;
        const flick = 0.92 + 0.08 * Math.sin(v.shared.time * 47 + item.seed * 9);
        if (pl.core > 0.03) {
          this.plumes.add(_p, _back, pl.length * flick, R, pl.core * 0.9, pl.diamonds, pl.glow, 0);
          this.plumes.add(_p, _back, pl.length * 0.8 * flick, R, pl.core * 1.3, pl.diamonds, pl.glow, 1);
        }
        // (the anchor is the exit plane: the band lines the last of the pipe)
        _p2.copy(_p).addScaledVector(_back, -0.36);
        this.plumes.add(_p2, _back, 0.36, R * 0.9, 1, 0, pl.glow, 2);
        const life = Math.max(dt * 2.5, 0.04);
        glow.spawn(G.core, _p.x, _p.y, _p.z, vel.x, vel.y, vel.z, life, R * 1.4, R * 1.4, 1, 0.55, 0.24, 1, 0.04 + pl.glow * 0.3 + pl.reheat * 1.6);
        if (pl.reheat > 0.05) {
          glow.spawn(G.glow, _p.x + _back.x * 0.6, _p.y + _back.y * 0.6, _p.z + _back.z * 0.6, vel.x, vel.y, vel.z, life, R * 1.4, R * 1.4, 1, 0.62, 0.3, 1, 1.4 * pl.reheat);
          glow.spawn(G.halo, _p.x + _back.x * 1.5, _p.y + _back.y * 1.5, _p.z + _back.z * 1.5, vel.x, vel.y, vel.z, life, 3.4, 3.4, 1, 0.5, 0.2, 1, 0.16 * pl.reheat);
          v.lights.request(_p.x + _back.x * 2.5, _p.y + _back.y * 2.5, _p.z + _back.z * 2.5, 1, 0.6, 0.3, 1100 * pl.reheat, 70);
        }
        if (dist < 500) v.heat(_p, _p2.copy(_p).addScaledVector(_back, 4 + pl.length * 1.6), 1.0, 0.35 + 0.65 * pl.glow);
        // reheat lighting: a short pop of flame
        if (target.reheat > 0 && item.wasReheat === 0) {
          glow.spawn(G.flash, _p.x, _p.y, _p.z, vel.x, vel.y, vel.z, 0.12, 1.5, 3.5, 1, 0.7, 0.35, 1, 4);
          for (let i = 0; i < 6; i++) {
            randDir(_d);
            glow.spawn(G.spark, _p.x, _p.y, _p.z, vel.x + _back.x * 60 + _d.x * 12, vel.y + _back.y * 60 + _d.y * 12, vel.z + _back.z * 60 + _d.z * 12, rnd(0.2, 0.5), 0.1, 0.02, 1, 0.7, 0.3, 1, 8);
          }
        }
      }
      item.wasReheat = target.reheat;
      // Dry-thrust smoke: a thin sooty thread laid in the air along the
      // nozzle's path (it stays where it was made, so it curves through a
      // hard turn); it burns clean in reheat.
      const sooty = dist < 5000 ? saturate((eng.throttle ?? 0.8) * 1.3 - 0.3) * (1 - 0.8 * pl.reheat) : 0;
      if (sooty > 0.08) {
        item.exhaust ??= v.ribbons.create(v.emitters._style('exhaust'));
        item.exhaust.strength = sooty;
        item.exhaust.push(_p2.copy(_p).addScaledVector(_back, 2.5));
      } else if (item.exhaust) { item.exhaust.end(); item.exhaust = null; }

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
      // humidity is known at the camera; aircraft far from it get the day's base value
      const weather = v.game.env?.weather;
      const hum = weather ? (entity === this.player || dist < 700 ? weather.humidity : weather.settings.humidity) : 0.3;
      const amount = near ? vapourAmount(item.g, aoa, speed, pos.y, hum) : 0;

      // wingtip vortex cores
      if (amount > 0.05) {
        if (!item.vortexL) {
          item.vortexL = v.ribbons.create(v.emitters._style('vortex'));
          item.vortexR = v.ribbons.create(v.emitters._style('vortex'));
        }
        item.vortexL.strength = item.vortexR.strength = saturate(amount * 1.6);
        item.vortexL.push(_p2.copy(socket(entity, 'wingtipL')).applyQuaternion(q).add(pos));
        item.vortexR.push(_p2.copy(socket(entity, 'wingtipR')).applyQuaternion(q).add(pos));
      } else if (item.vortexL) {
        item.vortexL.end(); item.vortexR.end();
        item.vortexL = item.vortexR = null;
      }

      // condensation sheets off the inner wing: a soft ribbon each side for
      // the body of it, and wisps born along the leading edge on top
      if (amount > 0.22 && dist < 4000) {
        if (!item.sheetL) {
          item.sheetL = v.ribbons.create(v.emitters._style('sheet'));
          item.sheetR = v.ribbons.create(v.emitters._style('sheet'));
        }
        item.sheetL.strength = item.sheetR.strength = smoothstep(0.22, 0.75, amount);
        item.sheetL.push(_p2.copy(socket(entity, 'wingRootL')).applyQuaternion(q).add(pos));
        item.sheetR.push(_p2.copy(socket(entity, 'wingRootR')).applyQuaternion(q).add(pos));
      } else if (item.sheetL) {
        item.sheetL.end(); item.sheetR.end();
        item.sheetL = item.sheetR = null;
      }
      if (amount > 0.22 && dist < 1500) {
        const n = Math.floor(1300 * amount * v.cfg.rate * dt + Math.random());
        const m = entity.vfxSockets ?? MIG21;
        const le0 = m.leRoot ?? MIG21.leRoot, le1 = m.leTip ?? MIG21.leTip, wy = m.wingY ?? MIG21.wingY;
        for (let i = 0; i < n; i++) {
          const side = Math.random() < 0.5 ? -1 : 1;
          const t = Math.random() * 0.9;
          _p2.set(side * lerp(le0[0], le1[0], t), wy + 0.22, lerp(le0[1], le1[1], t) + rnd(0.2, 1.3)).applyQuaternion(q).add(pos);
          // born moving with the wing: they sit over it for a moment, then drag peels them back
          lit.spawn(L.wisp, _p2.x, _p2.y, _p2.z, vel.x * 0.98 + _up.x * 3, vel.y * 0.98 + _up.y * 3, vel.z * 0.98 + _up.z * 3,
            rnd(0.06, 0.12), rnd(0.45, 0.7), rnd(1.0, 1.5), 1.25, 1.25, 1.3, 0.14 * amount);
        }
      }

      const mach = speed / speedOfSound(pos.y);
      const cone = near ? vapourCone(mach) : 0;
      if (cone > 0.02) {
        _p2.copy(pos).addScaledVector(_fwd, 0.5);
        this.cones.add(_p2, _back, 5.5, 1, cone, 1.3, 4.6, 0);
      }

      const contrail = contrailAmount(pos.y, eng.throttle ?? 0.8, weather?.settings.humidity ?? 0.3);
      if (contrail > 0.05) {
        item.contrail ??= v.ribbons.create(v.emitters._style('contrail'));
        item.contrail.strength = contrail;
        item.contrail.push(_p2.copy(_p).addScaledVector(_back, 9));
      } else if (item.contrail) { item.contrail.end(); item.contrail = null; }

      // ---- gun ----
      if (item.firing) {
        // Tracers are drawn from combat's live rounds (core/Tracers.js); the
        // gun itself only contributes its flash and smoke here.
        _p2.copy(socket(entity, 'gun')).applyQuaternion(q).add(pos);
        if (Math.random() < 0.8) this.muzzleFlash(_p2, _fwd, vel, 1);
      }
    }
    this.plumes.end();
    this.cones.end();
    this._cloudStreaks(dt);
    this._rain(dt);
  }

  /**
   * Precipitation near the camera (env.weather.rain / .snow, 0..1): drops and
   * flakes anchored in the air, falling with the wind, so at flying speed they
   * tear past as streaks that converge on the direction of flight. A few big
   * soft sheets give the volume its depth.
   */
  _rain(dt) {
    const v = this.vfx, { glow, lit, G, L } = v;
    const w = v.game.env?.weather;
    const rain = saturate(w?.rain ?? v.game.env?.rain ?? 0), snow = saturate(w?.snow ?? 0);
    if (rain < 0.03 && snow < 0.03) return;
    const u = v.shared.u, cam = u.camPos.value, cv = u.camVel.value, wind = u.wind.value;
    const speed = cv.length();
    const sky = u.skyColor.value;
    const lum = 0.25 + 1.6 * (sky.r + sky.g + sky.b) / 3;
    if (speed > 15) _fwd.copy(cv).divideScalar(speed); else _fwd.copy(u.camFwd.value);
    const reach = Math.max(40, speed * 0.45);
    const fall = (type, n, vy, life0, life1, w0, w1, r, g, b, k) => {
      for (let i = 0; i < n; i++) {
        randDir(_d);
        const ahead = rnd(0.1, 1) * reach;
        const lat = rnd(2, 38);
        _d.addScaledVector(_fwd, -_d.dot(_fwd)).normalize();
        const x = cam.x + _fwd.x * ahead + _d.x * lat, y = cam.y + _fwd.y * ahead + _d.y * lat, z = cam.z + _fwd.z * ahead + _d.z * lat;
        glow.spawn(type, x, y, z, wind.x, vy, wind.z, rnd(life0, life1), rnd(w0, w1), w0, r, g, b, 1, k * rnd(0.5, 1.1));
      }
    };
    if (rain >= 0.03) fall(G.rain, Math.floor(900 * rain * v.cfg.rate * dt + Math.random()), -9, 0.5, 0.9, 0.03, 0.06, 0.8, 0.86, 1, 5 * lum * rain);
    if (snow >= 0.03) fall(G.snow, Math.floor(650 * snow * v.cfg.rate * dt + Math.random()), -1.5, 0.5, 1.0, 0.035, 0.08, 0.95, 0.97, 1, 8 * lum * snow);
    const amt = Math.max(rain, snow * 0.6);
    const m = Math.floor(5 * amt * v.cfg.rate * dt + Math.random());
    for (let i = 0; i < m; i++) {
      randDir(_d);
      const ahead = rnd(0.4, 1.2) * reach + 30;
      const x = cam.x + _fwd.x * ahead + _d.x * 60, y = cam.y + _fwd.y * ahead + _d.y * 40, z = cam.z + _fwd.z * ahead + _d.z * 60;
      lit.spawn(L.wisp, x, y, z, wind.x, -4, wind.z, rnd(0.6, 1.1), rnd(18, 30), rnd(26, 44), 0.8, 0.82, 0.86, 0.05 * amt);
    }
  }

  /**
   * Inside cloud: grey wisps and pale droplet streaks rushing past the camera.
   * They are born close ahead (cloud hides anything further than a few tens
   * of metres) and held in the air, so speed alone makes the rush; the count
   * follows env.inCloud, which drops within a few frames on the way out.
   */
  _cloudStreaks(dt) {
    const v = this.vfx, { glow, lit, G, L } = v;
    const inCloud = saturate(v.game.env?.inCloud ?? 0);
    if (inCloud < 0.03) return;
    const u = v.shared.u, cam = u.camPos.value, cv = u.camVel.value;
    const speed = cv.length();
    if (speed < 20) return;
    const sky = u.skyColor.value;
    const lum = 0.2 + 1.3 * (sky.r + sky.g + sky.b) / 3;
    _fwd.copy(cv).divideScalar(speed);
    const n = Math.floor(260 * inCloud * v.cfg.rate * dt + Math.random());
    for (let i = 0; i < n; i++) {
      randDir(_d);
      const ahead = rnd(0.06, 0.4) * speed;
      const lat = rnd(2.5, 26);
      _d.addScaledVector(_fwd, -_d.dot(_fwd)).normalize();
      const x = cam.x + _fwd.x * ahead + _d.x * lat, y = cam.y + _fwd.y * ahead + _d.y * lat, z = cam.z + _fwd.z * ahead + _d.z * lat;
      if (i % 4 === 0) lit.spawn(L.wisp, x, y, z, 0, 0, 0, rnd(0.35, 0.6), rnd(7, 12), rnd(12, 20), 0.95, 0.96, 1, 0.05 * inCloud);
      else glow.spawn(G.streak, x, y, z, 0, 0, 0, rnd(0.25, 0.55), rnd(0.04, 0.1), 0.04, 0.85, 0.9, 1, 1, 7 * lum * inCloud);
    }
  }

  dispose() {
    this.plumes.dispose();
    this.cones.dispose();
  }
}
