// Download the CC0 PBR ground textures from Poly Haven and repack them for the
// terrain shader.
//
//   node tools/terrain/fetch-textures.mjs
//
// Per layer, at 1024 px (public/assets/textures/terrain):
//   <name>_col.webp   albedo, sRGB
//   <name>_nrm.jpg    R,G = tangent normal x,y (OpenGL convention)  B = roughness   (4:4:4)
//   <name>_hao.jpg    R = height  G = ambient occlusion                             (4:4:4)
// plus layers.json (order, tile size in metres, mean linear albedo, source).
//
// The runtime packs these into two texture arrays (albedo+height, normal+
// roughness+AO) so the whole set costs two texture bindings.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = join(ROOT, 'public/assets/textures/terrain');
const SIZE = 1024;
const UA = { 'User-Agent': 'terrain-texture-build/1.0' };

// Order is the layer index used by the shader (src/world/terrain/layers.js).
// [textures] scree was dry_ground_rocks (cracked desert mud: read as Arizona,
// not Ladakh); rock_ground_02 is grey-brown gravelly scree. talus (angular
// frost-shattered blocks) is new and appended so the other indices stay put.
const LAYERS = [
  { name: 'scree', id: 'rock_ground_02' },
  { name: 'rock', id: 'rock_face_03' },
  { name: 'strata', id: 'cliff_side' },
  { name: 'snow', id: 'snow_02' },
  { name: 'grass', id: 'grass_ground' },
  { name: 'gravel', id: 'ganges_river_pebbles' },
  { name: 'talus', id: 'gray_rocks' },
];

async function get(url) {
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

const pick = (files, keys) => {
  for (const k of keys) {
    const f = files[k]?.['2k']?.jpg ?? files[k]?.['2k']?.png;
    if (f) return f.url;
  }
  return null;
};

const grey = async (buf) => sharp(buf).resize(SIZE, SIZE, { kernel: 'lanczos3' }).greyscale().raw().toBuffer();
const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

mkdirSync(OUT, { recursive: true });
const manifest = [];
for (const L of LAYERS) {
  const info = JSON.parse((await get(`https://api.polyhaven.com/info/${L.id}`)).toString());
  const files = JSON.parse((await get(`https://api.polyhaven.com/files/${L.id}`)).toString());
  const urls = {
    col: pick(files, ['Diffuse', 'diff', 'Color']),
    nor: pick(files, ['nor_gl']),
    rough: pick(files, ['Rough', 'rough']),
    ao: pick(files, ['AO', 'ao']),
    disp: pick(files, ['Displacement', 'disp']),
  };
  if (!urls.col || !urls.nor || !urls.rough) throw new Error(`${L.id}: missing maps ${JSON.stringify(urls)}`);
  const [col, nor, rough, ao, disp] = await Promise.all(Object.values(urls).map((u) => (u ? get(u) : null)));

  const colRaw = await sharp(col).resize(SIZE, SIZE, { kernel: 'lanczos3' }).removeAlpha().raw().toBuffer();
  const mean = [0, 0, 0];
  for (let i = 0; i < colRaw.length; i += 3) for (let c = 0; c < 3; c++) mean[c] += srgbToLinear(colRaw[i + c] / 255);
  for (let c = 0; c < 3; c++) mean[c] = +(mean[c] / (colRaw.length / 3)).toFixed(4);
  await sharp(colRaw, { raw: { width: SIZE, height: SIZE, channels: 3 } }).webp({ quality: 80, effort: 6 }).toFile(join(OUT, `${L.name}_col.webp`));

  const norRaw = await sharp(nor).resize(SIZE, SIZE, { kernel: 'lanczos3' }).removeAlpha().raw().toBuffer();
  const roughRaw = await grey(rough);
  const nrm = Buffer.alloc(SIZE * SIZE * 3);
  for (let i = 0; i < SIZE * SIZE; i++) {
    nrm[i * 3] = norRaw[i * 3];
    nrm[i * 3 + 1] = norRaw[i * 3 + 1];
    nrm[i * 3 + 2] = roughRaw[i];
  }
  await sharp(nrm, { raw: { width: SIZE, height: SIZE, channels: 3 } }).jpeg({ quality: 80, chromaSubsampling: '4:4:4', mozjpeg: true }).toFile(join(OUT, `${L.name}_nrm.jpg`));

  const aoRaw = ao ? await grey(ao) : Buffer.alloc(SIZE * SIZE, 255);
  let dispRaw = disp ? await grey(disp) : Buffer.alloc(SIZE * SIZE, 128);
  // Stretch height to the full byte range: only its relative shape is used (height blending).
  let lo = 255;
  let hi = 0;
  for (const v of dispRaw) { if (v < lo) lo = v; if (v > hi) hi = v; }
  const hao = Buffer.alloc(SIZE * SIZE * 3);
  for (let i = 0; i < SIZE * SIZE; i++) {
    hao[i * 3] = hi > lo ? Math.round(((dispRaw[i] - lo) / (hi - lo)) * 255) : 128;
    hao[i * 3 + 1] = aoRaw[i];
    hao[i * 3 + 2] = 128;
  }
  await sharp(hao, { raw: { width: SIZE, height: SIZE, channels: 3 } }).jpeg({ quality: 62, chromaSubsampling: '4:4:4', mozjpeg: true }).toFile(join(OUT, `${L.name}_hao.jpg`));

  manifest.push({
    name: L.name,
    source: `https://polyhaven.com/a/${L.id}`,
    id: L.id,
    authors: Object.keys(info.authors ?? {}),
    licence: 'CC0-1.0',
    sizeMetres: +(info.dimensions?.[0] / 1000).toFixed(2),
    meanAlbedoLinear: mean,
  });
  console.log(L.name, L.id, mean, `${(info.dimensions?.[0] / 1000).toFixed(2)} m`);
}
writeFileSync(join(OUT, 'layers.json'), JSON.stringify({ size: SIZE, layers: manifest }, null, 2) + '\n');
