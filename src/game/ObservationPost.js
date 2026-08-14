import * as THREE from 'three';
import { terrainHeight, terrainNormal } from '../world/heightfield.js';

/**
 * Fictional enemy observation posts.
 *
 * These are intentionally *not* modelled on any real position or unit. They are
 * generic high-altitude sangars: dry-stone breastworks, a dug-in shelter, a
 * whip antenna and a scatter of stores, on a patch of ground scuffed clear of
 * snow. That last part is what actually makes them findable — at 250 m/s a few
 * grey boxes on a white ridge are invisible, but a dark disturbed footprint
 * eighty metres across reads from kilometres out, which is exactly how real
 * aerial reconnaissance spots occupied positions.
 *
 * Everything is built from shared geometry and merged per post, so the whole
 * mission costs a handful of draw calls.
 */

export const POST_RADIUS = 58; // metres; the scuffed ground footprint
export const POST_HEIGHT = 16; // metres; roughly the antenna tip

/**
 * How far the site sits proud of the analytic ground.
 *
 * The terrain the player sees is the clipmap mesh, which passes through the
 * height function only at its texel centres and interpolates linearly between
 * them. At the 1.5-3 km stand-off where reconnaissance actually happens those
 * cells are 32-64 m across, so the rendered surface can sit several metres
 * above the analytic height that ground objects are placed against — enough to
 * swallow a flat decal entirely. This lift is invisible from the air and keeps
 * the site on top of the mesh at every level of detail.
 */
const GROUND_LIFT = 4.0;

const STONE = new THREE.Color(0x4a4540);
const STONE_DARK = new THREE.Color(0x332f2b);
const TARP = new THREE.Color(0x3c4232);
const METAL = new THREE.Color(0x5a5c58);
const CRATE = new THREE.Color(0x6b5a3c);

/** Deterministic per-post PRNG so a given seed always builds the same camp. */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s ^ (s >>> 15), 2246822519) + 0x9e3779b9) >>> 0;
    return ((s ^ (s >>> 16)) >>> 8) / 16777216;
  };
}

/**
 * A disc of ground conformed to the terrain, used as the scuffed footprint.
 * Vertices sample the same height function the terrain shader does, so it sits
 * flush on any slope without needing to deform the landscape.
 */
