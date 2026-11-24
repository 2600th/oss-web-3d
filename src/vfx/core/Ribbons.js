import * as THREE from 'three/webgpu';
import {
  Fn, float, vec2, vec3, vec4, attribute, positionGeometry, cameraViewMatrix, cameraProjectionMatrix, varying,
  normalize, dot, cross, length, max, min, mix, select, sin, exp, sqrt, abs, sign, saturate, smoothstep, texture, pow, log2, floor,
} from 'three/tsl';
import { Ring, DirtyRanges } from './ring.js';
import { fireRamp } from './shared.js';

const STRIDE = 32; // 8 x vec4 per segment
// Trail segments are clipped to this view-space plane (metres in front of the
// camera); the camera's own near plane is 0.5 m.
const NEAR = 0.6;
const _d = new THREE.Vector3();

/**
 * Long smoke trails as chains of analytic volumetric segments.
 *
 * Each trail is a polyline of history points; every segment between two
 * points is one instance of a view-space bounding quad. The fragment shader
 * intersects the view ray with the segment's cylinder (radius interpolated
 * between its ends, clipped by the joint planes so neighbours tile exactly)
 * and turns the chord length into optical depth. Because transmittance
 * multiplies, a chain composites to the same result in any draw order — no
 * sorting — and a trail seen end-on (chasing your own missile) is dense
 * instead of collapsing the way a camera-facing ribbon does.
 *
 * Everything that evolves — widening, dissipation, wind drift, the slow
 * kinking of an old trail, noise erosion — is a function of the point's age
 * evaluated in the shaders, so the CPU only writes a segment when it is
 * created (plus the live head), and segments live in one ring shared by all
 * trails.
 */
