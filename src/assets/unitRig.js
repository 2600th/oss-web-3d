/**
 * Ground-unit presentation maths (pure; unit-tested in node). Used by
 * src/assets/system.js. Angles are radians; three.js frame (+Y up, front -Z).
 */

const D = Math.PI / 180;

/**
 * Per unit type (src/ai/ground.js `type`):
 *   align       follow the slope (vehicles, towed guns); else stay near level on a foundation
 *   maxTilt     clamp on the slope-following tilt
 *   maxBury     how far (m) the uphill edge may go into the ground before the unit is
 *               lifted instead (and an earth berm fills under the downhill edge).
 *               Kept well under the model height so nothing is visibly swallowed.
 *   sink        how far (m) the lowest edge is set into the ground (no daylight under it)
 *   clear       ground clearance (m) the interior of the footprint may rise into
 *               (between the wheels / inside a wall ring) before it counts as a poke-through
 *   maxHang     berm height (m) past which the unit leans further with the slope ...
 *   steepTilt   ... up to this tilt (default: twice maxTilt, at most maxTilt + 10 deg)
 *   yawRate / pitchRate   slew rates, rad/s
 *   pitch       [min, max] elevation of the barrels / launcher
 *   lead        projectile speed (m/s) for a lead solution, 0 = aim at the target
 *   scan        idle sector sweep amplitude (AAA), 0 = rest
 *   restPitch   idle elevation
 *   raiseOnLock launcher stays stowed until the site tracks, then elevates (min `minLaunch`)
 *   launcherYaws the `launcher` node is the only pivot and takes yaw as well (MANPADS)
 */
export const UNIT_RIGS = {
  // vehicles and towed guns follow the ground; the footprint is wheels / outriggers,
  // the interior is chassis clearance
  aaa: { align: true, maxTilt: 16 * D, maxBury: 0.22, sink: 0.04, clear: 0.25, yawRate: 75 * D, pitchRate: 55 * D, pitch: [-4 * D, 85 * D], lead: 950, scan: 55 * D, restPitch: 22 * D },
  flak: { align: true, maxTilt: 13 * D, maxBury: 0.25, sink: 0.04, clear: 0.3, yawRate: 14 * D, pitchRate: 9 * D, pitch: [2 * D, 70 * D], lead: 0, scan: 0, restPitch: 18 * D },
  sam: { align: true, maxTilt: 16 * D, maxBury: 0.25, sink: 0.04, clear: 0.35, yawRate: 40 * D, pitchRate: 20 * D, pitch: [0, 65 * D], lead: 0, scan: 0, restPitch: 0, raiseOnLock: true, minLaunch: 24 * D },
  manpads: { align: false, maxTilt: 10 * D, maxBury: 0.3, sink: 0.06, clear: 0.2, yawRate: 70 * D, pitchRate: 45 * D, pitch: [0, 70 * D], lead: 0, scan: 0, restPitch: 0, raiseOnLock: true, minLaunch: 12 * D, launcherYaws: true },
  radar: { align: true, maxTilt: 13 * D, maxBury: 0.25, sink: 0.04, clear: 0.35 },
  truck: { align: true, maxTilt: 26 * D, maxBury: 0.2, sink: 0.04, clear: 0.45 },
  // emplacements: mostly level (a few degrees with the ground, as dry-stone and
  // canvas would), dug into the uphill side as far as `maxBury`, a spoil berm on
  // the downhill side for whatever is left. Solid models ignore their interior.
  bunker: { align: false, maxTilt: 4 * D, maxBury: 0.75, sink: 0.08, clear: Infinity },
  sangar: { align: false, maxTilt: 10 * D, maxBury: 0.3, sink: 0.06, clear: 0.15 },
  supply: { align: false, maxTilt: 7 * D, maxBury: 0.35, sink: 0.06, clear: 0.6 },
  tent: { align: false, maxTilt: 10 * D, maxBury: 0.25, sink: 0.05, clear: Infinity },
  post: { align: false, maxTilt: 4 * D, maxBury: 0.5, sink: 0.06, clear: Infinity },
  default: { align: false, maxTilt: 4 * D, maxBury: 0.4, sink: 0.05, clear: Infinity },
};

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/** Grid samples across a footprint: about one per 2 m, 3 to 7 per side. */
const gridCount = (len) => clamp(Math.ceil(len / 2) + 1, 3, 7);

/**
 * Seat a unit on the terrain.
 * @param {(x:number,z:number)=>number} height terrain height
 * @param {number} x, z   unit origin (world)
 * @param {number} yaw    holder rotation.y
 * @param {{min:number[], max:number[]}} bounds model-space footprint
 * @param {object} spec   UNIT_RIGS entry
 * @param {number} [baseY] holder y (the model offset is relative to it); defaults to height(x, z)
 * @returns {{offset, pitch, roll, foundation: null|{minX,maxX,minZ,maxZ,depth,flare}, relief, hang, bury}}
 *   relief  height range of the ground under the footprint (m)
 *   hang    how far the lowest footprint edge sits above the ground (m; covered by the berm)
 *   bury    how far the highest footprint edge sits below the ground (m; at most maxBury)
 *
 * The footprint is sampled on a grid (about every 2 m). The tilt is the
 * least-squares plane through those samples (the ground's mean normal under
 * the unit), clamped to `maxTilt`. The base then goes down until the lowest
 * edge sample is `sink` into the ground, so no edge shows daylight, unless
 * that would put the highest edge more than `maxBury` under: then the base
 * stops there and the downhill gap gets a berm. Interior samples only count
 * where they rise more than `clear` into the model (a crest under a truck).
 */
