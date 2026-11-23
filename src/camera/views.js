import * as THREE from 'three/webgpu';
import { terrainHeight } from '../world/terrain/heightfield.js';
import { clamp, damp, dampFactor, springStep, smoothstep, actionShot } from './cameraMath.js';

/**
 * Override and alternate views for CameraRig (src/flight/CameraRig.js):
 * lock-on, missile follow, kill cam, death cam, and the optional action
 * ("cinematic") camera for dogfights. Each `xxxView(rig, dt, flight)` poses
 * `rig.camera` and returns the field of view; `rig.dofOut` may be filled for
 * the post chain's depth of field.
 *
 * Shared rules: positions are sprung *relative to their subject* (damping a
 * world position that moves at 300 m/s leaves speed/lambda metres of lag);
 * the up vector leans to world-up so the horizon stays readable; nothing goes
 * under the terrain.
 */
const WORLD_UP = new THREE.Vector3(0, 1, 0);
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _d = new THREE.Vector3();
const _up = new THREE.Vector3();
const _side = new THREE.Vector3();

/** Vector spring (component-wise springStep); state = { x: Vector3, v: Vector3, init }. */
export function springVec(state, target, freq, zeta, dt) {
  if (!state.init) { state.x.copy(target); state.v.set(0, 0, 0); state.init = true; return state.x; }
  const sx = { x: state.x.x, v: state.v.x }, sy = { x: state.x.y, v: state.v.y }, sz = { x: state.x.z, v: state.v.z };
  springStep(sx, target.x, freq, zeta, dt);
  springStep(sy, target.y, freq, zeta, dt);
  springStep(sz, target.z, freq, zeta, dt);
  state.x.set(sx.x, sy.x, sz.x);
  state.v.set(sx.v, sy.v, sz.v);
  return state.x;
}

export const newSpring = () => ({ x: new THREE.Vector3(), v: new THREE.Vector3(), init: false });

const clearGround = (p, margin) => {
  const g = terrainHeight(p.x, p.z) + margin;
  if (p.y < g) p.y = g;
  return p;
};

/** FOV (deg) that keeps two directions from the lens comfortably in frame. */
function fitFov(dirA, dirB, minFov, maxFov, aspect = 16 / 9) {
  const ang = THREE.MathUtils.radToDeg(dirA.angleTo(dirB));
  // the wider of the two must fit vertically in a 16:9 frame with margin
  return clamp(ang * 1.35 * Math.max(1, 1.6 / aspect) + 10, minFov, maxFov);
}

// ---------------------------------------------------------------- lock

export function lockView(rig, dt, flight) {
  const cam = rig.camera;
  const T = rig.lockTarget?.position;
  if (!T) return null;
  rig._chaseState(dt, flight);
  const s = rig._lock ??= { off: newSpring(), aim: new THREE.Vector3(), up: new THREE.Vector3(0, 1, 0), fov: 50, fresh: true };
  if (rig._lockFresh) { s.off.init = false; s.fresh = true; rig._lockFresh = false; }
  const P = flight.position;
  _a.copy(T).sub(P);
  const dist = _a.length();
  _a.divideScalar(Math.max(dist, 1));
  // up: the boom's up leaned 65% to the world so a rolling jet does not spin the shot
  _up.set(0, 1, 0).applyQuaternion(rig._boomQuat).lerp(WORLD_UP, 0.65).normalize();
  // behind the jet on the target line, raised and a touch to the side; the
  // closer the target, the further back (both stay in frame)
  const back = 20 + 10 * (1 - smoothstep(300, 2500, dist));
  _side.crossVectors(_a, _up).normalize();
  _b.copy(_a).multiplyScalar(-back).addScaledVector(_up, 5.2).addScaledVector(_side, 2.2);
  const off = springVec(s.off, _b, 2.6, 0.9, dt);
  cam.position.copy(P).add(off);
  clearGround(cam.position, 5);
  // aim: mostly at the target, pulled toward the jet so it sits low in frame
  _c.copy(T).sub(cam.position).normalize();
  _d.copy(P).sub(cam.position).normalize();
  const aimDir = _b.copy(_c).multiplyScalar(0.7).addScaledVector(_d, 0.3).normalize();
  if (s.fresh) { s.aim.copy(aimDir); s.up.copy(_up); }
  else { s.aim.lerp(aimDir, dampFactor(7, dt)).normalize(); s.up.lerp(_up, dampFactor(4, dt)).normalize(); }
  cam.up.copy(s.up);
  cam.lookAt(_a.copy(cam.position).add(s.aim));
  const want = fitFov(_c, _d, 30, 70, cam.aspect);
  s.fov = s.fresh ? want : damp(s.fov, want, 3.5, dt);
  s.fresh = false;
  return s.fov;
}

