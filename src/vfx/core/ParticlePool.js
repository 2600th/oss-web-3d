import * as THREE from 'three/webgpu';
import {
  Fn, If, float, int, vec2, vec3, vec4, instancedArray, instanceIndex, uniformArray, hash, exp, sin, cos,
  mix, smoothstep, select, positionGeometry, positionView, uv, texture, varying, dot, length, max, pow, floor,
  saturate,
} from 'three/tsl';
import { Ring, DirtyRanges } from './ring.js';
import { fireRamp } from './shared.js';

const MAX_TYPES = 24;
const TYPE_STRIDE = 3; // vec4 rows per type
// The type index rides in the life channel (type * LIFE_SPAN + life) so the
// compute pass needs only four buffers: three's WebGL2 fallback runs compute as
// transform feedback, which allows at most four separate outputs.
const LIFE_SPAN = 64;

/**
 * GPU particle pool.
 *
 *  - Spawning is CPU-side into a ring of `capacity` slots: four vec4 "spawn"
 *    storage buffers (position+birth, velocity+life, sizes+extra+type, colour)
 *    are written with partial uploads, so a spawn costs 16 floats.
 *  - Simulation is a compute pass over separate "state" buffers (position,
 *    velocity). A slot whose state stamp differs from its spawn birth time is
 *    (re)initialised on the GPU, then integrated every frame: exponential drag
 *    toward the wind, buoyancy/gravity, and a turbulence field.
 *  - Per-type dynamics and look live in a small uniform table, so effects are
 *    data: `pool.type({...})` returns the index you pass to `spawn`.
 *
 * Two flavours share all of that and differ only in the material:
 *   'lit'  — six-way-lightmap smoke/fire, premultiplied alpha (smoke occludes,
 *            fire adds), sun + sky lit, soft depth fade.
 *   'glow' — additive sparks, flashes, rings, flames, tracers; velocity
 *            stretched, with a minimum on-screen size so distant lights read.
 */
export class ParticlePool {
  constructor(shared, capacity, flavour = 'lit') {
    this.shared = shared;
    this.capacity = capacity;
    this.flavour = flavour;
    this.ring = new Ring(capacity);
    this.dirty = new DirtyRanges(capacity, 4);
    this.types = [];
    this.spawned = 0;

    const N = capacity;
    // CPU-written spawn records
    this.aData = new Float32Array(N * 4); // pos.xyz, birth
    this.bData = new Float32Array(N * 4); // vel.xyz, life
    this.cData = new Float32Array(N * 4); // size0, size1, extra (lit: heat, glow: intensity), type
    this.dData = new Float32Array(N * 4); // rgb, alpha
    for (let i = 0; i < N; i++) this.aData[i * 4 + 3] = -1e6;
    this.spawnA = instancedArray(this.aData, 'vec4');
    this.spawnB = instancedArray(this.bData, 'vec4');
    this.spawnC = instancedArray(this.cData, 'vec4');
    this.spawnD = instancedArray(this.dData, 'vec4');
    // GPU-owned state
    this.statePos = instancedArray(N, 'vec4'); // xyz, birth stamp
    this.stateVel = instancedArray(N, 'vec4');

    this._table = [];
    for (let i = 0; i < MAX_TYPES * TYPE_STRIDE; i++) this._table.push(new THREE.Vector4());
    this.table = uniformArray(this._table, 'vec4');

    this._buildCompute();
    this.mesh = this._buildMesh();
  }

  /**
   * Register a particle type. Common: drag (1/s), gravity (m/s², +up = buoyant),
   * turbulence (m/s²), turbScale (1/m), wind (0..1 coupling), sizePow, fadeIn,
   * fadeOut (fractions of life). lit: heatDecay (1/s), soft (depth-fade scale),
   * spin (rad/s), thin (0 = self-shadowed smoke, 1 = bright vapour). glow: shape (0 dot, 1 spark, 2 ring, 3 flash, 4 flame),
   * stretch (s of motion blur), minPixels, flicker.
   */
  type(p = {}) {
    const i = this.types.length;
    if (i >= MAX_TYPES) throw new Error('vfx: too many particle types');
    this.types.push(p);
    const r = i * TYPE_STRIDE;
    this._table[r].set(p.drag ?? 0.5, p.gravity ?? 0, p.turbulence ?? 0, p.turbScale ?? 0.05);
    this._table[r + 1].set(p.wind ?? 0, p.sizePow ?? 0.5, p.fadeIn ?? 0.05, p.fadeOut ?? 0.5);
    if (this.flavour === 'lit') this._table[r + 2].set(p.heatDecay ?? 2, p.soft ?? 0.35, p.spin ?? 0.3, p.thin ?? 0);
    else this._table[r + 2].set(p.shape ?? 0, p.stretch ?? 0, p.minPixels ?? 0, p.flicker ?? 0);
    return i;
  }

