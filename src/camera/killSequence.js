import * as THREE from 'three/webgpu';
import { terrainHeight } from '../world/terrain/heightfield.js';
import { clamp, damp, dampFactor, smoothstep } from './cameraMath.js';
import {
  KILL, predictIntercept, projectileScale, impactScale, impactDuration, shotScale, airShotPose,
  groundOrbit, impactOrbit, flyAway, pushOutOfSpheres,
} from './killCam.js';
import { newSpring, springVec, inDangerNow } from './views.js';

/**
 * The kill cam's camera work (CameraRig override view 'kill'). Phases:
 *
 *   projectile  riding the killing missile / rocket in slow motion
 *   impact      (after the near-freeze of the last metres) a punch through the
 *               flash, a swing round the target, the fly-away
 *   shot        the fast shot: 'air' (a close angle on the stricken jet),
 *               'ground' (an orbit of the wreck) or 'brief' (reduced motion:
 *               a held, real-time look, then a cut back)
 *
 * The rig calls killView(rig, rdt) every frame (rdt = real seconds). Time
 * is slowed through rig.warp.drive(), from the curves in killCam.js. Every
 * camera position is clamped against the terrain (under the lens and along
 * the line of sight to the subject) and pushed out of keep-out spheres round
 * the target, the player's jet and the projectile.
 *
 * Events (game.events) for audio and anyone else:
 *   camera:killcam { phase: 'start', shot, target, position }
 *   camera:killcam { phase: 'impact', shot, target, position, thump }
 *       thump = { gain 0..1, cutoff Hz, attack, hold, release (real s) }:
 *       a low-pass "thump" the mix can duck into while time is near-frozen
 *   camera:killcam { phase: 'return', shot }   the hand-back has begun
 *   camera:killcam { phase: 'end', shot, reason: 'done' | 'skip' | 'danger' | 'miss' }
 */
const WORLD_UP = new THREE.Vector3(0, 1, 0);
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _f = new THREE.Vector3();
const _r = new THREE.Vector3();
const _u = new THREE.Vector3();
const _s = new THREE.Vector3();
const _p = { x: 0, y: 0, z: 0 };
const _q = new THREE.Quaternion();

export const THUMP = { gain: 1, cutoff: 380, attack: 0.04, hold: 0.35, release: 0.9 };

const emit = (rig, payload) => rig.game?.events?.emit('camera:killcam', payload);

/** Lift `p` above the terrain under it and above any ridge between it and `subject`. */
export function clearTerrain(p, subject, margin = 6) {
  const g = terrainHeight(p.x, p.z) + margin;
  if (p.y < g) p.y = g;
  if (subject) {
    // Line of sight: sample the line lens -> subject; where it dips under
    // the terrain (plus a smaller margin), lift the lens until that sample
    // clears, keeping the subject end fixed: y(s) = p.y (1 - s) + subject.y s.
    // (the subject end is the caller's, raised off the ground for ground
    // targets; the samples stop short of it, where the slope it sits on
    // would otherwise lift the lens by 1 / (1 - s))
    const n = 10;
    let need = p.y;
    for (let i = 1; i <= 8; i++) {
      const s = i / n;
      const h = terrainHeight(p.x + (subject.x - p.x) * s, p.z + (subject.z - p.z) * s) + margin * 0.5;
      const y = p.y + (subject.y - p.y) * s;
      if (y < h) need = Math.max(need, (h - subject.y * s) / (1 - s));
    }
    p.y = Math.min(need, p.y + 80);
  }
  return p;
}

/** Keep-out spheres for this frame: subject, player's jet, the projectile. */
function keepOut(rig, o, center) {
  const s = [];
  const r = o.size * 9 + 4; // a tumbling MiG-21 is ~15 m long; half plus margin
  if (center) s.push({ x: center.x, y: center.y, z: center.z, r: o.air ? r : Math.max(8, (o.target?.radius ?? 8) * 1.6) });
  const P = rig.game?.flight?.position;
  if (P) s.push({ x: P.x, y: P.y, z: P.z, r: 13 });
  // after a detonation: the fireball (it drifts at ~0.3 of the target's
  // velocity) - the swing goes round it, not through it
  if (o.blast) s.push({ x: o.blast.pos.x, y: o.blast.pos.y, z: o.blast.pos.z, r: o.blast.r });
  return s;
}

