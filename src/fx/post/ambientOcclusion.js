import * as THREE from 'three/webgpu';
import {
  pass, uniform, float, vec4, uv, texture, screenUV, positionView, abs, max, mix, select, clamp,
  perspectiveDepthToViewZ, reference, context, Fn,
} from 'three/tsl';
import GTAONode from 'three/addons/tsl/display/GTAONode.js';

/**
 * GTAO that also writes the prepass view distance next to the AO
 * (rg = ao, -distance; background keeps the clear value). One texture for the
 * scene materials to sample instead of two: the terrain material already sits
 * at 15 of the 16 sampled textures WebGPU guarantees per stage, and every
 * other lit material pays one binding, not two.
 */
class PackedGTAONode extends GTAONode {
  constructor(depthNode, camera, distanceNode) {
    super(depthNode, null, camera);
    this.distanceNode = distanceNode;
    const t = this._aoRenderTarget.texture;
    t.format = THREE.RGFormat;
    t.type = THREE.HalfFloatType;
  }

  setup(builder) {
    const out = super.setup(builder);
    const aoFn = this._ao;
    const dist = this.distanceNode;
    this._ao = Fn(() => vec4(aoFn(), dist.negate(), 0, 1));
    this._material.fragmentNode = this._ao();
    this._material.needsUpdate = true;
    return out;
  }
}

/**
 * Near-field ambient occlusion on *indirect* light only (sky IBL + hemisphere
 * fill, diffuse and specular), WebGPU only.
 *
 * Why a prepass: AO computed from the main pass's own depth can only be
 * applied in post, where it multiplies direct sunlight too (a sunlit intake
 * lip goes grey). Applied through three's `builtinAOContext` on the scene pass
 * it reaches the lighting model, which multiplies only `indirectDiffuse` and
 * the specular-occluded `indirectSpecular`. That needs the AO before the scene
 * pass, so a depth-only prepass renders what is close:
 *
 *   prepass   opaque objects on the main camera's layers (aircraft, cockpit,
 *             pilot, ground units, props and, within `far`, the terrain), a
 *             depth-only override material, transparent objects skipped,
 *             half resolution, far plane `far` m (everything further, and the
 *             sky, is background and costs one discarded fragment)
 *   GTAO      three's GTAONode on that depth (normals rebuilt from depth),
 *             temporal slice rotation (TRAA in the main chain integrates it).
 *             The radius grows with distance: ~0.5 m on the jet in a close
 *             chase (intake, wing roots, pylons, canopy frame, cockpit
 *             consoles), several metres on terrain and units a few hundred
 *             metres away
 *   apply     scene-pass context: each lit fragment reads the AO at its screen
 *             position and keeps it only if the prepass saw the same surface
 *             (view depth within a few per cent); otherwise 1 (disocclusion,
 *             far geometry, sky, terrain beyond `far`)
 *
 * The two passes run in a tiny RenderPipeline of their own (its output is a
 * 1x1 target), rendered before the main chain each frame, so nothing in the
 * main scene pass schedules a nested render: the scene materials sample the
 * results as plain textures.
 */
