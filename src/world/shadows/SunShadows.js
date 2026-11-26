import {
  Fn, float, vec2, ivec2, uniform, reference, renderGroup, texture, textureLoad, If, clamp, step,
  screenCoordinate, interleavedGradientNoise, vogelDiskSample,
} from 'three/tsl';
import { ShadowNode, Vector3 } from 'three/webgpu';
import { CSMShadowNode } from 'three/addons/csm/CSMShadowNode.js';
import {
  cascadeSplits, cascadeBias, penumbraSlope, fallbackRadius, sunShadowConfig, SUN_ANGULAR_DIAMETER, MOON_ANGULAR_DIAMETER,
} from './shadowMath.js';

/**
 * Key-light (sun / moon) shadows: camera-fitted cascades with a physically
 * sized penumbra.
 *
 * Before this, one 120 m orthographic box followed the player aircraft. At a
 * low sun its footprint on the ground is a 120 m wide strip kilometres long,
 * so ground units only cast while the player was over them, every caster was
 * cut at the strip edge, and with a fixed 1-texel PCF a 16 m antenna mast (and
 * its guy wires) threw a razor-thin line 200 m across the ground; the jet threw
 * a crisp silhouette from a kilometre up. Real shadows from the sun's 0.53 deg
 * disc lose their umbra once the caster is ~107 widths away (a 0.2 m mast:
 * ~21 m), so long thin shadows fade, and a jet's shadow from high up is a faint
 * smudge (see shadowMath.js).
 *
 *  - Cascades: three's CSMShadowNode (practical PSSM splits, square
 *    sphere-sized cascades snapped to whole texels, so they do not shimmer as
 *    the camera moves), fading out over the last quarter of `far`.
 *  - Filter (WebGPU): PCSS. A blocker search reads raw depth around the
 *    receiver, the mean blocker distance sets the penumbra radius
 *    (distance x tan(angular radius)) and a rotated Vogel-disc PCF of that radius
 *    averages hardware 2x2 compares. Thin, far casters fade by themselves.
 *  - Filter without a blocker search (low tier, WebGL2, which cannot load a
 *    compare-sampled depth texture): a rotated disc PCF of a fixed world radius
 *    (shadowMath.fallbackRadius, ~0.14 m), so casters much thinner than that
 *    (guy wires, aerials) still fade instead of drawing hard lines.
 *  - Bias per cascade from its texel size: normal offset ~1.5 texels and a
 *    half-texel depth bias, instead of one fixed 2 m depth bias (which detached
 *    every small shadow from its caster).
 *  - Terrain does not cast into these maps (Terrain.js SHADOW_CAST_CELL); its
 *    own shadow is the heightfield sweep (terrain/shadowSweep.js), which also
 *    shades units and props through env.applyCloudShadow.
 */

const SEARCH_TEXELS = 14; // blocker search radius
const MAX_TEXELS = 28; // largest filter radius (the penumbra is clamped to it)
const MIN_TEXELS = 1.25;
// [ground polish] disc PCF without a blocker search: depth slab boundary (m)
// and the occluder distance (m) whose penumbra the far slab is filtered with
const FAR_SLAB = 6;
const FAR_SEPARATION = 110; // 0.51 m: fades a 0.16 m mast past ~6 m like the PCSS path does

const _filters = new WeakMap();
const _c = new Vector3();

/** Per-shadow uniforms shared by every material using that cascade. */
function shadowUniforms(shadow) {
  let u = _filters.get(shadow);
  if (!u) {
    u = {
      mapSize: reference('mapSize', 'vec2', shadow).setGroup(renderGroup),
      left: reference('camera.left', 'float', shadow).setGroup(renderGroup),
      right: reference('camera.right', 'float', shadow).setGroup(renderGroup),
      near: reference('camera.near', 'float', shadow).setGroup(renderGroup),
      far: reference('camera.far', 'float', shadow).setGroup(renderGroup),
    };
    _filters.set(shadow, u);
  }
  return u;
}

/**
 * PCSS filter for an orthographic (directional) shadow, as a three.js
 * `LightShadow.filterNode`. `tanHalf` is a uniform: tan(angular radius of the light).
 */
