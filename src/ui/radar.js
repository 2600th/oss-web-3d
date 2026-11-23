/**
 * Radar maths and the DEM relief bake.
 *
 * The radar is heading-up: the player sits at the centre pointing to the top,
 * and the world rotates around them. World convention: +X east, +Z south
 * (north = -Z). Heading is degrees clockwise from north.
 */

/**
 * World offset -> radar disc coordinates (unit radius = `range` metres).
 * Writes {x, y, dist, clamped} where +y is down the screen (behind the jet).
 */
export function worldToRadar(dx, dz, headingDeg, range, out) {
  const h = (headingDeg * Math.PI) / 180;
  // Rotate the world by -heading about the up axis so the nose points up.
  // In north-up screen space a world offset is (east = dx, down = dz).
  const c = Math.cos(h);
  const s = Math.sin(h);
  const rx = dx * c + dz * s;
  const ry = -dx * s + dz * c;
  const dist = Math.hypot(dx, dz);
  let x = rx / range;
  let y = ry / range;
  const r = Math.hypot(x, y);
  const clamped = r > 1;
  if (clamped) {
    x /= r;
    y /= r;
  }
  out.x = x;
  out.y = y;
  out.dist = dist;
  out.clamped = clamped;
  return out;
}

/** Radar range ladder (m) and the step to the next one. */
export const RADAR_RANGES = [4000, 8000, 16000, 32000];

export function nextRange(current) {
  const i = RADAR_RANGES.indexOf(current);
  return RADAR_RANGES[(i + 1) % RADAR_RANGES.length];
}

/**
 * Pick an automatic range: the smallest that holds the nearest priority
 * contact, else the nearest hostile, with a little hysteresis margin.
 */
export function autoRange(distances, current = RADAR_RANGES[1]) {
  if (!distances.length) return current;
  const d = Math.min(...distances);
  for (const r of RADAR_RANGES) if (d < r * 0.85) return r;
  return RADAR_RANGES[RADAR_RANGES.length - 1];
}

/**
 * Hypsometric relief colour for a height in metres plus a hillshade term.
 * Returns [r, g, b] 0..255. Valley floors dark slate, scree warm grey,
 * snowline (~5000 m) pale. Kept dark overall so contacts read on top.
 */
export function reliefColor(h, shade, minH = 2479, maxH = 5947) {
  const t = Math.min(1, Math.max(0, (h - minH) / (maxH - minH)));
  // three stops: valley, scree, snow
  let r, g, b;
  if (t < 0.55) {
    const k = t / 0.55;
    r = 18 + k * 26;
    g = 30 + k * 22;
    b = 38 + k * 14;
  } else {
    const k = (t - 0.55) / 0.45;
    r = 44 + k * 70;
    g = 52 + k * 74;
    b = 52 + k * 84;
  }
  const s = 0.55 + shade * 0.75;
  return [Math.min(255, r * s), Math.min(255, g * s), Math.min(255, b * s)];
}

/**
 * Bake a relief image of the DEM into RGBA pixels. `sample(x, z)` returns
 * terrain height; bounds are world metres. Sun from the north-west (the
 * cartographic convention) so ridges read the way a pilot expects on a chart.
 * Contour lines every `contour` metres are darkened.
 */
export function bakeRelief(sample, bounds, size, { contour = 500, minH, maxH } = {}) {
  const px = new Uint8ClampedArray(size * size * 4);
  const { minX, maxX, minZ, maxZ } = bounds;
  const sx = (maxX - minX) / size;
  const sz = (maxZ - minZ) / size;
  const heights = new Float32Array(size * size);
  for (let j = 0; j < size; j++) {
    const z = minZ + (j + 0.5) * sz;
    for (let i = 0; i < size; i++) heights[j * size + i] = sample(minX + (i + 0.5) * sx, z);
  }
  // light direction (from NW, 40 deg elevation), in (east, south, up)
  const lx = -0.54;
  const lz = -0.54;
  const ly = 0.64;
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const k = j * size + i;
      const h = heights[k];
      const hl = heights[j * size + Math.max(0, i - 1)];
      const hr = heights[j * size + Math.min(size - 1, i + 1)];
      const hu = heights[Math.max(0, j - 1) * size + i];
      const hd = heights[Math.min(size - 1, j + 1) * size + i];
      // normal from central differences
      const nx = (hl - hr) / (2 * sx);
      const nz = (hu - hd) / (2 * sz);
      const inv = 1 / Math.hypot(nx, 1, nz);
      const shade = Math.max(0, (nx * lx + nz * lz + ly) * inv);
      const [r, g, b] = reliefColor(h, shade, minH, maxH);
      // contour: a band crossing between this texel and a neighbour
      const band = Math.floor(h / contour);
      const isLine = band !== Math.floor(hr / contour) || band !== Math.floor(hd / contour);
      const f = isLine ? 0.62 : 1;
      px[k * 4] = r * f;
      px[k * 4 + 1] = g * f;
      px[k * 4 + 2] = b * f;
      px[k * 4 + 3] = 255;
    }
  }
  return px;
}
