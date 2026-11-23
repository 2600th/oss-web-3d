import * as THREE from 'three';
import { FX_NOISE_GLSL } from './noise.glsl.js';
import { FX_COMMON_GLSL } from './common.glsl.js';
import { sharedUniforms, registerFxMaterial, unregisterFxMaterial } from './FrameUniforms.js';

/**
 * GPU particles: the CPU writes spawn data, the vertex shader does the physics.
 *
 * Adapted from LinearAbiltyCastingThreeJS (MIT), src/particles/ParticleSystem.js.
 *
 * Every particle's whole trajectory is a closed-form function of its age, so
 * there is no simulation step at all. Ballistic motion with exponential drag
 * integrates exactly --
 *
 *     travel = (1 - exp(-k * age)) / k
 *     pos    = start + velocity * travel + 0.5 * gravity * age^2
 *
 * -- which means the same particle lands in the same place whether the frame
 * rate is 30 or 144, and a thousand of them cost the CPU one 14-float write
 * each, once, at birth. The system this replaces integrated 260 snow particles
 * on the main thread every frame and could not have afforded ten times that.
 *
 * The trade is that a particle cannot react to anything after it is born. That
 * is fine for everything here -- snow, sparks, debris, exhaust smoke -- and the
 * one place it would have hurt (a plume that must not sink through a ridge) is
 * covered by the soft depth fade instead.
 *
 * Recycling is a wrapping cursor over a ring buffer: emitting past capacity
 * overwrites the oldest slots, which is the behaviour we want when a crash
 * asks for more debris than the tier budget allows. Only the slots written this
 * frame are uploaded, via addUpdateRange().
 */

/** Procedural fragment silhouettes. There are no sprite textures in this project. */
export const ParticleShape = Object.freeze({
  SOFT: 0, // feathered disc -- embers, droplets, distant snow
  SMOKE: 1, // fbm-eroded puff -- spindrift, snow plume, smoke column
  STREAK: 2, // thin velocity-aligned spark -- debris trails, speed streaks
  CHIP: 3, // angular fragment -- airframe debris
});

const FLOATS = {
  start: 3,
  velocity: 3,
  color: 3,
  spawn: 1,
  life: 1,
  size: 1,
  seed: 1,
  spin: 1,
};

const _tmp = new THREE.Vector3();

