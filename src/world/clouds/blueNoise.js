/**
 * Blue-noise dither mask by void-and-cluster (Ulichney 1993), pure JS.
 *
 * The cloud ray march offsets each ray's start by this mask (animated with the
 * golden ratio per frame) so step banding turns into high-frequency noise that
 * the temporal resolve removes. Generated once at start-up; 64x64 takes a few
 * tens of milliseconds.
 */

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Returns Float32Array(size*size) holding a permutation rank / (size*size) in [0,1). */
export function generateBlueNoise(size = 64, seed = 1999, sigma = 1.5) {
  const n = size * size;
  const R = Math.min(Math.ceil(sigma * 4), (size >> 1) - 1);
  const K = 2 * R + 1;
  const kernel = new Float32Array(K * K);
  for (let y = -R; y <= R; y++) for (let x = -R; x <= R; x++) {
    kernel[(y + R) * K + x + R] = Math.exp(-(x * x + y * y) / (2 * sigma * sigma));
  }
  const energy = new Float32Array(n);
  const on = new Uint8Array(n);
  const splat = (idx, sign) => {
    const px = idx % size, py = (idx / size) | 0;
    for (let y = -R; y <= R; y++) {
      const row = ((py + y + size) % size) * size;
      const krow = (y + R) * K + R;
      for (let x = -R; x <= R; x++) energy[row + ((px + x + size) % size)] += sign * kernel[krow + x];
    }
  };
  const extreme = (wantOn, tightest) => {
    let best = -1, bestE = tightest ? -Infinity : Infinity;
    for (let i = 0; i < n; i++) {
      if ((on[i] === 1) !== wantOn) continue;
      const e = energy[i];
      if (tightest ? e > bestE : e < bestE) { bestE = e; best = i; }
    }
    return best;
  };

  // Initial binary pattern: ~10 % ones, then relax until moving the tightest
  // cluster into the largest void no longer changes anything.
  const rand = mulberry32(seed);
  const initial = Math.max(4, Math.floor(n * 0.1));
  let count = 0;
  while (count < initial) {
    const i = Math.floor(rand() * n);
    if (!on[i]) { on[i] = 1; splat(i, 1); count++; }
  }
  for (let guard = 0; guard < n * 4; guard++) {
    const c = extreme(true, true);
    on[c] = 0; splat(c, -1);
    const v = extreme(false, false);
    on[v] = 1; splat(v, 1);
    if (v === c) break;
  }

  const rank = new Float32Array(n);
  const proto = on.slice();
  const protoEnergy = energy.slice();
  // Phase 1: peel the prototype, tightest cluster first, ranks initial-1 .. 0.
  for (let r = initial - 1; r >= 0; r--) {
    const c = extreme(true, true);
    on[c] = 0; splat(c, -1);
    rank[c] = r;
  }
  // Phases 2-3: fill the largest void, ranks initial .. n-1.
  on.set(proto);
  energy.set(protoEnergy);
  for (let r = initial; r < n; r++) {
    const v = extreme(false, false);
    on[v] = 1; splat(v, 1);
    rank[v] = r;
  }
  for (let i = 0; i < n; i++) rank[i] /= n;
  return rank;
}
