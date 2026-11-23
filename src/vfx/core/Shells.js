import * as THREE from 'three/webgpu';
import {
  Fn, float, vec2, vec3, vec4, attribute, positionGeometry, positionView, uv, varying, normalize, dot, cross, abs, mix,
  select, cos, exp, pow, smoothstep, saturate, texture,
} from 'three/tsl';

/**
 * Axisymmetric shells attached to things: afterburner plumes (additive, with
 * shock diamonds) and transonic vapour cones (lit, premultiplied). One
 * instanced draw per kind; an instance is an origin, an axis and four
 * parameters, so nothing here cares how the owner is oriented or parented.
 *
 * plume  params: x = core brightness, y = shock diamonds (count), z = glow, w = layer (0 outer, 1 inner, 2 nozzle ring)
 * vapour params: x = amount, y = start radius, z = end radius
 */
export class Shells {
  constructor(shared, capacity, mode) {
    this.shared = shared;
    this.capacity = capacity;
    this.mode = mode;
    this.count = 0;
    const g = new THREE.CylinderGeometry(1, 1, 1, 24, 20, true);
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
    this.mesh = new THREE.Mesh(ig, mode === 'plume' ? this._plume() : this._vapour());
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

  _frame() {
    const sO = attribute('sO', 'vec4'), sD = attribute('sD', 'vec4'), sQ = attribute('sQ', 'vec4');
    const axis = normalize(sD.xyz);
    const ref = select(abs(axis.y).greaterThan(0.99), vec3(1, 0, 0), vec3(0, 1, 0));
    const t1 = normalize(cross(axis, ref));
    const t2 = cross(axis, t1);
    const z = positionGeometry.z;
    const radial = t1.mul(positionGeometry.x).add(t2.mul(positionGeometry.y));
    return { sO, sD, sQ, axis, z, radial };
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

  _plume() {
    const sh = this.shared, u = sh.u;
    const m = this._base(true);
    const { sO, sD, sQ, axis, z, radial } = this._frame();
    // layer: 0 = outer flame, 1 = inner core with the shock diamonds,
    // 2 = the nozzle ring (a short band of glowing petals at the exit)
    const layer = sQ.w;
    const isInner = select(layer.greaterThan(0.5).and(layer.lessThan(1.5)), float(1), float(0));
    const isRing = select(layer.greaterThan(1.5), float(1), float(0));
    const nD = sQ.y.max(0.001);
    const diamondAmt = saturate(sQ.y.mul(0.5));
    // an under-expanded jet swells and necks once per shock cell
    const swell = cos(z.mul(nD).mul(6.2832)).mul(0.12).mul(diamondAmt).mul(exp(z.mul(-1.6))).add(1);
    const taper = mix(float(1), mix(float(0.4), float(0.1), isInner), pow(z, 0.8));
    const rad = sD.w.mul(mix(float(1), float(0.55), isInner)).mul(mix(taper.mul(swell), float(1), isRing));
    const world = sO.xyz.add(axis.mul(z.mul(sO.w))).add(radial.mul(rad));
    m.positionNode = world;
    const vRad = varying(radial), vWorld = varying(world), vZ = varying(z), vQ = varying(sQ);
    const vSeed = varying(sO.x.add(sO.z).mul(0.37).fract());
    const vInner = varying(isInner), vRing = varying(isRing);
    m.fragmentNode = Fn(() => {
      const facing = abs(dot(normalize(vRad), normalize(u.camPos.sub(vWorld))));
      const n = texture(sh.tex.noise, vec2(vZ.mul(1.4).sub(u.time.mul(3.2)).add(vSeed), uv().x.mul(2))).r;
      const nDf = vQ.y.max(0.001);
      const dia = pow(cos(vZ.mul(nDf).mul(6.2832)).mul(0.5).add(0.5), 6).mul(exp(vZ.mul(-2.2))).mul(saturate(vQ.y.mul(0.5)));
      const body = exp(vZ.mul(mix(float(3.0), float(1.8), vInner)).negate()).mul(n.mul(0.9).add(0.55));
      // emissive gas: brightest where the view ray crosses the most of it
      const shape = pow(facing, mix(float(1.1), float(2.4), vInner));
      const inten = body.mul(mix(float(0.22), float(0.5), vInner)).add(dia.mul(vInner).mul(3.0)).mul(shape).mul(vQ.x);
      const hot = mix(vec3(0.55, 0.68, 1.0), vec3(1.0, 0.52, 0.16), smoothstep(0.0, 0.25, vZ));
      const col = mix(hot, vec3(1.0, 0.22, 0.04), smoothstep(0.45, 1, vZ)).add(vec3(1, 0.9, 0.7).mul(dia.mul(vInner).mul(0.7)));
      const ends = smoothstep(0, 0.04, vZ).mul(pow(float(1).sub(vZ), 1.4));
      const flame = col.mul(inten).mul(ends).mul(3.0);
      // nozzle ring: seen from behind the band is edge-on all the way round
      // (a ring); from the side it is a dim strip. Dull red on dry thrust,
      // yellow-white in reheat (vQ.z = glow).
      const rim = pow(float(1).sub(facing), 1.5).mul(0.9).add(0.1);
      const ringCol = mix(vec3(1.0, 0.27, 0.06), vec3(1.0, 0.74, 0.4), saturate(vQ.z));
      const ring = ringCol.mul(rim).mul(vQ.z.mul(2.4).add(0.16)).mul(n.mul(0.3).add(0.85)).mul(smoothstep(0, 0.2, vZ)).mul(smoothstep(1, 0.55, vZ)).mul(vQ.x);
      const depthFade = saturate(sh.sceneViewZ().sub(positionView.z.negate()).div(0.35));
      return vec4(mix(flame, ring, vRing).mul(depthFade).mul(u.fade).mul(sh.cloudVis()), 0);
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
