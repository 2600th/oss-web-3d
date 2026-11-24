import * as THREE from 'three/webgpu';
import { terrainHeight } from '../world/terrain/heightfield.js';

/**
 * The stricken aircraft in an air kill shot.
 *
 * When a hostile fighter dies, the ai drops its model from the scene and the
 * VFX throws a burning hulk (a dark debris piece inside a fire trail) along
 * a dragged ballistic path from the kill point (Emitters.wreck: gravity,
 * velocity x exp(-0.1 t)). For a kill shot the camera borrows the discarded
 * airframe and flies it down that same path, so the fire trail streams from
 * a recognisable jet: it rolls away, the nose drops, and a few control
 * surfaces tear off and tumble (one of them past the lens).
 *
 * Respect: the pilot figure is hidden; nothing else of the crew is shown.
 * Camera-owned scene objects; each is removed when it reaches the ground or
 * after `life` seconds (game time), so the player never sees it pop out.
 */
const PIECES = ['stab_L', 'stab_R', 'rudder', 'aileron_L', 'aileron_R', 'flap_L', 'flap_R', 'airbrake_L', 'airbrake_R'];
/** Drag rates (1/s): the hulk matches the VFX wreck; torn panels slow fast. */
const DRAG_WRECK = 0.1;
const DRAG_PIECE = 0.6;
const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _ax = new THREE.Vector3();

export class WreckProxies {
  constructor(game) {
    this.game = game;
    this.items = [];
    this.life = 14;
    this.max = 3;
  }

  /**
   * Borrow `target.object3d` and fly it as a wreck. opts: rng, pass
   * ({offset: Vector3 relative to the wreck, at: game s} — one piece is
   * thrown to fly past that point). Returns the proxy or null.
   */
  spawn(target, { rng = Math.random, pass = null } = {}) {
    const obj = target?.object3d;
    const scene = this.game?.scene;
    if (!obj || !scene) return null;
    if (this.items.length >= this.max) this._remove(this.items[0]);
    // the airframe's GLB loads asynchronously: no model, nothing to fly
    let hasMesh = false;
    obj.traverse((o) => { if (o.isMesh) hasMesh = true; });
    if (!hasMesh) return null;
    scene.add(obj); // re-parents (the ai has removed it, or is about to)
    obj.position.copy(target.position);
    if (target.quaternion) obj.quaternion.copy(target.quaternion);
    obj.visible = true;
    // close-up model only, and no crew figure
    obj.traverse((o) => {
      if (o.isLOD) {
        o.autoUpdate = false;
        o.levels.forEach((l, i) => { l.object.visible = i === 0; });
      }
      if (o.name === 'pilot') o.visible = false;
    });
    obj.updateMatrixWorld(true);
    const vel = (target.velocity?.isVector3 ? target.velocity.clone() : new THREE.Vector3());
    const p = {
      obj, target, pos: obj.position.clone(), vel, age: 0,
      roll: (rng() < 0.5 ? -1 : 1) * (2.2 + rng() * 1.6), // rad/s about the nose
      pitch: 0.25 + rng() * 0.25, // nose-down rate
      pieces: [],
    };
    this._tear(p, rng, pass);
    this.items.push(p);
    return p;
  }

  /** Detach 3-4 control surfaces and throw them clear, tumbling. */
  _tear(p, rng, pass) {
    const scene = this.game.scene;
    const level0 = [];
    p.obj.traverse((o) => { if (o.isLOD) level0.push(o.levels[0]?.object); });
    const root = level0[0] ?? p.obj;
    const names = PIECES.slice().sort(() => rng() - 0.5).slice(0, 3 + (rng() < 0.5 ? 1 : 0));
    if (!names.includes('stab_L') && !names.includes('stab_R')) names[0] = rng() < 0.5 ? 'stab_L' : 'stab_R';
    let first = true;
    for (const name of names) {
      const n = root.getObjectByName(name);
      if (!n) continue;
      let mesh = false;
      n.traverse((o) => { if (o.isMesh) mesh = true; });
      if (!mesh) continue;
      scene.attach(n); // keeps its world transform
      const v = p.vel.clone();
      if (pass && first) {
        // thrown so it crosses `pass.offset` (relative to the wreck) at
        // `pass.at` game s. Relative to the wreck the panel also falls back
        // under its heavier drag: x(t) = x0 + vr0 B - (kp - kw) W (t - B) / kp,
        // B = (1 - exp(-kp t)) / kp (gravity is common to both and cancels).
        const t = Math.max(0.15, pass.at);
        const B = (1 - Math.exp(-DRAG_PIECE * t)) / DRAG_PIECE;
        const A = ((DRAG_PIECE - DRAG_WRECK) * (t - B)) / DRAG_PIECE;
        _v.copy(pass.offset).sub(_ax.copy(n.position).sub(p.pos)).addScaledVector(p.vel, A);
        v.addScaledVector(_v, 1 / B);
        first = false;
      } else {
        _ax.set(rng() - 0.5, rng() * 0.6 - 0.1, rng() - 0.5).normalize();
        v.addScaledVector(_ax, 18 + rng() * 26);
      }
      p.pieces.push({
        node: n, vel: v,
        spin: new THREE.Vector3(rng() - 0.5, rng() - 0.5, rng() - 0.5).normalize(),
        rate: 5 + rng() * 9,
      });
    }
  }

  /** Game-time step (dt already scaled by the time warp). */
  update(dt) {
    if (!(dt > 0)) return;
    for (let i = this.items.length - 1; i >= 0; i--) {
      const p = this.items[i];
      p.age += dt;
      // the same dragged ballistic path as the VFX's burning hulk
      p.vel.y -= 9.81 * dt;
      p.vel.multiplyScalar(Math.exp(-DRAG_WRECK * dt));
      p.pos.addScaledVector(p.vel, dt);
      p.obj.position.copy(p.pos);
      // roll about the nose, nose falling toward the flight path
      _q.setFromAxisAngle(_ax.set(0, 0, -1), p.roll * dt);
      p.obj.quaternion.multiply(_q);
      _q.setFromAxisAngle(_ax.set(1, 0, 0), -p.pitch * dt);
      p.obj.quaternion.multiply(_q);
      for (const c of p.pieces) {
        c.vel.y -= 9.81 * dt;
        c.vel.multiplyScalar(Math.exp(-DRAG_PIECE * dt)); // light, draggy panels
        c.node.position.addScaledVector(c.vel, dt);
        _q.setFromAxisAngle(c.spin, c.rate * dt);
        c.node.quaternion.premultiply(_q);
      }
      const gy = terrainHeight(p.pos.x, p.pos.z);
      if (p.pos.y <= gy + 1 || p.age > this.life) this._remove(p);
    }
  }

  /** Where the wreck is (live), or null if it is gone. */
  positionOf(target) {
    return this.items.find((p) => p.target === target)?.pos ?? null;
  }

  _remove(p) {
    const i = this.items.indexOf(p);
    if (i >= 0) this.items.splice(i, 1);
    p.obj.removeFromParent();
    for (const c of p.pieces) c.node.removeFromParent();
  }

  clear() { while (this.items.length) this._remove(this.items[0]); }
}
