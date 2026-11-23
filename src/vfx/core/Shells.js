import * as THREE from 'three/webgpu';
import {
  Fn, float, vec2, vec3, vec4, attribute, positionGeometry, positionView, uv, varying, normalize, dot, cross, abs, mix,
  select, cos, exp, pow, smoothstep, saturate, texture, sqrt, max, min, length, atan, fract, screenCoordinate,
} from 'three/tsl';

/** Ray-marched samples through an afterburner plume (jittered per pixel, so no banding). */
const PLUME_SAT = 4; // luminance a plume tends to however long the chord
const PLUME_STEPS = 10;
/** Shock cells drawn at most. */
const MAX_DISKS = 5;

/**
 * Axisymmetric shells attached to things: afterburner plumes, the glowing
 * nozzle ring, and transonic vapour cones. One instanced draw per kind; an
 * instance is an origin, an axis and four parameters, so nothing here cares
 * how the owner is oriented or parented.
 *
 * plume  params: x = core brightness, y = shock diamonds (count), z = glow, w = reheat (0..1)
 *        (origin = nozzle exit centre, length = flame length, radius = nozzle radius)
 * ring   params: x = brightness, z = glow
 * vapour params: x = amount, y = start radius, z = end radius
 *
 * The plume is a volume: its bounding cylinder is rasterised by its back
 * faces only, and each pixel integrates emission along the view ray's chord
 * through the jet (a flame core, a train of Mach disks and a turbulent outer
 * flame, all functions of axial distance and radius). A ray down the axis
 * crosses the most gas, so the plume is brightest seen from dead six -- it
 * used to be a pair of cones shaded by `facing`, which is ~0 end-on, so it
 * vanished from behind.
 */
