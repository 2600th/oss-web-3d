/**
 * The effect vocabulary: particle types for the two pools and trail styles.
 * Effects are authored against these names; tuning the look of the whole game
 * happens here.
 */
export function defineTypes(lit, glow) {
  const L = {
    // generic lingering smoke: drifts with the wind, slowly rises and billows
    smoke: lit.type({ drag: 1.4, gravity: 0.5, turbulence: 2.5, turbScale: 0.02, wind: 1, sizePow: 0.5, fadeIn: 0.05, fadeOut: 0.4, heatDecay: 3, soft: 0.4, spin: 0.25 }),
    // explosion fireball: violent start, cools from white-hot to soot
    fireball: lit.type({ drag: 3.2, gravity: 2.2, turbulence: 7, turbScale: 0.03, wind: 0.6, sizePow: 0.3, fadeIn: 0.02, fadeOut: 0.55, heatDecay: 1.9, soft: 0.3, spin: 0.6 }),
    // thrown dirt / snow: ballistic, falls back
    dust: lit.type({ drag: 0.8, gravity: -7, turbulence: 2, turbScale: 0.03, wind: 0.5, sizePow: 0.55, fadeIn: 0.03, fadeOut: 0.45, heatDecay: 4, soft: 0.5, spin: 0.4, thin: 0.25 }),
    // low rolling ground dust
    groundDust: lit.type({ drag: 1.6, gravity: 0.3, turbulence: 2, turbScale: 0.03, wind: 0.8, sizePow: 0.5, fadeIn: 0.05, fadeOut: 0.35, heatDecay: 4, soft: 0.6, spin: 0.2, thin: 0.4 }),
    // oily column from a fire
    column: lit.type({ drag: 0.55, gravity: 3.4, turbulence: 2.2, turbScale: 0.012, wind: 1, sizePow: 0.75, fadeIn: 0.08, fadeOut: 0.45, heatDecay: 1.4, soft: 0.5, spin: 0.2 }),
    // licking flames
    flame: lit.type({ drag: 1.8, gravity: 7, turbulence: 7, turbScale: 0.12, wind: 0.5, sizePow: 0.6, fadeIn: 0.12, fadeOut: 0.35, heatDecay: 1.3, soft: 0.5, spin: 1.2 }),
    // vapour: stays with the air, gone in a blink
    wisp: lit.type({ drag: 2.5, gravity: 0, turbulence: 5, turbScale: 0.1, wind: 0, sizePow: 0.6, fadeIn: 0.25, fadeOut: 0.25, heatDecay: 4, soft: 0.6, spin: 0.8, thin: 1 }),
    // smoke shed by something moving fast: decouples from the emitter quickly
    // burning fuel streaming off something fast: flame for a moment, then soot
    burn: lit.type({ drag: 4, gravity: 1.2, turbulence: 5, turbScale: 0.04, wind: 1, sizePow: 0.5, fadeIn: 0.03, fadeOut: 0.45, heatDecay: 6.5, soft: 0.4, spin: 0.6 }),
    shed: lit.type({ drag: 4.5, gravity: 0.6, turbulence: 4, turbScale: 0.04, wind: 1, sizePow: 0.45, fadeIn: 0.04, fadeOut: 0.4, heatDecay: 2.6, soft: 0.4, spin: 0.5, thin: 0.35 }),
  };
  const G = {
    spark: glow.type({ drag: 0.7, gravity: -9.8, shape: 1, stretch: 0.04, minPixels: 1.3, flicker: 0.35, sizePow: 1, fadeIn: 0, fadeOut: 0.5 }),
    ember: glow.type({ drag: 1.4, gravity: -4, turbulence: 9, turbScale: 0.2, shape: 0, minPixels: 1.2, flicker: 0.5, sizePow: 1, fadeIn: 0, fadeOut: 0.4 }),
    flash: glow.type({ drag: 0, gravity: 0, shape: 3, sizePow: 0.35, fadeIn: 0.02, fadeOut: 0.15 }),
    glow: glow.type({ drag: 0, gravity: 0, shape: 0, minPixels: 3, flicker: 0.2, sizePow: 1, fadeIn: 0, fadeOut: 0.5 }),
    beacon: glow.type({ drag: 0, gravity: 0, shape: 0, minPixels: 9, flicker: 0.2, sizePow: 1, fadeIn: 0, fadeOut: 0.5 }),
    halo: glow.type({ drag: 2, gravity: 0, shape: 0, sizePow: 0.4, fadeIn: 0.04, fadeOut: 0.2 }),
    ring: glow.type({ drag: 0, gravity: 0, shape: 2, sizePow: 0.5, fadeIn: 0.02, fadeOut: 0.1 }),
    tracer: glow.type({ drag: 0.03, gravity: -4, shape: 1, stretch: 0.03, minPixels: 2.2, sizePow: 1, fadeIn: 0, fadeOut: 0.92 }),
    flame: glow.type({ drag: 2.5, gravity: 5, turbulence: 5, turbScale: 0.2, shape: 4, sizePow: 0.7, fadeIn: 0.1, fadeOut: 0.3, flicker: 0.3 }),
    jet: glow.type({ drag: 0.2, gravity: 0, shape: 4, sizePow: 0.7, fadeIn: 0.05, fadeOut: 0.2, flicker: 0.25 }),
    motor: glow.type({ drag: 0, gravity: 0, shape: 1, stretch: 0.013, minPixels: 1.5, sizePow: 1, fadeIn: 0, fadeOut: 0.5, flicker: 0.3 }),
    flare: glow.type({ drag: 0, gravity: 0, shape: 3, minPixels: 16, flicker: 0.35, sizePow: 1, fadeIn: 0, fadeOut: 0.5 }),
    streak: glow.type({ drag: 0, gravity: 0, shape: 1, stretch: 0.05, sizePow: 1, fadeIn: 0.2, fadeOut: 0.4 }),
  };
  return { L, G };
}

