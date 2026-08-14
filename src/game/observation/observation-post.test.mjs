import assert from 'node:assert/strict';
import * as THREE from 'three';
import { ObservationPost, POST_HEIGHT, POST_RADIUS } from '../ObservationPost.js';
import { terrainHeight } from '../../world/heightfield.js';

const world = new THREE.Vector3(21000, terrainHeight(21000, 6000), 6000);
const a = new ObservationPost(2, world, 0x1234abcd);
const b = new ObservationPost(2, world, 0x1234abcd);

assert.equal(a.id, 'OP-C');
assert.equal(a.callsign, 'CINDER');
assert.equal(a.captured, false);
assert.equal(a.bestScore, 0);
assert.equal(a.photo, null);
assert.deepEqual(a.position.toArray(), world.toArray());
assert.deepEqual(a.aimPoint.toArray(), [world.x, world.y + 13, world.z]);
assert.equal(POST_RADIUS, 58);
assert.equal(POST_HEIGHT, 16);
assert.equal(a.group.children.length, 2, 'installation must remain a two-draw merged assembly');
assert.equal(a.structures.isMesh, true);
assert.equal(a.patch.isMesh, true);

const geometry = a.structures.geometry;
const triangles = geometry.index.count / 3;
assert.ok(triangles >= 1600, `recon payoff needs modeled silhouette detail, got ${triangles} triangles`);
assert.ok(triangles <= 6500, `five posts must stay bounded, got ${triangles} triangles each`);
assert.ok(geometry.attributes.aWear, 'merged structures need deterministic weathering data');
assert.ok(geometry.attributes.aGrounding, 'contact shading must be primitive-relative on steep terrain');
assert.ok(a.patch.geometry.attributes.aScour, 'terrain patch needs snow-scour data');

const grounding = geometry.attributes.aGrounding.array;
assert.ok(Math.min(...grounding) <= 0.01 && Math.max(...grounding) >= 0.99, 'ground contact data must span base to top');
const uniqueColors = new Set(Array.from(geometry.attributes.color.array, (value) => value.toFixed(4)));
assert.ok(uniqueColors.size > 32, 'procedural PBR tint must avoid flat placeholder colors');

assert.deepEqual(
  Array.from(a.structures.geometry.attributes.position.array),
  Array.from(b.structures.geometry.attributes.position.array),
  'the same seed and world site must build bit-identical geometry',
);
assert.deepEqual(
  Array.from(a.structures.geometry.attributes.color.array),
  Array.from(b.structures.geometry.attributes.color.array),
  'weathering variation must be deterministic',
);

const bounds = new THREE.Box3().setFromBufferAttribute(geometry.attributes.position);
assert.ok(bounds.max.y - bounds.min.y >= POST_HEIGHT - 1, 'antenna must preserve the readable tall silhouette');
assert.ok(bounds.max.x - bounds.min.x >= 45 && bounds.max.z - bounds.min.z >= 45, 'terraces must read as an installation footprint');

{
  const sites = [
    [21000, 6000, 0x1234abcd],
    [-12000, -18000, 1],
    [40000, 27000, 99],
    [-35000, 42000, 12345],
  ];
  for (const [x, z, seed] of sites) {
    const site = new THREE.Vector3(x, terrainHeight(x, z), z);
    const post = new ObservationPost(0, site, seed);
    const patch = post.patch.geometry;
    const position = patch.attributes.position;
    const index = patch.index;
    let upward = 0;
    for (let offset = 0; offset < index.count; offset += 3) {
      const ia = index.getX(offset);
      const ib = index.getX(offset + 1);
      const ic = index.getX(offset + 2);
      const ax = position.getX(ia);
      const az = position.getZ(ia);
      const bx = position.getX(ib);
      const bz = position.getZ(ib);
      const cx = position.getX(ic);
      const cz = position.getZ(ic);
      const projectedCrossY = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
      if (projectedCrossY > 1e-5) upward++;
    }
    assert.equal(
      upward,
      index.count / 3,
      `all footprint triangles must face an aerial camera at site ${x},${z}`,
    );

    const segments = 26;
    const rings = 6;
    for (let segment = 0; segment < segments; segment++) {
      let previousRadius = 0;
      for (let ring = 0; ring < rings; ring++) {
        const vertex = 1 + ring * segments + segment;
        const radius = Math.hypot(position.getX(vertex), position.getZ(vertex));
        assert.ok(
          radius > previousRadius + 1e-4,
          `footprint rings must remain monotonic at site ${x},${z}, bearing ${segment}`,
        );
        assert.ok(
          radius <= POST_RADIUS + 1e-4,
          `footprint vertex must remain inside POST_RADIUS at site ${x},${z}`,
        );
        previousRadius = radius;
      }
    }
    post.dispose();
  }
}

{
  const shader = {
    vertexShader: '#include <common>\n#include <defaultnormal_vertex>\n#include <worldpos_vertex>',
    fragmentShader: '#include <common>\n#include <color_fragment>\n#include <roughnessmap_fragment>',
  };
  a.structures.material.onBeforeCompile(shader);
  assert.match(shader.fragmentShader, /postSnow/);
  assert.match(shader.fragmentShader, /postWeather/);
  assert.match(shader.fragmentShader, /contactGrounding/);
  assert.match(shader.vertexShader, /vPostWorldNormal/);
}

{
  const shader = {
    vertexShader: '#include <common>\n#include <worldpos_vertex>',
    fragmentShader: '#include <common>\n#include <color_fragment>',
  };
  a.patch.material.onBeforeCompile(shader);
  assert.match(shader.fragmentShader, /scouredSnow/);
}

let disposals = 0;
for (const post of [a, b]) {
  post.structures.geometry.addEventListener('dispose', () => disposals++);
  post.structures.material.addEventListener('dispose', () => disposals++);
  post.patch.geometry.addEventListener('dispose', () => disposals++);
  post.patch.material.addEventListener('dispose', () => disposals++);
  post.dispose();
}
assert.equal(disposals, 8, 'all owned GPU resources must dispose exactly once');

console.log('observation-post contracts passed');