// ---------------------------------------------------------------- missile

export function missileView(rig, dt) {
  const o = rig._override;
  const m = o.missile;
  const cam = rig.camera;
  const g = rig.game;
  o.spring ??= newSpring();
  if (m.alive !== false && !o.ended) {
    o.last.copy(m.position);
    if (m.velocity?.lengthSq?.() > 1) _a.copy(m.velocity).normalize();
    else _a.set(0, 0, -1).applyQuaternion(m.quaternion ?? new THREE.Quaternion());
    o.dir ??= _a.clone();
    o.dir.lerp(_a, dampFactor(6, dt)).normalize();
    _side.crossVectors(o.dir, WORLD_UP).normalize();
    _b.copy(o.dir).multiplyScalar(-10).addScaledVector(WORLD_UP, 1.7).addScaledVector(_side, 1.1);
    const off = springVec(o.spring, _b, 3.5, 0.85, dt);
    cam.position.copy(m.position).add(off);
    clearGround(cam.position, 3);
    // frame the target ahead when there is one
    const tp = m.target?.position;
    _c.copy(m.position).addScaledVector(o.dir, 60);
    let fov = 56;
    if (tp && m.target.alive !== false) {
      const dt2 = tp.distanceTo(m.position);
      _c.lerp(tp, 0.55 * smoothstep(4000, 600, dt2));
      fov = 56 - 16 * smoothstep(1500, 150, dt2);
      rig.dofOut = { amount: 0.5, focus: cam.position.distanceTo(m.position), focal: 40 };
    }
    o.aim ??= _c.clone();
    o.aim.lerp(_c, dampFactor(8, dt));
    cam.up.copy(WORLD_UP);
    cam.lookAt(o.aim);
    o.fov = damp(o.fov ?? fov, fov, 3, dt);
    return o.fov;
  }
  // impact: hold on the burst, drifting round it, then hand back
  if (!o.ended) {
    o.ended = true;
    o.hold = 0;
    o.from = cam.position.clone();
    if (o.reason === 'hit' && rig.options.slowMo && !rig.options.reducedMotion) {
      rig.warp.start({ scale: 0.3, ease: 0.08, hold: 0.55, end: 1.15 });
    }
  }
  o.hold += dt;
  _a.copy(o.from).sub(o.last);
  _a.applyAxisAngle(WORLD_UP, o.hold * 0.25);
  cam.position.copy(o.last).add(_a);
  clearGround(cam.position, 4);
  cam.up.copy(WORLD_UP);
  cam.lookAt(o.last);
  rig.dofOut = { amount: 0.7, focus: _a.length(), focal: Math.max(15, _a.length()) };
  if (o.hold > 1.5 || inDangerNow(g)) rig._endOverride(0.45);
  return o.fov ?? 50;
}

// ---------------------------------------------------------------- kill cam

export function killView(rig, dt) {
  const o = rig._override;
  const g = rig.game;
  o.t += dt;
  // follow the wreck while it falls (live position), never below the ground
  if (o.target?.position && o.target.position.distanceToSquared(o.center) < 4e6) o.center.lerp(o.target.position, dampFactor(5, dt));
  const k = smoothstep(0, o.dur, o.t);
  const a = o.a0 + o.t * 0.28;
  const r = o.radius * (1 - 0.14 * k);
  const cam = rig.camera;
  cam.position.set(Math.sin(a) * r, o.height - k * o.height * 0.35, -Math.cos(a) * r).add(o.center);
  clearGround(cam.position, 8);
  cam.up.copy(WORLD_UP);
  // look slightly above the burst: the fireball climbs, the sky frames it
  cam.lookAt(_a.copy(o.center).addScaledVector(WORLD_UP, 3 + k * 4));
  const d = cam.position.distanceTo(o.center);
  rig.dofOut = { amount: 1, focus: d, focal: Math.max(40, d * 1.5), bokeh: 2 };
  if (rig.devHold) o.t = Math.min(o.t, o.dur - 0.6);
  if (inDangerNow(g)) { rig.warp.cancel(); rig._endOverride(0.25); return o.fov; }
  if (o.t >= o.dur) {
    // auto-return: a quick whip back to the chase unless it is far away
    const far = cam.position.distanceTo(g?.flight?.position ?? cam.position) > 1500;
    rig._endOverride(far ? 0 : 0.7);
  }
  o.fov = 42 - 6 * k;
  return o.fov;
}