function buildGroundPatch(cx, cy, cz, radius, rand) {
  const rings = 6;
  const segments = 26;
  const positions = [];
  const colors = [];
  const scour = [];
  const indices = [];
  const rawBoundaryScale = new Float32Array(segments);
  const boundaryScale = new Float32Array(segments);
  for (let s = 0; s < segments; s++) rawBoundaryScale[s] = 0.84 + rand() * 0.14;
  for (let s = 0; s < segments; s++) {
    const previous = rawBoundaryScale[(s + segments - 1) % segments];
    const next = rawBoundaryScale[(s + 1) % segments];
    boundaryScale[s] = (previous + rawBoundaryScale[s] * 2 + next) * 0.25;
  }

  const push = (x, z, t) => {
    // Local to the post group, which is already positioned at (cx, cy, cz).
    // Pushing an absolute height here put the patch at twice the post's
    // altitude — a dark speck hanging 5.6 km above the mountain.
    const y = terrainHeight(x, z) + GROUND_LIFT - cy;
    positions.push(x - cx, y, z - cz);
    // Mottled bare earth and spoil, darkest in the middle where traffic is
    // heaviest. Against snow this is the only part of the position that is
    // legible from three kilometres out.
    const shade = 0.5 + 0.5 * t + (rand() - 0.5) * 0.26;
    colors.push(0.088 * shade, 0.076 * shade, 0.063 * shade);
    scour.push(Math.min(Math.max(t + (rand() - 0.5) * 0.16, 0), 1));
    return positions.length / 3 - 1;
  };

  const centre = push(cx, cz, 0.2);
  let prevRing = null;
  for (let r = 1; r <= rings; r++) {
    const t = r / rings;
    const ring = [];
    for (let s = 0; s < segments; s++) {
      const a = (s / segments) * Math.PI * 2;
      // A shared, softly filtered boundary scale keeps every radial spoke
      // strictly monotonic while retaining a hand-scuffed silhouette. The
      // small interior variation cannot overtake the next ring and the outer
      // ring is always bounded by the public POST_RADIUS contract.
      const interiorVariation = 0.975 + rand() * 0.025;
      const rr = radius * t * boundaryScale[s] * interiorVariation;
      ring.push(push(cx + Math.cos(a) * rr, cz + Math.sin(a) * rr, t));
    }
    for (let s = 0; s < segments; s++) {
      const n = (s + 1) % segments;
      if (r === 1) indices.push(centre, ring[n], ring[s]);
      else indices.push(prevRing[s], ring[n], ring[s], prevRing[s], prevRing[n], ring[n]);
    }
    prevRing = ring;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setAttribute('aScour', new THREE.Float32BufferAttribute(scour, 1));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function surfaceHash(x, y, z) {
  const value = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719) * 43758.5453;
  return value - Math.floor(value);
}

function decorateGeometry(geometry, color, wearBias = 0.5) {
  const position = geometry.attributes.position;
  const colors = new Float32Array(position.count * 3);
  const wear = new Float32Array(position.count);
  const grounding = new Float32Array(position.count);
  geometry.computeBoundingBox();
  const minY = geometry.boundingBox.min.y;
  const height = Math.max(geometry.boundingBox.max.y - minY, 0.001);
  for (let i = 0; i < position.count; i++) {
    const variation = surfaceHash(position.getX(i), position.getY(i), position.getZ(i));
    const shade = 0.82 + variation * 0.24;
    colors[i * 3] = color.r * shade;
    colors[i * 3 + 1] = color.g * shade;
    colors[i * 3 + 2] = color.b * shade;
    wear[i] = Math.min(Math.max(wearBias * 0.65 + variation * 0.35, 0), 1);
    grounding[i] = Math.min(Math.max((position.getY(i) - minY) / height, 0), 1);
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute('aWear', new THREE.BufferAttribute(wear, 1));
  geometry.setAttribute('aGrounding', new THREE.BufferAttribute(grounding, 1));
}

function boxAt(list, x, y, z, w, h, d, rotY, color) {
  const geometry = new THREE.BoxGeometry(w, h, d);
  geometry.rotateY(rotY);
  geometry.translate(x, y, z);
  decorateGeometry(geometry, color, color === METAL ? 0.82 : 0.46);
  list.push(geometry);
}

function cylinderAt(list, x, y, z, rt, rb, h, color, segments = 7) {
  const geometry = new THREE.CylinderGeometry(rt, rb, h, segments);
  geometry.translate(x, y + h * 0.5, z);
  decorateGeometry(geometry, color, color === METAL ? 0.86 : 0.52);
  list.push(geometry);
}

function sandbagAt(list, x, y, z, length, height, depth, rotY, color) {
  const geometry = new THREE.SphereGeometry(1, 8, 5);
  geometry.scale(length * 0.5, height * 0.5, depth * 0.5);
  geometry.rotateY(rotY);
  geometry.translate(x, y, z);
  decorateGeometry(geometry, color, 0.38);
  list.push(geometry);
}

function rockAt(list, x, y, z, sx, sy, sz, rotY, color) {
  const geometry = new THREE.DodecahedronGeometry(1, 0);
  geometry.scale(sx, sy, sz);
  geometry.rotateX(0.13 + surfaceHash(x, y, z) * 0.22);
  geometry.rotateY(rotY);
  geometry.rotateZ(-0.16 + surfaceHash(z, x, y) * 0.28);
  geometry.translate(x, y, z);
  decorateGeometry(geometry, color, 0.58);
  list.push(geometry);
}

function cylinderBetween(list, start, end, radius, color, segments = 5) {
  const direction = new THREE.Vector3().subVectors(end, start);
  const length = direction.length();
  const geometry = new THREE.CylinderGeometry(radius, radius, length, segments, 1, false);
  geometry.applyQuaternion(
    new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize()),
  );
  geometry.translate(
    (start.x + end.x) * 0.5,
    (start.y + end.y) * 0.5,
    (start.z + end.z) * 0.5,
  );
  decorateGeometry(geometry, color, 0.9);
  list.push(geometry);
}

function roofPanelAt(list, x, y, z, width, depth, rotY, tilt, color) {
  const geometry = new THREE.BoxGeometry(width, 0.34, depth);
  geometry.rotateZ(tilt);
  geometry.rotateY(rotY);
  geometry.translate(x, y, z);
  decorateGeometry(geometry, color, 0.42);
  list.push(geometry);
}

function createStructureMaterial() {
  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.91,
    metalness: 0.035,
  });

  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute float aWear;
