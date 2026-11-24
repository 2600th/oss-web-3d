/**
 * Pure bookkeeping shared by the GPU particle pools and the trail renderer.
 * No three.js imports: this file is unit-tested in Node.
 */

/** Ring allocator over `capacity` slots: the oldest slots are recycled first. */
export class Ring {
  constructor(capacity) {
    this.capacity = capacity;
    this.head = 0;
    this.total = 0; // lifetime allocations
  }

  /** Allocate one slot, returns its index. */
  next() {
    const i = this.head;
    this.head = (this.head + 1) % this.capacity;
    this.total++;
    return i;
  }
}

/**
 * Collects touched slot indices during a frame and reduces them to a short
 * list of contiguous `[start, count]` ranges for partial buffer uploads.
 * When the list would get longer than `maxRanges`, neighbouring ranges are
 * merged across the smallest gaps (uploading a few untouched slots is cheaper
 * than another `writeBuffer`).
 */
export class DirtyRanges {
  constructor(capacity, maxRanges = 12) {
    this.capacity = capacity;
    this.maxRanges = maxRanges;
    this._idx = [];
    this._seen = new Set();
  }

  mark(i) {
    if (this._seen.has(i)) return;
    this._seen.add(i);
    this._idx.push(i);
  }

  get empty() { return this._idx.length === 0; }

  /** Returns [[start, count], ...] sorted by start, and resets. */
  flush() {
    const idx = this._idx;
    if (idx.length === 0) return [];
    let ranges;
    if (idx.length >= this.capacity) {
      ranges = [[0, this.capacity]];
    } else {
      idx.sort((a, b) => a - b);
      ranges = [];
      let s = idx[0], e = idx[0];
      for (let k = 1; k < idx.length; k++) {
        if (idx[k] === e + 1) { e = idx[k]; continue; }
        ranges.push([s, e - s + 1]);
        s = e = idx[k];
      }
      ranges.push([s, e - s + 1]);
      while (ranges.length > this.maxRanges) {
        let best = 1, gap = Infinity;
        for (let k = 1; k < ranges.length; k++) {
          const g = ranges[k][0] - (ranges[k - 1][0] + ranges[k - 1][1]);
          if (g < gap) { gap = g; best = k; }
        }
        const a = ranges[best - 1], b = ranges[best];
        a[1] = b[0] + b[1] - a[0];
        ranges.splice(best, 1);
      }
    }
    this._idx = [];
    this._seen.clear();
    return ranges;
  }
}

/** Fixed pool of reusable items with an `active` flag; steals the oldest when full. */
export class Pool {
  constructor(size, make) {
    this.items = Array.from({ length: size }, (_, i) => make(i));
    this._stamp = 0;
    for (const it of this.items) { it.active = false; it._stamp = 0; }
  }

  acquire() {
    let pick = null;
    for (const it of this.items) {
      if (!it.active) { pick = it; break; }
      if (!pick || it._stamp < pick._stamp) pick = it;
    }
    pick.active = true;
    pick._stamp = ++this._stamp;
    return pick;
  }

  release(it) { it.active = false; }

  get activeCount() { let n = 0; for (const it of this.items) if (it.active) n++; return n; }
}

export const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
export const saturate = (x) => Math.min(1, Math.max(0, x));
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (a, b, x) => { const t = saturate((x - a) / (b - a)); return t * t * (3 - 2 * t); };

/**
 * Explosion size presets: metric radius of the fireball core; everything else
 * scales from it. The burning, rolling cloud ends up about 2.2x this across,
 * which is what has to match combat's blast radii for the same names
 * (small 14 m, medium 30 m, large 55 m, huge 110 m): what kills you is what
 * you see.
 */
export const EXPLOSION_SIZES = { small: 6.5, medium: 14, large: 25, huge: 50 };
export const BLAST_RADIUS = { small: 14, medium: 30, large: 55, huge: 110 };
export function explosionRadius(size) {
  if (typeof size === 'number' && size > 0) return size;
  return EXPLOSION_SIZES[size] ?? EXPLOSION_SIZES.medium;
}

/** ISA air at altitude: temperature (K), and pressure and density relative to sea level. */
export function airState(altitude) {
  const h = Math.max(0, altitude || 0);
  const T = Math.max(216.65, 288.15 - 0.0065 * h);
  let pressure = Math.pow(T / 288.15, 5.2559);
  if (h > 11000) pressure *= Math.exp(-(h - 11000) / 6341.6);
  return { T, pressure, density: pressure * 288.15 / T };
}