// ---------------------------------------------------------------- death cam

export function deathView(rig, dt) {
  const o = rig._override;
  o.t += dt;
  const cam = rig.camera;
  if (o.velocity) {
    // dragged ballistic fall (k = 0.6/s), stopped by the terrain
    const kd = 0.6;
    const tau = (1 - Math.exp(-kd * o.t)) / kd;
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
  o.look ??= o.center.clone();
  o.look.lerp(o.center, dampFactor(6, dt));
  cam.lookAt(o.look);
  const d = cam.position.distanceTo(o.center);
  rig.dofOut = { amount: 0.8, focus: d, focal: Math.max(20, d * 0.8) };
  return clamp(50 - o.t * 2, 34, 50);
}

// ---------------------------------------------------------------- action cam

/**
 * Optional "cinematic" dogfight camera (options.actionCam): holds dramatic
 * angles on the engaged enemy — over the shoulder, alongside, and from behind
 * the enemy looking back — cutting between them every few seconds with soft
 * blends. The system only offers it when an enemy is near and nothing is
 * threatening the player; otherwise the rig flies the normal chase.
 */
export function actionView(rig, dt, flight) {
  const T = rig.actionTarget?.position;
  if (!T) return null;
  const cam = rig.camera;
  rig._chaseState(dt, flight);
  const s = rig._action ??= { t: 0, shot: null, off: newSpring(), aim: new THREE.Vector3(), fov: 50, fresh: true };
  if (rig._actionFresh) { s.t = 0; s.off.init = false; s.fresh = true; s.shot = null; rig._actionFresh = false; }
  s.t += dt;
  const P = flight.position;
  _a.copy(T).sub(P);
  const range = _a.length();
  _a.divideScalar(Math.max(range, 1));
  const shot = actionShot(s.t, range, rig._actionSeed ?? 0);
  if (shot !== s.shot) {
    if (s.shot) rig._startBlend(0.85);
    s.shot = shot;
    s.off.init = false;
  }
  _up.set(0, 1, 0).applyQuaternion(rig._boomQuat).lerp(WORLD_UP, 0.8).normalize();
  _side.crossVectors(_a, _up).normalize();
  const fwd = _c.set(0, 0, -1).applyQuaternion(flight.orientation);
  let anchor = P;
  let aimK = 0.55;
  if (shot === 'shoulder') {
    _b.copy(_a).multiplyScalar(-28).addScaledVector(_up, 7).addScaledVector(_side, 7);
  } else if (shot === 'side') {
    _d.crossVectors(fwd, WORLD_UP).normalize();
    _b.copy(_d).multiplyScalar(36).addScaledVector(fwd, -10).addScaledVector(WORLD_UP, 3);
    aimK = 0.3;
  } else {
    // from behind the enemy, looking back past it at the player
    anchor = T;
    _b.copy(_a).multiplyScalar(26).addScaledVector(_up, 6).addScaledVector(_side, -5);
    aimK = 0.6;
  }
  const off = springVec(s.off, _b, 2.2, 0.9, dt);
  cam.position.copy(anchor).add(off);
  clearGround(cam.position, 8);
  // aim between the two (toward the far one from the anchor)
  const near = anchor === P ? P : T;
  const farP = anchor === P ? T : P;
  _c.copy(near).lerp(farP, aimK);
  if (s.fresh) s.aim.copy(_c); else s.aim.lerp(_c, dampFactor(6, dt));
  cam.up.copy(_up);
  cam.lookAt(s.aim);
  _c.copy(T).sub(cam.position).normalize();
  _d.copy(P).sub(cam.position).normalize();
  const want = fitFov(_c, _d, 28, 72, cam.aspect);
  s.fov = s.fresh ? want : damp(s.fov, want, 2.5, dt);
  s.fresh = false;
  return s.fov;
}

export function inDangerNow(g) {
  if (!g) return false;
  const h = g.hud ?? {};
  return (h.threats?.length ?? 0) > 0 || h.warning === 'missile' || g.flight?.crashed;
}
