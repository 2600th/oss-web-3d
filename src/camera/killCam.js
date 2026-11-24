/**
 * Kill cam: the pure parts (no three.js; unit-tested in killcam.test.mjs).
 *
 * The sequence has two flavours:
 *  - the projectile cam (rare, for special kills): the lens rides the killing
 *    missile / rocket in slow motion, the time ramps deeper the closer it is
 *    to the target, nearly freezes in the last metres before detonation,
 *    punches through the flash, swings round the
 *    breaking target and flies away back to the player's view;
 *  - the fast shot (most kills): a quick cut to a close, varied angle on the
 *    stricken aircraft (or an orbit of a ground wreck) with a light slow-down,
 *    then the same fly-away hand-back.
 * Time values are real seconds unless a name says "game".
 *
 * Vectors here are plain {x, y, z} objects so node can test them.
 */
import { clamp, smoothstep, easeInOut } from './cameraMath.js';

export const KILL = {
  /** Real seconds between the end of one kill cam and the start of the next. */
  cooldown: 5,
  /** Game seconds to impact when the projectile cam cuts in. */
  trigger: 0.3,
  /**
   * Game seconds to impact when the lens lets the projectile go: it holds
   * station on the target and watches the last ~30 m alone (a lens riding
   * into the burst would only see a white flash).
   */
  release: 0.045,
  /** The projectile cam never runs longer than this (real s); time is pushed back up before. */
  projectileMax: 1.7,
  /**
   * Time scale riding the projectile: `projectileHigh` when it cuts in,
   * `projectileMid` 0.1 game s out, and the near-freeze `projectileLow`
   * in the last metres before detonation.
   */
  projectileHigh: 0.45,
  projectileMid: 0.22,
  projectileLow: 0.07,
  /** Real seconds to ramp the time from 1 down to the projectile curve. */
  rampIn: 0.18,
  /**
   * After detonation: `punch` real s at `punchScale` (time runs through the
   * flash so the frame is not a white-out), then the slow swing round the
   * target at `swingScale`, then the fly-away back to real time.
   */
  punch: 0.3,
  punchScale: 0.5,
  swingScale: 0.18,
  orbit: 1.1,
  exit: 0.4,
  /** Fast air shot, ground shot and the reduced-motion shot (real s, exit included). */
  air: 1.85,
  ground: 2.1,
  brief: 1.3,
  /** Chance that a special kill (last of a group, long range, high off-boresight) gets the projectile cam. */
  specialChance: 0.85,
  /** Chance that an ordinary missile / rocket kill gets it (a rare surprise). */
  regularChance: 0.1,
  /** Chance that a ground kill gets a shot at all (rocket ripples kill a lot). */
  groundChance: 0.7,
  /** Missile launch range (m) that counts as long range, and off-boresight angle (rad) that counts as high. */
  longRange: 4200,
  offBoresight: 0.7,
};

const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const len = (a) => Math.sqrt(dot(a, a));

/**
 * Straight-line intercept: `rel` = target - projectile (m), `closing` =
 * projectile velocity - target velocity (m/s). Returns the game seconds to
 * the closest approach (`tgo`, Infinity when opening) and the miss distance
 * there (`miss`, m).
 */
export function predictIntercept(rel, closing) {
  const vv = dot(closing, closing);
  if (!(vv > 1e-6)) return { tgo: Infinity, miss: len(rel) };
  const tgo = dot(rel, closing) / vv;
  if (!(tgo > 0)) return { tgo: Infinity, miss: len(rel) };
  const mx = rel.x - closing.x * tgo, my = rel.y - closing.y * tgo, mz = rel.z - closing.z * tgo;
  return { tgo, miss: Math.sqrt(mx * mx + my * my + mz * mz) };
}

/**
 * Will this shot hit and kill? `hitRadius` = target radius + fuse. A guided
 * missile still steers, so its predicted miss gets a 1.6x allowance.
 */
export function predictKill({ tgo, miss, hitRadius, damage, health, guided = false }) {
  if (!(tgo < Infinity)) return false;
  if (!(miss <= hitRadius * (guided ? 1.6 : 1))) return false;
  return damage >= health - 1e-6;
}

