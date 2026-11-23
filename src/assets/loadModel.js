import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { CATALOG } from './catalog.js';
import { upgradeAircraftMaterials, upgradeGroundMaterials } from './materials.js';

/**
 * Asset loading for everything in src/assets/catalog.js.
 *
 *   const gun = await loadModel('aaa_gun');            // LOD0 clone
 *   const far = await loadModel('aaa_gun', { lod: 1 });
 *   const wreck = await loadModel('truck', { burned: true }); // charred material recipe
 *   gun.getObjectByName('turret').rotation.y = yaw;      // pivots: see catalog `pivots`
 *   gun.getObjectByName('barrels').rotation.x = pitch;  // + = elevate
 *   const muzzle = gun.userData.sockets.muzzle_L;      // Object3D, world via getWorldPosition
 *
 * Every model is in metres, +Y up, front toward -Z, origin on the ground
 * (ground units) or at the body centre (aircraft, weapons). Clones share
 * geometry and materials with a cached template, so treat materials as
 * read-only (clone one before tinting a single instance).
 */

let loader = null;
const gltfCache = new Map(); // absolute url -> Promise<GLTF>
const templateCache = new Map(); // `${id}|${lod}` -> Promise<Object3D>
const burnedMaterials = new WeakMap();

function getLoader() {
  if (!loader) {
    loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
  }
  return loader;
}

export function resolveAssetUrl(url) {
  const base = typeof document !== 'undefined' ? document.baseURI : 'http://localhost/';
  return new URL(url, base).href;
}

function loadGLTF(url) {
  const abs = resolveAssetUrl(url);
  if (!gltfCache.has(abs)) gltfCache.set(abs, getLoader().loadAsync(abs));
  return gltfCache.get(abs);
}

export function getEntry(id) {
  const e = CATALOG[id];
  if (!e) throw new Error(`loadModel: unknown asset id "${id}"`);
  return e;
}

/** Same normalisation as src/flight/Aircraft.js: centre, scale longest axis, nose to -Z. */
function normalise(root, { length, sourceForward }) {
  root.updateWorldMatrix(true, true);
  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  const centre = box.getCenter(new THREE.Vector3());
  const holder = new THREE.Group();
  holder.name = 'normalised';
  root.position.sub(centre);
  holder.add(root);
  const axes = [['x', size.x], ['y', size.y], ['z', size.z]].sort((a, b) => b[1] - a[1]);
  if (axes[0][0] === 'y') holder.rotateX(-Math.PI / 2);
  else if (axes[0][0] === 'x') holder.rotateY(Math.PI / 2);
  holder.scale.setScalar(length / axes[0][1]);
  if (sourceForward === '+Z') holder.rotateY(Math.PI);
  return holder;
}

async function buildTemplate(id, lod) {
  const entry = getEntry(id);
  const lods = entry.lods?.length ? entry.lods : [{ url: entry.url }];
  const level = lods[Math.max(0, Math.min(lod, lods.length - 1))];
  const gltf = await loadGLTF(level.url);
  let content = gltf.scene.clone(true);
  if (entry.normalize) content = normalise(content, entry.normalize);
  const root = new THREE.Group();
  root.name = id;
  root.add(content);
  // sockets the GLB does not carry as nodes (MiG family)
  if (entry.socketPositions) {
    for (const [name, p] of Object.entries(entry.socketPositions)) {
      if (root.getObjectByName(name)) continue;
      const s = new THREE.Object3D();
      s.name = name;
      s.position.fromArray(p);
      root.add(s);
    }
  }
  root.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = true;
    o.receiveShadow = true;
  });
  root.userData.assetId = id;
  root.userData.lod = lods.indexOf(level);
  return root;
}

function getTemplate(id, lod) {
  const key = `${id}|${lod}`;
  if (!templateCache.has(key)) templateCache.set(key, buildTemplate(id, lod));
  return templateCache.get(key);
}

/** Charred/burned material recipe (shared per source material). */
export function burnedMaterial(m) {
  if (!m) return m;
  let b = burnedMaterials.get(m);
  if (!b) {
    b = m.clone();
    b.name = `${m.name || 'mat'}_burned`;
    if (b.color) b.color.multiplyScalar(0.1).lerp(new THREE.Color(0.035, 0.03, 0.026), 0.5);
    if ('roughness' in b) b.roughness = 1;
    if ('metalness' in b) b.metalness = Math.min(b.metalness ?? 0, 0.25);
    if (b.emissive) b.emissive.setRGB(0, 0, 0);
    b.emissiveMap = null;
    b.userData.burned = true;
    burnedMaterials.set(m, b);
  }
  return b;
}

function collectSockets(obj, entry) {
  const sockets = {};
  for (const name of entry.sockets ?? []) {
    const s = obj.getObjectByName(name);
    if (s) sockets[name] = s;
  }
  return sockets;
}

/**
 * @param {string} id catalog id
 * @param {{lod?: number, burned?: boolean, castShadow?: boolean, receiveShadow?: boolean}} [opts]
 * @returns {Promise<THREE.Object3D>} a fresh clone (geometry/materials shared)
 */
export async function loadModel(id, { lod = 0, burned = false, castShadow = true, receiveShadow = true } = {}) {
  const entry = getEntry(id);
  const template = await getTemplate(id, lod);
  const obj = template.clone(true);
  obj.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = castShadow;
    o.receiveShadow = receiveShadow;
    if (burned) o.material = Array.isArray(o.material) ? o.material.map(burnedMaterial) : burnedMaterial(o.material);
  });
  // Node-material recipes (memoised per source material, so clones still share).
  if (config.materials) {
    if (entry.kind === 'aircraft') upgradeAircraftMaterials(obj, { tier: config.tier, role: id === 'mig21' ? 'player' : 'hostile', env: config.env });
    else if (entry.kind !== 'cockpit') upgradeGroundMaterials(obj, { tier: config.tier, env: config.env });
    if (!castShadow) obj.traverse((o) => { if (o.isMesh) o.castShadow = false; });
  }
  obj.userData = { ...template.userData, sockets: collectSockets(obj, entry), burned };
  return obj;
}

/**
 * Runtime context for the material recipes (src/assets/materials.js): quality
 * tier and the Environment (cloud shadows). Set by the assets system at init;
 * until then (or with `materials: false`) models keep their GLB materials.
 */
const config = { tier: 'high', env: null, materials: true };
export function configureAssets({ tier, env, materials } = {}) {
  if (tier) config.tier = tier;
  if (env) config.env = env;
  if (materials !== undefined) config.materials = materials;
  return config;
}

/**
 * THREE.LOD with every level of an asset, switching at the catalog
 * `distance` values (metres). Single-level assets return a LOD with one level.
 */
export async function loadModelLOD(id, opts = {}) {
  const entry = getEntry(id);
  const levels = entry.lods ?? [{ url: entry.url }];
  const lod = new THREE.LOD();
  lod.name = `${id}_lod`;
  const objs = await Promise.all(levels.map((_, i) => loadModel(id, { ...opts, lod: i })));
  objs.forEach((o, i) => {
    const d = levels[i].distance ?? (levels[i].projectedSize != null ? [0, 600, 1500][i] ?? 1500 : i * 250);
    lod.addLevel(o, d);
  });
  lod.userData = { assetId: id, sockets: objs[0].userData.sockets };
  return lod;
}

/** Fetch + parse ahead of time (e.g. during a loading screen). */
export function preloadModels(ids, { lods = [0] } = {}) {
  return Promise.all(ids.flatMap((id) => lods.map((lod) => getTemplate(id, lod))));
}

export { CATALOG };
