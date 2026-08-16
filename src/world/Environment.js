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
    // Mid-morning rather than late morning, from the south-east.
    //
    // 46 degrees was too high for the terrain to show its own relief: the
    // clipmap bakes a real ray-marched shadow per heightmap texel, and a sun
    // that steep casts almost nothing for it to record, so ridgelines read as
    // smooth clay. Dropping it is the single largest visual change available
    // here and it costs no new rendering work.
    this.sunAzimuth = THREE.MathUtils.degToRad(122);
    this.sunElevation = THREE.MathUtils.degToRad(24);

    this.sunDir = new THREE.Vector3();
    this._updateSunDir();

    this.uniforms = {
      uSunDir: { value: this.sunDir },
      // Warmer, to match the lower sun. Snow lit by a low sun is warm-white;
      // only its shadows are blue.
      uSunColor: { value: new THREE.Color(1.0, 0.88, 0.74) },
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
      // The Perlin-Worley volumes the density field reads. Owned and filled in
      // by CloudVolume once it has a renderer; declared here because the
      // terrain spreads these uniforms into its own material and compiles the
      // same density code for its cloud shadows.
      uCloudShape: { value: null },
      uCloudDetail: { value: null },
      uCameraPos: { value: new THREE.Vector3() },
    };

    // A three.js light so the aircraft's standard PBR materials receive the
    // same sun as the custom terrain shader.
    this.sunLight = new THREE.DirectionalLight(0xfff2e0, 1.5);
    this.sunLight.position.copy(this.sunDir).multiplyScalar(1000);

    // Cold sky bounce. Snow fields throw a lot of light back up, hence the
    // relatively strong ground colour.
    // Cut back with the sun. At 1.05 this alone put more blue on the airframe
    // than the sun put warm light, which is the aircraft-side half of the cyan
    // cast the terrain shader carried.
    this.hemiLight = new THREE.HemisphereLight(0x9dc4ff, 0xcfe0f0, 0.62);
  }

  /**
   * Move the sun, in degrees.
   *
   * Everything shares these uniform objects, so terrain, sky, clouds and the
   * aircraft's PBR materials all follow with no per-frame plumbing. The
   * transmittance and multiple-scattering LUTs are parameterised by sun zenith
   * rather than baked against a fixed sun, so they do not need rebuilding at
   * all; the sky-view and aerial LUTs already regenerate on their own cadence.
   *
   * Colour and intensity travel with elevation because a low sun really is
   * warmer and weaker, and because leaving them fixed is what made a lowered
   * sun look like a bug rather than an hour of the day.
   */
  setSun(elevationDeg, azimuthDeg) {
    this.sunElevation = THREE.MathUtils.degToRad(elevationDeg);
    this.sunAzimuth = THREE.MathUtils.degToRad(azimuthDeg);
    this._updateSunDir();
    this.sunLight.position.copy(this.sunDir).multiplyScalar(1000);

    const t = THREE.MathUtils.clamp((elevationDeg - 8) / 34, 0, 1);
    this.uniforms.uSunColor.value.setRGB(1.0, 0.78 + 0.14 * t, 0.58 + 0.24 * t);
    this.uniforms.uSunIntensity.value = 1.15 + 0.5 * t;
    this.sunLight.color.copy(this.uniforms.uSunColor.value);
    this.sunLight.intensity = this.uniforms.uSunIntensity.value;
    // Sky bounce falls off with the sun rather than staying at its noon value,
    // which is half of why the world used to read blue at any hour.
    this.hemiLight.intensity = 0.38 + 0.30 * t;
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

  dispose() {
    this.sunLight.removeFromParent();
    this.sunLight.target.removeFromParent();
    this.hemiLight.removeFromParent();
  }
}
