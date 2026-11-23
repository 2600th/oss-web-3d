/**
 * Motion-blur parameters per frame (pure, no three.js; unit-tested).
 *
 *  strength       multiplier on the per-frame velocity: a fixed *shutter time*
 *                 (1/90 s, about a 240 degree shutter at 60 fps) divided by the
 *                 frame time, so the streak length per second of motion is the
 *                 same at 45 fps and 144 fps; scaled by speed so a slow jet is
 *                 crisp, and by the user setting
 *  maxPx          the blur half-extent clamp in pixels (= the reconstruction's
 *                 tile size; scales with the pixel ratio)
 *  zoom           radial "speed zoom" per frame from the flight-path focus:
 *                 near the ground at speed, plus a little at transonic speed
 *  playerShutter  the player airframe's own (much shorter) shutter
 */
export const MOTION_DEFAULTS = Object.freeze({
  shutter: 1 / 90,
  zoomLow: 0.0055, // per frame at full effect, uv-fraction of the distance from focus
  zoomTransonic: 0.0016,
  playerShutter: 0.12,
});

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

/** Views where the lens rides with the jet (speed effects apply). */
export const RIDING_VIEWS = new Set(['chase', 'cockpit', 'hud', 'lock', 'action']);

export function motionBlurParams({
  dt = 1 / 60, airspeed = 0, agl = 1e4, mach = 0, reheat = false, user = 1, reducedMotion = false,
  cut = false, view = 'chase', tile = 32, pixelRatio = 1,
} = {}, o = MOTION_DEFAULTS) {
  const maxPx = tile * clamp(pixelRatio, 0.5, 2);
  if (reducedMotion || cut || !(user > 0)) return { strength: 0, zoom: 0, maxPx, playerShutter: o.playerShutter };
  const shutter = clamp(o.shutter / Math.max(dt, 1e-3), 0.5, 2.2);
  const riding = RIDING_VIEWS.has(view);
  // camera-only views (kill cam, cinematics) keep a constant, filmic blur
  const speedK = riding ? 0.35 + 0.65 * smooth(70, 300, airspeed) : 0.8;
  const strength = shutter * speedK * user;
  // speed zoom: strongest fast and low (terrain rushing at you); a whisper at Mach 1
  const low = smooth(170, 330, airspeed) * (1 - smooth(40, 450, agl));
  const trans = smooth(0.85, 1.0, mach);
  const zoom = riding ? (low * o.zoomLow * (reheat ? 1.2 : 1) + trans * o.zoomTransonic) * user * Math.min(shutter, 1.5) : 0;
  return { strength, zoom, maxPx, playerShutter: o.playerShutter };
}