export function makePCSSFilter({ tanHalf, blocker = 10, taps = 16 }) {
  return Fn(({ depthTexture, shadowCoord, shadow }, builder) => {
    const reversed = builder.renderer.reversedDepthBuffer === true;
    const u = shadowUniforms(shadow);
    const size = u.mapSize.x;
    const width = u.right.sub(u.left); // metres across the cascade
    const range = u.far.sub(u.near); // metres of depth per unit of stored depth (orthographic)
    const texel = width.div(size);
    const z = shadowCoord.z;
    const phi = interleavedGradientNoise(screenCoordinate.xy).mul(6.28318530718);

    // 1. Blocker search: mean distance (m) to whatever sits between receiver and light.
    const sum = float(0).toVar();
    const count = float(0).toVar();
    const maxI = size.sub(1);
    for (let i = 0; i < blocker; i++) {
      const o = vogelDiskSample(i, blocker, phi).mul(SEARCH_TEXELS);
      const st = shadowCoord.xy.mul(size).add(o);
      const d = textureLoad(depthTexture, ivec2(clamp(st, vec2(0), vec2(maxI)))).x;
      const sep = (reversed ? d.sub(z) : z.sub(d)).mul(range);
      // a blocker is clearly closer to the light than the receiver plane, so the
      // receiver's own neighbourhood on a sloped face does not count
      const thr = texel.mul(o.length().add(2));
      const hit = step(thr, sep);
      sum.addAssign(sep.mul(hit));
      count.addAssign(hit);
    }

    const lit = float(1).toVar();
    If(count.greaterThan(0), () => {
      // 2. Penumbra radius from the light's angular size, in texels.
      const dist = sum.div(count);
      const r = clamp(dist.mul(tanHalf).div(texel), MIN_TEXELS, MAX_TEXELS).div(size);
      // 3. PCF over that disc (each tap is a hardware 2x2 compare).
      const acc = float(0).toVar();
      const phi2 = phi.add(1.3);
      for (let i = 0; i < taps; i++) {
        const uv = shadowCoord.xy.add(vogelDiskSample(i, taps, phi2).mul(r));
        acc.addAssign(texture(depthTexture, uv).compare(z));
      }
      lit.assign(acc.div(taps));
    });
    return lit;
  });
}

/**
 * Disc PCF without a blocker search: `radius` is a uniform in metres.
 * Works on WebGL2 (compare samples only).
 *
 * [ground polish] Two depth slabs instead of one fixed disc. A single 0.14 m
 * disc left a 16 m mast (0.16 m thick) drawing a dark, razor-thin line 25 m
 * across the snow on WebGL2, where PCSS on WebGPU fades it: past ~17 m from a
 * 0.16 m caster the sun's disc is never fully covered. Without raw depth
 * reads the occluder distance cannot be measured, but it can be bracketed
 * with compares: comparing at a reference moved `farSlab` metres toward the
 * light counts only occluders farther than that from the receiver. Those get
 * the wide disc (`farRadius`, the penumbra half-width ~110 m out), the
 * near ones keep the contact-sharp `radius`:
 *   lit = pcf(z, r) - pcf(z', r) + pcf(z', R)
 * The near and far compares at radius r share taps; the wide disc runs only
 * where a far occluder is within the narrow one or `taps` / 2 samples of the
 * wide disc see one (most lit and contact-shadowed pixels skip it).
 */
