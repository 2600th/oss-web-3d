/**
 * Pure maths behind the effects (no three.js; unit-tested in Node):
 * the blackbody fire ramp the shaders mirror, near-plane clipping of trail
 * segments, per-metre emission along a path, the lightning channel
 * generator and the scorch-decal ring.
 */

// ------------------------------------------------------------------ fire --

/**
 * Fire colour from a 0..~1.7 "heat" (the particle's emissive channel).
 *
 * heat -> temperature T = 650 + 1050 heat kelvin (0.4 ~ 1070 K dull red,
 * 1 = 1700 K orange, 1.7 ~ 2430 K yellow). Colour is Planck's law sampled at
 * 610 / 550 / 465 nm in the Wien limit, normalised to red:
 *   g/r = (610/550)^5 exp(-c2 (1/550nm - 1/610nm) / T) = 1.677 exp(-2573 / T)
 *   b/r = (610/465)^5 exp(-c2 (1/465nm - 1/610nm) / T) = 3.88  exp(-7355 / T)
 * Brightness follows the red channel's Wien term with a softened exponent
 * (real radiance spans ~1000x between 1100 and 1700 K, which would make the
 * dull-red stage invisible next to the core):
 *   I = exp(6000 (1/1700 - 1/T))
 * scaled so heat 1 lands near the old ramp's orange. There is no blue or
 * magenta anywhere on the curve: b <= g <= r for every T below 6500 K.
 * `src/vfx/core/shared.js` fireRamp is the TSL twin of this function.
 */
export const FIRE = Object.freeze({ t0: 650, t1: 1050, gain: 1.9, k: 6000, tRef: 1700, gC: 2573, gA: 1.677, bC: 7355, bA: 3.88, hMax: 1.7 });

export function fireTemperature(heat) {
  const h = Math.min(FIRE.hMax, Math.max(0, heat));
  return FIRE.t0 + FIRE.t1 * h;
}

export function fireColor(heat, out = [0, 0, 0]) {
  const T = fireTemperature(heat);
  const I = FIRE.gain * Math.exp(FIRE.k * (1 / FIRE.tRef - 1 / T));
  out[0] = I;
  out[1] = I * FIRE.gA * Math.exp(-FIRE.gC / T);
  out[2] = I * FIRE.bA * Math.exp(-FIRE.bC / T);
  return out;
}

/**
 * How much of a puff's lit (scattered) colour survives at a given heat: the
 * hot core of a fireball is soot glowing from inside, not white smoke with
 * light added on top (the old additive mix read pink and peach).
 */
export const litKeep = (heat) => 1 - 0.85 * Math.min(1, Math.max(0, heat));

// --------------------------------------------------------------- ribbons --

/**
 * Clip a view-space segment (z negative in front of the camera) against the
 * plane z = nearZ (< 0). Returns the parameters along a -> b of the clipped
 * end points; `visible` is false when both ends are behind the plane.
 * The trail shader does the same in TSL: a segment that crosses the camera
 * plane used to project its far corners through infinity (the huge
 * translucent wedges).
 */
export function clipSegmentNear(az, bz, nearZ) {
  const aBehind = az > nearZ, bBehind = bz > nearZ;
  if (aBehind && bBehind) return { visible: false, ta: 0, tb: 0 };
  const d = bz - az;
  const t = Math.abs(d) > 1e-9 ? (nearZ - az) / d : 0;
  return { visible: true, ta: aBehind ? t : 0, tb: bBehind ? t : 1 };
}

// ----------------------------------------------------- per-metre emission --

/** State for `emitAlong`: where the last puff went down and how far the source has gone since. */
export function makePath() {
  return { has: false, x: 0, y: 0, z: 0, carry: 0 };
}

/**
 * Emit along the path a moving source traced since the last call, one puff
 * every `spacing` metres, so a trail has the same density at any speed and
 * frame rate (per-second emission beads into clumps when the frame rate
 * dips or the source speeds up). Calls `cb(x, y, z, k)` for each puff, with
 * k in (0, 1] the fraction of this frame's step at which it sits (for
 * sub-frame ageing). At most `max` puffs per call: past that the spacing
 * stretches evenly. A jump longer than `teleport` restarts the path.
 * Returns the number of puffs.
 */
export function emitAlong(path, x, y, z, spacing, max, cb, teleport = 2000) {
  if (!path.has) {
    path.has = true; path.x = x; path.y = y; path.z = z; path.carry = 0;
    cb(x, y, z, 1);
    return 1;
  }
  const dx = x - path.x, dy = y - path.y, dz = z - path.z;
  const len = Math.hypot(dx, dy, dz);
  if (len > teleport) { path.has = false; return emitAlong(path, x, y, z, spacing, max, cb, teleport); }
  const s = Math.max(1e-3, spacing);
  const total = path.carry + len;
  let n = Math.floor(total / s);
  let step = s;
  if (n > max) { step = total / max; n = max; }
  if (n === 0 || len < 1e-6) {
    path.carry = total;
    path.x = x; path.y = y; path.z = z;
    return 0;
  }
  // first puff `step - carry` metres along this frame's segment
  const ox = path.x, oy = path.y, oz = path.z;
  let d = step - path.carry;
  for (let i = 0; i < n; i++, d += step) {
    const k = Math.min(1, d / len);
    cb(ox + dx * k, oy + dy * k, oz + dz * k, k);
  }
  path.carry = total - n * step;
  path.x = x; path.y = y; path.z = z;
  return n;
}

