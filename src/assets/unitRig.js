/**
 * Ground-unit presentation maths (pure; unit-tested in node). Used by
 * src/assets/system.js. Angles are radians; three.js frame (+Y up, front -Z).
 */

const D = Math.PI / 180;

/**
 * Per unit type (src/ai/ground.js `type`):
 *   align       follow the slope (vehicles, towed guns); else stay level on a foundation
 *   maxTilt     clamp on the slope-following tilt
 *   bury        level units: base height between the lowest (0) and highest (1) footprint corner
 *   yawRate / pitchRate   slew rates, rad/s
 *   pitch       [min, max] elevation of the barrels / launcher
 *   lead        projectile speed (m/s) for a lead solution, 0 = aim at the target
 *   scan        idle sector sweep amplitude (AAA), 0 = rest
 *   restPitch   idle elevation
 *   raiseOnLock launcher stays stowed until the site tracks, then elevates (min `minLaunch`)
 *   launcherYaws the `launcher` node is the only pivot and takes yaw as well (MANPADS)
 */
export const UNIT_RIGS = {
  aaa: { align: true, maxTilt: 12 * D, yawRate: 75 * D, pitchRate: 55 * D, pitch: [-4 * D, 85 * D], lead: 950, scan: 55 * D, restPitch: 22 * D },
  flak: { align: true, maxTilt: 10 * D, yawRate: 14 * D, pitchRate: 9 * D, pitch: [2 * D, 70 * D], lead: 0, scan: 0, restPitch: 18 * D },
  sam: { align: true, maxTilt: 14 * D, yawRate: 40 * D, pitchRate: 20 * D, pitch: [0, 65 * D], lead: 0, scan: 0, restPitch: 0, raiseOnLock: true, minLaunch: 24 * D },
  manpads: { align: false, maxTilt: 8 * D, bury: 0.35, yawRate: 70 * D, pitchRate: 45 * D, pitch: [0, 70 * D], lead: 0, scan: 0, restPitch: 0, raiseOnLock: true, minLaunch: 12 * D, launcherYaws: true },
  radar: { align: true, maxTilt: 10 * D },
  truck: { align: true, maxTilt: 18 * D },
  // emplacements: mostly level (a few degrees with the ground, as dry-stone and
  // canvas would), part dug into the uphill side, a spoil berm on the downhill side
  bunker: { align: false, maxTilt: 3 * D, bury: 0.5 },
  sangar: { align: false, maxTilt: 7 * D, bury: 0.45 },
  supply: { align: false, maxTilt: 6 * D, bury: 0.35 },
  tent: { align: false, maxTilt: 9 * D, bury: 0.3 },
  post: { align: false, maxTilt: 4 * D, bury: 0.4 },
  default: { align: false, maxTilt: 4 * D, bury: 0.4 },
};

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/**
 * Seat a unit on the terrain.
 * @param {(x:number,z:number)=>number} height terrain height
 * @param {number} x, z   unit origin (world)
 * @param {number} yaw    holder rotation.y
 * @param {{min:number[], max:number[]}} bounds model-space footprint
 * @param {object} spec   UNIT_RIGS entry
 * @param {number} [baseY] holder y (the model offset is relative to it); defaults to height(x, z)
 * @returns {{offset, pitch, roll, foundation: null|{minX,maxX,minZ,maxZ,depth,flare}, relief}}
 */
export function seatUnit(height, x, z, yaw, bounds, spec, baseY = height(x, z)) {
  const [x0, , z0] = bounds.min;
  const [x1, , z1] = bounds.max;
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  // model-local (lx, lz) -> world, three's rotation about +Y
  const h = (lx, lz) => height(x + lx * c + lz * s, z - lx * s + lz * c);
  const fl = h(x0, z0); // front-left (front = -Z)
  const fr = h(x1, z0);
  const br = h(x1, z1);
  const bl = h(x0, z1);
  const hc = height(x, z);
  const lo = Math.min(fl, fr, br, bl);
  const hi = Math.max(fl, fr, br, bl);
  const out = { offset: 0, pitch: 0, roll: 0, foundation: null, relief: hi - lo };
  const len = Math.max(0.5, z1 - z0);
  const wid = Math.max(0.5, x1 - x0);
  // 1. follow the slope up to maxTilt (vehicles a lot, emplacements a few degrees)
  const max = spec.maxTilt ?? (spec.align ? 15 * D : 0);
  // + pitch raises the front (-Z); + roll raises the right (+X)
  out.pitch = clamp(Math.atan2((fl + fr) / 2 - (bl + br) / 2, len), -max, max);
  out.roll = clamp(Math.atan2((fr + br) / 2 - (fl + bl) / 2, wid), -max, max);
  const tp = Math.tan(out.pitch);
  const tr = Math.tan(out.roll);
  // 2. what the tilt leaves over: each corner's height relative to the tilted base plane
  const rel = (h0, lx, lz) => h0 - (tp * -lz + tr * lx);
  const e = [rel(fl, x0, z0), rel(fr, x1, z0), rel(br, x1, z1), rel(bl, x0, z1)];
  const elo = Math.min(...e);
  const ehi = Math.max(...e);
  // 3. base between the lowest (0) and highest (1) corner: vehicles sit high so
  //    the wheels/trails touch, dug-in positions sit low (uphill side in the slope)
  let base = elo + (spec.bury ?? (spec.align ? 0.65 : 0.4)) * (ehi - elo);
  if (spec.align) base = Math.max(base, hc - 0.2) - 0.04; // a crest never pokes through the floor
  out.offset = base - baseY;
  // 4. the downhill side would hang in the air: an earth berm under it
  if (base - elo > 0.15) out.foundation = foundation(x0, x1, z0, z1, base - elo + 0.35);
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
