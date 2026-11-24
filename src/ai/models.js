// Models for hostile units. Each one asks the asset catalogue first
// (`loadModel(id)` from src/assets/catalog.js, the art area's) and falls back
// to a primitive placeholder so gameplay never waits on art. Hostile units are
// unmarked: plain grey / dust / olive, no insignia.
import * as THREE from 'three/webgpu';
import { Aircraft } from '../flight/Aircraft.js';
import { tryLoadModel } from '../combat/visuals.js';
import { CATALOG } from '../assets/catalog.js';

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
  aaa: 'aaa_gun', flak: 'artillery', sam: 'sam_launcher', radar: 'radar', manpads: 'manpads_team', truck: 'truck_covered',
  bunker: 'bunker', sangar: 'sangar', tent: 'tent', supply: 'supply_dump',
};
const DESTROYED_IDS = { aaa: 'aaa_gun_destroyed', flak: 'artillery_destroyed', sam: 'sam_launcher_destroyed', radar: 'radar_destroyed', truck: 'truck_destroyed', bunker: 'bunker_destroyed' };

// ---- distance LOD ------------------------------------------------------------

/** Animated nodes kept in step across LOD levels (plus each asset's catalog `pivots`). */
const SYNC_NODES = ['turret', 'barrels', 'barrel', 'launcher', 'dish'];
/** Field of view (deg, vertical) the catalog switch distances are meant for. */
const LOD_REF_FOV = 60;
const LOD_REF_TAN = Math.tan((LOD_REF_FOV * Math.PI) / 360);

/**
 * [ground polish] THREE.LOD for units, with three changes:
 *  - The switch distance is in screen terms: it scales with the camera's field
 *    of view, so the narrow recon optic or a cinematic close-up keeps LOD0 on a
 *    unit that fills the frame, and a wide view swaps no earlier than intended.
 *  - Only perspective cameras pick the level. The CSM cascade cameras
 *    (orthographic) render whatever the main view chose, so a unit's shadow
 *    never switches level on its own.
 *  - Animated nodes (turret / barrels / launcher / dish, control surfaces) are
 *    driven on LOD0 by the assets and AI systems; each update copies their
 *    rotation onto the same-named nodes of the other levels, so a gun laid on
 *    the player keeps its lay when it switches level.
 */
export class UnitLOD extends THREE.LOD {
  constructor() {
    super();
    this.pairs = []; // [source node, [targets]]
    this.isUnitLOD = true;
  }

  /** Pair the named nodes of LOD0 with their namesakes on the other levels. */
  linkNodes(names) {
    this.pairs.length = 0;
    const [first, ...rest] = this.levels.map((l) => l.object);
    if (!first) return this;
    for (const name of new Set(names)) {
      const src = first.getObjectByName(name);
      if (!src) continue;
      const dst = rest.map((o) => o.getObjectByName(name)).filter(Boolean);
      if (dst.length) this.pairs.push([src, dst]);
    }
    return this;
  }

  /** Effective switch distance of the camera: metres, scaled to a 60 degree view. */
  static viewDistance(lodPos, camera) {
    const d = lodPos.distanceTo(camera.position) / (camera.zoom || 1);
    const fov = camera.fov ?? LOD_REF_FOV;
    return d * (Math.tan((fov * Math.PI) / 360) / LOD_REF_TAN);
  }

  update(camera) {
    for (const [src, dst] of this.pairs) for (const o of dst) o.quaternion.copy(src.quaternion);
    if (!camera.isPerspectiveCamera) return;
    const levels = this.levels;
    if (levels.length < 2) return;
    _lodPos.setFromMatrixPosition(this.matrixWorld);
    _camPos.setFromMatrixPosition(camera.matrixWorld);
    const d = UnitLOD.viewDistance(_lodPos, { position: _camPos, zoom: camera.zoom, fov: camera.fov });
    let cur = 0;
    for (let i = 1; i < levels.length; i++) {
      let at = levels[i].distance;
      if (levels[i].object.visible) at -= at * levels[i].hysteresis;
      if (d >= at) cur = i;
      else break;
    }
    for (let i = 0; i < levels.length; i++) levels[i].object.visible = i === cur;
    this._currentLevel = cur;
  }
}
const _lodPos = new THREE.Vector3();
const _camPos = new THREE.Vector3();

/** LOD switch distance of a catalogue entry's level `i`, or null without one. */
function lodDistance(entry, i) {
  const l = entry?.lods?.[i];
  return l && l.distance > 0 ? l.distance : null;
}

/**
 * An asset as a UnitLOD (LOD0 + LOD1 at the catalog distance), or the plain
 * LOD0 model when the asset has no second level. Null when LOD0 is missing.
 * The LOD carries LOD0's userData (assetId, sockets) so code that reads the
 * unit model's catalog id, bounds or sockets sees the same thing as before.
 */
