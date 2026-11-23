import * as THREE from 'three/webgpu';
import {
  Fn, vec4, float, uniform, attribute, varying, mrt, dot, max, mix, exp, sin, pow, fract, step, select, time,
  smoothstep, cameraProjectionMatrix, cameraViewMatrix, positionGeometry, screenSize,
} from 'three/tsl';

/**
 * Every small light in the world as one instanced draw of emissive sprites:
 * aircraft navigation lights and beacons, village windows, vehicle headlights.
 * No real lights are created; the sprites are HDR and the post chain's bloom
 * turns them into lights. Depth-tested against the scene, additive.
 *
 * A sprite has a physical radius (metres) but never draws smaller than
 * `minPx`; below that its brightness falls off instead, so a distant light
 * shrinks to a steady point and then fades rather than flickering between
 * pixels.
 *
 *   const h = sprites.add({ object3d, offset, color, intensity, radius, ... })
 *   sprites.remove(h)
 *
 * Options:
 *   object3d   follow this object (offset in its local space); omit for a fixed world `position`
 *   color      [r, g, b] linear
 *   intensity  HDR radiance at the core at night (around 4..12 blooms nicely)
 *   day        fraction of the intensity kept in daylight (0 = night only)
 *   radius     metres
 *   minPx      smallest half-size in pixels (at 1080 lines)
 *   blink      { period (s), phase (0..1), kind: 'strobe' | 'beacon' }
 *   range      metres at which it has faded out completely
 */
export class LightSprites {
  constructor({ capacity = 512 } = {}) {
    this.capacity = capacity;
    this.items = [];
    this.u = {
      /** 0 by day .. 1 at night; mixes each sprite between its `day` fraction and full. */
      night: uniform(0),
      gain: uniform(1),
      /** projection[1][1] / 2: metres at distance 1 -> fraction of the screen height. */
      proj: uniform(1),
    };
    const n = capacity;
    this._pos = new Float32Array(n * 3);
    this._col = new Float32Array(n * 4); // rgb x intensity, day fraction
    this._aux = new Float32Array(n * 4); // radius, minPx, blink period (signed: <0 beacon), blink phase
    this._rng = new Float32Array(n); // fade-out range

    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    this._aPos = new THREE.InstancedBufferAttribute(this._pos, 3);
    this._aCol = new THREE.InstancedBufferAttribute(this._col, 4);
    this._aAux = new THREE.InstancedBufferAttribute(this._aux, 4);
    this._aRng = new THREE.InstancedBufferAttribute(this._rng, 1);
    this._aPos.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('lightPos', this._aPos);
    geo.setAttribute('lightCol', this._aCol);
    geo.setAttribute('lightAux', this._aAux);
    geo.setAttribute('lightRange', this._aRng);
    geo.instanceCount = 0;

    const u = this.u;
    const mat = new THREE.MeshBasicNodeMaterial({
      depthTest: true, depthWrite: false, fog: false, side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending, transparent: true,
    });
    mat.name = 'LightSprites';
    const aPos = attribute('lightPos', 'vec3');
    const aCol = attribute('lightCol', 'vec4');
    const aAux = attribute('lightAux', 'vec4');
    const aRng = attribute('lightRange', 'float');
    const corner = positionGeometry.xy;
    const view = cameraViewMatrix.mul(vec4(aPos, 1));
    const dist = max(view.z.negate(), 0.01);
    // half-size in pixels: the metric size, but never below minPx
    const pxMetric = aAux.x.mul(u.proj).mul(screenSize.y).div(dist);
    const pxMin = aAux.y.mul(screenSize.y.div(1080).max(0.75));
    const px = max(pxMetric, pxMin);

    mat.vertexNode = Fn(() => {
      const clip = cameraProjectionMatrix.mul(view).toVar();
      const off = corner.mul(px).mul(2).div(screenSize.xy).mul(clip.w);
      return vec4(clip.xy.add(off), clip.z, clip.w);
    })();

    const gain = Fn(() => {
      // once the sprite is clamped to minPx it dims with distance - far more
      // gently than inverse-square (0.5 instead of 2), the way a point light
      // against a dark valley stays visible for tens of kilometres
      const k = pow(pxMetric.div(px), 0.5);
      const far = smoothstep(aRng, aRng.mul(0.6), dist);
      const t = fract(time.div(max(aAux.z.abs(), 1e-3)).add(aAux.w));
      const strobe = step(t, 0.08);
      const beacon = pow(max(sin(t.mul(Math.PI * 2)), 0), 5);
      const blink = select(aAux.z.equal(0), float(1), select(aAux.z.greaterThan(0), strobe, beacon));
      return k.mul(far).mul(blink).mul(mix(aCol.w, 1, u.night)).mul(u.gain);
    })();
    const vCol = varying(aCol.rgb.mul(gain), 'vLightCol');
    const vUv = varying(corner, 'vLightUv');
    const r2 = dot(vUv, vUv);
    // a hot core and a wide, faint skirt for the bloom to pick up
    mat.colorNode = vCol.mul(exp(r2.mul(-7)).add(exp(r2.mul(-1.6)).mul(0.12)).mul(smoothstep(1.0, 0.7, r2)));
    mat.mrtNode = mrt({ velocity: vec4(0) });

    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.name = 'light-sprites';
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = this.mesh.receiveShadow = false;
    this.mesh.renderOrder = 5;
    this.mesh.visible = false;
  }

