import * as THREE from 'three/webgpu';
import { terrainHeight, maxHeightAlong } from '../world/terrain/heightfield.js';
import {
  clamp, damp, dampFactor, springStep, chaseDistance, fovTarget, shakeAngles, easeInOut, smoothstep,
} from '../camera/cameraMath.js';
import { CINEMATICS, cinematicDuration } from '../camera/cinematics.js';

const WORLD_UP = new THREE.Vector3(0, 1, 0);
const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _f = new THREE.Vector3();
const _r = new THREE.Vector3();
const _u = new THREE.Vector3();
const _vd = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _e = new THREE.Euler();
const _m = new THREE.Matrix4();

/**
 * Fallback pilot eye in mig21.glb model space (nose -Z, metres) if an
 * airframe has no cockpit socket. The stock model has a full cockpit interior
 * (canopy glass top ~0.43 m at z -2.8, panel ~z -3.5), so first person uses the
 * exterior model itself; Aircraft.sockets.cockpit sits at the measured eye.
 */
export const MIG21_EYE = new THREE.Vector3(0, 0.22, -2.95);

/** Base views, cycled by the player. */
export const VIEWS = ['chase', 'cockpit', 'hud'];

/**
 * Camera rig.
 *
 * `mode` is the player's base view ('chase' | 'cockpit' | 'hud'); `view` is
 * what is on screen this frame, which may be a temporary override:
 *   'lock'      target-lock framing (held)
 *   'missile'   follow the player's missile (opt-in toggle)
 *   'kill'      short slow-motion kill cam (never in danger)
 *   'death'     detached wreck cam after a crash / shoot-down
 *   'cinematic' scripted path (playCinematic)
 * plus free look (orbit in chase, head turn in the cockpit) layered on top.
 *
 * Shake: `trauma` (0..1 impulse, squared, decays) + `rumble` (continuous,
 * set per frame by the camera system from G, guns, stall, fast+low).
 */
export class CameraRig {
  constructor(camera) {
    this.camera = camera;
    this.mode = 'chase';
    this.view = 'chase';
    this.position = new THREE.Vector3();
    this.quat = new THREE.Quaternion();
    this.trauma = 0;
    this.rumble = 0;
    this.baseFov = 62;
    this.cockpitFov = 74;
    this.eye = MIG21_EYE.clone();
    this.options = {
      shake: 1, // user scale 0..1
      reducedMotion: false,
      killCam: true,
      missileCam: false,
      fovEffects: 1,
    };
    /** free look input, radians; system writes targets, rig springs back when released */
    this.look = { yaw: 0, pitch: 0, targetYaw: 0, targetPitch: 0, active: false };
    this.lockHeld = false;
    this.game = null;
    this.cockpitModel = null;
    this.cut = false; // true on frames where the camera jumped (post suppresses blur)

    this._boomQuat = new THREE.Quaternion();
    this._offsetLocal = new THREE.Vector3(0, 3.4, 17);
    this._aim = new THREE.Vector3();
    this._prevVelDir = new THREE.Vector3(0, 0, -1);
    this._turn = new THREE.Vector3();
    this._gSpring = { x: 0, v: 0 };
    this._accSpring = { x: 0, v: 0 };
    this._prevSpeed = 0;
    this._fov = this.baseFov;
    this._kick = 0;
    this._t = 0;
    this._shake = { yaw: 0, pitch: 0, roll: 0 };
    this._blend = null; // { from: {pos, quat, fov}, t, dur }
    this._lastOut = { pos: new THREE.Vector3(), quat: new THREE.Quaternion(), fov: 62 };
    this._override = null; // { view, ... }
    this._cine = null;
    this._initialised = false;
  }

  /** Called by the camera system so overrides can read hud/events. */
  attach(game) { this.game = game; }

  reset(flight) {
    this._boomQuat.copy(flight.orientation);
    this._offsetLocal.set(0, 3.4, chaseDistance(flight.airspeed));
    _f.set(0, 0, -1).applyQuaternion(flight.orientation);
    this._prevVelDir.copy(flight.velocity.lengthSq() > 1 ? _vd.copy(flight.velocity).normalize() : _f);
    this._aim.copy(flight.position).addScaledVector(_f, 60);
    this._gSpring.x = this._gSpring.v = 0;
    this._accSpring.x = this._accSpring.v = 0;
    this._prevSpeed = flight.airspeed;
    this.trauma = 0;
    this.look.yaw = this.look.pitch = this.look.targetYaw = this.look.targetPitch = 0;
    if (this._override && this._override.view !== 'cinematic') this._endOverride(false);
    this._blend = null;
    this.cut = true;
    this._initialised = true;
  }

