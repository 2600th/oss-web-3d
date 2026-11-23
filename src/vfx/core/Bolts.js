import * as THREE from 'three/webgpu';
import {
  Fn, float, vec2, vec3, vec4, attribute, positionGeometry, cameraViewMatrix, cameraProjectionMatrix, varying,
  length, max, select, exp, saturate, abs, uniform,
} from 'three/tsl';
import { makeBolt } from './fxmath.js';

/**
 * Lightning channels: one additive view-facing capsule per channel segment.
 *
 * A strike (`weather:lightning`) builds a branching channel by midpoint
 * displacement (fxmath.makeBolt) from the cloud base down to the ground, and
 * the channel is lit by the weather's own flash envelope
 * (env.weather.lightning.intensity: the return strokes, a few hundredths of
 * a second apart, each a sharp rise and a fast fall) so the bolt and the lit
 * cloud pulse together and the restrikes reuse the same channel, as they do.
 *
 * Each segment is a white-violet core at least ~1.5 px wide (a 2 m channel is
 * sub-pixel at 10 km) inside a dim halo of scattered light, soft-clipped
 * against scene depth (a bolt behind a ridge is hidden by it) and attenuated
 * by cloud like everything else in the layer, which hides its top inside the
 * cloud deck.
 */
export class Bolts {
  constructor(shared, capacity = 320) {
    this.shared = shared;
    this.capacity = capacity;
    this.count = 0;
    this.segs = [];
    this.age = 0;
    this.peak = 0;
    this.active = false;

    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, -1, 0, 0, 1, 0, 1, -1, 0, 1, 1, 0]), 3));
    g.setIndex([0, 2, 1, 1, 2, 3]);
    this.a = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4); // xyz, half-width
    this.b = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4); // xyz, brightness
    g.setAttribute('bA', this.a);
    g.setAttribute('bB', this.b);
    g.instanceCount = 0;
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
    this.geometry = g;
    this.mesh = new THREE.Mesh(g, this._material());
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.visible = false;
    this.mesh.name = 'vfx-lightning';
  }

  /** A new strike: build its channel. `top` in the cloud, `bottom` on the ground. */
  strike(top, bottom, rng = Math.random) {
    const len = top.distanceTo(bottom);
    this.segs = makeBolt(rng, top, bottom, { depth: len > 3000 ? 7 : 6, rough: 0.2, branch: 0.25, width: 2.2 });
    if (this.segs.length > this.capacity) this.segs.length = this.capacity;
    const A = this.a.array, B = this.b.array;
    this.count = this.segs.length;
    for (let i = 0; i < this.count; i++) {
      const s = this.segs[i], o = i * 4;
      A[o] = s.a[0]; A[o + 1] = s.a[1]; A[o + 2] = s.a[2]; A[o + 3] = s.w;
      B[o] = s.b[0]; B[o + 1] = s.b[1]; B[o + 2] = s.b[2]; B[o + 3] = s.k;
    }
    this.a.needsUpdate = true; this.b.needsUpdate = true;
    this.geometry.instanceCount = this.count;
    this.age = 0;
    this.peak = 0;
    this.active = true;
  }

  /** `flash`: the strike's current brightness (0..1, env.weather.lightning.intensity). */
  update(dt, flash) {
    if (!this.active) { this.mesh.visible = false; return; }
    this.age += dt;
    this.peak = Math.max(this.peak, flash);
    // the weather's flash can lag our event by a frame; give it 0.15 s to start
    const lit = this.peak > 0 ? flash / Math.max(this.peak, 0.3) : (this.age < 0.15 ? 1 : 0);
    this.u.value = Math.max(0, lit);
    if ((this.age > 0.15 && flash < 0.004) || this.age > 2) { this.active = false; this.u.value = 0; }
    this.mesh.visible = this.active && this.count > 0;
  }

  /** Draw one dark instance so the pipeline exists before the first strike (VfxSystem.prewarm). */
  prewarm() {
    if (this.active) return;
    this.geometry.instanceCount = 1;
    this.mesh.visible = true;
    this.u.value = 0;
  }

  _material() {
    const sh = this.shared, u = sh.u;
    const amp = this.u = uniform(0);
    const m = new THREE.NodeMaterial();
    m.transparent = true; m.depthTest = false; m.depthWrite = false; m.side = THREE.DoubleSide;
    m.blending = THREE.CustomBlending;
    m.blendSrc = THREE.OneFactor; m.blendDst = THREE.OneFactor;
    m.blendSrcAlpha = THREE.ZeroFactor; m.blendDstAlpha = THREE.OneFactor;
    m.fog = false; m.lights = false;

    const bA = attribute('bA', 'vec4'), bB = attribute('bB', 'vec4');
    const toView = (p) => cameraViewMatrix.mul(vec4(p, 1)).xyz;
    const av = toView(bA.xyz), bv = toView(bB.xyz);
    const seg = av.xy.div(av.z.negate().max(0.05)).sub(bv.xy.div(bv.z.negate().max(0.05)));
    const segLen = length(seg);
    const dir2 = select(segLen.greaterThan(1e-6), seg.div(segLen.max(1e-6)), vec2(1, 0));
    const perp = vec2(dir2.y.negate(), dir2.x);
    const e = positionGeometry.x, side = positionGeometry.y;
    const c = av.add(bv.sub(av).mul(e));
    const inFront = av.z.lessThan(-1).and(bv.z.lessThan(-1));
    const dist = length(c);
    // core half-width: the channel, never under ~0.8 px; the quad is wide
    // enough for the halo around it
    const core = max(bA.w.mul(0.5), u.pixelAngle.mul(0.6).mul(dist));
    const halfW = core.mul(5).mul(select(inFront, float(1), float(0)));
    // overlap the ends a little so the joints do not show gaps
    const ext = core.mul(1.5);
    const viewPos = c.add(vec3(dir2.mul(e.mul(2).sub(1)).mul(ext).add(perp.mul(side).mul(halfW)), 0));
    m.vertexNode = cameraProjectionMatrix.mul(vec4(viewPos, 1));

    const vPos = varying(viewPos);
    const vS = varying(side);
    // a channel widened to a pixel keeps its total light, not its radiance
    const vGain = varying(bA.w.div(core.max(1e-4)).pow(0.5).mul(bB.w));

    m.fragmentNode = Fn(() => {
      const x = abs(vS).mul(5);          // distance across in core half-widths
      const coreI = exp(x.mul(x).mul(-1.5));
      const halo = exp(x.mul(-0.9)).mul(0.025).mul(float(1).sub(abs(vS)));
      const col = vec3(0.86, 0.88, 1).mul(coreI.mul(70)).add(vec3(0.62, 0.66, 1).mul(halo.mul(40)));
      const d = length(vPos);
      const depthFade = saturate(sh.sceneViewZ().sub(vPos.z.negate()).div(40));
      return vec4(col.mul(vGain).mul(amp).mul(depthFade).mul(u.fade).mul(sh.cloudVisAt(d)), 0);
    })();
    return m;
  }

  dispose() {
    this.geometry.dispose();
    this.mesh.material.dispose();
  }
}