/** Puff size on a tier that emits `rate` x as many: keeps neighbours overlapping (size x 1/sqrt(rate)). */
export const sizeForRate = (rate) => 1 / Math.sqrt(Math.max(0.05, rate));

/**
 * Seconds an explosion's smoke hangs, from the fireball radius: a shell hit
 * clears in under a quarter of a minute, a big blast's cloud stays for most
 * of a minute (capped under the particle pools' 64 s life span).
 */
export const blastSmokeLife = (R) => Math.min(55, Math.max(12, 8 + R * 1.6));

// ------------------------------------------------------------- lightning --

/**
 * A lightning channel from `top` (in the cloud) to `bottom` (the ground) by
 * midpoint displacement, with branches.
 *   rng       () -> [0, 1)
 *   opts      { depth (subdivision levels, 6 -> 64 main segments), rough
 *               (displacement per unit length), branch (chance per joint),
 *               width (main channel half-width, metres) }
 * Returns [{ a: [x,y,z], b: [x,y,z], w, k }] with w the half-width and k the
 * brightness (1 on the main channel, less on branches and their children).
 */
export function makeBolt(rng, top, bottom, opts = {}) {
  const depth = opts.depth ?? 6, rough = opts.rough ?? 0.22, branch = opts.branch ?? 0.22, width = opts.width ?? 2.2;
  const segs = [];
  const channel = (a, b, lv, w, k, budget) => {
    let pts = [a, b];
    for (let d = 0; d < lv; d++) {
      const next = [pts[0]];
      for (let i = 0; i < pts.length - 1; i++) {
        const p = pts[i], q = pts[i + 1];
        const len = Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]);
        const off = len * rough;
        // displacement mostly horizontal: channels zig-zag sideways as they fall
        next.push([(p[0] + q[0]) / 2 + (rng() - 0.5) * 2 * off, (p[1] + q[1]) / 2 + (rng() - 0.5) * off * 0.6, (p[2] + q[2]) / 2 + (rng() - 0.5) * 2 * off]);
        next.push(q);
      }
      pts = next;
    }
    for (let i = 0; i < pts.length - 1; i++) {
      // the channel thins a little toward its end
      const f = 1 - 0.35 * (i / pts.length);
      segs.push({ a: pts[i], b: pts[i + 1], w: w * f, k });
      if (budget > 0 && i > 1 && i < pts.length - 3 && rng() < branch / (1 + (segs.length / 60))) {
        const p = pts[i], rest = pts[pts.length - 1];
        const L = Math.hypot(rest[0] - p[0], rest[1] - p[1], rest[2] - p[2]) * (0.2 + rng() * 0.25);
        const ang = rng() * Math.PI * 2;
        const drop = 0.55 + rng() * 0.35;
        const end = [p[0] + Math.cos(ang) * L * (1 - drop), p[1] - L * drop, p[2] + Math.sin(ang) * L * (1 - drop)];
        channel(p, end, Math.max(2, lv - 2), w * 0.45, k * 0.45, budget - 1);
      }
    }
  };
  channel([top.x, top.y, top.z], [bottom.x, bottom.y, bottom.z], depth, width, 1, 2);
  return segs;
}

/**
 * Brightness of a strike over time from its return strokes ([{t, amp}],
 * Weather.strike): each stroke a sharp rise and a fast fall, ~80-200 ms in
 * all. Same envelope as the environment's flash, so the bolt and the sky
 * light up together.
 */
export function strokeEnvelope(strokes, age) {
  let f = 0;
  for (const q of strokes) {
    const a = age - q.t;
    if (a >= 0) f = Math.max(f, q.amp * Math.exp(-a / 0.045) * Math.min(1, a / 0.008 + 0.25));
  }
  return f;
}

// -------------------------------------------------------------- scorches --

/**
 * Ring buffer of ground scorch decals (blast marks) for the terrain material
 * to sample: positions, radii and birth times, newest overwriting oldest.
 * `packed` is [x, z, radius, birth] per slot (vec4-ready for a uniform array
 * or a 1-row float texture); `version` bumps on every write.
 */
export class ScorchRing {
  constructor(capacity = 32) {
    this.capacity = capacity;
    this.positions = new Float32Array(capacity * 3);
    this.radii = new Float32Array(capacity);
    this.births = new Float32Array(capacity).fill(-1e9);
    this.packed = new Float32Array(capacity * 4);
    for (let i = 0; i < capacity; i++) this.packed[i * 4 + 3] = -1e9;
    this.head = 0;
    this.count = 0;
    this.version = 0;
  }

  add(x, y, z, radius, time) {
    const i = this.head;
    this.head = (this.head + 1) % this.capacity;
    this.count = Math.min(this.capacity, this.count + 1);
    this.positions[i * 3] = x; this.positions[i * 3 + 1] = y; this.positions[i * 3 + 2] = z;
    this.radii[i] = radius;
    this.births[i] = time;
    const o = i * 4;
    this.packed[o] = x; this.packed[o + 1] = z; this.packed[o + 2] = radius; this.packed[o + 3] = time;
    this.version++;
    return i;
  }

  /** Seconds since slot `i` was written (Infinity if never). */
  age(i, now) { return this.births[i] < -1e8 ? Infinity : now - this.births[i]; }

  clear() {
    this.births.fill(-1e9);
    for (let i = 0; i < this.capacity; i++) this.packed[i * 4 + 3] = -1e9;
    this.head = 0; this.count = 0; this.version++;
  }
}
