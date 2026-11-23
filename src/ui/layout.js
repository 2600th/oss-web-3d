/**
 * HUD layout: where each instrument group sits for a given viewport.
 *
 * Pure function of size, safe-area insets, HUD scale and whether the touch
 * controls are showing, so it is unit-tested across 16:9, 21:9 / 32:9, and
 * phone portrait / landscape. Every anchor is in CSS pixels.
 *
 * Rules:
 *  - Flight symbology (ladder, FPM, tapes) stays in a central field no wider
 *    than ~16:9, so on ultrawide it does not stretch the eye across the screen.
 *  - Corner groups hug the safe area. On touch, the bottom band belongs to the
 *    thumbs, so instruments that would sit there move up.
 */

export const BASE = 820; // the viewport short side the HUD is drawn "at 1:1" for
export const TOUCH_TOP_W = 100; // two 44 px buttons + gap + margin
export const TOUCH_TOP_H = 44;

export function hudUnit(w, h, hudScale = 1) {
  const s = Math.min(w, h) / BASE;
  return Math.min(1.6, Math.max(0.62, s)) * hudScale;
}

export function computeLayout({ w, h, safe = {}, hudScale = 1, touch = false }) {
  const st = safe.top ?? 0;
  const sr = safe.right ?? 0;
  const sb = safe.bottom ?? 0;
  const sl = safe.left ?? 0;
  const s = hudUnit(w, h, hudScale);
  const portrait = h > w * 1.05;
  const pad = Math.round(Math.max(14, 22 * s));
  const L = sl + pad;
  const R = w - sr - pad;
  const T = st + pad;
  const B = h - sb - pad;

  // central field: at most 16:9 of the height, at most the usable width
  const fieldW = Math.min(R - L, h * (16 / 9));
  const cx = (L + R) / 2;
  let cy = (T + B) / 2;
  if (touch && portrait) cy = T + (B - T) * 0.36;
  else if (touch) cy = T + (B - T) * 0.46;

  // Tapes: x is each tape's spine; ticks, labels and readout boxes extend
  // outward from it by up to ~84 units (the altitude box is the widest).
  let tapeDx = Math.min(fieldW * 0.27, 330 * s);
  if (portrait) tapeDx = Math.min((R - L) / 2 - 84 * s, 300 * s);
  const tapeH = Math.min(portrait ? (B - T) * 0.3 : (B - T) * 0.46, 300 * s);

  const radarR = Math.round((touch ? 52 : portrait ? 60 : 78) * s);
  const layout = {
    s,
    w,
    h,
    portrait,
    touch,
    bounds: { L, R, T, B },
    cx,
    cy,
    fieldW,
    tapeH,
    speed: { x: cx - tapeDx, y: cy },
    alt: { x: cx + tapeDx, y: cy },
    heading: { x: cx, y: T + 14 * s, w: Math.min(fieldW * 0.42, 420 * s) },
    score: { x: R, y: T },
    objective: { x: L, y: T },
    radar: { x: L + radarR, y: B - radarR, r: radarR },
    health: { x: L + radarR * 2 + 18 * s, y: B },
    weapons: { x: R, y: B },
    radio: { x: cx, y: B - 64 * s, maxW: Math.min(R - L - 40, 640 * s) },
    warn: { x: cx, y: cy - tapeH * 0.62 },
    bannerY: T + 84 * s,
    // above the flight path marker: the chase-camera airframe sits below centre
    callout: { x: cx, y: cy - tapeH * 0.34 },
    ladderR: Math.min(tapeDx - 16 * s, tapeH * 0.95),
    arrowInset: Math.max(44 * s, 36) + Math.max(st, sr, sb, sl),
  };
  // Box that off-screen arrows hug (centre + half extents).
  const ai = layout.arrowInset;
  layout.arrowBox = { cx: w / 2, cy: h / 2, hw: w / 2 - ai, hh: h / 2 - ai };

  // On touch, the camera + pause buttons own the top-right corner
  // (TOUCH_TOP_W x TOUCH_TOP_H CSS px, see #touch .tz-top in styles.css).
  if (touch && portrait) {
    // Vertical zones, top to bottom: heading + corner buttons; radar, score
    // and objective; the flight field; weapons and airframe just under the
    // tapes; radio subtitles over the (invisible) upper stick zone; thumbs.
    const top = T + TOUCH_TOP_H + 10;
    const under = cy + tapeH / 2 + 40 * s; // clear of the G / radar-altitude row
    layout.radar = { x: L + radarR, y: top + radarR, r: radarR };
    layout.objective = { x: L, y: top + radarR * 2 + 14 * s };
    layout.score = { x: R, y: top };
    layout.weapons = { x: R, y: under };
    layout.weaponsTop = true;
    layout.health = { x: L, y: under + 30 * s };
    layout.radio = { x: cx, y: T + (B - T) * 0.6 + 100 * s, maxW: R - L - 20 };
    // a new-orders banner briefly covers the objective line it usually replaces
    layout.bannerY = layout.objective.y - 6 * s;
    layout.warn = { x: cx, y: cy - tapeH * 0.44 };
    layout.callout = { x: cx, y: cy - tapeH * 0.2 };
    // arrows stay above the thumb zone and clear of the side instruments
    const aTop = T + TOUCH_TOP_H + 14;
    const aBot = under - 8; // above the weapon / airframe rows and the BOOST button
    layout.arrowBox = { cx, cy: (aTop + aBot) / 2, hw: (R - L) / 2 - 10, hh: (aBot - aTop) / 2 };
    layout.heading = { x: cx, y: T + 6 * s, w: Math.min((R - L) * 0.5, 300 * s) };
  } else if (touch) {
    // Landscape phone: the stick and weapon cluster own the bottom corners.
    layout.radar = { x: L + radarR, y: T + radarR, r: radarR };
    layout.objective = { x: L + radarR * 2 + 16 * s, y: T };
    layout.score = { x: R - TOUCH_TOP_W - 10, y: T };
    layout.health = { x: L + radarR * 2 + 16 * s, y: T + 52 * s };
    layout.weapons = { x: R, y: T + TOUCH_TOP_H + 12 };
    layout.weaponsTop = true;
    // subtitles sit between the thumb clusters, banners low between the tapes
    layout.radio = { x: cx, y: B - 64 * s, maxW: Math.min(fieldW * 0.46, 360) };
    layout.bannerY = cy + tapeH / 2 - 52 * s;
    // arrows stay out of the bottom thumb corners
    const aTop = T + 20;
    const aBot = B - 120 * s;
    layout.arrowBox = { cx, cy: (aTop + aBot) / 2, hw: (R - L) / 2 - 20, hh: (aBot - aTop) / 2 };
  }
  return layout;
}
