import * as THREE from 'three';
import { ATMOSPHERE_GLSL, ATMOSPHERE_UNIFORMS_GLSL } from './atmosphere.glsl.js';
import { AtmosphereLut } from './atmosphere/lut.js';

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
    this.lut = new AtmosphereLut(environment);
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
        ${ATMOSPHERE_GLSL}

        void main() {
          vec4 clip = vec4(vNdc, 1.0, 1.0);
          vec4 viewPos = uInvProjection * clip;
          viewPos /= viewPos.w;
          vec3 dir = normalize((uInvView * vec4(viewPos.xyz, 0.0)).xyz);

          vec3 col = atm_skyColor(dir);

          // The photosphere is not a flat white circle. A sqrt limb profile is
          // the compact visible-light approximation, with a sub-pixel feather
          // outside the physical 0.2665 degree angular radius.
          float angle = acos(clamp(dot(dir, uSunDir), -1.0, 1.0));
          float radial = angle / 0.0046542;
          float limb = 0.42 + 0.58 * sqrt(max(1.0 - radial * radial, 0.0));
          float disc = (1.0 - smoothstep(0.98, 1.08, radial)) * limb;
          col += uSunColor * atm_sunTransmittance() * uAtmSunIrradiance * disc * 18.0;

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
    this.lut.update(camera.position.y);
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
    this.lut.initialize(renderer);
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
          float radial = acos(clamp(dot(dir, uSunDir), -1.0, 1.0)) / 0.0046542;
          float limb = 0.42 + 0.58 * sqrt(max(1.0 - radial * radial, 0.0));
          float disc = (1.0 - smoothstep(0.98, 1.08, radial)) * limb;
          col += uSunColor * atm_sunTransmittance() * uAtmSunIrradiance * disc * 18.0;
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
    this.environmentTarget?.dispose();
    const target = pmrem.fromScene(scene, 0, 0.1, 10);
    this.environmentTarget = target;

    box.dispose();
    material.dispose();
    pmrem.dispose();
    return target.texture;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.environmentTarget?.dispose();
    this.environmentTarget = null;
    this.lut.dispose();
  }
}
