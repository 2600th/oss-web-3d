import { projectPoint } from './projection.js';

/**
 * The player's own jet as a screen rect, for the outside (chase-type) views:
 * target labels treat it as an obstacle the way they treat the instruments,
 * so "TRUCK 2.5km" does not land on the burner glow or a wing. The markers
 * themselves still draw where their targets are.
 *
 * Pure maths (node-testable), allocation-free per frame.
 */

/**
 * MiG-21 extents in aircraft model space (metres, nose -Z, origin at the
 * bounding-box centre; length 15.76 m, span 7.33 m, fin top ~2.1 m above the
 * centre). The aft end reaches past the nozzle (+6.4 m) over the burner
 * plume's hot core.
 */
export const OWN_JET_EXTENT = Object.freeze({ x0: -3.7, x1: 3.7, y0: -1.9, y1: 2.15, z0: -7.9, z1: 9.2 });

/**
 * The same airframe as six boxes, so the screen obstacle follows the jet's
 * shape rather than its bounding rect (from the chase camera the corners of
 * that rect, ahead of the swept wing, are open sky or ground and a label there
 * is fine): fuselage with intakes, canopy and the burner's glowing nozzle; the
 * fin; the inner wing with its stores; the stabilators; the two outer wing
 * panels (the tips are at z +2.74). Parts near the chase camera project large,
 * so each one stops where the airframe does.
 */
export const OWN_JET_PARTS = Object.freeze([
  Object.freeze({ x0: -0.95, x1: 0.95, y0: -1.25, y1: 0.6, z0: -7.9, z1: 7.4 }),
  Object.freeze({ x0: -0.2, x1: 0.2, y0: 0, y1: 2.15, z0: 2.4, z1: 7.9 }),
  Object.freeze({ x0: -2.6, x1: 2.6, y0: -1.6, y1: -0.3, z0: -1.4, z1: 4.4 }),
  Object.freeze({ x0: -2.7, x1: 2.7, y0: -0.85, y1: -0.25, z0: 4.4, z1: 7.0 }),
  Object.freeze({ x0: -3.7, x1: -2.6, y0: -1.3, y1: -0.4, z0: 1.2, z1: 4.0 }),
  Object.freeze({ x0: 2.6, x1: 3.7, y0: -1.3, y1: -0.4, z0: 1.2, z1: 4.0 }),
]);

const _c = { x: 0, y: 0, w: 0, depth: 0, behind: false, onScreen: false };

/**
 * Screen rect {x0, y0, x1, y1} (CSS px) of the projected box `ext` under the
 * model matrix `m` (column-major 16, aircraft -> world), or null when any
 * corner is behind the camera (inside the jet: the cockpit) or the rect is
 * wholly off screen. `pad` grows the rect on every side.
 */
export function ownJetBox(m, view, proj, width, height, ext = OWN_JET_EXTENT, out = {}, pad = 0) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let i = 0; i < 8; i++) {
    const lx = i & 1 ? ext.x1 : ext.x0;
    const ly = i & 2 ? ext.y1 : ext.y0;
    const lz = i & 4 ? ext.z1 : ext.z0;
    const wx = m[0] * lx + m[4] * ly + m[8] * lz + m[12];
    const wy = m[1] * lx + m[5] * ly + m[9] * lz + m[13];
    const wz = m[2] * lx + m[6] * ly + m[10] * lz + m[14];
    projectPoint(wx, wy, wz, view, proj, width, height, _c);
    if (_c.behind) return null;
    if (_c.x < x0) x0 = _c.x;
    if (_c.x > x1) x1 = _c.x;
    if (_c.y < y0) y0 = _c.y;
    if (_c.y > y1) y1 = _c.y;
  }
  if (x1 < 0 || y1 < 0 || x0 > width || y0 > height) return null;
  out.x0 = x0 - pad;
  out.y0 = y0 - pad;
  out.x1 = x1 + pad;
  out.y1 = y1 + pad;
  return out;
}

/**
 * Screen rects of the airframe parts (`parts`, default OWN_JET_PARTS) into
 * `out` (an array of reusable rect objects, grown on first use). Returns how
 * many rects were written; 0 when the jet is behind the camera or off screen.
 */
export function ownJetRects(m, view, proj, width, height, out, pad = 0, parts = OWN_JET_PARTS) {
  let n = 0;
  for (const ext of parts) {
    const r = (out[n] ??= { x0: 0, y0: 0, x1: 0, y1: 0 });
    if (ownJetBox(m, view, proj, width, height, ext, r, pad)) n++;
  }
  return n;
}
