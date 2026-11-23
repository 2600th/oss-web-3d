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

/**
 * Afterburner plume shape from engine state.
 * Dry thrust gives a short faint plume; reheat lights the long plume with
 * shock diamonds. `reheat` may be a boolean (the player's FlightModel) or a
 * 0..1 amount.
 */
export function plumeState(throttle, reheat) {
  const th = saturate(throttle ?? 0);
  const rh = typeof reheat === 'number'
    ? saturate(reheat)
    : (reheat ? 0.45 + 0.55 * saturate((th - 0.86) / 0.14) : 0);
  const dry = smoothstep(0.35, 0.9, th);
  // Lengths in metres for a MiG-21-sized nozzle: military power shows a
  // stub of faint flame, full reheat about 8 m with 4-5 shock diamonds.
  return {
    length: 0.6 + dry * 1.4 + rh * 6.0,
    diamonds: rh > 0 ? 3 + rh * 2 : 0,
    core: dry * 0.08 + rh * 0.9,
    glow: dry * 0.15 + rh,
    reheat: rh,
  };
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
  const wet = smoothstep(0.7, 1, humidity) * 0.5;
  return saturate(Math.max(g, a * 0.8, wet) * q * dens);
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

