import * as THREE from 'three/webgpu';

// PBR ground layers (CC0, Poly Haven; fetched by tools/terrain/fetch-textures.mjs).
// All layers live in two texture arrays so the set costs two bindings:
//   albedo  RGBA8 sRGB   rgb = albedo, a = height (for height blending)
//   nrm     RGBA8        r,g = tangent normal x,y; b = roughness; a = ambient occlusion
//
// `mean` is the layer's mean linear albedo. The shader divides it out and
// multiplies by its own palette, so the textures supply detail and the palette
// supplies Ladakh's colours.
//
// [textures] scree is rock_ground_02 (grey-brown gravelly scree; it was
// dry_ground_rocks, a cracked desert mud), talus (gray_rocks, angular
// frost-shattered blocks) is new. Means and sizes from layers.json. The
// ground-cover layers (scree, grass, gravel, talus) have their tile-scale
// blotches flattened at build time (fetch-textures.mjs `flatten`) so they do
// not repeat as a lattice.
export const LAYERS = [
  { name: 'scree', size: 3.0, mean: [0.2198, 0.1897, 0.1395] },
  { name: 'rock', size: 2.7, mean: [0.2326, 0.1456, 0.0837] },
  { name: 'strata', size: 1.83, mean: [0.213, 0.0918, 0.034] },
  { name: 'snow', size: 2.0, mean: [0.3791, 0.3785, 0.3886] },
  { name: 'grass', size: 2.51, mean: [0.16, 0.1197, 0.0498] },
  { name: 'gravel', size: 2.16, mean: [0.2421, 0.2041, 0.1624] },
  { name: 'talus', size: 1.8, mean: [0.2039, 0.1803, 0.1438] },
];
export const LAYER = Object.fromEntries(LAYERS.map((l, i) => [l.name, i]));

const linearToSrgb = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);

function arrayTex(size, count, colorSpace, aniso) {
  const t = new THREE.DataArrayTexture(new Uint8Array(size * size * 4 * count), size, size, count);
  t.format = THREE.RGBAFormat;
  t.type = THREE.UnsignedByteType;
  t.colorSpace = colorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = aniso;
  return t;
}

export class TerrainLayers {
  /** size: per-layer resolution (source is 1024; lower tiers downscale at decode). */
  constructor({ size = 1024, aniso = 8 } = {}) {
    this.size = size;
    this.count = LAYERS.length;
    this.albedo = arrayTex(size, this.count, THREE.SRGBColorSpace, aniso);
    this.nrm = arrayTex(size, this.count, THREE.NoColorSpace, aniso);
    // Until the images arrive every layer is its own mean colour, flat and rough.
    const a = this.albedo.image.data;
    const n = this.nrm.image.data;
    const px = size * size;
    LAYERS.forEach((L, i) => {
      const c = L.mean.map((v) => Math.round(linearToSrgb(v) * 255));
      for (let k = i * px * 4, e = (i + 1) * px * 4; k < e; k += 4) {
        a[k] = c[0]; a[k + 1] = c[1]; a[k + 2] = c[2]; a[k + 3] = 128;
        n[k] = 128; n[k + 1] = 128; n[k + 2] = 220; n[k + 3] = 255;
      }
    });
    this.albedo.needsUpdate = true;
    this.nrm.needsUpdate = true;
    this.loaded = false;
  }

  async load(base = './assets/textures/terrain/') {
    const size = this.size;
    const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(size, size) : Object.assign(document.createElement('canvas'), { width: size, height: size });
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const pixels = async (file) => {
      const res = await fetch(base + file);
      if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
      const bmp = await createImageBitmap(await res.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(bmp, 0, 0, size, size);
      bmp.close?.();
      return ctx.getImageData(0, 0, size, size).data;
    };
    const a = this.albedo.image.data;
    const n = this.nrm.image.data;
    const px = size * size;
    let bytes = 0;
    for (let i = 0; i < LAYERS.length; i++) {
      const name = LAYERS[i].name;
      // Sequential on purpose: one shared canvas, and the images are small.
      const col = await pixels(`${name}_col.webp`);
      const o = i * px * 4;
      for (let k = 0; k < px * 4; k += 4) { a[o + k] = col[k]; a[o + k + 1] = col[k + 1]; a[o + k + 2] = col[k + 2]; }
      const nr = await pixels(`${name}_nrm.jpg`);
      for (let k = 0; k < px * 4; k += 4) { n[o + k] = nr[k]; n[o + k + 1] = nr[k + 1]; n[o + k + 2] = nr[k + 2]; }
      const hao = await pixels(`${name}_hao.jpg`);
      for (let k = 0; k < px * 4; k += 4) { a[o + k + 3] = hao[k]; n[o + k + 3] = hao[k + 1]; }
      bytes += px * 8;
    }
    this.albedo.needsUpdate = true;
    this.nrm.needsUpdate = true;
    this.loaded = true;
    return bytes;
  }

  dispose() {
    this.albedo.dispose();
    this.nrm.dispose();
  }
}