export function makeDiscPCFFilter({ radius, taps = 12, farSlab = null, farRadius = null }) {
  return Fn(({ depthTexture, shadowCoord, shadow }, builder) => {
    const reversed = builder.renderer.reversedDepthBuffer === true;
    const u = shadowUniforms(shadow);
    const size = u.mapSize.x;
    const texel = u.right.sub(u.left).div(size);
    const r = clamp(radius.div(texel), MIN_TEXELS, MAX_TEXELS).div(size);
    const phi = interleavedGradientNoise(screenCoordinate.xy).mul(6.28318530718);
    const z = shadowCoord.z;
    if (!farSlab || !farRadius) {
      const acc = float(0).toVar();
      for (let i = 0; i < taps; i++) {
        const uv = shadowCoord.xy.add(vogelDiskSample(i, taps, phi).mul(r));
        acc.addAssign(texture(depthTexture, uv).compare(z));
      }
      return acc.div(taps);
    }
    // the reference `farSlab` metres nearer the light (orthographic: depth is linear in metres)
    const dz = farSlab.div(u.far.sub(u.near));
    const zFar = reversed ? z.add(dz) : z.sub(dz);
    const all = float(0).toVar();
    const nearFar = float(0).toVar();
    for (let i = 0; i < taps; i++) {
      const uv = shadowCoord.xy.add(vogelDiskSample(i, taps, phi).mul(r));
      all.addAssign(texture(depthTexture, uv).compare(z));
      nearFar.addAssign(texture(depthTexture, uv).compare(zFar));
    }
    const lit = all.div(taps).toVar();
    const R = clamp(farRadius.div(texel), MIN_TEXELS, MAX_TEXELS).div(size);
    // a cheap probe of the wide disc: any far occluder there at all?
    const probe = float(0).toVar();
    const half = Math.max(4, taps >> 1);
    const phi2 = phi.add(2.1);
    for (let i = 0; i < half; i++) {
      probe.addAssign(texture(depthTexture, shadowCoord.xy.add(vogelDiskSample(i, half, phi2).mul(R))).compare(zFar));
    }
    If(nearFar.lessThan(taps - 0.001).or(probe.lessThan(half - 0.001)), () => {
      const wide = probe.toVar();
      const phi3 = phi.add(4.2);
      for (let i = 0; i < taps; i++) {
        wide.addAssign(texture(depthTexture, shadowCoord.xy.add(vogelDiskSample(i, taps, phi3).mul(R))).compare(zFar));
      }
      // far occluders seen through the wide disc instead of the narrow one
      lit.assign(clamp(lit.sub(nearFar.div(taps)).add(wide.div(taps + half)), 0, 1));
    });
    return lit;
  });
}

/**
 * A cascade's ShadowNode without the material's `receivedShadowNode`: three
 * applies that hook inside each cascade's node, so it would be skipped wherever
 * no cascade covers the pixel (past `far`, which is most of the terrain) and
 * applied up to twice in the fade bands. SunCascades applies it once, outside.
 * (Mirrors ShadowNode.setup in three r187 minus the hook.)
 */
class CascadeShadowNode extends ShadowNode {
  setup(builder) {
    if (builder.renderer.shadowMap.enabled === false) return;
    return Fn(() => {
      const type = builder.renderer.shadowMap.type;
      if (this._currentShadowType !== type) {
        this._reset();
        this._node = null;
      }
      this.setupShadowPosition(builder);
      if (this._node === null) {
        this._node = this.setupShadow(builder);
        this._currentShadowType = type;
      }
      return this._node;
    })();
  }
}

/** CSMShadowNode bound to the game camera, with per-cascade bias and filter. */
class SunCascades extends CSMShadowNode {
  constructor(light, camera, cfg, filter) {
    super(light, {
      cascades: cfg.cascades,
      maxFar: cfg.far,
      mode: 'custom',
      lightMargin: cfg.margin,
      customSplitsCallback: (count, near, far, target) => cascadeSplits(count, near, far, cfg.lambda, target),
    });
    this.fade = true;
    this._gameCamera = camera;
    this._cfg = cfg;
    this._filter = filter;
    /**
     * [engine perf] Do not redraw a cascade that nothing can sample this frame
     * (see _markReceivers). false = redraw every cascade every frame.
     */
    this.cullEmpty = true;
    /** (cameraPosition, radius) => true when no terrain is within `radius` (set by Terrain). */
    this.terrainClear = null;
    /** Per cascade: 1 when it was needed in the last render (dev / tests). */
    this.needed = new Uint8Array(cfg.cascades).fill(1);
    this._lo = new Float32Array(cfg.cascades);
    this._hi = new Float32Array(cfg.cascades);
    this._view = { px: 0, py: 0, pz: 0, fx: 0, fy: 0, fz: -1, mask: 0, left: 0, terrain: false };
  }

  updateBefore(frame) {
    super.updateBefore(frame);
    this._markReceivers(frame);
  }

