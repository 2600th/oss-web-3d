import { terrainHeight, isWater, DEM } from '../../terrain/heightfield.js';

/**
 * What the light sprites are attached to: aircraft navigation lights, vehicle
 * headlights and the valley villages. Pure placement; drawing is LightSprites.
 */

const RED = [1, 0.07, 0.04];
const GREEN = [0.05, 1, 0.32];
const WHITE = [1, 0.95, 0.86];
const WARM = [1, 0.62, 0.3];

/**
 * Lamp positions on the MiG-21 (mig21.glb and mig21_hostile*.glb share the
 * airframe), measured on the mesh with tools/blender/probe_lamps.py, in model
 * space (nose -Z, right +X, up +Y, metres). Each sprite sits ~2.5 cm proud of
 * its lens so the lens itself does not hide it, and the airframe does:
 *   wing lenses   (±2.81, -0.746, 1.419), in the leading edge 0.86 m inboard
 *                 of the tip (the tip itself is x ±3.666, y -0.78)
 *   tail lens     (0, 1.704, 7.635), the top of the fin trailing edge
 *   spine         skin top y 0.381 at z 1.2 (no lens on the mesh)
 *   belly         skin bottom y -1.444 at z 3.0, aft of the centreline tank
 * The old defaults (wing ±3.52, -0.05, 1.6; spine y 0.95; belly inside the
 * fuselage) floated 0.7 m above and ahead of the wing and 0.55 m over the spine.
 */
export const MIG21_LAMPS = {
  wing: [2.81, -0.746, 1.395],
  tail: [0, 1.704, 7.66],
  spine: [0, 0.405, 1.2],
  belly: [0, -1.47, 3.0],
};

/**
 * Navigation lights for an airframe in model conventions (nose -Z, right +X,
 * up +Y, metres): red on the left wing, green on the right, white on the
 * tail, a red anti-collision beacon on the spine and a white belly strobe.
 * Defaults fit the MiG-21 (MIG21_LAMPS). By day the steady lights are a small
 * lit point (daySize 0.25, 12% intensity); the beacon and strobe still flash.
 */
export function attachNavLights(sprites, object3d, {
  wing = MIG21_LAMPS.wing, tail = MIG21_LAMPS.tail, spine = MIG21_LAMPS.spine, belly = MIG21_LAMPS.belly,
  intensity = 1, phase = Math.random(),
} = {}) {
  const base = { object3d, group: object3d, day: 0.12, daySize: 0.25, radius: 0.15, minPx: 1.5, range: 14000 };
  const flash = { day: 0.6, daySize: 0.5, minPx: 1.8, range: 20000 };
  // Emission lobes (as on a real aircraft: each wing light covers forward
  // through its own side, the tail light aft, the beacons up / down). They
  // also stop a lamp from showing across the airframe: the green light seen
  // over the spine from the left was the sprite of a lamp the jet hides.
  const wingLobe = (sx) => ({ dir: { x: sx * 0.82, y: 0, z: -0.57 }, cone: -0.2 });
  return [
    sprites.add({ ...base, ...wingLobe(-1), offset: { x: -wing[0], y: wing[1], z: wing[2] }, color: RED, intensity: 5 * intensity }),
    sprites.add({ ...base, ...wingLobe(1), offset: { x: wing[0], y: wing[1], z: wing[2] }, color: GREEN, intensity: 4.5 * intensity }),
    sprites.add({ ...base, dir: { x: 0, y: 0.3, z: 1 }, cone: -0.1, offset: { x: tail[0], y: tail[1], z: tail[2] }, color: WHITE, intensity: 3 * intensity, radius: 0.12 }),
    sprites.add({ ...base, ...flash, dir: { x: 0, y: 1, z: 0 }, cone: -0.15, offset: { x: spine[0], y: spine[1], z: spine[2] }, color: RED, intensity: 8 * intensity, radius: 0.2, blink: { period: 1.3, phase, kind: 'beacon' } }),
    sprites.add({ ...base, ...flash, dir: { x: 0, y: -1, z: 0 }, cone: -0.15, offset: { x: belly[0], y: belly[1], z: belly[2] }, color: WHITE, intensity: 9 * intensity, radius: 0.18, blink: { period: 1.3, phase: phase + 0.5, kind: 'strobe' } }),
  ].filter(Boolean);
}

