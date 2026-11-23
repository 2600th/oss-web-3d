// Time of day and weather for a sortie: data, labels, the numbers gameplay
// reads from them, and the one function that pushes them at the environment.
// Pure except `applyToEnvironment` (which only touches what it is handed).
//
// A mission states `conditions: { time: 5.67, weather: 'scattered', advance?: h/min }`.
// `resolveConditions` turns that into the live object exposed as
// `game.conditions` and announced with `conditions:change`:
//
//   time        hours, 0..24 (advances during the sortie when `advance` is set)
//   weather     key of WEATHER
//   label       "0540 · Dawn · Scattered cloud" (for the briefing)
//   light       0..1, how much daylight there is (night ~0.12)
//   visibility  0..1, scales how far optically-aimed weapons and pilots see
//   turbulence  0..1, control buffeting
//   cloud       {base, top} metres MSL of a solid layer, or null
//   irLoss      per-second chance an IR seeker loses a target inside the layer
//   night       bool (light < 0.3)

export const WEATHER = {
  clear:     { label: 'Clear',            coverage: 0.12, visibility: 1,    turbulence: 0,    wind: 3,  rain: 0,   snow: 0,   lightning: false, cloud: null, preset: null },
  scattered: { label: 'Scattered cloud',  coverage: 0.35, visibility: 1,    turbulence: 0.05, wind: 5,  rain: 0,   snow: 0,   lightning: false, cloud: null, preset: null },
  cumulus:   { label: 'Building cumulus', coverage: 0.55, visibility: 0.92, turbulence: 0.2,  wind: 8,  rain: 0,   snow: 0,   lightning: false, cloud: null, preset: null },
  overcast:  { label: 'Overcast',         coverage: 0.85, visibility: 0.75, turbulence: 0.25, wind: 9,  rain: 0.2, snow: 0,   lightning: false, cloud: { base: 6100, top: 7000 }, preset: 'overcast' },
  snow:      { label: 'Snow showers',     coverage: 0.9,  visibility: 0.6,  turbulence: 0.35, wind: 11, rain: 0,   snow: 0.7, lightning: false, cloud: { base: 5900, top: 7000 }, preset: 'overcast' },
  storm:     { label: 'Storm',            coverage: 1,    visibility: 0.55, turbulence: 1,    wind: 18, rain: 0.8, snow: 0,   lightning: true,  cloud: { base: 5700, top: 7400 }, preset: 'storm' },
};
export const WEATHER_KEYS = Object.keys(WEATHER);

/** Named times for menus (free flight picker). */
export const TIMES = [
  { id: 'dawn', label: 'Dawn', time: 5.67 },
  { id: 'morning', label: 'Morning', time: 9.5 },
  { id: 'noon', label: 'Midday', time: 12.5 },
  { id: 'golden', label: 'Golden hour', time: 17.75 },
  { id: 'dusk', label: 'Dusk', time: 19.3 },
  { id: 'night', label: 'Night', time: 23 },
];

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };

/** 0..1 daylight at an hour of the Kargil summer (sunrise ~0520, sunset ~1920). */
export function lightLevel(hours) {
  const h = ((hours % 24) + 24) % 24;
  const up = smooth(4.7, 6.4, h);
  const down = 1 - smooth(18.6, 20.2, h);
  return 0.12 + 0.88 * Math.min(up, down);
}

export function partOfDay(hours) {
  const h = ((hours % 24) + 24) % 24;
  if (h < 4.7 || h >= 20.2) return 'Night';
  if (h < 6.6) return 'Dawn';
  if (h < 11) return 'Morning';
  if (h < 15) return 'Midday';
  if (h < 17.2) return 'Afternoon';
  if (h < 18.8) return 'Golden hour';
  return 'Dusk';
}

