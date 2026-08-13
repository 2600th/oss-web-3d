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
    this.params = new Float32Array(count * 3); // opacity, seed, cluster height
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
      },
      vertexShader: /* glsl */ `
        precision highp float;
        in vec4 aOffset;
        in vec3 aParams;

        out vec2 vUv;
        out float vOpacity;
        out float vSeed;
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
        in vec3 vWorld;
        in vec3 vCentre;
        out vec4 fragColor;

        ${ATMOSPHERE_UNIFORMS_GLSL}
        uniform vec3 uCameraPos;
        uniform float uTime;
        ${ATMOSPHERE_GLSL}

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

          // Soft round core, broken up by a little noise so the silhouette is
          // not a perfect disc. Two octaves is enough at the sizes these are
          // ever seen at.
          float n = vnoise(d * 3.1 + vSeed) * 0.5 + vnoise(d * 7.3 - vSeed) * 0.25;
          float alpha = smoothstep(1.0, 0.10, r + n * 0.38) * vOpacity;
          if (alpha < 0.004) discard;

          // Fake the volume: treat the offset from the puff centre as a normal.
          // Enough to give a lit crown, a shaded base and a bright rim toward
          // the sun, which is all a cumulus really reads as from a distance.
          vec3 toCam = normalize(uCameraPos - vWorld);
          vec3 normal = normalize(vec3(d.x, 0.55, d.y) + toCam * 0.35);
          float lit = clamp(dot(normal, uSunDir) * 0.5 + 0.5, 0.0, 1.0);

          // A cumulus reads almost entirely by the contrast between its lit
          // crown and its shaded base. Over snow that contrast is the *only*
          // thing separating it from the mountain behind, so the base is kept
          // genuinely dark rather than politely grey.
          vec3 shadowed = vec3(0.30, 0.36, 0.50);
          vec3 sunlit = vec3(1.26, 1.24, 1.20);
          vec3 col = mix(shadowed, sunlit, pow(lit, 1.9));

          // Forward scattering: the rim facing the sun glows.
          float mu = max(dot(-toCam, uSunDir), 0.0);
          col += uSunColor * pow(mu, 5.0) * (1.0 - smoothstep(0.25, 0.95, r)) * 0.55;

          float dist = length(uCameraPos - vWorld);
          // Clouds sit *in* the haze rather than behind all of it, and they are
          // far brighter than terrain, so applying the full path length washes
          // a bank into the sky and it vanishes. Half the optical distance
          // keeps distant decks readable while still tying them to the air.
          col = atm_applyAerial(col, -toCam, dist * 0.5, uCameraPos.y, vWorld.y);

          // Never let a puff slam into the near plane as the aircraft flies
          // through the bank; fade it out instead.
          alpha *= smoothstep(30.0, 220.0, dist);

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
    this.params[p + 2] = cluster.y;
  }

  update(dt, focus) {
    const attributes = this.mesh.geometry.attributes;

    if (!this._initialised) {
      for (let i = 0; i < this.count; i++) this._seedCluster(i, focus, true);
      this._centre.copy(focus);
      this._initialised = true;
      attributes.aOffset.needsUpdate = true;
      attributes.aParams.needsUpdate = true;
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
