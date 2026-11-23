/**
 * Pure formatting for HUD readouts and screens. No DOM, no THREE — node-testable.
 *
 * Units: the flight model is metric (m, m/s). The HUD shows knots and feet,
 * the units a MiG-21 Bison pilot of 1999 actually read, plus kilometres for
 * target range (the radar's unit on this jet).
 */

export const MS_TO_KT = 1.943844;
export const M_TO_FT = 3.28084;

export const toKnots = (ms) => (Number.isFinite(ms) ? ms * MS_TO_KT : 0);
export const toFeet = (m) => (Number.isFinite(m) ? m * M_TO_FT : 0);

/** Wrap an angle in degrees to [0, 360). */
export function wrap360(deg) {
  if (!Number.isFinite(deg)) return 0;
  const r = deg % 360;
  return r < 0 ? r + 360 : r;
}

/** Wrap to (-180, 180]. */
export function wrap180(deg) {
  const r = wrap360(deg);
  return r > 180 ? r - 360 : r;
}

/** Heading as three digits: 7 -> "007", 360 -> "360" convention: 0 shows "360". */
export function formatHeading(deg) {
  let h = Math.round(wrap360(deg));
  if (h === 0) h = 360;
  return String(h).padStart(3, '0');
}

const CARDINALS = { 0: 'N', 90: 'E', 180: 'S', 270: 'W', 360: 'N' };
/** Label for a heading-tape major tick (every 10 degrees): N/E/S/W or "03". */
export function headingTickLabel(deg) {
  const d = wrap360(Math.round(deg));
  if (CARDINALS[d]) return CARDINALS[d];
  return String(Math.round(d / 10)).padStart(2, '0');
}

/** Thousands separator with thin space, e.g. 12450 -> "12 450". */
export function groupThousands(n, sep = ' ') {
  const v = Math.round(Number.isFinite(n) ? n : 0);
  const s = String(Math.abs(v)).replace(/\B(?=(\d{3})+(?!\d))/g, sep);
  return v < 0 ? '-' + s : s;
}

/** Score as a fixed-width 7-digit counter. */
export function formatScore(n) {
  const v = Math.max(0, Math.round(Number.isFinite(n) ? n : 0));
  return String(Math.min(v, 9999999)).padStart(7, '0');
}

/** Seconds -> "m:ss" (or "h:mm:ss"), never negative. */
export function formatClock(sec) {
  const s = Math.max(0, Math.floor(Number.isFinite(sec) ? sec : 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${ss}`;
  return `${m}:${ss}`;
}

/** Target range: < 1 km in metres rounded to 10, else km with one decimal below 10. */
export function formatRange(m) {
  if (!Number.isFinite(m) || m < 0) return '';
  if (m < 1000) return `${Math.round(m / 10) * 10}m`;
  if (m < 10000) return `${(m / 1000).toFixed(1)}km`;
  return `${Math.round(m / 1000)}km`;
}

/** Percentage 0..1 -> "73%". */
export function formatPercent(f) {
  const v = Number.isFinite(f) ? f : 0;
  return `${Math.round(Math.min(1, Math.max(0, v)) * 100)}%`;
}

/** G load with one decimal, sign preserved. */
export function formatG(g) {
  const v = Number.isFinite(g) ? g : 1;
  return v.toFixed(1);
}

/** Accuracy 0..1 (or 0..100) -> "64%". */
export function formatAccuracy(a) {
  if (!Number.isFinite(a)) return '—';
  return formatPercent(a > 1 ? a / 100 : a);
}

/** Ammo counter: Infinity -> "∞", else integer. */
export function formatAmmo(n) {
  if (n === Infinity) return '∞';
  if (!Number.isFinite(n)) return '—';
  return String(Math.max(0, Math.round(n)));
}

/** Rank letter fallback from a 0..1 performance factor. */
export function rankFor(score01) {
  if (!Number.isFinite(score01)) return '—';
  if (score01 >= 0.95) return 'S';
  if (score01 >= 0.8) return 'A';
  if (score01 >= 0.6) return 'B';
  if (score01 >= 0.4) return 'C';
  return 'D';
}

/**
 * Altitude for the tape readout: feet rounded to 10, as "18 450".
 */
export function formatAltitude(m) {
  return groupThousands(Math.round(toFeet(m) / 10) * 10);
}

export function formatSpeed(ms) {
  return String(Math.max(0, Math.round(toKnots(ms))));
}
