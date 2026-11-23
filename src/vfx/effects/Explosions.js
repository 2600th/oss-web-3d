import * as THREE from 'three/webgpu';
import { terrainHeight, terrainNormal } from '../../world/terrain/heightfield.js';
import { Pool, clamp } from '../core/ring.js';
import { rnd, randDir } from './util.js';

const _d = new THREE.Vector3();
const _p = new THREE.Vector3();
const _n = new THREE.Vector3();
const _t = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _s = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
const SNOW_LINE = 4900;

/** Layered explosions, gun impacts and the tumbling debris they throw. */
export class Explosions {
  constructor(vfx) {
    this.vfx = vfx;
    this.pulses = [];
    const n = vfx.cfg.debris;
    this.debris = new Pool(n, () => ({
      pos: new THREE.Vector3(), vel: new THREE.Vector3(), quat: new THREE.Quaternion(), axis: new THREE.Vector3(),
      spin: 0, age: 0, life: 0, scale: 1, burn: 1, trail: null,
    }));
    const geo = new THREE.TetrahedronGeometry(0.6, 0);
    geo.scale(1.5, 0.35, 1);
    const mat = new THREE.MeshStandardNodeMaterial({ color: 0x191817, roughness: 0.85, metalness: 0.4 });
    this.debrisMesh = new THREE.InstancedMesh(geo, mat, n);
    this.debrisMesh.count = 0;
    this.debrisMesh.visible = false;
    this.debrisMesh.frustumCulled = false;
    this.debrisMesh.name = 'vfx-debris';
    this.debrisMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    vfx.game.scene.add(this.debrisMesh);
  }

  debrisCount() { return this.debris.activeCount; }

  /** AA shell burst: a snap of light, a few fragments and a dark puff that hangs. */
  flak(pos, R, q) {
    const v = this.vfx, { lit, glow, L, G } = v;
    const x = pos.x, y = pos.y, z = pos.z;
    glow.spawn(G.flash, x, y, z, 0, 0, 0, 0.09, R * 2, R * 4, 1, 0.85, 0.6, 1, 30);
    v.lights.flash(pos, 1, 0.7, 0.4, R * R * 260, R * 40, 0.3);
    const nPuff = Math.max(3, Math.round(6 * q));
    for (let i = 0; i < nPuff; i++) {
      randDir(_d);
      const sp = R * rnd(1.2, 3.5);
      lit.spawn(L.smoke, x + _d.x * R * 0.3, y + _d.y * R * 0.3, z + _d.z * R * 0.3, _d.x * sp, _d.y * sp, _d.z * sp,
        rnd(6, 11), R * 0.8, R * rnd(2.2, 3.4), 0.07, 0.068, 0.066, 0.95, i < 2 ? 1.6 : 0, -rnd(0.1));
    }
    const nSpark = Math.round(14 * q);
    for (let i = 0; i < nSpark; i++) {
      randDir(_d);
      const sp = R * rnd(8, 26);
      glow.spawn(G.spark, x, y, z, _d.x * sp, _d.y * sp, _d.z * sp, rnd(0.25, 0.7), rnd(0.1, 0.2), 0.03, 1, 0.65, 0.25, 1, rnd(6, 16));
    }
  }