  /** Hot path: no allocations. `age0` > 0 back-dates the birth (sub-frame), < 0 delays it. */
  spawn(type, x, y, z, vx, vy, vz, life, size0, size1, r, g, b, a, extra = 0, age0 = 0) {
    const i = this.ring.next();
    const o = i * 4;
    const A = this.aData, B = this.bData, C = this.cData, D = this.dData;
    A[o] = x; A[o + 1] = y; A[o + 2] = z; A[o + 3] = this.shared.time - age0;
    B[o] = vx; B[o + 1] = vy; B[o + 2] = vz; B[o + 3] = type * LIFE_SPAN + Math.min(life, LIFE_SPAN - 0.1);
    C[o] = size0; C[o + 1] = size1; C[o + 2] = extra; C[o + 3] = type;
    D[o] = r; D[o + 1] = g; D[o + 2] = b; D[o + 3] = a;
    this.dirty.mark(i);
    this.spawned++;
    return i;
  }

  /** Upload this frame's spawns and run the simulation step. */
  update(renderer) {
    if (!this.dirty.empty) {
      const ranges = this.dirty.flush();
      // A and B are bound by the compute pass below: uploaded (and their ranges
      // cleared by the backend) right now.
      for (const node of [this.spawnA, this.spawnB]) {
        const attr = node.value;
        for (const [s, c] of ranges) attr.addUpdateRange(s * 4, c * 4);
        attr.needsUpdate = true;
      }
      // C and D are only read when drawing, so their ranges must accumulate
      // until a draw has actually consumed them (fast-forward, hidden tab).
      if (this._drawn) { this._full = false; this._drawn = false; }
      for (const node of [this.spawnC, this.spawnD]) {
        const attr = node.value;
        if (!this._full) for (const [s, c] of ranges) attr.addUpdateRange(s * 4, c * 4);
        attr.needsUpdate = true;
      }
      if (!this._full && this.spawnC.value.updateRanges.length > 64) {
        this.spawnC.value.clearUpdateRanges(); this.spawnD.value.clearUpdateRanges(); // empty list = full upload
        this._full = true;
      }
    }
    renderer.compute(this.computeNode);
  }

  _buildCompute() {
    const { time, dt, wind } = this.shared.u;
    const { spawnA, spawnB, statePos, stateVel, table } = this;
    this.computeNode = Fn(() => {
      const sA = spawnA.element(instanceIndex);
      const sB = spawnB.element(instanceIndex);
      const p = statePos.element(instanceIndex);
      const v = stateVel.element(instanceIndex);
      const birth = sA.w;
      const age = time.sub(birth);
      const typeF = floor(sB.w.div(LIFE_SPAN));
      const life = sB.w.sub(typeF.mul(LIFE_SPAN));
      If(p.w.notEqual(birth), () => {
        // (re)born: start from the spawn record, advanced by the sub-frame age
        v.assign(vec4(sB.xyz, 0));
        p.assign(vec4(sA.xyz.add(sB.xyz.mul(age.clamp(0, 0.05))), birth));
      }).ElseIf(age.greaterThanEqual(0).and(age.lessThan(life)), () => {
        const ti = int(typeF.add(0.5)).mul(TYPE_STRIDE);
        const t0 = table.element(ti);
        const t1 = table.element(ti.add(1));
        const vel = v.xyz.toVar();
        const target = wind.mul(t1.x);
        vel.assign(target.add(vel.sub(target).mul(exp(t0.x.mul(dt).negate()))));
        vel.y.addAssign(t0.y.mul(dt));
        // cheap divergence-light turbulence: two octaves of phase-shifted sines
        const ph = hash(float(instanceIndex).add(birth.mul(61.7))).mul(6.283);
        const q = p.xyz.mul(t0.w);
        const n1 = vec3(
          sin(q.y.mul(1.3).add(q.z.mul(0.7)).add(time.mul(0.9)).add(ph)),
          sin(q.z.mul(1.1).add(q.x.mul(0.9)).add(time.mul(1.1)).add(ph.mul(1.7))),
          sin(q.x.mul(1.2).add(q.y.mul(0.8)).add(time.mul(0.7)).add(ph.mul(2.3))),
        );
        const q2 = q.mul(2.7);
        const n2 = vec3(sin(q2.z.add(q2.y).add(ph)), sin(q2.x.add(q2.z).add(time)), sin(q2.y.add(q2.x).sub(ph)));
        vel.addAssign(n1.add(n2.mul(0.5)).mul(t0.z.mul(dt)));
        p.xyz.addAssign(vel.mul(dt));
        v.xyz.assign(vel);
      });
    })().compute(this.capacity).setName(`vfx ${this.flavour} particles`);
  }

