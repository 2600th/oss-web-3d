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
  glacier: { ink: '#d6f6ff', dim: 'rgba(214,246,255,0.74)', faint: 'rgba(214,246,255,0.4)' },
  phosphor: { ink: '#b6ffcf', dim: 'rgba(182,255,207,0.74)', faint: 'rgba(182,255,207,0.4)' },
  amber: { ink: '#ffd9a0', dim: 'rgba(255,217,160,0.74)', faint: 'rgba(255,217,160,0.4)' },
  white: { ink: '#ffffff', dim: 'rgba(255,255,255,0.76)', faint: 'rgba(255,255,255,0.42)' },
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
  return { ...ink, ...pal, priority, halo: HALO, haloSoft: HALO_SOFT, haloText: HALO_TEXT };
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
