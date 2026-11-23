import * as THREE from 'three';
import { FX_NOISE_GLSL } from './noise.glsl.js';
import { FX_COMMON_GLSL } from './common.glsl.js';
import { sharedUniforms, registerFxMaterial, unregisterFxMaterial } from './FrameUniforms.js';

/**
 * A camera-facing trail built from instanced segments.
 *
 * The camera-facing construction is adapted from LinearAbiltyCastingThreeJS
 * (MIT), src/materials/LightningMaterial.js: the ribbon has no thickness of its
 * own, and each vertex is pushed sideways along
 * `binormal = cross(tangent, toCamera)`, so the strip is always presented flat
 * to the viewer no matter how the trail is oriented in space.
 *
 * Two things here are not from the reference, and both come from the same
 * requirement -- a contrail has to survive a hard manoeuvre as one coherent
 * ribbon and then dissipate, not just fade:
 *
 *  - **The CPU writes each node exactly once, at birth.** The system this
 *    replaces walked a 96-sample history and rewrote 1152 floats *per ribbon per
 *    frame* to spread and taper the trail. Spreading is a function of age, and
 *    age is a function of the clock, so it belongs in the shader. What the CPU
 *    does now is append one 16-float segment record per 30 metres flown.
 *  - **Segments are instanced, not a strip.** A ring buffer drawn as one strip
 *    has a seam where the newest node meets the oldest, and killing that one
 *    quad without killing its neighbours is fiddly because a strip vertex
 *    belongs to two quads. An instanced segment owns both its endpoints, so the
 *    wrap costs nothing and a dead segment collapses on its own. The duplicated
 *    endpoint data is 16 floats per 30 m of trail, which is nothing.
 *
 * Continuity across the joint is why each segment also carries its neighbours'
 * outer endpoints: the tangent at a shared node is averaged from both segments
 * that meet there, so the two agree exactly and the ribbon has no visible
 * kinks under roll.
 *
 * Node positions are world space. The mesh's own transform is ignored.
 */

const DEAD = -1e5;

const _v = new THREE.Vector3();

