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
    burn: lit.type({ drag: 4, gravity: 1.2, turbulence: 5, turbScale: 0.04, wind: 1, sizePow: 0.5, fadeIn: 0.03, fadeOut: 0.45, heatDecay: 13, soft: 0.4, spin: 0.6 }),
    // sooty burn smoke off a damaged aircraft or a falling wreck: rolls hard, swells fast
    soot: lit.type({ drag: 3.2, gravity: 0.9, turbulence: 7, turbScale: 0.045, wind: 1, sizePow: 0.42, fadeIn: 0.02, fadeOut: 0.5, heatDecay: 13, soft: 0.4, spin: 0.8 }),
    // the upper, older part of a smoke column: paler, huge, drifting downwind for a minute
    columnTop: lit.type({ drag: 0.4, gravity: 2.7, turbulence: 2.8, turbScale: 0.008, wind: 1, sizePow: 0.8, fadeIn: 0.1, fadeOut: 0.5, heatDecay: 2, soft: 0.6, spin: 0.15, thin: 0.15 }),
    // big explosions: the fireball stays hot longer and lifts into a mushroom
    fireballBig: lit.type({ drag: 2.1, gravity: 3.4, turbulence: 8, turbScale: 0.02, wind: 0.6, sizePow: 0.34, fadeIn: 0.02, fadeOut: 0.5, heatDecay: 1.0, soft: 0.3, spin: 0.5 }),
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
    // engine core seen up the tailpipe: a plain soft dot, no minimum size
    core: glow.type({ drag: 0, gravity: 0, shape: 0, flicker: 0.15, sizePow: 1, fadeIn: 0, fadeOut: 0.5 }),
    // flame torn off something moving fast: stretched along its motion
    fire: glow.type({ drag: 3, gravity: 3, turbulence: 6, turbScale: 0.2, shape: 4, stretch: 0.012, sizePow: 0.7, fadeIn: 0.08, fadeOut: 0.35, flicker: 0.3 }),
    // rain past the canopy: world-anchored drops, streaked by the camera's own speed
    rain: glow.type({ drag: 0, gravity: -9.8, shape: 1, stretch: 0.03, minPixels: 0.9, sizePow: 1, fadeIn: 0.2, fadeOut: 0.6 }),
    // snow / ice crystals: barely fall, tumble and glitter
    snow: glow.type({ drag: 0, gravity: -1.3, turbulence: 2.5, turbScale: 0.3, shape: 1, stretch: 0.045, minPixels: 1.2, flicker: 0.55, sizePow: 1, fadeIn: 0.15, fadeOut: 0.5 }),
    streak: glow.type({ drag: 0, gravity: 0, shape: 1, stretch: 0.08, minPixels: 1, sizePow: 1, fadeIn: 0.2, fadeOut: 0.4 }),
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
  // Burn trails: the ribbon is only the soft dark core that keeps the trail
  // continuous at range; the billowing body is `soot` particles on top of it.
  wreck: { radius: 1.8, growth: 3.6, life: 30, color: [0.05, 0.047, 0.045], opacity: 4.5, wobble: 18, rise: 1.2, glow: 0, wind: 1, spacing: 9 },
  damageLight: { radius: 0.5, growth: 1.3, life: 9, color: [0.55, 0.55, 0.56], opacity: 1.2, wobble: 5, rise: 0.4, glow: 0, wind: 1, spacing: 9 },
  damageHeavy: { radius: 1.0, growth: 2.6, life: 22, color: [0.055, 0.052, 0.05], opacity: 4, wobble: 15, rise: 0.8, glow: 0, wind: 1, spacing: 9 },
  // Condensation (glow: -1 = water lighting, see Shared.vapourLight).
  // Wingtip vortex cores: a thread a few centimetres thick at the tip that
  // spreads to a few tens of centimetres and is gone in about a second, and
  // translucent all the way (a fresh core lets about half the light through).
  // It was 0.11 m growing 0.3 m/sqrt(s) for 2.6 s at optical depth 1: by the
  // end a 1.5-2 m opaque rope.
  vortex: { radius: 0.045, growth: 0.13, life: 1.25, color: [1, 1, 1], opacity: 0.6, wobble: 0.5, rise: 0, glow: -1, wind: 1, spacing: 2.5 },
  // condensation rolling off the inner wing in a hard pull: soft, and gone
  // within about one wingspan behind the trailing edge (it was 0.11 s, a 40 m
  // flat band at combat speed)
  sheet: { radius: 0.3, growth: 2.2, life: 0.035, color: [1, 1, 1], opacity: 0.14, wobble: 0.3, rise: 0, glow: -1, wind: 1, spacing: 3 },
  // dry-thrust exhaust: the faint smoky thread a turbojet leaves at military power
  exhaust: { radius: 0.3, growth: 1.0, life: 2.2, color: [0.3, 0.29, 0.28], opacity: 0.07, wobble: 3, rise: 0.1, glow: 0, wind: 1, spacing: 5 },
  contrail: { radius: 0.9, growth: 2.4, life: 36, color: [1, 1, 1], opacity: 1.5, wobble: 12, rise: 0, glow: -1, wind: 1, spacing: 18 },
};
