// Line of sight with a sample spacing that does not depend on the range.
//
// heightfield.lineOfSight takes a sample *count*; every caller passed a fixed
// one (16 to 40), so a 9 km SAM shot was tested every 400 m and a fighter's
// 6 km look every 375 m. A Himalayan ridge crest is narrower than that, so
// units "saw" through ridges about as often as not: SAM sites launched at an
// aircraft masked behind a spur, and the player's own lock went through the
// hill it then flew the missile into. This keeps the spacing near `spacing`
// metres whatever the distance.
import { lineOfSight } from '../world/terrain/heightfield.js';

export function clearLine(a, b, spacing = 90) {
  const d = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
  return lineOfSight(a, b, Math.min(200, Math.max(8, Math.ceil(d / spacing))));
}