/** "0540" */
export function clock(hours) {
  const h = ((hours % 24) + 24) % 24;
  const hh = Math.floor(h), mm = Math.floor((h - hh) * 60 + 1e-6);
  return `${String(hh).padStart(2, '0')}${String(mm).padStart(2, '0')}`;
}

export function conditionsLabel(time, weather) {
  return `${clock(time)} · ${partOfDay(time)} · ${(WEATHER[weather] ?? WEATHER.clear).label}`;
}

/** Existing Environment preset to fall back on when there is no day/night API. */
export function fallbackPreset(time, weather) {
  const w = WEATHER[weather] ?? WEATHER.clear;
  if (w.preset) return w.preset;
  const part = partOfDay(time);
  if (part === 'Dawn' || part === 'Morning') return 'morning';
  if (part === 'Midday') return 'noon';
  if (part === 'Afternoon') return 'default';
  return 'golden'; // golden hour, dusk and (lacking anything darker) night
}

/** Mission data -> live conditions object. */
export function resolveConditions(def = {}, out = {}) {
  const weather = WEATHER[def.weather] ? def.weather : 'scattered';
  const w = WEATHER[weather];
  const time = Number.isFinite(def.time) ? ((def.time % 24) + 24) % 24 : 10;
  const light = lightLevel(time);
  out.time = time;
  out.weather = weather;
  out.advance = def.advance ?? 0;
  out.label = conditionsLabel(time, weather);
  out.light = light;
  out.night = light < 0.3;
  // Darkness costs an optical gunner more than cloud does.
  out.visibility = w.visibility * (0.45 + 0.55 * light);
  out.turbulence = w.turbulence;
  out.cloud = w.cloud;
  out.irLoss = w.cloud ? 0.3 : 0;
  out.wind = w.wind; out.rain = w.rain; out.snow = w.snow; out.lightning = w.lightning; out.coverage = w.coverage;
  return out;
}

/** Is an altitude inside the solid cloud layer? */
export function inCloudLayer(conditions, y) {
  const c = conditions?.cloud;
  return !!c && y > c.base && y < c.top;
}

/**
 * Push conditions at the environment. Codes against the day/night and weather
 * APIs being added in parallel (`env.setTimeOfDay(hours)`, `env.weather`);
 * where they are missing it falls back to `env.setPreset(name)` so the sortie
 * still gets a distinct look. Never throws.
 */
export function applyToEnvironment(env, c, { timeOnly = false } = {}) {
  if (!env || !c) return 'none';
  let how = 'preset';
  try {
    if (typeof env.setTimeOfDay === 'function') { env.setTimeOfDay(c.time); how = 'timeOfDay'; }
    if (timeOnly) return how;
    // With the day/night API the clock owns the sun, but the sky still needs
    // the weather's look: cloud type, coverage, storm cells, haze. `sun: null`
    // tells setPreset to leave the sun where the clock put it.
    if (how === 'timeOfDay' && typeof env.setPreset === 'function') {
      env.setPreset(WEATHER[c.weather]?.preset ?? 'default', { coverage: c.coverage, sun: null });
    }
    const w = env.weather;
    // Weather.set takes numbers only (lightning is a strike rate 0..1).
    const state = { type: c.weather, rain: c.rain, snow: c.snow, lightning: c.lightning === true ? 1 : Number(c.lightning) || 0, wind: c.wind, coverage: c.coverage, turbulence: c.turbulence };
    if (typeof env.setWeather === 'function') env.setWeather(state);
    else if (w && typeof w.set === 'function') w.set(state);
    else if (w && typeof w === 'object') for (const k of ['rain', 'snow', 'lightning', 'wind']) if (k in w && typeof w[k] !== 'function') w[k] = state[k];
    if (how === 'preset') env.setPreset?.(fallbackPreset(c.time, c.weather), { coverage: c.coverage });
    else if (!w) env.setCoverage?.(c.coverage);
  } catch (e) {
    console.warn('[conditions] environment refused', e);
  }
  return how;
}
