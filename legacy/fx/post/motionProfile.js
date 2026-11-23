const MAX_DISPLACEMENT_PX = 6;
const MAX_RADIAL_PX = 4;
const ANGULAR_PIXELS_PER_RADIAN_PER_SECOND = 3.2;

function finiteOrZero(value) {
  return Number.isFinite(value) ? value : 0;
}

/**
 * Convert per-frame camera rotation and airspeed into bounded 720p blur inputs.
 * angularX/angularY are camera-direction deltas in radians for the current
 * frame; dividing by dt makes the response independent of frame rate.
 */
export function computeMotionProfile({
  airspeed = 0,
  angularX = 0,
  angularY = 0,
  dt = 0,
  flying = false,
  reconActive = false,
  reducedMotion = false,
} = {}, output = {}) {
  const edgeStart = 0.45;
  if (!flying || reconActive || reducedMotion) {
    output.angularX = 0;
    output.angularY = 0;
    output.radialPixels = 0;
    output.amount = 0;
    output.edgeStart = edgeStart;
    output.combinedPixels = 0;
    return output;
  }

  const safeDt = Number.isFinite(dt) && dt > 0 ? dt : 0;
  const speed = Math.max(0, finiteOrZero(airspeed));
  const speedT = Math.min(1, Math.max(0, (speed - 120) / 300));
  let radialPixels = Math.pow(speedT, 0.9) * MAX_RADIAL_PX;

  let x = safeDt > 0
    ? finiteOrZero(angularX) / safeDt * ANGULAR_PIXELS_PER_RADIAN_PER_SECOND
    : 0;
  let y = safeDt > 0
    ? finiteOrZero(angularY) / safeDt * ANGULAR_PIXELS_PER_RADIAN_PER_SECOND
    : 0;

  const angularPixels = Math.hypot(x, y);
  const uncappedCombined = radialPixels + angularPixels;
  if (uncappedCombined > MAX_DISPLACEMENT_PX) {
    const scale = MAX_DISPLACEMENT_PX / uncappedCombined;
    radialPixels *= scale;
    x *= scale;
    y *= scale;
  }

  const combinedPixels = Math.min(MAX_DISPLACEMENT_PX, radialPixels + Math.hypot(x, y));
  output.angularX = x;
  output.angularY = y;
  output.radialPixels = radialPixels;
  output.amount = combinedPixels > 0.001 ? 1 : 0;
  output.edgeStart = edgeStart;
  output.combinedPixels = combinedPixels;
  return output;
}
