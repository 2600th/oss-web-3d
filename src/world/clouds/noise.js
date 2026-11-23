import * as THREE from 'three/webgpu';
import { Fn, vec2, vec3, vec4, float, uniform, uv, floor, fract, dot, mix, min, sqrt, clamp, saturate } from 'three/tsl';

/**
 * Tileable cloud noise, generated on the GPU at start-up.
 *
 * The volumes are RenderTarget3D slices filled by a full-screen quad, one draw
 * per slice. That is the same work a compute pass would do, but it also runs on
 * the WebGL2 fallback backend, which has no compute-to-texture path.
 *
 * Layout follows Schneider, "The Real-Time Volumetric Cloudscapes of Horizon Zero
 * Dawn" (SIGGRAPH 2015) and Hillaire's TileableVolumeNoise:
 *   shape  (128^3 RGBA8): R Perlin-Worley, GBA Worley fBm at rising frequency
 *   detail (32^3  RGBA8): RGB Worley fBm at rising frequency
 */

// Dave Hoskins' hash without sine: stable across GPUs and backends.
const hash33 = Fn(([p]) => {
  const q = fract(p.mul(vec3(0.1031, 0.103, 0.0973))).toVar();
  q.addAssign(dot(q, q.yxz.add(33.33)));
  return fract(q.xxy.add(q.yxx).mul(q.zyx));
});

const wrap = (c, period) => c.add(period).mod(period);

/** Inverted Worley noise in [0,1], periodic with integer `period`. p in lattice units. */
export const worley = (p, period) => Fn(() => {
  const cell = floor(p).toVar();
  const f = fract(p).toVar();
  const d = float(8).toVar();
  for (let z = -1; z <= 1; z++) for (let y = -1; y <= 1; y++) for (let x = -1; x <= 1; x++) {
    const o = vec3(x, y, z);
    const r = o.add(hash33(wrap(cell.add(o), period))).sub(f);
    d.assign(min(d, dot(r, r)));
  }
  return float(1).sub(clamp(sqrt(d), 0, 1));
})();

/** Gradient noise in roughly [-1,1], periodic with integer `period`. */
export const perlin = (p, period) => Fn(() => {
  const cell = floor(p).toVar();
  const f = fract(p).toVar();
  const u = f.mul(f).mul(f).mul(f.mul(f.mul(6).sub(15)).add(10)).toVar();
  const g = (x, y, z) => {
    const o = vec3(x, y, z);
    const grad = hash33(wrap(cell.add(o), period)).mul(2).sub(1);
    return dot(grad, f.sub(o));
  };
  const x00 = mix(g(0, 0, 0), g(1, 0, 0), u.x);
  const x10 = mix(g(0, 1, 0), g(1, 1, 0), u.x);
  const x01 = mix(g(0, 0, 1), g(1, 0, 1), u.x);
  const x11 = mix(g(0, 1, 1), g(1, 1, 1), u.x);
  return mix(mix(x00, x10, u.y), mix(x01, x11, u.y), u.z).mul(1.6);
})();

/** Perlin fBm mapped to [0,1]. uvw in [0,1), base frequency `freq` (integer). */
export const perlinFbm = (uvw, freq, octaves = 4, aniso = [1, 1, 1]) => {
  let sum = float(0);
  let amp = 0.5;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    const f = freq * 2 ** i;
    const period = vec3(f * aniso[0], f * aniso[1], f * aniso[2]);
    sum = sum.add(perlin(uvw.mul(period), period).mul(amp));
    norm += amp;
    amp *= 0.5;
  }
  return saturate(sum.div(norm).mul(0.75).add(0.5));
};

export const worleyFbm = (uvw, freq, maxFreq = 1e9) => {
  const w = (f) => worley(uvw.mul(Math.min(f, maxFreq)), Math.min(f, maxFreq));
  return w(freq).mul(0.625).add(w(freq * 2).mul(0.25)).add(w(freq * 4).mul(0.125));
};

const remap = (x, a, b, c, d) => x.sub(a).div(b.sub(a)).mul(d.sub(c)).add(c);

