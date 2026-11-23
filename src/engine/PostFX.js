import * as THREE from 'three/webgpu';
import { pass, mrt, output, velocity, renderOutput, uniform } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { fxaa } from 'three/addons/tsl/display/FXAANode.js';

/**
 * Post-processing chain (TSL RenderPipeline).
 *
 * Foundation version: HDR scene pass with velocity MRT -> [scene stages] ->
 * bloom -> tone map (AgX) -> FXAA. The post-FX owner extends this (TRAA,
 * motion blur, lens flare, heat haze, grade/LUT, film grain, vignette,
 * chromatic aberration). Keep the public surface:
 *   render(), dispose(), uniforms, scenePass,
 *   addSceneStage(fn, order)  — HDR compositing hook (see below).
 *
 * Scene stages run in linear HDR before bloom and tone mapping, in ascending
 * `order`. Each is `fn(colorNode, ctx) => colorNode` with
 *   ctx = { scenePass, depth (texture node, reversed-Z), velocity, camera, renderer }.
 * Atmosphere/clouds use it to composite volumetrics against scene depth.
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
    this.stages = [];

    const scenePass = pass(r.scene, r.camera);
    scenePass.setMRT(mrt({ output, velocity }));
    this.scenePass = scenePass;

    this.pipeline = new THREE.RenderPipeline(renderer);
    this.pipeline.outputColorTransform = false;
    this._build();
  }

  addSceneStage(fn, order = 50) {
    this.stages.push({ fn, order });
    this.stages.sort((a, b) => a.order - b.order);
    this._build();
  }

  _build() {
    const sp = this.scenePass;
    const ctx = {
      scenePass: sp,
      depth: sp.getTextureNode('depth'),
      velocity: sp.getTextureNode('velocity'),
      camera: this.r.camera,
      renderer: this.r.renderer,
    };
    let color = sp.getTextureNode('output');
    for (const s of this.stages) color = s.fn(color, ctx);

    const bloomPass = bloom(color, 0.35, 0.4, 0.9);
    bloomPass.strength = this.uniforms.bloomStrength;
    const hdr = color.mul(this.uniforms.exposure).add(bloomPass);
    this.pipeline.outputNode = fxaa(renderOutput(hdr));
    this.pipeline.needsUpdate = true;
  }

  render() {
    this.pipeline.render();
  }

  dispose() {
    this.pipeline.dispose();
  }
}