  addTrauma(t) { this.trauma = Math.min(1, this.trauma + Math.max(0, t)); }

  // ---------------------------------------------------------------- views

  setMode(mode) {
    if (!VIEWS.includes(mode) || mode === this.mode) return;
    this.mode = mode;
    this.cut = true; // first-person <-> chase is a hard cut, as in every console flyer
  }

  cycleMode() {
    this.setMode(VIEWS[(VIEWS.indexOf(this.mode) + 1) % VIEWS.length]);
    return this.mode;
  }

  /** Temporary override. kind: 'missile' | 'kill' | 'death' | 'cinematic'. */
  _beginOverride(o, blend = 0.35) {
    if (this._override?.view === 'kill' && o.view !== 'death') this._restoreTime();
    this._override = o;
    this._startBlend(blend);
  }

  _endOverride(blend = 0.3) {
    if (!this._override) return;
    if (this._override.view === 'kill') this._restoreTime();
    const res = this._override.resolve;
    this._override = null;
    if (blend) this._startBlend(blend); else this.cut = true;
    res?.();
  }

  _startBlend(dur) {
    if (!dur) { this.cut = true; this._blend = null; return; }
    this._blend = {
      from: { pos: this._lastOut.pos.clone(), quat: this._lastOut.quat.clone(), fov: this._lastOut.fov },
      t: 0, dur,
    };
  }

  _restoreTime() {
    const g = this.game;
    if (g && this._savedTimeScale != null) { g.timeScale = this._savedTimeScale; this._savedTimeScale = null; }
  }

  /** Follow a live missile entity until it ends (+ a beat to watch the hit). */
  followMissile(missile) {
    if (!missile || this._override?.view === 'death') return;
    this._beginOverride({ view: 'missile', missile, hold: 0, last: missile.position.clone() }, 0.25);
  }

  /** Slow-mo kill cam on a destroyed target; refused while in danger. */
  killCam(target, position) {
    if (!this.options.killCam || this.options.reducedMotion) return false;
    if (this._override && this._override.view !== 'missile') return false;
    const g = this.game;
    const flight = g?.flight;
    const p = (position ?? target?.position)?.clone?.();
    if (!p || !flight) return false;
    _v.copy(p).sub(flight.position);
    const a0 = Math.atan2(_v.x, -_v.z) + Math.PI * 0.7;
    this._savedTimeScale = g.timeScale ?? 1;
    this._beginOverride({ view: 'kill', target, center: p, t: 0, dur: 2.4, a0, radius: clamp(_v.length() * 0.12, 45, 110) }, 0);
    this.cut = true;
    return true;
  }

  /**
   * Detached wreck cam: hold near the last camera position and watch. With a
   * velocity (shot down in the air) the lens follows a dragged ballistic fall
   * of the wreck down to the terrain; without one (crash) it watches the impact.
   */
  deathCam(position, velocity = null) {
    const p = position?.clone?.() ?? this.camera.position.clone();
    const from = this.camera.position.clone();
    _v.copy(from).sub(p);
    if (_v.lengthSq() < 1) _v.set(0, 10, 30);
    const dist = clamp(_v.length() * 1.6, 45, 140);
    _v.normalize();
    const anchor = p.clone().addScaledVector(_v, dist);
    anchor.y = Math.max(anchor.y, terrainHeight(anchor.x, anchor.z) + 25, p.y + 18);
    this._beginOverride({
      view: 'death', origin: p.clone(), center: p, anchor, t: 0, a0: Math.atan2(_v.x, -_v.z),
      velocity: velocity?.clone?.() ?? null,
    }, 0.5);
  }

  /**
   * Play a named cinematic path (see camera/cinematics.js): 'orbit', 'title',
   * 'flyby', 'reveal'. Returns a promise resolved when it ends or is stopped.
   * opts: { focus: {position, orientation, velocity}, duration, ...path opts }
   */
  playCinematic(name, opts = {}) {
    const def = CINEMATICS[name];
    if (!def) return Promise.reject(new Error(`unknown cinematic "${name}"`));
    const focus = opts.focus ?? this.game?.flight;
    if (!focus) return Promise.reject(new Error('no focus for cinematic'));
    return new Promise((resolve) => {
      const ctx = { focus };
      const state = def.init(ctx, opts);
      const duration = opts.duration ?? cinematicDuration(def, state);
      this._beginOverride({
        view: 'cinematic', name, def, ctx, state, t: 0, duration, resolve,
        out: { position: new THREE.Vector3(), target: new THREE.Vector3(), fov: 50, roll: 0 },
      }, opts.blend ?? 0);
      this.game?.events?.emit('camera:cinematic', { name, state: 'start' });
    });
  }