/**
 * Is `target` the last live hostile of its group? Shares a tag with nobody
 * alive, and (untagged) no live hostile of its class is within `radius` m.
 * `others` = [{alive, team, class, tags, position}] (the target may be in it).
 */
export function lastOfGroup(target, others, radius = 6000) {
  const tags = target.tags ?? [];
  const r2 = radius * radius;
  for (const o of others) {
    if (o === target || o.alive === false || o.team !== target.team) continue;
    if (tags.length && (o.tags ?? []).some((t) => tags.includes(t))) return false;
    if (o.class !== target.class) continue;
    const dx = o.position.x - target.position.x, dy = o.position.y - target.position.y, dz = o.position.z - target.position.z;
    if (dx * dx + dy * dy + dz * dz < r2) return false;
  }
  return true;
}

/** A shot is special: the last of a group, a long-range missile, or a high-off-boresight one. */
export function isSpecial({ last = false, launchRange = 0, offBoresight = 0, weapon = '' } = {}) {
  if (last) return true;
  if (launchRange >= KILL.longRange) return true;
  if (offBoresight >= KILL.offBoresight) return true;
  return weapon === 'lraam' && launchRange >= KILL.longRange * 0.75;
}

/**
 * Should this predicted kill get the projectile cam? Never in danger, never
 * when the kill cam or slow motion is off or motion is reduced, never inside
 * the cooldown. `roll` is a uniform [0, 1) draw, made once per projectile.
 */
export function wantsProjectileCam({ enabled = true, slowMo = true, reducedMotion = false, danger = false, sinceLast = Infinity, special = false, roll = 0 } = {}) {
  if (!enabled || !slowMo || reducedMotion || danger) return false;
  if (!(sinceLast >= KILL.cooldown)) return false;
  return roll < (special ? KILL.specialChance : KILL.regularChance);
}

/**
 * After a kill with no projectile cam running: which shot, if any.
 * Returns 'air' | 'ground' | 'brief' | null.
 */
export function killShot({ enabled = true, reducedMotion = false, danger = false, sinceLast = Infinity, air = true, distance = 0, roll = 0 } = {}) {
  if (!enabled || danger) return null;
  if (!(sinceLast >= KILL.cooldown)) return null;
  if (distance > (air ? 6000 : 4500)) return null;
  if (!air && roll >= KILL.groundChance) return null;
  if (reducedMotion) return 'brief';
  return air ? 'air' : 'ground';
}

/**
 * Time scale while riding the projectile: ramps down from 1 over `rampIn`,
 * then follows the time to impact (game s): `projectileHigh` -> `projectileMid`
 * by 0.1 s out -> the near-freeze `projectileLow` in the last metres, so the
 * last stretch is the slowest. Past `projectileMax - 0.4` real seconds it is
 * eased back up so a long flight cannot hold the player in slow motion.
 */
export function projectileScale(tgo, tReal) {
  const g = Math.max(0, tgo);
  const curve = g >= 0.1
    ? KILL.projectileMid + (KILL.projectileHigh - KILL.projectileMid) * smoothstep(0.1, KILL.trigger, g)
    : KILL.projectileLow + (KILL.projectileMid - KILL.projectileLow) * smoothstep(0.015, 0.1, g);
  const ramp = easeInOut(tReal / KILL.rampIn);
  let s = 1 + (curve - 1) * ramp;
  const late = smoothstep(KILL.projectileMax - 0.4, KILL.projectileMax + 0.3, tReal);
  s += (1 - s) * late;
  return s;
}

/**
 * Time scale from the detonation on (t = real s since it, s0 = the scale at
 * the moment of impact, the near-freeze): a punch through the flash, a slow
 * swing round the burst, a quick ramp back to real time.
 */
export function impactScale(t, s0 = KILL.projectileLow) {
  const P = KILL.punch, O = KILL.orbit, X = KILL.exit, S = KILL.swingScale, end = S + 0.08;
  if (!(t > 0)) return s0;
  if (t < 0.12) return s0 + (KILL.punchScale - s0) * easeInOut(t / 0.12);
  if (t < P) return KILL.punchScale;
  if (t < P + 0.3) return KILL.punchScale + (S - KILL.punchScale) * easeInOut((t - P) / 0.3);
  if (t < P + O) return S + (end - S) * easeInOut((t - P - 0.3) / (O - 0.3));
  if (t < P + O + X) return end + (1 - end) * easeInOut((t - P - O) / X);
  return 1;
}