/** Two warm headlights (and two dim red tail lamps) for a ground vehicle, nose -Z. */
export function attachHeadlights(sprites, object3d, { halfWidth = 0.85, height = 1.05, front = -2.7, rear = 2.9, intensity = 1 } = {}) {
  const base = { object3d, group: object3d, day: 0.05, radius: 0.22, minPx: 1.4, range: 16000 };
  return [
    sprites.add({ ...base, offset: { x: -halfWidth, y: height, z: front }, color: [1, 0.86, 0.62], intensity: 14 * intensity }),
    sprites.add({ ...base, offset: { x: halfWidth, y: height, z: front }, color: [1, 0.86, 0.62], intensity: 14 * intensity }),
    sprites.add({ ...base, offset: { x: -halfWidth, y: height, z: rear }, color: RED, intensity: 2.5 * intensity, radius: 0.12, minPx: 1.1, range: 5000 }),
    sprites.add({ ...base, offset: { x: halfWidth, y: height, z: rear }, color: RED, intensity: 2.5 * intensity, radius: 0.12, minPx: 1.1, range: 5000 }),
  ].filter(Boolean);
}

/**
 * Settlements on the valley floors of the sector (world metres, +X east,
 * +Z south; from the DEM's geographic bounds). `n` lights within `r` metres.
 */
export const VILLAGES = [
  { name: 'Kargil', x: 3300, z: -6300, r: 1500, n: 64 },
  { name: 'Drass', x: -30000, z: 8000, r: 1100, n: 40 },
  { name: 'Kaksar', x: -14700, z: -3300, r: 600, n: 12 },
  { name: 'Chanigund', x: -6400, z: -7800, r: 600, n: 12 },
  { name: 'Hardas', x: 900, z: -11100, r: 600, n: 12 },
  { name: 'Batalik', x: 22000, z: -17800, r: 700, n: 14 },
  { name: 'Sanku', x: -11900, z: 23300, r: 800, n: 18 },
  { name: 'Pandrass', x: -39500, z: 10800, r: 600, n: 10 },
  { name: 'Matayen', x: -35200, z: 9400, r: 500, n: 8 },
  { name: 'Bhimbat', x: -25500, z: 7300, r: 500, n: 8 },
  { name: 'Thasgam', x: -21000, z: 4200, r: 500, n: 8 },
];

function mulberry32(a) {
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Light positions for the villages: each centre is first slid to the lowest
 * ground nearby (the valley floor), then lights are scattered on gentle, dry
 * ground close to that level. Returns [{ x, y, z, warm (0..1), size }].
 */
export function villageLights(villages = VILLAGES, { density = 1, seed = 1999 } = {}) {
  const rnd = mulberry32(seed);
  const out = [];
  const inside = (x, z) => !DEM.ready || (x > DEM.minX + 300 && x < DEM.maxX - 300 && z > DEM.minZ + 300 && z < DEM.maxZ - 300);
  for (const v of villages) {
    let cx = v.x, cz = v.z, ch = terrainHeight(cx, cz);
    for (let i = 0; i < 80; i++) {
      const a = rnd() * Math.PI * 2, d = rnd() * 1800;
      const x = v.x + Math.cos(a) * d, z = v.z + Math.sin(a) * d;
      if (!inside(x, z)) continue;
      const h = terrainHeight(x, z);
      if (h < ch) { ch = h; cx = x; cz = z; }
    }
    const want = Math.max(3, Math.round(v.n * density));
    let placed = 0;
    for (let tries = 0; tries < want * 30 && placed < want; tries++) {
      // clustered: most lights near the middle, a few strung out along the valley
      const a = rnd() * Math.PI * 2, d = Math.pow(rnd(), 1.6) * v.r;
      const x = cx + Math.cos(a) * d, z = cz + Math.sin(a) * d;
      if (!inside(x, z) || isWater(x, z)) continue;
      const h = terrainHeight(x, z);
      if (h - ch > 70) continue; // up the valley wall
      const slope = Math.abs(terrainHeight(x + 25, z) - h) + Math.abs(terrainHeight(x, z + 25) - h);
      if (slope > 14) continue;
      out.push({ x, y: h + 3.5, z, warm: rnd(), size: 0.5 + rnd() * 0.5, village: v.name });
      placed++;
    }
  }
  return out;
}

export function addVillageLights(sprites, lights) {
  const handles = [];
  for (const l of lights) {
    // mostly warm tungsten / kerosene, the odd cooler tube light
    const cool = l.warm > 0.9;
    handles.push(sprites.add({
      position: l, group: 'villages', day: 0, radius: 0.6 + l.size * 0.5, minPx: 1.9, range: 45000,
      color: cool ? [0.75, 0.9, 1] : [1, 0.5 + 0.14 * l.warm, 0.16 + 0.1 * l.warm],
      intensity: (cool ? 3 : 4.2) * (0.6 + 0.8 * l.size),
    }));
  }
  return handles.filter(Boolean);
}
