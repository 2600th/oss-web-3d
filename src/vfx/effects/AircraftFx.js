import * as THREE from 'three/webgpu';
import { Shells } from '../core/Shells.js';
import { GUN_MUZZLE } from '../core/sockets.js';
import { plumeState, burnerState, burnerStep, vapourAmount, vapourGates, contrailAmount, vapourCone, speedOfSound, saturate, smoothstep, lerp } from '../core/ring.js';
import { rnd, randDir, readPose, makePose, isAlive } from './util.js';
import { BURNER } from './types.js';
import { sizeForRate } from '../core/fxmath.js';

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
  gun: new THREE.Vector3(GUN_MUZZLE.x, GUN_MUZZLE.y, GUN_MUZZLE.z), // GSh-23 muzzle (core/sockets.js; combat fires from it too)
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
    // low tier: half the ray-march samples, one noise tap
    this.plumes = new Shells(vfx.shared, 24, 'plume', { low: game.r?.tier?.name === 'low' });
    this.rings = new Shells(vfx.shared, 24, 'ring');
    this.cones = new Shells(vfx.shared, 12, 'vapour');
    this.plumes.mesh.renderOrder = 2;
    this.rings.mesh.renderOrder = 2;
    this.cones.mesh.renderOrder = 1;
    vfx.scene.add(this.plumes.mesh, this.rings.mesh, this.cones.mesh);

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
      entity, pose: makePose(), plume: burnerState(), vortexL: null, vortexR: null, contrail: null,
      sheetL: null, sheetR: null, exhaust: null,
      firing: false, g: 1, seed: Math.random(),
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

  /**
   * One muzzle flash (also usable for ground guns). A 23 mm muzzle flash is
   * a short forward cone of burning propellant gas about a metre long with a
   * hot star at the muzzle, gone within a frame or two, then a puff of grey
   * gun smoke that the airflow strips back along the belly.
   */
  // lightScale: the flash's point light casts no shadow, so from the
  // player's own cockpit (the muzzle is a few metres under the pilot) it lit
  // the whole interior cream-white through the fuselage. The gun branch
  // below passes a small scale when the camera is in that cockpit.
  muzzleFlash(pos, dir, vel = null, scale = 1, lightScale = 1) {
    const { glow, lit, G, L, lights } = this.vfx;
    const vx = vel?.x ?? 0, vy = vel?.y ?? 0, vz = vel?.z ?? 0;
    // the star at the muzzle
    glow.spawn(G.flash, pos.x + dir.x * 0.25 * scale, pos.y + dir.y * 0.25 * scale, pos.z + dir.z * 0.25 * scale, vx, vy, vz,
      0.03, rnd(0.55, 0.8) * scale, rnd(0.9, 1.3) * scale, 1, 0.85, 0.55, 1, rnd(22, 34));
    // the forward cone of gas: stretched along the barrel by its own motion
    glow.spawn(G.muzzle, pos.x + dir.x * 0.6 * scale, pos.y + dir.y * 0.6 * scale, pos.z + dir.z * 0.6 * scale,
      vx + dir.x * 320, vy + dir.y * 320, vz + dir.z * 320, 0.035, 0.38 * scale, 0.55 * scale, 1, 0.62, 0.24, 1, rnd(14, 22));
    if (Math.random() < 0.6) {
      lit.spawn(L.gunSmoke, pos.x, pos.y, pos.z, vx * 0.55 + dir.x * 12, vy * 0.55 + dir.y * 12, vz * 0.55 + dir.z * 12,
        rnd(0.5, 0.9), 0.25 * scale, rnd(1.4, 2.2) * scale, 0.42, 0.42, 0.43, 0.32);
    }
    if (lightScale > 0) lights.request(pos.x + dir.x, pos.y + dir.y, pos.z + dir.z, 1, 0.78, 0.45, 420 * scale * lightScale * rnd(0.6, 1), 30);
  }

  tracer(pos, vel) { this.vfx.tracers.fire(pos, vel); }

  update(dt) {
    const v = this.vfx, { lit, glow, L, G } = v;
    const cam = v.shared.u.camPos.value;
    this.plumes.begin();
    this.rings.begin();
    this.cones.begin();
    // how much the sun outshines a flame's light on the airframe (0 night .. 1 noon)
    const sun = v.shared.u.sunColor.value;
    const daylight = smoothstep(0.3, 3, 0.3 * sun.r + 0.59 * sun.g + 0.11 * sun.b);
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
      const mach = speed / speedOfSound(pos.y);
      const R = entity.nozzleRadius ?? MIG21.nozzleRadius;
      // The burner keeps its own clock (light-up pop, collapse) whether or
      // not anyone is near enough to see it.
      const pl = burnerStep(item.plume, plumeState(eng.throttle, eng.reheat, pos.y, mach, R), dt);
      _p.copy(socket(entity, 'nozzle')).applyQuaternion(q).add(pos);
      if (near) {
        // The exhaust, all sized from the nozzle (0.45 m radius on the
        // MiG-21) and all driven by the burner state:
        //  - the plume volume: nothing to speak of dry; in reheat a
        //    turbulent flame with shock diamonds, and behind it, up the pipe,
        //    the flameholder (Shells 'plume')
        //  - the nozzle ring: the hot flaps, dull red dry, bright in reheat
        //  - light: on the tail and whatever is close, a flash at light-up
        //  - a dot that keeps a lit burner readable when the flame itself
        //    is a pixel wide.
        // Slow breathing of the whole flame on top of the turbulence the
        // shader scrolls down it: two incommensurate rates, so it never
        // reads as a pulse.
        const t = v.shared.time, ph = item.seed * 40;
        const breathe = 1 + 0.035 * Math.sin(t * 23 + ph) + 0.025 * Math.sin(t * 37.7 + ph * 1.7);
        const hot = pl.reheat > 0.01;
        // Dry, the volume is only worth drawing close in (the flameholder
        // glow up the pipe and a stub of faint flame).
        if (hot || dist < BURNER.dryRange) {
          this.plumes.add(_p, _back, pl.flameLength * breathe, R, pl.power, pl.spacing, pl.glow, pl.reheat,
            pl.pop, item.seed * 7, pl.contrast, pl.spread);
        }
        // (the anchor is the exit plane: the band lines the last of the pipe)
        _p2.copy(_p).addScaledVector(_back, -0.36);
        this.rings.add(_p2, _back, 0.36, R * 0.9, 1, 0, pl.glow, 0);
        const life = Math.max(dt * 2.5, 0.04);
        // the turbine glow up the pipe on dry thrust (the flame takes over in reheat)
        const dryCore = (0.04 + pl.glow * 0.3) * (1 - saturate(pl.reheat * 3));
        if (dryCore > 0.01) glow.spawn(G.core, _p.x, _p.y, _p.z, vel.x, vel.y, vel.z, life, R * 1.4, R * 1.4, 1, 0.5, 0.18, 1, dryCore);
        if (hot) {
          // Far off the flame is thinner than a pixel: a dot with a pixel
          // floor carries it, and is absent close in where it would be a
          // halo over the real thing.
          const far = smoothstep(BURNER.dotNear, BURNER.dotFar, dist);
          if (far > 0.01) {
            glow.spawn(G.burner, _p.x + _back.x * 2, _p.y + _back.y * 2, _p.z + _back.z * 2, vel.x, vel.y, vel.z, life,
              R * 1.6, R * 1.6, 1, 0.62, 0.3, 1, BURNER.dot * far * pl.reheat * (1 + pl.pop));
          }
          // The flame as a light: mid-plume, so the fin, the tailplane
          // undersides and the ground under a low pass catch it.
          const lightK = pl.reheat * (1 + BURNER.flashLight * pl.pop) * (0.9 + 0.1 * breathe) * lerp(1, BURNER.lightDay, daylight);
          v.lights.request(_p.x + _back.x * 2.2, _p.y + _back.y * 2.2, _p.z + _back.z * 2.2, 1, 0.62, 0.3, BURNER.light * lightK, BURNER.lightRange);
        }
        if (dist < 500) {
          // shimmer: the hot jet stays hot far past the visible flame
          v.heat(_p, _p2.copy(_p).addScaledVector(_back, 5 + pl.length * (1.6 + 1.2 * pl.reheat)), 1.0 + 0.25 * pl.reheat, 0.35 + 0.65 * Math.min(1, pl.glow));
        }
        // Light-up: the flame's own lunge is the event (burnerStep's pop).
        // Here only the soft bloom of the torch leaving the pipe, moving
        // with the jet and gone in a tenth of a second.
        if (pl.lightUp && dist < 3000) {
          glow.spawn(G.lightUp, _p.x + _back.x * 0.3, _p.y + _back.y * 0.3, _p.z + _back.z * 0.3,
            vel.x + _back.x * 25, vel.y + _back.y * 25, vel.z + _back.z * 25, 0.14, R * 1.6, R * 3.2, 1, 0.66, 0.3, 1, BURNER.lightUpGlow);
        }
      }
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
      // Both need moisture: the tip vortex core condenses in its pressure
      // drop at moderate G on a humid day but is rare in dry air; the sheet
      // over the wing needs high G *and* humid air (vapourGates in ring.js).
      const gates = vapourGates(amount, hum);

      // wingtip vortex cores
      if (gates.tip > 0.05) {
        if (!item.vortexL) {
          item.vortexL = v.ribbons.create(v.emitters._style('vortex'));
          item.vortexR = v.ribbons.create(v.emitters._style('vortex'));
        }
        item.vortexL.strength = item.vortexR.strength = smoothstep(0.05, 0.7, gates.tip);
        item.vortexL.push(_p2.copy(socket(entity, 'wingtipL')).applyQuaternion(q).add(pos));
        item.vortexR.push(_p2.copy(socket(entity, 'wingtipR')).applyQuaternion(q).add(pos));
      } else if (item.vortexL) {
        item.vortexL.end(); item.vortexR.end();
        item.vortexL = item.vortexR = null;
      }

      // condensation sheets off the inner wing: a soft ribbon each side for
      // the body of it, and wisps born along the leading edge on top
      const wing = gates.wing;
      if (wing > 0.22 && dist < 4000) {
        if (!item.sheetL) {
          item.sheetL = v.ribbons.create(v.emitters._style('sheet'));
          item.sheetR = v.ribbons.create(v.emitters._style('sheet'));
        }
        item.sheetL.strength = item.sheetR.strength = smoothstep(0.22, 0.75, wing);
        item.sheetL.push(_p2.copy(socket(entity, 'wingRootL')).applyQuaternion(q).add(pos));
        item.sheetR.push(_p2.copy(socket(entity, 'wingRootR')).applyQuaternion(q).add(pos));
      } else if (item.sheetL) {
        item.sheetL.end(); item.sheetR.end();
        item.sheetL = item.sheetR = null;
      }
      if (wing > 0.22 && dist < 1500) {
        const n = Math.floor(1300 * wing * v.cfg.rate * dt + Math.random());
        const m = entity.vfxSockets ?? MIG21;
        const le0 = m.leRoot ?? MIG21.leRoot, le1 = m.leTip ?? MIG21.leTip, wy = m.wingY ?? MIG21.wingY;
        for (let i = 0; i < n; i++) {
          const side = Math.random() < 0.5 ? -1 : 1;
          const t = Math.random() * 0.9;
          _p2.set(side * lerp(le0[0], le1[0], t), wy + 0.22, lerp(le0[1], le1[1], t) + rnd(0.2, 1.3)).applyQuaternion(q).add(pos);
          // born moving with the wing: they sit over it for a moment, then drag peels them back
          lit.spawn(L.wisp, _p2.x, _p2.y, _p2.z, vel.x * 0.98 + _up.x * 3, vel.y * 0.98 + _up.y * 3, vel.z * 0.98 + _up.z * 3,
            rnd(0.06, 0.12), rnd(0.45, 0.7), rnd(1.0, 1.5), 1, 1, 1, 0.14 * wing);
        }
      }

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
        // camera inside this airframe (cockpit view): keep the flash and
        // smoke, drop its light (1.7 m from the eye, any of it floods the pit)
        const inside = entity === this.player && dist < 12;
        if (Math.random() < 0.8) this.muzzleFlash(_p2, _fwd, vel, 1, inside ? 0 : 1);
      }
    }
    this.plumes.end();
    this.rings.end();
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
    const place = (lat0, latK) => {
      randDir(_d);
      const ahead = rnd(0.1, 1) * reach;
      const lat = lat0 + latK * Math.random() ** 1.5;
      _d.addScaledVector(_fwd, -_d.dot(_fwd)).normalize();
      return _p2.set(cam.x + _fwd.x * ahead + _d.x * lat, cam.y + _fwd.y * ahead + _d.y * lat, cam.z + _fwd.z * ahead + _d.z * lat);
    };
    // Rain: grey translucent drops, alpha-blended (a drop against a bright
    // sky is darker than the sky; the additive streaks were glowing lines),
    // a short shutter (1/80 s) so speed gives dashes instead of warp-speed
    // lines, and a minimum on-screen width that spreads rather than adds
    // light (L.rain: minPixels keeps the coverage).
    if (rain >= 0.03) {
      const n = Math.floor(2200 * rain * v.cfg.rate * dt + Math.random());
      const k = sizeForRate(v.cfg.rate);
      for (let i = 0; i < n; i++) {
        const p = place(1.0, 14);
        const w = rnd(0.03, 0.055) * k;
        lit.spawn(L.rain, p.x, p.y, p.z, wind.x, -9, wind.z, rnd(0.4, 0.8), w, w, 0.72, 0.75, 0.8, Math.min(1, 2 * rain));
      }
    }
    if (snow >= 0.03) {
      const n = Math.floor(650 * snow * v.cfg.rate * dt + Math.random());
      for (let i = 0; i < n; i++) {
        const p = place(1.0, 14);
        glow.spawn(G.snow, p.x, p.y, p.z, wind.x, -1.5, wind.z, rnd(0.5, 1.0), rnd(0.035, 0.08), 0.035, 0.95, 0.97, 1, 1, 8 * lum * snow * rnd(0.5, 1.1));
      }
    }
    const amt = Math.max(rain, snow * 0.6);
    const m = Math.floor(5 * amt * v.cfg.rate * dt + Math.random());
    for (let i = 0; i < m; i++) {
      randDir(_d);
      const ahead = rnd(0.4, 1.2) * reach + 30;
      const x = cam.x + _fwd.x * ahead + _d.x * 60, y = cam.y + _fwd.y * ahead + _d.y * 40, z = cam.z + _fwd.z * ahead + _d.z * 60;
      lit.spawn(L.wisp, x, y, z, wind.x, -4, wind.z, rnd(0.6, 1.1), rnd(18, 30), rnd(26, 44), 0.8, 0.82, 0.86, 0.05 * amt);
    }
    // Curtains: the shafts of heavier rain a few hundred metres off that give
    // a storm its depth. Tall grey veils hanging under the cloud, falling and
    // drifting with the wind, born around the horizon.
    if (rain >= 0.25) {
      const c = Math.floor(3 * rain * v.cfg.rate * dt + Math.random());
      for (let i = 0; i < c; i++) {
        const a = rnd(Math.PI * 2), r = rnd(250, 1400);
        const x = cam.x + Math.cos(a) * r, z = cam.z + Math.sin(a) * r;
        const y = cam.y + rnd(-60, 120);
        lit.spawn(L.wisp, x, y, z, wind.x, -6, wind.z, rnd(5, 9), rnd(60, 90), rnd(110, 170), 0.5, 0.52, 0.56, 0.09 * rain, 0, -rnd(0.5));
      }
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
      if (i % 4 === 0) lit.spawn(L.wisp, x, y, z, 0, 0, 0, rnd(0.35, 0.6), rnd(7, 12), rnd(12, 20), 0.95, 0.96, 1, 0.2 * inCloud);
      else glow.spawn(G.streak, x, y, z, 0, 0, 0, rnd(0.25, 0.55), rnd(0.04, 0.1), 0.04, 0.85, 0.9, 1, 1, 7 * lum * inCloud);
    }
  }

  /** Make every pipeline this module draws exist before the first frame that needs it. */
  prewarm() {
    this.plumes.prewarm();
    this.rings.prewarm();
    this.cones.prewarm();
  }

  dispose() {
    this.plumes.dispose();
    this.rings.dispose();
    this.cones.dispose();
  }
}