export class Ribbons {
  constructor(shared, capacity) {
    this.shared = shared;
    this.capacity = capacity;
    this.ring = new Ring(capacity);
    this.dirty = new DirtyRanges(capacity, 24);
    this.owner = new Array(capacity).fill(null);
    this.data = new Float32Array(capacity * STRIDE);
    for (let i = 0; i < capacity; i++) { this.data[i * STRIDE + 7] = -1e6; this.data[i * STRIDE + 11] = -1e6; }
    // Static usage on purpose: three re-uploads a DynamicDraw buffer in full on
    // every draw; with static usage only the ranges touched this frame go up.
    this.buffer = new THREE.InstancedInterleavedBuffer(this.data, STRIDE, 1);

    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, -1, 0, 0, 1, 0, 1, -1, 0, 1, 1, 0]), 3));
    g.setIndex([0, 2, 1, 1, 2, 3]);
    const names = ['iP', 'iA', 'iB', 'iN', 'iS', 'iC', 'iX', 'iY'];
    names.forEach((n, k) => g.setAttribute(n, new THREE.InterleavedBufferAttribute(this.buffer, 4, k * 4)));
    g.instanceCount = capacity;
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);

    this.mesh = new THREE.Mesh(g, this._material());
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.name = 'vfx-trails';
    this._drawn = false;
    this.mesh.onBeforeRender = () => { this._drawn = true; };
    this.segments = 0;
  }

  /**
   * Start a trail. Style: { radius, growth (m per sqrt(s)), life (s), color [r,g,b],
   * opacity (optical depth through the fresh core), wobble (m), rise (m/s),
   * glow (motor light on the first metres; a negative value -w means water
   * condensation, lit by Shared.vapourLight instead of as smoke, w = 1 fully),
   * wind (0..1), spacing (m), lump (0..1, default 1: how much the radius
   * swells and necks along the trail; a contrail is a clean line, 0),
   * taper (m: the first metres of a trail grow from a point instead of
   * starting at full radius, for debris streamers), glowFade (1/s, default 9:
   * how fast the motor light leaves the smoke behind it; a missile's is short,
   * so the light stays on the metres next to the nozzle rather than on the
   * last tenths of a second, which right after a rail launch is the whole
   * trail beside the jet), onset (s, default 0: the swelling eases in over
   * this long, so a missile's exhaust is a tight jet for its first tenths of
   * a second instead of a 2 m tube beside the jet that launched it) }.
   */
  create(style) {
    return new Trail(this, style);
  }

  _write(i, trail, P, A, bA, B, bB, N, distA) {
    const o = i * STRIDE, d = this.data, s = trail.style;
    d[o] = P.x; d[o + 1] = P.y; d[o + 2] = P.z; d[o + 3] = distA;
    d[o + 4] = A.x; d[o + 5] = A.y; d[o + 6] = A.z; d[o + 7] = bA;
    d[o + 8] = B.x; d[o + 9] = B.y; d[o + 10] = B.z; d[o + 11] = bB;
    d[o + 12] = N.x; d[o + 13] = N.y; d[o + 14] = N.z; d[o + 15] = _d.subVectors(B, A).length();
    d[o + 16] = s.radius; d[o + 17] = s.growth; d[o + 18] = s.life; d[o + 19] = trail.seed;
    d[o + 20] = s.color[0]; d[o + 21] = s.color[1]; d[o + 22] = s.color[2]; d[o + 23] = s.opacity * trail.strength;
    d[o + 24] = s.wobble; d[o + 25] = s.rise; d[o + 26] = s.glow; d[o + 27] = s.wind;
    d[o + 28] = s.lump ?? 1; d[o + 29] = s.taper ?? 0; d[o + 30] = s.glowFade ?? 0; d[o + 31] = s.onset ?? 0;
    this.owner[i] = trail;
    this.dirty.mark(i);
  }

  _patchNext(i, N) {
    const o = i * STRIDE, d = this.data;
    d[o + 12] = N.x; d[o + 13] = N.y; d[o + 14] = N.z;
    this.dirty.mark(i);
  }

  update() {
    if (this.dirty.empty) return;
    const ranges = this.dirty.flush();
    // Ranges are consumed when the mesh is next drawn. If several updates
    // happen between draws (fast-forward, hidden tab) they must accumulate.
    if (this._drawn) { this._full = false; this._drawn = false; } // the backend cleared the ranges on upload
    if (!this._full) {
      for (const [s, c] of ranges) this.buffer.addUpdateRange(s * STRIDE, c * STRIDE);
      if (this.buffer.updateRanges.length > 96) { this.buffer.clearUpdateRanges(); this._full = true; } // empty list = full upload
    }
    this.buffer.needsUpdate = true;
  }

  _material() {
    const sh = this.shared;
    const u = sh.u;
    const material = new THREE.NodeMaterial();
    material.transparent = true;
    material.depthTest = false;
    material.depthWrite = false;
    material.side = THREE.DoubleSide;
    material.blending = THREE.CustomBlending;
    material.blendSrc = THREE.OneFactor;
    material.blendDst = THREE.OneMinusSrcAlphaFactor;
    material.blendSrcAlpha = THREE.OneFactor;
    material.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
    material.fog = false;
    material.lights = false;

    const iP = attribute('iP', 'vec4'), iA = attribute('iA', 'vec4'), iB = attribute('iB', 'vec4');
    const iN = attribute('iN', 'vec4'), iS = attribute('iS', 'vec4'), iC = attribute('iC', 'vec4');
    const iX = attribute('iX', 'vec4'), iY = attribute('iY', 'vec4');
    const seed = iS.w;

    // Where a history point has drifted to by now.
    const drift = (P, birth) => {
      const age = u.time.sub(birth).max(0);
      const grow = float(1).sub(exp(age.mul(-0.1)));
      const q = P.mul(1 / 240).add(seed.mul(9.7));
      const n = vec3(
        sin(q.y.mul(1.7).add(q.z.mul(1.3)).add(seed.mul(6.1))),
        sin(q.z.mul(1.9).add(q.x.mul(1.1)).add(seed.mul(3.3))).mul(0.55),
        sin(q.x.mul(1.5).add(q.y.mul(2.1)).add(seed.mul(4.7))),
      ).add(vec3(sin(q.z.mul(4.3).add(q.x.mul(3.1))), sin(q.x.mul(3.7).add(q.y.mul(4.9))).mul(0.5), sin(q.y.mul(4.1).add(q.z.mul(3.3)))).mul(0.4));
      return P.add(u.wind.mul(age.mul(iX.w))).add(n.mul(iX.x).mul(grow)).add(vec3(0, iX.y, 0).mul(age));
    };
    const radius = (birth, dist) => {
      const age = u.time.sub(birth).max(0);
      const lump = sin(dist.mul(0.043).add(seed.mul(40))).mul(0.22).add(sin(dist.mul(0.117).add(seed.mul(17))).mul(0.12)).mul(iY.x).add(1);
      // taper: the first `iY.y` metres grow out of a point (debris streamers)
      const taper = select(iY.y.greaterThan(0), smoothstep(0, iY.y.max(1e-3), dist).mul(0.85).add(0.15), float(1));
      const onset = select(iY.w.greaterThan(0), smoothstep(0, iY.w.max(1e-3), age), float(1));
      return iS.x.add(iS.y.mul(sqrt(age)).mul(onset)).mul(lump).mul(taper);
    };

    const bA = iA.w, bB = iB.w;
    const bP = bA.mul(2).sub(bB), bN = bB.mul(2).sub(bA);
    const toView = (p) => cameraViewMatrix.mul(vec4(p, 1)).xyz;
    const pv = toView(drift(iP.xyz, bP));
    const av = toView(drift(iA.xyz, bA));
    const bv = toView(drift(iB.xyz, bB));
    const nv = toView(drift(iN.xyz, bN));
    const distA = iP.w, distB = iP.w.add(iN.w);
    const ageA = u.time.sub(bA), ageB = u.time.sub(bB);
    const life = iS.z.max(0.01);
    const alive = ageB.lessThan(life).and(bA.greaterThan(-1e5)).and(ageB.greaterThanEqual(0));
    // keep sub-pixel trails visible: clamp the radius to ~3/4 pixel and thin the density instead
    const rA0 = radius(bA, distA), rB0 = radius(bB, distB);
    const rA = max(rA0, u.pixelAngle.mul(0.75).mul(length(av)));
    const rB = max(rB0, u.pixelAngle.mul(0.75).mul(length(bv)));
    const tanA = normalize(bv.sub(pv).add(vec3(1e-5, 0, 0)));
    const tanB = normalize(nv.sub(av).add(vec3(1e-5, 0, 0)));

    // Near-plane clip (fxmath.clipSegmentNear): a segment that crosses the
    // camera plane is cut at z = -NEAR, one wholly behind it is dropped. The
    // bounding quad of a segment with an end behind the camera used to project
    // through infinity into a screen-wide translucent wedge with banded rings.
    const zN = float(-NEAR);
    const aBeh = av.z.greaterThan(zN), bBeh = bv.z.greaterThan(zN);
    const dzAB = bv.z.sub(av.z);
    const tCut = zN.sub(av.z).div(select(abs(dzAB).lessThan(1e-6), float(1e-6), dzAB)).clamp(0, 1);
    const tA = select(aBeh, tCut, float(0)), tB = select(bBeh, tCut, float(1));
    const avC = mix(av, bv, tA), bvC = mix(av, bv, tB);
    const rAc = mix(rA, rB, tA), rBc = mix(rA, rB, tB);
    const front = aBeh.and(bBeh).not();

    // Screen-space direction of the segment. It has to come from the projected
    // end points: for a segment running away from the camera the view-space xy
    // delta points somewhere else entirely and the quad collapses to a sliver.
    const seg = bvC.xy.div(bvC.z.negate().max(0.05)).sub(avC.xy.div(avC.z.negate().max(0.05)));
    const segLen = length(seg);
    const dir2 = select(segLen.greaterThan(1e-6), seg.div(segLen.max(1e-6)), vec2(1, 0));
    const perp = vec2(dir2.y.negate(), dir2.x);
    const e = positionGeometry.x, side = positionGeometry.y;
    const c = mix(avC, bvC, e);
    const r = mix(rAc, rBc, e).mul(1.5).mul(select(alive.and(front), float(1), float(0)));
    const viewPos = c.add(vec3(dir2.mul(e.mul(2).sub(1)).add(perp.mul(side)).mul(r), 0));
    material.vertexNode = cameraProjectionMatrix.mul(vec4(viewPos, 1));

    const vPos = varying(viewPos);
    const v0 = varying(vec4(avC, rAc));
    const v1 = varying(vec4(bvC, rBc));
    const v2 = varying(vec4(tanA, mix(ageA, ageB, tA)));
    const v3 = varying(vec4(tanB, mix(ageA, ageB, tB)));
    const v4 = varying(vec4(mix(distA, distB, tA), mix(distA, distB, tB), life, seed));
    const v5 = varying(iC);
    const v6 = varying(vec4(iX.z, iS.x, mix(rA0.div(rA), rB0.div(rB), tA), mix(rA0.div(rA), rB0.div(rB), tB)));
    // cloud shadow where the segment has drifted to (one shadow-map tap per vertex)
    const v7 = varying(sh.cloudShadow(drift(iA.xyz, bA)));
    const vFade = varying(select(iY.z.greaterThan(0), iY.z, float(9)));

    material.fragmentNode = Fn(() => {
      const D = normalize(vPos);
      const a = v0.xyz, b = v1.xyz;
      const ab = b.sub(a);
      const L = length(ab).max(1e-4);
      const ax = ab.div(L);
      const w = a.negate();
      const Dpar = dot(D, ax);
      const Dp = D.sub(ax.mul(Dpar));
      const dp2 = dot(Dp, Dp).max(1e-6);
      const wu = dot(w, ax);
      const wp = w.sub(ax.mul(wu));
      const tc = dot(wp, Dp).negate().div(dp2);
      const cl = wp.add(Dp.mul(tc)); // from the axis to the ray at closest approach
      const d2 = dot(cl, cl);
      const sc = saturate(wu.add(Dpar.mul(tc)).div(L));
      const rBase = mix(v0.w, v1.w, sc);
      // Noise that keeps pace with the widening tube without swimming: sample two
      // fixed octaves bracketing log2(radius) and cross-fade between them.
      const along = mix(v4.x, v4.y, sc);
      const sd = v4.w;
      const lod = log2(rBase.max(0.25));
      const l0 = floor(lod), lf = lod.sub(l0);
      const s0 = pow(float(2), l0), s1 = s0.mul(2);
      const lodNoise = (per, vcoord, at = along) => mix(
        texture(sh.tex.noise, vec2(at.div(s0.mul(per)), vcoord)),
        texture(sh.tex.noise, vec2(at.div(s1.mul(per)), vcoord.add(0.37))), lf);
      // The ray against this segment's tube, clipped by the joint planes so
      // adjacent segments tile without overlap, by the camera and by the
      // scene. The tube is a cone, not a cylinder: its radius runs linearly
      // from one end's to the other's (a trail widens with age). With one
      // radius per segment every joint was a step, and seen along the trail
      // the steps showed as a stack of discs ("slinky").
      //   |wp + t Dp|^2 = (m (rA + k (wu + t Dpar)))^2,  k = (rB - rA) / L
      // `m` is the billow noise on the radius, taken where the ray crosses
      // (a first pass at the closest approach finds where that is).
      const safe = (x) => select(abs(x).lessThan(1e-5), float(1e-5), x);
      const da = safe(dot(D, v2.xyz)), ta = dot(a, v2.xyz).div(da);
      const db = safe(dot(D, v3.xyz)), tb = dot(b, v3.xyz).div(db);
      const sceneT = sh.sceneViewZ().div(D.z.negate().max(1e-3));
      const wpDp = dot(wp, Dp), wp2 = dot(wp, wp);
      const intersect = (m) => {
        const k = v1.w.sub(v0.w).div(L).mul(m);
        const r0 = v0.w.mul(m).add(k.mul(wu));             // radius level with the camera
        const kq = k.mul(Dpar);
        const qa = dp2.sub(kq.mul(kq)).max(dp2.mul(0.05));  // (nearly down the axis: stay a tube)
        const qb = wpDp.sub(r0.mul(kq));
        const qc = wp2.sub(r0.mul(r0));
        const disc = qb.mul(qb).sub(qa.mul(qc));
        const sq = sqrt(disc.max(0));
        const miss = disc.lessThan(0);
        const lo0 = select(miss, float(1e9), qb.negate().sub(sq).div(qa));
        const hi0 = select(miss, float(-1e9), qb.negate().add(sq).div(qa));
        const lo = max(max(lo0, select(da.greaterThan(0), ta, float(-1e9))), select(db.greaterThan(0), float(-1e9), tb)).max(0);
        const hi = min(min(hi0, select(da.greaterThan(0), float(1e9), ta)), select(db.greaterThan(0), tb, float(1e9))).min(sceneT);
        return { lo, hi, wall: select(miss, tc, lo0) };
      };
      const mAt = (sAt) => lodNoise(13, sd.mul(5.1), mix(v4.x, v4.y, sAt)).g.mul(0.75).add(0.6);
      const first = intersect(mAt(sc));
      const s1m = saturate(dot(D.mul(first.lo.add(first.hi).mul(0.5)).sub(a), ax).div(L));
      const sR = select(first.hi.greaterThan(first.lo), s1m, sc);
      const mR = mAt(sR);
      const rS = mix(v0.w, v1.w, sR);
      const r = rS.mul(mR);
      const { lo, hi, wall } = intersect(mR);
      const h2 = r.mul(r).sub(d2);
      const tWall = wall;
      const t0 = lo.toVar();
      const t1 = hi.toVar();
      const chord = max(t1.sub(t0), 0);

      // Everything inside the medium is evaluated at the chord's midpoint, not
      // at the ray's closest approach to the axis. Seen end-on (a missile
      // trail from dead six) the closest-approach parameter of every segment
      // clamps to one of its ends, so age, density and noise stepped from
      // segment to segment: a stack of discs ("slinky" seams).
      const pm = D.mul(t0.add(t1).mul(0.5));
      const sm = saturate(dot(pm.sub(a), ax).div(L));
      const radialM = pm.sub(a.add(ax.mul(sm.mul(L))));
      const rm2 = dot(radialM, radialM);
      const age = mix(v2.w, v3.w, sm).max(0);
      const lifeT = saturate(age.div(v4.z));
      const prof = saturate(float(1).sub(rm2.div(r.mul(r))));
      const thin = mix(v6.z, v6.w, sm);
      // noise along the trail: breaks the tube into billows, then erodes it with age
      const across = sign(dot(radialM, cross(ax, D))).mul(sqrt(rm2)).div(r.max(1e-3));
      const alongM = mix(v4.x, v4.y, sm);
      const nz = mix(
        texture(sh.tex.noise, vec2(alongM.div(s0.mul(9)), across.mul(0.21).add(sd.mul(7.3)))),
        texture(sh.tex.noise, vec2(alongM.div(s1.mul(9)), across.mul(0.21).add(sd.mul(7.3)).add(0.37))), lf);
      const n1 = nz.r, n2 = nz.b;
      const n = n1.mul(0.6).add(n2.mul(0.4));
      const er = mix(float(-0.22), float(0.6), pow(lifeT, 1.2));
      const erosion = smoothstep(er, er.add(0.42), n).mul(n.mul(1.3).add(0.3));
      const sigma = v5.w.mul(pow(v6.y.div(rS), 0.3)).div(rS.mul(2)).mul(thin.mul(thin));
      const fadeLife = smoothstep(0.55, 1, lifeT).oneMinus();
      // fade when the camera itself is inside the tube (the quad cannot cover the screen)
      const camSeg = a.add(ax.mul(wu.clamp(0, L)));
      // (from the smooth radius, and well clear of it: with the camera a metre or
      // two off a fresh tube, the chase view in a hard turn, every ray through
      // the joint-clipped segment has a chord and the segment drew as a flat,
      // straight-edged pane, plainest at night exposure)
      const inside = smoothstep(rBase.mul(1.1), rBase.mul(2.8), length(camSeg));
      const tau = sigma.mul(chord).mul(pow(prof, 0.5)).mul(erosion).mul(fadeLife).mul(inside).mul(1.5);
      const alpha = float(1).sub(exp(tau.negate())).mul(u.fade).mul(sh.cloudVisAt(t0.add(t1).mul(0.5)));

      // shading: through the wall, the tube normal at the entry point; through
      // a joint plane (end-on), the radial direction at the chord midpoint --
      // the wall normal there belongs to a surface the ray never crossed.
      const rim = sqrt(max(h2, 0)).div(r.max(1e-3));
      // (blended in only when the entry is far past the wall, i.e. nearly
      // end-on: an oblique ray near a joint enters through the joint plane a
      // little past a wall point that lies in the neighbouring segment of the
      // same continuous tube, and that wall normal is the right one; switching
      // there shaded every segment as a separate pillow)
      const capEntry = smoothstep(r.mul(4), r.mul(10), t0.sub(tWall));
      const base0 = mix(cl.div(r.max(1e-3)).sub(Dp.div(sqrt(dp2)).mul(rim)),
        radialM.div(r.max(1e-3)).mul(0.8).sub(D.mul(0.35)), capEntry);
      // The tangent for shading is interpolated between the joint planes'
      // normals (the trail's smoothed tangent at each joint), not this
      // segment's chord: on a curving trail every segment otherwise turned its
      // normals by the bend at each joint, and the segments read as pillows.
      const tS = normalize(mix(v2.xyz, v3.xyz, sm));
      const base = base0.sub(tS.mul(dot(base0, tS)));
      const nrm = normalize(base.add(tS.mul(n1.sub(0.5).mul(1.1))).add(radialM.div(r.max(1e-3)).mul(n2.sub(0.5).mul(0.9))));
      const ndl = dot(nrm, u.sunDirView);
      const diffuse = saturate(ndl.mul(0.5).add(0.5)).mul(0.8).add(0.2).mul(mix(float(0.7), float(1), n2));
      const upV = cameraViewMatrix.mul(vec4(0, 1, 0, 0)).xyz;
      const hemi = dot(nrm, upV).mul(0.5).add(0.5);
      const amb = mix(u.groundColor, u.skyColor, hemi);
      const fwd = pow(saturate(dot(D, u.sunDirView)), 8).mul(float(1).sub(alpha)).mul(0.9);
      // style.glow >= 0: motor light on smoke; < 0: -glow = water (condensation) lighting
      const glowK = v6.x.max(0), water = saturate(v6.x.negate());
      const smokeLit = u.sunColor.mul(v7).mul(diffuse.mul(0.62).add(fwd)).add(amb.mul(0.34));
      const waterLit = sh.vapourLight(ndl, dot(D, u.sunDirView), v7).mul(mix(float(0.85), float(1.05), n2));
      const col = v5.rgb.mul(mix(smokeLit, waterLit, water)).toVar();
      // rocket motor lighting the first metres of smoke
      const hot = glowK.mul(exp(age.mul(vFade).negate())).mul(prof.mul(0.8).add(0.2));
      col.addAssign(fireRamp(hot.mul(1.2)));
      return vec4(col.mul(alpha), alpha);
    })();
    return material;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}