export class Ribbon {
  /**
   * @param {object} options
   * @param {string} options.name
   * @param {number} [options.capacity]  segments retained
   * @param {number} [options.life]      seconds a node survives
   * @param {number} [options.renderOrder]
   */
  constructor({ name, capacity = 256, life = 30, renderOrder = 13 }) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new RangeError('Ribbon capacity must be a positive integer');
    }
    if (!Number.isFinite(life) || life <= 0) {
      throw new RangeError('Ribbon life must be a finite positive number');
    }
    this.name = name;
    this.capacity = capacity;
    this.active = capacity;
    this.cursor = 0;

    const geometry = new THREE.InstancedBufferGeometry();
    // position = (side, u, 0) in ribbon parameter space.
    geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(
        new Float32Array([-1, 0, 0, 1, 0, 0, 1, 1, 0, -1, 1, 0]),
        3,
      ),
    );
    geometry.setIndex(new THREE.BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3]), 1));

    this.data = {
      p0: new Float32Array(capacity * 3),
      p1: new Float32Array(capacity * 3),
      prev: new Float32Array(capacity * 3),
      next: new Float32Array(capacity * 3),
      // (birth0, birth1, halfWidth0, halfWidth1)
      data: new Float32Array(capacity * 4),
    };
    this._sizes = { p0: 3, p1: 3, prev: 3, next: 3, data: 4 };
    this.attributes = {};
    for (const [key, itemSize] of Object.entries(this._sizes)) {
      const attribute = new THREE.InstancedBufferAttribute(this.data[key], itemSize).setUsage(
        THREE.DynamicDrawUsage,
      );
      this.attributes[key] = attribute;
      geometry.setAttribute(`a${key[0].toUpperCase()}${key.slice(1)}`, attribute);
    }
    for (let i = 0; i < capacity; i++) {
      this.data.data[i * 4] = DEAD;
      this.data.data[i * 4 + 1] = DEAD;
    }
    geometry.instanceCount = capacity;
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);
    this.geometry = geometry;

    this.material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      defines: {},
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.NormalBlending,
      side: THREE.DoubleSide,
      uniforms: sharedUniforms({
        uLife: { value: life },
        uSpread: { value: 0.5 }, // metres of half-width gained per second
        uTaper: { value: 0.01 }, // fraction of life over which a new node widens
        uTurb: { value: 0.35 }, // metres of curl displacement per second of age
        uTurbFreq: { value: 0.01 },
        uTurbSpeed: { value: 0.05 },
        uWindDrift: { value: 0.35 },
        uBreakFreq: { value: 0.02 },
        uErode: { value: 1.7 },
        uEdge: { value: 0.35 },
        uOpacity: { value: 1 },
        uAlbedo: { value: new THREE.Color(0.94, 0.96, 1.0) },
      }),
      vertexShader: RIBBON_VERTEX,
      fragmentShader: RIBBON_FRAGMENT,
    });
    registerFxMaterial(this.material);

    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.renderOrder = renderOrder;
    this.mesh.name = `fx:${name}`;

    this._lastP = new THREE.Vector3();
    this._prevP = new THREE.Vector3();
    this._lastW = 1;
    this._lastBirth = 0;
    this._hasLast = false;
    this._hasPrev = false;
    this._lastIndex = -1;

    this._ranges = [];
    this._dirty = false;
  }

  get uniforms() {
    return this.material.uniforms;
  }

  setActive(count) {
    if (!Number.isFinite(count)) throw new RangeError('Ribbon active count must be finite');
    const previous = this.active;
    this.active = THREE.MathUtils.clamp(Math.round(count), 0, this.capacity);
    if (this.active === previous) return;

    if (this.active < previous) {
      const d = this.data.data;
      for (let i = this.active; i < previous; i++) {
        d[i * 4] = DEAD;
        d[i * 4 + 1] = DEAD;
      }
      this._markDirtyRange(this.active, previous - this.active);
    }

    // The cached endpoint and neighbour index describe the old ring topology.
    // Reusing either after a budget change can bridge a disabled interval or
    // patch a segment that is no longer part of the active ring.
    this.break();
    this.geometry.instanceCount = this.active;
    if (this.cursor >= this.active) this.cursor = 0;
    this.mesh.visible = this.active > 0;
  }

  /**
   * Append a node. The first node after a break only primes the strip; a
   * segment appears on the second.
   *
   * @param {THREE.Vector3} position world-space centreline point
   * @param {number} halfWidth        metres at birth
   * @param {number} time             shared clock
   */
  push(position, halfWidth, time) {
    if (this.active <= 0) return;

    if (!this._hasLast) {
      this._lastP.copy(position);
      this._lastW = halfWidth;
      this._lastBirth = time;
      this._hasLast = true;
      this._hasPrev = false;
      this._lastIndex = -1;
      return;
    }

    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.active;
    const i3 = i * 3;
    const i4 = i * 4;
    const d = this.data;

    d.p0[i3] = this._lastP.x;
    d.p0[i3 + 1] = this._lastP.y;
    d.p0[i3 + 2] = this._lastP.z;
    d.p1[i3] = position.x;
    d.p1[i3 + 1] = position.y;
    d.p1[i3 + 2] = position.z;

    // Neighbours outside the segment. Where there is no real neighbour yet the
    // segment is extrapolated, which makes the averaged tangent degenerate to
    // the segment's own direction instead of collapsing to zero.
    if (this._hasPrev) {
      d.prev[i3] = this._prevP.x;
      d.prev[i3 + 1] = this._prevP.y;
      d.prev[i3 + 2] = this._prevP.z;
    } else {
      _v.subVectors(this._lastP, position).add(this._lastP);
      d.prev[i3] = _v.x;
      d.prev[i3 + 1] = _v.y;
      d.prev[i3 + 2] = _v.z;
    }
    _v.subVectors(position, this._lastP).add(position);
    d.next[i3] = _v.x;
    d.next[i3 + 1] = _v.y;
    d.next[i3 + 2] = _v.z;

    d.data[i4] = this._lastBirth;
    d.data[i4 + 1] = time;
    d.data[i4 + 2] = this._lastW;
    d.data[i4 + 3] = halfWidth;
    this._markDirty(i);

    // The previous segment now has a real successor, so its far tangent stops
    // being an extrapolation. Without this patch each joint carried two
    // different tangents and the ribbon showed a hairline notch per node under
    // hard roll.
    if (this._lastIndex >= 0) {
      const j3 = this._lastIndex * 3;
      d.next[j3] = position.x;
      d.next[j3 + 1] = position.y;
      d.next[j3 + 2] = position.z;
      this._markDirty(this._lastIndex);
    }

    this._prevP.copy(this._lastP);
    this._hasPrev = true;
    this._lastP.copy(position);
    this._lastW = halfWidth;
    this._lastBirth = time;
    this._lastIndex = i;
  }

  /** Start a new strip on the next push, so no segment spans the gap. */
  break() {
    this._hasLast = false;
    this._hasPrev = false;
    this._lastIndex = -1;
  }

  _markDirty(index) {
    this._markDirtyRange(index, 1);
  }

  _markDirtyRange(index, count) {
    if (count <= 0) return;
    this._dirty = true;
    const ranges = this._ranges;
    const last = ranges[ranges.length - 1];
    if (last && index === last[0] + last[1]) last[1] += count;
    else ranges.push([index, count]);
  }

  flush() {
    if (!this._dirty) return;
    for (const [key, itemSize] of Object.entries(this._sizes)) {
      const attribute = this.attributes[key];
      attribute.clearUpdateRanges();
      for (const [start, count] of this._ranges) {
        attribute.addUpdateRange(start * itemSize, count * itemSize);
      }
      attribute.needsUpdate = true;
    }
    this._ranges.length = 0;
    this._dirty = false;
  }

  reset() {
    const d = this.data.data;
    for (let i = 0; i < this.capacity; i++) {
      d[i * 4] = DEAD;
      d[i * 4 + 1] = DEAD;
    }
    const a = this.attributes.data;
    a.clearUpdateRanges();
    a.needsUpdate = true;
    this._ranges.length = 0;
    this._dirty = false;
    this.cursor = 0;
    this.break();
  }

  dispose() {
    unregisterFxMaterial(this.material);
    this.geometry.dispose();
    this.material.dispose();
  }
}

