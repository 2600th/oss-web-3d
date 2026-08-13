import * as THREE from 'three';

/**
 * Owns the lighting/atmosphere state that sky, terrain, clouds and aircraft all
 * have to agree on. Everything shares the *same* uniform objects, so changing
 * the sun here changes it everywhere with no per-frame plumbing.
 *
 * Time of day is fixed to a late-morning high-altitude sun: hard directional
 * light, cold blue shadow fill, very high contrast. That is what the Kargil
 * reference photography looks like and it is what makes snow read as snow.
 */
export class Environment {
  constructor() {
    // Sun elevation ~46 degrees, coming from the south-east.
    this.sunAzimuth = THREE.MathUtils.degToRad(128);
    this.sunElevation = THREE.MathUtils.degToRad(46);

    this.sunDir = new THREE.Vector3();
    this._updateSunDir();

    this.uniforms = {
      uSunDir: { value: this.sunDir },
      uSunColor: { value: new THREE.Color(1.0, 0.94, 0.84) },
      // Deep, dark zenith. At 7 km there is a third of the atmosphere overhead
      // and the sky really is close to navy — and without that depth, white
      // cloud over white mountain has nothing to read against.
      uZenithColor: { value: new THREE.Color(0.028, 0.088, 0.30) },
      uHorizonColor: { value: new THREE.Color(0.56, 0.68, 0.85) },
      uHazeDensity: { value: 5.2e-5 },
      uHazeHeight: { value: 2500.0 },
      // Haze is measured from just below the valley floors, not sea level.
      uHazeBase: { value: 2600.0 },
      uSunIntensity: { value: 1.5 },
      uTime: { value: 0 },
      uWind: { value: new THREE.Vector2(11.0, 4.5) },
      // Cloud field. Shared by the volumetric march and the terrain's cloud
      // shadows so both describe the same weather; see clouds.glsl.js.
      uCloudBase: { value: 4600.0 },
      uCloudTop: { value: 6450.0 },
      uCloudCoverage: { value: 0.00055 },
      uCloudDensity: { value: 0.0042 },
      uCloudWind: { value: new THREE.Vector2(3.8, 1.6) },
      uCloudTime: { value: 0 },
      uCameraPos: { value: new THREE.Vector3() },
    };

    // A three.js light so the aircraft's standard PBR materials receive the
    // same sun as the custom terrain shader.
    this.sunLight = new THREE.DirectionalLight(0xfff2e0, 1.5);
    this.sunLight.position.copy(this.sunDir).multiplyScalar(1000);

    // Cold sky bounce. Snow fields throw a lot of light back up, hence the
    // relatively strong ground colour.
    this.hemiLight = new THREE.HemisphereLight(0x9dc4ff, 0xcfe0f0, 1.05);
  }

  _updateSunDir() {
    const ce = Math.cos(this.sunElevation);
    this.sunDir
      .set(ce * Math.sin(this.sunAzimuth), Math.sin(this.sunElevation), ce * Math.cos(this.sunAzimuth))
      .normalize();
  }

  addTo(scene) {
    scene.add(this.sunLight);
    scene.add(this.sunLight.target);
    scene.add(this.hemiLight);
  }

  update(dt, cameraPos) {
    this.uniforms.uTime.value += dt;
    this.uniforms.uCloudTime.value += dt;
    this.uniforms.uCameraPos.value.copy(cameraPos);
    // Keep the directional light anchored to the camera so its (unused for
    // shadows, but used for specular) direction stays stable in a moving world.
    this.sunLight.position.copy(cameraPos).addScaledVector(this.sunDir, 5000);
    this.sunLight.target.position.copy(cameraPos);
  }
}
