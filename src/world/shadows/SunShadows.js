import {
  Fn, float, vec2, ivec2, uniform, reference, renderGroup, texture, textureLoad, If, clamp, step,
  screenCoordinate, interleavedGradientNoise, vogelDiskSample,
} from 'three/tsl';
import { ShadowNode } from 'three/webgpu';
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

const _filters = new WeakMap();

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
 * Fixed-size disc PCF (no blocker search): `radius` is a uniform in metres.
 * Works on WebGL2 (compare samples only).
 */
export function makeDiscPCFFilter({ radius, taps = 12 }) {
  return Fn(({ depthTexture, shadowCoord, shadow }) => {
    const u = shadowUniforms(shadow);
    const size = u.mapSize.x;
    const texel = u.right.sub(u.left).div(size);
    const r = clamp(radius.div(texel), MIN_TEXELS, MAX_TEXELS).div(size);
    const phi = interleavedGradientNoise(screenCoordinate.xy).mul(6.28318530718);
    const acc = float(0).toVar();
    for (let i = 0; i < taps; i++) {
      const uv = shadowCoord.xy.add(vogelDiskSample(i, taps, phi).mul(r));
      acc.addAssign(texture(depthTexture, uv).compare(shadowCoord.z));
    }
    return acc.div(taps);
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
  const filter = cfg.pcss
    ? makePCSSFilter({ tanHalf, blocker: cfg.blocker, taps: cfg.taps })
    : makeDiscPCFFilter({ radius, taps: Math.min(cfg.taps || 12, 12) });
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
    update(cam = camera, keyLight = 'sun') {
      const deg = keyLight === 'moon' ? MOON_ANGULAR_DIAMETER : SUN_ANGULAR_DIAMETER;
      tanHalf.value = penumbraSlope(deg);
      radius.value = fallbackRadius(deg);
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