  stopCinematic() {
    if (this._override?.view === 'cinematic') this._endOverride(0.6);
  }

  get lockTarget() {
    const h = this.game?.hud;
    const t = h?.lock?.target;
    if (t && t.alive !== false && t.position) return t;
    const l = h?.targets?.find?.((x) => x.locked && x.position);
    return l ?? null;
  }

  // ---------------------------------------------------------------- update

  update(dt, flight, aircraft) {
    if (!this._initialised) this.reset(flight);
    const g = this.game;
    // camera smoothing runs on real time even when the game is in slow motion
    const ts = g?.timeScale ?? 1;
    const rdt = ts > 1e-3 ? Math.min(dt / ts, 0.1) : dt;
    this._t += rdt;
    const cam = this.camera;
    this.cut = this.cut || false;

    // -- choose the view --------------------------------------------------
    let view = this._override?.view ?? this.mode;
    if (!this._override && this.lockHeld && this.lockTarget && !flight.crashed) view = 'lock';
    if (view !== this.view) {
      const prev = this.view;
      this.view = view;
      if (!this.cut && !this._override && (prev === 'lock' || view === 'lock')) this._startBlend(0.28);
      g?.events?.emit('camera:mode', { mode: view, base: this.mode });
    }

    // -- free look springs ------------------------------------------------
    const L = this.look;
    const lookLambda = L.active ? 14 : 5;
    L.yaw = damp(L.yaw, L.active ? L.targetYaw : 0, lookLambda, rdt);
    L.pitch = damp(L.pitch, L.active ? L.targetPitch : 0, lookLambda, rdt);

    // -- pose for the view ------------------------------------------------
    let fov;
    let near = 0.5;
    switch (view) {
      case 'cockpit':
      case 'hud':
        fov = this._firstPerson(rdt, flight, aircraft);
        near = view === 'cockpit' ? 0.05 : 0.3;
        break;
      case 'lock': fov = this._lockView(rdt, flight); break;
      case 'missile': fov = this._missileView(rdt, flight); break;
      case 'kill': fov = this._killView(rdt, flight); break;
      case 'death': fov = this._deathView(rdt); break;
      case 'cinematic': fov = this._cinematicView(rdt); break;
      default: fov = this._chase(rdt, flight); break;
    }
    // keep the chase state warm while an override is on screen, so returning is seamless
    if (view !== 'chase' && view !== 'cockpit' && view !== 'hud') this._chaseState(rdt, flight);

    // -- airframe visibility ---------------------------------------------
    if (aircraft?.model) {
      const firstPerson = view === 'cockpit' || view === 'hud';
      aircraft.model.visible = view !== 'hud';
      if (this.cockpitModel) this.cockpitModel.visible = view === 'cockpit';
    }

    // -- blend from the previous view --------------------------------------
    if (this._blend && !this.cut) {
      const b = this._blend;
      b.t += rdt;
      const k = easeInOut(b.t / b.dur);
      cam.position.lerpVectors(b.from.pos, cam.position, k);
      _q.copy(b.from.quat).slerp(cam.quaternion, k);
      cam.quaternion.copy(_q);
      fov = b.from.fov + (fov - b.from.fov) * k;
      if (b.t >= b.dur) this._blend = null;
    } else if (this.cut) {
      this._blend = null;
    }

    // -- shake ---------------------------------------------------------------
    const scale = this.options.shake * (this.options.reducedMotion ? 0.25 : 1) * (view === 'cinematic' ? 0 : 1);
    if (scale > 0 && (this.trauma > 0 || this.rumble > 0)) {
      const firstPerson = view === 'cockpit' || view === 'hud';
      shakeAngles(this._t, this.trauma, this.rumble * (firstPerson ? 1.4 : 1), scale, this._shake);
      _q.setFromEuler(_e.set(this._shake.pitch, this._shake.yaw, this._shake.roll));
      cam.quaternion.multiply(_q);
    }
    this.trauma = Math.max(0, this.trauma - rdt * 1.25);

    // -- lens ----------------------------------------------------------------
    this._fov = fov;
    if (cam.fov !== fov || cam.near !== near) {
      cam.fov = fov;
      cam.near = near;
      cam.updateProjectionMatrix();
    }
    cam.updateMatrixWorld();
    this.position.copy(cam.position);
    this.quat.copy(cam.quaternion);
    this._lastOut.pos.copy(cam.position);
    this._lastOut.quat.copy(cam.quaternion);
    this._lastOut.fov = fov;
  }

