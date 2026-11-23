import * as THREE from 'three/webgpu';
import {
  Fn, float, vec2, vec3, vec4, attribute, positionGeometry, cameraViewMatrix, cameraProjectionMatrix, varying,
  length, max, mix, select, exp, saturate, smoothstep,
} from 'three/tsl';

const _v = new THREE.Vector3();
const G = 9.81;

/**
 * Gun tracers: one additive streak per live round.
 *
 * The rounds themselves belong to combat (`CombatWorld.bullets`, a
 * structure-of-arrays the hit tests run on), so what you see is exactly what
 * can hit. Each round is drawn as a view-facing streak from its position back
 * along its velocity by one shutter time, never further than the muzzle it
 * left, at least a pixel and a half wide so it survives distance, soft-clipped
 * against scene depth and attenuated by cloud like the rest of the layer.
 *
 * `fire(position, velocity)` adds a free-flying visual-only round (dev harness,
 * ground guns that do not go through CombatWorld).
 */
export class Tracers {
  constructor(shared, capacity = 896) {
    this.shared = shared;
    this.capacity = capacity;
    this.count = 0;
    this.shutter = 1 / 42; // seconds of flight a streak covers
    this.free = [];        // visual-only rounds: {x,y,z,vx,vy,vz,life,hostile}

    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, -1, 0, 0, 1, 0, 1, -1, 0, 1, 1, 0]), 3));
    g.setIndex([0, 2, 1, 1, 2, 3]);
    this.head = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4); // xyz, hostile
    this.tail = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4); // xyz, brightness
    this.head.setUsage(THREE.DynamicDrawUsage);
    this.tail.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('tH', this.head);
    g.setAttribute('tT', this.tail);
    g.instanceCount = 0;
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
    this.geometry = g;

    this.mesh = new THREE.Mesh(g, this._material());
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.visible = false;
    this.mesh.name = 'vfx-tracers';
  }

  /** A visual-only round. */
  fire(position, velocity, hostile = false, life = 1.6) {
    if (this.free.length > 160) this.free.shift();
    this.free.push({ x: position.x, y: position.y, z: position.z, vx: velocity.x, vy: velocity.y, vz: velocity.z, life, age: 0, hostile: hostile ? 1 : 0 });
  }

  _push(x, y, z, vx, vy, vz, hostile, maxLen) {
    if (this.count >= this.capacity) return;
    const sp = Math.hypot(vx, vy, vz);
    if (sp < 1) return;
    const len = Math.min(sp * this.shutter, maxLen);
    if (len < 0.5) return;
    const k = len / sp;
    const i = this.count++ * 4;
    const h = this.head.array, t = this.tail.array;
    h[i] = x; h[i + 1] = y; h[i + 2] = z; h[i + 3] = hostile;
    t[i] = x - vx * k; t[i + 1] = y - vy * k; t[i + 2] = z - vz * k; t[i + 3] = 1;
  }

  /** `bullets`: CombatWorld's SoA ({n, px, py, pz, vx, vy, vz, hostile, owner}) or null. */
  update(bullets, dt) {
    this.count = 0;
    if (bullets) {
      const n = Math.min(bullets.n, this.capacity);
      for (let i = 0; i < n; i++) {
        const x = bullets.px[i], y = bullets.py[i], z = bullets.pz[i];
        // the streak must not reach back past the gun that fired it
        const o = bullets.owner?.[i]?.position;
        const maxLen = o ? _v.set(x, y, z).distanceTo(o) * 0.85 : 1e9;
        this._push(x, y, z, bullets.vx[i], bullets.vy[i], bullets.vz[i], bullets.hostile[i] ? 1 : 0, maxLen);
      }
    }
    for (let i = this.free.length - 1; i >= 0; i--) {
      const f = this.free[i];
      if (dt > 0) {
        f.age += dt;
        f.vy -= G * 0.35 * dt;
        f.x += f.vx * dt; f.y += f.vy * dt; f.z += f.vz * dt;
      }
      if (f.age >= f.life) { this.free.splice(i, 1); continue; }
      this._push(f.x, f.y, f.z, f.vx, f.vy, f.vz, f.hostile, Math.hypot(f.vx, f.vy, f.vz) * f.age);
    }
    this.geometry.instanceCount = this.count;
    this.mesh.visible = this.count > 0;
    if (this.count > 0) {
      this.head.clearUpdateRanges(); this.head.addUpdateRange(0, this.count * 4); this.head.needsUpdate = true;
      this.tail.clearUpdateRanges(); this.tail.addUpdateRange(0, this.count * 4); this.tail.needsUpdate = true;
    }
  }

  _material() {
    const sh = this.shared, u = sh.u;
    const m = new THREE.NodeMaterial();
    m.transparent = true; m.depthTest = false; m.depthWrite = false; m.side = THREE.DoubleSide;
    m.blending = THREE.CustomBlending;
    m.blendSrc = THREE.OneFactor; m.blendDst = THREE.OneFactor;
    m.blendSrcAlpha = THREE.ZeroFactor; m.blendDstAlpha = THREE.OneFactor;
    m.fog = false; m.lights = false;

    const tH = attribute('tH', 'vec4'), tT = attribute('tT', 'vec4');
    const toView = (p) => cameraViewMatrix.mul(vec4(p, 1)).xyz;
    const hv = toView(tH.xyz), tv = toView(tT.xyz);
    // screen-space direction from the projected ends (see Ribbons)
    const seg = hv.xy.div(hv.z.negate().max(0.05)).sub(tv.xy.div(tv.z.negate().max(0.05)));
    const segLen = length(seg);
    const dir2 = select(segLen.greaterThan(1e-6), seg.div(segLen.max(1e-6)), vec2(1, 0));
    const perp = vec2(dir2.y.negate(), dir2.x);
    const e = positionGeometry.x, side = positionGeometry.y;
    const c = mix(tv, hv, e);
    const inFront = hv.z.lessThan(-0.4).and(tv.z.lessThan(-0.4));
    // half-width: 9 cm of glowing round, never under ~1.6 px across
    const r0 = float(0.09);
    const r = max(r0, u.pixelAngle.mul(0.8).mul(length(c))).mul(select(inFront, float(1), float(0)));
    const viewPos = c.add(vec3(dir2.mul(e.mul(2).sub(1)).add(perp.mul(side)).mul(r), 0));
    m.vertexNode = cameraProjectionMatrix.mul(vec4(viewPos, 1));

    const vPos = varying(viewPos);
    const vE = varying(e), vS = varying(side);
    // widening a sub-pixel round keeps its total light, not its radiance
    const vGain = varying(r0.div(r.max(1e-4)).pow(0.6).mul(tT.w));
    const vHostile = varying(tH.w);

    m.fragmentNode = Fn(() => {
      const across = exp(vS.mul(vS).mul(-5.5));
      const core = exp(vS.mul(vS).mul(-40));
      // bright head, tail falling away: the eye's (and the shutter's) persistence
      const along = smoothstep(0, 0.25, vE).mul(mix(float(0.12), float(1), vE.mul(vE))).mul(smoothstep(1, 0.93, vE).mul(0.4).add(0.6));
      const friendly = vec3(1.0, 0.66, 0.26), hostile = vec3(1.0, 0.24, 0.1);
      const col = mix(friendly, hostile, vHostile).mul(across.mul(22)).add(vec3(1, 0.93, 0.8).mul(core.mul(vE).mul(26)));
      const dist = length(vPos);
      const depthFade = saturate(sh.sceneViewZ().sub(vPos.z.negate()).div(1.5));
      return vec4(col.mul(along).mul(vGain).mul(depthFade).mul(u.fade).mul(sh.cloudVisAt(dist)), 0);
    })();
    return m;
  }

  dispose() {
    this.geometry.dispose();
    this.mesh.material.dispose();
  }
}
