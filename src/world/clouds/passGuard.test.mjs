import test from 'node:test';
import assert from 'node:assert/strict';
import { Group, Mesh, BoxGeometry, MeshBasicMaterial, Points, Object3D } from 'three';
import { PassGuard, brokenRenderables } from './passGuard.js';

test('brokenRenderables names meshes whose geometry went missing', () => {
  const scene = new Group();
  scene.name = 'scene';
  const terrain = new Group();
  terrain.name = 'terrain';
  scene.add(terrain);
  const ok = new Mesh(new BoxGeometry(), new MeshBasicMaterial());
  const trim = new Mesh(new BoxGeometry(), new MeshBasicMaterial());
  trim.name = 'trim3';
  trim.geometry = undefined; // what Terrain.update did with a NaN camera: trimGeo[NaN]
  const pts = new Points();
  pts.geometry = null;
  terrain.add(ok, trim, new Object3D());
  scene.add(pts);
  assert.deepEqual(brokenRenderables(scene), ['scene/terrain/trim3', 'scene/Points']);
  assert.deepEqual(brokenRenderables(null), []);
  assert.deepEqual(brokenRenderables(new Group()), []);
});

test('PassGuard: one warning per power of two, exponential skip, reset on success', () => {
  const lines = [];
  const g = new PassGuard('clouds', { warn: (m) => lines.push(m), maxSkip: 8 });
  const scene = new Group();
  const bad = new Mesh();
  bad.name = 'bad';
  bad.geometry = undefined;
  scene.add(bad);
  const err = new TypeError("Cannot read properties of undefined (reading 'boundingSphere')");

  // a persistent fault: run the pass whenever the guard allows, fail every time
  const ran = [];
  for (let frame = 0; frame < 60; frame++) {
    if (!g.ready()) continue;
    ran.push(frame);
    g.fail(err, scene);
  }
  // backoff 1, 2, 4, 8, 8 ...: attempts get sparse instead of every frame
  assert.deepEqual(ran.slice(0, 5), [0, 2, 5, 10, 19]);
  assert.equal(ran.length, 9, `${ran.length} attempts in 60 frames`);
  // warned on failures 1, 2, 4 and 8 only, never per frame
  assert.equal(lines.length, 4, lines.join('\n'));
  assert.match(lines[0], /boundingSphere/);
  assert.match(lines[0], /Renderables without geometry: Group\/bad/);
  assert.match(lines[2], /1 similar failures not logged/);

  // recovery: a clean frame drops the backoff, the next failure skips one frame only
  while (!g.ready());
  g.ok();
  g.fail(err, scene);
  assert.equal(g.ready(), false);
  assert.equal(g.ready(), true);
});