function clampCamera(rig, o, pos, center) {
  _p.x = pos.x; _p.y = pos.y; _p.z = pos.z;
  pushOutOfSpheres(_p, keepOut(rig, o, center));
  pos.set(_p.x, _p.y, _p.z);
  // line of sight to the middle of a ground target, not to its foot
  let subject = center;
  if (center && !o.air) { subject = _s.copy(center); subject.y += Math.max(4, (o.target?.radius ?? 8) * 0.6); }
  clearTerrain(pos, subject, o.air ? 8 : 5);
  return pos;
}

/** Time warp for this phase, only with slow motion on and motion not reduced. */
function warp(rig, scale) {
  if (!rig.options.slowMo || rig.options.reducedMotion) return;
  rig.warp.drive(scale);
}

/** Track the camera's own velocity (m/s, real time) for the momentum hand-back. */
function trackVelocity(o, pos, rdt) {
  o.prev ??= pos.clone();
  o.vel ??= new THREE.Vector3();
  if (rdt > 1e-4) {
    _a.copy(pos).sub(o.prev).divideScalar(rdt);
    // the rig cuts mid-shot sometimes; ignore jumps
    if (_a.lengthSq() < 4e6) o.vel.lerp(_a, dampFactor(12, rdt));
  }
  o.prev.copy(pos);
}

/** Simulate the wreck's path (same as the VFX hulk) when no proxy carries it. */
function stepWreck(o, gdt) {
  if (!o.wpos) return;
  o.wvel.y -= 9.81 * gdt;
  o.wvel.multiplyScalar(Math.exp(-0.1 * gdt));
  o.wpos.addScaledVector(o.wvel, gdt);
  const g = terrainHeight(o.wpos.x, o.wpos.z) + 1;
  if (o.wpos.y < g) { o.wpos.y = g; o.wvel.set(0, 0, 0); }
}

/** Live centre of the shot: the proxy wreck, the simulated one, or the target. */
function centerOf(rig, o) {
  if (o.proxy && o.proxy.obj.parent) return o.proxy.pos;
  if (o.wpos) return o.wpos;
  return o.center;
}

// ---------------------------------------------------------------- phases

