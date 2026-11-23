import * as THREE from 'three/webgpu';
import { TILE_SIZE } from './detail.js';

// GPU textures derived from the terrain pack at load.
//
//   height  R32F  res^2    heights (m), read with textureLoad + manual bilinear
//   outer   R32F           coarse surrounding DEM, same treatment
//   amp     R8    res/2    sub-DEM displacement amplitude (hardware bilinear)
//   tile    RGBA8 512^2    detail tile: R,G = slope along u,v; B,A = height hi/lo byte
//   surf    RGBA8 res^2    R,G = DEM normal x,z; B = sky visibility; A = curvature
//   river   RGBA8 res^2    R = bank distance; G,B = flow direction; A = vegetation
//   outerSurf RGBA8        R,G = outer DEM normal x,z; B = sky visibility
//
// Everything a pixel needs about the land at DEM scale comes from `surf` and
// `river` through mipmapped, anisotropic samplers, so distant terrain is
// filtered instead of aliasing.

/** Slope range stored in the tile's R,G channels: byte 0..255 -> -TILE_SLOPE..+TILE_SLOPE per texel. */
export const TILE_SLOPE = 0.25;
/** Curvature range: byte 0..255 -> -1..+1 where 1 = CURV_RANGE metres of relief per metre. */
export const CURV_RANGE = 0.35;

const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