async function loadUnitLOD(id, opts = {}) {
  const entry = CATALOG[id];
  const dist = (opts.lod ?? 0) === 0 ? lodDistance(entry, 1) : null; // a pinned level stays pinned
  const [near, far] = await Promise.all([
    tryLoadModel(id, opts),
    dist ? tryLoadModel(id, { ...opts, lod: 1 }) : null,
  ]);
  if (!near) return null;
  if (!far || far.userData.lod !== 1) return near;
  const lod = new UnitLOD();
  lod.name = `${id}-lod`;
  lod.hysteresis = 0.1;
  lod.addLevel(near, 0, 0.1);
  lod.addLevel(far, dist, 0.1);
  lod.userData = { ...near.userData };
  lod.linkNodes([...SYNC_NODES, ...(entry?.pivots ?? [])]);
  return lod;
}

/** A fresh Object3D for a ground unit type. */
export async function groundModel(type) {
  const id = ASSET_IDS[type];
  const model = (id ? await loadUnitLOD(id) : null) ?? (PLACEHOLDERS[type] ?? PLACEHOLDERS.bunker)();
  model.userData.isUnitModel = true;
  if (!model.userData.spin) model.userData.spin = model.getObjectByName('dish') ?? null;
  return model;
}

/**
 * Turn a destroyed unit into its wreck (which stays as a landmark): the art
 * area's `_destroyed` model where one exists, its burned material recipe
 * otherwise, and a blackened placeholder as the last resort.
 */
export function wreck(object3d, type = null, flatten = 0.7) {
  const blacken = () => {
    object3d.traverse((o) => { if (o.isMesh) o.material = M.wreck; });
    object3d.scale.y *= flatten;
  };
  const id = DESTROYED_IDS[type] ?? null;
  const base = ASSET_IDS[type] ?? (typeof type === 'string' && type.startsWith('base_') ? type : null);
  if (!id && !base) return blacken();
  // [ground polish] the wreck switches level at the same distance as the live
  // unit did (both levels of the `_destroyed` asset, or of the burned recipe);
  // a base kit stays on the level its live layout used (LOD1, see loadBaseKit)
  const kit = !id && base.startsWith('base_');
  (id ? loadUnitLOD(id) : loadUnitLOD(base, { burned: true, lod: kit ? 1 : 0 })).then((m) => {
    if (!m) return blacken();
    const keep = object3d.children.find((c) => c.userData.isUnitModel);
    if (keep) { m.position.copy(keep.position); object3d.remove(keep); }
    m.userData.isUnitModel = true;
    object3d.add(m);
  });
}

// ---- base kit (public/assets/bases) ----------------------------------------

/** A base layout ("raven", "slate", ...) from the catalogue, or null. */
export async function loadBaseKit(id) {
  const m = await tryLoadModel(`base_${id}`, { lod: 1 });
  if (m) m.userData.isUnitModel = true;
  return m;
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
  // loadModel hands out clones itself; only the fallback needs a template.
  if (await tryLoadModel('mig21_hostile')) return { isTemplate: false, object: new THREE.Group() };
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
  return { isTemplate: true, object: ac.model };
}

// [art pass] Beyond this distance (camera, metres) the hostile shows its LOD1
// airframe (24k instead of 232k triangles; catalog `mig21_hostile.lods[1].distance`).
const HOSTILE_LOD1_DISTANCE = 600;

export async function hostileFighterModel() {
  hostileTemplate ??= buildHostileTemplate();
  const src = await hostileTemplate;
  const g = new THREE.Group();
  g.name = 'hostile-aircraft';
  if (src.isTemplate) {
    g.add(src.object.clone());
    return g;
  }
  // [art pass] a simple pilot in the cockpit (pilot LOD1, aircraft model space,
  // no shadow) and the light airframe at range
  const [near, far, pilot] = await Promise.all([
    tryLoadModel('mig21_hostile'),
    tryLoadModel('mig21_hostile', { lod: 1 }),
    tryLoadModel('pilot', { lod: 1, castShadow: false }),
  ]);
  if (!near) {
    g.add(src.object.clone());
    return g;
  }
  if (pilot) {
    pilot.name = 'pilot';
    near.add(pilot);
  }
  if (far && far.userData.lod === 1) {
    // [ground polish] UnitLOD: the shadow cascades no longer pick a level of
    // their own, the switch follows the field of view, the 10 % hysteresis is
    // real (it was set as an unused `lod.hysteresis` property) and LOD1's
    // control surfaces follow LOD0's
    const lod = new UnitLOD();
    lod.name = 'hostile-lod';
    lod.addLevel(near, 0, 0.1);
    lod.addLevel(far, HOSTILE_LOD1_DISTANCE, 0.1);
    lod.linkNodes(CATALOG.mig21_hostile?.pivots ?? []);
    g.add(lod);
  } else {
    g.add(near);
  }
  return g;
}

/** Preload so the first spawn in a sortie does not hitch. */
export function preloadModels() {
  hostileTemplate ??= buildHostileTemplate();
  return hostileTemplate;
}
