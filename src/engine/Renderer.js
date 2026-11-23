import * as THREE from 'three/webgpu';
import { QUALITY, pickTier } from './Quality.js';

/**
 * Owns the WebGPURenderer, the main camera and the canvas size.
 *
 * WebGPU is the primary backend. three's WebGPURenderer falls back to its own
 * WebGL2 backend automatically when `navigator.gpu` is missing, so all shading
 * in this project is TSL (node materials) — never GLSL ShaderMaterial, which
 * the WebGPU renderer cannot run on either backend.
 */
export class Renderer {
  constructor(canvas, { forceWebGL = false } = {}) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGPURenderer({
      canvas,
      antialias: false, // AA is done in post (TRAA / SMAA)
      powerPreference: 'high-performance',
      forceWebGL,
      logarithmicDepthBuffer: false,
      reversedDepthBuffer: true, // float depth precision for 0.5 m .. 300 km
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
    this._onResize = () => this.resize();
  }

  async init() {
    await this.renderer.init();
    this.backend = this.renderer.backend.isWebGPUBackend ? 'webgpu' : 'webgl2';
    this.tier = QUALITY[pickTier(this.backend)];
    window.addEventListener('resize', this._onResize);
    this.resize();
    return this;
  }

  setTier(name) {
    this.tier = QUALITY[name] ?? this.tier;
    this.resize();
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.pixelRatio = Math.min(window.devicePixelRatio || 1, this.tier.maxPixelRatio) * this.renderScale;
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.width = w;
    this.height = h;
  }

  dispose() {
    window.removeEventListener('resize', this._onResize);
    this.renderer.dispose();
  }
}
