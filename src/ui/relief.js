import { DEM } from '../world/terrain/heightfield.js';
import { bakeRelief } from './radar.js';

/**
 * Bake the DEM into a shaded-relief canvas once, shared by the radar backdrop,
 * the mission-select thumbnails and the briefing map.
 *
 * Samples the DEM array directly (nearest texel) rather than through
 * terrainHeight(): at 1024 px over 90 km each output texel spans two DEM cells,
 * so bilinear filtering buys nothing and the direct read is several times
 * faster. Returns null when the DEM is not loaded (node tests, boot failure).
 */
let cached = null;

export function getRelief(size = 1024) {
  if (cached && cached.size >= size) return cached;
  if (!DEM.ready || typeof document === 'undefined') return null;
  const { res, data, minX, maxX, minZ, maxZ } = DEM;
  const sample = (x, z) => {
    const i = Math.min(res - 1, Math.max(0, Math.round(((x - minX) / (maxX - minX)) * (res - 1))));
    const j = Math.min(res - 1, Math.max(0, Math.round(((z - minZ) / (maxZ - minZ)) * (res - 1))));
    return data[j * res + i];
  };
  const bounds = { minX, maxX, minZ, maxZ };
  const px = bakeRelief(sample, bounds, size, { contour: 500, minH: DEM.heightMin, maxH: DEM.heightMax });
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  canvas.getContext('2d').putImageData(new ImageData(px, size, size), 0, 0);
  cached = { canvas, bounds, size };
  return cached;
}