/** Real length of the impact phase (punch + swing + fly-away). */
export const impactDuration = () => KILL.punch + KILL.orbit + KILL.exit;

/**
 * Time scale of the fast shots: a quick dip (a hit-stop beat), held, then
 * back to real time before the hand-back. `depth` = lowest scale.
 */
export function shotScale(t, dur, depth = 0.45) {
  if (!(t > 0) || t >= dur) return 1;
  const dip = 0.1, back = Math.min(0.5, dur * 0.3);
  if (t < dip) return 1 + (depth - 1) * easeInOut(t / dip);
  if (t < dur - back) return depth;
  return depth + (1 - depth) * easeInOut((t - (dur - back)) / back);
}

// ------------------------------------------------------------- air angles

export const AIR_ANGLES = ['lowSide', 'frontQuarter', 'topDown', 'debris'];

/**
 * Pick the next air-kill angle: never one of the last two used, and not the
 * low-side shot when the wreck is too close to the ground to get under it.
 * `recent` = previously used angles, most recent last.
 */
export function pickAirAngle(recent = [], roll = 0, { agl = 1e4 } = {}) {
  const avoid = new Set(recent.slice(-2));
  let pool = AIR_ANGLES.filter((a) => !avoid.has(a) && (a !== 'lowSide' || agl > 90));
  if (!pool.length) pool = AIR_ANGLES.filter((a) => a !== recent[recent.length - 1] && (a !== 'lowSide' || agl > 90));
  if (!pool.length) pool = ['topDown'];
  return pool[Math.min(pool.length - 1, Math.floor(clamp(roll, 0, 0.999999) * pool.length))];
}

/**
 * Pose of an air shot at real time t of `dur`, in the wreck's frame:
 * f = along its horizontal heading, r = to its right, u = world up (metres).
 * `side` (+1 / -1) mirrors the shot; `size` scales it to the airframe (1 = a
 * MiG-21, ~15 m long). Returns { off, look, fov, roll, follow } where `look`
 * is the aim point relative to the wreck, and `follow` (0..1) is how much of
 * the wreck's vertical motion the camera rides (top-down lets it fall away).
 */
export function airShotPose(angle, t, dur, side = 1, size = 1) {
  const u = clamp(t / dur, 0, 1);
  const e = easeInOut(u);
  let off, look, fov, roll = 0, follow = 1;
  switch (angle) {
    case 'lowSide':
      // under the wing line, looking up at the belly against the sky; the wreck slides past
      off = { f: 10 - 22 * e, r: side * 24, u: -13 + 3 * e };
      look = { f: -2 * e, r: 0, u: 2 };
      fov = 40 - 6 * e;
      roll = side * 0.1;
      break;
    case 'frontQuarter':
      // ahead and off the nose: the burning jet rolls toward the lens
      off = { f: 36 - 12 * e, r: side * 14, u: 5 - 2 * e };
      look = { f: 0, r: 0, u: 1 };
      fov = 33 + 5 * e;
      roll = -side * 0.05;
      break;
    case 'topDown':
      // above and a touch ahead (its smoke trail streams away behind it);
      // the lens climbs, the wreck falls away rolling
      off = { f: 7 + 3 * e, r: side * 7, u: 28 + 26 * e };
      look = { f: -2, r: 0, u: 0 };
      fov = 40;
      follow = 0.35;
      break;
    case 'debris':
    default:
      // from behind the burst, flying up through the debris past the wing
      off = { f: -50 + 42 * e, r: side * 12, u: 3 + 2 * e };
      look = { f: 4, r: 0, u: 0.5 };
      fov = 46 - 6 * e;
      roll = side * 0.06 * (1 - e);
      break;
  }
  return {
    off: { f: off.f * size, r: off.r * size, u: off.u * size },
    look: { f: look.f * size, r: look.r * size, u: look.u * size },
    fov, roll, follow,
  };
}

/**
 * Ground shot: an orbit of the wreck. Starts on the player's side (bearing
 * `a0`, radians from north, clockwise), swings `side` x 0.9 rad while closing in.
 * `radius` m (scaled to the target), returns {x, y, z} offset from it.
 */