attribute float aGrounding;
varying vec3 vPostWorldNormal;
varying vec3 vPostLocalPosition;
varying float vPostWear;
varying float vPostGrounding;`,
      )
      .replace(
        '#include <defaultnormal_vertex>',
        `#include <defaultnormal_vertex>
vPostWorldNormal = normalize(mat3(modelMatrix) * objectNormal);`,
      )
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
vPostLocalPosition = position;
vPostWear = aWear;
vPostGrounding = aGrounding;`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vPostWorldNormal;
varying vec3 vPostLocalPosition;
varying float vPostWear;
varying float vPostGrounding;
float postSurfaceNoise(vec3 p) {
  return fract(sin(dot(floor(p * 1.7), vec3(12.9898, 78.233, 37.719))) * 43758.5453);
}`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
float postWeather = mix(0.82, 1.06, postSurfaceNoise(vPostLocalPosition));
float contactGrounding = smoothstep(0.02, 0.7, vPostGrounding);
diffuseColor.rgb *= postWeather * mix(0.66, 1.0, contactGrounding);
float postSnow = smoothstep(0.58, 0.92, normalize(vPostWorldNormal).y);
postSnow *= mix(0.48, 0.15, vPostWear);
diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.72, 0.79, 0.82), postSnow);`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
roughnessFactor = clamp(roughnessFactor + (0.5 - vPostWear) * 0.12, 0.72, 1.0);`,
      );
  };
  material.customProgramCacheKey = () => 'observation-post-pbr-v1';
  return material;
}

function createPatchMaterial() {
  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 1.0,
    metalness: 0,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -4,
  });

  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute float aScour;
varying float vPostScour;`,
      )
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
vPostScour = aScour;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying float vPostScour;`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
float scouredSnow = smoothstep(0.58, 0.98, vPostScour);
vec3 postSnowDust = vec3(0.48, 0.53, 0.55);
diffuseColor.rgb = mix(diffuseColor.rgb, postSnowDust, scouredSnow * 0.36);`,
      );
  };
  material.customProgramCacheKey = () => 'observation-post-patch-v1';
  return material;
}

