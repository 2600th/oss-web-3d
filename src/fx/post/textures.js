import * as THREE from 'three/webgpu';

/**
 * Procedural lens textures, generated once at boot (no asset download):
 *  - lens dirt: dust specks and soft smudges, revealed by bloom and the sun
 *  - lens droplets: tileable refraction map for the in-cloud / wet lens state
 * Seeded so every run looks the same.
 */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createLensDirtTexture(w = 512, h = 288, seed = 1999) {
  const r = rng(seed);
  const f = new Float32Array(w * h * 3);
  const splat = (cx, cy, rad, k, tint, ring = 0) => {
    const x0 = Math.max(0, Math.floor(cx - rad)), x1 = Math.min(w - 1, Math.ceil(cx + rad));
    const y0 = Math.max(0, Math.floor(cy - rad)), y1 = Math.min(h - 1, Math.ceil(cy + rad));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const d = Math.hypot(x - cx, y - cy) / rad;
        if (d >= 1) continue;
        // soft disc, optionally brighter at the rim (dried droplet)
        let v = Math.pow(1 - d * d, 1.5);
        if (ring) v = v * (1 - ring) + ring * Math.exp(-Math.pow((d - 0.85) / 0.1, 2));
        v *= k;
        const i = (y * w + x) * 3;
        f[i] += v * tint[0]; f[i + 1] += v * tint[1]; f[i + 2] += v * tint[2];
      }
    }
  };
  // broad smudges (fingerprint haze)
  for (let i = 0; i < 14; i++) splat(r() * w, r() * h, 30 + r() * 70, 0.05 + r() * 0.06, [1, 0.97, 0.92]);
  // dust specks
  for (let i = 0; i < 260; i++) {
    const big = r() < 0.12;
    const t = 0.9 + r() * 0.1;
    splat(r() * w, r() * h, big ? 5 + r() * 12 : 1 + r() * 3.5, big ? 0.18 + r() * 0.25 : 0.25 + r() * 0.5, [t, t * (0.95 + r() * 0.05), t * (0.9 + r() * 0.1)], big && r() < 0.5 ? 0.6 : 0);
  }
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    for (let c = 0; c < 3; c++) data[i * 4 + c] = Math.min(255, Math.round(Math.min(1, f[i * 3 + c]) * 255));
    data[i * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  tex.name = 'LensDirt';
  return tex;
}

/** RG = refraction offset (0.5 = none), B = coverage, A = highlight. Tileable. */
export function createDropletTexture(size = 256, seed = 7) {
  const r = rng(seed);
  const ox = new Float32Array(size * size);
  const oy = new Float32Array(size * size);
  const cov = new Float32Array(size * size);
  const hi = new Float32Array(size * size);
  const drop = (cx, cy, rad, stretch) => {
    const R = Math.ceil(rad * stretch) + 1;
    for (let dy = -R; dy <= R; dy++) {
      for (let dx = -Math.ceil(rad) - 1; dx <= Math.ceil(rad) + 1; dx++) {
        const nx = dx / rad, ny = dy / (rad * stretch);
        const d2 = nx * nx + ny * ny;
        if (d2 >= 1) continue;
        const x = ((Math.round(cx) + dx) % size + size) % size;
        const y = ((Math.round(cy) + dy) % size + size) % size;
        const i = y * size + x;
        const h = Math.sqrt(1 - d2);
        if (h < cov[i]) continue;
        cov[i] = h;
        ox[i] = -nx * 0.9; oy[i] = -ny * 0.9; // a lens: inverts what is behind it
        hi[i] = Math.max(0, 1 - Math.hypot(nx + 0.35, ny + 0.4) / 0.35);
      }
    }
  };
  for (let i = 0; i < 380; i++) drop(r() * size, r() * size, 0.8 + r() * 1.6, 1);
  for (let i = 0; i < 70; i++) drop(r() * size, r() * size, 2.5 + r() * 5.5, 1 + r() * 0.5);
  const data = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    data[i * 4] = Math.round((0.5 + 0.5 * ox[i]) * 255);
    data[i * 4 + 1] = Math.round((0.5 + 0.5 * oy[i]) * 255);
    data[i * 4 + 2] = Math.round(Math.min(1, cov[i] * 1.6) * 255);
    data[i * 4 + 3] = Math.round(hi[i] * 255);
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  tex.name = 'LensDroplets';
  return tex;
}

/**
 * Frost / rime texture for the ice rim (cold cloud at altitude). Tileable,
 * R = frost density (ridged fbm: feathery crystal fronts), G = sparkle mask.
 */
export function createFrostTexture(size = 256, seed = 41) {
  const r = rng(seed);
  const G = 32;
  const grid = new Float32Array(G * G);
  for (let i = 0; i < grid.length; i++) grid[i] = r();
  const vnoise = (x, y, f) => {
    // periodic value noise at frequency f (cells per tile)
    const gx = (x / size) * f, gy = (y / size) * f;
    const x0 = Math.floor(gx), y0 = Math.floor(gy);
    const tx = gx - x0, ty = gy - y0;
    const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
    const at = (i, j) => grid[(((j % f) + f) % f) * G + (((i % f) + f) % f)];
    const a = at(x0, y0), b = at(x0 + 1, y0), c = at(x0, y0 + 1), d = at(x0 + 1, y0 + 1);
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
  };
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let v = 0, amp = 0.55;
      for (const f of [4, 8, 16, 32]) {
        const n = vnoise(x, y, Math.min(f, G));
        v += (1 - Math.abs(n * 2 - 1)) * amp; // ridged: thin bright fronts
        amp *= 0.55;
      }
      v = Math.pow(Math.min(1, v / 1.05), 2.2);
      const sparkle = r() < 0.004 ? 1 : 0;
      const i = (y * size + x) * 4;
      data[i] = Math.round(v * 255);
      data[i + 1] = sparkle * 255;
      data[i + 2] = 0;
      data[i + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  tex.name = 'Frost';
  return tex;
}