export class ParticleSystem {
  /**
   * @param {object} options
   * @param {string}  options.name
   * @param {number}  options.capacity   maximum simultaneous particles
   * @param {number}  options.shape      ParticleShape.*
   * @param {boolean} [options.additive] additive (emissive) vs normal (lit) blending
   * @param {boolean} [options.lit]      shade as thin white condensate instead of emitting
   * @param {boolean} [options.curl]     curl-noise turbulence rather than a cheap wobble
   * @param {boolean} [options.stretch]  orient the quad along screen-space velocity
   * @param {boolean} [options.wind]     advect with the environment wind
   * @param {boolean} [options.depthTest] test against opaque scene depth
   * @param {boolean} [options.softDepth] fade against the shared scene-depth texture
   * @param {number}  [options.softFade]  world-space soft-depth fade distance
   * @param {number}  [options.renderOrder]
   */
  constructor({
    name,
    capacity = 512,
    shape = ParticleShape.SOFT,
    additive = true,
    lit = false,
    curl = false,
    stretch = false,
    wind = false,
    depthTest = true,
    softDepth = true,
    softFade = 40,
    renderOrder = 12,
  }) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new RangeError('ParticleSystem capacity must be a positive integer');
    }
    if (!Object.values(ParticleShape).includes(shape)) {
      throw new RangeError('ParticleSystem shape must be a ParticleShape value');
    }
    this.name = name;
    this.capacity = capacity;
    this.active = capacity;
    this.cursor = 0;

    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(
        new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]),
        3,
      ),
    );
    geometry.setAttribute(
      'uv',
      new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2),
    );
    geometry.setIndex(new THREE.BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3]), 1));

    this.data = {};
    this.attributes = {};
    for (const [key, itemSize] of Object.entries(FLOATS)) {
      const array = new Float32Array(capacity * itemSize);
      const attribute = new THREE.InstancedBufferAttribute(array, itemSize).setUsage(
        THREE.DynamicDrawUsage,
      );
      this.data[key] = array;
      this.attributes[key] = attribute;
      geometry.setAttribute(`a${key[0].toUpperCase()}${key.slice(1)}`, attribute);
    }
    // Everything starts dead. spawn is pushed far into the past so age > life
    // even before the shared clock has advanced at all.
    this.data.spawn.fill(-1e5);
    geometry.instanceCount = capacity;
    // Positions are computed in the vertex shader, so nothing the CPU knows
    // bounds this mesh.
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);
    this.geometry = geometry;

    const defines = { SHAPE: shape };
    if (curl) defines.USE_CURL = '';
    if (stretch) defines.USE_STRETCH = '';
    if (wind) defines.USE_WIND = '';
    if (lit) defines.USE_LIT = '';

    this.material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      defines,
      transparent: true,
      depthWrite: false,
      depthTest,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      side: THREE.DoubleSide,
      uniforms: sharedUniforms({
        // Per-material on purpose: impact fire and smoke need distinct terrain
        // contact fades without mutating the shared frame-uniform default.
        uSoftFade: { value: softFade },
        uGravity: { value: new THREE.Vector3(0, -9.80665, 0) },
        uDrag: { value: 0.6 },
        uTurbulence: { value: 0 },
        uTurbFrequency: { value: 0.02 },
        uTurbSpeed: { value: 0.35 },
        uWindScale: { value: 1 },
        uSizeScale: { value: 1 },
        uLifeScale: { value: 1 },
        uEndSize: { value: 1.6 },
        uSizeIn: { value: 0.08 },
        uFadeIn: { value: 0.06 },
        uFadeOut: { value: 0.45 },
        uOpacity: { value: 1 },
        uGlow: { value: 1 },
        uStretch: { value: 0.05 },
        uStretchWorld: { value: new THREE.Vector3() },
        // Half-width falloff for STREAK shapes. 3.4 preserves the narrow
        // spark/condensation silhouette; speed streaks override it because a
        // one-pixel billboard has no MSAA coverage to rescue a sub-pixel core.
        uStreakCore: { value: 3.4 },
        // (nearIn0, nearIn1, farOut0, farOut1) in metres of view distance.
        // Defaults are a deliberate no-op; edges must stay ordered or the
        // smoothsteps are undefined.
        uDistFade: { value: new THREE.Vector4(-2, -1, 1e9, 2e9) },
        uColor0: { value: new THREE.Color(1, 1, 1) },
        uColor1: { value: new THREE.Color(1, 1, 1) },
        uColor2: { value: new THREE.Color(1, 1, 1) },
        uColor3: { value: new THREE.Color(1, 1, 1) },
      }),
      vertexShader: PARTICLE_VERTEX,
      fragmentShader: PARTICLE_FRAGMENT,
    });
    this.material.userData.fxSoftDepth = Boolean(softDepth);
    registerFxMaterial(this.material);

    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.renderOrder = renderOrder;
    this.mesh.name = `fx:${name}`;

    this._ranges = [];
    this._dirty = false;
  }

  get uniforms() {
    return this.material.uniforms;
  }

  /**
   * Cap how many slots the ring buffer uses, for quality tiers.
   *
   * The cursor wraps at `active`, not at capacity, so a lowered budget recycles
   * the head of the buffer rather than emitting into slots the draw call no
   * longer covers.
   */
  setActive(count) {
    if (!Number.isFinite(count)) throw new RangeError('ParticleSystem active count must be finite');
    const previous = this.active;
    this.active = THREE.MathUtils.clamp(Math.round(count), 0, this.capacity);
    if (this.active < previous) {
      this.data.spawn.fill(-1e5, this.active, previous);
      this._markDirtyRange(this.active, previous - this.active);
    }
    this.geometry.instanceCount = this.active;
    if (this.cursor >= this.active) this.cursor = 0;
    this.mesh.visible = this.active > 0;
  }

  /**
   * Write `count` spawn records.
   *
   * `p` is read and never retained, so callers keep one scratch object per
   * emitter and the frame allocates nothing.
   *
   * @param {number} count
   * @param {object} p
   * @param {THREE.Vector3} p.position
   * @param {number}  [p.radius]        random offset within a ball of this radius
   * @param {THREE.Vector3} [p.velocity] explicit base velocity (wins over direction/speed)
   * @param {THREE.Vector3} [p.direction] unit direction for the emission cone
   * @param {number}  [p.speed]
   * @param {number}  [p.speedVariance] 0..1
   * @param {number}  [p.spread]        0 = a ray, 1 = a sphere
   * @param {THREE.Vector3} [p.inherit] velocity added to every particle
   * @param {number}  [p.size]
   * @param {number}  [p.sizeVariance]
   * @param {number}  [p.life]          seconds
   * @param {number}  [p.lifeVariance]
   * @param {number}  [p.spin]          radians/second, randomly signed
   * @param {THREE.Color} [p.tint]      per-particle multiplier on the gradient
   * @param {number}  p.time            current shared clock
   */
  emit(count, p) {
    if (count <= 0 || this.active <= 0) return;
    count = Math.min(count, this.active);

    const {
      position,
      radius = 0,
      velocity = null,
      direction = null,
      speed = 1,
      speedVariance = 0.3,
      spread = 0.4,
      inherit = null,
      size = 1,
      sizeVariance = 0.35,
      life = 1,
      lifeVariance = 0.3,
      spin = 0,
      tint = null,
      time = 0,
    } = p;

    const d = this.data;

    for (let n = 0; n < count; n++) {
      const i = this.cursor;
      this.cursor = (this.cursor + 1) % this.active;
      this._markDirty(i);

      const i3 = i * 3;

      let ox = 0;
      let oy = 0;
      let oz = 0;
      if (radius > 0) {
        const r = radius * Math.cbrt(Math.random());
        const theta = Math.random() * Math.PI * 2;
        const phi = Math.acos(2 * Math.random() - 1);
        const s = Math.sin(phi);
        ox = r * s * Math.cos(theta);
        oy = r * Math.cos(phi);
        oz = r * s * Math.sin(theta);
      }
      d.start[i3] = position.x + ox;
      d.start[i3 + 1] = position.y + oy;
      d.start[i3 + 2] = position.z + oz;

      if (velocity) {
        _tmp.copy(velocity);
        const jitter = 1 + (Math.random() - 0.5) * 2 * speedVariance;
        _tmp.multiplyScalar(jitter);
        if (spread > 0) {
          const mag = velocity.length() * spread;
          _tmp.x += (Math.random() - 0.5) * 2 * mag;
          _tmp.y += (Math.random() - 0.5) * 2 * mag;
          _tmp.z += (Math.random() - 0.5) * 2 * mag;
        }
      } else {
        if (direction) _tmp.copy(direction);
        else _tmp.set(0, 1, 0);
        if (spread > 0) {
          _tmp.x += (Math.random() - 0.5) * 2 * spread;
          _tmp.y += (Math.random() - 0.5) * 2 * spread;
          _tmp.z += (Math.random() - 0.5) * 2 * spread;
        }
        _tmp.normalize().multiplyScalar(speed * (1 + (Math.random() - 0.5) * 2 * speedVariance));
      }
      if (inherit) _tmp.add(inherit);

      d.velocity[i3] = _tmp.x;
      d.velocity[i3 + 1] = _tmp.y;
      d.velocity[i3 + 2] = _tmp.z;

      d.spawn[i] = time;
      d.life[i] = Math.max(0.05, life * (1 + (Math.random() - 0.5) * 2 * lifeVariance));
      d.size[i] = Math.max(0.001, size * (1 + (Math.random() - 0.5) * 2 * sizeVariance));
      d.seed[i] = Math.random();
      d.spin[i] = (Math.random() - 0.5) * 2 * spin;

      if (tint) {
        d.color[i3] = tint.r;
        d.color[i3 + 1] = tint.g;
        d.color[i3 + 2] = tint.b;
      } else {
        d.color[i3] = 1;
        d.color[i3 + 1] = 1;
        d.color[i3 + 2] = 1;
      }
    }
  }

  _markDirty(index) {
    this._markDirtyRange(index, 1);
  }

  _markDirtyRange(index, count) {
    if (count <= 0) return;
    this._dirty = true;
    const ranges = this._ranges;
    // Emissions walk the cursor, so merging into the previous range is almost
    // always a single comparison and the whole burst uploads as one region.
    const last = ranges[ranges.length - 1];
    if (last && index === last[0] + last[1]) last[1] += count;
    else ranges.push([index, count]);
  }

  /** Upload only the slots written this frame. */
  flush() {
    if (!this._dirty) return;
    for (const [key, itemSize] of Object.entries(FLOATS)) {
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

  setGradient(c0, c1, c2, c3) {
    const u = this.uniforms;
    u.uColor0.value.copy(c0);
    u.uColor1.value.copy(c1);
    u.uColor2.value.copy(c2);
    u.uColor3.value.copy(c3 ?? c2);
    return this;
  }

  reset() {
    this.data.spawn.fill(-1e5);
    for (const key of Object.keys(FLOATS)) {
      const a = this.attributes[key];
      a.clearUpdateRanges();
      a.needsUpdate = true;
    }
    this._ranges.length = 0;
    this._dirty = false;
    this.cursor = 0;
  }

  dispose() {
    unregisterFxMaterial(this.material);
    this.geometry.dispose();
    this.material.dispose();
  }
}

/**
 * Fractional-rate accumulator.
 *
 * Adapted from LinearAbiltyCastingThreeJS (MIT), the RateEmitter in
 * src/particles/ParticleSystem.js.
 *
 * Emitting Math.round(rate * dt) particles a frame is wrong in a way that only
 * shows on slow hardware: at 20 particles/second and 144 fps it rounds to zero
 * every frame and the effect never appears. Carrying the fraction makes density
 * a property of the effect rather than of the frame rate.
 */
export class RateEmitter {
  constructor(rate = 0) {
    this.rate = rate;
    this._acc = 0;
  }

  get rate() {
    return this._rate;
  }

  set rate(value) {
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError('RateEmitter rate must be a finite non-negative number');
    }
    this._rate = value;
  }

  /** @returns {number} whole particles owed this frame, capped against a hitch. */
  tick(dt) {
    if (!Number.isFinite(dt) || dt < 0) {
      throw new RangeError('RateEmitter dt must be a finite non-negative number');
    }
    this._acc += this.rate * dt;
    const owed = Math.floor(this._acc);
    this._acc -= owed;
    return Math.min(240, owed);
  }

  reset() {
    this._acc = 0;
  }
}