  /**
   * [engine perf] Which cascades can be sampled in this render. A pixel reads
   * cascade i only when its view depth lies in that cascade's slice (plus the
   * fade band, see CSMShadowNode._setupFade), and only objects with
   * `receiveShadow` read the shadow at all. So a cascade whose slice holds no
   * receiver is never sampled, and drawing its map (every caster in it, again)
   * buys nothing: at altitude the jet alone sits in the first slice and the
   * ground in the last one. The test is conservative: bounding boxes with
   * slack by depth only (no side planes), anything it cannot bound counts for
   * every cascade, and the terrain (group.userData.cascadeReceiver) is asked
   * for through `terrainClear` with the distance of the slice's far corners.
   * A skipped map keeps its old content until its slice has a receiver again;
   * it is redrawn in that same render, before anything samples it.
   */
  _markReceivers(frame) {
    const lights = this.lights;
    const n = lights.length;
    const need = this.needed;
    const cam = frame?.camera;
    const scene = frame?.scene;
    if (!this.cullEmpty || !cam || !scene || !this.camera) {
      for (let i = 0; i < n; i++) { need[i] = 1; lights[i].shadow.autoUpdate = true; }
      return;
    }
    // slices in metres of view depth, as the shader computes them
    const near = this.camera.near;
    const span = Math.min(this.maxFar, this.camera.far) - near;
    for (let i = 0; i < n; i++) {
      const c = this._cascades[i];
      this._lo[i] = near + (c.x - 0.125 * c.x * c.x) * span - 0.5;
      this._hi[i] = near + (i === n - 1 ? c.y : c.y + 0.125 * c.y * c.y) * span + 0.5;
      need[i] = 0;
    }
    const e = cam.matrixWorld.elements;
    const v = this._view;
    const fl = Math.hypot(e[8], e[9], e[10]) || 1;
    v.fx = -e[8] / fl; v.fy = -e[9] / fl; v.fz = -e[10] / fl;
    v.px = e[12]; v.py = e[13]; v.pz = e[14];
    v.mask = cam.layers.mask;
    v.left = n;
    v.terrain = false;
    this._walk(scene);
    if (v.terrain && v.left > 0) {
      // Terrain in view at distance r has view depth >= r * cos(angle of the
      // frustum's corner rays): clear of it out to hi / cos means none in the slice.
      let k = 0;
      if (this.terrainClear && cam.isPerspectiveCamera) {
        const t = Math.tan(cam.fov * Math.PI / 360) / (cam.zoom || 1);
        k = Math.sqrt(1 + t * t * (1 + cam.aspect * cam.aspect)) * 1.05;
      }
      _c.set(v.px, v.py, v.pz);
      for (let i = 0; i < n; i++) {
        if (need[i] === 0 && !(k > 0 && this.terrainClear(_c, this._hi[i] * k))) need[i] = 1;
      }
    }
    for (let i = 0; i < n; i++) lights[i].shadow.autoUpdate = need[i] === 1;
  }

  _markAll() {
    this.needed.fill(1);
    this._view.left = 0;
  }

  _walk(o) {
    const v = this._view;
    if (o.visible === false || v.left === 0) return;
    if (o.userData.cascadeReceiver === 'terrain') { v.terrain = true; return; }
    if (o.receiveShadow === true && (o.isMesh || o.isLine || o.isPoints || o.isSprite) && (o.layers.mask & v.mask) !== 0) {
      const g = o.geometry;
      if (!g || o.isInstancedMesh || o.isBatchedMesh || o.isSkinnedMesh) {
        this._markAll();
        return;
      }
      if (g.boundingBox === null) g.computeBoundingBox();
      const bb = g.boundingBox;
      const hx = (bb.max.x - bb.min.x) / 2;
      const hy = (bb.max.y - bb.min.y) / 2;
      const hz = (bb.max.z - bb.min.z) / 2;
      if (!(hx >= 0 && hy >= 0 && hz >= 0) || !Number.isFinite(hx + hy + hz)) {
        this._markAll();
        return;
      }
      // depth extent of the oriented box along the view direction: a fuselage
      // seen from the side is thin, a sphere around it is not
      const m = o.matrixWorld.elements;
      _c.set((bb.max.x + bb.min.x) / 2, (bb.max.y + bb.min.y) / 2, (bb.max.z + bb.min.z) / 2).applyMatrix4(o.matrixWorld);
      const r = (Math.abs(m[0] * v.fx + m[1] * v.fy + m[2] * v.fz) * hx
        + Math.abs(m[4] * v.fx + m[5] * v.fy + m[6] * v.fz) * hy
        + Math.abs(m[8] * v.fx + m[9] * v.fy + m[10] * v.fz) * hz) * 1.1 + 0.5; // slack
      const d = (_c.x - v.px) * v.fx + (_c.y - v.py) * v.fy + (_c.z - v.pz) * v.fz;
      const need = this.needed;
      for (let i = 0; i < need.length; i++) {
        if (need[i] === 0 && d + r >= this._lo[i] && d - r <= this._hi[i]) { need[i] = 1; v.left--; }
      }
    }
    const ch = o.children;
    for (let i = 0; i < ch.length; i++) this._walk(ch[i]);
  }