  _buildMesh() {
    const material = this.flavour === 'lit' ? this._litMaterial() : this._glowMaterial();
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
    mesh.count = this.capacity;
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.name = `vfx-${this.flavour}`;
    mesh.onBeforeRender = () => { this._drawn = true; };
    return mesh;
  }

  /** Shared vertex-stage per-particle values. */
  _common() {
    const u = this.shared.u;
    const A = this.spawnA.toAttribute();
    const B = this.spawnB.toAttribute();
    const C = this.spawnC.toAttribute();
    const D = this.spawnD.toAttribute();
    const P = this.statePos.toAttribute();
    const V = this.stateVel.toAttribute();
    const age = u.time.sub(A.w);
    const typeF = floor(B.w.div(LIFE_SPAN));
    const life = B.w.sub(typeF.mul(LIFE_SPAN)).max(1e-4);
    const t = age.div(life).clamp(0, 1);
    // a slot is drawable once the compute pass has adopted its spawn record
    const alive = age.greaterThanEqual(0).and(age.lessThan(life)).and(P.w.equal(A.w));
    const ti = int(typeF.add(0.5)).mul(TYPE_STRIDE);
    const T1 = this.table.element(ti.add(1));
    const T2 = this.table.element(ti.add(2));
    const seed = hash(float(instanceIndex).add(A.w.mul(61.7)));
    const seed2 = hash(float(instanceIndex).mul(3).add(A.w.mul(17.3)).add(11));
    const size = mix(C.x, C.y, pow(t, T1.y));
    const fade = t.add(1e-4).div(T1.z.max(1e-4)).clamp(0, 1).mul(smoothstep(T1.w.min(0.999), 1, t).oneMinus());
    const center = P.xyz;
    const dist = length(center.sub(u.camPos)).max(0.01);
    return { u, A, B, C, D, P, V, age, life, t, alive, T1, T2, seed, seed2, size, fade, center, dist };
  }

  _blend(material, additive) {
    material.transparent = true;
    material.depthTest = false;   // the layer soft-clips against scene depth itself
    material.depthWrite = false;
    material.side = THREE.DoubleSide;
    material.blending = THREE.CustomBlending;
    material.blendEquation = THREE.AddEquation;
    material.blendSrc = THREE.OneFactor;
    material.blendDst = additive ? THREE.OneFactor : THREE.OneMinusSrcAlphaFactor;
    material.blendSrcAlpha = additive ? THREE.ZeroFactor : THREE.OneFactor;
    material.blendDstAlpha = additive ? THREE.OneFactor : THREE.OneMinusSrcAlphaFactor;
    material.fog = false;
    material.lights = false;
  }

