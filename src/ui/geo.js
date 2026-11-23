/**
 * Geographic helpers for the briefing map and the fallback mission list.
 *
 * World origin = DEM centre (lon 76.09 E, lat 34.50 N); +X east, +Z south.
 * Equirectangular is exact enough at this scale (90 km box): the error against
 * the DEM build's own projection is well under one DEM cell.
 */

export const ORIGIN = { lon: 76.09, lat: 34.5 };
const M_PER_DEG_LAT = 110574;
const M_PER_DEG_LON = 111320 * Math.cos((ORIGIN.lat * Math.PI) / 180);

export function lonLatToWorld(lon, lat) {
  return { x: (lon - ORIGIN.lon) * M_PER_DEG_LON, z: -(lat - ORIGIN.lat) * M_PER_DEG_LAT };
}

export function worldToLonLat(x, z) {
  return { lon: ORIGIN.lon + x / M_PER_DEG_LON, lat: ORIGIN.lat - z / M_PER_DEG_LAT };
}

/**
 * Real place names for map labels only. Positions are approximate, rounded to
 * about a kilometre; nothing in gameplay depends on them.
 */
export const PLACES = [
  { name: 'Drass', lon: 75.76, lat: 34.43, kind: 'town' },
  { name: 'Kargil', lon: 76.13, lat: 34.56, kind: 'town' },
  { name: 'Batalik', lon: 76.36, lat: 34.62, kind: 'town' },
  { name: 'Tololing', lon: 75.81, lat: 34.42, kind: 'peak' },
  { name: 'Tiger Hill', lon: 75.73, lat: 34.47, kind: 'peak' },
  { name: 'Mushkoh', lon: 75.66, lat: 34.39, kind: 'valley' },
  { name: 'Indus', lon: 76.3, lat: 34.7, kind: 'river' },
  { name: 'Suru', lon: 76.06, lat: 34.36, kind: 'river' },
].map((p) => ({ ...p, ...lonLatToWorld(p.lon, p.lat) }));