export class Shells {
  constructor(shared, capacity, mode) {
    this.shared = shared;
    this.capacity = capacity;
    this.mode = mode;
    this.count = 0;
    const closed = mode === 'plume';
    const g = new THREE.CylinderGeometry(1, 1, 1, closed ? 16 : 24, closed ? 1 : 20, !closed);
    g.rotateX(Math.PI / 2);
    g.translate(0, 0, 0.5);
    this.o = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4); // origin, length
    this.d = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4); // axis, radius
    this.q = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4); // params
    for (const a of [this.o, this.d, this.q]) a.setUsage(THREE.DynamicDrawUsage);
    const ig = new THREE.InstancedBufferGeometry();
    ig.index = g.index;
    ig.setAttribute('position', g.getAttribute('position'));
    ig.setAttribute('uv', g.getAttribute('uv'));
    ig.setAttribute('sO', this.o); ig.setAttribute('sD', this.d); ig.setAttribute('sQ', this.q);
    ig.instanceCount = 0;
    this.geometry = ig;
    const mat = mode === 'plume' ? this._plume() : mode === 'ring' ? this._ring() : this._vapour();
    this.mesh = new THREE.Mesh(ig, mat);
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.name = `vfx-${mode}`;
  }

  begin() { this.count = 0; }

  add(origin, axis, length, radius, a = 0, b = 0, c = 0, d = 0) {
    if (this.count >= this.capacity) return;
    const i = this.count++ * 4;
    const o = this.o.array, dd = this.d.array, q = this.q.array;
    o[i] = origin.x; o[i + 1] = origin.y; o[i + 2] = origin.z; o[i + 3] = length;
    dd[i] = axis.x; dd[i + 1] = axis.y; dd[i + 2] = axis.z; dd[i + 3] = radius;
    q[i] = a; q[i + 1] = b; q[i + 2] = c; q[i + 3] = d;
  }

  end() {
    this.geometry.instanceCount = this.count;
    this.mesh.visible = this.count > 0;
    if (this.count > 0) { this.o.needsUpdate = true; this.d.needsUpdate = true; this.q.needsUpdate = true; }
  }

  /** Draw one zero-sized instance so the pipeline exists before it is needed (VfxSystem.prewarm). */
  prewarm() {
    if (this.count > 0) return;
    this.o.array.fill(0, 0, 4); this.d.array.set([0, 0, 1, 0], 0); this.q.array.fill(0, 0, 4);
    this.o.needsUpdate = this.d.needsUpdate = this.q.needsUpdate = true;
    this.geometry.instanceCount = 1;
    this.mesh.visible = true;
  }

  _frame() {
    const sO = attribute('sO', 'vec4'), sD = attribute('sD', 'vec4'), sQ = attribute('sQ', 'vec4');
    const axis = normalize(sD.xyz);
    const ref = select(abs(axis.y).greaterThan(0.99), vec3(1, 0, 0), vec3(0, 1, 0));
    const t1 = normalize(cross(axis, ref));
    const t2 = cross(axis, t1);
    const z = positionGeometry.z;
    const radial = t1.mul(positionGeometry.x).add(t2.mul(positionGeometry.y));
    return { sO, sD, sQ, axis, z, radial, t1, t2 };
  }

  _base(additive) {
    const m = new THREE.NodeMaterial();
    m.transparent = true; m.depthTest = false; m.depthWrite = false; m.side = THREE.DoubleSide;
    m.blending = THREE.CustomBlending;
    m.blendSrc = THREE.OneFactor;
    m.blendDst = additive ? THREE.OneFactor : THREE.OneMinusSrcAlphaFactor;
    m.blendSrcAlpha = additive ? THREE.ZeroFactor : THREE.OneFactor;
    m.blendDstAlpha = additive ? THREE.OneFactor : THREE.OneMinusSrcAlphaFactor;
    m.fog = false; m.lights = false;
    return m;
  }

  /**
   * Afterburner plume: chord-integrated emission through the jet.
   *
   * In plume space (z along the jet from the exit plane, rho from the axis,
   * R the nozzle radius, zn = z / length):
   *   core   exp(-3 (rho / rc)^2) exp(-2.2 zn), rc = R (0.78 - 0.38 zn): the
   *          supersonic core, blue-white at the lip grading to yellow; HDR
   *          (~30-40 per metre at full reheat)
   *   disks  Mach disks every ~1.15 nozzle diameters, thin bright ellipsoids
   *          on the axis, each 0.78x the last
   *   flame  exp(-2 (rho / rf)^2) (1 - zn)^1.3 x turbulence, rf = R (1 + 0.3 zn):
   *          the orange mixing layer, red toward the tail
   * The bounding cylinder (radius 1.45 R) is drawn by its back faces; each
   * pixel finds where its ray enters, clips the far end against the scene
   * depth, and sums PLUME_STEPS jittered samples.
   */
  _plume() {
    const sh = this.shared, u = sh.u;
    const m = this._base(true);
    m.side = THREE.BackSide;
    const { sO, sD, sQ, axis, z, radial, t1, t2 } = this._frame();
    const BOUND = 1.45;
    const world = sO.xyz.add(axis.mul(z.mul(sO.w))).add(radial.mul(sD.w.mul(BOUND)));
    m.positionNode = world;
    const vWorld = varying(world);
    const vO = varying(sO), vR = varying(sD.w), vQ = varying(sQ);
    const vA = varying(axis), vT1 = varying(t1), vT2 = varying(t2);
    const vSeed = varying(sO.x.add(sO.z).mul(0.37).fract());

    m.fragmentNode = Fn(() => {
      const L = vO.w.max(0.05), R = vR.max(0.01), Rb = R.mul(BOUND);
      const ax = normalize(vA), e1 = normalize(vT1), e2 = normalize(vT2);
      const rel = vWorld.sub(u.camPos);
      const tBack = length(rel);
      const Dw = rel.div(tBack.max(1e-4));
      // ray in plume space
      const oc = u.camPos.sub(vO.xyz);
      const o = vec3(dot(oc, e1), dot(oc, e2), dot(oc, ax));
      const d = vec3(dot(Dw, e1), dot(Dw, e2), dot(Dw, ax));
      // entry: cylinder wall and the two end caps
      const qa = d.x.mul(d.x).add(d.y.mul(d.y)).max(1e-6);
      const qb = o.x.mul(d.x).add(o.y.mul(d.y));
      const qc = o.x.mul(o.x).add(o.y.mul(o.y)).sub(Rb.mul(Rb));
      const disc = qb.mul(qb).sub(qa.mul(qc));
      const tw0 = qb.negate().sub(sqrt(disc.max(0))).div(qa);
      const dzs = select(abs(d.z).lessThan(1e-5), float(1e-5), d.z);
      const tz0 = o.z.negate().div(dzs), tz1 = L.sub(o.z).div(dzs);
      const tEnter = max(max(tw0, min(tz0, tz1)), 0);
      // exit: the back face itself, or the opaque scene in front of it
      const sceneT = sh.sceneViewZ().div(dot(Dw, u.camFwd).max(1e-3));
      const tExit = min(tBack, sceneT);
      const span = tExit.sub(tEnter).max(0);
      const ds = span.div(PLUME_STEPS);
      // interleaved-gradient jitter of the sample positions
      const sc = screenCoordinate.xy;
      const jit = fract(fract(sc.x.mul(0.06711056).add(sc.y.mul(0.00583715))).mul(52.9829189));

      const core = vQ.x, nDisk = vQ.y, glow = vQ.z;
      const sp = R.mul(2.3);                 // shock-cell spacing: ~1.15 nozzle diameters
      const z0 = sp.mul(0.55);
      const diskAmt = saturate(nDisk.mul(0.4)).mul(core);
      const t = u.time;
      const acc = vec3(0).toVar();
      for (let i = 0; i < PLUME_STEPS; i++) {
        const s = tEnter.add(ds.mul(float(i).add(jit)));
        const p = o.add(d.mul(s));
        const zz = p.z, zn = saturate(zz.div(L));
        const rho2 = p.x.mul(p.x).add(p.y.mul(p.y));
        const rc = R.mul(float(0.78).sub(zn.mul(0.38)));
        const rf = R.mul(zn.mul(0.3).add(1));
        const inside = smoothstep(-0.02, 0.06, zz).mul(smoothstep(L, L.mul(0.86), zz));
        const coreD = exp(rho2.div(rc.mul(rc)).mul(-3)).mul(exp(zn.mul(-2.2)));
        // Mach disks: thin bright lenses on the axis, each weaker than the last
        let disks = float(0);
        for (let k = 0; k < MAX_DISKS; k++) {
          const zk = z0.add(sp.mul(k));
          const th = R.mul(0.16 + 0.05 * k);
          const on = saturate(nDisk.sub(k));
          const dz = zz.sub(zk).div(th);
          disks = disks.add(exp(dz.mul(dz).negate().sub(rho2.div(rc.mul(rc).mul(0.3)))).mul(on).mul(0.78 ** k));
        }
        // turbulent mixing layer: noise scrolled down the jet
        const ang = atan(p.y, p.x).mul(1 / 6.2832);
        const n = texture(sh.tex.noise, vec2(zz.mul(0.32).sub(t.mul(5.5)).add(vSeed), ang.mul(2))).r;
        const flameD = exp(rho2.div(rf.mul(rf)).mul(-2)).mul(pow(float(1).sub(zn), 1.3)).mul(n.mul(1.1).add(0.35));
        const coreCol = mix(vec3(0.62, 0.74, 1.0), vec3(1.0, 0.8, 0.52), smoothstep(0.08, 0.55, zn));
        const flameCol = mix(vec3(1.0, 0.52, 0.17), vec3(0.85, 0.2, 0.05), smoothstep(0.2, 1.0, zn));
        const e = coreCol.mul(coreD.mul(core).mul(10))
          .add(vec3(1.0, 0.9, 0.74).mul(disks.mul(diskAmt).mul(14)))
          .add(flameCol.mul(flameD.mul(glow).mul(5)));
        acc.addAssign(e.mul(inside));
      }
      // Self-absorption: a long chord (seen end-on) does not keep adding
      // light without limit; the glowing soot and water in the jet absorb
      // too. Saturate the luminance, keep the hue: end-on stays the
      // brightest view without turning into a bloom ball.
      const I = acc.mul(ds);
      const lum = dot(I, vec3(0.3, 0.59, 0.11)).max(1e-4);
      const sat = float(PLUME_SAT).mul(float(1).sub(exp(lum.div(-PLUME_SAT)))).div(lum);
      return vec4(I.mul(sat).mul(u.fade).mul(sh.cloudVis()), 0);
    })();
    return m;
  }

  /**
   * The nozzle ring: a short band of hot petals lining the last of the jet
   * pipe. Seen from behind the band is edge-on all the way round (a ring);
   * from the side it is a dim strip. Dull red on dry thrust, yellow-white in
   * reheat (params.z = glow).
   */
  _ring() {
    const sh = this.shared, u = sh.u;
    const m = this._base(true);
    const { sO, sD, sQ, axis, z, radial } = this._frame();
    const world = sO.xyz.add(axis.mul(z.mul(sO.w))).add(radial.mul(sD.w));
    m.positionNode = world;
    const vRad = varying(radial), vWorld = varying(world), vZ = varying(z), vQ = varying(sQ);
    m.fragmentNode = Fn(() => {
      const facing = abs(dot(normalize(vRad), normalize(u.camPos.sub(vWorld))));
      const n = texture(sh.tex.noise, vec2(vZ.mul(1.4).sub(u.time.mul(3.2)), uv().x.mul(2))).r;
      const rim = pow(float(1).sub(facing), 1.5).mul(0.9).add(0.1);
      const ringCol = mix(vec3(1.0, 0.27, 0.06), vec3(1.0, 0.74, 0.4), saturate(vQ.z));
      const ring = ringCol.mul(rim).mul(vQ.z.mul(2.4).add(0.16)).mul(n.mul(0.3).add(0.85))
        .mul(smoothstep(0, 0.2, vZ)).mul(smoothstep(1, 0.55, vZ)).mul(vQ.x);
      const depthFade = saturate(sh.sceneViewZ().sub(positionView.z.negate()).div(0.35));
      return vec4(ring.mul(depthFade).mul(u.fade).mul(sh.cloudVis()), 0);
    })();
    return m;
  }

  _vapour() {
    const sh = this.shared, u = sh.u;
    const m = this._base(false);
    const { sO, sD, sQ, axis, z, radial } = this._frame();
    const rad = mix(sQ.y, sQ.z, pow(z, 0.6));
    const world = sO.xyz.add(axis.mul(z.mul(sO.w))).add(radial.mul(rad));
    m.positionNode = world;
    const vRad = varying(radial), vWorld = varying(world), vZ = varying(z), vQ = varying(sQ), vAxis = varying(axis);
    m.fragmentNode = Fn(() => {
      const nrm = normalize(vRad);
      const facing = abs(dot(nrm, normalize(u.camPos.sub(vWorld))));
      const n = texture(sh.tex.noise, vec2(uv().x.mul(3), vZ.mul(0.9).sub(u.time.mul(1.4)))).g;
      const n2 = texture(sh.tex.noise, vec2(uv().x.mul(7).add(0.3), vZ.mul(2.1).sub(u.time.mul(2.3)))).r;
      const shell = pow(float(1).sub(facing), 0.7).mul(0.75).add(0.25);
      const along = smoothstep(0, 0.1, vZ).mul(smoothstep(0.35, 1, vZ).oneMinus());
      const depthFade = saturate(sh.sceneViewZ().sub(positionView.z.negate()).div(0.6));
      const axial = float(1).sub(abs(dot(normalize(vAxis), normalize(u.camPos.sub(vWorld)))).pow(2).mul(0.8));
      const a = saturate(vQ.x.mul(shell).mul(along).mul(axial).mul(smoothstep(0.2, 0.7, n.mul(0.65).add(n2.mul(0.35)))).mul(0.8)).mul(depthFade).mul(u.fade).mul(sh.cloudVis());
      // condensation: lit as water (Shared.vapourLight), not 0.5 x the raw sun irradiance
      const col = sh.vapourLight(dot(nrm, u.sunDir), dot(normalize(vWorld.sub(u.camPos)), u.sunDir), float(1));
      return vec4(col.mul(a), a);
    })();
    return m;
  }

  dispose() {
    this.geometry.dispose();
    this.mesh.material.dispose();
  }
}