  /** Called by the system after post has consumed `cut`. */
  clearCut() { this.cut = false; }

  // ---------------------------------------------------------------- chase

  _chaseState(dt, flight) {
    // Boom basis: the airframe's attitude blended 78% toward a horizon-level
    // frame, then damped. Rolls read on screen (the camera lags into a bank)
    // without the horizon spinning with the jet.
    _f.set(0, 0, -1).applyQuaternion(flight.orientation);
    _u.set(0, 1, 0).applyQuaternion(flight.orientation);
    _m.lookAt(_v.set(0, 0, 0), _f, Math.abs(_f.y) > 0.98 ? _u : WORLD_UP);
    _q.setFromRotationMatrix(_m); // level frame looking along the nose
    _q2.copy(_q).slerp(flight.orientation, 0.78);
    this._boomQuat.slerp(_q2, dampFactor(6.5, dt));

    // velocity direction + how fast it is turning (look-ahead into turns)
    if (flight.velocity.lengthSq() > 1) _vd.copy(flight.velocity).normalize(); else _vd.copy(_f);
    _w.copy(_vd).sub(this._prevVelDir).divideScalar(Math.max(dt, 1e-3));
    this._turn.lerp(_w, dampFactor(5, dt));
    this._prevVelDir.copy(_vd);

    // G and longitudinal-acceleration springs: the "gut" layer. Under load
    // the camera sinks below the jet and overshoots slightly when it unloads;
    // lighting the burner throws it back, then it catches up.
    const gTarget = clamp((flight.gLoad - 1) * 0.22, -0.8, 1.9);
    springStep(this._gSpring, gTarget, 1.1, 0.55, dt);
    const accel = (flight.airspeed - this._prevSpeed) / Math.max(dt, 1e-3);
    this._prevSpeed = flight.airspeed;
    springStep(this._accSpring, clamp(accel * 0.09, -1.2, 2.6) + (flight.reheat ? 0.9 : 0), 0.9, 0.6, dt);
  }

  _chase(dt, flight) {
    const cam = this.camera;
    this._chaseState(dt, flight);
    _f.set(0, 0, -1).applyQuaternion(flight.orientation);

    // Target offset in the boom frame, sitting partly along the flight path so
    // a hard pull opens the frame and shows the manoeuvre.
    const dist = chaseDistance(flight.airspeed) + this._accSpring.x;
    const height = 3.3 - this._gSpring.x;
    _v.set(0, height, dist);
    // free look: orbit around the jet
    if (Math.abs(this.look.yaw) > 1e-4 || Math.abs(this.look.pitch) > 1e-4) {
      _e.set(-this.look.pitch * 0.9, -this.look.yaw, 0, 'YXZ');
      _v.applyEuler(_e);
    }
    _v.applyQuaternion(this._boomQuat);
    // bias toward trailing the velocity vector (AoA visible in a hard turn)
    _w.copy(_vd).multiplyScalar(-dist).sub(_r.copy(_f).multiplyScalar(-dist)).multiplyScalar(0.45);
    _v.add(_w);

    // Damp the offset in the aircraft's frame, never the world position:
    // damping a world position chasing 250 m/s leaves speed/lambda metres of lag.
    _q.copy(flight.orientation).invert();
    _v.applyQuaternion(_q);
    this._offsetLocal.lerp(_v, dampFactor(this.cut ? 1e6 : 10, dt));
    _v.copy(this._offsetLocal).applyQuaternion(flight.orientation);
    cam.position.copy(flight.position).add(_v);

    // terrain clearance along the boom, not just under the lens
    const ridge = Math.max(
      terrainHeight(cam.position.x, cam.position.z),
      maxHeightAlong(flight.position.x, flight.position.z, cam.position.x, cam.position.z, 6),
    ) + 5;
    if (cam.position.y < ridge) cam.position.y = ridge;

    // aim: ahead along the flight path, leading into the turn
    _w.copy(flight.position).addScaledVector(_vd, 70).addScaledVector(this._turn, clamp(28, 0, 40));
    if (this.cut) this._aim.copy(_w); else this._aim.lerp(_w, dampFactor(9, dt));
    if (Math.abs(this.look.yaw) > 0.02 || Math.abs(this.look.pitch) > 0.02) {
      const k = smoothstep(0.02, 0.6, Math.max(Math.abs(this.look.yaw), Math.abs(this.look.pitch)));
      _w.copy(this._aim).lerp(flight.position, k);
    } else _w.copy(this._aim);

    _u.set(0, 1, 0).applyQuaternion(this._boomQuat);
    cam.up.copy(_u);
    cam.lookAt(_w);

    const reheat = flight.reheat ? 1 : 0;
    this._kick = damp(this._kick, reheat, reheat > this._kick ? 6 : 1.4, dt);
    const fx = this.options.fovEffects * (this.options.reducedMotion ? 0.4 : 1);
    const target = this.baseFov + (fovTarget({ baseFov: 0, airspeed: flight.airspeed, reheat: this._kick, brake: flight.brake ?? 0 })) * fx;
    return this.cut ? target : damp(this._fov ?? target, target, 3, dt);
  }