export class NearFieldAO {
  /**
   * @param {object} o
   * @param {THREE.WebGPURenderer} o.renderer
   * @param {THREE.Scene} o.scene
   * @param {THREE.PerspectiveCamera} o.camera  main camera (mirrored every frame)
   * @param {{far:number, samples:number, scale:number, terrain:boolean}} o.cfg
   */
  constructor({ renderer, scene, camera, cfg }) {
    this.renderer = renderer;
    this.camera = camera;
    this.cfg = cfg;
    this.u = {
      /** 0 = off .. 1 = full GTAO on indirect light. */
      intensity: uniform(cfg.intensity ?? 1),
      /** Radius (m) at the camera; grows by `radiusSlope` per metre of distance. */
      radius: uniform(cfg.radius ?? 0.45),
      radiusSlope: uniform(cfg.radiusSlope ?? 0.018),
      radiusMax: uniform(cfg.radiusMax ?? 8),
    };

    const cam = this.aoCamera = new THREE.PerspectiveCamera();
    this._sync();

    const pre = this.prepass = pass(scene, cam);
    pre.name = 'AO.prepass';
    pre.transparent = false; // particles, glass, light sprites never occlude
    pre.setResolutionScale(cfg.scale ?? 0.5);
    const depthOnly = new THREE.MeshBasicNodeMaterial();
    depthOnly.name = 'AO.depth';
    depthOnly.colorNode = vec4(0, 0, 0, 1);
    depthOnly.fog = false;
    pre.overrideMaterial = depthOnly;
    this._override = depthOnly;

    const depth = pre.getTextureNode('depth');
    const near = reference('near', 'float', cam);
    const far = reference('far', 'float', cam);
    // distance-scaled radius: read at the GTAO quad's own uv
    const dist = perspectiveDepthToViewZ(depth.sample(uv()).r, near, far).negate();
    const radius = clamp(this.u.radius.add(dist.mul(this.u.radiusSlope)), this.u.radius, this.u.radiusMax);

    const g = this.gtao = new PackedGTAONode(depth, cam, dist);
    g.resolutionScale = cfg.scale ?? 0.5;
    g.samples.value = cfg.samples ?? 12;
    g.radius = radius;
    // thin surfaces (a wing seen edge-on, a pylon) must not shadow what is far behind them
    g.thickness = radius.mul(1.5);
    g.useTemporalFiltering = true;

    // Own pipeline: prepass -> GTAO, output into a 1x1 dummy target.
    this.pipeline = new THREE.RenderPipeline(renderer);
    this.pipeline.outputColorTransform = false;
    this.pipeline.outputNode = vec4(g.getTextureNode().sample(uv()).r.mul(0), 0, 0, 1);
    this._sink = new THREE.RenderTarget(1, 1, { depthBuffer: false });
    this._sink.texture.name = 'AO.sink';

    // Plain texture nodes of the results (no pass linkage: sampling them in
    // the scene materials must not schedule the prepass from inside the scene pass).
    const aoTex = texture(g._aoRenderTarget.texture);
    const u = this.u;
    const aoNode = (() => {
      const s = aoTex.sample(screenUV);
      const seen = s.g.negate(); // background: the clear value (+1) never matches
      const z = positionView.z.negate();
      const same = abs(seen.sub(z)).lessThan(max(z.mul(0.04), 0.2));
      return select(same, mix(float(1), s.r, u.intensity), float(1));
    })();
    /**
     * Scene-pass lighting context: AO on indirect light of opaque lit
     * materials. Skipped: transparent ones, the terrain (its fragment stage
     * is at the 16-texture limit; it still occludes in the prepass) and any
     * material with `userData.noAO`.
     */
    this.context = (node = null) => context(node, {
      getAO: (inputNode, { material }) => {
        if (material.transparent === true || material.terrainLit || material.userData?.noAO) return inputNode;
        return inputNode !== null ? inputNode.mul(aoNode) : aoNode;
      },
    });
    this.enabled = true;
  }

  _sync() {
    const c = this.camera;
    const a = this.aoCamera;
    a.fov = c.fov;
    a.aspect = c.aspect;
    a.near = c.near;
    a.far = Math.min(c.far, this.cfg.far ?? 400);
    a.zoom = c.zoom;
    a.filmGauge = c.filmGauge;
    a.filmOffset = c.filmOffset;
    a.view = null;
    a.updateProjectionMatrix();
    a.position.copy(c.position);
    a.quaternion.copy(c.quaternion);
    a.scale.copy(c.scale);
    a.matrixWorld.copy(c.matrixWorld);
    a.matrixWorldInverse.copy(c.matrixWorldInverse);
    a.matrixAutoUpdate = false;
    a.matrix.copy(c.matrixWorld);
    // the main camera's layers: 0 (objects) + the terrain's view layer; the
    // terrain only reaches the prepass within `far`, and only on tiers that ask
    a.layers.mask = this.cfg.terrain ? c.layers.mask : 1;
  }

  /** Render prepass + GTAO for this frame. Call before the main pipeline. */
  render() {
    if (!this.enabled || this.u.intensity.value <= 0) return;
    const r = this.renderer;
    this._sync();
    const prev = r.getRenderTarget();
    r.setRenderTarget(this._sink);
    this.pipeline.render();
    r.setRenderTarget(prev);
  }

  dispose() {
    this.pipeline.dispose();
    this.prepass.dispose();
    this.gtao.dispose();
    this._override.dispose();
    this._sink.dispose();
  }
}
