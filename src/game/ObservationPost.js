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
  const indices = [];

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
    return positions.length / 3 - 1;
  };

  const centre = push(cx, cz, 0.2);
  let prevRing = null;
  for (let r = 1; r <= rings; r++) {
    const t = r / rings;
    const ring = [];
    for (let s = 0; s < segments; s++) {
      const a = (s / segments) * Math.PI * 2;
      // Irregular edge; a perfect circle reads as a decal.
      const wobble = 0.72 + 0.5 * rand();
      const rr = radius * t * wobble;
      ring.push(push(cx + Math.cos(a) * rr, cz + Math.sin(a) * rr, t));
    }
    for (let s = 0; s < segments; s++) {
      const n = (s + 1) % segments;
      if (r === 1) indices.push(centre, ring[s], ring[n]);
      else indices.push(prevRing[s], ring[s], ring[n], prevRing[s], ring[n], prevRing[n]);
    }
    prevRing = ring;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function boxAt(list, x, y, z, w, h, d, rotY, color) {
  const geometry = new THREE.BoxGeometry(w, h, d);
  geometry.rotateY(rotY);
  geometry.translate(x, y, z);
  const count = geometry.attributes.position.count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    colors[i * 3] = color.r;
    colors[i * 3 + 1] = color.g;
    colors[i * 3 + 2] = color.b;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  list.push(geometry);
}

function cylinderAt(list, x, y, z, rt, rb, h, color, segments = 7) {
  const geometry = new THREE.CylinderGeometry(rt, rb, h, segments);
  geometry.translate(x, y + h * 0.5, z);
  const count = geometry.attributes.position.count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    colors[i * 3] = color.r;
    colors[i * 3 + 1] = color.g;
    colors[i * 3 + 2] = color.b;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  list.push(geometry);
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
    const sangarRadius = 13 + rand() * 4;
    const blocks = 13;
    for (let i = 0; i < blocks; i++) {
      const a = upSlope + Math.PI + (i / blocks) * Math.PI * 1.55 - Math.PI * 0.78;
      const r = sangarRadius * (0.92 + rand() * 0.16);
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      const h = 2.6 + rand() * 1.5;
      boxAt(
        parts,
        x,
        groundAt(x, z) + h * 0.5,
        z,
        4.0 + rand() * 2.2,
        h,
        2.6 + rand() * 1.2,
        a + (rand() - 0.5) * 0.5,
        rand() > 0.55 ? STONE : STONE_DARK,
      );
    }

    // Dug-in shelter with a tarpaulin roof.
    const bx = Math.cos(upSlope) * 6.5;
    const bz = Math.sin(upSlope) * 6.5;
    const bGround = groundAt(bx, bz);
    boxAt(parts, bx, bGround + 2.2, bz, 13.5, 4.4, 8.5, upSlope + 0.2, STONE_DARK);
    boxAt(parts, bx, bGround + 4.7, bz, 14.6, 0.8, 9.6, upSlope + 0.2, TARP);

    // Antenna mast — the tallest feature, and the giveaway from the air.
    const ax = Math.cos(upSlope + 2.1) * 11;
    const az = Math.sin(upSlope + 2.1) * 11;
    const aGround = groundAt(ax, az);
    cylinderAt(parts, ax, aGround, az, 0.2, 0.34, 14, METAL, 6);
    boxAt(parts, ax, aGround + 14.1, az, 3.4, 0.24, 0.24, upSlope, METAL);
    boxAt(parts, ax, aGround + 14.1, az, 0.24, 0.24, 3.4, upSlope, METAL);

    // Stores, a second smaller sangar, and a fuel drum or two.
    for (let i = 0; i < 9; i++) {
      const a = rand() * Math.PI * 2;
      const r = 17 + rand() * 28;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      const g = groundAt(x, z);
      if (rand() > 0.45) {
        boxAt(parts, x, g + 1.1, z, 3.0, 2.2, 2.2, rand() * 3.14, CRATE);
      } else {
        cylinderAt(parts, x, g, z, 0.8, 0.8, 2.0, rand() > 0.5 ? CRATE : METAL, 8);
      }
    }

    // Approach tracks worn into the snow. Two or three dark lines running off
    // downslope are the classic aerial signature of an occupied position, and
    // they read from much further out than any structure.
    for (let i = 0; i < 3; i++) {
      const a = upSlope + Math.PI + (i - 1) * 0.55 + (rand() - 0.5) * 0.3;
      const length = 90 + rand() * 70;
      const width = 4.5 + rand() * 2;
      const steps = 7;
      for (let s = 0; s < steps; s++) {
        const t0 = 12 + (length * s) / steps;
        const wob = (rand() - 0.5) * 9;
        const x = Math.cos(a) * t0 + Math.cos(a + 1.57) * wob;
        const z = Math.sin(a) * t0 + Math.sin(a + 1.57) * wob;
        boxAt(
          parts,
          x,
          groundAt(x, z) + 0.35,
          z,
          width,
          0.7,
          length / steps + 5,
          a,
          new THREE.Color(0.075, 0.066, 0.056),
        );
      }
    }

    const merged = mergeGeometries(parts);
    const structures = new THREE.Mesh(
      merged,
      new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.94,
        metalness: 0.04,
        flatShading: true,
      }),
    );
    structures.frustumCulled = false;
    this.group.add(structures);

    const patch = new THREE.Mesh(
      buildGroundPatch(position.x, position.y, position.z, POST_RADIUS, rand),
      new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 1.0,
        metalness: 0,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -4,
      }),
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
  const index = new Uint32Array(indexCount);

  let vOffset = 0;
  let iOffset = 0;
  for (const g of list) {
    const p = g.attributes.position;
    const n = g.attributes.normal;
    const c = g.attributes.color;
    position.set(p.array, vOffset * 3);
    if (n) normal.set(n.array, vOffset * 3);
    if (c) color.set(c.array, vOffset * 3);
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
  geometry.setIndex(new THREE.BufferAttribute(index, 1));
  geometry.computeBoundingSphere();
  return geometry;
}

// Fictional callsigns. Deliberately generic rather than evoking any real unit.
const POST_NAMES = ['RAVEN', 'SLATE', 'CINDER', 'HOLLOW', 'MARBLE', 'THISTLE'];
