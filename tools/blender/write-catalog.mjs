/**
 * Generate src/assets/catalog.js from what is actually on disk:
 *   - assets/authoring/build/manifest/<id>.json (written by build_assets.py)
 *   - the MiG-21 family (counted here from the GLBs)
 *   - the base kit in public/assets/bases/catalog.json
 *
 *   node tools/blender/write-catalog.mjs
 *
 * The manifest directory is a build product; when it is missing (fresh clone)
 * the previous catalog.js values are kept for those ids.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { io, countTriangles } from './gltf-pipeline.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = path.join(ROOT, 'src/assets/catalog.js');
const MAN = path.join(ROOT, 'assets/authoring/build/manifest');
const rel = (p) => p.replace(/^\/+/, '');

// LOD switch distances (metres, camera to object) per kind.
const LOD_DISTANCE = { aaa: 260, sam_site: 260, radar: 300, vehicle: 260, artillery: 260, position: 220, camp: 220, helicopter: 400, base: 0 };

let previous = {};
if (existsSync(OUT)) {
  try {
    previous = (await import(pathToFileURL(OUT).href + '?t=' + Date.now())).CATALOG;
  } catch {}
}

const catalog = {};

async function glbStats(url) {
  const file = path.join(ROOT, 'public', url);
  const doc = await io.read(file);
  return { url, triangles: countTriangles(doc), bytes: statSync(file).size };
}

// ---------------------------------------------------------------- MiG-21 family
// Sockets in aircraft model space (three: +X right, +Y up, nose -Z), matching
// src/flight/Aircraft.js except `eye`, which is the measured pilot eye point.
const MIG_SOCKETS = {
  eye: [0, 0.22, -2.95],
  hud: [0, 0.212, -3.364],
  nozzle: [0, 0.05, 7.58],
  wingtipL: [-3.64, -0.777, 2.74], // measured tip (tools/blender/probe_lamps.py); was the bbox guess [-3.516, -0.05, 1.6]
  wingtipR: [3.64, -0.777, 2.74],
  gun: [0, -0.6, -2.5],
};
// Moving surfaces cut by tools/blender/build_mig_surfaces.py and (rudder, airbrakes)
// tools/blender/build_mig_moving.mjs; each turns on rotation.x on its hinge line.
const MIG_SURFACES = ['stab_L', 'stab_R', 'aileron_L', 'aileron_R', 'flap_L', 'flap_R', 'rudder', 'airbrake_L', 'airbrake_R'];
const MIG_SURFACE_NOTE = 'stab_L/R, aileron_L/R, flap_L/R turn on rotation.x, + = trailing edge down; rudder (+ = trailing ' +
  'edge right) and airbrake_L/R (+ = open) turn on rotation.x under fixed `<name>_hinge` frames.';
const MIG_ATTR ='CC BY 4.0 - derivative of "MiG-21 Bison Indian (War Thunder)" by KojfDiscord (Sketchfab); see public/THIRD_PARTY_NOTICES.txt';
catalog.mig21 = {
  url: 'models/mig21.glb',
  lods: [await glbStats('models/mig21.glb')],
  scale: 1,
  sockets: Object.keys(MIG_SOCKETS),
  socketPositions: MIG_SOCKETS,
  pivots: MIG_SURFACES,
  kind: 'aircraft',
  license: MIG_ATTR,
  notes:
    'Player airframe (IAF markings). Baked to conventions (metres, nose -Z, origin at bbox centre; root node `mig21` ' +
    'has extras.baked). Control surfaces on pivot nodes: ' + MIG_SURFACE_NOTE + ' Contains a full cockpit interior; ' +
    'named meshes: cockpit_interior, cockpit_seat, canopy_glass, airframe. Built by tools/blender/build_mig_surfaces.py.',
};
catalog.mig21_hostile = {
  url: 'models/mig21_hostile.glb',
  lods: [
    { ...(await glbStats('models/mig21_hostile.glb')), distance: 0 },
    { ...(await glbStats('models/mig21_hostile_lod1.glb')), distance: 600 },
  ],
  scale: 1,
  sockets: Object.keys(MIG_SOCKETS).filter((s) => s !== 'eye' && s !== 'hud'),
  socketPositions: MIG_SOCKETS,
  pivots: MIG_SURFACES,
  kind: 'aircraft',
  license: MIG_ATTR,
  notes:
    'Enemy MiG-21: same airframe, fictional dark two-tone grey, no national markings. Baked to conventions (metres, nose -Z, ' +
    'origin at bbox centre). Both LODs have the control-surface pivots (' + MIG_SURFACE_NOTE + ') LOD1 (<= 25k tris, no small ' +
    'detail, 512 px) for distant enemies; it has small decimation notches around the intake lip.',
};
catalog.mig21_cockpit = {
  url: 'models/mig21_cockpit.glb',
  lods: [await glbStats('models/mig21_cockpit.glb')],
  scale: 1,
  sockets: ['eye', 'hud'],
  kind: 'cockpit',
  license: 'MIT',
  notes:
    'First-person overlay for the player MiG: emissive MFD/aux display faces, canopy periscope, `eye` and `hud` sockets. ' +
    'Parent to aircraft.model (identity transform). The interior itself is part of mig21.glb. Use camera near <= 0.05 m in cockpit view.',
};

// ---------------------------------------------------------------- procedural props
const manifests = existsSync(MAN) ? readdirSync(MAN).filter((f) => f.endsWith('.json')) : [];
for (const f of manifests.sort()) {
  const m = JSON.parse(readFileSync(path.join(MAN, f), 'utf8'));
  const lods = m.lods.map((l, i) => ({ url: rel(l.url), triangles: l.triangles, bytes: l.bytes, distance: i === 0 ? 0 : LOD_DISTANCE[m.kind] ?? 250 }));
  catalog[m.id] = {
    url: lods[0].url,
    lods,
    scale: 1,
    sockets: m.sockets,
    pivots: m.pivots,
    kind: m.kind,
    bounds: m.bounds,
    license: 'MIT',
    notes: m.notes,
  };
}
for (const [id, e] of Object.entries(previous)) {
  if (!catalog[id] && !id.startsWith('base_')) catalog[id] = e; // keep entries whose manifest is not present locally
}
for (const id of Object.keys(catalog)) {
  if (catalog[`${id}_destroyed`]) catalog[id].destroyed = `${id}_destroyed`;
}

// ---------------------------------------------------------------- base kit
const bases = JSON.parse(readFileSync(path.join(ROOT, 'public/assets/bases/catalog.json'), 'utf8'));
for (const a of bases.assets) {
  catalog[`base_${a.id}`] = {
    url: rel(a.lods[0].url),
    lods: a.lods.map((l) => ({ url: rel(l.url), triangles: l.triangles, bytes: l.bytes, projectedSize: l.projectedSize })),
    scale: 1,
    sockets: [],
    kind: 'base',
    bounds: a.bounds,
    license: a.license,
    notes: `Airbase/ridge base layout "${a.id}" from public/assets/bases/catalog.json (${a.attribution}). LODs switch by projectedSize.`,
  };
}

const ids = Object.keys(catalog);
const body = JSON.stringify(catalog, null, 2)
  .replace(/\[\s*([^\[\]{}]*?)\s*\]/g, (_, inner) => `[${inner.split(/,\s*/).join(', ')}]`) // inline flat arrays
  .replace(/"([a-zA-Z_][a-zA-Z0-9_]*)":/g, '$1:');
writeFileSync(
  OUT,
  `// GENERATED by tools/blender/write-catalog.mjs - do not edit by hand.\n` +
    `// Asset catalogue: id -> GLB url(s) relative to the site base, metres, +Y up, front -Z.\n` +
    `// sockets: Object3D names inside the model (or socketPositions the loader adds).\n` +
    `// pivots: animatable nodes (turret/dish = rotation.y, barrels/barrel/launcher = rotation.x, +x = elevate).\n` +
    `/* eslint-disable */\n` +
    `export const CATALOG = ${body};\n\n` +
    `export const ASSET_IDS = Object.keys(CATALOG);\n` +
    `export default CATALOG;\n`,
);
console.log(`wrote ${path.relative(ROOT, OUT)} with ${ids.length} ids`);
let total = 0;
const seen = new Set();
for (const e of Object.values(catalog)) for (const l of e.lods) if (!seen.has(l.url)) { seen.add(l.url); total += l.bytes; }
console.log(`total bytes referenced: ${(total / 1048576).toFixed(2)} MB in ${seen.size} files`);
