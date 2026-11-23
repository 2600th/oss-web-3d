import * as THREE from 'three/webgpu';
import { Fn, vec2, ivec2, float, texture, textureLoad, floor, clamp, mix, smoothstep, step } from 'three/tsl';
import { SHADOW_MIN, SHADOW_STEP } from './shadowConst.js';
import { SWEEP_REACH } from '../shadows/shadowMath.js';
export { SHADOW_MIN, SHADOW_STEP };


/**
 * Long-range terrain self-shadowing. Owns an R8 texture registered to the DEM
 * and a worker that refills it whenever the sun has moved (see shadowWorker.js
 * for the algorithm). Until the first sweep lands the texture reads "lit".
 */
export class ShadowSweep {
  constructor(DEM) {
    const n = DEM.res;
    this.res = n;
    this.texture = new THREE.DataTexture(new Uint8Array(n * n), n, n, THREE.RedFormat, THREE.UnsignedByteType);
    this.texture.magFilter = this.texture.minFilter = THREE.LinearFilter;
    this.texture.colorSpace = THREE.NoColorSpace;
    this.texture.needsUpdate = true;
    this._dir = new THREE.Vector3(0, 0, 0); // direction of the sweep in flight or shown
    this._busy = false;
    this._id = 0;
    this._last = -1e9;
    this.sweeps = 0;
    this.worker = null;
    if (typeof Worker === 'undefined') return;
    try {
      this.worker = new Worker(new URL('./shadowWorker.js', import.meta.url), { type: 'module' });
      // The worker keeps its own copy: the main thread still needs the heights.
      const copy = DEM.data.slice();
      this.worker.postMessage({ type: 'init', heights: copy, res: n, cellX: DEM.cellX, cellZ: DEM.cellZ }, [copy.buffer]);
      this.worker.onmessage = (e) => {
        if (e.data.type !== 'done') return;
        this.texture.image.data.set(e.data.data);
        this.texture.needsUpdate = true;
        this._busy = false;
        this.sweeps++;
        this.lastMs = performance.now() - this._t0;
      };
      this.worker.onerror = (e) => { console.warn('[terrain] shadow worker failed', e.message); this.worker = null; };
    } catch (e) {
      console.warn('[terrain] shadow worker unavailable', e);
    }
  }

  /** Call every frame with the unit direction toward the sun. */
  update(sunDir, now = performance.now()) {
    if (!this.worker || this._busy) return;
    if (this._dir.dot(sunDir) > 0.999997 || now - this._last < 250) return; // < ~0.14 deg, or too soon
    this._dir.copy(sunDir);
    this._last = now;
    this._busy = true;
    this._t0 = now;
    this.worker.postMessage({ type: 'sweep', id: ++this._id, dir: [sunDir.x, sunDir.y, sunDir.z] });
  }

  /**
   * [shadows] TSL Fn(worldPos) -> 0..1: the sweep's shadow at any point near
   * the ground, for receivers other than the terrain (units, props, a jet on a
   * low pass). The sweep stores, per DEM texel, how far the shadow boundary
   * lies above the DEM ground (S - h), so a point `agl` metres up is shadowed
   * by (S - h) - agl metres. The 8-bit field saturates at 47.75 m, so the term
   * fades out between SWEEP_REACH.full and .none metres above the ground
   * (higher points keep the old behaviour: no terrain shadow).
   * `heightTex` is the terrain's R32F DEM texture (bilinear by hand: float32
   * textures are not filterable everywhere).
   */
  makeShadowFn(heightTex, DEM, soft = 3.5) {
    const n = this.res;
    const minXZ = vec2(DEM.minX, DEM.minZ);
    const cell = vec2(DEM.cellX, DEM.cellZ);
    const tex = this.texture;
    return Fn(([p]) => {
      const g = p.xz.sub(minXZ).div(cell).toVar();
      const inside = step(0, g.x).mul(step(0, g.y)).mul(step(g.x, n - 1)).mul(step(g.y, n - 1));
      const sweep = texture(tex, g.add(0.5).div(n)).level(0).r.mul(255 * SHADOW_STEP).add(SHADOW_MIN);
      const f = clamp(g, vec2(0), vec2(n - 1.0001));
      const i = floor(f);
      const k = f.sub(i);
      const ii = ivec2(i);
      const a = textureLoad(heightTex, ii).r;
      const b = textureLoad(heightTex, ii.add(ivec2(1, 0))).r;
      const c = textureLoad(heightTex, ii.add(ivec2(0, 1))).r;
      const d = textureLoad(heightTex, ii.add(ivec2(1, 1))).r;
      const top = a.add(b.sub(a).mul(k.x));
      const h = top.add(c.add(d.sub(c).mul(k.x)).sub(top).mul(k.y));
      const agl = p.y.sub(h);
      const lit = smoothstep(soft, -soft, sweep.sub(agl));
      const reach = float(1).sub(smoothstep(SWEEP_REACH.full, SWEEP_REACH.none, agl)).mul(inside);
      return mix(float(1), lit, reach);
    });
  }

  dispose() {
    this.worker?.terminate();
    this.texture.dispose();
  }
}
