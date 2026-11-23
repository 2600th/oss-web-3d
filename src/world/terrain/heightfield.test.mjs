// CPU heightfield: pack round trip, determinism, continuity across the seams,
// rivers, and the legacy bare-grid initialiser other areas' tests rely on.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { encodePlane, readPack } from '../../../tools/terrain/pack.mjs';
import { decodeRaw } from './pack.js';
import { inflateSync } from 'node:zlib';
import * as hf from './heightfield.js';
import { INNER_BLEND, AMP_MAX } from './detail.js';

const packPath = new URL('../../../public/assets/terrain/kargil-lo.stp', import.meta.url);
const pack = readPack(readFileSync(packPath));

test('pack encodings round-trip', () => {
  const w = 37;
  const h = 23;
  const u16 = new Uint16Array(w * h).map((_, i) => (i * 7919 + (i % w) * 311) & 0xffff);
  const u8 = new Uint8Array(w * h).map((_, i) => (i * 131) & 255);
  for (const [enc, data] of [['delta16', u16], ['delta8', u8], ['raw8', u8]]) {
    const back = decodeRaw(inflateSync(encodePlane(data, w, h, enc)), w, h, enc);
    assert.deepEqual(Array.from(back), Array.from(data), enc);
  }
});

test('pack matches the manifest', () => {
  const manifest = JSON.parse(readFileSync(new URL('../../../public/assets/terrain/dem.json', import.meta.url), 'utf8'));
  const lo = manifest.packs.find((p) => p.id === 'lo');
  assert.equal(createHash('sha256').update(readFileSync(packPath)).digest('hex'), lo.sha256);
  assert.equal(pack.meta.resolution, lo.resolution);
  for (const name of ['height', 'river', 'flowx', 'flowz', 'ao', 'drain', 'outer', 'tile']) assert.ok(pack.planes[name], name);
});

test('terrainHeight is deterministic and inside the expected range', () => {
  hf.initTerrain(pack.meta, pack.planes);
  const sample = () => {
    const out = [];
    let s = 12345;
    const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) | 0; return (s >>> 0) / 4294967296; };
    for (let i = 0; i < 4000; i++) out.push(hf.terrainHeight((rnd() - 0.5) * 300000, (rnd() - 0.5) * 300000));
    return out;
  };
  const a = sample();
  hf.initTerrain(pack.meta, pack.planes); // re-initialising must not change anything
  const b = sample();
  assert.deepEqual(a, b);
  for (const v of a) assert.ok(Number.isFinite(v) && v > 500 && v < 9000, `height ${v}`);
});

test('detail stays within its amplitude and vanishes on river beds', () => {
  hf.initTerrain(pack.meta, pack.planes);
  let worst = 0;
  for (let i = 0; i < 5000; i++) {
    const d = hf.detailHeight(i * 37.7 - 40000, i * 19.3 - 30000);
    worst = Math.max(worst, Math.abs(d));
  }
  assert.ok(worst < 1.9, `detail field peak ${worst}`); // the culling boxes assume < 1.9 * AMP_MAX
  assert.ok(AMP_MAX * worst < 20);
  // find water and check the surface is level across the channel
  let found = 0;
  let checks = 0;
  let level = 0;
  for (let x = -20000; x < 20000 && found < 20; x += 61) for (let z = -20000; z < 20000 && found < 20; z += 61) {
    if (hf.riverEdge(x, z) > -10) continue;
    found++;
    const h0 = hf.terrainHeight(x, z);
    assert.equal(hf.waterHeight(x, z), h0);
    assert.ok(hf.isWater(x, z));
    for (const [dx, dz] of [[4, 0], [-4, 0], [0, 4], [0, -4]]) {
      if (hf.riverEdge(x + dx, z + dz) > -8) continue;
      const dh = Math.abs(hf.terrainHeight(x + dx, z + dz) - h0);
      checks++;
      if (dh < 0.3) level++;
      assert.ok(dh < 6, 'water steps ' + dh.toFixed(2) + ' m within 4 m'); // confluences may drop a little
    }
  }
  assert.ok(found > 0, 'no river found');
  assert.ok(level / checks > 0.9, 'only ' + level + '/' + checks + ' neighbouring water samples are level');
  assert.equal(hf.waterHeight(1e6, 1e6), -Infinity);
});

test('no step at the DEM edge, the outer edge or far outside', () => {
  hf.initTerrain(pack.meta, pack.planes);
  const D = hf.DEM;
  const lines = [
    [D.minX - 3000, 1234, D.minX + INNER_BLEND + 3000, 1234], // across the inner seam
    [4321, D.maxZ + 3000, 4321, D.maxZ - INNER_BLEND - 3000],
    [D.outerMinX - 12000, -2000, D.outerMinX + 12000, -2000], // across the outer seam
    [-250000, 180000, 250000, -190000], // right across the world
  ];
  for (const [x0, z0, x1, z1] of lines) {
    const len = Math.hypot(x1 - x0, z1 - z0);
    const n = Math.ceil(len / 2);
    let prev = hf.terrainHeight(x0, z0);
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      const h = hf.terrainHeight(x0 + (x1 - x0) * t, z0 + (z1 - z0) * t);
      // 2 m steps: cliffs and outcrop ledges are near-vertical, a seam fault would be far larger
      assert.ok(Math.abs(h - prev) < 30, `step of ${(h - prev).toFixed(1)} m at t=${t.toFixed(4)}`);
      prev = h;
    }
  }
});

test('queries agree with the height function', () => {
  hf.initTerrain(pack.meta, pack.planes);
  const x = -14000;
  const z = 6000;
  const ground = hf.terrainHeight(x, z);
  const d = hf.raycastTerrain(x, ground + 800, z, 0, -1, 0);
  assert.ok(Math.abs(d - 800) < 0.5, `straight-down ray hit at ${d}`);
  assert.equal(hf.raycastTerrain(x, ground + 800, z, 0, 1, 0, 5000), Infinity);
  assert.ok(hf.lineOfSight({ x, y: ground + 50, z }, { x: x + 10, y: ground + 60, z }));
  assert.ok(!hf.lineOfSight({ x, y: ground + 50, z }, { x, y: ground - 50, z }));
  assert.ok(hf.maxHeightAlong(x, z, x + 3000, z + 3000, 32) >= ground);
  const n = { set(a, b, c) { this.v = [a, b, c]; return this; }, normalize() { const l = Math.hypot(...this.v); this.v = this.v.map((q) => q / l); return this; } };
  hf.terrainNormal(x, z, n);
  assert.ok(n.v[1] > 0.2 && Math.abs(Math.hypot(...n.v) - 1) < 1e-9);
});

test('initDEM still accepts a bare grid of metres', () => {
  const res = 5;
  const u16 = new Uint16Array(res * res).fill(3000);
  u16[12] = 3400;
  hf.initDEM({ resolution: res, worldBounds: { minX: -20000, maxX: 20000, minZ: -20000, maxZ: 20000 }, cellMetres: [10000, 10000], heightMin: 3000, heightMax: 3400 }, u16);
  assert.equal(hf.terrainHeight(0, 0), 3400);
  assert.equal(hf.terrainHeight(-10000, -10000), 3000);
  assert.ok(Math.abs(hf.terrainHeight(5000, 0) - 3200) < 1e-6);
  assert.equal(hf.riverEdge(0, 0), 1e9);
});
