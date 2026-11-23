import * as THREE from 'three/webgpu';
import { SkyMesh } from 'three/addons/objects/SkyMesh.js';

/**
 * Foundation sky and lighting. The atmosphere owner replaces SkyMesh with the
 * physical atmosphere (sky, aerial perspective, sun/ambient from LUTs) and
 * keeps this public surface: `sunDirection` (unit, world, toward the sun),
 * `sun` (DirectionalLight), `ambient`, `update(dt, camera)`.
 */
export class Environment {
  constructor(r) {
    this.r = r;
    this.sunDirection = new THREE.Vector3();
    this.setSun(28, 140); // elevation, azimuth (deg from north, clockwise)

    this.sky = new SkyMesh();
    this.sky.scale.setScalar(200000);
    this.sky.turbidity.value = 3;
    this.sky.rayleigh.value = 1.2;
    this.sky.mieCoefficient.value = 0.004;
    this.sky.mieDirectionalG.value = 0.85;
    this.sky.cloudCoverage.value = 0.0;
    this.sky.frustumCulled = false;
    // Drawn first, never occludes: SkyMesh projects to the far plane, which a
    // reversed depth buffer treats as nearest.
    this.sky.material.depthTest = false;
    this.sky.material.depthWrite = false;
    this.sky.renderOrder = -1000;

    this.sun = new THREE.DirectionalLight(0xfff3e0, 3.2);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.setScalar(2048);
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 4000;
    const s = 60;
    Object.assign(this.sun.shadow.camera, { left: -s, right: s, top: s, bottom: -s });
    this.sun.shadow.bias = -0.0005;
    this.sun.shadow.normalBias = 0.05;

    this.ambient = new THREE.HemisphereLight(0x9cc4ff, 0x6b5a48, 0.9);
    this.group = new THREE.Group();
    this.group.add(this.sky, this.sun, this.sun.target, this.ambient);
  }

  setSun(elevationDeg, azimuthDeg) {
    const el = THREE.MathUtils.degToRad(elevationDeg);
    const az = THREE.MathUtils.degToRad(azimuthDeg);
    // azimuth from north (-Z) clockwise toward east (+X)
    this.sunDirection.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)).normalize();
  }

  /** Keep the shadow frustum on the focus (usually the player aircraft). */
  update(dt, camera, focus = camera.position) {
    this.sky.position.copy(camera.position);
    this.sky.sunPosition.value.copy(this.sunDirection);
    this.sun.target.position.copy(focus);
    this.sun.position.copy(focus).addScaledVector(this.sunDirection, 2000);
  }

  addTo(scene) {
    scene.add(this.group);
  }
}
