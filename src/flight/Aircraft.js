import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { upgradeAircraftMaterials } from '../assets/materials.js';
import { SurfaceRig, demandsFromFlight } from '../assets/controlSurfaces.js';

const REAL_LENGTH = 15.76; // MiG-21bis overall length, metres

const cache = new Map();
function loadGLTF(url) {
  if (!cache.has(url)) {
    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
    cache.set(url, loader.loadAsync(url));
  }
  return cache.get(url);
}

/** A node in the GLB that says it is already in runtime conventions (tools/blender/build_mig_surfaces.py). */
function isBaked(root) {
  let baked = false;
  root.traverse((o) => { if (o.userData?.baked) baked = true; });
  return baked;
}

/**
 * Visual airframe. Model space: nose toward -Z, up +Y, right +X, origin at the
 * bounding-box centre, metres. `group` follows the flight model; effects attach
 * to the named sockets in `sockets` (nozzle, wingtips, gun, pylons).
 *
 * [art pass] The shipped mig21.glb is now baked to those conventions and carries
 * pivot nodes for the stabilators, ailerons and flaps (`surfaces`, driven by
 * `updateSurfaces(dt, flight)` from the flight model's rates). An un-baked
 * source GLB is still normalised as before. Materials are upgraded to node
 * materials (painted metal, coated canopy glass) by src/assets/materials.js;
 * `configure({tier, env})` re-applies them for the quality tier and hooks up
 * cloud shadows (the assets system calls it at init).
 */
export class Aircraft {
  constructor({ url = './models/mig21.glb', livery = null, role = 'player' } = {}) {
    this.url = url;
    this.livery = livery;
    this.role = role;
    this.group = new THREE.Group();
    this.group.name = 'aircraft';
    this.model = new THREE.Group();
    this.group.add(this.model);
    this.sockets = {
      nozzle: new THREE.Object3D(),
      wingtipL: new THREE.Object3D(),
      wingtipR: new THREE.Object3D(),
      gun: new THREE.Object3D(),
      cockpit: new THREE.Object3D(),
      pylons: [],
    };
    for (const k of ['nozzle', 'wingtipL', 'wingtipR', 'gun', 'cockpit']) this.group.add(this.sockets[k]);
    this.loaded = false;
    this.surfaces = null;
    this._demands = { pitch: 0, roll: 0, flap: 0 };
  }

  async load() {
    const gltf = await loadGLTF(this.url);
    const root = gltf.scene.clone(true);
    root.updateWorldMatrix(true, true);
    const holder = new THREE.Group();
    holder.add(root);
    if (!isBaked(root)) {
      const box = new THREE.Box3().setFromObject(root);
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      root.position.sub(center);
      const axes = [['x', size.x], ['y', size.y], ['z', size.z]].sort((a, b) => b[1] - a[1]);
      if (axes[0][0] === 'y') holder.rotateX(-Math.PI / 2);
      else if (axes[0][0] === 'x') holder.rotateY(Math.PI / 2);
      holder.scale.setScalar(REAL_LENGTH / axes[0][1]);
      // The source model (Sketchfab, War Thunder export) has its nose toward +Z.
      holder.rotateY(Math.PI);
    }
    this.model.add(holder);

    root.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = true;
      o.receiveShadow = true;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        if (!m?.isMeshStandardMaterial) continue;
        m.envMapIntensity = 1;
        if (this.livery) this.livery(m, o);
      }
    });
    this._source = root;
    upgradeAircraftMaterials(root, { tier: this.tier ?? 'high', role: this.role, env: this.env ?? null });
    this.surfaces = new SurfaceRig(root);

    this.model.updateWorldMatrix(true, true);
    const b = new THREE.Box3().setFromObject(this.model);
    this.bounds = b;
    this.length = b.max.z - b.min.z;
    this.wingspan = b.max.x - b.min.x;
    this.sockets.nozzle.position.set(0, -0.61, 6.42); // [vfx] measured nozzle exit of mig21.glb (centre of the 0.45 m lip); the bbox guess was 0.66 m high and 1.16 m aft (it measured the fin)
    // [art pass] measured wingtips of mig21.glb (outermost point x ±3.666, y -0.777, z 2.74; tools/blender/probe_lamps.py); the bbox guess floated 0.7 m above and 1.1 m ahead of the wing
    this.sockets.wingtipL.position.set(-3.64, -0.777, 2.74);
    this.sockets.wingtipR.position.set(3.64, -0.777, 2.74);
    this.sockets.gun.position.set(0, -0.6, -2.5);
    this.sockets.cockpit.position.set(0, 0.22, -2.95); // measured pilot eye (docs/v2/evidence/assets/cockpit)
    this.loaded = true;
    return this;
  }

  /**
   * Quality tier + environment (cloud shadows). Re-applies the material recipe
   * from the original GLB materials, so it is safe to call after load().
   */
  configure({ tier, env } = {}) {
    if (tier) this.tier = tier;
    if (env) this.env = env;
    if (!this._source) return;
    upgradeAircraftMaterials(this._source, { tier: this.tier ?? 'high', role: this.role, env: this.env ?? null });
  }

  /**
   * Animate stabilators / ailerons / flaps from the flight model: the body
   * rates it is flying (which chase stick x authority) and its airspeed.
   */
  updateSurfaces(dt, flight) {
    if (!this.surfaces?.ok || !flight) return;
    this.surfaces.update(Math.min(dt, 0.1), demandsFromFlight(flight, this._demands));
  }

  /** Copy pose from a flight model (position + orientation). */
  syncTo(flight) {
    this.group.position.copy(flight.position);
    this.group.quaternion.copy(flight.orientation);
  }

  addTo(scene) { scene.add(this.group); }
}
