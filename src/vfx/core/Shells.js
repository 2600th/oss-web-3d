import * as THREE from 'three/webgpu';
import {
  Fn, float, vec2, vec3, vec4, attribute, positionGeometry, positionView, uv, varying, normalize, dot, cross, abs, mix,
  select, cos, exp, pow, smoothstep, saturate, texture, sqrt, max, min, length, atan, fract, floor, screenCoordinate,
} from 'three/tsl';

/** Ray-marched samples through an afterburner plume (jittered per pixel, so no banding). */
const PLUME_STEPS = 12;
const PLUME_STEPS_LOW = 6;
/** Bounding cylinder of the plume, in nozzle radii (the flame envelope plus its turbulence). */
const PLUME_BOUND = 2.1;
/** Luminance the plume tends to seen side-on, and down its axis (bloom and the exposure meter see it). */
const PLUME_SAT = 9;
const PLUME_SAT_END_ON = 1.6;
/** Emission scale under a night sky (1 by day); see `gain` in the plume shader. */
const PLUME_NIGHT_GAIN = 0.45;
/** The flameholder plane sits this many nozzle radii up the jet pipe. */
const HOLDER_DEPTH = 2.2;
/** Flaps round the MiG-21's variable nozzle. */
const NOZZLE_PETALS = 24;

