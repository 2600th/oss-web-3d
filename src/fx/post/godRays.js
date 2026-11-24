import * as THREE from 'three/webgpu';
import { emitterTaps, emitterBlend } from './godRayMath.js';
import {
  Fn, float, vec2, vec3, vec4, uv, Loop, max, min, mix, smoothstep, select, luminance, rtt, interleavedGradientNoise,
  screenCoordinate, screenSize, exp, log2, uniform, texture, passTexture, getViewPosition, getScreenPosition, NodeUpdateType,
} from 'three/tsl';

/**
 * Screen-space crepuscular rays (Mitchell, "Volumetric Light Scattering as a
 * Post-Process", GPU Gems 3 ch. 13), for a low sun only.
 *
 * The froxel aerial perspective already integrates cloud shadow in 3D (shafts
 * under a cloud deck at any sun angle). What it cannot see is the terrain
 * cutting the sun off (its shadow sweep stops 46 m above the ground) or the
 * clean edges of cloud gaps right around the sun. This pass radially blurs
 * the bright sky around the sun toward each pixel: where a ridge or a cloud
 * body interrupts it, the streak breaks, leaving shafts.
 *
 * Three passes at `scale` of the drawing buffer: an emitter mask from the
 * composited HDR colour and the reversed depth (sky = 0; only sky texels
 * brighter than `floor`, in exposed units, emit, so clouds and terrain are
 * occluders and the sun's surroundings are the source), its accumulation over
 * time (EmitterHistory), then a `samples`-tap radial march over that. The
 * result (exposed HDR, scaled by `u.strength`) is added in the final
 * composite; `u.strength` is 0 unless the sun is on or near the screen, low,
 * and the key light.
 *
 * The returned node carries `.mask`, `.history` (their passes; PostFX skips
 * all three while the strength is 0) and `.updateCamera(camera, cut)`, to be
 * called once per frame before the pipeline renders.
 */
