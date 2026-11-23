import * as THREE from 'three/webgpu';
import { SkyMesh } from 'three/addons/objects/SkyMesh.js';
import { Fn, float } from 'three/tsl';

/**
 * Foundation sky and lighting. The atmosphere owner replaces SkyMesh with the
 * physical atmosphere (sky, aerial perspective, sun/ambient from LUTs) and
 * keeps this public surface: `sunDirection` (unit, world, toward the sun),
 * `sun` (DirectionalLight), `ambient`, `update(dt, camera)`, `cloudShadow`,
 * `inCloud`.
 */
export class Environment {
  constructor(r) {
    this.r = r;
    this.sunDirection = new THREE.Vector3();
    this.setSun(28, 140); // elevation, azimuth (deg from north, clockwise)

    /**
     * TSL Fn(worldPosition: vec3) -> float, 1 = fully sunlit. Materials that
     * want cloud shadows use
     *   material.receivedShadowNode = Fn(([s]) => s.mul(env.cloudShadow(positionWorld)))
     * The clouds owner replaces the body; the identity default keeps callers valid.
     */
    this.cloudShadow = Fn(([p]) => float(1).add(p.x.mul(0)));
    /** 0..1, how deep the camera is inside cloud (post/vfx/audio read it). */
    this.inCloud = 0;

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
