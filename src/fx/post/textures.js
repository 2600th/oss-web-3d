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
