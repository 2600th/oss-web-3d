// Models for hostile units. Each one asks the asset catalogue first
// (`loadModel(id)` from src/assets/catalog.js, the art area's) and falls back
// to a primitive placeholder so gameplay never waits on art. Hostile units are
// unmarked: plain grey / dust / olive, no insignia.
import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { Aircraft } from '../flight/Aircraft.js';
import { tryLoadModel } from '../combat/visuals.js';

const mat = (color, rough = 0.85, metal = 0.1) => new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal });
const M = {
  olive: mat(0x4b4f3a), dark: mat(0x2b2c28, 0.7, 0.4), dust: mat(0x8a7a62), stone: mat(0x77726a, 0.95, 0),
  canvas: mat(0x6f6a52, 0.95, 0), white: mat(0xd8d6cc, 0.5, 0.2), crate: mat(0x5c4a32), wreck: mat(0x15130f, 1, 0),
};

function mesh(geo, material, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(geo, material);
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
const cyl = (r, h, seg = 10) => new THREE.CylinderGeometry(r, r, h, seg);

/** Primitive stand-ins, built roughly to scale (metres), origin on the ground. */
const PLACEHOLDERS = {
  aaa() {
    const g = new THREE.Group();
    g.add(mesh(cyl(2.6, 0.5, 14), M.dust, 0, 0.25, 0));
    g.add(mesh(box(1.6, 1.1, 2.2), M.olive, 0, 1.0, 0));
    const turret = new THREE.Group();
    turret.position.y = 1.5;
    for (const x of [-0.35, 0.35]) {
      const b = mesh(cyl(0.07, 3.2, 6), M.dark, x, 0.9, -1.2);
      b.rotation.x = -Math.PI / 2 + 0.6;
      turret.add(b);
    }
    g.add(turret);
    return g;
  },
  flak() {
    const g = PLACEHOLDERS.aaa();
    g.scale.setScalar(1.5);
    return g;
  },
  sam() {
    const g = new THREE.Group();
    g.add(mesh(box(3, 1.2, 6), M.olive, 0, 0.9, 0));
    for (const x of [-0.8, 0.8]) {
      const r = mesh(cyl(0.22, 5.5, 8), M.white, x, 2.6, 0);
      r.rotation.x = -Math.PI / 2 + 0.75;
      g.add(r);
    }
    return g;
  },
  radar() {
    const g = new THREE.Group();
    g.add(mesh(box(3, 2.2, 5), M.olive, 0, 1.1, 0));
    g.add(mesh(cyl(0.15, 3.5, 6), M.dark, 0, 3.9, 0));
    const dish = mesh(new THREE.SphereGeometry(2.4, 12, 6, 0, Math.PI * 2, 0, Math.PI * 0.35), M.dust, 0, 5.2, 0);
    dish.rotation.x = Math.PI / 2 + 0.3;
    g.add(dish);
    g.userData.spin = dish;
    return g;
  },
  manpads() {
    const g = new THREE.Group();
    g.add(mesh(new THREE.TorusGeometry(1.8, 0.45, 5, 10), M.stone, 0, 0.35, 0).rotateX(Math.PI / 2));
    const tube = mesh(cyl(0.09, 1.6, 6), M.olive, 0, 1.5, 0);
    tube.rotation.x = -0.9;
    g.add(tube);
    g.add(mesh(new THREE.CapsuleGeometry(0.28, 0.9, 3, 6), M.canvas, 0.3, 0.9, 0.2));
    return g;
  },
  bunker() {
    const g = new THREE.Group();
    g.add(mesh(box(9, 2.6, 7), M.stone, 0, 1.2, 0));
    g.add(mesh(box(10, 0.6, 8), M.dust, 0, 2.7, 0));
    g.add(mesh(box(3, 0.5, 0.4), M.dark, 0, 1.7, -3.55));
    return g;
  },
  sangar() {
    const g = new THREE.Group();
    g.add(mesh(new THREE.CylinderGeometry(3.2, 3.6, 1.5, 9, 1, true), M.stone, 0, 0.75, 0));
    g.add(mesh(box(2.4, 0.25, 2.4), M.canvas, 0, 1.7, 0));
    return g;
  },
  supply() {
    const g = new THREE.Group();
    g.add(mesh(box(4, 2, 3), M.crate, -2, 1, 0));
    g.add(mesh(box(3, 1.4, 3), M.crate, 2, 0.7, 1));
    g.add(mesh(box(2.5, 1.2, 2), M.crate, -1.6, 2.6, 0));
    for (let i = 0; i < 5; i++) g.add(mesh(cyl(0.45, 1.2, 8), M.dark, 3 + (i % 3) * 1.0, 0.6, -2.5 + Math.floor(i / 3) * 1.0));
    g.add(mesh(new THREE.ConeGeometry(3.6, 2.2, 4), M.canvas, -1, 4.0, 0).rotateY(Math.PI / 4));
    return g;
  },
  tent() {
    const g = new THREE.Group();
    const t = mesh(new THREE.CylinderGeometry(0.01, 2.6, 2.3, 4), M.canvas, 0, 1.15, 0);
    t.rotation.y = Math.PI / 4;
    t.scale.z = 1.6;
    g.add(t);
    return g;
  },
  truck() {
    const g = new THREE.Group();
    g.add(mesh(box(2.3, 1.0, 6.5), M.dark, 0, 0.9, 0));
    g.add(mesh(box(2.2, 1.4, 1.8), M.olive, 0, 2.0, -2.2));
    g.add(mesh(box(2.3, 1.7, 4.2), M.canvas, 0, 2.2, 1.1));
    return g;
  },
  post() {
    // Observation post (recon target): hut, mast, drums.
    const g = new THREE.Group();
    g.add(mesh(box(6, 2.4, 4), M.stone, 0, 1.2, 0));
    const roof = mesh(new THREE.CylinderGeometry(0.01, 3.2, 1.6, 4), M.canvas, 0, 3.2, 0);
    roof.rotation.y = Math.PI / 4;
    roof.scale.x = 1.5;
    g.add(roof);
    g.add(mesh(cyl(0.08, 9, 5), M.dark, 4, 4.5, 2));
    for (let i = 0; i < 4; i++) g.add(mesh(cyl(0.45, 1.2, 8), M.dark, -4.5, 0.6, -1.6 + i * 1.1));
    return g;
  },
};

const ASSET_IDS = {
  aaa: 'aaa_gun', flak: 'aaa_gun', sam: 'sam_launcher', radar: 'radar', truck: 'truck',
  bunker: 'bunker', sangar: 'bunker', tent: 'tent', supply: 'supply_dump',
};

const cache = new Map();

/** A fresh Object3D for a ground unit type. */
export async function groundModel(type) {
  if (!cache.has(type)) {
    const id = ASSET_IDS[type];
    cache.set(type, id ? tryLoadModel(id) : Promise.resolve(null));
  }
  const src = await cache.get(type);
  if (src) return src.clone();
  return (PLACEHOLDERS[type] ?? PLACEHOLDERS.bunker)();
}

/** Blacken a destroyed unit in place (the wreck stays as a landmark). */
export function wreck(object3d, flatten = 0.7) {
  object3d.traverse((o) => { if (o.isMesh) o.material = M.wreck; });
  object3d.scale.y *= flatten;
}

// ---- base kit (public/assets/bases) ----------------------------------------

let gltfLoader = null;
const baseCache = new Map();
export function loadBaseKit(id, lod = 1) {
  const url = `./assets/bases/${id}-lod${lod}.glb`;
  if (!baseCache.has(url)) {
    gltfLoader ??= new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
    baseCache.set(url, gltfLoader.loadAsync(url).then((g) => {
      g.scene.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
      return g.scene;
    }).catch((e) => { console.warn('[ai] base kit failed', url, e); return null; }));
  }
  return baseCache.get(url).then((s) => s?.clone() ?? null);
}

// ---- hostile fighter --------------------------------------------------------

let hostileTemplate = null;

/**
 * Hostile airframe. Uses `mig21_hostile` when the art area has delivered it;
 * otherwise clones the player's airframe and repaints it flat air-superiority
 * grey — the texture (which carries the player's markings) is dropped, so the
 * placeholder carries no insignia at all.
 */
async function buildHostileTemplate() {
  const fromCatalog = await tryLoadModel('mig21_hostile');
  if (fromCatalog) return fromCatalog;
  const ac = new Aircraft();
  await ac.load();
  const greys = [0x7d8388, 0x6b7076, 0x868b86];
  let i = 0;
  const repainted = new Map();
  ac.model.traverse((o) => {
    if (!o.isMesh) return;
    const src = o.material;
    if (!repainted.has(src)) {
      const m = src.clone();
      m.map = null;
      m.emissiveMap = null;
      m.color = new THREE.Color(greys[i++ % greys.length]);
      m.roughness = 0.62;
      m.metalness = 0.35;
      repainted.set(src, m);
    }
    o.material = repainted.get(src);
  });
  return ac.model;
}

export async function hostileFighterModel() {
  hostileTemplate ??= buildHostileTemplate();
  const src = await hostileTemplate;
  const g = new THREE.Group();
  g.name = 'hostile-aircraft';
  g.add(src.clone());
  return g;
}

/** Preload so the first spawn in a sortie does not hitch. */
export function preloadModels() {
  hostileTemplate ??= buildHostileTemplate();
  return hostileTemplate;
}
