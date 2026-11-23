import * as THREE from 'three/webgpu';
import { QUALITY, pickTier } from './Quality.js';

/**
 * Owns the WebGPURenderer, the main camera and the canvas size.
 *
 * WebGPU is the primary backend; WebGL2 is the fallback (chosen up front by
 * src/core/BootLifecycle.js when WebGPU is missing or has no adapter, or by
 * `?webgl`). All shading in this project is TSL (node materials) — never GLSL
 * ShaderMaterial, which the WebGPU renderer cannot run on either backend.
 *
 * Perf/robustness (engine pass):
 *  - `renderScale` (adaptive resolution, src/engine/AdaptiveResolution.js)
 *    multiplies the tier's pixel ratio; `setRenderScale(s)`.
 *  - Timestamp queries are on by default on WebGPU (adaptive resolution and
 *    `?perfhud` read them); on WebGL2 only with `?gputime`/`?perfhud` and only
 *    when EXT_disjoint_timer_query exists (otherwise three warns every frame).
 *    `?notimestamps` turns them off everywhere.
 *  - Resizes are coalesced to one per frame (window drags fire dozens of
 *    events, each one re-allocating every render target), and devicePixelRatio
 *    changes (browser zoom, moving to another monitor) re-size too.
 *  - `onLost(info)` is called once when the GPU device / GL context is lost.
 */
export class Renderer {
  constructor(canvas, { forceWebGL = false, timestamps } = {}) {
    this.canvas = canvas;
    const params = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams();
    const wantTimestamps = timestamps ?? (!params.has('notimestamps') && (!forceWebGL || params.has('gputime') || params.has('perfhud')));
    this.renderer = new THREE.WebGPURenderer({
      canvas,
      antialias: false, // AA is done in post (TRAA / SMAA)
      powerPreference: 'high-performance',
      forceWebGL,
      logarithmicDepthBuffer: false,
      reversedDepthBuffer: true, // float depth precision for 0.5 m .. 300 km
      trackTimestamp: wantTimestamps,
    });
    this.renderer.toneMapping = THREE.NoToneMapping; // tone mapping lives in PostFX
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;

    this.camera = new THREE.PerspectiveCamera(62, 1, 0.5, 260000);
    this.scene = new THREE.Scene();
    this.tier = QUALITY.high;
    this.pixelRatio = 1;
    this.renderScale = 1;
    this.lost = false;
    /** Called once with three's device-lost info ({api, message, reason}). */
    this.onLost = null;
    this._params = params;
    this._resizeQueued = false;
    this._onResize = () => {
      if (this._resizeQueued) return;
      this._resizeQueued = true;
      requestAnimationFrame(() => { this._resizeQueued = false; this.resize(); });
    };
    this._dprQuery = null;
    this._onDpr = () => { this._watchDpr(); this._onResize(); };
  }

  async init() {
    await this.renderer.init();
    const backend = this.renderer.backend;
    this.backend = backend.isWebGPUBackend ? 'webgpu' : 'webgl2';
    if (this.backend === 'webgl2' && backend.trackTimestamp) {
      // three's GL query pool warns on every resolve when the timer extension is
      // missing; check it once here, before the pool exists.
      const gl = backend.gl;
      const ext = gl?.getExtension('EXT_disjoint_timer_query_webgl2') || gl?.getExtension('EXT_disjoint_timer_query');
      if (!ext) backend.trackTimestamp = false;
    }
    this.tier = QUALITY[pickTier(this.backend)];
    this.renderer.onDeviceLost = (info) => {
      if (this.lost) return;
      this.lost = true;
      console.warn(`[renderer] ${info?.api ?? ''} device lost: ${info?.message ?? ''}`);
      this.onLost?.(info);
    };
    window.addEventListener('resize', this._onResize);
    this._watchDpr();
    this.resize();
    return this;
  }

  /** Re-arm the devicePixelRatio media query (it matches one exact value). */
  _watchDpr() {
    this._dprQuery?.removeEventListener?.('change', this._onDpr);
    try {
      this._dprQuery = matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
      this._dprQuery.addEventListener('change', this._onDpr, { once: true });
    } catch { this._dprQuery = null; }
  }

  setTier(name) {
    this.tier = QUALITY[name] ?? this.tier;
    this.resize();
  }

  /** Adaptive resolution: fraction of the tier's pixel ratio (0.25..1). */
  setRenderScale(s) {
    const v = Math.min(1, Math.max(0.25, s));
    if (v === this.renderScale) return;
    this.renderScale = v;
    this.resize();
  }

  resize() {
    const w = Math.max(1, window.innerWidth);
    const h = Math.max(1, window.innerHeight);
    const pr = Math.min(window.devicePixelRatio || 1, this.tier.maxPixelRatio) * this.renderScale;
    if (w === this.width && h === this.height && pr === this.pixelRatio) return;
    this.pixelRatio = pr;
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.width = w;
    this.height = h;
  }

  dispose() {
    window.removeEventListener('resize', this._onResize);
    this._dprQuery?.removeEventListener?.('change', this._onDpr);
    this.renderer.dispose();
  }
}