  /** `R` is the fireball radius in metres; everything scales from it. */
  explode(pos, R, kind = 'air', velocity = null) {
    const v = this.vfx, { lit, glow, L, G } = v;
    const cam = v.shared.u.camPos.value;
    const dist = cam.distanceTo(pos);
    const lod = dist > 9000 ? 0.35 : dist > 3500 ? 0.65 : 1;
    const q = v.cfg.rate * lod;
    if (kind === 'flak') return this.flak(pos, R, q);
    const ground = kind === 'ground';
    const ivx = (velocity?.x ?? 0) * 0.3, ivy = (velocity?.y ?? 0) * 0.3, ivz = (velocity?.z ?? 0) * 0.3;
    const big = Math.sqrt(R / 9);
    let surfaceY = -1e9;
    if (ground) {
      terrainNormal(pos.x, pos.z, _n);
      surfaceY = terrainHeight(pos.x, pos.z);
    }
    const x = pos.x, y = ground ? Math.max(pos.y, surfaceY + 0.3) : pos.y, z = pos.z;

    // 1. flash + bloom halo + scene light + pressure bubble
    glow.spawn(G.flash, x, y, z, ivx, ivy, ivz, 0.12, R * 3, R * 6, 1, 0.88, 0.66, 1, 40);
    glow.spawn(G.halo, x, y, z, ivx, ivy, ivz, 0.6, R * 5, R * 10, 1, 0.5, 0.17, 1, 1.6);
    v.lights.flash(pos, 1, 0.62, 0.3, R * R * 420, R * 50, 0.65);
    this.pulses.push({ x, y, z, R, age: 0 });

    // 2. fireball: white-hot core puffs, then the rolling ball that cools to soot
    for (let i = 0; i < 3; i++) {
      randDir(_d);
      lit.spawn(L.fireball, x + _d.x * R * 0.2, y + _d.y * R * 0.2, z + _d.z * R * 0.2, _d.x * R + ivx, _d.y * R + ivy, _d.z * R + ivz,
        0.6 * big, R * 0.9, R * 1.7, 0.1, 0.09, 0.08, 0.9, 6);
    }
    const nBall = Math.round((9 + R * 0.45) * q);
    for (let i = 0; i < nBall; i++) {
      randDir(_d);
      if (ground) { _d.y = Math.abs(_d.y) * 0.9 + 0.2; _d.normalize(); }
      const r0 = R * rnd(0.1, 0.5), sp = R * rnd(1.4, 5.2);
      lit.spawn(L.fireball, x + _d.x * r0, y + _d.y * r0, z + _d.z * r0, _d.x * sp + ivx, _d.y * sp + ivy, _d.z * sp + ivz,
        rnd(2.2, 3.8) * (0.55 + 0.45 * big), R * rnd(0.5, 0.8), R * rnd(1.9, 2.8), 0.085, 0.08, 0.075, 0.95, rnd(2.0, 3.3), -rnd(0.05));
    }

    // 3. smoke that stays behind and drifts off with the wind
    const nSmoke = Math.round(7 * q);
    for (let i = 0; i < nSmoke; i++) {
      randDir(_d);
      if (ground) _d.y = Math.abs(_d.y);
      lit.spawn(L.smoke, x + _d.x * R * 0.7, y + _d.y * R * 0.7, z + _d.z * R * 0.7, _d.x * R * 0.7 + ivx, _d.y * R * 0.7 + 2 + ivy, _d.z * R * 0.7 + ivz,
        rnd(7, 13) * (0.7 + R / 22), R * 1.3, R * rnd(3.0, 4.4), 0.17, 0.165, 0.16, 0.85, 0, -rnd(0.25, 0.7));
    }

    // 4. sparks
    if (lod > 0.4) {
      const nSpark = Math.round((28 + R * 3) * q);
      for (let i = 0; i < nSpark; i++) {
        randDir(_d);
        if (ground) _d.y = Math.abs(_d.y);
        const sp = R * rnd(5, 22);
        glow.spawn(G.spark, x, y, z, _d.x * sp + ivx * 2, _d.y * sp + ivy * 2, _d.z * sp + ivz * 2,
          rnd(0.5, 1.6), rnd(0.12, 0.3) * big, 0.03, 1, 0.6, 0.2, 1, rnd(6, 20));
      }
    }

    // 5. shock ring
    glow.spawn(G.ring, x, y, z, 0, 0, 0, 0.5, R * 1.5, R * 17, 1, 0.92, 0.82, 1, 0.42);

    // 6. debris with smoke trails
    if (lod === 1 && R >= 4) {
      const nDeb = Math.round(clamp(3 + R / 3, 3, 10) * v.cfg.rate);
      for (let i = 0; i < nDeb; i++) {
        randDir(_d);
        if (ground) _d.y = Math.abs(_d.y) * 0.8 + 0.3;
        const sp = rnd(25, 95) * (0.7 + 0.3 * big);
        _t.set(_d.x * sp + (velocity?.x ?? 0) * 0.7, _d.y * sp + (velocity?.y ?? 0) * 0.7, _d.z * sp + (velocity?.z ?? 0) * 0.7);
        this.spawnDebris(_p.set(x, y, z), _t, rnd(0.5, 1.3) * big);
      }
    }

    // 7. ground: thrown column, rolling dust skirt, a fire that keeps smoking
    if (ground) {
      const snow = y > SNOW_LINE;
      const cr = snow ? 0.88 : 0.3, cg = snow ? 0.89 : 0.255, cb = snow ? 0.93 : 0.2;
      const nCol = Math.round(20 * q);
      for (let i = 0; i < nCol; i++) {
        randDir(_d);
        const up = R * rnd(1.6, 4.6), lat = R * rnd(0.3, 1.4);
        lit.spawn(L.dust, x + _d.x * R * 0.4, y + 0.5, z + _d.z * R * 0.4,
          _n.x * up + _d.x * lat, _n.y * up + Math.abs(_d.y) * lat, _n.z * up + _d.z * lat,
          rnd(2.6, 4.6) * (0.7 + R / 26), R * 0.55, R * rnd(1.8, 3), cr, cg, cb, 0.85, 0, -rnd(0.08));
      }
      const nSkirt = Math.round(14 * q);
      for (let i = 0; i < nSkirt; i++) {
        const a = (i / nSkirt) * Math.PI * 2 + rnd(0.4);
        _t.set(Math.cos(a), 0, Math.sin(a));
        _t.addScaledVector(_n, -_t.dot(_n)).normalize();
        const sp = R * rnd(2.4, 5);
        lit.spawn(L.groundDust, x + _t.x * R * 0.5, y + R * 0.12, z + _t.z * R * 0.5, _t.x * sp, _t.y * sp + 1, _t.z * sp,
          rnd(3, 6), R * 0.8, R * rnd(2.4, 3.6), cr * 1.05, cg * 1.05, cb * 1.05, 0.5, 0, -rnd(0.1));
      }
      if (R >= 8) v.spawnFire(_p.set(x, surfaceY, z), { size: R * 0.32, duration: R >= 16 ? Infinity : 150 });
    }

    // 8. camera shake for anyone listening
    const shake = clamp((R * 16) / Math.max(dist, 20), 0, 1);
    if (shake > 0.03) v.game.events.emit('vfx:shake', { amount: shake });
  }