const RIBBON_VERTEX = /* glsl */ `
  precision highp float;

  uniform float uTime;
  uniform vec3  uWind;
  uniform vec3  uSunDir;
  uniform float uLife;
  uniform float uSpread;
  uniform float uTaper;
  uniform float uTurb;
  uniform float uTurbFreq;
  uniform float uTurbSpeed;
  uniform float uWindDrift;

  in vec3 aP0;
  in vec3 aP1;
  in vec3 aPrev;
  in vec3 aNext;
  in vec4 aData;

  out float vT;
  out float vSide;
  out float vViewZ;
  out vec3  vWorld;
  out float vNdl;
  out float vForward;

  ${FX_NOISE_GLSL}

  vec3 fxSafeNormalize(vec3 value, vec3 fallback) {
    float lengthSq = dot(value, value);
    return lengthSq > 1e-10 ? value * inversesqrt(lengthSq) : fallback;
  }

  void main() {
    float side = position.x;
    float u = position.y;
    vSide = side;

    float birth = mix(aData.x, aData.y, u);
    float age = uTime - birth;
    float t = age / max(uLife, 1e-4);
    vT = t;
    vViewZ = -1.0;
    vWorld = vec3(0.0);
    vNdl = 0.0;
    vForward = 0.0;

    if (age < 0.0 || t > 1.0) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      return;
    }

    vec3 p = mix(aP0, aP1, u);

    vec3 seg = aP1 - aP0;
    float segLen = length(seg);
    vec3 dir = segLen > 1e-5 ? seg / segLen : vec3(0.0, 0.0, 1.0);

    vec3 back = aP0 - aPrev;
    vec3 fwd = aNext - aP1;
    vec3 backDir = fxSafeNormalize(back, dir);
    vec3 fwdDir = fxSafeNormalize(fwd, dir);
    // An exact reversal makes dir + neighbourDir zero. Falling back to the
    // current segment keeps the join finite instead of feeding NaNs to the
    // clip-space position for the whole instance.
    vec3 t0 = fxSafeNormalize(dir + backDir, dir);
    vec3 t1 = fxSafeNormalize(dir + fwdDir, dir);
    vec3 tangent = fxSafeNormalize(mix(t0, t1, u), dir);

    // Everything below is a function of the node and its age only -- never of
    // the segment -- so the two segments meeting at a node compute identical
    // results and the ribbon stays watertight.
    vec3 world = p + uWind * (uWindDrift * age);
    world += fxCurl(p * uTurbFreq + vec3(0.0, uTime * uTurbSpeed, 0.0)) * (uTurb * age);
    vWorld = world;

    float halfWidth = mix(aData.z, aData.w, u) * (1.0 + uSpread * age);
    // Draw the newest end to a point so the trail grows out of the wingtip
    // instead of appearing as a blunt rectangle.
    halfWidth *= smoothstep(0.0, max(uTaper, 1e-4), t);

    vec3 toCam = fxSafeNormalize(cameraPosition - world, vec3(0.0, 0.0, 1.0));
    vec3 binormal = cross(tangent, toCam);
    vec3 fallbackAxis = abs(tangent.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
    binormal = fxSafeNormalize(binormal, fxSafeNormalize(cross(tangent, fallbackAxis), vec3(1.0, 0.0, 0.0)));

    vec3 finalPos = world + binormal * (side * halfWidth);

    vec3 faceNormal = fxSafeNormalize(cross(tangent, binormal), toCam);
    vNdl = dot(faceNormal, uSunDir);

    vec4 mv = viewMatrix * vec4(finalPos, 1.0);
    vViewZ = mv.z;
    vForward = clamp(dot(-toCam, uSunDir), 0.0, 1.0);
    gl_Position = projectionMatrix * mv;
  }
`;

