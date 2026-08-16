import * as THREE from 'three';
import {
  EffectComposer,
  EffectPass,
  RenderPass,
  BloomEffect,
  SMAAEffect,
  SMAAPreset,
  BlendFunction,
} from 'postprocessing';
import { DitherEffect } from './DitherEffect.js';
import { CinematicGradeEffect } from '../fx/post/CinematicGradeEffect.js';
import { LensEdgeEffect } from '../fx/post/LensEdgeEffect.js';
import { AdaptiveExposureEffect, createFilmicToneMapping } from '../fx/post/AutoExposure.js';
import {
  configureFinalOutput,
  normalizeRenderOptions,
  setPassEnabled,
} from '../fx/post/PostPipeline.js';
import { OutputEffectPass } from '../fx/post/OutputEffectPass.js';
import { SunShaftEffect } from '../fx/post/SunShaftEffect.js';
import { MotionBlurEffect } from '../fx/post/MotionBlurEffect.js';
import { HeatDistortionEffect } from '../fx/post/HeatDistortionEffect.js';
import { LensArtifactsEffect } from '../fx/post/LensArtifactsEffect.js';

/**
 * Renderer, camera, post chain and the frame loop.
 *
 * Depth: the near/far pair is extreme (4 m .. 750 km) but a plain depth buffer
 * is still the right call. Terrain is a heightfield, so it can never self-
 * intersect, and the only places precision gets thin are ridges 80 km+ out
 * which are already 90% dissolved into haze. A logarithmic buffer would force
 * gl_FragDepth writes in the terrain shader and cost more than it returns.
 *
 * Resolution scaling is adaptive: frame time is smoothed and render scale
 * nudged, because a stable 60 with a slightly soft image is a far better
 * flight experience than a crisp 45.
 */