  // CSMShadowNode takes the camera of whatever first builds a lit material;
  // that may be an off-screen camera. Always fit the cascades to the game camera.
  _init({ renderer }) {
    super._init({ camera: this._gameCamera, renderer });
    this.lights.forEach((l, i) => { this._shadowNodes[i] = new CascadeShadowNode(l, l.shadow); });
    for (const l of this.lights) {
      const s = l.shadow;
      s.camera.near = 1;
      s.camera.far = this._cfg.depth;
      s.camera.layers.mask = this._cfg.layers;
      s.camera.updateProjectionMatrix();
      if (this._filter) s.filterNode = this._filter;
      s.radius = this._cfg.pcfRadius;
      s.needsUpdate = true; // draw every map once, also one that starts out empty
    }
    this.refreshBias();
  }

  setup(builder) {
    const out = super.setup(builder);
    const received = builder.material.receivedShadowNode;
    return received ? received(out) : out;
  }

  /** Bias from each cascade's current texel size (call after updateFrustums). */
  refreshBias() {
    for (const l of this.lights) {
      const s = l.shadow;
      const c = s.camera;
      const texel = (c.right - c.left) / s.mapSize.x;
      const b = cascadeBias(texel);
      s.normalBias = b.normal;
      s.bias = -b.depth / (c.far - c.near);
    }
  }
}

/**
 * Install cascaded shadows on a DirectionalLight. Returns a controller:
 *   update(camera, keyLight)  per frame: refits after FOV / aspect changes
 *   node                      the CSMShadowNode (dev: node.lights[i].shadow)
 *   config                    the tier config in use
 */
export function installSunShadows(light, camera, { tier, backend, layers = 1 }) {
  const cfg = {
    ...sunShadowConfig(tier, backend),
    margin: 320, // casters this far beyond a cascade, toward the light, still cast
    depth: 12000, // cascade depth range (m); generous: receivers past it would read as shadowed
    layers,
    pcfRadius: 1.5,
  };
  light.castShadow = true;
  light.shadow.mapSize.setScalar(cfg.mapSize);
  light.shadow.camera.near = 1;
  light.shadow.camera.far = cfg.depth;

  const tanHalf = uniform(penumbraSlope(SUN_ANGULAR_DIAMETER));
  const radius = uniform(fallbackRadius(SUN_ANGULAR_DIAMETER));
  // [ground polish] WebGL2 / low: occluders more than FAR_SLAB metres from the
  // receiver are filtered with the penumbra of one FAR_SEPARATION metres out
  const farSlab = uniform(FAR_SLAB);
  const farRadius = uniform(fallbackRadius(SUN_ANGULAR_DIAMETER, FAR_SEPARATION));
  const filter = cfg.pcss
    ? makePCSSFilter({ tanHalf, blocker: cfg.blocker, taps: cfg.taps })
    : makeDiscPCFFilter({ radius, taps: Math.min(cfg.taps || 12, 12), farSlab, farRadius });
  const node = new SunCascades(light, camera, cfg, filter);
  light.shadow.shadowNode = node;

  let fov = -1;
  let aspect = -1;
  let near = -1;
  return {
    node,
    config: cfg,
    tanHalf,
    radius,
    farSlab, // [ground polish] WebGL2 / low disc PCF slabs (uniforms, metres)
    farRadius,
    update(cam = camera, keyLight = 'sun') {
      const deg = keyLight === 'moon' ? MOON_ANGULAR_DIAMETER : SUN_ANGULAR_DIAMETER;
      tanHalf.value = penumbraSlope(deg);
      radius.value = fallbackRadius(deg);
      farRadius.value = fallbackRadius(deg, FAR_SEPARATION);
      if (!node.camera) return; // not built yet
      if (Math.abs(cam.fov - fov) > 0.25 || cam.aspect !== aspect || cam.near !== near) {
        fov = cam.fov; aspect = cam.aspect; near = cam.near;
        node.updateFrustums();
        node.refreshBias();
      }
    },
    dispose() { node.dispose(); },
  };
}
