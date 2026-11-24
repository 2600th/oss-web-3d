import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CATALOG, ASSET_IDS } from './catalog.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PUBLIC = path.join(ROOT, 'public');

/** Node names from a GLB's JSON chunk (no decoding of meshopt buffers needed). */
function glbNodeNames(file) {
  const buf = readFileSync(file);
  assert.equal(buf.readUInt32LE(0), 0x46546c67, `${file} is not a GLB`);
  const len = buf.readUInt32LE(12);
  assert.equal(buf.readUInt32LE(16), 0x4e4f534a, `${file}: first chunk is not JSON`);
  const json = JSON.parse(buf.subarray(20, 20 + len).toString('utf8'));
  return { names: new Set((json.nodes ?? []).map((n) => n.name)), json };
}

const PLANNED = ['mig21', 'mig21_hostile', 'aam_ir', 'sam', 'rocket', 'bomb', 'flare', 'sam_launcher', 'aaa_gun', 'radar',
  'truck', 'bunker', 'tent', 'supply_dump', 'helipad'];

// LOD0 triangle budgets per kind
const BUDGET = { missile: 2000, rocket: 2000, bomb: 2000, flare: 500, pod: 3000, aaa: 8000, sam_site: 8000, radar: 8000,
  vehicle: 12000, artillery: 8000, helicopter: 8000, camp: 8000, position: 10000, base: 10000, cockpit: 40000, aircraft: 250000,
  pilot: 18000 };

test('every planned asset id exists', () => {
  for (const id of PLANNED) assert.ok(CATALOG[id], `missing ${id}`);
});

test('every catalog URL exists on disk', () => {
  for (const id of ASSET_IDS) {
    const e = CATALOG[id];
    assert.ok(e.url && !e.url.startsWith('/'), `${id}: url must be relative to the site base`);
    const urls = new Set([e.url, ...(e.lods ?? []).map((l) => l.url)]);
    for (const u of urls) {
      const f = path.join(PUBLIC, u);
      assert.ok(existsSync(f), `${id}: ${u} not found`);
    }
    for (const l of e.lods ?? []) {
      if (l.bytes) assert.equal(statSync(path.join(PUBLIC, l.url)).size, l.bytes, `${id}: ${l.url} size changed - rerun write-catalog`);
    }
  }
});

test('entries carry the contract fields', () => {
  for (const id of ASSET_IDS) {
    const e = CATALOG[id];
    assert.equal(e.scale, 1, `${id}: scale must be baked (1)`);
    assert.ok(Array.isArray(e.sockets), `${id}: sockets array`);
    assert.equal(typeof e.kind, 'string', `${id}: kind`);
    assert.equal(typeof e.notes, 'string', `${id}: notes`);
    if (e.destroyed) assert.ok(CATALOG[e.destroyed], `${id}: destroyed variant ${e.destroyed} missing`);
  }
});

test('sockets and pivots are real nodes in every LOD', () => {
  for (const id of ASSET_IDS) {
    const e = CATALOG[id];
    for (const l of e.lods ?? [{ url: e.url }]) {
      const { names } = glbNodeNames(path.join(PUBLIC, l.url));
      for (const s of e.sockets) {
        if (e.socketPositions?.[s]) continue; // added by loadModel
        assert.ok(names.has(s), `${id}: socket ${s} missing in ${l.url}`);
      }
      for (const p of e.pivots ?? []) assert.ok(names.has(p), `${id}: pivot ${p} missing in ${l.url}`);
    }
  }
});

test('weapons have a motor/tail socket, turrets have their named pivots', () => {
  for (const id of ['aam_ir', 'aam_hobs', 'aam_long', 'sam', 'sam_large', 'rocket', 'flare']) assert.ok(CATALOG[id].sockets.includes('nozzle'), id);
  assert.ok(CATALOG.bomb.sockets.includes('tail'));
  assert.deepEqual([...CATALOG.aaa_gun.pivots].sort(), ['barrels', 'turret']);
  assert.ok(CATALOG.aaa_gun.sockets.includes('muzzle_L') && CATALOG.aaa_gun.sockets.includes('muzzle_R'));
  assert.ok(CATALOG.sam_launcher.pivots.includes('launcher'));
  assert.ok(CATALOG.radar.pivots.includes('dish'));
});

test('triangle budgets hold', () => {
  for (const id of ASSET_IDS) {
    const e = CATALOG[id];
    const b = BUDGET[e.kind];
    if (!b || !e.lods?.[0]?.triangles) continue;
    assert.ok(e.lods[0].triangles <= b, `${id}: ${e.lods[0].triangles} tris > ${b} budget for ${e.kind}`);
    if (e.lods[1]) assert.ok(e.lods[1].triangles < e.lods[0].triangles, `${id}: LOD1 not lighter`);
  }
  assert.ok(CATALOG.mig21_hostile.lods[1].triangles <= 25000, 'mig21_hostile LOD1 over 25k');
});

test('models are meshopt-compressed and in metres (bounds sane)', () => {
  for (const id of ASSET_IDS) {
    const e = CATALOG[id];
    if (e.kind === 'base' || id === 'mig21') continue;
    const { json } = glbNodeNames(path.join(PUBLIC, e.url));
    assert.ok((json.extensionsUsed ?? []).includes('EXT_meshopt_compression'), `${id}: not meshopt-compressed`);
    if (e.bounds?.min) {
      const size = e.bounds.max.map((v, i) => v - e.bounds.min[i]);
      assert.ok(Math.max(...size) < 30 && Math.max(...size) > 0.05, `${id}: implausible size ${size}`);
    }
  }
});