export function createGodRays({ color, depth, sunUV, exposure, aspect, near, far, samples = 32, scale = 0.25, u }) {
  const n = samples;
  // 1. Emitters at `scale`: bright sky texels (around the sun, silver cloud
  //    edges), capped so the disc cannot dominate.
  //    [cloud flicker] Each tap is the mean of a 2x2 pixel footprint, floored
  //    and capped. There were four of them side by side per mask texel; one
  //    sun pixel (thousands of times the cap) saturates its whole footprint,
  //    so the sun and every thin lit rim emitted by the number of footprints
  //    they happened to touch, which changes with any sub-pixel shift of the
  //    frame. The sun's own texel swung by 30 % from frame to frame, and every
  //    shaft with it. Now sixteen overlapping footprints, one per pixel
  //    (emitterTaps / footprintEmission in godRayMath.js): the same average
  //    brightness, without the dependence on alignment.
  const taps = emitterTaps(scale);
  const mask = rtt(Fn(() => {
    const st = uv();
    const texel = vec2(1).div(screenSize); // the mask target's own texel
    const acc = vec3(0).toVar();
    for (const [ox, oy] of taps) {
      const q = st.add(texel.mul(vec2(ox, oy)));
      const sky = select(depth.sample(q).x.lessThanEqual(0.0), float(1), float(0));
      const c = color.sample(q).rgb.mul(exposure);
      const e = max(luminance(c).sub(u.floor), 0).min(u.cap);
      acc.addAssign(c.div(max(luminance(c), 1e-4)).mul(e).mul(sky));
    }
    return vec4(acc.div(taps.length), 1);
  })(), null, null, { type: THREE.HalfFloatType, resolutionScale: scale });
  mask.name = 'GodRays.mask';

  // 2. [cloud flicker] The emitters, accumulated over time (see EmitterHistory).
  const history = new EmitterHistory(mask);
  const emitters = history.textureNode;

  // 3. Radial march toward the sun over the accumulated mask.
  const node = Fn(() => {
    const st = uv().toVar();
    const toSun = sunUV.sub(st).toVar();
    const len = toSun.mul(vec2(aspect, 1)).length();
    const span = min(len, 0.5).div(max(len, 1e-4)); // at most half the frame
    const step = toSun.mul(span).div(n).toVar();
    // [cloud flicker] The taps are up to 6 mask texels (24 px) apart, and the
    // emitters are thin: lit cloud rims a texel or two wide. Each tap either
    // hit a rim or stepped over it, so a shaft was a comb of thin streaks, and
    // the comb re-drew itself whenever a rim moved by a fraction of a texel
    // (every frame: clouds drift and their rims shimmer). Read the mask at the
    // mip whose texel is one step long instead: every rim along the ray counts
    // by its true share, whatever the tap spacing.
    const lod = log2(max(step.mul(screenSize).length(), 1)).toVar(); // = rayMarchLod(), godRayMath.js
    // per-texel start jitter turns the residual staircase into fine noise
    const p = st.add(step.mul(interleavedGradientNoise(screenCoordinate.xy))).toVar();
    const acc = vec3(0).toVar();
    const w = float(1).toVar();
    Loop(n, () => {
      p.addAssign(step);
      // (not .sample().level(): a pass texture's clone() keeps neither, so
      // the second call would drop the first's coordinates)
      const tap = emitters.sample(p.clamp(0, 1));
      tap.levelNode = lod;
      acc.addAssign(tap.rgb.mul(w));
      w.mulAssign(u.decay);
    });
    // fall-off away from the sun in the frame
    const fall = smoothstep(1.1, 0.0, len);
    // the shafts are light scattered along the view ray: a ridge 2 km away
    // has little air in front of it, the sky has all of it
    // [cloud flicker] the nearest of the four depths under this texel (reversed
    // Z: the largest). One tap at the centre flipped between the aircraft and
    // the sky behind it along every silhouette, as the frame's sub-pixel
    // jitter moved the edge across it: full shaft light one frame, none the
    // next, in a ring around the jet.
    const dq = vec2(0.25).div(screenSize);
    const dAt = (ox, oy) => depth.sample(st.add(dq.mul(vec2(ox, oy)))).x;
    const d = max(max(dAt(-1, -1), dAt(1, -1)), max(dAt(-1, 1), dAt(1, 1))).toVar();
    const dist = near.mul(far).div(d.mul(far.sub(near)).add(near));
    const air = select(d.lessThanEqual(0.0), float(1), float(1).sub(exp(dist.div(u.airLength).negate())));
    return vec4(acc.div(n).mul(fall).mul(air), 1);
  })();
  const tex = rtt(node, null, null, { type: THREE.HalfFloatType, resolutionScale: scale });
  tex.name = 'GodRays';
  tex.mask = mask;
  tex.history = history;
  tex.updateCamera = (camera, cut) => history.updateCamera(camera, cut);
  return tex;
}

/**
 * [cloud flicker] Temporal accumulation of the emitter mask.
 *
 * What emits is the sun seen through cloud and the lit rims around it: the
 * product of a radiance thousands of times the cap and a cloud transmittance
 * that is still settling, cut off by a threshold. One frame of it is a noisy
 * estimate, and because the march spreads every emitter texel along half the
 * frame, that noise came out as whole shafts changing brightness together.
 *
 * The emitters are sky, i.e. at infinity, so last frame's mask is reprojected
 * exactly by the camera's rotation alone (no depth, no velocity buffer) and
 * blended with this frame's: an exponential average over about 1 / BLEND
 * frames. History that falls outside the last frame is replaced outright, and
 * a camera cut, a resize or a skipped frame (PostFX skips the pass while the
 * rays are off, and calls restart()) starts it again.
 *
 * The accumulated target carries a mip chain, which the march reads at the
 * level matching its step length.
 */
class EmitterHistory extends THREE.Node {
  static get type() { return 'GodRaysEmitterHistory'; }