export function groundOrbit(t, dur, a0, side, radius) {
  const e = easeInOut(clamp(t / dur, 0, 1));
  const a = a0 + side * 0.9 * e;
  const r = radius * (1.05 - 0.15 * e);
  return { x: Math.sin(a) * r, y: radius * (0.42 - 0.06 * e), z: -Math.cos(a) * r };
}

/**
 * Swing round the impact point after the detonation: rotate the starting
 * offset (camera - centre, {x, y, z}) about world up by up to `swing` rad
 * while moving to radius `r1` (in or out). The elevation eases from where
 * the lens started to `elev` (rad above the horizontal; default: the start's
 * plus a little rise), so a steep dive onto a ground target ends on a low,
 * three-quarter view with the horizon in it. t = real s after the detonation.
 */
export function impactOrbit(start, t, dur, swing, r1, elev = null) {
  const e = easeInOut(clamp(t / dur, 0, 1));
  const a = swing * e;
  const c = Math.cos(a), s = Math.sin(a);
  // rotation about +Y (three.js convention: x' = x c + z s, z' = -x s + z c)
  const x = start.x * c + start.z * s;
  const z = -start.x * s + start.z * c;
  const h = Math.hypot(x, z);
  const r0 = Math.max(1e-3, Math.hypot(h, start.y));
  const r = r0 + (r1 - r0) * e;
  const el0 = Math.atan2(start.y, Math.max(h, 1e-3));
  const el1 = elev ?? Math.min(1.3, el0 + 0.25);
  const el = el0 + (el1 - el0) * e;
  const hk = (r * Math.cos(el)) / Math.max(h, 1e-3);
  // straight overhead (no horizontal bearing): keep the start's bearing
  if (h < 1e-3) return { x: 0, y: r * Math.sin(el), z: r * Math.cos(el) };
  return { x: x * hk, y: r * Math.sin(el), z: z * hk };
}

/**
 * The fly-away at the end of a shot: extra offset (same frame as the shot)
 * along `dir` (unit) that accelerates (ease-in) over the last `exit` s, and
 * its rate (m/s) at the end, which the hand-back blend carries on.
 */
export function flyAway(t, dur, exit, dir, dist = 45) {
  const u = clamp((t - (dur - exit)) / exit, 0, 1);
  const d = dist * u * u * u;
  const rate = exit > 0 ? (3 * dist * u * u) / exit : 0;
  return { x: dir.x * d, y: dir.y * d, z: dir.z * d, rate };
}

/**
 * Push point `p` ({x, y, z}, modified) out of keep-out spheres
 * ([{x, y, z, r}]): the target mesh, the player's jet, anything near.
 * Returns true when it moved.
 */
export function pushOutOfSpheres(p, spheres) {
  let moved = false;
  for (let pass = 0; pass < 2; pass++) {
    for (const s of spheres) {
      const dx = p.x - s.x, dy = p.y - s.y, dz = p.z - s.z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d >= s.r) continue;
      moved = true;
      if (d < 1e-6) { p.y = s.y + s.r; continue; }
      const k = s.r / d;
      p.x = s.x + dx * k; p.y = s.y + dy * k; p.z = s.z + dz * k;
    }
  }
  return moved;
}

/** FOV (deg) at which an object of `radius` m at `dist` m fills `frac` of the frame height. */
export function fovFor(radius, dist, frac = 0.35) {
  const half = Math.atan(radius / Math.max(dist, 1e-3)) / frac;
  return clamp((2 * half * 180) / Math.PI, 18, 75);
}

/**
 * When does `gameT` game seconds have passed under the scale curve
 * `scaleAt(tReal)`? Returns the real time (capped at `maxReal`).
 */
export function realTimeFor(scaleAt, gameT, maxReal = 5, dt = 1 / 240) {
  let g = 0, t = 0;
  while (g < gameT && t < maxReal) { g += scaleAt(t) * dt; t += dt; }
  return t;
}

/**
 * Real-time length of a projectile approach for a constant closing speed:
 * steps the curve until impact. For tests and tuning.
 */
export function projectileRealTime(tgo0 = KILL.trigger, dt = 1 / 240) {
  let tgo = tgo0, t = 0;
  while (tgo > 0 && t < 10) { tgo -= projectileScale(tgo, t) * dt; t += dt; }
  return t;
}
