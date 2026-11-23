import * as THREE from 'three/webgpu';
import {
  uniform, texture, screenUV, cameraNear, cameraFar, perspectiveDepthToViewZ, Fn, vec3, float, length, positionView,
} from 'three/tsl';

const _m = new THREE.Matrix4();
const _v = new THREE.Vector3();
const _prevCam = new THREE.Vector3();
const GROUND_ALBEDO = [0.26, 0.23, 0.2];

/**
 * Uniforms, textures and helpers shared by every VFX material: clock, sun and
 * sky colours, wind, camera basis, and the opaque scene depth (sampled from the
 * post chain's scene pass, so the VFX layer can soft-clip against the world
 * without a framebuffer copy).
 *
 * Light comes from the environment: `sunColor` is the direct solar irradiance
 * at the camera's altitude, `skyColor` / `groundColor` the radiance of the two
 * ambient hemispheres (env.skyAmbient; the ground one follows env.sunVisibility,
 * so smoke over shadowed country is lit by shadowed country). Materials
 * multiply the sun by `cloudShadow(worldPos)` and their output by
 * `cloudVis()`, the transmittance of the cloud between them and the camera.
 */
export class Shared {
  constructor(game) {
    this.game = game;
    this.u = {
      time: uniform(0),
      dt: uniform(1 / 60),
      sunDir: uniform(new THREE.Vector3(0.3, 0.8, 0.2).normalize()),      // world, toward the sun
      sunDirView: uniform(new THREE.Vector3(0, 1, 0)),                    // view space
      sunColor: uniform(new THREE.Color(3, 2.9, 2.7)),                    // colour * intensity
      skyColor: uniform(new THREE.Color(0.5, 0.7, 1.0)),                  // ambient from above
      groundColor: uniform(new THREE.Color(0.4, 0.35, 0.3)),              // ambient from below
      wind: uniform(new THREE.Vector3(7, 0, 3)),                          // m/s, world
      camPos: uniform(new THREE.Vector3()),
      camRight: uniform(new THREE.Vector3(1, 0, 0)),
      camUp: uniform(new THREE.Vector3(0, 1, 0)),
      camFwd: uniform(new THREE.Vector3(0, 0, -1)),
      camVel: uniform(new THREE.Vector3()),
      pixelAngle: uniform(0.001),   // view-space size of one pixel at unit distance
      fade: uniform(1),             // global visibility (drops inside cloud)
    };
    this.tex = {};
    this.time = 0;
    this._first = true;

    // Opaque scene depth -> positive view-space distance along -Z.
    const depthTex = game.post?.scenePass?.renderTarget?.depthTexture ?? null;
    this.hasSceneDepth = !!depthTex;
    if (depthTex) {
      const d = texture(depthTex, screenUV);
      this.sceneViewZ = Fn(() => perspectiveDepthToViewZ(d.r, cameraNear, cameraFar).negate());
    } else {
      this.sceneViewZ = Fn(() => float(1e9));
    }

    // Clouds: shadow on the effect, and the cloud in front of it. The VFX
    // layer is composited after the cloud stage, so without this a trail
    // behind a cumulus is drawn over it.
    const env = game.env;
    const clouds = env?.clouds ?? null;
    this.hasCloudOcclusion = !!clouds?.visibilityAt;
    /** TSL: (viewDistance) -> 0..1 at this fragment's screen position (fragment stage only). */
    this.cloudVisAt = this.hasCloudOcclusion
      ? Fn(([dist]) => clouds.visibilityAt(screenUV, dist))
      : Fn(([dist]) => float(1).add(dist.mul(0)));
    /** Same, for materials whose `positionView` is the shaded point. */
    this.cloudVis = Fn(() => this.cloudVisAt(length(positionView)));
    /** TSL: (worldPos) -> 0..1 sun reaching that point through the clouds. */
    this.cloudShadow = env?.cloudShadow ?? Fn(([p]) => float(1).add(p.x.mul(0)));
  }

  async load(base = './assets/vfx/') {
    const loader = new THREE.TextureLoader();
    const [a, b, n] = await Promise.all([
      loader.loadAsync(base + 'smoke6_a.png'),
      loader.loadAsync(base + 'smoke6_b.png'),
      loader.loadAsync(base + 'noise.png'),
    ]);
    for (const t of [a, b, n]) { t.colorSpace = THREE.NoColorSpace; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; }
    n.wrapS = n.wrapT = THREE.RepeatWrapping;
    this.tex.smokeA = a; this.tex.smokeB = b; this.tex.noise = n;
  }