export class ObservationPost {
  /**
   * @param {number} index    0-based, used for the callsign
   * @param {THREE.Vector3} position  world position on the terrain
   * @param {number} seed
   */
  constructor(index, position, seed) {
    this.index = index;
    this.id = `OP-${String.fromCharCode(65 + index)}`;
    this.callsign = POST_NAMES[index % POST_NAMES.length];
    this.position = position.clone();
    this.captured = false;
    this.bestScore = 0;
    this.photo = null;

    // Aim point sits above the ground so scoring and the HUD marker track the
    // camp as a whole rather than one corner of it.
    this.aimPoint = position.clone();
    this.aimPoint.y += GROUND_LIFT + 9;

    this.group = new THREE.Group();
    this.group.position.copy(position);

    const rand = rng(seed);
    const parts = [];

    const normal = terrainNormal(position.x, position.z, 14);
    const upSlope = Math.atan2(normal.x, normal.z);

    // Local ground height relative to the post origin, already lifted clear of
    // the clipmap mesh.
    const groundAt = (x, z) => terrainHeight(position.x + x, position.z + z) + GROUND_LIFT - position.y;

    // Main sangar: a broken ring of stone breastwork facing downslope. Built
    // heavier than a real one would be — at two kilometres a metre-high wall is
    // a single pixel, and the position has to be findable.
    for (let terrace = 0; terrace < 2; terrace++) {
      const count = terrace === 0 ? 18 : 14;
      const radius = terrace === 0 ? 25 : 19;
      for (let i = 0; i < count; i++) {
        const a = upSlope + Math.PI + (i / (count - 1) - 0.5) * Math.PI * 1.72;
        const r = radius * (0.93 + rand() * 0.14);
        const x = Math.cos(a) * r;
        const z = Math.sin(a) * r;
        const sy = (terrace === 0 ? 1.25 : 1.0) + rand() * 0.46;
        rockAt(
          parts,
          x,
          groundAt(x, z) + sy * 0.68,
          z,
          1.75 + rand() * 0.55,
          sy,
          1.35 + rand() * 0.45,
          a + rand() * 0.7,
          rand() > 0.48 ? STONE : STONE_DARK,
        );
      }
    }

    const sangarRadius = 14.5 + rand() * 1.8;
    for (let layer = 0; layer < 2; layer++) {
      const bags = layer === 0 ? 19 : 17;
      for (let i = 0; i < bags; i++) {
        const a = upSlope + Math.PI + (i / (bags - 1) - 0.5) * Math.PI * 1.48;
        const r = sangarRadius - layer * 0.45;
        const x = Math.cos(a) * r;
        const z = Math.sin(a) * r;
        sandbagAt(
          parts,
          x,
          groundAt(x, z) + 1.18 * (0.52 + layer * 0.78),
          z,
          3.55 + rand() * 0.35,
          1.18,
          1.7,
          a + Math.PI * 0.5,
          layer === 0 && rand() > 0.62 ? STONE_DARK : STONE,
        );
      }
    }

    // Dug-in shelter with split tarp roof, recessed entrance and rock shoulders.
    const bunkerAngle = upSlope + 0.12;
    const bx = Math.cos(upSlope) * 7.2;
    const bz = Math.sin(upSlope) * 7.2;
    const bGround = groundAt(bx, bz);
    boxAt(parts, bx, bGround + 1.75, bz, 14.8, 3.5, 8.8, bunkerAngle, STONE_DARK);
    roofPanelAt(
      parts,
      bx - Math.sin(bunkerAngle) * 3.55,
      bGround + 3.72,
      bz + Math.cos(bunkerAngle) * 3.55,
      7.6,
      9.5,
      bunkerAngle,
      0.11,
      TARP,
    );
    roofPanelAt(
      parts,
      bx + Math.sin(bunkerAngle) * 3.55,
      bGround + 3.72,
      bz - Math.cos(bunkerAngle) * 3.55,
      7.6,
      9.5,
      bunkerAngle,
      -0.11,
      TARP,
    );
    const entranceX = bx + Math.cos(upSlope + Math.PI) * 4.46;
    const entranceZ = bz + Math.sin(upSlope + Math.PI) * 4.46;
    boxAt(
      parts,
      entranceX,
      groundAt(entranceX, entranceZ) + 1.3,
      entranceZ,
      4.2,
      2.6,
      0.42,
      upSlope + Math.PI * 0.5,
      new THREE.Color(0x171918),
    );

    for (let i = 0; i < 12; i++) {
      const side = i % 2 === 0 ? -1 : 1;
      const along = -4.5 + (i / 11) * 9;
      const x =
        bx + Math.cos(bunkerAngle) * along + Math.cos(bunkerAngle + Math.PI * 0.5) * side * 6.8;
      const z =
        bz + Math.sin(bunkerAngle) * along + Math.sin(bunkerAngle + Math.PI * 0.5) * side * 6.8;
      rockAt(
        parts,
        x,
        groundAt(x, z) + 1.0,
        z,
        1.8 + rand() * 0.7,
        1.1 + rand() * 0.55,
        1.4 + rand() * 0.5,
        rand() * Math.PI,
        STONE,
      );
    }

    const cx = Math.cos(upSlope - 1.45) * 8.5;
    const cz = Math.sin(upSlope - 1.45) * 8.5;
    const canopyGround = groundAt(cx, cz);
    const lateral = new THREE.Vector2(-Math.sin(upSlope), Math.cos(upSlope));
    const forward = new THREE.Vector2(Math.cos(upSlope), Math.sin(upSlope));
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const px = cx + lateral.x * sx * 3.2 + forward.x * sz * 2.1;
        const pz = cz + lateral.y * sx * 3.2 + forward.y * sz * 2.1;
        cylinderAt(parts, px, groundAt(px, pz), pz, 0.11, 0.15, 3.5 + sz * 0.25, METAL, 5);
      }
    }
    roofPanelAt(parts, cx, canopyGround + 3.72, cz, 7.2, 5.0, upSlope, 0.08, TARP);

    // Antenna mast — the tallest feature, and the giveaway from the air.
    const ax = Math.cos(upSlope + 2.05) * 11.5;
    const az = Math.sin(upSlope + 2.05) * 11.5;
    const aGround = groundAt(ax, az);
    cylinderAt(parts, ax, aGround, az, 0.17, 0.31, 14, METAL, 7);
    boxAt(parts, ax, aGround + 13.6, az, 3.6, 0.18, 0.18, upSlope, METAL);
    boxAt(parts, ax, aGround + 13.6, az, 0.18, 0.18, 3.6, upSlope, METAL);
    const guyTop = new THREE.Vector3(ax, aGround + 11.8, az);
    for (let i = 0; i < 3; i++) {
      const a = upSlope + 0.45 + (i / 3) * Math.PI * 2;
      const gx = ax + Math.cos(a) * 8.5;
      const gz = az + Math.sin(a) * 8.5;
      cylinderBetween(
        parts,
        guyTop,
        new THREE.Vector3(gx, groundAt(gx, gz) + 0.18, gz),
        0.045,
        METAL,
        4,
      );
    }

    // Restrained stores supply occupation cues without becoming visual confetti.
    for (let i = 0; i < 6; i++) {
      const a = upSlope + 0.8 + rand() * Math.PI * 1.3;
      const r = 18 + rand() * 16;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      const g = groundAt(x, z);
      if (i < 4) boxAt(parts, x, g + 0.85, z, 2.3, 1.7, 1.9, rand() * Math.PI, CRATE);
      else cylinderAt(parts, x, g, z, 0.62, 0.62, 1.65, METAL, 8);
    }

    // Two broken approach tracks tie the compact structure to the scoured site.
    for (let i = 0; i < 2; i++) {
      const a = upSlope + Math.PI + (i - 0.5) * 0.66 + (rand() - 0.5) * 0.16;
      const length = 82 + rand() * 34;
      const steps = 6;
      for (let s = 0; s < steps; s++) {
        const t0 = 15 + (length * s) / steps;
        const wob = (rand() - 0.5) * 6;
        const x = Math.cos(a) * t0 + Math.cos(a + 1.57) * wob;
        const z = Math.sin(a) * t0 + Math.sin(a + 1.57) * wob;
        boxAt(
          parts,
          x,
          groundAt(x, z) + 0.24,
          z,
          4.0,
          0.48,
          length / steps + 3,
          a,
          new THREE.Color(0.075, 0.066, 0.056),
        );
      }
    }

    const merged = mergeGeometries(parts);
    const structures = new THREE.Mesh(
      merged,
      createStructureMaterial(),
    );
    structures.frustumCulled = false;
    this.group.add(structures);

    const patch = new THREE.Mesh(
      buildGroundPatch(position.x, position.y, position.z, POST_RADIUS, rand),
      createPatchMaterial(),
    );
    patch.frustumCulled = false;
    this.group.add(patch);

    this.structures = structures;
    this.patch = patch;
  }

  dispose() {
    this.structures.geometry.dispose();
    this.structures.material.dispose();
    this.patch.geometry.dispose();
    this.patch.material.dispose();
  }
}