  _litMaterial() {
    const sh = this.shared;
    const c = this._common();
    const { u } = c;
    const material = new THREE.NodeMaterial();
    this._blend(material, false);

    const angle = c.seed.mul(6.283).add(c.seed2.sub(0.5).mul(c.T2.z).mul(c.age));
    const ca = cos(angle), sa = sin(angle);
    const axisX = u.camRight.mul(ca).add(u.camUp.mul(sa));
    const axisY = u.camUp.mul(ca).sub(u.camRight.mul(sa));
    // keep big sprites from slamming through the camera, and drop sub-pixel ones
    const nearFade = smoothstep(0.6, c.size.mul(0.7).add(1.2), c.dist);
    const px = c.size.div(c.dist.mul(u.pixelAngle));
    const farFade = smoothstep(0.35, 1.3, px);
    const vis = c.fade.mul(nearFade).mul(farFade);
    const draw = select(c.alive.and(vis.greaterThan(0.002)), c.size, 0);
    material.positionNode = c.center
      .add(axisX.mul(positionGeometry.x.mul(draw)))
      .add(axisY.mul(positionGeometry.y.mul(draw)));

    const vVis = varying(vis);
    const vLight = varying(vec3(dot(u.sunDir, axisX), dot(u.sunDir, axisY), dot(u.sunDir, u.camFwd.negate())));
    const vColor = varying(c.D);
    const vHeat = varying(c.C.z.mul(exp(c.age.mul(c.T2.x).negate())));
    const vCell = varying(floor(c.seed2.mul(15.999)));
    const vSoft = varying(c.size.mul(c.T2.y).max(0.25));
    const vT = varying(c.t);
    const vThin = varying(c.T2.w);

    material.fragmentNode = Fn(() => {
      const cell = vCell.add(0.5).floor();
      const cuv = uv().clamp(0.01, 0.99).add(vec2(cell.mod(4), floor(cell.div(4)))).mul(0.25);
      const ta = texture(sh.tex.smokeA, cuv);
      const tb = texture(sh.tex.smokeB, cuv);
      // The baked puffs are soft; carve them with tiling billow noise so the
      // silhouette is crisp cauliflower rather than fog, and erodes with age.
      const dn = texture(sh.tex.noise, uv().mul(2.3).add(vec2(cell.mul(0.137), cell.mul(0.71)))).g;
      const dn2 = texture(sh.tex.noise, uv().mul(5.1).add(vec2(cell.mul(0.41), cell.mul(0.23)))).r;
      const cut = dn.mul(0.7).add(dn2.mul(0.3)).mul(vT.sub(0.25).max(0).mul(0.75).add(0.34));
      const shaped = saturate(ta.a.sub(cut).div(float(1).sub(cut)).mul(1.5));
      const gain = shaped.div(ta.a.max(1e-3));
      const L = vLight;
      const wp = max(L, 0), wn = max(L.negate(), 0);
      const shadowed = ta.r.mul(wp.x.mul(wp.x)).add(tb.r.mul(wn.x.mul(wn.x)))
        .add(ta.g.mul(wp.y.mul(wp.y))).add(tb.g.mul(wn.y.mul(wn.y)))
        .add(ta.b.mul(wp.z.mul(wp.z))).add(tb.b.mul(wn.z.mul(wn.z)));
      // thin media (vapour, light smoke) barely shadow themselves
      const sunLit = mix(shadowed, ta.a.mul(0.8), vThin);
      const side = ta.r.add(tb.r).add(ta.b).add(tb.b).mul(0.25);
      const amb = u.skyColor.mul(ta.g.mul(0.55).add(side.mul(0.45)))
        .add(u.groundColor.mul(tb.g.mul(0.55).add(side.mul(0.2))));
      // lighting channels are premultiplied by the baked alpha: rescale to the carved one
      const detail = dn2.mul(0.5).add(0.75);
      const lit = vColor.rgb.mul(u.sunColor.mul(sunLit).mul(1.0).mul(detail).add(amb.mul(0.45))).mul(gain);
      // fire: hot in the dense core, cooling to soot over life
      const heat = vHeat.mul(tb.a.mul(1.6).add(0.2)).mul(dn.mul(0.8).add(0.6));
      const fire = fireRamp(heat).mul(shaped);
      const depthFade = saturate(sh.sceneViewZ().sub(positionView.z.negate()).div(vSoft));
      const k = vVis.mul(depthFade).mul(u.fade);
      const alpha = shaped.mul(vColor.a).mul(k);
      return vec4(lit.mul(vColor.a).mul(k).add(fire.mul(k)), alpha);
    })();
    return material;
  }