  /** Call once per frame after the camera has its final pose. */
  update(dt, game) {
    const u = this.u;
    this.time += dt;
    u.time.value = this.time;
    u.dt.value = dt;
    const cam = game.camera;
    cam.updateMatrixWorld();
    const e = cam.matrixWorld.elements;
    u.camRight.value.set(e[0], e[1], e[2]);
    u.camUp.value.set(e[4], e[5], e[6]);
    u.camFwd.value.set(-e[8], -e[9], -e[10]);
    _v.setFromMatrixPosition(cam.matrixWorld);
    if (this._first || dt <= 0) u.camVel.value.set(0, 0, 0);
    else {
      u.camVel.value.copy(_v).sub(_prevCam).divideScalar(dt);
      if (u.camVel.value.lengthSq() > 4e6) u.camVel.value.set(0, 0, 0); // teleport / camera cut
    }
    _prevCam.copy(_v);
    u.camPos.value.copy(_v);
    this._first = false;

    const h = game.r?.renderer?.domElement?.height || 1080;
    u.pixelAngle.value = (2 * Math.tan(THREE.MathUtils.degToRad(cam.fov) * 0.5)) / h;

    const env = game.env;
    if (env) {
      if (env.sunDirection) u.sunDir.value.copy(env.sunDirection).normalize();
      const e = env.sunIrradiance, sky = env.skyAmbient?.irradiance;
      if (e && sky) {
        // Physical inputs: direct irradiance, and the two ambient hemispheres
        // as the radiance a white diffuser would show (E / pi).
        u.sunColor.value.setRGB(e[0], e[1], e[2]);
        u.skyColor.value.setRGB(sky[0] / Math.PI, sky[1] / Math.PI, sky[2] / Math.PI);
        const up = Math.max(u.sunDir.value.y, 0) * (0.25 + 0.75 * THREE.MathUtils.clamp(env.sunVisibility ?? 1, 0, 1));
        u.groundColor.value.setRGB(
          GROUND_ALBEDO[0] * (e[0] * up + sky[0]) / Math.PI,
          GROUND_ALBEDO[1] * (e[1] * up + sky[1]) / Math.PI,
          GROUND_ALBEDO[2] * (e[2] * up + sky[2]) / Math.PI,
        );
      } else {
        if (env.sun?.color) u.sunColor.value.copy(env.sun.color).multiplyScalar(env.sun.intensity ?? 3);
        const amb = env.ambient;
        if (amb?.isHemisphereLight) {
          u.skyColor.value.copy(amb.color).multiplyScalar(amb.intensity);
          u.groundColor.value.copy(amb.groundColor).multiplyScalar(amb.intensity);
        } else if (amb?.color) {
          u.skyColor.value.copy(amb.color).multiplyScalar(amb.intensity ?? 1);
          u.groundColor.value.copy(u.skyColor.value).multiplyScalar(0.6);
        }
      }
      // Inside cloud the sun is gone and the light is the cloud's own white
      // fill (the cloud shadow map only describes the air below the layer).
      const ic = THREE.MathUtils.clamp(env.inCloud ?? 0, 0, 1);
      if (ic > 0) {
        u.sunColor.value.multiplyScalar(1 - 0.6 * ic);
        u.skyColor.value.multiplyScalar(1 + 3 * ic);
        u.groundColor.value.multiplyScalar(1 + 5 * ic);
      }
      if (env.wind?.isVector3) u.wind.value.copy(env.wind);
      else if (env.clouds?.wind) u.wind.value.copy(env.clouds.wind);
      // With per-fragment cloud occlusion the layer no longer needs to be
      // dimmed wholesale inside cloud; keep the old fade as the fallback.
      u.fade.value = this.hasCloudOcclusion ? 1 : 1 - 0.75 * THREE.MathUtils.clamp(env.inCloud ?? 0, 0, 1);
    }
    _m.copy(cam.matrixWorldInverse);
    u.sunDirView.value.copy(u.sunDir.value).transformDirection(_m);
  }
}

/**
 * Blackbody-ish fire ramp. heat 0 -> black, 0.4 -> deep red, 1 -> orange,
 * 2+ -> yellow-white (clamped so the core stays saturated under tone mapping).
 */
export const fireRamp = Fn(([heat]) => {
  const h = heat.clamp(0, 1.7);
  const h2 = h.mul(h);
  return vec3(h.mul(1.35).add(h2.mul(0.5)), h2.mul(0.52), h2.mul(h2).mul(0.06));
});
