/**
 * HUD colour system.
 *
 * Two independent axes:
 *  - `hudColor` is the symbology ink (the colour of every line and numeral that
 *    is *yours*: ladder, tapes, readouts). Four inks, all light and slightly
 *    desaturated so they hold against a blue zenith and do not vanish on snow.
 *  - `palette` is the identification set (hostile / priority / ace / friendly /
 *    warning). `standard` is red-amber-blue; `deutan` (red-green safe, also
 *    covers protan) moves hostile to orange and priority to white; `tritan`
 *    (blue-yellow safe) moves friendly to teal-white and caution to pink-red.
 *    Shape always carries the same meaning as colour, so no state is colour-only.
 *
 * Every stroke and glyph is drawn twice: a dark `halo` underlay, then the ink.
 * That outline, not the ink colour, is what makes the HUD legible on sunlit
 * snow at 5,500 m.
 */

export const INKS = {
  glacier: { ink: '#d6f6ff', dim: 'rgba(214,246,255,0.74)', faint: 'rgba(214,246,255,0.4)', rgb: '214,246,255', dimA: 0.74, faintA: 0.4 },
  phosphor: { ink: '#b6ffcf', dim: 'rgba(182,255,207,0.74)', faint: 'rgba(182,255,207,0.4)', rgb: '182,255,207', dimA: 0.74, faintA: 0.4 },
  amber: { ink: '#ffd9a0', dim: 'rgba(255,217,160,0.74)', faint: 'rgba(255,217,160,0.4)', rgb: '255,217,160', dimA: 0.74, faintA: 0.4 },
  white: { ink: '#ffffff', dim: 'rgba(255,255,255,0.76)', faint: 'rgba(255,255,255,0.42)', rgb: '255,255,255', dimA: 0.76, faintA: 0.42 },
};

export const PALETTES = {
  standard: {
    hostile: '#ff5b47',
    priority: '#ffc53d',
    // The flight lead is a hostile: same colour, told apart by its notched
    // double frame, not by a fifth hue.
    ace: '#ff5b47',
    friendly: '#69c8ff',
    ground: '#ff7a4a',
    warning: '#ff4036',
    caution: '#ffb21f',
    good: '#7dffb0',
    burner: '#ff9b3d',
  },
  // Red-green safe (deuteranopia / protanopia): blue-orange axis.
  deutan: {
    hostile: '#ff9a1f',
    priority: '#ffffff',
    ace: '#ff9a1f',
    friendly: '#4aa3ff',
    ground: '#ffb84d',
    warning: '#ffd400',
    caution: '#ffe680',
    good: '#4aa3ff',
    burner: '#ffb84d',
  },
  // Blue-yellow safe (tritanopia): red-cyan axis.
  tritan: {
    hostile: '#ff4a5a',
    priority: '#ffffff',
    ace: '#ff4a5a',
    friendly: '#5ff2ff',
    ground: '#ff6b7a',
    warning: '#ff2d55',
    caution: '#ff9aa8',
    good: '#5ff2ff',
    burner: '#ff8fb0',
  },
};

// Halos were 0.72 / 0.42 / 0.6: raised so dim labels and hairlines hold over
// sunlit snow (the ink alone washes out) without going heavy over dark rock.
export const HALO = 'rgba(2,8,12,0.8)';
export const HALO_SOFT = 'rgba(2,8,12,0.5)';
/** Glyph halo: lighter than the stroke halo so small text keeps its counters. */
export const HALO_TEXT = 'rgba(2,8,12,0.68)';

export function resolveTheme(settings = {}) {
  const ink = INKS[settings.hudColor] ?? INKS.glacier;
  const pal = PALETTES[settings.palette] ?? PALETTES.standard;
  // The amber ink would collide with the amber priority/objective channel;
  // under it, priority moves to white so "objective" still reads apart.
  const priority = settings.hudColor === 'amber' && pal === PALETTES.standard ? '#ffffff' : pal.priority;
  return {
    ...ink, ...pal, priority, halo: HALO, haloSoft: HALO_SOFT, haloText: HALO_TEXT,
    // daylight legibility (see adaptTheme); all off = the night look
    k: 0, haloPad: 2.6, haloWide: null, haloWidePad: 0, textHalo: [1.25, 2.5, 0.13], plate: null,
  };
}

