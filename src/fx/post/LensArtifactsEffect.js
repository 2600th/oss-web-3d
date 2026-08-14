import { Uniform, Vector2 } from 'three';
import { Effect } from 'postprocessing';

const fragment = /* glsl */ `
  uniform vec2 uSun;
  uniform float uVisibility;
  uniform float uFlare;
  uniform float uDirt;

  float hash(vec2 p) {
    return fract(sin(dot(floor(p), vec2(127.1, 311.7))) * 43758.5453);
  }

  void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
    vec2 axis = vec2(0.5) - uSun;
    float halo = exp(-distance(uv, uSun) * 18.0);
    float ghostA = exp(-distance(uv, vec2(0.5) + axis * 0.58) * 32.0);
    float ghostB = exp(-distance(uv, vec2(0.5) + axis * 1.12) * 48.0);
    float dirt = mix(1.0, 0.55 + hash(uv * 31.0) * 0.45, uDirt);
    vec3 flare = vec3(1.0, 0.72, 0.42) * halo + vec3(0.25, 0.48, 1.0) * ghostA + vec3(1.0, 0.32, 0.12) * ghostB;
    float onScreen = step(0.0, uSun.x) * step(uSun.x, 1.0) * step(0.0, uSun.y) * step(uSun.y, 1.0);
    outputColor = vec4(inputColor.rgb + flare * dirt * uFlare * uVisibility * onScreen, inputColor.a);
  }
`;

export class LensArtifactsEffect extends Effect {
  constructor() {
    const sun = new Vector2(0.5, 0.5);
    super('LensArtifactsEffect', fragment, {
      uniforms: new Map([
        ['uSun', new Uniform(sun)],
        ['uVisibility', new Uniform(0)],
        ['uFlare', new Uniform(0.1)],
        ['uDirt', new Uniform(0.12)],
      ]),
    });
    this.sunPosition = sun;
  }

  setSunPosition(x, y, visibility = 1) {
    this.sunPosition.set(x, y);
    this.visibility = visibility;
  }

  set visibility(value) {
    this.uniforms.get('uVisibility').value = Math.max(0, Math.min(1, value));
  }

  get visibility() {
    return this.uniforms.get('uVisibility').value;
  }

  set flare(value) {
    this.uniforms.get('uFlare').value = Math.max(0, Math.min(0.35, value));
  }

  get flare() {
    return this.uniforms.get('uFlare').value;
  }

  set dirt(value) {
    this.uniforms.get('uDirt').value = Math.max(0, Math.min(1, value));
  }

  get dirt() {
    return this.uniforms.get('uDirt').value;
  }
}