/**
 * Fixed spacing in *distance*, not time.
 *
 * A trail emitted on a clock is dense when the aircraft is slow and sparse when
 * it is fast, which is exactly backwards. Emitting one node per N metres makes
 * the trail a property of the flight path.
 */
export class DistanceEmitter {
  constructor(spacing = 10) {
    this.spacing = spacing;
    this._acc = 0;
  }

  get spacing() {
    return this._spacing;
  }

  set spacing(value) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new RangeError('DistanceEmitter spacing must be a finite positive number');
    }
    this._spacing = value;
  }

  /** @returns {number} whole nodes owed for a step of `distance` metres. */
  tick(distance) {
    if (!Number.isFinite(distance) || distance < 0) {
      throw new RangeError('DistanceEmitter distance must be a finite non-negative number');
    }
    this._acc += distance;
    const owed = Math.floor(this._acc / this.spacing);
    this._acc -= owed * this.spacing;
    return Math.min(8, owed);
  }

  reset() {
    this._acc = 0;
  }
}

const PARTICLE_VERTEX = /* glsl */ `
  precision highp float;

  uniform float uTime;
  uniform vec3  uWind;
  uniform vec3  uSunDir;
  uniform vec3  uGravity;
  uniform float uDrag;
  uniform float uTurbulence;
  uniform float uTurbFrequency;
  uniform float uTurbSpeed;
  uniform float uWindScale;
  uniform float uSizeScale;
  uniform float uLifeScale;
  uniform float uEndSize;
  uniform float uSizeIn;
  uniform float uStretch;
  uniform vec3  uStretchWorld;

  in vec3  aStart;
  in vec3  aVelocity;
  in vec3  aColor;
  in float aSpawn;
  in float aLife;
  in float aSize;
  in float aSeed;
  in float aSpin;

  out vec2  vUv;
  out float vT;
  out float vSeed;
  out vec3  vTint;
  out float vViewZ;
  #ifdef USE_LIT
    out vec3  vSunView;
    out float vForward;
  #endif

  ${FX_NOISE_GLSL}

  void main() {
    vUv = uv;
    vSeed = aSeed;
    vTint = aColor;

    float life = aLife * uLifeScale;
    float age = uTime - aSpawn;
    float t = age / max(life, 1e-4);
    vT = t;
    vViewZ = -1.0;

    // Dead particles are collapsed outside the clip volume, so the whole
    // triangle is discarded before rasterisation rather than costing fill.
    if (age < 0.0 || t > 1.0) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      return;
    }

    // Ballistic motion with exponential drag, integrated in closed form.
    float k = max(uDrag, 1e-3);
    float travel = (1.0 - exp(-k * age)) / k;
    vec3 pos = aStart + aVelocity * travel + 0.5 * uGravity * age * age;

    #ifdef USE_WIND
      pos += uWind * (uWindScale * age);
    #endif

    #ifdef USE_CURL
      pos += fxCurl(aStart * uTurbFrequency + vec3(0.0, uTime * uTurbSpeed, 0.0) + aSeed * 4.0)
             * uTurbulence * age;
    #else
      vec3 wobble = vec3(
        sin(age * 3.1 + aSeed * 41.0),
        cos(age * 2.3 + aSeed * 17.0),
        sin(age * 2.7 + aSeed * 73.0)
      );
      pos += wobble * uTurbulence * age * 0.55;
    #endif

    vec4 mv = modelViewMatrix * vec4(pos, 1.0);
    vViewZ = mv.z;

    float grow = smoothstep(0.0, max(uSizeIn, 1e-3), t);
    float size = aSize * uSizeScale * mix(1.0, uEndSize, t) * grow;

    vec2 corner;
    #ifdef USE_STRETCH
      // uStretchWorld exists for particles that are static in the world and
      // whose apparent motion is the *camera's*. Speed streaks have zero
      // velocity of their own, so stretching them along aVelocity would give
      // them no length at all.
      vec3 sv = aVelocity + uStretchWorld;
      vec3 svView = (modelViewMatrix * vec4(sv, 0.0)).xyz;
      vec2 dir = normalize(svView.xy + vec2(1e-5));
      vec2 perp = vec2(-dir.y, dir.x);
      float stretch = 1.0 + uStretch * length(sv);
      corner = dir * (position.y * size * stretch) + perp * (position.x * size);
    #else
      corner = fxRot2(aSpin * age + aSeed * 6.2831) * (position.xy * size);
    #endif

    mv.xy += corner;
    gl_Position = projectionMatrix * mv;

    #ifdef USE_LIT
      vSunView = normalize((viewMatrix * vec4(uSunDir, 0.0)).xyz);
      // 1 when the particle sits between the camera and the sun. Backlit ice is
      // the brightest a contrail ever gets.
      vForward = clamp(dot(normalize(mv.xyz), vSunView), 0.0, 1.0);
    #endif
  }
`;

