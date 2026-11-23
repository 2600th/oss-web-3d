import * as THREE from 'three/webgpu';
import {
  Fn, float, vec3, vec4, uniform, attribute, varying, positionGeometry, dot, cross, normalize, length, max, min, mix,
  smoothstep, saturate, abs, dFdx, dFdy, select, Loop, sqrt, fract, vec2, screenCoordinate,
} from 'three/tsl';
import { beamTier, beamSlots, BEAM } from './beams.js';

/**
 * Vehicle headlight beams without a real light per vehicle.
 *
 * One instanced draw of light volumes: each vehicle's dipped beam is a box
 * in front of its lamps (rasterised by its back faces, so it also works with
 * the camera inside it), drawn into the VFX layer, which is rendered after
 * the scene and can read the scene's depth (Shared.sceneViewZ). Per pixel:
 *
 *   - ground pool: the scene point behind the pixel is reconstructed from
 *     depth, put into the lamp's frame and lit by a low-beam pattern
 *     (spread about +-24 deg, sharp cut-off just under the horizon, falloff
 *     with distance flattened toward the cut-off the way a real dipped beam
 *     throws its hot spot down the road), times the incidence cosine (mostly
 *     of the road plane, partly of the screen-derivative normal, see below)
 *     and a road-dust albedo. It lights whatever is in front of the truck:
 *     road, verge, the back of the truck ahead. The beam axis follows the
 *     road slope sampled `BEAM.slopeProbe` m ahead (`heightAt`), since the
 *     vehicle roots stay level.
 *   - soft cone (not on low): a few-step march of single scattering in thin
 *     night air along the part of the view ray inside the box, with a
 *     forward-peaked phase function, so a beam seen against the dark glows
 *     and looking into the lamps brightens it.
 *
 * Additive with alpha 0 in the premultiplied VFX layer: it only adds light.
 * Nothing per vehicle reaches the scene's lights, so the pipeline and the
 * shadow maps are untouched by how many trucks there are.
 *
 *   const beams = new HeadlightBeams(shared, { tier, heightAt })
 *   beams.add(object3d, { entity, halfWidth, height, front })  // nose -Z, lamps at (+-halfWidth, height, front)
 *   beams.remove(object3d)
 *   beams.update(camera, night)                                 // per frame, after objects moved
 */
export class HeadlightBeams {
  constructor(shared, { tier = 'high', heightAt = null } = {}) {
    this.shared = shared;
    /** (x, z) -> ground height, to pitch beams with the road (optional) */
    this.heightAt = heightAt;
    this.cfg = beamTier(tier);
    this.items = new Map(); // object3d -> item
    const n = this.cfg.capacity;
    this._o = new Float32Array(n * 4); // lamp centre (world), intensity
    this._f = new Float32Array(n * 4); // beam axis (world, unit), range
    this._r = new Float32Array(n * 4); // right (world, unit), lamp height above the wheels
    const geo = new THREE.BoxGeometry(2, 2, 2);
    const inst = new THREE.InstancedBufferGeometry();
    inst.index = geo.index;
    inst.setAttribute('position', geo.getAttribute('position'));
    this._aO = new THREE.InstancedBufferAttribute(this._o, 4).setUsage(THREE.DynamicDrawUsage);
    this._aF = new THREE.InstancedBufferAttribute(this._f, 4).setUsage(THREE.DynamicDrawUsage);
    this._aR = new THREE.InstancedBufferAttribute(this._r, 4).setUsage(THREE.DynamicDrawUsage);
    inst.setAttribute('beamO', this._aO);
    inst.setAttribute('beamF', this._aF);
    inst.setAttribute('beamR', this._aR);
    inst.instanceCount = 0;
    inst.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
    geo.dispose();
    /** on: day/night fade; debug: > 0 tints every covered pixel (dev, to see the volumes) */
    this.u = { on: uniform(0), debug: uniform(0) };
    this.mesh = new THREE.Mesh(inst, this._material());
    this.mesh.name = 'headlight-beams';
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.renderOrder = -1; // under the smoke and particles of the layer
    this.mesh.visible = false;
    this.drawn = 0;
  }

