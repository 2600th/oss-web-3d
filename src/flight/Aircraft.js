import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { burnerHeat, burnerReheat } from './burner.js';

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
    this._crashPresentation = false;
    this.length = REAL_LENGTH;
    this.wingspan = 7.15;
    /** World-space nozzle, republished every update for the particle envelope. */
    this.nozzlePosition = new THREE.Vector3();
    this.burnerActive = false;

    this._buildExhaust();
  }

  async load(url = './models/mig21.glb', envMap = null) {
    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);

    const gltf = await loader.loadAsync(url);
    const root = gltf.scene;
    this._envMap = envMap;

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

  /** Bounded, depth-tested nozzle glow and afterburner volume. */
  _buildExhaust() {
    this.exhaust = new THREE.Group();
    this.exhaust.name = 'bounded-afterburner';
    // Refined to the measured tail once the model loads.
    this.exhaust.position.set(0, 0.05, 6.6);
    this.group.add(this.exhaust);
    this._exhaustTime = 0;

    const plume = (nearRadius, farRadius, length, color, opacity) => {
      // A short frustum has a finite near and far radius. Unlike an uncapped
      // cone it cannot put a triangle apex behind the chase camera and expand
      // that triangle into a full-screen additive wedge.
      const geometry = new THREE.CylinderGeometry(farRadius, nearRadius, length, 20, 3, true);
      geometry.rotateX(Math.PI / 2);
      geometry.translate(0, 0, length * 0.5);
      const material = new THREE.ShaderMaterial({
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        depthTest: true,
        side: THREE.DoubleSide,
        toneMapped: false,
        uniforms: {
          uColor: { value: new THREE.Color(color) },
          uOpacity: { value: opacity },
          uTime: { value: 0 },
        },
        vertexShader: /* glsl */ `
          precision highp float;
          varying vec2 vUv;
          varying vec3 vViewNormal;
          varying vec3 vViewDir;
          void main() {
            vUv = uv;
            vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
            vViewNormal = normalMatrix * normal;
            vViewDir = -viewPosition.xyz;
            gl_Position = projectionMatrix * viewPosition;
          }
        `,
        fragmentShader: /* glsl */ `
          precision highp float;
          uniform vec3 uColor;
          uniform float uOpacity;
          uniform float uTime;
          varying vec2 vUv;
          varying vec3 vViewNormal;
          varying vec3 vViewDir;
          void main() {
            // How much gas this view ray crosses. A cylinder's chord is longest
            // straight through the axis and zero at the silhouette, and that is
            // exactly |dot(N, V)| — 1 where the surface faces the eye, 0 where
            // it turns away. Without it the tube has no falloff across its
            // width, so its silhouette is a hard line and the plume reads as a
            // flat plank rather than a volume. The old shader tried to do this
            // from the angular UV, which is fixed to the geometry and does not
            // follow the eye, so it shaded one side of the tube bright
            // regardless of where the camera was.
            // Not squared. Squaring narrows the bright band and drops the mean
            // alpha to about 0.5 against the old rim term's 0.86, which on top
            // of a shorter plume left the burner looking weak. Unsquared it
            // still reaches zero at the silhouette, which is all the hard edge
            // needed.
            vec3 normal = normalize(vViewNormal);
            float chord = abs(dot(normal, normalize(vViewDir)));

            // Hot just aft of the nozzle, then a long fade to nothing at the
            // tip. sin() peaked in the middle and left the plume dark where it
            // leaves the engine, which is backwards; this holds brightness well
            // down the tube so a long plume still reads as lit gas rather than
            // fading out a metre behind the nozzle.
            float v = clamp(vUv.y, 0.0, 1.0);
            float axial = smoothstep(0.0, 0.08, v) * (1.0 - v * v);
            float cell = 0.92 + 0.08 * sin(v * 36.0 - uTime * 28.0);

            float alpha = axial * cell * chord * uOpacity;
            if (alpha < 0.006) discard;
            // Three injects pc_fragColor and aliases gl_FragColor to it. A
            // second user-declared output conflicts with the composer's
            // stable-depth/MRT support render.
            gl_FragColor = vec4(uColor * (0.75 + alpha), alpha);
          }
        `,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.frustumCulled = true;
      this.exhaust.add(mesh);
      return mesh;
    };

    // All three volumes stop inside 5.2 m of the nozzle; the chase camera is
    // outside that safety envelope even under its crash spring impulse.
    this.flameCore = plume(0.39, 0.18, 1.35, 0xfff3d2, 0.88);
    this.flameMid = plume(0.52, 0.16, 3.0, 0xff9938, 0.42);
    this.flameOuter = plume(0.62, 0.24, 5.15, 0x668cff, 0.18);

    const nozzleMaterial = new THREE.MeshBasicMaterial({
      color: 0xff9b52,
      transparent: true,
      opacity: 0.22,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true,
      toneMapped: false,
    });
    this.nozzleGlow = new THREE.Mesh(new THREE.TorusGeometry(0.43, 0.055, 8, 24), nozzleMaterial);
    this.nozzleGlow.rotateX(Math.PI / 2);
    this.nozzleGlow.position.z = 0.03;
    this.exhaust.add(this.nozzleGlow);

    // Shock diamonds: small bright discs spaced down the plume, only visible in
    // reheat. Cheap, and instantly recognisable as an afterburner.
    this.diamonds = [];
    for (let i = 0; i < 4; i++) {
      const geometry = new THREE.OctahedronGeometry(0.27, 1);
      geometry.scale(1, 1, 0.55);
      const material = new THREE.MeshBasicMaterial({
        color: 0xffe9c0,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
      });
      const mesh = new THREE.Mesh(geometry, material);
      // Inside the mid plume, which reaches about 8 m at full reheat.
      mesh.position.z = 1.35 + i * 1.05;
      mesh.frustumCulled = true;
      this.exhaust.add(mesh);
      this.diamonds.push(mesh);
    }
  }

  update(dt, flight) {
    this.group.position.copy(flight.position);
    this.group.quaternion.copy(flight.orientation);
    if (this._crashPresentation) {
      this.burnerActive = false;
      return;
    }

    const t = flight.throttleSmoothed;
    const reheat = burnerReheat(t);
    this._exhaustTime += dt;
    // Deterministic frame-clock flicker: no wall-clock discontinuity after a
    // pause and no browser-global dependency in tests.
    const flicker = 0.94 + 0.06 * Math.sin(this._exhaustTime * 31.0);

    // Below about half throttle there is essentially nothing to see, which is
    // what makes lighting the burner feel like an event.
    const heat = burnerHeat(t);

    // Published for FlightFx, which hangs the turbulent particle envelope off
    // the same nozzle. Read from the scene graph rather than reconstructed from
    // the flight state: the offset is measured off the loaded model's bounds in
    // load(), and duplicating that arithmetic in another file is how the plume
    // and its particles end up in two different places.
    this.exhaust.getWorldPosition(this.nozzlePosition);
    this.burnerActive = true;

    // Lengths are the original ones. Lighting the burner should be dramatic,
    // and the plank the plume used to render as was a shading bug, not a length
    // one — the fix for it is the view-relative chord in the shader. Opacities
    // are up about a third to hold the same apparent brightness through that
    // chord term, whose mean across the tube is lower than the flat rim factor
    // it replaced.
    this.flameCore.scale.set(0.72 + 0.28 * heat, 0.72 + 0.28 * heat, 0.5 + 0.7 * heat + reheat * 1.5);
    this.flameCore.material.uniforms.uOpacity.value = (0.11 + 0.52 * heat + 0.44 * reheat) * flicker;
    this.flameCore.material.uniforms.uTime.value = this._exhaustTime;

    this.flameMid.scale.set(0.62 + 0.38 * heat, 0.62 + 0.38 * heat, 0.35 + 0.5 * heat + reheat * 1.9);
    this.flameMid.material.uniforms.uOpacity.value = (0.045 + 0.21 * heat + 0.35 * reheat) * flicker;
    this.flameMid.material.uniforms.uTime.value = this._exhaustTime;

    this.flameOuter.scale.set(0.55 + 0.45 * reheat, 0.55 + 0.45 * reheat, 0.3 + 1.4 * reheat);
    this.flameOuter.material.uniforms.uOpacity.value = 0.016 + 0.25 * reheat;
    this.flameOuter.material.uniforms.uTime.value = this._exhaustTime;
    this.flameOuter.visible = reheat > 0.01;

    for (let i = 0; i < this.diamonds.length; i++) {
      const d = this.diamonds[i];
      d.material.opacity = reheat * (0.45 - i * 0.09) * flicker;
      d.scale.setScalar(0.55 + 0.45 * reheat);
      d.visible = reheat > 0.02;
    }
    this.nozzleGlow.material.opacity = (0.08 + heat * 0.28 + reheat * 0.20) * flicker;
  }

  setCrashPresentation(active) {
    this._crashPresentation = Boolean(active);
    this.model.visible = !this._crashPresentation;
    this.exhaust.visible = !this._crashPresentation;
  }

  addTo(scene) {
    scene.add(this.group);
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this.group.traverse((object) => {
      if (!object.isMesh) return;
      object.geometry?.dispose?.();
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) {
        if (!material) continue;
        for (const value of Object.values(material)) {
          if (value?.isTexture && value !== this._envMap) value.dispose();
        }
        material.dispose?.();
      }
    });
    this.group.removeFromParent();
    this.group.clear();
  }
}
