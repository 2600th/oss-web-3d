import { DEM, isWater } from '../world/terrain/heightfield.js';
import { bakeRelief } from './radar.js';

/**
 * Bake the terrain into a shaded-relief canvas once, shared by the radar
 * backdrop, the mission-select thumbnails and the briefing map.
 *
 * Reads the heightfield module (src/world/terrain/heightfield.js), never the
 * pack files: heights from its decoded base grid `DEM.data` (nearest texel;
 * at 1024 px over the DEM each output texel spans a few cells, so bilinear
 * filtering and the sub-DEM detail buy nothing at map scale and the direct
 * read is several times faster), rivers from `isWater`. Returns null until
 * the DEM is loaded (node tests, early boot, boot failure).
 */
let cached = null;

export function getRelief(size = 1024) {
  if (cached && cached.size >= size) return cached;
  if (!DEM.ready || !DEM.data || typeof document === 'undefined') return null;
  const { res, data, minX, maxX, minZ, maxZ } = DEM;
  const sample = (x, z) => {
    const i = Math.min(res - 1, Math.max(0, Math.round(((x - minX) / (maxX - minX)) * (res - 1))));
    const j = Math.min(res - 1, Math.max(0, Math.round(((z - minZ) / (maxZ - minZ)) * (res - 1))));
    return data[j * res + i];
  };
  const bounds = { minX, maxX, minZ, maxZ };
  const water = DEM.river ? isWater : null;
  const px = bakeRelief(sample, bounds, size, { contour: 500, minH: DEM.heightMin, maxH: DEM.heightMax, water });
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  canvas.getContext('2d').putImageData(new ImageData(px, size, size), 0, 0);
  cached = { canvas, bounds, size };
  return cached;
}