function render3D(renderer, size, fragment, name) {
  const target = new THREE.RenderTarget3D(size, size, size, { depthBuffer: false });
  const t = target.texture;
  t.name = name;
  t.minFilter = t.magFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = t.wrapR = THREE.RepeatWrapping;
  t.generateMipmaps = false;
  const w = uniform(0);
  const material = new THREE.NodeMaterial();
  material.depthTest = false;
  material.fragmentNode = fragment(vec3(uv(), w));
  const quad = new THREE.QuadMesh(material);
  const state = THREE.RendererUtils.resetRendererState(renderer);
  for (let i = 0; i < size; i++) {
    w.value = (i + 0.5) / size;
    renderer.setRenderTarget(target, i);
    quad.render(renderer);
  }
  THREE.RendererUtils.restoreRendererState(renderer, state);
  material.dispose();
  return target;
}

export function generateShapeNoise(renderer, size = 128) {
  return render3D(renderer, size, (p) => Fn(() => {
    const pf = perlinFbm(p, 4, size >= 96 ? 5 : 4);
    const w4 = worley(p.mul(4), 4);
    const w8 = worley(p.mul(8), 8);
    const w16 = worley(p.mul(16), 16);
    const w32 = worley(p.mul(32), 32);
    const g = w4.mul(0.625).add(w8.mul(0.25)).add(w16.mul(0.125)).toVar();
    const b = w8.mul(0.625).add(w16.mul(0.25)).add(w32.mul(0.125));
    const a = w16.mul(0.625).add(w32.mul(0.375));
    // Perlin-Worley: Perlin "dilated" by the low Worley fBm keeps connected billows.
    const pw = remap(pf, float(0), float(1), g.mul(0.85), float(1));
    return vec4(saturate(pw), g, b, a);
  })(), 'Clouds.shape');
}

export function generateDetailNoise(renderer, size = 32) {
  return render3D(renderer, size, (p) => Fn(() => {
    const w2 = worley(p.mul(2), 2);
    const w4 = worley(p.mul(4), 4);
    const w8 = worley(p.mul(8), 8);
    const w16 = worley(p.mul(16), 16);
    return vec4(
      w2.mul(0.625).add(w4.mul(0.25)).add(w8.mul(0.125)),
      w4.mul(0.625).add(w8.mul(0.25)).add(w16.mul(0.125)),
      w8.mul(0.625).add(w16.mul(0.375)),
      1,
    );
  })(), 'Clouds.detail');
}

/**
 * Tileable 2D cirrus texture: R streaky fibres, G broad patches.
 */
export function generateCirrusNoise(renderer, size = 512) {
  const target = new THREE.RenderTarget(size, size, { depthBuffer: false });
  const t = target.texture;
  t.name = 'Clouds.cirrus';
  t.minFilter = t.magFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.generateMipmaps = false;
  const material = new THREE.NodeMaterial();
  material.depthTest = false;
  material.fragmentNode = Fn(() => {
    const st = uv();
    const p0 = vec3(st, 0.37);
    // Domain warp, then stretch 1:3 so the fibres run along one axis.
    const warp = vec2(perlin(p0.mul(4), 4), perlin(p0.add(vec3(0.31, 0.17, 0.5)).mul(4), 4)).mul(0.06);
    const q = vec3(st.add(warp), 0.11);
    const fibres = perlinFbm(q, 5, 5, [1, 3, 1]);
    const fine = perlinFbm(q.add(vec3(0.5, 0.25, 0.3)), 18, 3, [1, 3, 1]);
    const patches = perlinFbm(vec3(st, 0.71), 3, 3);
    return vec4(saturate(fibres.mul(0.7).add(fine.mul(0.3))), patches, 0, 1);
  })();
  const quad = new THREE.QuadMesh(material);
  const state = THREE.RendererUtils.resetRendererState(renderer);
  renderer.setRenderTarget(target);
  quad.render(renderer);
  THREE.RendererUtils.restoreRendererState(renderer, state);
  material.dispose();
  return target;
}
