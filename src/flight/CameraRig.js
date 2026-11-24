import * as THREE from 'three/webgpu';
import { terrainHeight, maxHeightAlong } from '../world/terrain/heightfield.js';
import {
  clamp, damp, dampFactor, springStep, chaseDistance, fovTarget, shakeAngles, easeInOut, smoothstep,
  chaseLagFreq, noise1,
} from '../camera/cameraMath.js';
import { CINEMATICS, cinematicDuration } from '../camera/cinematics.js';
import { TimeWarp } from '../camera/timeWarp.js';
import { KILL, AIR_ANGLES } from '../camera/killCam.js';
import { lockView, missileView, deathView, actionView, inDangerNow, springVec, newSpring } from '../camera/views.js';
import { killView, projectileState, toImpact, shotState } from '../camera/killSequence.js';

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

/** Views where the lens rides with the player's jet. */
export const RIDING = new Set(['chase', 'cockpit', 'hud', 'lock', 'action']);

/**
 * Camera rig.
 *
 * `mode` is the player's base view ('chase' | 'cockpit' | 'hud'); `view` is
 * what is on screen this frame, which may be a temporary override:
 *   'lock'      target-lock framing (held)
 *   'action'    optional cinematic dogfight angles (options.actionCam, chase only)
 *   'missile'   follow the player's missile (opt-in toggle)
 *   'kill'      kill cam (camera/killSequence.js): a slow-motion ride on the
 *               killing projectile for special kills, or a fast close shot of
 *               the stricken target; never in danger, skippable
 *   'death'     detached wreck cam after a crash / shoot-down
 *   'cinematic' scripted path (playCinematic)
 * plus free look (orbit in chase, head turn in the cockpit) layered on top.
 *
 * Feel layers: speed-tuned lag spring on the chase boom, G and thrust springs
 * (the camera sinks under load, is thrown back by the burner), afterburner
 * light-off and Mach-crossing FOV pulses, cockpit head bob / G-pull / roll lag,
 * shake = `trauma` (0..1 impulse, squared, decays) + `rumble` (continuous,
 * set per frame by the camera system from G, guns, stall, fast+low).
 *
 * `dofOut` ({amount, focus, focal, bokeh} | null) is written every frame for
 * the post chain's depth of field (cinematic, kill, death, missile views).
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
      fovEffects: 1, // speed / burner / Mach FOV changes, 0..1
      actionCam: false, // cinematic dogfight angles in the chase view
      slowMo: true, // brief time dilation on kill / missile impact / death
      sortieIntro: true, // briefing -> sortie transition shot
      headBob: 1, // cockpit head motion (G-pull, roll lag, buffet), 0..1
      cameraLag: 1, // chase boom lag, 0.4 (stiff) .. 1.5 (loose)
      dof: true, // depth of field in cinematic / kill cams
    };
    /** free look input, radians; system writes targets, rig springs back when released */
    this.look = { yaw: 0, pitch: 0, targetYaw: 0, targetPitch: 0, active: false };
    this.lockHeld = false;
    /** Enemy the action camera frames (set by the camera system), or null. */
    this.actionTarget = null;
    this.game = null;
    this.cockpitModel = null;
    this.cut = false; // true on frames where the camera jumped (post suppresses blur)
    this.dofOut = null;
    this.warp = new TimeWarp(null);

    this._boomQuat = new THREE.Quaternion();
    this._offsetLocal = new THREE.Vector3(0, 3.4, 17);
    this._offSpring = newSpring();
    this._aim = new THREE.Vector3();
    this._prevVelDir = new THREE.Vector3(0, 0, -1);
    this._turn = new THREE.Vector3();
    this._gSpring = { x: 0, v: 0 };
    this._accSpring = { x: 0, v: 0 };
    this._fovPulse = { x: 0, v: 0 };
    this._head = { pitch: { x: 0, v: 0 }, roll: { x: 0, v: 0 } };
    this._prevRoll = 0;
    this._prevSpeed = 0;
    this._prevReheat = false;
    this._fov = this.baseFov;
    this._kick = 0;
    this._t = 0;
    this._shake = { yaw: 0, pitch: 0, roll: 0 };
    this._blend = null; // { from: {pos, quat, fov}, t, dur }
    this._lastOut = { pos: new THREE.Vector3(), quat: new THREE.Quaternion(), fov: 62 };
    this._override = null; // { view, ... }
    this._lastKill = -1e9;
    this._killEnd = -1e9;
    this._swoop = null; // chase arrival offset after a kill cam cuts back
    this._initialised = false;
  }

  /** Called by the camera system so overrides can read hud/events. */
  attach(game) { this.game = game; this.warp.game = game; }

  reset(flight) {
    this._boomQuat.copy(flight.orientation);
    this._offsetLocal.set(0, 3.4, chaseDistance(flight.airspeed));
    this._offSpring.init = false;
    _f.set(0, 0, -1).applyQuaternion(flight.orientation);
    this._prevVelDir.copy(flight.velocity.lengthSq() > 1 ? _vd.copy(flight.velocity).normalize() : _f);
    this._aim.copy(flight.position).addScaledVector(_f, 60);
    this._gSpring.x = this._gSpring.v = 0;
    this._accSpring.x = this._accSpring.v = 0;
    this._fovPulse.x = this._fovPulse.v = 0;
    this._prevSpeed = flight.airspeed;
    this._prevReheat = !!flight.reheat;
    this.trauma = 0;
    this.look.yaw = this.look.pitch = this.look.targetYaw = this.look.targetPitch = 0;
    // (listeners holding a kill-cam effect, such as an audio low-pass, hear it end)
    if (this._override?.view === 'kill') this.game?.events?.emit('camera:killcam', { phase: 'end', shot: this._override.shot, reason: 'reset' });
    if (this._override && this._override.view !== 'cinematic') this._endOverride(false);
    this.warp.cancel();
    this._blend = null;
    this.cut = true;
    this._initialised = true;
  }

  addTrauma(t) { this.trauma = Math.min(1, this.trauma + Math.max(0, t)); }

  /** A quick FOV punch (degrees of initial velocity; + widens). */
  fovPulse(amount) {
    const k = this.options.fovEffects * (this.options.reducedMotion ? 0.3 : 1);
    this._fovPulse.v += amount * k;
  }

  /** Sonic boom crossing: a thump in the lens (FOV squeeze, shake). */
  sonicThump(direction = 1) {
    this.addTrauma(direction > 0 ? 0.32 : 0.18);
    this.fovPulse(direction > 0 ? -38 : 22);
  }

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
    if (this._override?.view === 'kill' || this._override?.view === 'missile') this.warp.cancel();
    this._override = o;
    this._startBlend(blend);
  }

  _endOverride(blend = 0.3, vel = null) {
    if (!this._override) return;
    const v = this._override.view;
    if (v === 'missile') this.warp.cancel();
    else if (v === 'kill') this.warp.release(0.2);
    const res = this._override.resolve;
    this._override = null;
    if (blend) this._startBlend(blend, vel);
    else {
      // an override that ends while it poses has already drawn this frame:
      // the jump to the next view happens next frame, so cut then as well
      this.cut = true;
      this._cutNext = true;
    }
    res?.();
  }

  /** Blend from the last pose; `vel` (m/s, optional) keeps the old lens moving: a hand-back with momentum. */
  _startBlend(dur, vel = null) {
    if (!dur) { this.cut = true; this._blend = null; return; }
    this._blend = {
      from: {
        pos: this._lastOut.pos.clone(), quat: this._lastOut.quat.clone(), fov: this._lastOut.fov, shift: this._lastOut.shift ?? 0,
        // with momentum, the old lens is carried in the jet's frame (offset
        // from it) and keeps drifting at `vel` relative to it, easing off
        vel: vel?.clone?.() ?? null,
        rel: vel && this.game?.flight ? this._lastOut.pos.clone().sub(this.game.flight.position) : null,
      },
      t: 0, dur,
    };
  }

  /** Legacy name (kept): put normal time back. */
  _restoreTime() { this.warp.cancel(); }

  /** Follow a live missile entity until it ends (+ a beat to watch the hit). */
  followMissile(missile) {
    if (!missile || this._override?.view === 'death' || this._override?.view === 'cinematic') return;
    this._beginOverride({ view: 'missile', missile, hold: 0, last: missile.position.clone() }, 0.25);
  }

  /** Called by the camera system on `missile:end` for the followed missile. */
  missileEnded(missile, reason) {
    const o = this._override;
    if (o?.view === 'missile' && o.missile === missile) o.reason = reason;
  }

  /**
   * Kill cam on a destroyed target (camera/killSequence.js).
   *
   * opts.shot: 'air' | 'ground' | 'brief' (the camera system picks it with
   * killCam.killShot); without it the rig picks from the target's class.
   * opts.angle (air: an AIR_ANGLES entry), opts.side (+1 / -1), opts.proxy
   * (the stricken airframe, camera/wreckProxy.js). When the projectile cam
   * is riding the shot that killed `target`, this is its impact instead.
   * Refused while the kill cam is off, while another override (other than
   * the missile cam) is on screen, and within the cooldown.
   */
  killCam(target, position, opts = {}) {
    const o = this._override;
    if (o?.view === 'kill' && o.phase === 'projectile') {
      if (o.target !== target) return false;
      toImpact(this, o, position, opts.proxy);
      return true;
    }
    if (!this.options.killCam) return false;
    if (o && o.view !== 'missile') return false;
    const flight = this.game?.flight;
    const p = (position ?? target?.position)?.clone?.();
    if (!p || !flight) return false;
    if (this._t - this._killEnd < KILL.cooldown) return false;
    const air = target ? target.class === 'air' : false;
    let shot = opts.shot;
    if (!shot) {
      if (p.distanceTo(flight.position) > 6000) return false;
      shot = this.options.reducedMotion ? 'brief' : air ? 'air' : 'ground';
    }
    const side = opts.side ?? (Math.random() < 0.5 ? -1 : 1);
    const angle = opts.angle ?? AIR_ANGLES[Math.floor(Math.random() * AIR_ANGLES.length)];
    this._lastKill = this._t;
    this._beginOverride(shotState(this, { shot, target, position: p, angle, side, proxy: opts.proxy }), 0);
    this.cut = true;
    this.game?.events?.emit('camera:killcam', { phase: 'start', shot, angle: shot === 'air' ? angle : undefined, target, position: p.clone() });
    return true;
  }

  /**
   * Ride `projectile` (a live missile / rocket entity) in slow motion until
   * it hits `target`; the kill then arrives through killCam(). The camera
   * system decides when a shot qualifies (killCam.js wantsProjectileCam).
   */
  projectileCam(projectile, target, { side } = {}) {
    if (!this.options.killCam || !projectile || !target) return false;
    const o = this._override;
    if (o && o.view !== 'missile') return false;
    const s = side ?? (Math.random() < 0.5 ? -1 : 1);
    const following = o?.view === 'missile' && o.missile === projectile;
    this._lastKill = this._t;
    this._beginOverride(projectileState(this, projectile, target, s), following ? 0.25 : 0);
    if (!following) this.cut = true;
    this.game?.events?.emit('camera:killcam', { phase: 'start', shot: 'projectile', target, position: projectile.position.clone() });
    return true;
  }

  /** The kill cam's phase on screen ('projectile' | 'impact' | 'shot'), or null. */
  get killPhase() { return this._override?.view === 'kill' ? this._override.phase : null; }

  /** Real seconds since the last kill cam ended. */
  get killSince() { return this._t - this._killEnd; }

  /**
   * End the kill cam. reason: 'done' (it ran its course: hand back with
   * momentum), 'skip' (player input), 'danger', 'miss' (the projectile did
   * not kill). Time comes back quickly in every case.
   */
  endKill(reason = 'done') {
    const o = this._override;
    if (o?.view !== 'kill') return;
    this._killEnd = this._t;
    const P = this.game?.flight?.position;
    // a blend across more than a few hundred metres whips the lens across the
    // terrain; beyond that the hand-back is a cut with the chase boom swooping in
    const far = !P || this._lastOut.pos.distanceTo(P) > 260;
    // the lens's own drift relative to the jet (the fly-away), for the hand-back
    const vel = o.vel && P ? o.vel.clone().sub(this.game.flight.velocity ?? _v.set(0, 0, 0)) : null;
    if (vel && vel.lengthSq() > 150 * 150) vel.setLength(150);
    this.game?.events?.emit('camera:killcam', { phase: 'end', shot: o.shot, reason });
    if (reason === 'done' && o.shot === 'brief') {
      this._endOverride(0); // reduced motion: a plain cut
    } else if (reason === 'skip' || reason === 'danger') {
      if (reason === 'danger') this.warp.cancel(); // a skip eases back over 0.2 s
      this._endOverride(far ? 0 : 0.25);
    } else if (!far) {
      this._endOverride(0.55, vel);
    } else {
      // too far to fly across: cut, and let the chase boom swoop in
      this._endOverride(0);
      if (!this.options.reducedMotion && this.mode === 'chase') this._swoop = new THREE.Vector3(2.5, 5, 22);
    }
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
    if (this.options.slowMo && !this.options.reducedMotion) this.warp.start({ scale: 0.35, ease: 0.1, hold: 0.9, end: 1.7 });
  }

  /**
   * Play a named cinematic path (see camera/cinematics.js): 'orbit', 'title',
   * 'flyby', 'reveal', 'sortie', 'mount', 'director'. Returns a promise resolved when it ends or is
   * stopped. opts: { focus: {position, orientation, velocity}, duration,
   * blend (in), blendOut, ...path opts }
   */
  playCinematic(name, opts = {}) {
    const def = CINEMATICS[name];
    if (!def) return Promise.reject(new Error(`unknown cinematic "${name}"`));
    const focus = opts.focus ?? this.game?.flight;
    if (!focus) return Promise.reject(new Error('no focus for cinematic'));
    return new Promise((resolve) => {
      if (this._override?.view === 'cinematic') this._endOverride(0);
      const ctx = { focus };
      const state = def.init(ctx, opts);
      const duration = opts.duration ?? cinematicDuration(def, state);
      this._beginOverride({
        view: 'cinematic', name, def, ctx, state, t: 0, duration, resolve, blendOut: opts.blendOut ?? 0.6,
        out: { position: new THREE.Vector3(), target: new THREE.Vector3(), fov: 50, roll: 0, shift: 0, cut: false, dof: null },
      }, opts.blend ?? 0);
      this.game?.events?.emit('camera:cinematic', { name, state: 'start' });
    });
  }

  /** Stop the running cinematic (optionally only if it is `name`). */
  stopCinematic(name) {
    const o = this._override;
    if (o?.view !== 'cinematic' || (name && o.name !== name)) return;
    this.game?.events?.emit('camera:cinematic', { name: o.name, state: 'end' });
    this._endOverride(o.blendOut ?? 0.6);
  }

  get cinematicName() { return this._override?.view === 'cinematic' ? this._override.name : null; }

  get lockTarget() {
    if (this.devLockTarget?.alive !== false && this.devLockTarget?.position) return this.devLockTarget;
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
    this.warp.update(rdt);
    const cam = this.camera;
    this.cut = this.cut || !!this._cutNext;
    this._cutNext = false;
    this.dofOut = null;

    // -- choose the view --------------------------------------------------
    let view = this._override?.view ?? this.mode;
    if (!this._override && !flight.crashed) {
      if (this.lockHeld && this.lockTarget) view = 'lock';
      else if (this.mode === 'chase' && this.options.actionCam && this.actionTarget && !inDangerNow(g)) view = 'action';
    }
    if (view !== this.view) {
      const prev = this.view;
      this.view = view;
      if (view === 'lock') this._lockFresh = true;
      if (view === 'action') this._actionFresh = true;
      if (!this.cut && !this._override && (prev === 'lock' || view === 'lock' || prev === 'action' || view === 'action')) this._startBlend(view === 'action' || prev === 'action' ? 0.8 : 0.3);
      g?.events?.emit('camera:mode', { mode: view, base: this.mode });
    }

    // -- free look springs ------------------------------------------------
    const L = this.look;
    const lookLambda = L.active ? 14 : 5;
    L.yaw = damp(L.yaw, L.active ? L.targetYaw : 0, lookLambda, rdt);
    L.pitch = damp(L.pitch, L.active ? L.targetPitch : 0, lookLambda, rdt);

    // -- feel springs shared by the views -----------------------------------
    // afterburner light-off: a quick FOV punch on top of the sustained kick
    if (flight.reheat && !this._prevReheat) { this.fovPulse(30); this.addTrauma(0.08); }
    this._prevReheat = !!flight.reheat;
    springStep(this._fovPulse, 0, 2.4, 0.45, rdt);

    // -- pose for the view ------------------------------------------------
    let fov;
    let near = 0.5;
    let shift = 0;
    switch (view) {
      case 'cockpit':
      case 'hud':
        fov = this._firstPerson(rdt, flight, aircraft);
        near = view === 'cockpit' ? 0.05 : 0.3;
        break;
      case 'lock': fov = lockView(this, rdt, flight) ?? this._chase(rdt, flight); break;
      case 'action': fov = actionView(this, rdt, flight) ?? this._chase(rdt, flight); break;
      case 'missile': fov = missileView(this, rdt, flight); break;
      case 'kill': fov = killView(this, rdt); break;
      case 'death': fov = deathView(this, rdt); break;
      case 'cinematic': ({ fov, shift } = this._cinematicView(rdt)); break;
      default: fov = this._chase(rdt, flight); break;
    }
    // keep the chase state warm while an override is on screen, so returning is seamless
    if (view !== 'chase' && view !== 'cockpit' && view !== 'hud' && view !== 'lock' && view !== 'action') this._chaseState(rdt, flight);
    if (RIDING.has(view)) fov += this._fovPulse.x;

    // -- airframe visibility ---------------------------------------------
    if (aircraft?.model) {
      aircraft.model.visible = view !== 'hud';
      if (this.cockpitModel) this.cockpitModel.visible = view === 'cockpit';
    }

    // -- blend from the previous view --------------------------------------
    if (this._blend && !this.cut) {
      const b = this._blend;
      b.t += rdt;
      if (b.from.vel) {
        if (b.from.rel) {
          b.from.rel.addScaledVector(b.from.vel, rdt);
          b.from.pos.copy(flight.position).add(b.from.rel);
        } else b.from.pos.addScaledVector(b.from.vel, rdt);
        b.from.vel.multiplyScalar(Math.exp(-2.5 * rdt));
      }
      const k = easeInOut(b.t / b.dur);
      cam.position.lerpVectors(b.from.pos, cam.position, k);
      if (RIDING.has(view) && flight) {
        // returning to the jet: the in-between camera keeps looking at it
        // (a plain slerp between two far-apart poses swings it off frame)
        _m.lookAt(cam.position, flight.position, _u.set(0, 1, 0));
        _q2.setFromRotationMatrix(_m);
        if (k < 0.5) _q.copy(b.from.quat).slerp(_q2, easeInOut(k * 2));
        else _q.copy(_q2).slerp(cam.quaternion, easeInOut(k * 2 - 1));
      } else {
        _q.copy(b.from.quat).slerp(cam.quaternion, k);
      }
      cam.quaternion.copy(_q);
      fov = b.from.fov + (fov - b.from.fov) * k;
      shift = (b.from.shift ?? 0) + (shift - (b.from.shift ?? 0)) * k;
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
    if (!this.options.dof) this.dofOut = null;
    this._fov = fov;
    // three.js slides the frustum's left edge by near*filmOffset/filmWidth, so a
    // positive filmOffset moves the subject *left*. Convert "fraction of frame
    // width, > 0 = subject right of centre" into that unit (fov dependent).
    const frameW = 2 * cam.aspect * Math.tan(THREE.MathUtils.degToRad(fov) * 0.5);
    const filmOffset = shift ? -shift * frameW * cam.getFilmWidth() : 0;
    if (cam.fov !== fov || cam.near !== near || cam.filmOffset !== filmOffset) {
      cam.fov = fov;
      cam.near = near;
      cam.filmOffset = filmOffset;
      cam.updateProjectionMatrix();
    }
    cam.updateMatrixWorld();
    this.position.copy(cam.position);
    this.quat.copy(cam.quaternion);
    this._lastOut.pos.copy(cam.position);
    this._lastOut.quat.copy(cam.quaternion);
    this._lastOut.fov = fov;
    this._lastOut.shift = shift;
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

    // Spring the offset in the aircraft's frame, never the world position:
    // damping a world position chasing 250 m/s leaves speed/lambda metres of
    // lag. The spring loosens with speed (camera lag tuned per speed) and
    // overshoots a touch, so pulls and burner kicks drag the lens along.
    _q.copy(flight.orientation).invert();
    _v.applyQuaternion(_q);
    if (this.cut) this._offSpring.init = false;
    const freq = chaseLagFreq(flight.airspeed, this.options.reducedMotion ? 0.5 : this.options.cameraLag);
    springVec(this._offSpring, _v, freq, 0.82, dt);
    if (this._swoop) {
      // back from a kill cam on a cut: the boom starts long and high and
      // springs in, so the chase view arrives with momentum
      this._offSpring.x.add(this._swoop);
      this._offSpring.v.set(0, 0, 0);
      this._swoop = null;
    }
    this._offsetLocal.copy(this._offSpring.x);
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
    const hb = this.options.headBob * (this.options.reducedMotion ? 0.3 : 1);
    // Eye: measured pilot eye (or the cockpit socket for other airframes).
    // The cockpit overlay's `eye` socket wins (useCockpitEye), then the
    // airframe's cockpit socket (the measured pilot eye), then the fallback.
    const eye = this.useCockpitEye ? this.eye : (aircraft?.sockets?.cockpit?.position ?? this.eye);
    _v.copy(eye);
    // head drops under +G, rises under -G; small fore-aft surge with thrust;
    // a fast vertical buffet when the airframe rumbles (fast and low, guns)
    _v.y -= clamp(this._gSpring.x * 0.03, -0.03, 0.06) * hb;
    _v.z += clamp(this._accSpring.x * 0.012, -0.02, 0.04) * hb;
    _v.y += noise1(this._t * 31, 7) * 0.0045 * this.rumble * hb;
    _v.applyQuaternion(flight.orientation);
    cam.position.copy(flight.position).add(_v);

    // head: free look, a small instinctive turn into the turn, the head
    // pulled down by G (the helmet is heavy at 7 G) and lagging the roll
    _w.copy(this._turn).applyQuaternion(_q.copy(flight.orientation).invert());
    const rollRate = flight.rates?.z ?? 0;
    const rollAcc = (rollRate - this._prevRoll) / Math.max(dt, 1e-3);
    this._prevRoll = rollRate;
    springStep(this._head.pitch, -clamp((flight.gLoad - 1) * 0.0075, -0.03, 0.06) * hb, 1.6, 0.7, dt);
    springStep(this._head.roll, clamp(-rollRate * 0.035 - rollAcc * 0.004, -0.09, 0.09) * hb, 2.2, 0.55, dt);
    const yaw = this.look.yaw * 1.6 + clamp(_w.x * 0.25, -0.12, 0.12);
    const pitch = this.look.pitch * 1.1 + clamp(_w.y * 0.15, -0.06, 0.1) + this._head.pitch.x;
    _e.set(pitch, -yaw, this._head.roll.x, 'YXZ');
    _q.setFromEuler(_e);
    cam.quaternion.copy(flight.orientation).multiply(_q);
    cam.up.set(0, 1, 0).applyQuaternion(cam.quaternion);

    const fx = this.options.fovEffects * (this.options.reducedMotion ? 0.4 : 1);
    const target = this.cockpitFov + fovTarget({ baseFov: 0, airspeed: flight.airspeed, reheat: flight.reheat ? 1 : 0 }) * 0.5 * fx;
    return this.cut ? target : damp(this._fov ?? target, target, 3, dt);
  }

  // ---------------------------------------------------------------- cinematic

  _cinematicView(dt) {
    const o = this._override;
    o.t += dt;
    o.out.up = null; // a path may set it (airframe-mounted shots roll with the jet)
    o.def.pose(o.t, o.state, o.ctx, o.out);
    if (o.out.cut) this.cut = true;
    const cam = this.camera;
    cam.position.copy(o.out.position);
    const ground = terrainHeight(cam.position.x, cam.position.z) + 4;
    if (cam.position.y < ground) cam.position.y = ground;
    cam.up.copy(o.out.up ?? WORLD_UP);
    cam.lookAt(o.out.target);
    if (o.out.roll) cam.rotateZ(o.out.roll);
    if (o.out.dof) this.dofOut = { ...o.out.dof };
    const res = { fov: o.out.fov, shift: o.out.shift ?? 0 };
    if (o.t >= o.duration) {
      this.game?.events?.emit('camera:cinematic', { name: o.name, state: 'end' });
      this._endOverride(o.blendOut ?? 0.6);
    }
    return res;
  }
}

/** Kept for importers of the old helper. */
export { inDangerNow };