function dataTex(data, w, h, format, type, { linear = false, mips = false, repeat = false, aniso = 1 } = {}) {
  const t = new THREE.DataTexture(data, w, h, format, type);
  t.magFilter = linear ? THREE.LinearFilter : THREE.NearestFilter;
  t.minFilter = mips ? THREE.LinearMipmapLinearFilter : t.magFilter;
  t.generateMipmaps = mips;
  t.wrapS = t.wrapT = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  t.anisotropy = aniso;
  t.colorSpace = THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

function normalsInto(out, stride, H, w, h, cellX, cellZ) {
  for (let j = 0; j < h; j++) {
    const j0 = Math.max(0, j - 1);
    const j1 = Math.min(h - 1, j + 1);
    for (let i = 0; i < w; i++) {
      const i0 = Math.max(0, i - 1);
      const i1 = Math.min(w - 1, i + 1);
      const dx = (H[j * w + i1] - H[j * w + i0]) / ((i1 - i0) * cellX);
      const dz = (H[j1 * w + i] - H[j0 * w + i]) / ((j1 - j0) * cellZ);
      const inv = 1 / Math.sqrt(dx * dx + dz * dz + 1);
      const k = (j * w + i) * stride;
      out[k] = Math.round(127.5 - 127.5 * dx * inv);
      out[k + 1] = Math.round(127.5 - 127.5 * dz * inv);
    }
  }
}

/** Separable box blur of a float field (edge-clamped), in place. */
function boxBlur(f, n, radius, passes = 2) {
  const tmp = new Float32Array(n);
  const w = 2 * radius + 1;
  for (let p = 0; p < passes; p++) {
    for (let pass = 0; pass < 2; pass++) {
      const stride = pass === 0 ? 1 : n;
      const lines = n;
      for (let l = 0; l < lines; l++) {
        const base = pass === 0 ? l * n : l;
        let acc = 0;
        for (let a = -radius; a <= radius; a++) acc += f[base + Math.min(n - 1, Math.max(0, a)) * stride];
        for (let i = 0; i < n; i++) {
          tmp[i] = acc / w;
          acc += f[base + Math.min(n - 1, i + radius + 1) * stride] - f[base + Math.max(0, i - radius) * stride];
        }
        for (let i = 0; i < n; i++) f[base + i * stride] = tmp[i];
      }
    }
  }
}

export function buildTerrainTextures(DEM, { aniso = 8 } = {}) {
  const n = DEM.res;
  const H = DEM.data;
  const P = DEM.planes;
  const m = DEM.ampRes;
  const out = {};

  out.height = dataTex(H, n, n, THREE.RedFormat, THREE.FloatType);
  out.outer = dataTex(DEM.outer, DEM.outerW, DEM.outerH, THREE.RedFormat, THREE.FloatType);
  out.amp = dataTex(DEM.amp, m, m, THREE.RedFormat, THREE.UnsignedByteType, { linear: true });

  // --- detail tile
  {
    const T = TILE_SIZE;
    const src = P.tile.data;
    const f = DEM.tile;
    const px = new Uint8Array(T * T * 4);
    const M = T - 1;
    for (let j = 0; j < T; j++) for (let i = 0; i < T; i++) {
      const k = j * T + i;
      const du = (f[j * T + ((i + 1) & M)] - f[j * T + ((i - 1) & M)]) * 0.5;
      const dv = (f[((j + 1) & M) * T + i] - f[((j - 1) & M) * T + i]) * 0.5;
      px[k * 4] = Math.min(255, Math.max(0, Math.round(127.5 + (du / TILE_SLOPE) * 127.5)));
      px[k * 4 + 1] = Math.min(255, Math.max(0, Math.round(127.5 + (dv / TILE_SLOPE) * 127.5)));
      px[k * 4 + 2] = src[k] >> 8;
      px[k * 4 + 3] = src[k] & 255;
    }
    out.tile = dataTex(px, T, T, THREE.RGBAFormat, THREE.UnsignedByteType, { linear: true, mips: true, repeat: true, aniso });
  }

  // --- surface: normal, sky visibility, curvature
  const surf = new Uint8Array(n * n * 4);
  normalsInto(surf, 4, H, n, n, DEM.cellX, DEM.cellZ);
  const ao = P.ao.data;
  const R = 3; // curvature footprint in texels
  const curvScale = 1 / (CURV_RANGE * R * Math.max(DEM.cellX, DEM.cellZ));
  for (let j = 0; j < n; j++) {
    const jm = Math.max(0, j - R) * n;
    const jp = Math.min(n - 1, j + R) * n;
    const fj = Math.min(m - 1.001, j * 0.5);
    const aj = Math.floor(fj);
    const tj = fj - aj;
    for (let i = 0; i < n; i++) {
      const im = Math.max(0, i - R);
      const ip = Math.min(n - 1, i + R);
      const k = j * n + i;
      const ring = (H[jm + i] + H[jp + i] + H[j * n + im] + H[j * n + ip]) * 0.25;
      const fi = Math.min(m - 1.001, i * 0.5);
      const ai = Math.floor(fi);
      const ti = fi - ai;
      const a = aj * m + ai;
      const top = ao[a] + (ao[a + 1] - ao[a]) * ti;
      const bot = ao[a + m] + (ao[a + m + 1] - ao[a + m]) * ti;
      surf[k * 4 + 2] = Math.round(top + (bot - top) * tj);
      // > 0.5 = hollow (the ring around is higher), < 0.5 = ridge
      surf[k * 4 + 3] = Math.min(255, Math.max(0, Math.round(127.5 + 127.5 * (ring - H[k]) * curvScale)));
    }
  }
  out.surf = dataTex(surf, n, n, THREE.RGBAFormat, THREE.UnsignedByteType, { linear: true, mips: true, aniso });

  // --- rivers: bank distance, flow direction, vegetation
  {
    // Riparian mask: river presence spread ~350 m sideways on the half-res grid.
    const near = new Float32Array(m * m);
    const sdf = DEM.river;
    for (let j = 0; j < m; j++) for (let i = 0; i < m; i++) {
      near[j * m + i] = sdf[j * 2 * n + i * 2] * DEM.riverStep + DEM.riverMin < 12 ? 1 : 0;
    }
    boxBlur(near, m, Math.max(2, Math.round(190 / (DEM.cellX * 2))), 2);
    const drain = P.drain.data;
    const dMin = DEM.meta.drain.log10Min;
    const dMax = DEM.meta.drain.log10Max;
    const veg = new Float32Array(m * m);
    for (let j = 0; j < m; j++) for (let i = 0; i < m; i++) {
      const k = j * 2 * n + i * 2;
      const nx = surf[k * 4] / 127.5 - 1;
      const nz = surf[k * 4 + 1] / 127.5 - 1;
      const ny = Math.sqrt(Math.max(1e-4, 1 - nx * nx - nz * nz));
      const tan = Math.sqrt(nx * nx + nz * nz) / ny;
      const alt = H[k];
      const km2 = drain[j * m + i] > 0 ? 10 ** (dMin + (drain[j * m + i] / 255) * (dMax - dMin)) : 0;
      // valley floors beside the rivers (irrigated oases), thinning with height
      const oasis = Math.min(1, near[j * m + i] * 3.2) * (1 - smooth(0.16, 0.42, tan)) * (1 - smooth(3150, 3900, alt));
      // seepage lines down the side nallahs
      const seep = smooth(1.5, 12, km2) * 0.5 * (1 - smooth(0.3, 0.7, tan)) * (1 - smooth(3600, 4500, alt));
      veg[j * m + i] = Math.max(oasis, seep);
    }
    boxBlur(veg, m, 1, 1);
    const fx = P.flowx.data;
    const fz = P.flowz.data;
    const riv = new Uint8Array(n * n * 4);
    for (let j = 0; j < n; j++) {
      const hj = Math.min(m - 1, Math.round(j * 0.5));
      for (let i = 0; i < n; i++) {
        const hi = Math.min(m - 1, Math.round(i * 0.5));
        const k = (j * n + i) * 4;
        riv[k] = sdf[j * n + i];
        riv[k + 1] = fx[hj * m + hi];
        riv[k + 2] = fz[hj * m + hi];
        riv[k + 3] = Math.round(veg[hj * m + hi] * 255);
      }
    }
    out.river = dataTex(riv, n, n, THREE.RGBAFormat, THREE.UnsignedByteType, { linear: true, mips: true, aniso: Math.min(aniso, 4) });
  }

  // --- outer DEM surface
  {
    const w = DEM.outerW;
    const h = DEM.outerH;
    const px = new Uint8Array(w * h * 4);
    const cx = (DEM.outerMaxX - DEM.outerMinX) / (w - 1);
    const cz = (DEM.outerMaxZ - DEM.outerMinZ) / (h - 1);
    normalsInto(px, 4, DEM.outer, w, h, cx, cz);
    // Cheap sky visibility for the outer field: how far a texel sits below its neighbourhood.
    const O = DEM.outer;
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      let hi = 0;
      for (const [a, b] of [[6, 0], [-6, 0], [0, 6], [0, -6], [14, 0], [-14, 0], [0, 14], [0, -14]]) {
        const v = O[Math.min(h - 1, Math.max(0, j + b)) * w + Math.min(w - 1, Math.max(0, i + a))] - O[j * w + i];
        const t = Math.max(0, v) / (Math.hypot(a * cx, b * cz));
        hi += 1 / (1 + t * t);
      }
      px[(j * w + i) * 4 + 2] = Math.round((hi / 8) * 255);
      px[(j * w + i) * 4 + 3] = 128;
    }
    out.outerSurf = dataTex(px, w, h, THREE.RGBAFormat, THREE.UnsignedByteType, { linear: true, mips: true, aniso: Math.min(aniso, 4) });
  }
  return out;
}