/**
 * Halo strength for daylight, keyed by `k` in 0..1 (0 = night: exactly the
 * look above; 1 = full daylight). Measured over sunlit snow, white cumulus
 * and the burner glow (docs/v2/evidence/hud-legibility): the 0.68 glyph halo
 * left 10-11 px numerals at ~1.5:1 against their surround and the 0.74 `dim`
 * ink read as grey. In daylight the tight halo goes near-opaque and a touch
 * wider, a soft wide halo (low alpha) darkens the surround without a hard
 * black edge, and `dim` / `faint` ink gains alpha so secondary numerals stop
 * reading as grey. Shape and hairline widths do not change.
 */
export const DAY = Object.freeze({
  halo: 0.92, // stroke halo alpha (night 0.8)
  haloPad: 3.2, // stroke halo extra width, px (night 2.6)
  haloText: 0.9, // glyph halo alpha (night 0.68)
  textHalo: [1.5, 2.9, 0.155], // glyph halo half-width: [min, max, x font size] (night [1.25, 2.5, 0.13])
  wide: 0.3, // soft outer halo alpha (night: none)
  widePad: 3.6, // soft outer halo extra width, px
  dim: 0.9, // `dim` ink alpha (night 0.74)
  faint: 0.62, // `faint` ink alpha (night 0.4)
  plate: 0.5, // dark plate under bars (THR, AIRFRAME, progress)
});

const lerp = (a, b, t) => a + (b - a) * t;
const rgba = (rgb, a) => `rgba(${rgb},${+a.toFixed(3)})`;

/** Theme for daylight factor `k` (0..1); `base` comes from resolveTheme. */
export function adaptTheme(base, k) {
  k = Math.min(1, Math.max(0, Number.isFinite(k) ? k : 0));
  if (k <= 0) return { ...base, k: 0 };
  const rgb = base.rgb ?? '214,246,255';
  const dimA = base.dimA ?? 0.74;
  const faintA = base.faintA ?? 0.4;
  return {
    ...base,
    k,
    dim: rgba(rgb, lerp(dimA, DAY.dim, k)),
    faint: rgba(rgb, lerp(faintA, DAY.faint, k)),
    halo: rgba('2,8,12', lerp(0.8, DAY.halo, k)),
    haloText: rgba('2,8,12', lerp(0.68, DAY.haloText, k)),
    haloPad: lerp(2.6, DAY.haloPad, k),
    haloWide: rgba('2,8,12', DAY.wide * k),
    haloWidePad: DAY.widePad,
    textHalo: [lerp(1.25, DAY.textHalo[0], k), lerp(2.5, DAY.textHalo[1], k), lerp(0.13, DAY.textHalo[2], k)],
    plate: rgba('2,8,12', DAY.plate * k),
  };
}

/**
 * Daylight factor from the post chain's metered luminance (no GPU readback of
 * its own: PostFX already reads its 1x1 meter back every few frames).
 * `adaptedLog2 + ev` is the log2 mean of the *exposed* frame: about -2 at noon
 * (-1.2 inside sunlit cloud), about -5 or below at night. Unknown (no meter,
 * e.g. auto-exposure off) counts as day: most sorties fly in daylight and the
 * day halo is the safe side.
 */
export function daylight(stats) {
  const a = stats?.adaptedLog2;
  if (!Number.isFinite(a)) return 1;
  const b = a + (Number.isFinite(stats.ev) ? stats.ev : 0);
  const t = Math.min(1, Math.max(0, (b - -4.6) / (-3.0 - -4.6)));
  return t * t * (3 - 2 * t);
}

/** Colour for a target marker given its role. */
export function targetColor(theme, t) {
  if (t.team === 'friendly' || t.team === 'blue' || t.team === 'player') return theme.friendly;
  // recon posts and other neutral subjects: yours to photograph, not shoot
  if (t.team === 'neutral') return theme.ink;
  if (t.isAce) return theme.ace;
  if (t.isTarget) return theme.priority;
  if (isGround(t)) return theme.ground;
  return theme.hostile;
}

/** Ground or air: gameplay's `class` when present, else inferred from `kind`. */
export function isGround(t) {
  if (t.class === 'ground') return true;
  if (t.class === 'air') return false;
  return isGroundKind(t.kind);
}

const AIR_KINDS = new Set(['air', 'aircraft', 'fighter', 'ace', 'bomber', 'helo', 'helicopter', 'jet', 'transport']);

export function isGroundKind(kind) {
  if (!kind) return false;
  return !AIR_KINDS.has(String(kind).toLowerCase());
}