  add(o) {
    if (this.items.length >= this.capacity) return null;
    const it = {
      object3d: o.object3d ?? null,
      offset: o.offset ? new THREE.Vector3().copy(o.offset) : new THREE.Vector3(),
      position: o.position ? new THREE.Vector3().copy(o.position) : new THREE.Vector3(),
      index: this.items.length,
      group: o.group ?? null,
    };
    this.items.push(it);
    const i = it.index;
    const c = o.color ?? [1, 1, 1];
    const s = o.intensity ?? 6;
    this._col.set([c[0] * s, c[1] * s, c[2] * s, o.day ?? 0], i * 4);
    const b = o.blink;
    this._aux.set([o.radius ?? 0.2, o.minPx ?? 1.6, b ? (b.kind === 'beacon' ? -b.period : b.period) : 0, b?.phase ?? 0], i * 4);
    this._rng[i] = o.range ?? 30000;
    this._write(it);
    this._aCol.needsUpdate = this._aAux.needsUpdate = this._aRng.needsUpdate = this._aPos.needsUpdate = true;
    this.mesh.geometry.instanceCount = this.items.length;
    return it;
  }

  remove(it) {
    if (!it || this.items[it.index] !== it) return;
    const last = this.items.pop();
    if (last !== it) {
      const i = it.index, j = last.index;
      this._pos.copyWithin(i * 3, j * 3, j * 3 + 3);
      this._col.copyWithin(i * 4, j * 4, j * 4 + 4);
      this._aux.copyWithin(i * 4, j * 4, j * 4 + 4);
      this._rng[i] = this._rng[j];
      last.index = i;
      this.items[i] = last;
    }
    it.index = -1;
    this._aCol.needsUpdate = this._aAux.needsUpdate = this._aRng.needsUpdate = this._aPos.needsUpdate = true;
    this.mesh.geometry.instanceCount = this.items.length;
  }

  /** Remove every sprite added with this `group` tag (an object or a string). */
  removeGroup(group) {
    for (let i = this.items.length - 1; i >= 0; i--) if (this.items[i].group === group) this.remove(this.items[i]);
  }

  _write(it) {
    const p = _v;
    if (it.object3d) p.copy(it.offset).applyMatrix4(it.object3d.matrixWorld);
    else p.copy(it.position);
    this._pos[it.index * 3] = p.x; this._pos[it.index * 3 + 1] = p.y; this._pos[it.index * 3 + 2] = p.z;
  }

  /** Per frame, after objects have moved. */
  update(camera, night) {
    const u = this.u;
    u.night.value = night;
    u.proj.value = camera.projectionMatrix.elements[5] * 0.5;
    let moved = false;
    for (const it of this.items) {
      if (!it.object3d) continue;
      this._write(it);
      moved = true;
    }
    if (moved) this._aPos.needsUpdate = true;
    this.mesh.visible = this.items.length > 0;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}

const _v = new THREE.Vector3();