  _glowMaterial() {
    const sh = this.shared;
    const c = this._common();
    const { u } = c;
    const material = new THREE.NodeMaterial();
    this._blend(material, true);

    const shape = c.T2.x, stretch = c.T2.y, minPx = c.T2.z, flicker = c.T2.w;
    const vrel = c.V.xyz.sub(u.camVel);
    const s2 = vec2(dot(vrel, u.camRight), dot(vrel, u.camUp));
    const sl = length(s2);
    const dir2 = select(sl.greaterThan(1e-3), s2.div(sl.max(1e-3)), vec2(1, 0));
    const streak = sl.mul(stretch).min(c.size.mul(60).add(4));
    const angle = c.seed.mul(6.283);
    const rot = vec2(cos(angle), sin(angle));
    const d = select(stretch.greaterThan(0), dir2, rot);
    const axisX = u.camRight.mul(d.x).add(u.camUp.mul(d.y));
    const axisY = u.camUp.mul(d.x).sub(u.camRight.mul(d.y));
    const minSize = minPx.mul(u.pixelAngle).mul(c.dist);
    const size = max(c.size, minSize);
    const draw = select(c.alive, float(1), float(0));
    const lenX = size.add(streak);
    material.positionNode = c.center
      .sub(axisX.mul(streak.mul(0.5)).mul(draw))
      .add(axisX.mul(positionGeometry.x.mul(lenX).mul(draw)))
      .add(axisY.mul(positionGeometry.y.mul(size).mul(draw)));

    const fl = float(1).sub(flicker.mul(hash(float(instanceIndex).add(u.time.mul(60).floor().mul(13.1)))));
    // conserve energy when a streak is stretched, loosely
    const energy = size.div(lenX).pow(0.35);
    const vCol = varying(c.D.rgb.mul(c.C.z).mul(c.fade).mul(fl).mul(energy).mul(c.D.a));
    const vShape = varying(shape);
    const vSoft = varying(size.mul(0.5).max(0.4));
    const vCell = varying(floor(c.seed2.mul(15.999)));

    material.fragmentNode = Fn(() => {
      const p = uv().mul(2).sub(1);
      const r2 = dot(p, p);
      const r = r2.sqrt();
      const dotS = exp(r2.mul(-4.5)).sub(0.011).max(0).add(exp(r2.mul(-40)).mul(1.5));
      const spark = exp(p.y.mul(p.y).mul(-9)).mul(float(1).sub(p.x.abs().pow(4)).max(0)).mul(p.x.mul(0.4).add(0.6))
        .mul(float(1).sub(p.y.abs()).max(0));
      const ringS = exp(r.sub(0.8).div(0.085).pow(2).negate()).add(exp(r.sub(0.8).div(0.3).pow(2).negate()).mul(0.12))
        .mul(smoothstep(0.92, 1, r).oneMinus());
      const star = exp(p.y.abs().mul(-22)).mul(exp(p.x.abs().mul(-3))).add(exp(p.x.abs().mul(-22)).mul(exp(p.y.abs().mul(-3))));
      const flash = exp(r2.mul(-7)).add(star.mul(0.6)).mul(smoothstep(0.7, 1, r).oneMinus());
      const cell = vCell.add(0.5).floor();
      const cuv = uv().clamp(0.01, 0.99).add(vec2(cell.mod(4), floor(cell.div(4)))).mul(0.25);
      const fa = texture(sh.tex.smokeA, cuv).a;
      const fb = texture(sh.tex.smokeB, cuv).a;
      const flame = fa.mul(fb.mul(1.6).add(0.15));
      const s = select(vShape.lessThan(0.5), dotS,
        select(vShape.lessThan(1.5), spark,
          select(vShape.lessThan(2.5), ringS,
            select(vShape.lessThan(3.5), flash, flame))));
      const depthFade = saturate(sh.sceneViewZ().sub(positionView.z.negate()).div(vSoft));
      return vec4(vCol.mul(s).mul(depthFade).mul(u.fade), 0);
    })();
    return material;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.computeNode.dispose?.();
  }
}