function projectilePhase(rig, o, rdt) {
  const cam = rig.camera;
  const m = o.projectile;
  const T = o.target?.position;
  o.t += rdt;
  if (m.alive === false || o.ended) {
    // the projectile is gone and no kill arrived (the kill, through rig.killCam, would have
    // switched phase): it missed, or the target was already dead
    o.missWait = (o.missWait ?? 0) + rdt;
    if (o.missWait > 0.15) return rig.endKill('miss');
  } else {
    o.last.copy(m.position);
  }
  if (o.t > KILL.projectileMax + 0.6) return rig.endKill('miss');
  const M = o.last;
  if (m.velocity?.lengthSq?.() > 1) _a.copy(m.velocity).normalize();
  else _a.copy(o.dir);
  o.dir.lerp(_a, dampFactor(10, rdt)).normalize();
  let tgo = o.tgo ?? KILL.trigger;
  if (T && m.alive !== false) {
    const tv = o.target.velocity ?? _f.set(0, 0, 0);
    const pr = predictIntercept(
      { x: T.x - M.x, y: T.y - M.y, z: T.z - M.z },
      { x: (m.velocity?.x ?? 0) - tv.x, y: (m.velocity?.y ?? 0) - tv.y, z: (m.velocity?.z ?? 0) - tv.z },
    );
    if (pr.tgo < Infinity) tgo = pr.tgo;
  }
  o.tgo = tgo;
  _r.crossVectors(o.dir, WORLD_UP);
  if (_r.lengthSq() < 1e-4) _r.set(1, 0, 0);
  _r.normalize();
  if (T && !o.held && tgo < KILL.release) {
    // let go: hold station on the target and watch the last metres
    o.held = cam.position.clone().sub(T);
  }
  if (o.held && T) {
    cam.position.copy(T).add(o.held);
  } else {
    // behind, to one side and a little above the projectile: seen three-
    // quarter from behind (dead astern it shrinks to its cross-section),
    // its trail streaming past beside the lens, the target beyond it
    _u.crossVectors(_r, o.dir).normalize(); // the projectile's own "up"
    _b.copy(o.dir).multiplyScalar(-6).addScaledVector(_u, 1.6).addScaledVector(_r, 4.2 * o.side);
    const off = springVec(o.spring, _b, 4, 0.9, rdt);
    cam.position.copy(M).add(off);
  }
  clampCamera(rig, o, cam.position, T && o.target.alive !== false ? T : M);
  // aim between the projectile and the target so both stay in frame, and
  // open the lens just enough to hold them
  let dT = 300;
  let fov = 44;
  if (T) {
    dT = cam.position.distanceTo(T);
    _c.copy(M).sub(cam.position).normalize();
    _f.copy(T).sub(cam.position).normalize();
    const sep = THREE.MathUtils.radToDeg(_c.angleTo(_f));
    // the last stretch belongs to the target: the projectile is flying into it
    const wT = 0.58 + 0.3 * smoothstep(0.12, 0.03, tgo);
    _c.multiplyScalar(1 - wT).addScaledVector(_f, wT).normalize().multiplyScalar(50).add(cam.position);
    fov = clamp(sep * 1.05 + 14, 32, 58);
  } else {
    _c.copy(M).addScaledVector(o.dir, 80);
  }
  if (o.fresh) o.aim.copy(_c); else o.aim.lerp(_c, dampFactor(9, rdt));
  cam.up.copy(WORLD_UP);
  cam.lookAt(o.aim);
  // a slight lean into the projectile's turn
  o.bank = damp(o.bank ?? 0, clamp(-_a.dot(_r) * 4, -0.12, 0.12), 4, rdt);
  cam.rotateZ(o.bank + o.side * 0.04);
  warp(rig, projectileScale(tgo, o.t));
  o.scale = rig.warp.scale;
  // focus rides the projectile, then racks to the target for the last stretch
  const dM = cam.position.distanceTo(M);
  const rack = smoothstep(0.18, KILL.release, tgo);
  rig.dofOut = { amount: 0.55, focus: dM + (dT - dM) * rack, focal: 30 + 50 * rack, bokeh: 1.6 };
  o.fresh = false;
  o.fov = o.fov === undefined ? fov : damp(o.fov, fov, 4, rdt);
  return o.fov;
}

function impactPhase(rig, o, rdt) {
  const cam = rig.camera;
  o.t += rdt;
  const gdt = rdt * (rig.game?.timeScale ?? 1);
  stepWreck(o, gdt);
  if (o.blast) { o.blast.pos.addScaledVector(o.blast.vel, gdt); o.blast.vel.multiplyScalar(Math.exp(-0.5 * gdt)); }
  const C = centerOf(rig, o);
  const F = KILL.punch, O = KILL.orbit, X = KILL.exit;
  const dur = impactDuration();
  const orb = impactOrbit(o.start, o.t, F + O, o.swing, o.r1, o.elev);
  _a.set(orb.x, orb.y, orb.z);
  const fa = flyAway(o.t, dur, X, o.awayDir, 55 * o.size);
  _a.x += fa.x; _a.y += fa.y; _a.z += fa.z;
  cam.position.copy(C).add(_a);
  clampCamera(rig, o, cam.position, C);
  trackVelocity(o, cam.position, rdt);
  // look: from where the projectile cam was aiming onto the burst, which climbs
  _c.copy(C).addScaledVector(WORLD_UP, (o.air ? 1.5 : 4) + 3 * smoothstep(0, dur, o.t));
  o.aim.lerp(_c, dampFactor(o.t < F ? 14 : 7, rdt));
  cam.up.copy(WORLD_UP);
  cam.lookAt(o.aim);
  warp(rig, impactScale(o.t, o.s0));
  const d = cam.position.distanceTo(C);
  rig.dofOut = { amount: 1, focus: d, focal: Math.max(14, d * 0.7), bokeh: 2.2 };
  if (!o.returned && o.t > dur - X) { o.returned = true; emit(rig, { phase: 'return', shot: o.shot }); }
  if (o.t >= dur) return rig.endKill('done');
  o.fov = damp(o.fov ?? 40, 40, 2, rdt);
  return o.fov;
}