  // ---------------------------------------------------------------- first person

  _firstPerson(dt, flight, aircraft) {
    const cam = this.camera;
    this._chaseState(dt, flight);
    // Eye: measured pilot eye (or the cockpit socket for other airframes).
    // The cockpit overlay's `eye` socket wins (useCockpitEye), then the
    // airframe's cockpit socket (the measured pilot eye), then the fallback.
    const eye = this.useCockpitEye ? this.eye : (aircraft?.sockets?.cockpit?.position ?? this.eye);
    _v.copy(eye);
    // head drops under +G, rises under -G; small fore-aft surge with thrust
    _v.y -= clamp(this._gSpring.x * 0.03, -0.03, 0.06);
    _v.z += clamp(this._accSpring.x * 0.012, -0.02, 0.04);
    _v.applyQuaternion(flight.orientation);
    cam.position.copy(flight.position).add(_v);

    // head: free look plus a small instinctive turn into the turn
    _w.copy(this._turn).applyQuaternion(_q.copy(flight.orientation).invert());
    const yaw = this.look.yaw * 1.6 + clamp(_w.x * 0.25, -0.12, 0.12);
    const pitch = this.look.pitch * 1.1 + clamp(_w.y * 0.15, -0.06, 0.1);
    _e.set(pitch, -yaw, 0, 'YXZ');
    _q.setFromEuler(_e);
    cam.quaternion.copy(flight.orientation).multiply(_q);
    cam.up.set(0, 1, 0).applyQuaternion(cam.quaternion);

    const fx = this.options.fovEffects * (this.options.reducedMotion ? 0.4 : 1);
    const target = this.cockpitFov + fovTarget({ baseFov: 0, airspeed: flight.airspeed, reheat: flight.reheat ? 1 : 0 }) * 0.5 * fx;
    return this.cut ? target : damp(this._fov ?? target, target, 3, dt);
  }

  // ---------------------------------------------------------------- overrides

  _lockView(dt, flight) {
    const cam = this.camera;
    const T = this.lockTarget?.position;
    if (!T) return this._chase(dt, flight);
    this._chaseState(dt, flight);
    // behind the jet on the target line, a touch high: the jet in the lower
    // foreground, the target framed over its spine
    _v.copy(T).sub(flight.position);
    const d = _v.length();
    _v.divideScalar(Math.max(d, 1));
    _u.set(0, 1, 0).applyQuaternion(this._boomQuat).lerp(WORLD_UP, 0.5).normalize();
    _w.copy(flight.position).addScaledVector(_v, -24).addScaledVector(_u, 4.5);
    const ground = terrainHeight(_w.x, _w.z) + 5;
    if (_w.y < ground) _w.y = ground;
    cam.position.copy(_w);
    // look between target and jet by angle, then open the lens until the jet fits
    _r.copy(T).sub(_w).normalize();
    _f.copy(flight.position).sub(_w).normalize();
    _vd.copy(_r).multiplyScalar(0.72).addScaledVector(_f, 0.28).normalize();
    cam.up.copy(_u);
    cam.lookAt(_w.add(_vd));
    const jetAngle = THREE.MathUtils.radToDeg(_vd.angleTo(_f));
    return clamp(Math.max(58 - Math.log10(Math.max(d, 10)) * 6, (jetAngle * 2) / 0.72), 34, 72);
  }