  _material() {
    const sh = this.shared, u = sh.u, on = this.u.on;
    const cfg = this.cfg;
    const m = new THREE.NodeMaterial();
    m.name = 'HeadlightBeams';
    m.transparent = true;
    m.depthTest = false;
    m.depthWrite = false;
    m.side = THREE.BackSide;
    m.blending = THREE.CustomBlending;
    m.blendEquation = THREE.AddEquation;
    m.blendSrc = THREE.OneFactor;
    m.blendDst = THREE.OneFactor;
    m.blendSrcAlpha = THREE.ZeroFactor;
    m.blendDstAlpha = THREE.OneFactor;
    m.fog = false;
    m.lights = false;

    const aO = attribute('beamO', 'vec4'), aF = attribute('beamF', 'vec4'), aR = attribute('beamR', 'vec4');
    const F = aF.xyz, R = aR.xyz, U = cross(R, F);
    const range = aF.w, height = aR.w;
    // box in the lamp frame: x across, y up, z down the beam
    const halfW = range.mul(BEAM.spread).add(1.5);
    const g = positionGeometry;
    const lx = g.x.mul(halfW);
    const ly = mix(height.add(BEAM.below).negate(), float(BEAM.above), g.y.mul(0.5).add(0.5));
    const lz = mix(float(-0.6), range, g.z.mul(0.5).add(0.5));
    const world = aO.xyz.add(R.mul(lx)).add(U.mul(ly)).add(F.mul(lz));
    m.positionNode = world;

    const vWorld = varying(world);
    const vO = varying(aO), vF = varying(aF), vR = varying(aR);

    m.fragmentNode = Fn(() => {
      const f = vF.xyz, r = vR.xyz, up = cross(r, f);
      const I = vO.w, rangeF = vF.w;
      const D = normalize(vWorld.sub(u.camPos));
      // view-ray distance to the opaque scene behind this pixel
      const tScene = sh.sceneViewZ().div(dot(D, u.camFwd).max(1e-3));
      const O = u.camPos.sub(vO.xyz);
      const ro = vec3(dot(O, r), dot(O, up), dot(O, f));
      const rd = vec3(dot(D, r), dot(D, up), dot(D, f));

      // dipped-beam pattern for a direction in the lamp frame (unit vector)
      const pattern = (dir) => {
        const fwd = dir.z.max(1e-3);
        const across = abs(dir.x).div(fwd);
        const elev = dir.y.div(fwd);
        const lateral = smoothstep(BEAM.spread, BEAM.spread * 0.3, across);
        const cut = smoothstep(BEAM.cutoff + 0.025, BEAM.cutoff - 0.02, elev).mul(1 - BEAM.spill).add(BEAM.spill);
        return lateral.mul(cut).mul(smoothstep(0, 0.15, dir.z));
      };

      // ---- ground pool: the scene point, lit
      const P = ro.add(rd.mul(tScene));
      const d2 = dot(P, P);
      const d = sqrt(d2);
      const L = P.div(d.max(1e-3));
      const Pw = D.mul(tScene); // camera-relative scene point (world)
      let n = normalize(cross(dFdx(Pw), dFdy(Pw)));
      n = select(dot(n, D).greaterThan(0), n.negate(), n);
      const nl = vec3(dot(n, r), dot(n, up), dot(n, f));
      // The beam meets the road at a few degrees, where cos(incidence) of the
      // flat-shaded terrain triangles (screen-derivative normal) swings by 2x
      // from facet to facet: the pool came out faceted, and on a rise ahead
      // of the truck almost unlit. Light mostly as the road plane under the
      // lamps (-L.y in the lamp frame, which follows the road slope), keep a
      // share of the true normal so banks and walls facing the truck still
      // catch more, and gate off surfaces turned away.
      const ndlGeom = dot(nl, L.negate());
      const ndl = saturate(mix(L.y.negate(), ndlGeom, 0.35)).mul(smoothstep(-0.15, 0.05, ndlGeom));
      // 1/d^2, flattened down the road: a dipped beam puts its hot spot near the cut-off
      const throwK = min(d.div(BEAM.throwRef), float(BEAM.throwMax));
      const fade = smoothstep(rangeF, rangeF.mul(0.6), d);
      const E = I.mul(pattern(L)).mul(ndl).mul(throwK).div(d2.add(1)).mul(fade);
      const pool = E.mul(BEAM.albedo / Math.PI);

      // ---- soft cone: single scattering in the air inside the box
      let air = float(0);
      if (cfg.steps > 0) {
        // ray / box slab test in the lamp frame
        const hw = rangeF.mul(BEAM.spread).add(1.5);
        const bmin = vec3(hw.negate(), vR.w.add(BEAM.below).negate(), float(-0.6));
        const bmax = vec3(hw, float(BEAM.above), rangeF);
        const inv = vec3(1).div(select(abs(rd).lessThan(1e-5), vec3(1e-5), rd));
        const ta = bmin.sub(ro).mul(inv), tb = bmax.sub(ro).mul(inv);
        const tmin = min(ta, tb), tmax = max(ta, tb);
        const t0 = max(max(tmin.x, tmin.y), max(tmin.z, 0));
        const t1 = min(min(tmax.x, tmax.y), min(tmax.z, tScene));
        const len = max(t1.sub(t0), 0);
        const dt = len.div(cfg.steps);
        // per-pixel offset (interleaved gradient noise): with a handful of steps
        // over a slab whose length jumps at the box edges, fixed offsets band
        const jit = fract(float(52.9829189).mul(fract(dot(screenCoordinate.xy, vec2(0.06711056, 0.00583715)))));
        const acc = float(0).toVar();
        Loop(cfg.steps, ({ i }) => {
          const t = t0.add(dt.mul(float(i).add(jit)));
          const X = ro.add(rd.mul(t));
          const r2 = dot(X, X).add(1.5); // ~lamp size: keeps the 1/r^2 peak at the lens from turning the jitter into grain
          const Xd = X.div(sqrt(r2));
          // Henyey-Greenstein, g = 0.55: haze scatters forward
          const cosT = dot(Xd, rd.negate());
          const hg = float(1 - BEAM.g * BEAM.g).div(float(1 + BEAM.g * BEAM.g).sub(cosT.mul(2 * BEAM.g)).max(1e-3).pow(1.5)).mul(1 / (4 * Math.PI));
          acc.addAssign(pattern(Xd).mul(hg).div(r2).mul(smoothstep(rangeF, rangeF.mul(0.5), sqrt(r2))));
        });
        air = acc.mul(dt).mul(I).mul(BEAM.sigma);
      }

      const col = vec3(BEAM.color[0], BEAM.color[1], BEAM.color[2]).mul(pool.add(air)).add(vec3(this.u.debug, 0, 0));
      const vis = sh.cloudVisAt(min(tScene, length(vWorld.sub(u.camPos)))).mul(u.fade).mul(on);
      return vec4(col.mul(vis), 0);
    })();
    return m;
  }

