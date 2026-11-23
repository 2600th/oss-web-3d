/**
 * Ray-traced ambient occlusion for tools/blender/build-mig-skin.mjs.
 *
 * A small BVH over the airframe's opaque triangles and a cosine-weighted
 * hemisphere sampler, run on worker threads (this file is its own worker).
 * Deterministic: the sample set is fixed and each texel's rotation comes from
 * a hash of its index.
 */
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import os from 'node:os';

/**
 * @param {Float32Array} tri  n * 9: the three corners of each triangle
 * @returns {{tris: Float32Array, bounds: Float32Array, left: Int32Array, right: Int32Array, first: Int32Array, count: Int32Array}}
 *   `tris` is n * 9 as (v0, e1, e2) in leaf order.
 */
export function buildBVH(tri) {
  const n = tri.length / 9;
  const cen = new Float32Array(n * 3);
  const tb = new Float32Array(n * 6);
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < 3; a++) {
      const v0 = tri[i * 9 + a], v1 = tri[i * 9 + 3 + a], v2 = tri[i * 9 + 6 + a];
      tb[i * 6 + a] = Math.min(v0, v1, v2);
      tb[i * 6 + 3 + a] = Math.max(v0, v1, v2);
      cen[i * 3 + a] = (v0 + v1 + v2) / 3;
    }
  }
  const idx = new Uint32Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  const cap = 2 * n + 1;
  const bounds = new Float32Array(cap * 6);
  const left = new Int32Array(cap), right = new Int32Array(cap), first = new Int32Array(cap), count = new Int32Array(cap);
  let nodes = 1;
  const stack = [[0, 0, n]];
  while (stack.length) {
    const [ni, s, e] = stack.pop();
    const lo = [1e30, 1e30, 1e30], hi = [-1e30, -1e30, -1e30], clo = [1e30, 1e30, 1e30], chi = [-1e30, -1e30, -1e30];
    for (let k = s; k < e; k++) {
      const t = idx[k];
      for (let a = 0; a < 3; a++) {
        if (tb[t * 6 + a] < lo[a]) lo[a] = tb[t * 6 + a];
        if (tb[t * 6 + 3 + a] > hi[a]) hi[a] = tb[t * 6 + 3 + a];
        const c = cen[t * 3 + a];
        if (c < clo[a]) clo[a] = c;
        if (c > chi[a]) chi[a] = c;
      }
    }
    for (let a = 0; a < 3; a++) { bounds[ni * 6 + a] = lo[a]; bounds[ni * 6 + 3 + a] = hi[a]; }
    const ext = [chi[0] - clo[0], chi[1] - clo[1], chi[2] - clo[2]];
    const ax = ext[0] > ext[1] ? (ext[0] > ext[2] ? 0 : 2) : (ext[1] > ext[2] ? 1 : 2);
    if (e - s <= 4 || ext[ax] < 1e-7) {
      first[ni] = s;
      count[ni] = e - s;
      continue;
    }
    idx.subarray(s, e).sort((a, b) => cen[a * 3 + ax] - cen[b * 3 + ax]);
    const mid = (s + e) >> 1;
    const l = nodes++, r = nodes++;
    left[ni] = l;
    right[ni] = r;
    stack.push([l, s, mid], [r, mid, e]);
  }
  const tris = new Float32Array(n * 9);
  for (let k = 0; k < n; k++) {
    const t = idx[k] * 9;
    for (let a = 0; a < 3; a++) {
      tris[k * 9 + a] = tri[t + a];
      tris[k * 9 + 3 + a] = tri[t + 3 + a] - tri[t + a];
      tris[k * 9 + 6 + a] = tri[t + 6 + a] - tri[t + a];
    }
  }
  return { tris, bounds: bounds.slice(0, nodes * 6), left: left.slice(0, nodes), right: right.slice(0, nodes), first: first.slice(0, nodes), count: count.slice(0, nodes) };
}

function makeTracer({ tris, bounds, left, right, first, count }) {
  const stack = new Int32Array(128);
  /** Distance to the nearest hit along (o, d), or tmax when there is none. */
  return function trace(ox, oy, oz, dx, dy, dz, tmax) {
    const ix = 1 / dx, iy = 1 / dy, iz = 1 / dz;
    let t = tmax, sp = 0;
    stack[sp++] = 0;
    while (sp) {
      const ni = stack[--sp];
      const b = ni * 6;
      let t0 = (bounds[b] - ox) * ix, t1 = (bounds[b + 3] - ox) * ix;
      let lo = t0 < t1 ? t0 : t1, hi = t0 < t1 ? t1 : t0;
      t0 = (bounds[b + 1] - oy) * iy; t1 = (bounds[b + 4] - oy) * iy;
      let a = t0 < t1 ? t0 : t1, c = t0 < t1 ? t1 : t0;
      if (a > lo) lo = a;
      if (c < hi) hi = c;
      t0 = (bounds[b + 2] - oz) * iz; t1 = (bounds[b + 5] - oz) * iz;
      a = t0 < t1 ? t0 : t1; c = t0 < t1 ? t1 : t0;
      if (a > lo) lo = a;
      if (c < hi) hi = c;
      if (hi < 0 || lo > hi || lo > t) continue;
      const cn = count[ni];
      if (cn === 0) {
        stack[sp++] = left[ni];
        stack[sp++] = right[ni];
        continue;
      }
      const f = first[ni];
      for (let k = f; k < f + cn; k++) {
        const p = k * 9;
        const e1x = tris[p + 3], e1y = tris[p + 4], e1z = tris[p + 5];
        const e2x = tris[p + 6], e2y = tris[p + 7], e2z = tris[p + 8];
        const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
        const det = e1x * px + e1y * py + e1z * pz;
        if (det > -1e-12 && det < 1e-12) continue;
        const inv = 1 / det;
        const sx = ox - tris[p], sy = oy - tris[p + 1], sz = oz - tris[p + 2];
        const u = (sx * px + sy * py + sz * pz) * inv;
        if (u < 0 || u > 1) continue;
        const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
        const v = (dx * qx + dy * qy + dz * qz) * inv;
        if (v < 0 || u + v > 1) continue;
        const tt = (e2x * qx + e2y * qy + e2z * qz) * inv;
        if (tt > 1e-5 && tt < t) t = tt;
      }
    }
    return t;
  };
}

