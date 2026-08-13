import * as THREE from 'three';
import { ATMOSPHERE_GLSL, ATMOSPHERE_UNIFORMS_GLSL } from './atmosphere.glsl.js';

/**
 * Full-screen sky. Drawn first with depth test off, so it costs one untextured
 * pass and never needs a dome mesh or a cubemap.
 *
 * The view ray is reconstructed from the inverse projection/view matrices,
 * which keeps it exact at any FOV — important because the FOV moves with
 * airspeed and a dome-mesh sky would visibly swim.
 */
export class Sky {
  constructor(environment) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3),
    );

    this.material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        ...environment.uniforms,
        uInvProjection: { value: new THREE.Matrix4() },
        uInvView: { value: new THREE.Matrix4() },
      },
      vertexShader: /* glsl */ `
        out vec2 vNdc;
        void main() {
          vNdc = position.xy;
          gl_Position = vec4(position.xy, 1.0, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        in vec2 vNdc;
        out vec4 fragColor;

        uniform mat4 uInvProjection;
        uniform mat4 uInvView;
        ${ATMOSPHERE_UNIFORMS_GLSL}
        uniform float uTime;
        uniform vec2 uWind;
        ${ATMOSPHERE_GLSL}

        float hash21(vec2 p) {
          p = 50.0 * fract(p * 0.3183099 + vec2(0.71, 0.113));
          return fract(p.x * p.y * (p.x + p.y));
        }

        float vnoise(vec2 x) {
          vec2 p = floor(x), f = fract(x);
          f = f * f * (3.0 - 2.0 * f);
          return mix(mix(hash21(p), hash21(p + vec2(1, 0)), f.x),
                     mix(hash21(p + vec2(0, 1)), hash21(p + vec2(1, 1)), f.x), f.y);
        }

        float cirrus(vec2 p) {
          float v = 0.0, a = 0.5;
          for (int i = 0; i < 5; i++) {
            v += a * vnoise(p);
            p = mat2(1.7, 1.2, -1.2, 1.7) * p;
            a *= 0.5;
          }
          return v;
        }

        void main() {
          vec4 clip = vec4(vNdc, 1.0, 1.0);
          vec4 viewPos = uInvProjection * clip;
          viewPos /= viewPos.w;
          vec3 dir = normalize((uInvView * vec4(viewPos.xyz, 0.0)).xyz);

          vec3 col = atm_skyColor(dir);

          // High cirrus, stretched along the wind and only visible above the
          // horizon. Cheap, but it stops the upper sky being a flat gradient.
          if (dir.y > 0.005) {
            vec2 cp = dir.xz / dir.y;
            cp = cp * 0.9 + uWind * uTime * 0.00035;
            float c = cirrus(vec2(cp.x * 0.55, cp.y * 1.9));
            c = smoothstep(0.52, 0.92, c);
            float fade = smoothstep(0.02, 0.30, dir.y) * (1.0 - smoothstep(0.55, 1.0, dir.y) * 0.55);
            vec3 cirrusCol = mix(vec3(0.92, 0.95, 1.0), uSunColor, 0.35) * (0.85 + 0.4 * pow(max(dot(dir, uSunDir), 0.0), 4.0));
            col = mix(col, cirrusCol, c * fade * 0.55);
          }

          // Sun disc, softened at the edge so bloom has something to grip.
          float mu = clamp(dot(dir, uSunDir), -1.0, 1.0);
          float ang = acos(mu);
          float disc = 1.0 - smoothstep(0.0046, 0.0092, ang);
          col += uSunColor * disc * uSunIntensity * 14.0;

          fragColor = vec4(col, 1.0);
        }
      `,
    });

    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1000;
  }

  update(camera) {
    this.material.uniforms.uInvProjection.value.copy(camera.projectionMatrixInverse);
    this.material.uniforms.uInvView.value.copy(camera.matrixWorld);
  }

  /**
   * Bake the sky into a prefiltered environment map.
   *
   * The aircraft's converted metal/rough materials are largely bare metal, and
   * bare metal with no environment renders black. One PMREM pass at load gives
   * the airframe a sky to reflect and costs nothing per frame.
   *
   * Rendered from a cube-facing box rather than the full-screen pass, because
   * CubeCamera drives all six faces itself and never gives us a hook to update
   * the inverse-view uniform the screen-space version depends on.
   */
  bakeEnvironment(renderer, environment) {
    const box = new THREE.BoxGeometry(2, 2, 2);
    const material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: { ...environment.uniforms },
      vertexShader: /* glsl */ `
        out vec3 vDir;
        void main() {
          vDir = position;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        in vec3 vDir;
        out vec4 fragColor;
        ${ATMOSPHERE_UNIFORMS_GLSL}
        ${ATMOSPHERE_GLSL}
        void main() {
          vec3 dir = normalize(vDir);
          vec3 col = atm_skyColor(dir);
          float mu = clamp(dot(dir, uSunDir), -1.0, 1.0);
          col += uSunColor * (1.0 - smoothstep(0.006, 0.02, acos(mu))) * uSunIntensity * 6.0;
          // Ground half: snow and rock throw a lot of light back up here.
          col = mix(col, vec3(0.30, 0.31, 0.33), smoothstep(-0.02, -0.45, dir.y));
          fragColor = vec4(col, 1.0);
        }
      `,
    });

    const scene = new THREE.Scene();
    scene.add(new THREE.Mesh(box, material));

    const pmrem = new THREE.PMREMGenerator(renderer);
    pmrem.compileEquirectangularShader();
    const target = pmrem.fromScene(scene, 0, 0.1, 10);

    box.dispose();
    material.dispose();
    pmrem.dispose();
    return target.texture;
  }
}