/**
 * Axisymmetric shells attached to things: afterburner plumes, the glowing
 * nozzle ring, and transonic vapour cones. One instanced draw per kind; an
 * instance is an origin, an axis and four parameters, so nothing here cares
 * how the owner is oriented or parented.
 *
 * plume  params: x = flame power, y = shock-cell spacing (m), z = hot-metal glow, w = reheat (0..1)
 *        extra:  x = rich (0..1: the fuel-rich torch of a light-up), y = seed,
 *                z = shock contrast (air density), w = spread (under-expansion)
 *        (origin = nozzle exit centre, length = flame length, radius = nozzle radius)
 * ring   params: x = brightness, z = glow, w = reheat
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
  /** `opts.low`: the cheap plume (half the samples, one noise tap, no flameholder detail). */
  constructor(shared, capacity, mode, opts = {}) {
    this.shared = shared;
    this.opts = opts;
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
    this.e = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4); // extra params (plume)
    for (const a of [this.o, this.d, this.q, this.e]) a.setUsage(THREE.DynamicDrawUsage);
    const ig = new THREE.InstancedBufferGeometry();
    ig.index = g.index;
    ig.setAttribute('position', g.getAttribute('position'));
    ig.setAttribute('uv', g.getAttribute('uv'));
    ig.setAttribute('sO', this.o); ig.setAttribute('sD', this.d); ig.setAttribute('sQ', this.q);
    if (mode === 'plume') ig.setAttribute('sE', this.e);
    ig.instanceCount = 0;
    this.geometry = ig;
    const mat = mode === 'plume' ? this._plume() : mode === 'ring' ? this._ring() : this._vapour();
    this.mesh = new THREE.Mesh(ig, mat);
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.name = `vfx-${mode}`;
  }

  begin() { this.count = 0; }

  add(origin, axis, length, radius, a = 0, b = 0, c = 0, d = 0, e0 = 0, e1 = 0, e2 = 0, e3 = 0) {
    if (this.count >= this.capacity) return;
    const i = this.count++ * 4;
    const o = this.o.array, dd = this.d.array, q = this.q.array, e = this.e.array;
    e[i] = e0; e[i + 1] = e1; e[i + 2] = e2; e[i + 3] = e3;
    o[i] = origin.x; o[i + 1] = origin.y; o[i + 2] = origin.z; o[i + 3] = length;
    dd[i] = axis.x; dd[i + 1] = axis.y; dd[i + 2] = axis.z; dd[i + 3] = radius;
    q[i] = a; q[i + 1] = b; q[i + 2] = c; q[i + 3] = d;
  }

  end() {
    this.geometry.instanceCount = this.count;
    this.mesh.visible = this.count > 0;
    if (this.count > 0) { this.o.needsUpdate = true; this.d.needsUpdate = true; this.q.needsUpdate = true; this.e.needsUpdate = this.mode === 'plume'; }
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
   * Afterburner plume: emission and a little absorption integrated along the
   * view ray's chord through the jet.
   *
   * In plume space (z along the jet from the exit plane, rho from the axis,
   * R the nozzle radius, zn = z / length, c the phase inside a shock cell):
   *   sheath   the burning mixing layer: a Gaussian tube that tapers to half
   *            the nozzle radius, barrels a little at every cell, orange
   *            going red. Turbulence scrolls down it and grows downstream:
   *            the root is smooth, the tail is torn (the radius itself is
   *            warped by the noise, so the silhouette breaks up).
   *   root     the yellow-white flame standing off the flameholder, with a
   *            short blue-white core inside the first nozzle diameter
   *   cells    shock diamonds: one per cell of length `spacing` (Prandtl-Pack,
   *            ring.js plumeState), each a bright cone that opens abruptly at
   *            its Mach disk and tapers downstream, 0.85x the last one; the
   *            disk itself is a soft lens on the axis. One periodic function,
   *            not a loop over disks.
   * The bounding cylinder (PLUME_BOUND nozzle radii) is drawn by its back
   * faces; each pixel finds where its ray enters, clips the far end against
   * the scene depth, and marches jittered samples front to back. The result
   * is premultiplied: mostly light, with enough opacity that the flame keeps
   * its colour over snow and bright cloud instead of adding up to white.
   *
   * The same pixel also looks up the jet pipe: a ray that enters the nozzle
   * aperture is intersected with the flameholder plane HOLDER_DEPTH radii
   * inside (two V-gutter rings and their struts round the exhaust cone), so
   * the view from dead six has depth and parallax behind the flame.
   */
  _plume() {
    const sh = this.shared, u = sh.u;
    const low = !!this.opts.low;
    const STEPS = low ? PLUME_STEPS_LOW : PLUME_STEPS;
    const m = this._base(false);
    m.side = THREE.BackSide;
    const { sO, sD, sQ, axis, z, radial, t1, t2 } = this._frame();
    const sE = attribute('sE', 'vec4');
    const world = sO.xyz.add(axis.mul(z.mul(sO.w))).add(radial.mul(sD.w.mul(PLUME_BOUND)));
    m.positionNode = world;
    const vWorld = varying(world);
    const vO = varying(sO), vR = varying(sD.w), vQ = varying(sQ), vE = varying(sE);
    const vA = varying(axis), vT1 = varying(t1), vT2 = varying(t2);

    m.fragmentNode = Fn(() => {
      const L = vO.w.max(0.05), R = vR.max(0.01), Rb = R.mul(PLUME_BOUND);
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
      const ds = span.div(STEPS);
      // interleaved-gradient jitter of the sample positions, re-rolled every frame
      const sc = screenCoordinate.xy;
      const jit = fract(fract(sc.x.mul(0.06711056).add(sc.y.mul(0.00583715))).mul(52.9829189).add(u.time.mul(41.3)));

      const power = vQ.x, cell = vQ.y.max(0.3), glow = vQ.z, rh = vQ.w;
      const rich = vE.x, seed = vE.y, contrast = vE.z, spread = vE.w;
      const t = u.time;
      // A flame's radiance does not change at night, but the exposure does,
      // and less than the scene darkens: hold the flame back in the dark so
      // it keeps its colour instead of clipping to a white sausage.
      const ambient = dot(u.sunColor, vec3(0.3, 0.59, 0.11));
      const gain = mix(float(PLUME_NIGHT_GAIN), float(1), smoothstep(0.3, 3, ambient));
      const diaAmt = rh.mul(contrast).mul(rich.oneMinus());
      const wide = rich.mul(0.3).add(1);
      const acc = vec3(0).toVar();
      const trans = float(1).toVar();
      for (let i = 0; i < STEPS; i++) {
        const s = tEnter.add(ds.mul(float(i).add(jit)));
        const p = o.add(d.mul(s));
        const zz = p.z, zn = saturate(zz.div(L));
        const rho = sqrt(p.x.mul(p.x).add(p.y.mul(p.y)));
        // turbulence carried down the jet: two planar projections, so there
        // is no seam round the axis
        const flow = zz.mul(0.15).sub(t.mul(4.6)).add(seed);
        const nA = texture(sh.tex.noise, vec2(flow, p.x.mul(0.21).add(seed.mul(3.1))), float(0)).r;
        const nB = low ? nA : texture(sh.tex.noise, vec2(flow.mul(1.9).add(0.37), p.y.mul(0.27).add(seed.mul(1.7))), float(0)).g;
        const turb = saturate(nA.add(nB).sub(0.96).mul(3.0).add(0.5));
        const rough = saturate(smoothstep(0.02, 0.6, zn).mul(0.8).add(rich.mul(0.5)));
        const rr = rho.mul(turb.sub(0.5).mul(rough).mul(1.1).add(1));
        // shock cells
        const cz = zz.div(cell).sub(0.62);
        const k = floor(cz).max(0), c = fract(cz);
        const born = smoothstep(0, 0.02, cz);
        const decay = exp(k.mul(0.16).negate());
        const taper = float(1).sub(pow(zn, 1.3).mul(0.4));
        const barrel = cos(c.mul(6.2832)).mul(0.09).mul(diaAmt).mul(zn.oneMinus()).add(1);
        const swell = smoothstep(0, 0.18, zn).mul(zn.oneMinus()).mul(spread).mul(0.3).add(1);
        const rEnv = R.mul(taper).mul(barrel).mul(swell).mul(wide);
        const axial = smoothstep(-0.02, 0.1, zz).mul(pow(zn.oneMinus(), 1.15)).mul(smoothstep(0.8, 1, zn).oneMinus());
        const qS = rr.div(rEnv);
        const sheath = exp(qS.mul(qS).mul(1.8).negate()).mul(axial).mul(mix(float(1), turb.mul(1.7).add(0.12), rough));
        // the flame root
        const rc = R.mul(float(0.72).sub(zn.mul(0.3)));
        const qR = rho.div(rc);
        const root = exp(qR.mul(qR).mul(-3)).mul(exp(zn.mul(5.5).negate())).mul(smoothstep(-0.02, 0.05, zz));
        const qI = rho.div(R.mul(0.42));
        const inner = exp(qI.mul(qI).mul(-3.5)).mul(exp(zz.div(R.mul(-1.8)))).mul(smoothstep(-0.02, 0.05, zz));
        // diamonds: a lozenge per cell, opening over its first quarter and
        // tapering to the next Mach disk
        const wd = min(c.div(0.25), c.oneMinus().div(0.75));
        const rd = rEnv.mul(0.72).mul(wd);
        const dia = smoothstep(0, 1, saturate(rd.sub(rr).div(rEnv.mul(0.3)))).mul(float(1).sub(c.mul(0.55)))
          .mul(decay).mul(born).mul(axial);
        const qD = rho.div(rEnv.mul(0.3));
        const cd = c.sub(0.15).div(0.12);
        const disk = exp(cd.mul(cd).negate().sub(qD.mul(qD))).mul(decay).mul(born).mul(axial);

        const hot = smoothstep(0.0, 0.5, zn);
        const sheathCol = mix(mix(vec3(1.0, 0.47, 0.12), vec3(0.92, 0.2, 0.04), smoothstep(0.1, 1.0, zn)), vec3(1.0, 0.6, 0.16), rich.mul(0.8));
        const rootCol = mix(vec3(1.0, 0.9, 0.66), vec3(1.0, 0.7, 0.3), hot);
        const e = sheathCol.mul(sheath.mul(7))
          .add(rootCol.mul(root.mul(22)))
          .add(vec3(0.72, 0.82, 1.0).mul(inner.mul(rh).mul(14)))
          .add(vec3(1.0, 0.76, 0.42).mul(dia.mul(14).add(disk.mul(4)).mul(diaAmt)));
        const sigma = sheath.mul(0.8).add(root.mul(0.8)).add(dia.mul(diaAmt).mul(0.6)).mul(power);
        const a = float(1).sub(exp(sigma.mul(ds).negate()));
        acc.addAssign(e.mul(power).mul(gain).mul(ds).mul(trans));
        trans.mulAssign(a.oneMinus());
      }

      // ---- up the jet pipe: the flameholder, seen through the nozzle aperture ----
      const tP0 = o.z.negate().div(dzs);                            // exit plane
      const tP1 = o.z.add(R.mul(HOLDER_DEPTH)).negate().div(dzs);   // flameholder plane
      const p0 = o.add(d.mul(tP0)), p1 = o.add(d.mul(tP1));
      const r0 = length(p0.xy).div(R), r1 = length(p1.xy).div(R);
      const looking = smoothstep(-0.08, 0, d.z).oneMinus().mul(smoothstep(0, 0.2, o.z));
      const aperture = smoothstep(0.88, 0.97, r0).oneMinus().mul(smoothstep(0.94, 1.04, r1).oneMinus());
      const clear = smoothstep(tP0.sub(0.25), tP0.sub(0.05), sceneT);
      const ang = atan(p1.y, p1.x);
      const g1 = r1.sub(0.4).div(0.07), g2 = r1.sub(0.76).div(0.07);
      const gutters = exp(g1.mul(g1).negate()).add(exp(g2.mul(g2).negate()));
      const struts = pow(abs(cos(ang.mul(4))), 20).mul(0.6).mul(smoothstep(0.16, 0.3, r1));
      const metal = saturate(gutters.add(struts));
      const hub = smoothstep(0.1, 0.2, r1);
      const nH = low ? float(0.5) : texture(sh.tex.noise, vec2(p1.x.div(R).mul(0.35).add(t.mul(1.7)), p1.y.div(R).mul(0.35).sub(t.mul(1.3)).add(seed)), float(0)).g;
      // dry: the gutters glow dull red against a dark pipe. Reheat: the pipe
      // is full of flame and the gutters are the darker pattern in it.
      const dryGlow = vec3(1.0, 0.3, 0.07).mul(metal.mul(0.5).add(0.07)).mul(glow.mul(1.6).add(0.12)).mul(hub.mul(0.7).add(0.3));
      const wet = mix(vec3(1.0, 0.62, 0.24), vec3(1.0, 0.88, 0.62), saturate(float(1.15).sub(r1)))
        .mul(float(1).sub(metal.mul(0.55))).mul(nH.mul(0.9).add(0.55)).mul(hub.mul(0.5).add(0.5)).mul(power.mul(6));
      const holder = dryGlow.mul(rh.oneMinus()).add(wet.mul(rh)).mul(looking).mul(aperture).mul(clear);

      // An end-on chord is metres of flame: let the luminance saturate, and
      // sooner down the axis than across it, so the view up the pipe shows
      // the flameholder instead of a bloom ball.
      const S = mix(float(PLUME_SAT), float(PLUME_SAT_END_ON), pow(abs(d.z), 6));
      const lum = dot(acc, vec3(0.3, 0.59, 0.11)).max(1e-4);
      const sat = S.mul(float(1).sub(exp(lum.div(S).negate()))).div(lum);
      // the gutters show through the flame as its darker pattern
      const through = float(1).sub(metal.mul(hub).mul(0.34).add(hub.oneMinus().mul(0.25)).mul(nH.mul(0.8).add(0.6)).mul(looking).mul(aperture).mul(clear));
      const I = acc.mul(sat).mul(through).add(holder.mul(trans));
      const vis = u.fade.mul(sh.cloudVis());
      const alpha = trans.oneMinus().mul(0.6).mul(vis);
      return vec4(I.mul(vis), alpha);
    })();
    return m;
  }

  /**
   * The nozzle ring: a short band of hot petals lining the last of the jet
   * pipe. Seen from behind the band is edge-on all the way round (a ring);
   * from the side it is a dim strip. Dull red on dry thrust, yellow-white in
   * reheat (params.z = glow), with the seams between the nozzle flaps dark.
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
      // 24 flaps: a dark seam between each pair, hotter toward the lip
      const seam = float(1).sub(pow(abs(cos(uv().x.mul(Math.PI * NOZZLE_PETALS))), 24).mul(0.6));
      const ring = ringCol.mul(rim).mul(vQ.z.mul(2.4).add(0.16)).mul(n.mul(0.3).add(0.85)).mul(seam)
        .mul(smoothstep(0, 0.2, vZ)).mul(smoothstep(0.55, 1, vZ).oneMinus()).mul(vQ.x);
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