function hash01(i) {
  let h = (i * 2654435761) | 0;
  h = Math.imul(h ^ (h >>> 15), 2246822519);
  h = Math.imul(h ^ (h >>> 13), 3266489917);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Cosine-weighted directions about +Z (Hammersley). */
function sampleSet(n) {
  const s = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    let b = i, r = 0, f = 0.5;
    while (b) { if (b & 1) r += f; b >>= 1; f *= 0.5; }
    const u = (i + 0.5) / n;
    const rad = Math.sqrt(u), phi = 2 * Math.PI * r;
    s[i * 3] = rad * Math.cos(phi);
    s[i * 3 + 1] = rad * Math.sin(phi);
    s[i * 3 + 2] = Math.sqrt(1 - u);
  }
  return s;
}

function run({ bvh, pos, nrm, list, out, start, end, rays, tmax, bias, twoSided }) {
  const trace = makeTracer(bvh);
  const S = sampleSet(rays);
  const hemi = (i, px, py, pz, nx, ny, nz) => {
    // orthonormal basis about n
    const sgn = nz >= 0 ? 1 : -1;
    const a = -1 / (sgn + nz), b = nx * ny * a;
    const tx = 1 + sgn * nx * nx * a, ty = sgn * b, tz = -sgn * nx;
    const bx = b, by = sgn + ny * ny * a, bz = -ny;
    const rot = hash01(i) * 2 * Math.PI, cr = Math.cos(rot), sr = Math.sin(rot);
    const ox = px + nx * bias, oy = py + ny * bias, oz = pz + nz * bias;
    let occ = 0;
    for (let k = 0; k < rays; k++) {
      const sx = S[k * 3] * cr - S[k * 3 + 1] * sr, sy = S[k * 3] * sr + S[k * 3 + 1] * cr, sz = S[k * 3 + 2];
      let dx = tx * sx + bx * sy + nx * sz, dy = ty * sx + by * sy + ny * sz, dz = tz * sx + bz * sy + nz * sz;
      if (dx === 0) dx = 1e-9;
      if (dy === 0) dy = 1e-9;
      if (dz === 0) dz = 1e-9;
      const t = trace(ox, oy, oz, dx, dy, dz, tmax);
      if (t < tmax) { const f = t / tmax; occ += 1 - f * f; }
    }
    return 1 - occ / rays;
  };
  for (let k = start; k < end; k++) {
    const i = list[k];
    const px = pos[i * 3], py = pos[i * 3 + 1], pz = pos[i * 3 + 2];
    const nx = nrm[i * 3], ny = nrm[i * 3 + 1], nz = nrm[i * 3 + 2];
    let ao = hemi(i, px, py, pz, nx, ny, nz);
    // a face whose normal points into the body (the model is drawn two-sided)
    if (twoSided && ao < 0.12) ao = Math.max(ao, hemi(i + 7919, px, py, pz, -nx, -ny, -nz));
    out[i] = ao;
  }
}

const shared = (a) => {
  const C = a.constructor;
  const s = new C(new SharedArrayBuffer(a.byteLength));
  s.set(a);
  return s;
};

/**
 * Occlusion (1 = open) for the texels in `list`.
 * @param {object} bvh  from buildBVH
 * @param {Float32Array} pos  texel positions (3 per texel)
 * @param {Float32Array} nrm  texel unit normals
 * @param {Uint32Array} list  texel indices to bake
 * @param {{rays?: number, tmax?: number, bias?: number, twoSided?: boolean}} opts
 * @returns {Promise<Float32Array>} one value per texel of pos (uncovered texels stay 1)
 */
export async function bakeAO(bvh, pos, nrm, list, { rays = 64, tmax = 3, bias = 0.004, twoSided = true } = {}) {
  const sb = {};
  for (const k of Object.keys(bvh)) sb[k] = shared(bvh[k]);
  const sp = shared(pos), sn = shared(nrm), sl = shared(list);
  const out = new Float32Array(new SharedArrayBuffer(pos.length / 3 * 4)).fill(1);
  const threads = Math.max(1, Math.min(16, os.cpus().length - 1));
  const chunk = Math.ceil(list.length / threads);
  const jobs = [];
  for (let t = 0; t < threads; t++) {
    const start = t * chunk, end = Math.min(list.length, start + chunk);
    if (start >= end) break;
    jobs.push(new Promise((resolve, reject) => {
      const w = new Worker(new URL(import.meta.url), { workerData: { bvh: sb, pos: sp, nrm: sn, list: sl, out, start, end, rays, tmax, bias, twoSided } });
      w.on('error', reject);
      w.on('exit', (c) => (c === 0 ? resolve() : reject(new Error(`ao worker exit ${c}`))));
    }));
  }
  await Promise.all(jobs);
  return new Float32Array(out);
}

if (!isMainThread && workerData?.bvh) {
  run(workerData);
  parentPort.close();
}
