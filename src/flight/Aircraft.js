import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';

/**
 * The player's MiG-21: model loading, orientation, and the engine plume.
 *
 * The source asset is a Sketchfab OBJ conversion, so its axes are whatever the
 * original artist used and every node carries its own scale. Rather than
 * hard-coding a guessed transform, the model is measured at load and fitted to
 * a real MiG-21's 14.7 m length, with the nose put on -Z to match three.js
 * convention. That way the flight model can work in metres and the camera
 * distances mean something physical.
 */

const REAL_LENGTH = 14.7; // metres, MiG-21bis including probe

/**
 * Vertical *extent* of the front and back quarters of a model whose long axis
 * is already on Z. The tail quarter of any fighter carries the fin and the
 * stabilators and spans far more height than the nose quarter, so this picks
 * which way the aircraft faces without hard-coding anything about the asset.
 *
 * Extent, not mean deviation: the first attempt averaged |y - centre| and
 * separated the two ends by 0.7%, because the slim nose sits well below a
 * centre line that the fin drags upward, so its mean offset is just as large as
 * the tail's. Range is unambiguous.
 */
function measureEndSpread(object) {
  const box = new THREE.Box3().setFromObject(object);
  const zMin = box.min.z;
  const zMax = box.max.z;
  const quarter = (zMax - zMin) / 4;

  let frontMin = Infinity;
  let frontMax = -Infinity;
  let backMin = Infinity;
  let backMax = -Infinity;
  const v = new THREE.Vector3();

  object.traverse((child) => {
    if (!child.isMesh) return;
    const position = child.geometry.getAttribute('position');
    if (!position) return;
    child.updateWorldMatrix(true, false);
    // Sampling is plenty; this only has to pick a side.
    const stride = Math.max(1, Math.floor(position.count / 6000));
    for (let i = 0; i < position.count; i += stride) {
      v.fromBufferAttribute(position, i).applyMatrix4(child.matrixWorld);
      if (v.z < zMin + quarter) {
        if (v.y < frontMin) frontMin = v.y;
        if (v.y > frontMax) frontMax = v.y;
      } else if (v.z > zMax - quarter) {
        if (v.y < backMin) backMin = v.y;
        if (v.y > backMax) backMax = v.y;
      }
    }
  });

  return {
    front: Number.isFinite(frontMax) ? frontMax - frontMin : 0,
    back: Number.isFinite(backMax) ? backMax - backMin : 0,
  };
}

export class Aircraft {
  constructor(environment) {
    this.environment = environment;

    /** Outer node driven by the flight model. */
    this.group = new THREE.Group();
    /** Inner node holding the corrective transform for the source asset. */
    this.model = new THREE.Group();
    this.group.add(this.model);

    this.loaded = false;
    this.length = REAL_LENGTH;
    this.wingspan = 7.15;

    this._buildExhaust();
  }

  async load(url = './models/mig21.glb', envMap = null) {
    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);

    const gltf = await loader.loadAsync(url);
    const root = gltf.scene;

