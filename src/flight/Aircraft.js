import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

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

/**
 * Visual airframe. Model space: nose toward -Z, up +Y, right +X, origin at the
 * bounding-box centre, metres. `group` follows the flight model; effects attach
 * to the named sockets in `sockets` (nozzle, wingtips, gun, pylons).
 */
export class Aircraft {
  constructor({ url = './models/mig21.glb', livery = null } = {}) {
    this.url = url;
    this.livery = livery;
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
  }

  async load() {
    const gltf = await loadGLTF(this.url);
    const root = gltf.scene.clone(true);
    root.updateWorldMatrix(true, true);
    const box = new THREE.Box3().setFromObject(root);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const holder = new THREE.Group();
    root.position.sub(center);
    holder.add(root);
    const axes = [['x', size.x], ['y', size.y], ['z', size.z]].sort((a, b) => b[1] - a[1]);
    if (axes[0][0] === 'y') holder.rotateX(-Math.PI / 2);
    else if (axes[0][0] === 'x') holder.rotateY(Math.PI / 2);
    holder.scale.setScalar(REAL_LENGTH / axes[0][1]);
    // The source model (Sketchfab, War Thunder export) has its nose toward +Z.
    holder.rotateY(Math.PI);
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

    this.model.updateWorldMatrix(true, true);
    const b = new THREE.Box3().setFromObject(this.model);
    this.bounds = b;
    this.length = b.max.z - b.min.z;
    this.wingspan = b.max.x - b.min.x;
    this.sockets.nozzle.position.set(0, -0.61, 6.42); // [vfx] measured nozzle exit of mig21.glb (centre of the 0.45 m lip); the bbox guess was 0.66 m high and 1.16 m aft (it measured the fin)
    this.sockets.wingtipL.position.set(b.min.x + 0.15, -0.05, 1.6);
    this.sockets.wingtipR.position.set(b.max.x - 0.15, -0.05, 1.6);
    this.sockets.gun.position.set(0, -0.6, -2.5);
    this.sockets.cockpit.position.set(0, 0.22, -2.95); // measured pilot eye (docs/v2/evidence/assets/cockpit)
    this.loaded = true;
    return this;
  }

  /** Copy pose from a flight model (position + orientation). */
  syncTo(flight) {
    this.group.position.copy(flight.position);
    this.group.quaternion.copy(flight.orientation);
  }

  addTo(scene) { scene.add(this.group); }
}
