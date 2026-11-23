/**
 * Screen-space projection for HUD symbology. Pure maths over plain arrays so it
 * is node-testable and allocation-free in the frame loop.
 *
 * Matrices are column-major 16-element arrays exactly as three.js stores them
 * (`Matrix4.elements`): view = camera.matrixWorldInverse, proj =
 * camera.projectionMatrix. Reversed depth does not matter here: only clip x, y
 * and w are used, never z.
 */

/**
 * Project a world point. Writes into `out` = {x, y, w, behind, onScreen} where
 * x, y are CSS pixels (origin top-left) and `behind` means the point is behind
 * the camera plane (its x,y are mirrored so edge arrows still point the right
 * way round).
 */
export function projectPoint(px, py, pz, view, proj, width, height, out, margin = 0) {
  // view space
  const vx = view[0] * px + view[4] * py + view[8] * pz + view[12];
  const vy = view[1] * px + view[5] * py + view[9] * pz + view[13];
  const vz = view[2] * px + view[6] * py + view[10] * pz + view[14];
  // clip space (w = -vz for a perspective camera, but use the matrix for generality)
  const cx = proj[0] * vx + proj[4] * vy + proj[8] * vz + proj[12];
  const cy = proj[1] * vx + proj[5] * vy + proj[9] * vz + proj[13];
  const cw = proj[3] * vx + proj[7] * vy + proj[11] * vz + proj[15];
  const behind = cw <= 1e-6;
  const w = behind ? Math.max(-cw, 1e-6) : cw;
  // Dividing by |w| (not w) keeps a point behind the camera on the side it
  // is really on: behind-right stays right, which is the way to turn.
  let nx = cx / w;
  let ny = cy / w;
  if (behind) {
    // A point straight behind projects near the centre; push it outward so the
    // edge arrow has a stable direction instead of jittering through zero.
    const len = Math.hypot(nx, ny);
    if (len < 1e-3) {
      nx = 0;
      ny = -1;
    } else {
      nx = (nx / len) * 2;
      ny = (ny / len) * 2;
    }
  }
  out.x = (nx * 0.5 + 0.5) * width;
  out.y = (1 - (ny * 0.5 + 0.5)) * height;
  out.w = cw;
  out.depth = -vz;
  out.behind = behind;
  out.onScreen = !behind && out.x >= margin && out.x <= width - margin && out.y >= margin && out.y <= height - margin;
  return out;
}

/**
 * Clamp a screen point to a rounded edge box for off-screen arrows.
 * Returns {x, y, angle} where angle (radians, screen space, 0 = right, +y down)
 * points from the screen centre toward the target.
 */
export function edgeClamp(x, y, width, height, inset, out) {
  return boxClamp(x, y, width / 2, height / 2, width / 2 - inset, height / 2 - inset, out);
}

/** As edgeClamp, for an arbitrary box (centre cx, cy; half extents hw, hh). */
export function boxClamp(x, y, cx, cy, hw, hh, out) {
  const dx = x - cx;
  const dy = y - cy;
  const angle = Math.atan2(dy, dx);
  hw = Math.max(1, hw);
  hh = Math.max(1, hh);
  // Superellipse (n = 4): hugs the screen edge but rounds the corners, so
  // arrows never pile up in a corner where safe areas bite.
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const n = 4;
  const r = Math.pow(Math.pow(Math.abs(c) / hw, n) + Math.pow(Math.abs(s) / hh, n), -1 / n);
  out.x = cx + c * r;
  out.y = cy + s * r;
  out.angle = angle;
  return out;
}

/**
 * First-order gun lead: where to put the pipper so rounds fired now meet the
 * target. Iterates time-of-flight twice (enough for < 2 km, |v| < 400 m/s).
 * Shooter velocity is added to the round (rounds inherit the jet's speed).
 * Writes the aim point into `out` = {x, y, z, tof}.
 */
export function gunLead(shooterPos, shooterVel, targetPos, targetVel, muzzleSpeed, out) {
  const sv = shooterVel ?? ZERO;
  const tv = targetVel ?? ZERO;
  // relative velocity of target w.r.t. shooter
  const rvx = tv.x - sv.x;
  const rvy = tv.y - sv.y;
  const rvz = tv.z - sv.z;
  let tof = 0;
  let ax = targetPos.x;
  let ay = targetPos.y;
  let az = targetPos.z;
  for (let i = 0; i < 3; i++) {
    const dx = ax - shooterPos.x;
    const dy = ay - shooterPos.y;
    const dz = az - shooterPos.z;
    tof = Math.hypot(dx, dy, dz) / Math.max(1, muzzleSpeed);
    ax = targetPos.x + rvx * tof;
    ay = targetPos.y + rvy * tof;
    az = targetPos.z + rvz * tof;
  }
  // Gravity drop on the round over its flight, compensated upward.
  ay += 0.5 * 9.81 * tof * tof;
  out.x = ax;
  out.y = ay;
  out.z = az;
  out.tof = tof;
  return out;
}

const ZERO = { x: 0, y: 0, z: 0 };

/** Pixels per degree of vertical field of view at the screen centre. */
export function pixelsPerDegree(fovDeg, heightPx) {
  const f = (Math.max(1, Math.min(170, fovDeg)) * Math.PI) / 180;
  // tan-correct at the centre: d(px)/d(theta) = (h/2) / tan(fov/2)
  return (heightPx / 2 / Math.tan(f / 2)) * (Math.PI / 180);
}

/** Bearing (deg, 0 = north, clockwise) from a to b in world space (north = -Z). */
export function bearingDeg(ax, az, bx, bz) {
  const deg = (Math.atan2(bx - ax, -(bz - az)) * 180) / Math.PI;
  return deg < 0 ? deg + 360 : deg;
}
