import * as THREE from 'three';
import { ATMOSPHERE_GLSL, ATMOSPHERE_UNIFORMS_GLSL } from './atmosphere.glsl.js';
import { terrainHeight } from './heightfield.js';

/**
 * Cloud banks: instanced soft billboards grouped into cumulus clusters, plus a
 * valley inversion layer.
 *
 * Not a full-screen raymarch, and that is a measured decision rather than a
 * shortcut. Published WebGL cloud raymarchers of this kind report roughly 60 fps
 * on a GTX 1060 *with nothing else in the scene*, and as low as 11-20 fps on an
 * RTX 2080; their authors describe them as pixel-bound. This experience already
 * spends its fill rate on terrain that covers the whole frame. Billboard
 * clusters give the same read — volume, silver lining, cloud shadows on the
 * ground, something to fly between — for a fraction of the cost, and they hold
 * up precisely because the player is moving past them at 250 m/s.
 *
 * Clusters recycle around the aircraft rather than existing everywhere, so the
 * cost is fixed no matter how far you fly.
 */

/**
 * Radius of the recycling field.
 *
 * Sized from density, not from view distance: 26 km put forty cloud banks
 * across 2100 km², roughly one per 53 km², and the sky read as empty with two
 * or three distant smudges. Halving the radius quadruples density for the same
 * instance count and the same cost.
 */
const FIELD_RADIUS = 12500;
const RECYCLE_MARGIN = 1.15;