const PARTICLE_FRAGMENT = /* glsl */ `
  precision highp float;

  uniform float uTime;
  uniform float uOpacity;
  uniform float uGlow;
  uniform float uFadeIn;
  uniform float uFadeOut;
  uniform float uStreakCore;
  uniform vec4  uDistFade;
  uniform vec3  uColor0;
  uniform vec3  uColor1;
  uniform vec3  uColor2;
  uniform vec3  uColor3;

  in vec2  vUv;
  in float vT;
  in float vSeed;
  in vec3  vTint;
  in float vViewZ;
  #ifdef USE_LIT
    in vec3  vSunView;
    in float vForward;
  #endif

  out vec4 fragColor;

  ${FX_NOISE_GLSL}
  ${FX_COMMON_GLSL}

  float shapeMask(vec2 uvIn) {
    vec2 c = (uvIn - 0.5) * 2.0;
    float d = length(c);

    #if SHAPE == 0
      return 1.0 - smoothstep(0.0, 1.0, d);
    #elif SHAPE == 1
      // Two octaves eroding the disc edge. A plain feathered circle reads as a
      // bubble no matter how it is coloured; the ragged silhouette is most of
      // what makes a puff look like it is made of something.
      float n = fxSnoise(vec3(c * 1.7, vSeed * 21.0 + uTime * 0.20));
      n += 0.5 * fxSnoise(vec3(c * 4.3, vSeed * 13.0 - uTime * 0.33));
      return (1.0 - smoothstep(0.06, 1.0, d + n * 0.30)) * 0.92;
    #elif SHAPE == 2
      float core = 1.0 - smoothstep(0.0, 1.0, abs(c.x) * uStreakCore);
      float len = 1.0 - smoothstep(0.0, 1.0, abs(c.y));
      return core * len;
    #else
      float ang = atan(c.y, c.x);
      float r = 0.62 + 0.24 * sin(ang * 5.0 + vSeed * 30.0) + 0.10 * sin(ang * 9.0 - vSeed * 11.0);
      return 1.0 - smoothstep(r - 0.16, r, d);
    #endif
  }

  void main() {
    if (vT < 0.0 || vT > 1.0) discard;

    float mask = shapeMask(vUv);
    if (mask <= 0.004) discard;

    float fade = smoothstep(0.0, max(uFadeIn, 1e-3), vT) *
                 (1.0 - smoothstep(clamp(uFadeOut, 0.0, 0.98), 1.0, vT));
    float alpha = mask * fade * uOpacity;

    // Near and far gates, in metres of view distance. The near one is the
    // reason speed streaks do not read as scratches on the canopy: a streak a
    // few metres off the lens is drawn tens of metres long and sweeps most of
    // the frame in a single frame.
    float dist = -vViewZ;
    alpha *= smoothstep(uDistFade.x, uDistFade.y, dist);
    alpha *= 1.0 - smoothstep(uDistFade.z, uDistFade.w, dist);
    alpha *= fxSoftFade(vViewZ);
    if (alpha < 0.004) discard;

    vec3 color = fxGradient4(uColor0, uColor1, uColor2, uColor3, vT) * vTint;

    #ifdef USE_LIT
      // Treat the billboard as the silhouette of a sphere so a puff has a lit
      // side and a shaded side rather than a flat fill.
      vec2 c = (vUv - 0.5) * 2.0;
      float r2 = clamp(dot(c, c), 0.0, 1.0);
      vec3 n = vec3(c, sqrt(1.0 - r2));
      color = fxScatter(color, dot(n, vSunView), vForward) * uGlow;
    #else
      color *= uGlow;
    #endif

    fragColor = vec4(color, alpha);
  }
`;
