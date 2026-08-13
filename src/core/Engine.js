import * as THREE from 'three';
import {
  EffectComposer,
  EffectPass,
  RenderPass,
  BloomEffect,
  ToneMappingEffect,
  ToneMappingMode,
  VignetteEffect,
  SMAAEffect,
  SMAAPreset,
  BlendFunction,
} from 'postprocessing';

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
      luminanceThreshold: 0.88,
      luminanceSmoothing: 0.24,
      mipmapBlur: true,
      intensity: 0.72,
      radius: 0.62,
    });

    this.toneMapping = new ToneMappingEffect({
      mode: ToneMappingMode.AGX,
      resolution: 256,
      whitePoint: 8.0,
      middleGrey: 0.45,
    });

    this.vignette = new VignetteEffect({ offset: 0.32, darkness: 0.44 });

    this.smaa = new SMAAEffect({ preset: SMAAPreset.MEDIUM });

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
    this._scaleCooldown = 0;
    this.fps = 60;
    this.adaptEnabled = true;

    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);
    this.resize();
  }

  _buildEffectPass() {
    if (this.effectPass) {
      this.composer.removePass(this.effectPass);
      this.effectPass.dispose();
    }
    const tier = this.settings.tier;
    const effects = [];
    if (tier.bloom) effects.push(this.bloom);
    effects.push(this.toneMapping, this.vignette);
    if (tier.smaa) effects.push(this.smaa);
    this.effectPass = new EffectPass(this.camera, ...effects);
    this.composer.addPass(this.effectPass);
  }

  applySettings() {
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
    this.composer.render(dt);
  }

  dispose() {
    window.removeEventListener('resize', this._onResize);
    this.composer.dispose();
    this.renderer.dispose();
  }
}
