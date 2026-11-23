import * as THREE from 'three/webgpu';

export const rnd = (a = 1, b) => (b === undefined ? Math.random() * a : a + Math.random() * (b - a));

/** Uniform random unit vector. */
export function randDir(out) {
  const z = Math.random() * 2 - 1, a = Math.random() * Math.PI * 2, r = Math.sqrt(1 - z * z);
  return out.set(Math.cos(a) * r, z, Math.sin(a) * r);
}

/** Random unit vector in the hemisphere around `n`. */
export function randHemi(out, n) {
  randDir(out);
  if (out.dot(n) < 0) out.negate();
  return out;
}

const _prev = new WeakMap();
const _v = new THREE.Vector3();

/**
 * Read a live entity's pose. Entities come from other systems with slightly
 * different shapes, so be liberal: an `object3d`, or `position` (+ optional
 * `quaternion`/`orientation`), and `velocity` if it exists (finite-differenced
 * otherwise).
 */
export function readPose(entity, out, dt = 1 / 60) {
  const o = entity.object3d;
  if (o && o.isObject3D && !entity.position) {
    o.updateWorldMatrix(true, false);
    o.matrixWorld.decompose(out.position, out.quaternion, _v);
  } else {
    const p = entity.position ?? o?.position;
    if (!p) return false;
    out.position.copy(p);
    const q = entity.quaternion ?? entity.orientation ?? o?.quaternion;
    if (q) out.quaternion.copy(q);
    else out.quaternion.identity();
  }
  let st = _prev.get(entity);
  if (!st) { st = { p: out.position.clone(), v: new THREE.Vector3(), has: false }; _prev.set(entity, st); }
  if (entity.velocity?.isVector3) out.velocity.copy(entity.velocity);
  else {
    if (st.has && dt > 0) st.v.lerp(_v.subVectors(out.position, st.p).divideScalar(dt), 0.5);
    out.velocity.copy(st.v);
  }
  // acceleration estimate for g-driven effects
  if (st.has && dt > 0) out.accel.subVectors(out.velocity, st.lastV ?? out.velocity).divideScalar(dt);
  else out.accel.set(0, 0, 0);
  (st.lastV ??= new THREE.Vector3()).copy(out.velocity);
  st.p.copy(out.position);
  st.has = true;
  if (!entity.quaternion && !entity.orientation && !o && out.velocity.lengthSq() > 1) {
    // no orientation at all: face along the velocity (nose is -Z)
    _v.copy(out.velocity).normalize();
    out.quaternion.setFromUnitVectors(_fwd, _v);
  }
  return true;
}
const _fwd = new THREE.Vector3(0, 0, -1);

export function makePose() {
  return { position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), velocity: new THREE.Vector3(), accel: new THREE.Vector3() };
}

export const isAlive = (e) => e && e.alive !== false && e.dead !== true && e.destroyed !== true;