function airShot(rig, o, rdt) {
  const cam = rig.camera;
  o.t += rdt;
  stepWreck(o, rdt * (rig.game?.timeScale ?? 1));
  const W = centerOf(rig, o);
  const dur = KILL.air;
  const pose = airShotPose(o.angle, o.t, dur, o.side, o.size);
  // the wreck's frame: heading, right, world up
  const fwd = o.basisF, right = o.basisR;
  _a.copy(fwd).multiplyScalar(pose.off.f).addScaledVector(right, pose.off.r);
  const baseY = o.startY + (W.y - o.startY) * pose.follow;
  cam.position.set(W.x + _a.x, baseY + pose.off.u, W.z + _a.z);
  const fa = flyAway(o.t, dur, KILL.exit, o.awayDir, 50 * o.size);
  cam.position.x += fa.x; cam.position.y += fa.y; cam.position.z += fa.z;
  clampCamera(rig, o, cam.position, W);
  trackVelocity(o, cam.position, rdt);
  _c.copy(W).addScaledVector(fwd, pose.look.f).addScaledVector(right, pose.look.r).addScaledVector(WORLD_UP, pose.look.u);
  if (o.fresh) o.aim.copy(_c); else o.aim.lerp(_c, dampFactor(16, rdt));
  cam.up.copy(WORLD_UP);
  cam.lookAt(o.aim);
  if (pose.roll) cam.rotateZ(pose.roll);
  warp(rig, shotScale(o.t, dur, 0.45));
  const d = cam.position.distanceTo(W);
  rig.dofOut = { amount: 0.9, focus: d, focal: Math.max(14, d * 0.6), bokeh: 1.8 };
  o.fresh = false;
  if (!o.returned && o.t > dur - KILL.exit) { o.returned = true; emit(rig, { phase: 'return', shot: o.shot }); }
  if (o.t >= dur) return rig.endKill('done');
  return pose.fov;
}

function groundShot(rig, o, rdt) {
  const cam = rig.camera;
  o.t += rdt;
  const C = o.center;
  const dur = KILL.ground;
  const off = groundOrbit(o.t, dur, o.a0, o.side, o.radius);
  cam.position.set(C.x + off.x, C.y + off.y, C.z + off.z);
  _a.set(cam.position.x - C.x, 0.35 * o.radius, cam.position.z - C.z).normalize();
  const fa = flyAway(o.t, dur, KILL.exit, _a, 70);
  cam.position.x += fa.x; cam.position.y += fa.y; cam.position.z += fa.z;
  clampCamera(rig, o, cam.position, C);
  trackVelocity(o, cam.position, rdt);
  // the fireball climbs: the aim rises with it
  _c.copy(C).addScaledVector(WORLD_UP, 4 + 10 * smoothstep(0, dur, o.t));
  if (o.fresh) o.aim.copy(_c); else o.aim.lerp(_c, dampFactor(10, rdt));
  cam.up.copy(WORLD_UP);
  cam.lookAt(o.aim);
  warp(rig, shotScale(o.t, dur, 0.35));
  const d = cam.position.distanceTo(C);
  rig.dofOut = { amount: 0.9, focus: d, focal: Math.max(20, d * 0.7), bokeh: 1.8 };
  o.fresh = false;
  if (!o.returned && o.t > dur - KILL.exit) { o.returned = true; emit(rig, { phase: 'return', shot: o.shot }); }
  if (o.t >= dur) return rig.endKill('done');
  return 40;
}

/** Reduced motion: a held, real-time look from the player's side; no swing, no slow motion. */
function briefShot(rig, o, rdt) {
  const cam = rig.camera;
  o.t += rdt;
  stepWreck(o, rdt * (rig.game?.timeScale ?? 1));
  const C = centerOf(rig, o);
  cam.position.copy(C).add(o.offset);
  clampCamera(rig, o, cam.position, C);
  _c.copy(C).addScaledVector(WORLD_UP, o.air ? 1 : 5);
  if (o.fresh) o.aim.copy(_c); else o.aim.lerp(_c, dampFactor(6, rdt));
  cam.up.copy(WORLD_UP);
  cam.lookAt(o.aim);
  o.fresh = false;
  if (o.t >= KILL.brief) return rig.endKill('done');
  return o.fov;
}