/**
 * Shock cells of the reheat jet. The MiG-21's nozzle only converges, so above
 * the critical pressure ratio (1.83 for hot gas) the jet leaves it
 * under-expanded and finishes expanding outside, through a train of cells.
 *
 *   NPR      nozzle pressure ratio = engine pressure ratio x intake ram.
 *            The R-25's EPR is about 2.6 at sea-level static and follows
 *            corrected rpm (colder intake air -> more), so thin cold air and
 *            speed both raise it.
 *   mach     fully expanded jet Mach number, from NPR (gamma 1.3)
 *   spacing  cell length, Prandtl-Pack: 1.306 D sqrt(Mj^2 - 1)
 *
 * About one nozzle diameter on the runway, 1.4 m in a Mach 0.75 fight at
 * 5 km, over 2 m supersonic at 10 km.
 */
export function shockCells(altitude = 0, mach = 0, nozzleRadius = 0.45) {
  const { T } = airState(altitude);
  const M = clamp(mach || 0, 0, 2.2);
  const ram = 1 + 0.2 * M * M;
  const epr = clamp(2.6 * Math.pow(288.15 / (T * ram), 1.5), 1.7, 3.6);
  const npr = epr * 0.97 * Math.pow(ram, 3.5);
  const G = 1.3;
  const mj = Math.sqrt(Math.max(0, (2 / (G - 1)) * (Math.pow(npr, (G - 1) / G) - 1)));
  return { npr, mach: mj, spacing: 1.306 * 2 * nozzleRadius * Math.sqrt(Math.max(mj * mj - 1, 0.05)) };
}

/**
 * Afterburner plume shape from engine state and the air it burns in.
 * Dry thrust gives a short faint stub; reheat lights the long flame with
 * shock diamonds. `reheat` may be a boolean (the player's FlightModel) or a
 * 0..1 amount. In thin air the flame mixes out more slowly (longer, about
 * rho^-0.3), its cells are longer (shockCells) and fainter, and the jet
 * swells where it leaves the nozzle.
 */
export function plumeState(throttle, reheat, altitude = 0, mach = 0, nozzleRadius = 0.45) {
  const th = saturate(throttle ?? 0);
  const rh = typeof reheat === 'number'
    ? saturate(reheat)
    : (reheat ? 0.45 + 0.55 * saturate((th - 0.86) / 0.14) : 0);
  const dry = smoothstep(0.35, 0.9, th);
  const air = airState(altitude);
  const cells = shockCells(altitude, mach, nozzleRadius);
  // Lengths in metres for a MiG-21-sized nozzle: military power shows a
  // stub of faint flame, full reheat about 8 m at sea level and 11 m at 10 km.
  const length = 0.6 + dry * 1.4 + rh * 6.0 * Math.pow(Math.max(air.density, 0.2), -0.3);
  return {
    length,
    spacing: cells.spacing,
    diamonds: rh > 0 ? length / cells.spacing : 0,
    core: dry * 0.08 + rh * 0.9,
    glow: dry * 0.15 + rh,
    reheat: rh,
    contrast: 0.5 + 0.5 * Math.sqrt(air.density),
    spread: saturate((cells.npr - 1.9) / 6),
  };
}

/** A fresh, unlit burner for `burnerStep`. */
export function burnerState() {
  return {
    length: 0.6, spacing: 1.2, diamonds: 0, core: 0, glow: 0, reheat: 0, contrast: 1, spread: 0,
    lit: false, since: 10, lightUp: false, pop: 0, flameLength: 0.6, power: 0,
  };
}

/** Seconds the light-up pop takes to die (e-folding); it has settled by about four of these. */
export const LIGHT_UP_TAU = 0.15;

/**
 * Advance a burner toward `target` (a plumeState) by `dt`.
 *
 * Fuel reaches the spray rings and lights off the igniter torch at once, so
 * the flame comes up fast (18/s) and overshoots: for a moment the pipe holds
 * more fuel than the flame is burning, and it leaves as a long, wide, yellow
 * torch (`pop`, 1 at light-up, gone in ~0.6 s) before the nozzle opens and the
 * jet settles into its cells. Cancelling is slower (6.5/s): the flame shortens
 * from the tail as the pipe empties.
 *
 * Sets `lightUp` on the frame the burner lights, `flameLength` and `power`
 * (what to draw, pop included), and returns `s`.
 */
