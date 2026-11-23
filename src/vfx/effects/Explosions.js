import * as THREE from 'three/webgpu';
import { terrainHeight, terrainNormal } from '../../world/terrain/heightfield.js';
import { Pool, clamp } from '../core/ring.js';
import { rnd, randDir } from './util.js';
import { sizeForRate, blastSmokeLife } from '../core/fxmath.js';

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
      spin: 0, age: 0, life: 0, scale: 1, burn: 1, trail: null, owner: null,
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

  /**
   * AA shell burst. Photos of heavy flak show a crisp black ball of several
   * overlapping puffs, a few dark streamers of smoke thrown out by the
   * fragments, and a cloud that hangs where it burst for a quarter of a
   * minute. The light is over in a couple of frames.
   */
  flak(pos, R, q) {
    const v = this.vfx, { lit, glow, L, G } = v;
    const x = pos.x, y = pos.y, z = pos.z;
    const k = sizeForRate(q);
    glow.spawn(G.flash, x, y, z, 0, 0, 0, 0.05, R * 1.2, R * 2.4, 1, 0.85, 0.6, 1, 34);
    v.lights.flash(pos, 1, 0.7, 0.4, R * R * 260, R * 40, 0.2);
    const nPuff = Math.max(5, Math.round(rnd(8, 12) * q));
    for (let i = 0; i < nPuff; i++) {
      randDir(_d);
      const r0 = R * rnd(0.05, 0.55), sp = R * rnd(0.4, 2.0);
      lit.spawn(L.flak, x + _d.x * r0, y + _d.y * r0, z + _d.z * r0, _d.x * sp, _d.y * sp, _d.z * sp,
        rnd(15, 25), R * 0.9 * k, R * rnd(1.5, 2.2) * k, 0.032, 0.031, 0.03, 0.97, i < 2 ? rnd(0.9, 1.3) : 0);
    }
    // fragments: each throws a streamer of the burst's smoke, laid down along
    // its path as drag slows it (puffs at fractions of the throw speed)
    const nFrag = Math.round(rnd(6, 10) * Math.max(0.6, q));
    for (let i = 0; i < nFrag; i++) {
      randDir(_d);
      const sp = R * rnd(5, 9);
      for (let j = 0; j < 10; j++) {
        const f = (j + 1) / 10;
        lit.spawn(L.frag, x, y, z, _d.x * sp * f, _d.y * sp * f, _d.z * sp * f,
          rnd(9, 15), R * 0.2 * k, R * (0.7 + 0.5 * f) * k, 0.045, 0.043, 0.042, 0.55 * (1.1 - f * 0.5), 0);
      }
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
    const big = Math.sqrt(R / 14);
    // fewer puffs on a lower tier (or far away) are bigger, so the ball stays solid
    const k = sizeForRate(q);
    // lights and shake were tuned when the radii were about half this
    const Rl = R * 0.55;
    let surfaceY = -1e9;
    if (ground) {
      terrainNormal(pos.x, pos.z, _n);
      surfaceY = terrainHeight(pos.x, pos.z);
    }
    const x = pos.x, y = ground ? Math.max(pos.y, surfaceY + 0.3) : pos.y, z = pos.z;

    // 1. flash + bloom halo + scene light + pressure bubble. The flash is two
    // things: the star that fills the blast for a frame or so (detonation
    // light is over in tens of milliseconds; it was 0.14 s at 6.5 R, a white
    // disc that hid the fireball), and a point that holds a minimum size on
    // screen so a hit three kilometres off still registers as a hit.
    glow.spawn(G.flash, x, y, z, ivx, ivy, ivz, 0.06, R * 1.5, R * 3, 1, 0.9, 0.7, 1, 46);
    glow.spawn(G.flare, x, y, z, ivx, ivy, ivz, 0.16 + 0.08 * big, R * 1.6, R * 1.0, 1, 0.86, 0.6, 1, 18);
    glow.spawn(G.halo, x, y, z, ivx, ivy, ivz, 0.5, R * 3, R * 6, 1, 0.5, 0.17, 1, 1.0);
    v.lights.flash(pos, 1, 0.62, 0.3, Rl * Rl * 420, Rl * 50 + 120, 0.65);
    this.pulses.push({ x, y, z, R: Rl, age: 0 });

    // 2. fireball. Footage of a warhead or fuel fireball: a dense, slow
    // incandescent core that stays where it burst, wrapped within a few
    // tenths of a second in a shell of black soot that rolls outward and
    // swallows it. So: many small hot puffs, central and slow; a ring of
    // cooler, faster ones; and the delayed dark shell (section 3).
    const ball = R >= 20 ? L.fireballBig : L.fireball;
    const life = 0.55 + 0.45 * big;
    const nCore = Math.round((14 + R * 0.6) * q);
    for (let i = 0; i < nCore; i++) {
      randDir(_d);
      if (ground) { _d.y = Math.abs(_d.y) * 0.9 + 0.15; _d.normalize(); }
      const r0 = R * rnd(0, 0.25), sp = R * rnd(0.15, 0.8);
      lit.spawn(ball, x + _d.x * r0, y + _d.y * r0, z + _d.z * r0, _d.x * sp + ivx, _d.y * sp + ivy, _d.z * sp + ivz,
        rnd(1.6, 2.8) * life, R * 0.4 * k, R * rnd(1.2, 1.6) * k, 0.05, 0.047, 0.044, 0.95, rnd(1.35, 1.7), -rnd(0.03));
    }
    const nBall = Math.round((8 + R * 0.3) * q);
    for (let i = 0; i < nBall; i++) {
      randDir(_d);
      if (ground) { _d.y = Math.abs(_d.y) * 0.9 + 0.2; _d.normalize(); }
      const r0 = R * rnd(0.25, 0.5), sp = R * rnd(1.0, 2.6);
      lit.spawn(ball, x + _d.x * r0, y + _d.y * r0, z + _d.z * r0, _d.x * sp + ivx, _d.y * sp + ivy, _d.z * sp + ivz,
        rnd(2.4, 3.8) * life, R * 0.5 * k, R * rnd(1.5, 2.1) * k, 0.05, 0.047, 0.044, 0.95, rnd(0.7, 1.2), -rnd(0.06));
    }

    // 3. the soot shell, arriving a few tenths of a second late, then the
    // smoke that stays behind and drifts off with the wind. Burnt-fuel smoke
    // is close to black (albedo ~0.05) and a big blast's cloud hangs for most
    // of a minute.
    const smokeLife = blastSmokeLife(R);
    const nShell = Math.round((10 + R * 0.25) * q);
    for (let i = 0; i < nShell; i++) {
      randDir(_d);
      if (ground) _d.y = Math.abs(_d.y) * 0.8 + 0.2;
      const r0 = R * rnd(0.55, 0.85), sp = R * rnd(0.8, 1.6);
      lit.spawn(L.smoke, x + _d.x * r0, y + _d.y * r0, z + _d.z * r0, _d.x * sp + ivx, _d.y * sp + 1 + ivy, _d.z * sp + ivz,
        smokeLife * rnd(0.85, 1.1), R * 0.8 * k, R * rnd(2.2, 3.0) * k, 0.045, 0.043, 0.041, 0.92, 0, -rnd(0.12, 0.4));
    }
    const nSmoke = Math.round((5 + R * 0.08) * q);
    for (let i = 0; i < nSmoke; i++) {
      randDir(_d);
      if (ground) _d.y = Math.abs(_d.y);
      lit.spawn(L.smoke, x + _d.x * R * 0.4, y + _d.y * R * 0.4, z + _d.z * R * 0.4, _d.x * R * 0.3 + ivx, _d.y * R * 0.3 + 2 + ivy, _d.z * R * 0.3 + ivz,
        smokeLife * rnd(0.9, 1.15), R * 1.1 * k, R * rnd(2.6, 3.6) * k, 0.06, 0.058, 0.055, 0.85, 0, -rnd(0.5, 1.0));
    }

    // 4. sparks
    if (lod > 0.4) {
      const nSpark = Math.round((28 + R * 2) * q);
      for (let i = 0; i < nSpark; i++) {
        randDir(_d);
        if (ground) _d.y = Math.abs(_d.y);
        const sp = R * rnd(3, 13);
        glow.spawn(G.spark, x, y, z, _d.x * sp + ivx * 2, _d.y * sp + ivy * 2, _d.z * sp + ivz * 2,
          rnd(0.5, 1.6), rnd(0.12, 0.3) * big, 0.03, 1, 0.6, 0.2, 1, rnd(6, 20));
      }
    }

    // 5. shock: barely visible as such (it was a bright ring that read as a
    // lens halo). What a camera sees is refraction (the pressure bubble,
    // stronger now) and, in humid air only, a brief condensation shell.
    glow.spawn(G.ring, x, y, z, 0, 0, 0, 0.35, R * 1.2, R * 9, 1, 0.92, 0.82, 1, 0.1);
    const hum = v.game.env?.weather?.humidity ?? 0.3;
    if (hum > 0.7 && lod === 1) {
      const wet = Math.min(1, (hum - 0.7) / 0.25);
      for (let i = 0; i < 10; i++) {
        randDir(_d);
        if (ground) _d.y = Math.abs(_d.y);
        const r0 = R * 1.6;
        lit.spawn(L.wisp, x + _d.x * r0, y + _d.y * r0, z + _d.z * r0, _d.x * R * 9, _d.y * R * 9, _d.z * R * 9,
          0.3, R * 1.2, R * 2.4, 1, 1, 1, 0.3 * wet, 0, -0.02);
      }
    }

    // 6. debris with smoke trails
    if (lod === 1 && R >= 6) {
      const nDeb = Math.round(clamp(3 + R / 4, 3, 10) * v.cfg.rate);
      for (let i = 0; i < nDeb; i++) {
        randDir(_d);
        if (ground) _d.y = Math.abs(_d.y) * 0.8 + 0.3;
        const sp = rnd(25, 95) * (0.7 + 0.3 * big);
        _t.set(_d.x * sp + (velocity?.x ?? 0) * 0.7, _d.y * sp + (velocity?.y ?? 0) * 0.7, _d.z * sp + (velocity?.z ?? 0) * 0.7);
        this.spawnDebris(_p.set(x, y, z), _t, rnd(0.5, 1.3) * big);
      }
    }

    // 7. ground: dark soil thrown up in spikes, clods raining back out of
    // them, a rolling dust skirt, a scorch, a fire that keeps smoking.
    // (Dry topsoil photographs at an albedo of 0.12-0.18; it was 0.3, a pale
    // beige dome.)
    if (ground) {
      const snow = y > SNOW_LINE;
      const cr = snow ? 0.88 : 0.11, cg = snow ? 0.89 : 0.095, cb = snow ? 0.93 : 0.075;
      const nSpike = Math.max(4, Math.round(rnd(8, 12) * q));
      for (let i = 0; i < nSpike; i++) {
        // jets fan out within ~40 degrees of the surface normal
        randDir(_d);
        _t.copy(_n).addScaledVector(_d, rnd(0.25, 0.75)).normalize();
        const top = R * rnd(4, 7.5);
        for (let j = 0; j < 4; j++) {
          const f = 0.35 + 0.65 * (j / 3);
          lit.spawn(L.spike, x + _t.x * R * 0.2, y + 0.3, z + _t.z * R * 0.2, _t.x * top * f, _t.y * top * f, _t.z * top * f,
            rnd(2.2, 3.4) * (0.7 + R / 44), R * 0.22 * k, R * rnd(0.7, 1.0) * k, cr * 0.75, cg * 0.75, cb * 0.75, 0.95, 0, -rnd(0.02));
        }
      }
      const nClump = Math.round(28 * q);
      for (let i = 0; i < nClump; i++) {
        randDir(_d);
        _t.copy(_n).addScaledVector(_d, rnd(0.3, 1.1)).normalize();
        const sp = R * rnd(1.8, 4.8);
        const c = R * rnd(0.04, 0.09);
        lit.spawn(L.clump, x, y + 0.5, z, _t.x * sp, _t.y * sp, _t.z * sp, rnd(1.8, 3.4), c, c * 1.15,
          cr * 0.55, cg * 0.55, cb * 0.55, 1, 0);
      }
      const nCol = Math.round(14 * q);
      for (let i = 0; i < nCol; i++) {
        randDir(_d);
        const up = R * rnd(1.2, 3.4), lat = R * rnd(0.3, 1.1);
        lit.spawn(L.dust, x + _d.x * R * 0.4, y + 0.5, z + _d.z * R * 0.4,
          _n.x * up + _d.x * lat, _n.y * up + Math.abs(_d.y) * lat, _n.z * up + _d.z * lat,
          rnd(2.8, 5) * (0.7 + R / 44), R * 0.5 * k, R * rnd(1.5, 2.4) * k, cr, cg, cb, 0.85, 0, -rnd(0.08));
      }
      const nSkirt = Math.round(14 * q);
      for (let i = 0; i < nSkirt; i++) {
        const a = (i / nSkirt) * Math.PI * 2 + rnd(0.4);
        _t.set(Math.cos(a), 0, Math.sin(a));
        _t.addScaledVector(_n, -_t.dot(_n)).normalize();
        const sp = R * rnd(2.0, 4.2);
        lit.spawn(L.groundDust, x + _t.x * R * 0.5, y + R * 0.12, z + _t.z * R * 0.5, _t.x * sp, _t.y * sp + 1, _t.z * sp,
          rnd(4, 8), R * 0.7 * k, R * rnd(2.0, 3.0) * k, cr * 1.25, cg * 1.25, cb * 1.25, 0.55, 0, -rnd(0.1));
      }
      v.scorches?.add(x, surfaceY, z, R * 1.3, v.shared.time);
      if (R >= 12) v.spawnFire(_p.set(x, surfaceY, z), { size: R * 0.2, duration: R >= 24 ? Infinity : 150 });
    }

    // 8. camera shake for anyone listening
    const shake = clamp((Rl * 16) / Math.max(dist, 20), 0, 1);
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

  /** A wreck's hulk gives its piece back (only if the pool has not recycled it). */
  releaseDebris(d, owner) {
    if (!d || d.owner !== owner || !d.active) return;
    d.owner = null;
    d.trail?.end(); d.trail = null;
    this.debris.release(d);
  }

  /**
   * A tumbling piece. With `owner` ({pos, vel}, a falling wreck) the piece is
   * carried by it instead of flying on its own, and leaves no trail of its own.
   */
  spawnDebris(pos, vel, scale = 1, owner = null) {
    const d = this.debris.acquire();
    d.trail?.end(); d.trail = null;
    d.owner = owner;
    if (owner) {
      d.pos.copy(pos); d.vel.copy(vel);
      randDir(d.axis); d.spin = rnd(2, 5); d.quat.identity();
      d.age = 0; d.life = 1e9; d.scale = scale; d.burn = 1e9;
      return d;
    }
    d.pos.copy(pos); d.vel.copy(vel);
    randDir(d.axis); d.spin = rnd(4, 14); d.quat.identity();
    d.age = 0; d.life = rnd(3.5, 6.5); d.scale = scale; d.burn = rnd(1.2, 3);
    const st = this.vfx.TRAILS.debris;
    d.trail = this.vfx.ribbons.create({ ...st, radius: st.radius * scale, growth: st.growth * scale, spacing: st.spacing * this.vfx.cfg.spacing });
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
      v.heat(_p, _p, p.R * (2 + 9 * t), (1 - t) * 2.0);
    }

    let n = 0;
    const mesh = this.debrisMesh;
    for (const d of this.debris.items) {
      if (!d.active) continue;
      if (d.owner) {
        d.pos.copy(d.owner.pos);
        _q.setFromAxisAngle(d.axis, d.spin * dt);
        d.quat.premultiply(_q);
        _m.compose(d.pos, d.quat, _s.setScalar(d.scale));
        mesh.setMatrixAt(n++, _m);
        continue;
      }
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
        glow.spawn(G.glow, d.pos.x, d.pos.y, d.pos.z, d.vel.x, d.vel.y, d.vel.z, Math.max(dt * 2.5, 0.04), 1.4 * d.scale, 1.0 * d.scale, 1, 0.5, 0.15, 1, 6 * hot);
        // the burning head: short flame tongues torn off the piece (glow, gone
        // in a fraction of a second: long-lived hot smoke puffs here read as a
        // string of glowing beads down the trail)
        if (Math.random() < dt * 30) glow.spawn(G.fire, d.pos.x, d.pos.y, d.pos.z, d.vel.x * 0.7, d.vel.y * 0.7, d.vel.z * 0.7, rnd(0.12, 0.25), 0.9 * d.scale, 1.8 * d.scale, 1, 0.52, 0.17, 1, 2.2 * hot);
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

  /** One zero-scale debris instance so its (lit, shadowed) pipelines exist before the first blast. */
  prewarm() {
    const mesh = this.debrisMesh;
    if (mesh.count > 0) return;
    _m.makeScale(0, 0, 0);
    mesh.setMatrixAt(0, _m);
    mesh.count = 1;
    mesh.visible = true;
    mesh.instanceMatrix.needsUpdate = true;
  }

  dispose() {
    this.debrisMesh.removeFromParent();
    this.debrisMesh.geometry.dispose();
    this.debrisMesh.material.dispose();
  }
}