  constructor(mask) {
    super('vec4');
    this.mask = mask;
    this.updateBeforeType = NodeUpdateType.FRAME;
    const mk = () => {
      const t = new THREE.RenderTarget(1, 1, {
        type: THREE.HalfFloatType, depthBuffer: false, generateMipmaps: true,
        minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter,
      });
      t.texture.name = 'GodRays.emitters';
      return t;
    };
    this.targets = [mk(), mk()];
    this._write = 0;
    this._quad = new THREE.QuadMesh();
    this.u = {
      projInv: uniform(new THREE.Matrix4()),
      prevProj: uniform(new THREE.Matrix4()),
      // this frame's view space -> last frame's view space, rotation only
      rot: uniform(new THREE.Matrix4()),
      blend: uniform(1),
    };
    this._prevProj = new THREE.Matrix4();
    this._prevRotInv = new THREE.Matrix4();
    this._rot = new THREE.Matrix4();
    this._cut = true;
    this._prev = texture(this.targets[1].texture);
    this.textureNode = passTexture(this, this.targets[0].texture);

    const u = this.u;
    const prev = this._prev;
    const material = new THREE.NodeMaterial();
    material.name = 'GodRays.emitters';
    material.depthTest = false;
    material.depthWrite = false;
    material.fragmentNode = Fn(() => {
      const st = uv();
      const cur = mask.sample(st);
      // a point on this pixel's view ray, carried into last frame's view space
      const ray = getViewPosition(st, float(0.5), u.projInv);
      const was = u.rot.mul(vec4(ray, 0)).xyz;
      const puv = getScreenPosition(was, u.prevProj);
      const inside = was.z.lessThan(0).and(puv.x.greaterThan(0)).and(puv.x.lessThan(1)).and(puv.y.greaterThan(0)).and(puv.y.lessThan(1));
      const old = prev.sample(puv).level(0).max(0);
      return vec4(mix(old, cur, select(inside, u.blend, float(1))).rgb, 1);
    })();
    this._material = material;
  }

  /** Once per frame, with the unjittered camera, before the pipeline renders. */
  updateCamera(camera, cut = false) {
    const u = this.u;
    this._rot.extractRotation(camera.matrixWorld);
    u.projInv.value.copy(camera.projectionMatrixInverse);
    u.prevProj.value.copy(this._prevProj);
    u.rot.value.multiplyMatrices(this._prevRotInv, this._rot);
    this._prevProj.copy(camera.projectionMatrix);
    this._prevRotInv.copy(this._rot).transpose();
    if (cut) this._cut = true;
  }

  /** The pass was skipped this frame (rays off): what it holds is no longer last frame's. */
  restart() { this._cut = true; }

  updateBefore(frame) {
    const renderer = frame.renderer;
    const src = this.mask.renderTarget;
    const [a, b] = this.targets;
    let restart = this._cut;
    if (a.width !== src.width || a.height !== src.height) {
      a.setSize(src.width, src.height);
      b.setSize(src.width, src.height);
      restart = true;
    }
    this._cut = false;
    this.u.blend.value = emitterBlend(restart);
    const write = this.targets[this._write];
    this._prev.value = this.targets[1 - this._write].texture;
    this._state = THREE.RendererUtils.resetRendererState(renderer, this._state);
    try {
      this._quad.material = this._material;
      renderer.setRenderTarget(write);
      this._quad.render(renderer);
    } finally {
      THREE.RendererUtils.restoreRendererState(renderer, this._state);
    }
    this.textureNode.value = write.texture;
    this._write = 1 - this._write;
  }

  setup() { return this.textureNode; }

  dispose() {
    for (const t of this.targets) t.dispose();
    this._material.dispose();
  }
}

/**
 * Strength of the rays for a sun direction (world, unit) and on-screen amount
 * (PostFX `sunAmount`: in front, on screen, sun is the key light). Pure.
 * Rays are a low-sun phenomenon: full below 6 degrees, gone by 24.
 */
export function godRayStrength(sunElevationDeg, sunAmount, gain = 1) {
  const t = Math.min(1, Math.max(0, (24 - sunElevationDeg) / 18));
  const low = t * t * (3 - 2 * t);
  return gain * low * Math.min(1, Math.max(0, sunAmount));
}
