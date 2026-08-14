import { terrainHeight } from '../world/heightfield.js';

/**
 * Shared terrain line-of-sight visibility, from 0 (blocked) to 1 (clear).
 * Endpoint margins keep a low aircraft and ground objective from occluding
 * themselves; the 40 m soft edge preserves degraded ridge-skimming shots.
 */
export function terrainVisibility(from, to, heightAt = terrainHeight) {
  const steps = 30;
  const first = 0.05;
  const last = 0.9;
  let clearance = Infinity;

  for (let i = 0; i <= steps; i++) {
    const t = first + ((last - first) * i) / steps;
    const x = from.x + (to.x - from.x) * t;
    const y = from.y + (to.y - from.y) * t;
    const z = from.z + (to.z - from.z) * t;
    clearance = Math.min(clearance, y - heightAt(x, z));
  }

  if (clearance <= 0) return 0;
  return Math.min(clearance / 40, 1);
}
