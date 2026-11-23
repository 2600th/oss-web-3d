import * as THREE from 'three/webgpu';
import {
  Fn, float, vec2, uniform, uniformArray, screenUV, texture, convertToTexture, dot, length, smoothstep, select, max,
} from 'three/tsl';

const MAX = 8;
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();

/**
 * Heat haze as a self-contained HDR scene stage.
 *
 * Effects register heat sources each frame as world-space capsules (a nozzle
 * plume, the air over a fire, an explosion's pressure bubble). The strongest
 * few are projected to the screen on the CPU and the stage refracts the image
 * around them with scrolling noise, masked by scene depth so haze behind a
 * ridge does not bend the ridge.
 */
export class Heat {
  constructor(shared) {
    this.shared = shared;
    this._segs = Array.from({ length: MAX }, () => new THREE.Vector4());   // a.xy, b.xy (aspect-corrected screen)
    this._params = Array.from({ length: MAX }, () => new THREE.Vector4()); // radius, strength, view depth, world radius
    this.segs = uniformArray(this._segs, 'vec4');
    this.params = uniformArray(this._params, 'vec4');
    this.aspect = uniform(1);
    this.sources = [];
    this._free = [];
    this.activeCount = 0;
  }

  /** Capsule from `a` to `b` (world), `radius` metres, `strength` ~0..1. Call every frame. */
  add(a, b, radius, strength) {
    if (strength <= 0.001) return;
    const s = this._free.pop() ?? { a: new THREE.Vector3(), b: new THREE.Vector3(), radius: 1, strength: 0, score: 0 };
    s.a.copy(a); s.b.copy(b); s.radius = radius; s.strength = strength;
    this.sources.push(s);
  }

  update(camera) {
    const aspect = camera.aspect;
    this.aspect.value = aspect;
    const tanHalf = Math.tan(THREE.MathUtils.degToRad(camera.fov) * 0.5);
    const list = [];
    for (const s of this.sources) {
      _a.copy(s.a).applyMatrix4(camera.matrixWorldInverse);
      _b.copy(s.b).applyMatrix4(camera.matrixWorldInverse);
      const za = -_a.z, zb = -_b.z;
      if (za < 0.6 || zb < 0.6) continue;
      const z = Math.min(za, zb);
      const rs = s.radius / (z * tanHalf * 2);      // in screen heights
      if (rs < 0.004 || rs > 3) continue;
      const ax = (_a.x / (za * tanHalf * aspect)) * 0.5 + 0.5, ay = 0.5 - (_a.y / (za * tanHalf)) * 0.5;
      const bx = (_b.x / (zb * tanHalf * aspect)) * 0.5 + 0.5, by = 0.5 - (_b.y / (zb * tanHalf)) * 0.5;
      if (Math.min(ax, bx) > 1 + rs || Math.max(ax, bx) < -rs || Math.min(ay, by) > 1 + rs || Math.max(ay, by) < -rs) continue;
      // distant haze is weaker: shimmer is a near-field effect
      const k = s.strength * Math.min(1, 1.6 * Math.sqrt(rs * 6));
      list.push({ ax: ax * aspect, ay, bx: bx * aspect, by, rs, k, z: (za + zb) * 0.5, wr: s.radius, score: k * rs });
    }
    list.sort((p, q) => q.score - p.score);
    for (let i = 0; i < MAX; i++) {
      const q = list[i];
      if (q) {
        this._segs[i].set(q.ax, q.ay, q.bx, q.by);
        this._params[i].set(q.rs, q.k, q.z, q.wr);
      } else {
        this._params[i].set(1, 0, 0, 0);
      }
    }
    this.activeCount = Math.min(list.length, MAX);
    for (const s of this.sources) this._free.push(s);
    this.sources.length = 0;
  }

  /** Scene stage: `fn(colorNode, ctx) => colorNode`. */
  stage() {
    const sh = this.shared;
    return (color) => {
      const src = convertToTexture(color);
      const offset = Fn(() => {
        const p = vec2(screenUV.x.mul(this.aspect), screenUV.y);
        const t = sh.u.time;
        const n1 = texture(sh.tex.noise, p.mul(3.1).add(vec2(t.mul(0.07), t.mul(-0.9)))).rg.sub(0.5);
        const n2 = texture(sh.tex.noise, p.mul(7.3).add(vec2(t.mul(-0.11), t.mul(-1.7)))).ba.sub(0.5);
        const n = n1.add(n2.mul(0.6));
        const sceneZ = sh.sceneViewZ();
        const acc = float(0).toVar();
        for (let i = 0; i < MAX; i++) {
          const sg = this.segs.element(i), pr = this.params.element(i);
          const a = sg.xy, ab = sg.zw.sub(sg.xy);
          const h = dot(p.sub(a), ab).div(max(dot(ab, ab), 1e-6)).clamp(0, 1);
          const d = length(p.sub(a).sub(ab.mul(h)));
          const f = smoothstep(0, pr.x, d).oneMinus();
          // only bend what lies at or behind the hot air
          const vis = select(sceneZ.greaterThan(pr.z.sub(pr.w)), float(1), float(0));
          acc.addAssign(f.mul(f).mul(pr.y).mul(vis));
        }
        return n.mul(acc.min(1.5)).mul(0.022);
      })();
      // A plain expression, not a texture node: later stages (TRAA) call
      // convertToTexture on the result and must get a render target of their own.
      return src.sample(screenUV.add(offset)).xyzw;
    };
  }
}