  /** Gun round striking something. */
  impact(pos, normal, targetKind = 'terrain') {
    const v = this.vfx, { lit, glow, L, G } = v;
    const n = normal ? _n.copy(normal).normalize() : _n.copy(UP);
    const soft = targetKind == null || targetKind === 'terrain' || targetKind === 'ground' || targetKind === 'snow';
    if (soft) {
      const snow = targetKind === 'snow' || pos.y > SNOW_LINE;
      const cr = snow ? 0.9 : 0.34, cg = snow ? 0.91 : 0.29, cb = snow ? 0.95 : 0.23;
      for (let i = 0; i < 3; i++) {
        randDir(_d);
        const sp = rnd(4, 12);
        lit.spawn(L.dust, pos.x, pos.y + 0.2, pos.z, n.x * sp + _d.x * 3, n.y * sp + _d.y * 3, n.z * sp + _d.z * 3,
          rnd(0.9, 1.6), 0.5, rnd(2.2, 3.6), cr, cg, cb, 0.7);
      }
      lit.spawn(L.groundDust, pos.x, pos.y + 0.3, pos.z, n.x * 2, n.y * 2, n.z * 2, rnd(1.6, 2.6), 0.8, 4.2, cr, cg, cb, 0.45);
      if (!snow) for (let i = 0; i < 3; i++) {
        randDir(_d); const sp = rnd(8, 26);
        glow.spawn(G.spark, pos.x, pos.y, pos.z, n.x * sp + _d.x * sp * 0.6, n.y * sp + _d.y * sp * 0.6, n.z * sp + _d.z * sp * 0.6,
          rnd(0.2, 0.5), 0.08, 0.02, 1, 0.7, 0.3, 1, 8);
      }
    } else {
      glow.spawn(G.flash, pos.x, pos.y, pos.z, 0, 0, 0, 0.07, 1.2, 2.6, 1, 0.85, 0.55, 1, 9);
      for (let i = 0; i < 9; i++) {
        randDir(_d); const sp = rnd(15, 60);
        glow.spawn(G.spark, pos.x, pos.y, pos.z, n.x * sp * 0.5 + _d.x * sp, n.y * sp * 0.5 + _d.y * sp, n.z * sp * 0.5 + _d.z * sp,
          rnd(0.25, 0.7), rnd(0.07, 0.14), 0.02, 1, 0.72, 0.32, 1, rnd(8, 18));
      }
      lit.spawn(L.smoke, pos.x, pos.y, pos.z, n.x * 3, n.y * 3, n.z * 3, rnd(0.8, 1.4), 0.5, 2.6, 0.25, 0.25, 0.25, 0.5);
      v.lights.flash(pos, 1, 0.75, 0.4, 900, 60, 0.12);
    }
  }

