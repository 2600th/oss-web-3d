import { BlendFunction, Effect } from 'postprocessing';
import { Uniform } from 'three';

export const CLOUD_BUFFER_DEBUG_VIEWS = Object.freeze([
  'cloud-alpha',
  'cloud-color',
]);

const VIEW_MODES = Object.freeze({
  'cloud-alpha': 0,
  'cloud-color': 1,
});

const fragment = /* glsl */ `
  uniform sampler2D uCloudBuffer;
  uniform float uCloudMode;

  void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
    vec4 cloud = texture2D(uCloudBuffer, uv);
    if (uCloudMode < 0.5) {
      outputColor = vec4(vec3(cloud.a), 1.0);
    } else {
      outputColor = vec4(cloud.rgb, 1.0);
    }
  }
`;

/**
 * Comparison-only view of the resolved upstream CloudsEffect buffer. It keeps
 * the cloud effect off the final composite path while still driving its
 * offscreen render targets every frame.
 */
export class CloudBufferDebugEffect extends Effect {
  constructor(clouds, view = 'cloud-alpha') {
    if (clouds?.cloudsPass == null || typeof clouds.update !== 'function') {
      throw new TypeError('Cloud buffer debug requires a CloudsEffect with an output buffer');
    }
    super('CloudBufferDebugEffect', fragment, {
      blendFunction: BlendFunction.REPLACE,
      uniforms: new Map([
        ['uCloudBuffer', new Uniform(null)],
        ['uCloudMode', new Uniform(0)],
      ]),
    });
    this.clouds = clouds;
    this.authoredHaze = clouds.haze;
    this.authoredSkipRendering = clouds.skipRendering;
    this.view = 'composite';
    this.setView(view);
  }

  setView(view) {
    if (view === 'composite') {
      this.view = view;
      this.enabled = false;
      this.clouds.haze = this.authoredHaze;
      return;
    }
    if (!CLOUD_BUFFER_DEBUG_VIEWS.includes(view)) {
      throw new RangeError(`Unknown cloud buffer debug view: ${String(view)}`);
    }
    this.view = view;
    this.enabled = true;
    this.clouds.haze = false;
    this.clouds.skipRendering = true;
    this.uniforms.get('uCloudMode').value = VIEW_MODES[view];
  }

  update(renderer, inputBuffer, deltaTime = 0) {
    if (!this.enabled) return;
    this.clouds.haze = false;
    this.clouds.skipRendering = true;
    this.clouds.update(renderer, inputBuffer, deltaTime);
    // CloudsPass swaps resolve/history targets on every update. Bind the
    // accessor result, not a cached target, so this always samples the latest
    // resolved cloud buffer by identity.
    this.uniforms.get('uCloudBuffer').value = this.clouds.cloudsPass.outputBuffer;
  }

  debugPixel(rgba, pixelIndex) {
    const offset = pixelIndex * 4;
    if (offset < 0 || offset + 3 >= rgba.length) {
      throw new RangeError(`Cloud buffer pixel index is outside the supplied RGBA data: ${pixelIndex}`);
    }
    if (this.view === 'cloud-alpha') {
      const alpha = rgba[offset + 3];
      return [alpha, alpha, alpha, 1];
    }
    return [rgba[offset], rgba[offset + 1], rgba[offset + 2], 1];
  }

  dispose() {
    this.clouds.haze = this.authoredHaze;
    this.clouds.skipRendering = this.authoredSkipRendering;
    super.dispose();
  }
}