let _seedCounter = 1;

/** One emitter's history. Call `push(position)` every frame while it emits, then `end()`. */
export class Trail {
  constructor(ribbons, style) {
    this.ribbons = ribbons;
    this.style = style;
    this.seed = ((_seedCounter++ * 0.61803398875) % 1);
    this.strength = 1; // multiplies opacity of segments written from now on
    this.prev = new THREE.Vector3();
    this.last = new THREE.Vector3();
    this.lastBirth = 0;
    this.dist = 0;
    this.count = 0;
    this.headSlot = -1;
    this.prevSlot = -1;
    this.active = true;
    this._next = new THREE.Vector3();
  }

  push(pos) {
    const R = this.ribbons, now = R.shared.time;
    if (this.count === 0) {
      this.last.copy(pos); this.prev.copy(pos); this.lastBirth = now; this.count = 1;
      return;
    }
    const d = _d.subVectors(pos, this.last).length();
    if (d < 1e-3) return;
    if (d > 4000) { // teleport: cut the trail
      this.count = 0; this.headSlot = -1; this.prevSlot = -1;
      return this.push(pos);
    }
    if (this.headSlot >= 0 && R.owner[this.headSlot] !== this) this.headSlot = -1; // slot was recycled
    if (this.headSlot < 0) { this.headSlot = R.ring.next(); R.owner[this.headSlot] = this; R.segments++; }
    if (this.prevSlot >= 0 && R.owner[this.prevSlot] === this) R._patchNext(this.prevSlot, pos);
    this._next.subVectors(pos, this.last).add(pos);
    R._write(this.headSlot, this, this.prev, this.last, this.lastBirth, pos, now, this._next, this.dist);
    if (d >= this.style.spacing) {
      this.prevSlot = this.headSlot;
      this.headSlot = -1;
      this.prev.copy(this.last);
      this.last.copy(pos);
      this.lastBirth = now;
      this.dist += d;
      this.count++;
    }
  }

  end() {
    this.active = false;
    this.headSlot = -1;
  }
}