/** The rig's 'kill' view. Returns the field of view. */
export function killView(rig, rdt) {
  const o = rig._override;
  if (inDangerNow(rig.game)) { rig.endKill('danger'); return o.fov ?? 45; }
  if (rig.devHold && o.phase === 'shot' && o.t > 0.6) o.t = 0.6;
  let fov;
  if (o.phase === 'projectile') fov = projectilePhase(rig, o, rdt);
  else if (o.phase === 'impact') fov = impactPhase(rig, o, rdt);
  else if (o.shot === 'air') fov = airShot(rig, o, rdt);
  else if (o.shot === 'ground') fov = groundShot(rig, o, rdt);
  else fov = briefShot(rig, o, rdt);
  return fov ?? o.fov ?? 45;
}

// ---------------------------------------------------------------- set-up

/** Override state for the projectile cam. */
export function projectileState(rig, projectile, target, side) {
  const dir = projectile.velocity?.lengthSq?.() > 1 ? projectile.velocity.clone().normalize() : new THREE.Vector3(0, 0, -1).applyQuaternion(projectile.quaternion ?? _q.identity());
  return {
    view: 'kill', phase: 'projectile', shot: 'projectile', projectile, target, air: target?.class === 'air',
    size: 1, side, t: 0, dir, last: projectile.position.clone(), spring: newSpring(), aim: new THREE.Vector3(), fresh: true,
  };
}

/** Switch a projectile override to the impact phase. */
export function toImpact(rig, o, position, proxy) {
  const cam = rig.camera;
  o.phase = 'impact';
  o.t = 0;
  o.proxy = proxy ?? null;
  o.center = (position ?? o.target?.position ?? o.last).clone();
  if (!o.proxy && o.air) { o.wpos = o.center.clone(); o.wvel = o.target?.velocity?.clone?.() ?? new THREE.Vector3(); }
  o.s0 = rig.warp.scale < 1 ? rig.warp.scale : KILL.projectileLow;
  const size = o.target?.explosion ?? (o.air ? 'medium' : 'large');
  o.blast = {
    pos: o.center.clone(),
    vel: (o.target?.velocity?.clone?.() ?? new THREE.Vector3()).multiplyScalar(0.3),
    r: { small: 14, medium: 22, large: 30, huge: 45 }[size] ?? 24,
  };
  Object.assign(o, impactPlan(cam.position, centerOf(rig, o), o.side, o.air, o.target?.velocity));
  if (o.cut) { rig.cut = true; o.aim.copy(centerOf(rig, o)); }
  rig.addTrauma(0.42);
  emit(rig, { phase: 'impact', shot: o.shot, target: o.target, position: o.center.clone(), thump: { ...THUMP } });
}

/**
 * The swing after a detonation, from the lens position at impact: start
 * offset, swing angle, end radius, fly-away direction. The swing runs away
 * from the side the lens rode on, so it keeps turning the same way.
 */
export function impactPlan(camPos, center, side, air = true, velocity = null) {
  const start = camPos.clone().sub(center);
  let cut = false;
  const hv = velocity ? _s.set(velocity.x, 0, velocity.z) : null;
  if (air && hv && hv.lengthSq() > 400) {
    // An air kill is almost always a tail chase: the lens sits behind the
    // target and the fireball (which lags the wreck) would roll back over
    // it. Cut, under the flash, to the target's flank, a little behind and
    // above; the swing then carries the lens round toward its nose while
    // the burning wreck pulls out of the fireball.
    hv.normalize();
    const right = new THREE.Vector3().crossVectors(hv, WORLD_UP).normalize();
    start.copy(right).multiplyScalar(side * 44).addScaledVector(hv, -12).addScaledVector(WORLD_UP, 7);
    cut = true;
  }
  const r0 = start.length();
  const plan = {
    start: { x: start.x, y: start.y, z: start.z },
    cut,
    swing: side * (cut ? 0.9 : 1.15),
    // close in a little on the breaking target while swinging (keep-out
    // spheres round it and round the fireball stop the lens short of both)
    r1: clamp(r0 * 0.75, 38, 70),
    // a ground kill ends on a low three-quarter view, horizon in frame
    elev: air ? null : 0.42,
  };
  // the fly-away leaves along the lens's line at the end of the swing, and up
  const end = impactOrbit(plan.start, 1, 1, plan.swing, plan.r1, plan.elev);
  plan.awayDir = new THREE.Vector3(end.x, end.y, end.z).normalize().addScaledVector(WORLD_UP, 0.35).normalize();
  return plan;
}

