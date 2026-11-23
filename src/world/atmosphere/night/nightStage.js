import * as THREE from 'three/webgpu';
import { Fn, vec3, vec4, float, uniform, uv, select, length, normalize, dot, max, getViewPosition } from 'three/tsl';

/**
 * Screen-space night terms, composited in linear HDR through PostFX scene
 * stages (the time-of-day system registers them):
 *
 *   aerial(atmosphere)  order 21, right after the day aerial perspective.
 *     The froxels only carry in-scattered *sunlight*; at night they still
 *     attenuate distant terrain (toward black). This adds what the night air
 *     itself scatters toward the eye - moonlit haze and airglow - as
 *     (1 - transmittance) x the night horizon radiance, so far ridges fade to
 *     the night sky's horizon colour and stay readable as layered silhouettes.
 *
 *   clouds(atmosphere, cloudsObject)  order 31, right after the cloud composite.
 *     (a) the same night haze on the clouds' own depth;
 *     (b) a flash term: up to FLASH_SLOTS point flashes (explosions, lightning)
 *         light the cloud in front of each pixel, by the cloud's opacity and
 *         the distance from its front surface to the flash. No extra march:
 *         two taps of the cloud history the composite already reads.
 */

export const FLASH_SLOTS = 4;

export class NightStage {
  constructor({ slots = FLASH_SLOTS } = {}) {
    this.u = {
      /** Night radiance toward the horizon (airglow + moonlit haze), renderer units. */
      fog: uniform(new THREE.Vector3()),
      flashPos: [],
      flashCol: [],
    };
    for (let i = 0; i < slots; i++) {
      this.u.flashPos.push(uniform(new THREE.Vector4(0, 0, 0, 1))); // xyz world, w = range (m)
      this.u.flashCol.push(uniform(new THREE.Vector3()));
    }
    this.flashes = [];
  }

  /**
   * A flash that lights nearby cloud.
   *   color: [r, g, b] (0..1); intensity: radiance added to fully opaque
   *   cloud at the flash itself (renderer units; night cloud is about 0.02,
   *   so 2..5 is a strong flash); range: metres (see the falloff in
   *   clouds()); duration: seconds, quadratic decay.
   */
  flash(position, { color = [1, 0.7, 0.4], intensity = 0.6, range = 1500, duration = 0.5 } = {}) {
    if (this.flashes.length >= 24) this.flashes.shift();
    this.flashes.push({ x: position.x, y: position.y, z: position.z, color, intensity, range, duration, age: 0 });
  }

  update(dt, camPos) {
    const fl = this.flashes;
    for (let i = fl.length - 1; i >= 0; i--) {
      fl[i].age += dt;
      if (fl[i].age >= fl[i].duration) fl.splice(i, 1);
    }
    const slots = this.u.flashPos.length;
    if (fl.length > slots) {
      // keep the ones that matter most from here: bright and close
      for (const f of fl) {
        const k = 1 - f.age / f.duration;
        const d2 = (f.x - camPos.x) ** 2 + (f.y - camPos.y) ** 2 + (f.z - camPos.z) ** 2;
        f.score = f.intensity * k * k * f.range * f.range / (d2 + f.range * f.range);
      }
      fl.sort((a, b) => b.score - a.score);
    }
    for (let i = 0; i < slots; i++) {
      const f = fl[i];
      if (f) {
        const k = 1 - f.age / f.duration;
        const s = f.intensity * k * k;
        this.u.flashPos[i].value.set(f.x, f.y, f.z, f.range);
        this.u.flashCol[i].value.set(f.color[0] * s, f.color[1] * s, f.color[2] * s);
      } else {
        this.u.flashCol[i].value.set(0, 0, 0);
      }
    }
  }

  aerial(atmosphere) {
    const fog = this.u.fog;
    return (color, ctx) => Fn(() => {
      const st = uv();
      const depth = ctx.depth.sample(st).r.toVar();
      const background = ctx.renderer.reversedDepthBuffer === true ? depth.lessThanEqual(0) : depth.greaterThanEqual(1);
      const vp = getViewPosition(st, depth, atmosphere.u.projInv);
      const ap = atmosphere.apSample(st, length(vp));
      return vec4(select(background, color.rgb, color.rgb.add(fog.mul(float(1).sub(ap.a)))), color.a);
    })();
  }

  clouds(atmosphere, clouds) {
    const u = this.u;
    const au = atmosphere.u;
    return (color) => {
      const node = clouds?.node; // created by the cloud stage, which runs before this one
      if (!node?.auxNode) return color;
      return Fn(() => {
        const st = uv();
        const aux = node.auxNode.sample(st).toVar(); // r: front distance (km), b: opacity
        const front = aux.r.mul(1000).toVar();
        const opacity = aux.b.toVar();
        const add = vec3(0).toVar();
        // night haze in front of the cloud
        const ap = atmosphere.apSample(st, front);
        add.addAssign(u.fog.mul(float(1).sub(ap.a)));
        // flashes
        const dirV = normalize(getViewPosition(st, float(0.5), au.projInv));
        const dir = normalize(au.cameraWorld.mul(vec4(dirV, 0)).xyz);
        const p = au.cameraPos.add(dir.mul(front)).toVar();
        for (let i = 0; i < u.flashPos.length; i++) {
          const d = p.sub(u.flashPos[i].xyz);
          const r = u.flashPos[i].w;
          // 1 / (1 + (d/r)^2)^2: half brightness at 0.64 r, 1 % at 3 r, so a
          // flash lights the cloud it is in or under and not the whole sky
          const k = float(1).div(dot(d, d).div(r.mul(r)).add(1));
          add.addAssign(u.flashCol[i].mul(k.mul(k)));
        }
        return vec4(color.rgb.add(add.mul(max(opacity, 0))), color.a);
      })();
    };
  }
}