const RIBBON_FRAGMENT = /* glsl */ `
  precision highp float;

  uniform float uTime;
  uniform float uBreakFreq;
  uniform float uErode;
  uniform float uEdge;
  uniform float uOpacity;
  uniform vec3  uAlbedo;

  in float vT;
  in float vSide;
  in float vViewZ;
  in vec3  vWorld;
  in float vNdl;
  in float vForward;

  out vec4 fragColor;

  ${FX_NOISE_GLSL}
  ${FX_COMMON_GLSL}

  void main() {
    if (vT < 0.0 || vT > 1.0) discard;

    float v = abs(vSide);
    float profile = 1.0 - smoothstep(uEdge, 1.0, v);

    // Dissolve, not fade. A uniform alpha ramp makes a contrail look like it is
    // being turned down with a dial; a rising threshold against a spatial noise
    // field makes it break into billows and gaps, which is what actually
    // happens as the vortex pair collapses.
    float n = fxFbm3(vWorld * uBreakFreq) * 0.5 + 0.5;
    float threshold = vT * uErode - 0.35;
    float dissolve = smoothstep(threshold, threshold + 0.55, n);

    float alpha = profile * dissolve * uOpacity;
    alpha *= fxSoftFade(vViewZ);
    if (alpha < 0.004) discard;

    fragColor = vec4(fxScatter(uAlbedo, vNdl, vForward), alpha);
  }
`;