/** Lens offset (from the centre) during the impact swing at real time t after the detonation. */
export function impactLensOffset(plan, t) {
  const o = impactOrbit(plan.start, t, KILL.punch + KILL.orbit, plan.swing, plan.r1, plan.elev);
  return new THREE.Vector3(o.x, o.y, o.z);
}

/**
 * A point a torn panel should fly through to pass the lens: `inward` m
 * from the lens toward the subject and `lateral` m to the side of the line
 * (offsets relative to the subject; Vector3).
 */
export function passPoint(lensOffset, lateral = 2.4, inward = 5) {
  const toward = lensOffset.clone().normalize().negate();
  const side = new THREE.Vector3().crossVectors(toward, WORLD_UP);
  if (side.lengthSq() < 1e-4) side.set(1, 0, 0);
  side.normalize();
  return lensOffset.clone().addScaledVector(toward, inward).addScaledVector(side, lateral).addScaledVector(WORLD_UP, 0.6);
}

/**
 * Override state for a fast shot. shot: 'air' | 'ground' | 'brief';
 * angle: an AIR_ANGLES entry (air only); proxy: WreckProxies item or null.
 */
export function shotState(rig, { shot, target, position, angle, side, proxy }) {
  const g = rig.game;
  const center = (position ?? target?.position).clone();
  const air = target ? target.class === 'air' : center.y - terrainHeight(center.x, center.z) > 25;
  const o = {
    view: 'kill', phase: 'shot', shot, target, air, size: 1, side, t: 0, angle,
    center, proxy: proxy ?? null, aim: new THREE.Vector3(), fresh: true, fov: 45,
  };
  if (air && !o.proxy) { o.wpos = center.clone(); o.wvel = target?.velocity?.clone?.() ?? new THREE.Vector3(); }
  const P = g?.flight?.position ?? center;
  if (shot === 'air') {
    const v = target?.velocity ?? new THREE.Vector3();
    o.basisF = new THREE.Vector3(v.x, 0, v.z);
    if (o.basisF.lengthSq() < 1) o.basisF.set(center.x - P.x, 0, center.z - P.z);
    if (o.basisF.lengthSq() < 1) o.basisF.set(0, 0, -1);
    o.basisF.normalize();
    o.basisR = new THREE.Vector3().crossVectors(o.basisF, WORLD_UP).normalize();
    o.startY = center.y;
    // fly away: back along the lens's own line from the wreck, and up
    const pose = airShotPose(angle, KILL.air - KILL.exit, KILL.air, side, 1);
    o.awayDir = o.basisF.clone().multiplyScalar(pose.off.f).addScaledVector(o.basisR, pose.off.r).addScaledVector(WORLD_UP, pose.off.u)
      .normalize().addScaledVector(WORLD_UP, 0.3).normalize();
    rig.addTrauma(0.3);
  } else if (shot === 'ground') {
    // far enough out to stay clear of the fireball and its smoke (a 'large'
    // ground blast is ~40 m across), close enough to read the wreck
    o.radius = clamp((target?.radius ?? 8) * 9, 72, 120);
    o.a0 = Math.atan2(P.x - center.x, -(P.z - center.z));
    rig.addTrauma(0.25);
  } else {
    // brief: from the player's side, 3/4 above, at a calm distance
    const d = air ? 70 : clamp((target?.radius ?? 8) * 9, 60, 120);
    const off = new THREE.Vector3(P.x - center.x, 0, P.z - center.z);
    if (off.lengthSq() < 1) off.set(0, 0, 1);
    off.normalize().applyAxisAngle(WORLD_UP, side * 0.5).multiplyScalar(d);
    off.y = d * (air ? 0.15 : 0.4);
    o.offset = off;
    o.fov = 40;
  }
  return o;
}

/**
 * Where an air shot's lens is, relative to the wreck, at real time t (for
 * throwing a torn panel past it). Returns a Vector3 (world axes).
 */
export function airShotOffset(angle, t, side, basisF, basisR) {
  const pose = airShotPose(angle, t, KILL.air, side, 1);
  return new THREE.Vector3().copy(basisF).multiplyScalar(pose.off.f).addScaledVector(basisR, pose.off.r).addScaledVector(WORLD_UP, pose.off.u);
}