/** Trail styles. `spacing` is multiplied by the tier's trail spacing factor at creation. */
export const TRAILS = {
  // air-to-air missile: thin, brilliant white, hangs for half a minute
  aam: { radius: 0.7, growth: 2.0, life: 32, color: [0.97, 0.97, 0.98], opacity: 4.2, wobble: 9, rise: 0.25, glow: 2.2, wind: 1, spacing: 12 },
  // surface-to-air: fat booster plume
  sam: { radius: 1.5, growth: 3.2, life: 40, color: [0.9, 0.89, 0.87], opacity: 5.2, wobble: 14, rise: 0.5, glow: 3.0, wind: 1, spacing: 16 },
  agm: { radius: 0.7, growth: 1.7, life: 30, color: [0.95, 0.95, 0.95], opacity: 4.0, wobble: 9, rise: 0.25, glow: 2.2, wind: 1, spacing: 12 },
  rocket: { radius: 0.35, growth: 0.9, life: 12, color: [0.8, 0.8, 0.8], opacity: 1.8, wobble: 4, rise: 0.2, glow: 1.6, wind: 1, spacing: 9 },
  flare: { radius: 0.35, growth: 1.0, life: 9, color: [0.95, 0.95, 0.97], opacity: 3.2, wobble: 4, rise: 0.4, glow: 2.6, wind: 1, spacing: 5 },
  debris: { radius: 0.3, growth: 0.8, life: 5, color: [0.2, 0.19, 0.18], opacity: 4, wobble: 2, rise: 0.6, glow: 0.7, wind: 1, spacing: 4 },
  wreck: { radius: 1.6, growth: 3.2, life: 26, color: [0.07, 0.065, 0.06], opacity: 11, wobble: 10, rise: 1.2, glow: 0.8, wind: 1, spacing: 9 },
  damageLight: { radius: 0.5, growth: 1.3, life: 9, color: [0.55, 0.55, 0.56], opacity: 1.2, wobble: 5, rise: 0.4, glow: 0, wind: 1, spacing: 9 },
  damageHeavy: { radius: 0.8, growth: 2.2, life: 18, color: [0.08, 0.075, 0.07], opacity: 9, wobble: 8, rise: 0.8, glow: 0.5, wind: 1, spacing: 9 },
  vortex: { radius: 0.1, growth: 0.22, life: 1.7, color: [1, 1, 1], opacity: 0.55, wobble: 0.8, rise: 0, glow: 0, wind: 1, spacing: 3.5 },
  contrail: { radius: 0.9, growth: 2.4, life: 36, color: [1, 1, 1], opacity: 1.5, wobble: 12, rise: 0, glow: 0, wind: 1, spacing: 18 },
};
