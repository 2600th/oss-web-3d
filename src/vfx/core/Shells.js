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
 * plume  params: x = core brightness, y = shock diamonds (count), z = glow, w = layer (0 outer, 1 inner)
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
    const nD = sQ.y.max(0.001);
    const diamondAmt = saturate(sQ.y.mul(0.5));
    const inner = sQ.w;
    const taper = mix(float(0.42), float(0.12), inner);
    const bulge = cos(z.mul(nD).mul(6.2832)).mul(0.09).mul(diamondAmt).mul(exp(z.mul(-2))).add(1);
    const rad = sD.w.mul(mix(float(1), float(0.5), inner)).mul(mix(float(1), taper, pow(z, 0.7))).mul(bulge);
    const world = sO.xyz.add(axis.mul(z.mul(sO.w))).add(radial.mul(rad));
    m.positionNode = world;
    const vRad = varying(radial), vWorld = varying(world), vZ = varying(z), vQ = varying(sQ);
    const vSeed = varying(sO.x.add(sO.z).mul(0.37).fract());
    m.fragmentNode = Fn(() => {
      const facing = abs(dot(normalize(vRad), normalize(u.camPos.sub(vWorld))));
      const n = texture(sh.tex.noise, vec2(vZ.mul(1.4).sub(u.time.mul(3.2)).add(vSeed), uv().x.mul(2))).r;
      const nDf = vQ.y.max(0.001);
      const dia = pow(cos(vZ.mul(nDf).mul(6.2832)).mul(0.5).add(0.5), 5).mul(exp(vZ.mul(-2.6))).mul(saturate(vQ.y.mul(0.5)));
      const isInner = vQ.w;
      const body = exp(vZ.mul(mix(float(3.2), float(2.0), isInner)).negate()).mul(n.mul(0.9).add(0.55));
      const shape = pow(facing, mix(float(0.9), float(2.2), isInner));
      const inten = body.mul(mix(float(0.3), float(0.55), isInner)).add(dia.mul(isInner).mul(2.6)).mul(shape).mul(vQ.x);
      const hot = mix(vec3(0.5, 0.66, 1.0), vec3(1.0, 0.5, 0.14), smoothstep(0.0, 0.22, vZ));
      const col = mix(hot, vec3(1.0, 0.24, 0.04), smoothstep(0.4, 1, vZ)).add(vec3(1, 0.85, 0.6).mul(dia.mul(isInner).mul(0.6)));
      const ends = smoothstep(0, 0.03, vZ).mul(pow(float(1).sub(vZ), 1.3));
      const depthFade = saturate(sh.sceneViewZ().sub(positionView.z.negate()).div(0.35));
      return vec4(col.mul(inten).mul(ends).mul(depthFade).mul(3.2).mul(u.fade), 0);
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
      const a = saturate(vQ.x.mul(shell).mul(along).mul(axial).mul(smoothstep(0.2, 0.7, n.mul(0.65).add(n2.mul(0.35)))).mul(0.8)).mul(depthFade).mul(u.fade);
      const ndl = dot(nrm, u.sunDir).mul(0.35).add(0.65);
      const col = u.sunColor.mul(0.5).mul(ndl).add(u.skyColor.mul(0.34));
      return vec4(col.mul(a), a);
    })();
    return m;
  }

  dispose() {
    this.geometry.dispose();
    this.mesh.material.dispose();
  }
}