export class Clouds {
  constructor(environment, count = 320) {
    this.environment = environment;
    this.count = count;

    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3),
    );
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
    geometry.setIndex([0, 1, 2, 0, 2, 3]);

    this.offsets = new Float32Array(count * 4); // xyz + radius
    this.params = new Float32Array(count * 3); // opacity, seed, sun transmittance
    geometry.setAttribute('aOffset', new THREE.InstancedBufferAttribute(this.offsets, 4));
    geometry.setAttribute('aParams', new THREE.InstancedBufferAttribute(this.params, 3));
    geometry.instanceCount = count;
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);

    this.material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      blending: THREE.NormalBlending,
      uniforms: {
        ...environment.uniforms,
        uFieldRadius: { value: FIELD_RADIUS },
        uNear: { value: 4 },
        uExtinction: { value: 0.0013 },
      },
      vertexShader: /* glsl */ `
        precision highp float;
        in vec4 aOffset;
        in vec3 aParams;

        out vec2 vUv;
        out float vOpacity;
        out float vSeed;
        out float vRadius;
        out float vSunLight;
        out vec3 vWorld;
        out vec3 vCentre;

        void main() {
          vec3 centre = aOffset.xyz;
          float radius = aOffset.w;

          // Camera-facing billboard built from the view matrix rows, so the
          // puff always presents its full area without a per-instance lookAt.
          vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
          vec3 up    = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);

          vec3 world = centre + (right * position.x + up * position.y * 0.72) * radius;

          vUv = uv;
          vOpacity = aParams.x;
          vSeed = aParams.y;
          vSunLight = aParams.z;
          vRadius = radius;
          vWorld = world;
          vCentre = centre;

          gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        in vec2 vUv;
        in float vOpacity;
        in float vSeed;
        in float vRadius;
        in float vSunLight;
        in vec3 vWorld;
        in vec3 vCentre;
        out vec4 fragColor;

        ${ATMOSPHERE_UNIFORMS_GLSL}
        uniform vec3 uCameraPos;
        uniform float uTime;
        uniform float uNear;
        uniform float uExtinction;
        ${ATMOSPHERE_GLSL}

        // Henyey-Greenstein phase function.
        float hg(float mu, float g) {
          float gg = g * g;
          float denom = 1.0 + gg - 2.0 * g * mu;
          return (1.0 - gg) / (12.566370614 * max(denom * sqrt(max(denom, 1e-4)), 1e-4));
        }

        float hash21(vec2 p) {
          p = 50.0 * fract(p * 0.3183099 + vec2(0.71, 0.113));
          return fract(p.x * p.y * (p.x + p.y));
        }
        float vnoise(vec2 x) {
          vec2 p = floor(x), f = fract(x);
          f = f * f * (3.0 - 2.0 * f);
          return mix(mix(hash21(p), hash21(p + vec2(1, 0)), f.x),
                     mix(hash21(p + vec2(0, 1)), hash21(p + vec2(1, 1)), f.x), f.y);
        }

        void main() {
          vec2 d = vUv * 2.0 - 1.0;
          float r = length(d);
          if (r > 1.0) discard;

          float n = vnoise(d * 3.1 + vSeed) * 0.5 + vnoise(d * 7.3 - vSeed) * 0.25;

          // Spherical billboard: alpha comes from how much cloud the view ray
          // actually crosses, not from a painted disc.
          //
          // The quad stands in for a sphere, so the half-chord through it at
          // this fragment is r_sphere * sqrt(1 - r^2). Opacity is then Beer's
          // law over that thickness. Two artifacts disappear together: the puff
          // no longer reads as a flat card, because density genuinely thins
          // toward the rim; and flying through a bank no longer pops, because
          // clipping the chord at the near plane makes a puff dissolve
          // continuously as the camera enters it. The old smoothstep disc
          // needed a hand-tuned distance fade to hide the same popping.
          // Umenhoffer et al., Spherical Billboards for Rendering Volumetric
          // Data (ShaderX5 / GI 2006).
          // The noise displaces the silhouette, not just the density. Driving
          // Beer's law off the exact analytic chord alone gives a perfect
          // circle of near-opaque cloud with a hard rim — a solid egg, which is
          // a worse read than the soft smear it replaced. Real cumulus edges
          // are not soft, they are fractal, so the radius itself is perturbed
          // and the chord is taken through the perturbed sphere.
          float rn = clamp(r + (n - 0.36) * 0.62, 0.0, 1.0);
          if (rn > 0.998) discard;

          float omega = vRadius * sqrt(max(1.0 - rn * rn, 0.0));
          float toCentre = length(uCameraPos - vCentre);
          float entry = max(toCentre - omega, uNear);
          float thickness = max(toCentre + omega - entry, 0.0);

          float density = vOpacity * clamp(0.55 + 0.60 * n, 0.0, 1.3);
          float alpha = (1.0 - exp(-uExtinction * density * thickness))
                      * smoothstep(1.0, 0.90, rn);
          if (alpha < 0.004) discard;

          vec3 toCam = normalize(uCameraPos - vWorld);
          float mu = dot(-toCam, uSunDir);

          // Two lobes: a narrow forward one for the silver lining when looking
          // into the sun, and a wide backscatter one so the body of the cloud
          // does not go dead once the rim is bright. A single forward lobe was
          // the obvious choice and leaves everything but the rim flat.
          //
          // Normalised so side-scatter is 1.0 rather than left as the raw
          // sphere-integrating phase function, whose value at mu = 0 is about
          // 0.027 — used directly it made every cloud not pointed at the sun
          // almost black. The forward spike is clamped for the same reason in
          // reverse: unclamped it is 50x side-scatter and blows out to a disc.
          float phase = mix(hg(mu, 0.68), hg(mu, -0.25), 0.38) / 0.0265;
          phase = min(phase, 5.5);

          // Powder: the dark edge on clouds seen with the sun behind the
          // viewer. Gated on view direction on purpose — it is only visible
          // where the view vector approaches the light vector, and applying it
          // unconditionally (the common mistake) darkens cloud that should be
          // bright.
          float powder = 1.0 - exp(-uExtinction * density * thickness * 2.2);
          float powderGate = clamp(mu * 0.5 + 0.5, 0.0, 1.0);

          // Sun transmittance is per-puff, computed on the CPU by sorting the
          // field along the sun vector, so a puff buried behind its own cluster
          // is genuinely darker than one on the sunlit face.
          float energy = vSunLight * mix(1.0, powder, powderGate * 0.85);

          // Sky ambient rises through the cloud: the crown sees the whole dome,
          // the base sees mostly the underside of the cloud above it. This is
          // separate from distance haze, and it is what gives a cumulus its
          // lit-top / dark-bottom read.
          float heightInCloud = clamp((vWorld.y - vCentre.y) / (2.0 * vRadius) + 0.5, 0.0, 1.0);
          vec3 ambient = mix(vec3(0.20, 0.25, 0.37), vec3(0.62, 0.68, 0.82), heightInCloud);

          vec3 col = ambient + uSunColor * uSunIntensity * energy * phase * 0.37;

          float dist = length(uCameraPos - vWorld);
          // Clouds sit *in* the haze rather than behind all of it, and they are
          // far brighter than terrain, so applying the full path length washes
          // a bank into the sky and it vanishes. Half the optical distance
          // keeps distant decks readable while still tying them to the air.
          col = atm_applyAerial(col, -toCam, dist * 0.5, uCameraPos.y, vWorld.y);

          // No distance fade here any more. The chord clipped at the near plane
          // already dissolves a puff continuously as the camera enters it,
          // which is what the old smoothstep(30, 220) was standing in for -- and
          // that fade also erased puffs the aircraft was merely close to.

          fragColor = vec4(col, alpha);
        }
      `,
    });

    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 12;

    this._clusters = [];
    this._rand = mulberry32(0x5afed5a9);
    this._centre = new THREE.Vector3();
    this._initialised = false;
    this._order = new Int32Array(0);
    this._keys = new Float32Array(0);
    this._relightTimer = 0;
  }

  setQuality(tier) {
    const count = Math.min(this.count, tier.cloudCount);
    this.mesh.geometry.instanceCount = count;
    this._activeCount = count;
  }

  /** Place one cluster of puffs somewhere on the ring around `centre`. */
  _seedCluster(index, centre, spawnAnywhere) {
    const rand = this._rand;
    const puffsPerCluster = 10;
    const clusterIndex = Math.floor(index / puffsPerCluster);

    let cluster = this._clusters[clusterIndex];
    if (!cluster) {
      cluster = { x: 0, y: 0, z: 0, scale: 1 };
      this._clusters[clusterIndex] = cluster;
    }

    if (index % puffsPerCluster === 0) {
      const angle = rand() * Math.PI * 2;
      // Spawn on the outer ring when recycling so banks drift into view rather
      // than appearing in front of the aircraft.
      const t = spawnAnywhere ? Math.sqrt(rand()) : 0.85 + rand() * 0.3;
      const radius = FIELD_RADIUS * t;
      cluster.x = centre.x + Math.cos(angle) * radius;
      cluster.z = centre.z + Math.sin(angle) * radius;

      // Two decks: fair-weather cumulus above the ridges, and an inversion
      // layer of cloud pooling in the valleys.
      // Two decks, both placed to be seen *against* something. The cumulus
      // deck sits clear above the summits so it reads against sky; the
      // inversion layer pools in the valleys where it reads against dark rock.
      // Putting either at ridge height hides it behind the mountains in front.
      const valley = rand() < 0.42;
      const ground = terrainHeight(cluster.x, cluster.z);
      cluster.y = valley
        ? Math.max(ground + 200, 4050 + rand() * 620)
        : 7150 + rand() * 1500;
      cluster.scale = valley ? 1.6 + rand() * 1.2 : 0.9 + rand() * 1.0;
    }

    const spread = 620 * cluster.scale;
    const o = index * 4;
    this.offsets[o] = cluster.x + (rand() - 0.5) * spread;
    this.offsets[o + 1] = cluster.y + (rand() - 0.5) * spread * 0.34;
    this.offsets[o + 2] = cluster.z + (rand() - 0.5) * spread;
    this.offsets[o + 3] = (340 + rand() * 420) * cluster.scale;

    const p = index * 3;
    this.params[p] = 0.66 + rand() * 0.34;
    this.params[p + 1] = rand() * 40;
    this.params[p + 2] = 1; // sun transmittance, filled in by _relight()
  }

  /**
   * Per-puff transmittance toward the sun.
   *
   * This is Harris's first pass from Real-Time Cloud Rendering for Games (GDC
   * 2002) with the expensive half removed. He sorts particles by distance to
   * the light, renders them front-to-back and reads back the framebuffer to
   * find how much light reaches each one. The readback is a pipeline stall and
   * a non-starter in WebGL2 — but with only a few hundred puffs the same
   * integral is cheap to do analytically on the CPU, and it is the single thing
   * that makes a cluster read as one cumulus rather than ten separate blobs:
   * puffs buried behind the sunlit face come out genuinely darker, so the bank
   * gets a lit crown and a shadowed core for the right reason.
   *
   * The sun does not move, so this only runs when the field changes.
   */
  _relight() {
    const active = this._activeCount ?? this.count;
    const sun = this.environment.uniforms.uSunDir.value;
    const order = this._order.length === active ? this._order : (this._order = new Int32Array(active));
    for (let i = 0; i < active; i++) order[i] = i;

    // Nearest the sun first, so every occluder is processed before what it
    // shades.
    const depthAlongSun = (i) => {
      const o = i * 4;
      return this.offsets[o] * sun.x + this.offsets[o + 1] * sun.y + this.offsets[o + 2] * sun.z;
    };
    const keys = this._keys.length === active ? this._keys : (this._keys = new Float32Array(active));
    for (let i = 0; i < active; i++) keys[i] = depthAlongSun(i);
    const sorted = Array.from(order).sort((a, b) => keys[b] - keys[a]);

    // Deliberately far below the shader's extinction. That value is for a
    // single view ray; this integral stands in for the light that reaches a
    // puff after bouncing around inside the bank, and cloud is strongly
    // multiple-scattering — a physically "correct" single-scatter extinction
    // here drove mean transmittance to 0.18 and turned every bank into a row of
    // dark grey eggs. The floor plays the same role: a real cumulus shadow side
    // sits around a third of its lit side, not at zero.
    const EXTINCTION = 0.0008;
    for (let a = 0; a < sorted.length; a++) {
      const i = sorted[a];
      const io = i * 4;
      const px = this.offsets[io];
      const py = this.offsets[io + 1];
      const pz = this.offsets[io + 2];

      let optical = 0;
      for (let b = 0; b < a; b++) {
        const j = sorted[b];
        const jo = j * 4;
        const rj = this.offsets[jo + 3];
        // Perpendicular distance from this puff to the sun ray through puff j.
        const dx = px - this.offsets[jo];
        const dy = py - this.offsets[jo + 1];
        const dz = pz - this.offsets[jo + 2];
        const along = dx * sun.x + dy * sun.y + dz * sun.z;
        const perpSq = dx * dx + dy * dy + dz * dz - along * along;
        if (perpSq >= rj * rj) continue;
        // Chord of puff j intercepted on the way to the sun.
        optical += 2 * Math.sqrt(rj * rj - perpSq) * this.params[j * 3];
        if (optical > 2400) break; // already fully shadowed
      }
      this.params[i * 3 + 2] = 0.22 + 0.78 * Math.exp(-EXTINCTION * optical);
    }
    this.mesh.geometry.attributes.aParams.needsUpdate = true;
  }

  update(dt, focus) {
    const attributes = this.mesh.geometry.attributes;

    if (!this._initialised) {
      for (let i = 0; i < this.count; i++) this._seedCluster(i, focus, true);
      this._centre.copy(focus);
      this._initialised = true;
      attributes.aOffset.needsUpdate = true;
      attributes.aParams.needsUpdate = true;
      this._relight();
      return;
    }

    // Drift with the wind so the sky is never static.
    const wind = this.environment.uniforms.uWind.value;
    const dx = wind.x * dt * 0.55;
    const dz = wind.y * dt * 0.55;

    let dirty = false;
    const limit = FIELD_RADIUS * RECYCLE_MARGIN;
    const active = this._activeCount ?? this.count;

    for (let i = 0; i < active; i++) {
      const o = i * 4;
      this.offsets[o] += dx;
      this.offsets[o + 2] += dz;

      const ox = this.offsets[o] - focus.x;
      const oz = this.offsets[o + 2] - focus.z;
      if (ox * ox + oz * oz > limit * limit) {
        // Recycle the whole cluster together, or banks tear apart.
        const clusterStart = Math.floor(i / 10) * 10;
        for (let k = clusterStart; k < Math.min(clusterStart + 10, active); k++) {
          this._seedCluster(k, focus, false);
        }
        dirty = true;
      }
    }

    attributes.aOffset.needsUpdate = true;
    if (dirty) attributes.aParams.needsUpdate = true;

    // Relighting is O(n^2) in puffs, so it is throttled rather than run per
    // frame. Drift is slow enough that the shading stays correct between runs,
    // and a recycled cluster spawning with stale transmittance is off screen.
    this._relightTimer -= dt;
    if (dirty || this._relightTimer <= 0) {
      this._relight();
      this._relightTimer = 1.5;
    }
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