export function seatUnit(height, x, z, yaw, bounds, spec, baseY = height(x, z)) {
  const [x0, , z0] = bounds.min;
  const [x1, , z1] = bounds.max;
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  // model-local (lx, lz) -> world, three's rotation about +Y
  const h = (lx, lz) => height(x + lx * c + lz * s, z - lx * s + lz * c);
  const len = Math.max(0.5, z1 - z0);
  const wid = Math.max(0.5, x1 - x0);
  const nx = gridCount(wid);
  const nz = gridCount(len);
  const mx = (x0 + x1) / 2;
  const mz = (z0 + z1) / 2;
  // 1. sample the ground under the footprint; least-squares plane h = a + bx (lx - mx) + bz (lz - mz)
  const pts = [];
  let sh = 0, sxh = 0, szh = 0, sxx = 0, szz = 0;
  for (let j = 0; j < nz; j++) {
    const lz = z0 + (len * j) / (nz - 1);
    for (let i = 0; i < nx; i++) {
      const lx = x0 + (wid * i) / (nx - 1);
      const hv = h(lx, lz);
      const edge = i === 0 || j === 0 || i === nx - 1 || j === nz - 1;
      pts.push(lx, lz, hv, edge ? 1 : 0);
      const dx = lx - mx, dz = lz - mz;
      sh += hv; sxh += dx * hv; szh += dz * hv; sxx += dx * dx; szz += dz * dz;
    }
  }
  const bx = sxh / sxx;
  const bz = szh / szz;
  const out = { offset: 0, pitch: 0, roll: 0, foundation: null, relief: 0, hang: 0, bury: 0 };
  const clear = spec.clear ?? 0;
  const sink = spec.sink ?? 0.05;
  const maxBury = spec.maxBury ?? (spec.align ? 0.2 : 0.4);
  // Seat with the tilt clamped to `lim`; fills `out` and returns the hang.
  const seat = (lim) => {
    // 2. follow the slope up to the limit (vehicles a lot, emplacements a few degrees)
    // + pitch raises the front (-Z); + roll raises the right (+X)
    // (model rotation order 'YXZ': the base plane is y = tan(roll) / cos(pitch) lx - tan(pitch) lz)
    out.pitch = clamp(Math.atan(-bz), -lim, lim);
    out.roll = clamp(Math.atan(bx * Math.cos(out.pitch)), -lim, lim);
    const A = Math.tan(out.roll) / Math.cos(out.pitch);
    const B = -Math.tan(out.pitch);
    // 3. what the tilt leaves over: each sample's height relative to the tilted base plane
    let lo = Infinity, hi = -Infinity, glo = Infinity, ghi = -Infinity;
    for (let k = 0; k < pts.length; k += 4) {
      const e = pts[k + 2] - (A * pts[k] + B * pts[k + 1]);
      if (e < glo) glo = e;
      if (e > ghi) ghi = e;
      if (pts[k + 3]) {
        if (e < lo) lo = e;
        if (e > hi) hi = e;
      } else if (e - clear > hi) hi = e - clear;
    }
    out.relief = ghi - glo;
    // 4. down to the lowest edge (plus `sink`), but never more than maxBury into the high side
    const base = Math.max(lo - sink, hi - maxBury);
    out.offset = base - baseY;
    out.hang = Math.max(0, base - lo);
    out.bury = Math.max(0, hi - base);
    return out.hang;
  };
  const max = spec.maxTilt ?? (spec.align ? 15 * D : 0);
  // On ground too steep for maxTilt the berm would grow into a plinth: past
  // `maxHang` the unit leans further with the slope, up to `steepTilt`, as far
  // as it takes to bring the berm back down to maxHang.
  const maxHang = spec.maxHang ?? (spec.align ? 0.35 : 0.6);
  const steep = Math.max(max, spec.steepTilt ?? Math.min(max * 2, max + 10 * D));
  if (seat(max) > maxHang && steep > max) {
    for (let i = 1; i <= 6 && seat(max + ((steep - max) * i) / 6) > maxHang; i++);
  }
  // 5. the downhill side would show daylight: an earth berm under it
  if (out.hang > (spec.align ? 0.1 : 0.04)) out.foundation = foundation(x0, x1, z0, z1, out.hang + 0.35);
  return out;
}

function foundation(x0, x1, z0, z1, depth) {
  const pad = 0.35;
  // a spoil berm, not a plinth: sides about 35 degrees, so it reads as dug earth
  return { minX: x0 - pad, maxX: x1 + pad, minZ: z0 - pad, maxZ: z1 + pad, depth, flare: Math.min(Math.max(depth * 1.4, 0.8), 6) };
}

/**
 * Yaw / pitch that lay a turret + barrel on a world point.
 * `parent` is the turret's parent Object3D (its matrixWorld is used),
 * `yawPivot` the turret (or launcher) node, `pitchPivot` the barrel node.
 * Yaw is about the parent's +Y (0 = front, -Z); pitch is + up.
 */
export function aimAngles(parent, target, yawPivot, pitchPivot, tmp) {
  const p = parent ? parent.worldToLocal(tmp.copy(target)) : tmp.copy(target);
  const dx = p.x - yawPivot.position.x;
  const dz = p.z - yawPivot.position.z;
  const dy = p.y - yawPivot.position.y - (pitchPivot && pitchPivot !== yawPivot ? pitchPivot.position.y : 0);
  return { yaw: Math.atan2(-dx, -dz), pitch: Math.atan2(dy, Math.hypot(dx, dz)) };
}

/** Move `cur` toward `want` by at most `step`; `wrap` = shortest way round. */
export function slew(cur, want, step, wrap = false) {
  let d = want - cur;
  if (wrap) d = Math.atan2(Math.sin(d), Math.cos(d));
  return cur + clamp(d, -step, step);
}