  /** Light the road in front of `object3d` (nose -Z, lamps at +-halfWidth, height, front). */
  add(object3d, { entity = null, halfWidth = 0.85, height = 1.05, front = -2.7, intensity = 1 } = {}) {
    if (!object3d || this.items.has(object3d)) return this.items.get(object3d) ?? null;
    const it = { object3d, entity, height, front, halfWidth, intensity };
    this.items.set(object3d, it);
    return it;
  }

  remove(object3d) { this.items.delete(object3d); }

  /** Per frame, after objects have moved. `night` 0..1 (env.night). */
  update(camera, night) {
    const on = smoothstep01(BEAM.nightOn[0], BEAM.nightOn[1], night);
    this.u.on.value = on;
    for (const [obj, it] of this.items) {
      // a destroyed vehicle's lamps go out at once (not on the next scan)
      if (it.entity?.alive === false || !obj.parent) this.items.delete(obj);
    }
    if (on <= 0.001 || this.items.size === 0) { this.mesh.visible = false; this.drawn = 0; return; }
    const cam = camera.position;
    const slots = beamSlots(this.items.values(), cam, this.cfg);
    for (let k = 0; k < slots.length; k++) {
      const it = slots[k];
      const m = it.object3d.matrixWorld;
      _p.set(0, it.height, it.front).applyMatrix4(m);
      _f.set(0, 0, -1).transformDirection(m);
      _u.set(0, 1, 0).transformDirection(m);
      // The vehicle's root stays level (its model is slope-seated), so pitch
      // the beam with the road: a dipped beam rides with the truck, and on a
      // rise the road ahead would otherwise sit above the cut-off, unlit.
      if (this.heightAt && Math.abs(_u.y) > 0.9) {
        const hx = _f.x, hz = _f.z, hl = Math.hypot(hx, hz) || 1;
        const h0 = this.heightAt(_p.x, _p.z), h1 = this.heightAt(_p.x + (hx / hl) * BEAM.slopeProbe, _p.z + (hz / hl) * BEAM.slopeProbe);
        const slope = Math.max(-0.5, Math.min(0.5, (h1 - h0) / BEAM.slopeProbe));
        _f.set(hx / hl, slope, hz / hl).normalize();
        _u.set(0, 1, 0);
      }
      _f.addScaledVector(_u, -BEAM.aimDown).normalize(); // dipped: aimed a couple of degrees down
      _r.crossVectors(_f, _u).normalize();
      this._o.set([_p.x, _p.y, _p.z, BEAM.intensity * it.intensity], k * 4);
      this._f.set([_f.x, _f.y, _f.z, this.cfg.range], k * 4);
      this._r.set([_r.x, _r.y, _r.z, it.height], k * 4);
    }
    this._aO.needsUpdate = this._aF.needsUpdate = this._aR.needsUpdate = true;
    this.mesh.geometry.instanceCount = slots.length;
    this.mesh.visible = slots.length > 0;
    this.drawn = slots.length;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}

const smoothstep01 = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const _p = new THREE.Vector3(), _f = new THREE.Vector3(), _u = new THREE.Vector3(), _r = new THREE.Vector3();
