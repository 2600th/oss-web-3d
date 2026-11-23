import * as THREE from 'three/webgpu';
import { pass, mrt, output, velocity, renderOutput, uniform } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { fxaa } from 'three/addons/tsl/display/FXAANode.js';

/**
 * Post-processing chain (TSL RenderPipeline).
 *
 * Foundation version: HDR scene pass with velocity MRT -> bloom -> tone map
 * (AgX) -> FXAA. The post-FX owner extends this (TRAA, motion blur, lens
 * flare, heat haze, grade/LUT, film grain, vignette, chromatic aberration).
 * Keep the public surface: `render()`, `setSize()`, `uniforms`, `scenePass`.
 */
export class PostFX {
  constructor(r) {
    this.r = r;
    const renderer = r.renderer;
    renderer.toneMapping = THREE.AgXToneMapping;
    renderer.toneMappingExposure = 1.0;

    this.uniforms = {
      exposure: uniform(0.6),
      bloomStrength: uniform(0.08),
    };

    const scenePass = pass(r.scene, r.camera);
    scenePass.setMRT(mrt({ output, velocity }));
    this.scenePass = scenePass;
    const color = scenePass.getTextureNode('output');

    const bloomPass = bloom(color, 0.35, 0.4, 0.9);
    bloomPass.strength = this.uniforms.bloomStrength;
    const hdr = color.mul(this.uniforms.exposure).add(bloomPass);

    this.pipeline = new THREE.RenderPipeline(renderer);
    this.pipeline.outputColorTransform = false;
    this.pipeline.outputNode = fxaa(renderOutput(hdr));
  }

  render() {
    this.pipeline.render();
  }

  dispose() {
    this.pipeline.dispose();
  }
}