/**
 * Minimal geometry merge. three.js ships BufferGeometryUtils for this, but all
 * the parts here share one attribute layout, so a dozen lines avoids pulling in
 * the addon and its edge cases.
 */
function mergeGeometries(list) {
  let vertexCount = 0;
  let indexCount = 0;
  for (const g of list) {
    vertexCount += g.attributes.position.count;
    indexCount += g.index ? g.index.count : g.attributes.position.count;
  }

  const position = new Float32Array(vertexCount * 3);
  const normal = new Float32Array(vertexCount * 3);
  const color = new Float32Array(vertexCount * 3);
  const wear = new Float32Array(vertexCount);
  const grounding = new Float32Array(vertexCount);
  const index = new Uint32Array(indexCount);

  let vOffset = 0;
  let iOffset = 0;
  for (const g of list) {
    const p = g.attributes.position;
    const n = g.attributes.normal;
    const c = g.attributes.color;
    const w = g.attributes.aWear;
    const ground = g.attributes.aGrounding;
    position.set(p.array, vOffset * 3);
    if (n) normal.set(n.array, vOffset * 3);
    if (c) color.set(c.array, vOffset * 3);
    if (w) wear.set(w.array, vOffset);
    if (ground) grounding.set(ground.array, vOffset);
    if (g.index) {
      for (let i = 0; i < g.index.count; i++) index[iOffset + i] = g.index.array[i] + vOffset;
      iOffset += g.index.count;
    } else {
      for (let i = 0; i < p.count; i++) index[iOffset + i] = i + vOffset;
      iOffset += p.count;
    }
    vOffset += p.count;
    g.dispose();
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(color, 3));
  geometry.setAttribute('aWear', new THREE.BufferAttribute(wear, 1));
  geometry.setAttribute('aGrounding', new THREE.BufferAttribute(grounding, 1));
  geometry.setIndex(new THREE.BufferAttribute(index, 1));
  geometry.computeBoundingSphere();
  return geometry;
}

// Fictional callsigns. Deliberately generic rather than evoking any real unit.
const POST_NAMES = ['RAVEN', 'SLATE', 'CINDER', 'HOLLOW', 'MARBLE', 'THISTLE'];