  _missileView(dt, flight) {
    const o = this._override;
    const m = o.missile;
    const cam = this.camera;
    if (m.alive !== false) {
      o.last.copy(m.position);
      if (m.velocity?.lengthSq?.() > 1) _vd.copy(m.velocity).normalize();
      else _vd.set(0, 0, -1).applyQuaternion(m.quaternion ?? _q.identity());
      _w.copy(m.position).addScaledVector(_vd, -9).addScaledVector(WORLD_UP, 1.6);
      if (!o.init) { o.pos = _w.clone(); o.init = true; }
      o.pos.lerp(_w, dampFactor(12, dt));
      cam.position.copy(o.pos);
      cam.up.copy(WORLD_UP);
      cam.lookAt(_r.copy(m.position).addScaledVector(_vd, 30));
    } else {
      o.hold += dt;
      cam.up.copy(WORLD_UP);
      cam.lookAt(o.last);
      if (o.hold > 1.3) this._endOverride(0.4);
    }
    return 56;
  }

  _killView(dt, flight) {
    const o = this._override;
    const g = this.game;
    o.t += dt;
    // slow motion: ease into 0.25x, hold, ease back out
    if (g) {
      const k = o.t < 0.15 ? o.t / 0.15 : o.t > o.dur - 0.5 ? (o.dur - o.t) / 0.5 : 1;
      g.timeScale = 1 + (0.25 - 1) * clamp(k, 0, 1);
    }
    const a = o.a0 + o.t * 0.35;
    const cam = this.camera;
    cam.position.set(Math.sin(a) * o.radius, o.radius * 0.28, -Math.cos(a) * o.radius).add(o.center);
    const ground = terrainHeight(cam.position.x, cam.position.z) + 8;
    if (cam.position.y < ground) cam.position.y = ground;
    cam.up.copy(WORLD_UP);
    const tp = o.target?.position ?? o.center;
    cam.lookAt(_w.copy(o.center).lerp(tp, 0.5));
    if (o.t >= o.dur || inDangerNow(g)) this._endOverride(0);
    return 44;
  }

  _deathView(dt) {
    const o = this._override;
    o.t += dt;
    const cam = this.camera;
    if (o.velocity) {
      // dragged ballistic fall (k = 0.6/s), stopped by the terrain
      const k = 0.6;
      const tau = (1 - Math.exp(-k * o.t)) / k;
      o.center.copy(o.origin).addScaledVector(o.velocity, tau);
      o.center.y -= 4.9 * o.t * o.t;
      const gh = terrainHeight(o.center.x, o.center.z);
      if (o.center.y < gh) { o.center.y = gh; o.velocity = null; }
    }
    const a = o.a0 + o.t * 0.12;
    o.r0 ??= Math.hypot(o.anchor.x - o.origin.x, o.anchor.z - o.origin.z);
    const r = o.r0 * (1 + o.t * 0.05);
    cam.position.set(Math.sin(a) * r, 0, -Math.cos(a) * r).add(o.center);
    cam.position.y = Math.max(o.center.y + (o.anchor.y - o.origin.y) + o.t * 2, terrainHeight(cam.position.x, cam.position.z) + 20);
    cam.up.copy(WORLD_UP);
    cam.lookAt(o.center);
    return clamp(50 - o.t * 2, 34, 50);
  }

  _cinematicView(dt) {
    const o = this._override;
    o.t += dt;
    o.def.pose(o.t, o.state, o.ctx, o.out);
    const cam = this.camera;
    cam.position.copy(o.out.position);
    const ground = terrainHeight(cam.position.x, cam.position.z) + 4;
    if (cam.position.y < ground) cam.position.y = ground;
    cam.up.copy(WORLD_UP);
    cam.lookAt(o.out.target);
    if (o.out.roll) cam.rotateZ(o.out.roll);
    if (o.t >= o.duration) {
      this.game?.events?.emit('camera:cinematic', { name: o.name, state: 'end' });
      this._endOverride(0.6);
    }
    return o.out.fov;
  }
}

function inDangerNow(g) {
  if (!g) return false;
  const h = g.hud ?? {};
  return (h.threats?.length ?? 0) > 0 || h.warning === 'missile' || g.flight?.crashed;
}