export function burnerStep(s, target, dt) {
  s.lightUp = false;
  if (target.reheat > 0) {
    if (!s.lit) { s.lit = true; s.since = 0; s.lightUp = true; }
  } else s.lit = false;
  s.since += dt;
  const up = 1 - Math.exp(-18 * dt), down = 1 - Math.exp(-6.5 * dt), k = 1 - Math.exp(-9 * dt);
  for (const key of ['length', 'core', 'glow', 'reheat']) s[key] = lerp(s[key], target[key], target[key] > s[key] ? up : down);
  for (const key of ['spacing', 'diamonds', 'contrast', 'spread']) s[key] = lerp(s[key], target[key], k);
  s.pop = s.lit ? Math.exp(-s.since / LIGHT_UP_TAU) : 0;
  s.flameLength = s.length * (1 + 0.55 * s.pop);
  s.power = s.core * (1 + 1.2 * s.pop * s.pop);
  return s;
}

/**
 * How strongly the wing sheds visible vapour: G and AoA driven, thinner in
 * high dry air. `humidity` (0..1, env.weather.humidity; 0.3 is a dry day)
 * lowers the G and AoA it takes, and saturated air (inside cloud) condenses
 * off the airframe even in level flight.
 */
export function vapourAmount(gLoad, aoaRad, speed, altitude, humidity = 0.3) {
  const h = saturate((humidity - 0.3) / 0.7);
  const g = smoothstep(3.5 - 1.6 * h, 6.8 - 2.4 * h, Math.abs(gLoad));
  const a = smoothstep(0.16 - 0.06 * h, 0.34 - 0.1 * h, Math.abs(aoaRad));
  const q = smoothstep(110, 240, speed);
  const dens = 1 - smoothstep(5500, 9500, altitude) * 0.6 * (1 - h);
  const wet = smoothstep(0.86, 1, humidity) * 0.5;
  return saturate(Math.max(g, a * 0.8, wet) * q * dens);
}

/**
 * Split a vapourAmount into what shows where, by humidity (0..1; 0.3 = a dry
 * Ladakh day, 1 = saturated / in cloud):
 *   tip   the wingtip vortex cores: their low-pressure core condenses on a
 *         moderately humid day; in dry air only the hardest pulls show a faint
 *         thread (about 40 % of the amount at humidity 0.3)
 *   wing  the condensation sheet over the wing: high G *and* humid air; on a
 *         dry day it stays under its 0.22 threshold except in cloud
 */
export function vapourGates(amount, humidity = 0.3) {
  const a = saturate(amount);
  return {
    tip: a * (0.4 + 0.6 * smoothstep(0.3, 0.7, humidity)),
    wing: a * (0.2 + 0.8 * smoothstep(0.4, 0.85, humidity)),
  };
}

/** Contrail strength: cold air aloft, lower in humid air. */
export function contrailAmount(altitude, throttle = 0.8, humidity = 0.3) {
  const h = saturate((humidity - 0.3) / 0.7);
  const lo = 6600 - 1800 * h;
  return smoothstep(lo, lo + 800, altitude) * saturate(throttle * 1.4);
}

/** Transonic vapour-cone visibility: a narrow band around Mach 0.95-1.03. */
export function vapourCone(mach) {
  return smoothstep(0.9, 0.955, mach) * (1 - smoothstep(1.0, 1.06, mach));
}

/** Speed of sound (m/s) at altitude, ISA troposphere. */
export function speedOfSound(altitude) {
  const T = Math.max(216.65, 288.15 - 0.0065 * altitude);
  return Math.sqrt(1.4 * 287.05 * T);
}

/** Rank virtual lights for a camera: brightest-at-the-eye first. Pure, unit-tested. */
export function rankLights(requests, cam, max) {
  for (const q of requests) {
    const dx = q.x - cam.x, dy = q.y - cam.y, dz = q.z - cam.z;
    q.score = q.intensity / (dx * dx + dy * dy + dz * dz + 400);
  }
  requests.sort((a, b) => b.score - a.score);
  return requests.length > max ? requests.slice(0, max) : requests;
}