    // Measure before touching anything.
    root.updateWorldMatrix(true, true);
    const box = new THREE.Box3().setFromObject(root);
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);

    // The longest axis is the fuselage.
    const axes = [
      { axis: 'x', len: size.x },
      { axis: 'y', len: size.y },
      { axis: 'z', len: size.z },
    ].sort((a, b) => b.len - a.len);
    const lengthAxis = axes[0].axis;
    const scale = REAL_LENGTH / axes[0].len;

    root.position.sub(center);
    const holder = new THREE.Group();
    holder.add(root);

    // Put the fuselage on Z and the short axis on Y.
    if (lengthAxis === 'y') holder.rotateX(-Math.PI / 2);
    else if (lengthAxis === 'x') holder.rotateY(Math.PI / 2);
    holder.scale.setScalar(scale);
    this.model.add(holder);
    this._holder = holder;

    // Measure with the model detached from the flying group, so "world" space
    // during the fit *is* aircraft-local space. Measuring it attached gave
    // bounds around the aircraft's position 6 km down the map, which put the
    // exhaust nozzle at z = 6013.
    const parent = this.model.parent;
    parent?.remove(this.model);
    this.model.position.set(0, 0, 0);
    this.model.quaternion.identity();
    this.model.updateWorldMatrix(true, true);

    // Which end is the nose? Guessing produced an aircraft that flew tail-first
    // with its afterburner on the pitot tube. A fighter's tail quarter carries
    // the fin and stabilators and is much taller than its nose quarter, so the
    // thinner end gets pointed at -Z, which is three.js forward.
    const spread = measureEndSpread(this.model);
    if (spread.front > spread.back) {
      holder.rotateY(Math.PI);
      this.model.updateWorldMatrix(true, true);
    }
    this.noseConfidence = Math.abs(spread.front - spread.back) / Math.max(spread.front, spread.back, 1e-6);
    if (this.noseConfidence < 0.15) {
      console.warn(
        `[aircraft] nose direction is ambiguous (${(this.noseConfidence * 100).toFixed(1)}% ` +
          'difference between ends); the model may be flying backwards.',
      );
    }

    this.bounds = new THREE.Box3().setFromObject(this.model);
    parent?.add(this.model);

    root.traverse((child) => {
      if (!child.isMesh) return;
      child.castShadow = false;
      child.receiveShadow = false;
      child.frustumCulled = false;
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      for (const m of materials) {
        if (!m) continue;
        if (envMap) {
          m.envMap = envMap;
          m.envMapIntensity = 0.85;
        }
        // Sketchfab spec/gloss conversions land on very high roughness with no
        // metalness, which reads as chalk. Bring it back toward painted metal.
        if (m.isMeshStandardMaterial) {
          m.roughness = THREE.MathUtils.clamp(m.roughness * 0.72 + 0.16, 0.18, 0.92);
          m.metalness = THREE.MathUtils.clamp(m.metalness * 0.5 + 0.32, 0, 1);
          m.needsUpdate = true;
        }
      }
    });

    // Park the plume on the actual tail rather than a guessed offset.
    this.exhaust.position.set(0, this.bounds.min.y * 0.15, this.bounds.max.z - 0.35);
    this.wingspan = this.bounds.max.x - this.bounds.min.x;

    this.loaded = true;
    return this;
  }

  /**
   * Engine plume: a stack of additive cones plus a bright core. Deliberately
   * built from geometry rather than a sprite so it stays correct when the
   * camera swings around the tail.
   */
  _buildExhaust() {
    this.exhaust = new THREE.Group();
    // Refined to the measured tail once the model loads.
    this.exhaust.position.set(0, 0.05, 6.6);
    this.group.add(this.exhaust);

    const cone = (radius, length, color, opacity) => {
      const geometry = new THREE.ConeGeometry(radius, length, 18, 1, true);
      geometry.rotateX(-Math.PI / 2);
      geometry.translate(0, 0, length * 0.5);
      const material = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.frustumCulled = false;
      this.exhaust.add(mesh);
      return mesh;
    };

    // Sized off the real nozzle (about 0.9 m across). The plume only becomes
    // long and blue-cored in reheat; at cruise it is a short, dim glow.
    this.flameCore = cone(0.44, 1.5, 0xfff0d8, 0.95);
    this.flameMid = cone(0.60, 3.2, 0xffa63a, 0.55);
    this.flameOuter = cone(0.76, 6.0, 0x6f8cff, 0.24);

    // Shock diamonds: small bright discs spaced down the plume, only visible in
    // reheat. Cheap, and instantly recognisable as an afterburner.
    this.diamonds = [];
    for (let i = 0; i < 4; i++) {
      const geometry = new THREE.SphereGeometry(0.3, 10, 8);
      geometry.scale(1, 1, 0.42);
      const material = new THREE.MeshBasicMaterial({
        color: 0xffe9c0,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.z = 2.1 + i * 1.65;
      mesh.frustumCulled = false;
      this.exhaust.add(mesh);
      this.diamonds.push(mesh);
    }
  }

  update(dt, flight) {
    this.group.position.copy(flight.position);
    this.group.quaternion.copy(flight.orientation);

    const t = flight.throttleSmoothed;
    const reheat = THREE.MathUtils.clamp((t - 0.84) / 0.16, 0, 1);
    // Flicker keeps the plume alive without ever pumping the bloom threshold.
    const flicker = 0.94 + 0.06 * Math.sin(performance.now() * 0.045);

    // Below about half throttle there is essentially nothing to see, which is
    // what makes lighting the burner feel like an event.
    const heat = THREE.MathUtils.clamp((t - 0.35) / 0.65, 0, 1);

    this.flameCore.scale.set(0.72 + 0.28 * heat, 0.72 + 0.28 * heat, 0.5 + 0.7 * heat + reheat * 1.5);
    this.flameCore.material.opacity = (0.10 + 0.42 * heat + 0.35 * reheat) * flicker;

    this.flameMid.scale.set(0.62 + 0.38 * heat, 0.62 + 0.38 * heat, 0.35 + 0.5 * heat + reheat * 1.9);
    this.flameMid.material.opacity = (0.04 + 0.18 * heat + 0.30 * reheat) * flicker;

    this.flameOuter.scale.set(0.55 + 0.45 * reheat, 0.55 + 0.45 * reheat, 0.3 + 1.4 * reheat);
    this.flameOuter.material.opacity = 0.02 + 0.24 * reheat;
    this.flameOuter.visible = reheat > 0.01;

    for (let i = 0; i < this.diamonds.length; i++) {
      const d = this.diamonds[i];
      d.material.opacity = reheat * (0.45 - i * 0.09) * flicker;
      d.scale.setScalar(0.55 + 0.45 * reheat);
      d.visible = reheat > 0.02;
    }

    void dt;
  }

  addTo(scene) {
    scene.add(this.group);
  }
}