export class Engine {
  constructor(canvas, settings) {
    this.settings = settings;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      powerPreference: 'high-performance',
      stencil: false,
      depth: true,
      alpha: false,
    });
    this.renderer.autoClear = true;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.setClearColor(0x000000, 1);

    this.scene = new THREE.Scene();

    this.camera = new THREE.PerspectiveCamera(58, 1, 4, 750000);
    this.camera.rotation.order = 'YXZ';

    this.composer = new EffectComposer(this.renderer, {
      frameBufferType: THREE.HalfFloatType,
      multisampling: 0,
    });
    this.renderPass = new RenderPass(this.scene, this.camera);
    this.composer.addPass(this.renderPass);

    this.bloom = new BloomEffect({
      blendFunction: BlendFunction.ADD,
      // Restrained on purpose: only the sun disc, afterburner and hard snow
      // glints should ever bloom.
      luminanceThreshold: 1.08,
      luminanceSmoothing: 0.18,
      mipmapBlur: true,
      intensity: 0.34,
      radius: 0.58,
      levels: 6,
    });

    this.exposure = new AdaptiveExposureEffect();
    this.toneMapping = createFilmicToneMapping();
    this.autoExposure = this.exposure;
    this.grade = new CinematicGradeEffect();
    this.lensEdge = new LensEdgeEffect();
    this.sunShafts = new SunShaftEffect();
    this.motionEffect = new MotionBlurEffect();
    this.heatDistortion = new HeatDistortionEffect();
    this.lensArtifacts = new LensArtifactsEffect();
    this.smaa = new SMAAEffect({ preset: SMAAPreset.MEDIUM });

    // Slightly above one 8-bit step. The sky is a near-flat gradient across
    // most of the frame and bands hard without this.
    this.dither = new DitherEffect(1.4 / 255);

    // Every convolution stage owns a buffer boundary. Besides preventing
    // convolution-effect merge conflicts, this makes bloom read the cloud,
    // shaft and lens radiance produced by preceding passes.
    this.radiancePass = new EffectPass(this.camera, this.lensArtifacts);
    this.motionPass = new EffectPass(this.camera, this.motionEffect);
    this.heatPass = new EffectPass(this.camera, this.heatDistortion);
    this.shaftPass = new EffectPass(this.camera, this.sunShafts);
    this.bloomPass = new EffectPass(this.camera, this.bloom);
    this.tonePass = new EffectPass(this.camera, this.exposure, this.toneMapping);
    this.lensPass = new EffectPass(this.camera, this.lensEdge);
    this.finishPass = new OutputEffectPass(this.camera, this.grade, this.smaa, this.dither);
    this.composer.addPass(this.radiancePass);
    this.composer.addPass(this.motionPass);
    this.composer.addPass(this.heatPass);
    this.composer.addPass(this.shaftPass);
    this.composer.addPass(this.bloomPass);
    this.composer.addPass(this.tonePass);
    this.composer.addPass(this.lensPass);
    this.composer.addPass(this.finishPass);
    this.composer.autoRenderToScreen = false;
    this._postPasses = [
      this.radiancePass,
      this.motionPass,
      this.heatPass,
      this.shaftPass,
      this.bloomPass,
      this.tonePass,
      this.lensPass,
      this.finishPass,
    ];
    this._ownedEffects = new Set([
      this.bloom,
      this.exposure,
      this.toneMapping,
      this.lensEdge,
      this.grade,
      this.smaa,
      this.dither,
      this.sunShafts,
      this.motionEffect,
      this.heatDistortion,
      this.lensArtifacts,
    ]);
    this._initializedPostEffects = new WeakSet(this._ownedEffects);
    // Kept as a compatibility alias for diagnostics that inspect the original
    // single-pass engine. Rendering should always go through composer.
    this.effectPass = this.finishPass;
    this._buildEffectPass();

    // THREE.Clock is deprecated in r185 and warns on construction. Timer is the
    // replacement; it has no delta clamp of its own, so the caller still has to
    // bound the step after a tab switch.
    this.timer = new THREE.Timer();
    this._frameTimes = new Float32Array(30);
    this._sorted = new Float32Array(30);
    this._frameIndex = 0;
    this._frameCount = 0;
    this.renderScale = 1;
    // Set by the Game once it knows the tier; see setSceneDepthRequired.
    this._sceneWantsDepth = false;
    this._scaleCooldown = 0;
    this.fps = 60;
    this.adaptEnabled = true;

    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);
    this.resize();
  }

  _buildEffectPass() {
    const tier = this.settings.tier;
    const radiance = this.clouds
      ? [this.clouds, this.lensArtifacts]
      : [this.lensArtifacts];

    const lensEnabled = tier.name === 'medium' || tier.name === 'high';
    this.grade.setQuality(tier);
    this.lensEdge.amount = this.grade.chromaticAberration;
    this.bloom.intensity = tier.name === 'high' ? 0.34 : 0.26;
    this.radiancePass.setEffects(radiance);
    this.motionPass.setEffects([this.motionEffect]);
    this.heatPass.setEffects([this.heatDistortion]);
    this.shaftPass.setEffects([this.sunShafts]);
    this.bloomPass.setEffects([this.bloom]);
    this.tonePass.setEffects([this.exposure, this.toneMapping]);
    this.lensPass.setEffects([this.lensEdge]);
    this.finishPass.setEffects(tier.smaa
      ? [this.grade, this.smaa, this.dither]
      : [this.grade, this.dither]);

    // Settings can change after initialization. Recompiling updates effect
    // listeners and shader composition without disposing reusable effects.
    for (const pass of this._postPasses) {
      if (pass.renderer) pass.recompile();
    }

    this.radiancePass.enabled = Boolean(this.clouds) || this.lensArtifacts.visibility > 0;
    this.motionPass.enabled = lensEnabled && (this.motionEffect.amount ?? 1) > 0;
    this.heatPass.enabled = lensEnabled && (this.heatDistortion.amount ?? 1) > 0;
    this.shaftPass.enabled = lensEnabled && (this.sunShafts.visibility ?? 1) > 0;
    this.bloomPass.enabled = Boolean(tier.bloom);
    this.tonePass.enabled = true;
    this.lensPass.enabled = lensEnabled;
    this.finishPass.enabled = true;
    configureFinalOutput(this.composer.passes, this.finishPass, null);

    // A depth-reading effect can be attached after the pass was added. The
    // composer normally allocates its stable depth texture only in addPass(),
    // so dynamic hooks must promote it here as well.
    //
    // The test is "does *any* pass need depth", not "does the radiance pass
    // need it". It used to name the radiance pass because the clouds lived
    // there; when they moved out, the output pass still needed depth and no
    // longer got it, so the stable depth texture stayed null and everything
    // reading it — soft particles, water refraction — silently lost its input.
    this.syncDepthTexture();
  }

  /**
   * Give the composer a stable depth texture exactly when some pass wants one.
   *
   * Called from _buildEffectPass and again every frame, because a pass only
   * recomputes needsDepthTexture once it has a renderer — at boot it does not,
   * so the flag read here is still false and a one-shot check misses it
   * permanently. The scan is nine booleans and it only acts on a transition.
   */
  /**
   * Declare that something in the *scene* reads the composer depth texture.
   *
   * The cloud billboards and every GPU FX material sample it for their soft
   * edge, but they are scene objects, not passes, so `pass.needsDepthTexture`
   * cannot see them. They used to ride on whatever the post chain happened to
   * want, and on medium, low and phone it wants nothing — so soft particles
   * were dead on three of four tiers, including the one the reference GPU
   * selects. Cloud billboards cut a hard straight line into the mountains there.
   */
  setSceneDepthRequired(required) {
    const next = Boolean(required);
    if (this._sceneWantsDepth === next) return false;
    this._sceneWantsDepth = next;
    return this.syncDepthTexture();
  }

  syncDepthTexture() {
    const wantsDepth = this._sceneWantsDepth
      || this.composer.passes.some((pass) => pass.needsDepthTexture);
    const has = this.composer.stableDepthTexture !== null;
    if (wantsDepth && !has) {
      this.composer.createDepthTexture();
      for (const pass of this.composer.passes) {
        pass.setDepthTexture(this.composer.stableDepthTexture);
      }
      return true;
    }
    if (!wantsDepth && has) {
      this.composer.deleteDepthTexture();
      return true;
    }
    return false;
  }

  _initializePostEffect(effect) {
    if (!effect || this._initializedPostEffects.has(effect)) return;
    const gl = this.renderer.getContext();
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    effect.initialize(this.renderer, gl.getContextAttributes().alpha, this.composer.inputBuffer.texture.type);
    effect.setSize(size.width, size.height);
    this._initializedPostEffects.add(effect);
  }

  _releaseEffect(effect) {
    if (!effect || !this._ownedEffects.has(effect)) return;
    const stillUsed = [
      this.clouds,
      this.sunShafts,
      this.motionEffect,
      this.heatDistortion,
      this.lensArtifacts,
    ].includes(effect);
    if (stillUsed) return;
    this._ownedEffects.delete(effect);
    effect.dispose();
  }

  _replaceEffect(property, effect, factory, takeOwnership = true) {
    const previous = this[property];
    const next = effect ?? factory();
    if (previous === next) return previous;
    this[property] = next;
    this._initializePostEffect(next);
    if (takeOwnership || effect == null) this._ownedEffects.add(next);
    this._buildEffectPass();
    this._releaseEffect(previous);
    return next;
  }

  /**
   * Attach the volumetric clouds.
   *
   * They need the environment and camera, which the Game owns, so they are
   * installed after construction rather than built here. Rebuilding the effect
   * pass is what actually inserts them into the chain.
   */
  setClouds(clouds, { takeOwnership = true } = {}) {
    const previous = this.clouds;
    if (previous === clouds) return;
    this.clouds = clouds ?? null;
    this._initializePostEffect(this.clouds);
    if (takeOwnership && this.clouds) this._ownedEffects.add(this.clouds);
    if (this.clouds) this.clouds.setQuality(this.settings.tier);
    this._buildEffectPass();
    this._releaseEffect(previous);
  }

  /**
   * Install optional post effects supplied by the atmosphere/flight streams.
   * Any omitted key keeps its current value; pass `null` to restore the owned
   * built-in component. Ownership transfers by default and can be declined.
   * Effects are ordered as HDR scene radiance before bloom and tone mapping.
   */
  setPostEffectHooks(hooks = {}, { takeOwnership = true } = {}) {
    if ('sunShafts' in hooks) {
      this._replaceEffect('sunShafts', hooks.sunShafts, () => new SunShaftEffect(), takeOwnership);
    }
    if ('motion' in hooks) {
      this._replaceEffect('motionEffect', hooks.motion, () => new MotionBlurEffect(), takeOwnership);
    }
    if ('heatDistortion' in hooks) {
      this._replaceEffect(
        'heatDistortion',
        hooks.heatDistortion,
        () => new HeatDistortionEffect(),
        takeOwnership,
      );
    }
  }

  setSunShafts(effect) {
    this.setPostEffectHooks({ sunShafts: effect });
  }

  setSunScreenPosition(x, y, visibility = 1) {
    this.sunShafts.setSunPosition?.(x, y, visibility);
    this.lensArtifacts.setSunPosition(x, y, visibility);
    const desktop = this.settings.tier.name === 'medium' || this.settings.tier.name === 'high';
    setPassEnabled(this.shaftPass, desktop && (this.sunShafts.visibility ?? visibility) > 0);
    setPassEnabled(this.radiancePass, Boolean(this.clouds) || this.lensArtifacts.visibility > 0);
  }

  setMotionBlur(motion = {}) {
    this.motionEffect.setMotion?.(motion);
    const amount = motion.amount ?? 0;
    if (!this.motionEffect.setMotion && 'amount' in this.motionEffect) this.motionEffect.amount = amount;
    const desktop = this.settings.tier.name === 'medium' || this.settings.tier.name === 'high';
    setPassEnabled(this.motionPass, desktop && (this.motionEffect.amount ?? amount) > 0);
  }

  setHeatDistortion(amount) {
    if ('amount' in this.heatDistortion) this.heatDistortion.amount = amount;
    const desktop = this.settings.tier.name === 'medium' || this.settings.tier.name === 'high';
    setPassEnabled(this.heatPass, desktop && (this.heatDistortion.amount ?? amount) > 0);
  }

  setLensArtifacts(flareOrOptions = this.lensArtifacts.flare, dirt = this.lensArtifacts.dirt) {
    const options = typeof flareOrOptions === 'object' && flareOrOptions !== null
      ? flareOrOptions
      : null;
    const flare = options?.flare ?? flareOrOptions;
    dirt = options?.dirt ?? dirt;
    this.lensArtifacts.flare = flare;
    this.lensArtifacts.dirt = dirt;
    setPassEnabled(this.radiancePass, Boolean(this.clouds) || this.lensArtifacts.visibility > 0);
  }

  /** Smoothly adapt scene exposure to an externally chosen EV target. */
  setExposure(ev, adaptationRate) {
    this.exposure.setBias(ev, adaptationRate);
  }

  get exposureEV() {
    return this.exposure.biasEV;
  }

  get autoExposureSettings() {
    return {
      enabled: true,
      source: 'rendered-luminance',
      minLuminance: this.exposure.minLuminance,
      adaptationRate: this.exposure.adaptationRate,
      minEV: this.exposure.minEV,
      maxEV: this.exposure.maxEV,
      maxGain: 2 ** this.exposure.maxEV,
      compression: 'AGX',
    };
  }

  applySettings() {
    if (this.clouds) this.clouds.setQuality(this.settings.tier);
    this._buildEffectPass();
    this.renderScale = Math.min(1, this.settings.tier.pixelRatio);
    this.resize();
  }

  get maxPixelRatio() {
    return this.settings.tier.maxPixelRatio;
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, this.maxPixelRatio) * this.renderScale;

    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();

    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
  }

  /**
   * Nudge render scale to defend 60 fps, from the *median* frame time.
   *
   * The mean was the obvious choice and it is the wrong one. Chrome throttles
   * requestAnimationFrame to about 1 Hz whenever the tab is occluded or the
   * window changes state, and a single second-long frame drags a 30-frame mean
   * far enough to trip the downscale — so alt-tabbing away and back left the
   * game running at its minimum resolution for no reason. A median ignores
   * those spikes completely while still tracking genuine sustained load.
   */
  _adapt(dt) {
    // Reject implausible samples outright rather than letting them into the
    // window. Nothing this renderer does costs a quarter of a second a frame,
    // so a sample that long is the browser not calling us — Chrome throttles
    // requestAnimationFrame to about 1 Hz for occluded windows, and it does so
    // without ever setting document.hidden. Dropping resolution cannot buy back
    // time we were never spending, and adapting on those samples pinned the
    // game at its minimum scale for as long as the window stayed covered.
    if (dt > 0.25) return;

    this._frameTimes[this._frameIndex] = dt;
    this._frameIndex = (this._frameIndex + 1) % this._frameTimes.length;
    this._frameCount++;

    if (this._frameCount < this._frameTimes.length) return;

    this._sorted.set(this._frameTimes);
    this._sorted.sort();
    const median = this._sorted[this._sorted.length >> 1];
    this.fps = 1 / Math.max(median, 1e-4);

    this._scaleCooldown -= dt;
    if (this._scaleCooldown > 0) return;
    // Never adapt while hidden; those frames say nothing about our cost.
    if (document.hidden) return;
    // Held off during visual testing, where the harness drives the page from a
    // window the compositor treats as occluded: frame times measured then are
    // the browser's, not ours, and letting them move render scale changes what
    // the screenshot shows for reasons that have nothing to do with the scene.
    if (!this.adaptEnabled) return;

    const min = 0.62;
    // The recovery threshold has to sit just above the vsync interval, not
    // below it. It was 1/75 s, which a 60 Hz display can never deliver — frames
    // are quantised to 16.67 ms — so scale could only ever go down. One passing
    // hitch left the rest of the session permanently soft with no way back.
    // 1/57 s leaves about 5% of headroom over 16.67 ms; the asymmetric
    // cooldowns damp the oscillation that costs.
    if (median > 1 / 52 && this.renderScale > min) {
      this.renderScale = Math.max(min, this.renderScale - 0.08);
      this._scaleCooldown = 1.1;
      this.resize();
    } else if (median < 1 / 57 && this.renderScale < 1) {
      this.renderScale = Math.min(1, this.renderScale + 0.05);
      this._scaleCooldown = 2.2;
      this.resize();
    }
  }

  render(dt) {
    this._adapt(dt);
    configureFinalOutput(this.composer.passes, this.finishPass, null);
    // A pass only recomputes needsDepthTexture inside recompile(), and
    // _buildEffectPass skips that at boot because the passes have no renderer
    // yet. So the very first frame is the earliest point the flags can be
    // trusted; rebuild once there, or every depth-reading effect in the chain
    // spends the session reading a texture that was never allocated.
    if (!this._postSettled && this.composer.passes.some((pass) => pass.renderer)) {
      this._postSettled = true;
      this._buildEffectPass();
    }
    this.syncDepthTexture();
    this.composer.render(dt);
  }

  /**
   * Render an un-postprocessed scene colour/depth source for local material
   * refraction. The excluded object is hidden only for this synchronous draw,
   * preventing a water surface from recursively sampling itself.
   */
  renderSceneToTarget(target, scene = this.scene, camera = this.camera, excludedObject = null) {
    if (!target?.isWebGLRenderTarget) {
      throw new TypeError('renderSceneToTarget requires a WebGLRenderTarget');
    }
    const previousTarget = this.renderer.getRenderTarget();
    const previousVisible = excludedObject?.visible;
    try {
      if (excludedObject) excludedObject.visible = false;
      this.renderer.setRenderTarget(target);
      this.renderer.clear();
      this.renderer.render(scene, camera);
      return target;
    } finally {
      if (excludedObject) excludedObject.visible = previousVisible;
      this.renderer.setRenderTarget(previousTarget);
    }
  }

  /**
   * Render the complete cloud/bloom/metering/finish chain into a caller-owned
   * target. This is intentionally synchronous so a reconnaissance capture can
   * read the target immediately after it returns.
   */
  renderToTarget(
    target,
    cameraOrOptions = {},
  ) {
    if (!target?.isWebGLRenderTarget) {
      throw new TypeError('renderToTarget requires a WebGLRenderTarget');
    }

    const { scene, camera, deltaTime } = normalizeRenderOptions(cameraOrOptions, {
      scene: this.scene,
      camera: this.camera,
      deltaTime: 0,
    });
    const previousTarget = this.renderer.getRenderTarget();
    const previousPixelRatio = this.renderer.getPixelRatio();
    const previousCloudCamera = this.clouds?.camera;

    this.composer.setMainScene(scene);
    this.composer.setMainCamera(camera);
    if (this.clouds?.camera) this.clouds.camera = camera;
    this.renderer.setPixelRatio(1);
    this.composer.setSize(target.width, target.height, false);
    configureFinalOutput(this.composer.passes, this.finishPass, target);

    try {
      this.composer.render(deltaTime);
      return target;
    } finally {
      configureFinalOutput(this.composer.passes, this.finishPass, null);
      this.composer.setMainScene(this.scene);
      this.composer.setMainCamera(this.camera);
      if (this.clouds && previousCloudCamera) this.clouds.camera = previousCloudCamera;
      this.renderer.setPixelRatio(previousPixelRatio);
      this.resize();
      this.renderer.setRenderTarget(previousTarget);
    }
  }

  dispose() {
    window.removeEventListener('resize', this._onResize);
    // EffectPass owns every effect it currently references. Detaching first
    // lets Engine dispose only resources whose ownership was explicitly
    // transferred, while caller-owned replacements remain untouched.
    for (const pass of this._postPasses) pass.setEffects([]);
    this.composer.dispose();
    for (const effect of this._ownedEffects) effect.dispose();
    this._ownedEffects.clear();
    this.renderer.dispose();
  }
}