  spawnDebris(pos, vel, scale = 1) {
    const d = this.debris.acquire();
    d.trail?.end();
    d.pos.copy(pos); d.vel.copy(vel);
    randDir(d.axis); d.spin = rnd(4, 14); d.quat.identity();
    d.age = 0; d.life = rnd(3.5, 6.5); d.scale = scale; d.burn = rnd(1.2, 3);
    d.trail = this.vfx.ribbons.create({ ...this.vfx.TRAILS.debris, radius: 0.28 * scale, growth: 0.8 * scale, spacing: this.vfx.TRAILS.debris.spacing * this.vfx.cfg.spacing });
    return d;
  }

  update(dt) {
    const v = this.vfx, { glow, lit, G, L } = v;
    // pressure bubbles: a brief expanding lens of hot air
    for (let i = this.pulses.length - 1; i >= 0; i--) {
      const p = this.pulses[i];
      p.age += dt;
      const t = p.age / 0.7;
      if (t >= 1) { this.pulses.splice(i, 1); continue; }
      _p.set(p.x, p.y, p.z);
      v.heat(_p, _p, p.R * (2 + 9 * t), (1 - t) * 1.3);
    }

    let n = 0;
    const mesh = this.debrisMesh;
    for (const d of this.debris.items) {
      if (!d.active) continue;
      d.age += dt;
      d.vel.y -= 9.81 * dt;
      d.vel.multiplyScalar(Math.exp(-0.22 * dt));
      d.pos.addScaledVector(d.vel, dt);
      const gy = terrainHeight(d.pos.x, d.pos.z);
      const hit = d.pos.y <= gy + 0.2;
      if (hit || d.age >= d.life) {
        if (hit) {
          d.pos.y = gy + 0.2;
          this.impact(d.pos, null, 'terrain');
        }
        d.trail?.end(); d.trail = null;
        this.debris.release(d);
        continue;
      }
      const hot = Math.max(0, 1 - d.age / d.burn);
      d.trail.strength = 0.35 + 0.65 * hot;
      d.trail.push(d.pos);
      if (hot > 0) {
        glow.spawn(G.glow, d.pos.x, d.pos.y, d.pos.z, d.vel.x, d.vel.y, d.vel.z, Math.max(dt * 2.5, 0.04), 0.7 * d.scale, 0.5 * d.scale, 1, 0.5, 0.15, 1, 5 * hot);
        if (Math.random() < dt * 14) lit.spawn(L.flame, d.pos.x, d.pos.y, d.pos.z, d.vel.x * 0.4, d.vel.y * 0.4, d.vel.z * 0.4, rnd(0.25, 0.5), 0.6 * d.scale, 1.6 * d.scale, 0.1, 0.1, 0.1, 0.7, 4 * hot);
      }
      _q.setFromAxisAngle(d.axis, d.spin * dt);
      d.quat.premultiply(_q);
      _m.compose(d.pos, d.quat, _s.setScalar(d.scale));
      mesh.setMatrixAt(n++, _m);
    }
    mesh.visible = n > 0;
    if (n > 0 || mesh.count !== 0) {
      mesh.count = n;
      mesh.instanceMatrix.needsUpdate = true;
    }
  }

  dispose() {
    this.debrisMesh.removeFromParent();
    this.debrisMesh.geometry.dispose();
    this.debrisMesh.material.dispose();
  }
}
