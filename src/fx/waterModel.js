/**
 * Screen-water drivers (pure, no three.js; unit-tested in post-math.test.mjs).
 *
 * Turns weather + flight state into the handful of numbers the GPU water
 * simulation (src/fx/post/screenWater.js) runs on. Kept separate so the
 * physical reasoning is testable and the shader stays dumb.
 *
 *   rateSmall / rateBig  new drops per second over the whole glass (fine mist / rain)
 *   flow                 0..1, how hard the airflow drags water across the glass
 *   stick                bead height below which water clings (surface tension)
 *   evap                 thickness lost per second (drying)
 *   fogTarget, fogRate   condensation film the water settles toward
 *   wipe                 film cleared per second by the airflow
 *   frost                0..1 ice rim (cold cloud at altitude)
 */
export const WATER_DEFAULTS = Object.freeze({
  mistRate: 55, // small drops per second over the glass, fully in cloud
  rainSmall: 40,
  rainBig: 8, // big drops per second in heavy rain
  flowOnset: 35, // m/s: below this, drops only bead and slide with gravity
  flowFull: 190, // m/s: airflow streams everything back
  evap: 0.05,
  frostAlt: 5800, // m: freezing cloud starts to rime the glass
  frostFull: 7800,
});

const clamp01 = (x) => Math.min(1, Math.max(0, x));
const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };

/**
 * @param {{rain?:number, inCloud?:number, airspeed?:number, altitude?:number, surface?:'lens'|'canopy'|'none'}} s
 */
export function waterDrivers(s = {}, o = WATER_DEFAULTS) {
  const rain = clamp01(s.rain ?? 0);
  const cloud = clamp01(s.inCloud ?? 0);
  const speed = Math.max(0, s.airspeed ?? 0);
  const alt = s.altitude ?? 0;
  const surface = s.surface ?? 'lens';
  if (surface === 'none') {
    return { rateSmall: 0, rateBig: 0, flow: 0, stick: 0.5, evap: 0.6, fogTarget: 0, fogRate: 0, wipe: 2, frost: 0 };
  }
  // More water is swept up the faster you fly through it (up to a point).
  const sweep = 0.45 + 0.55 * smooth(40, 220, speed);
  const flow = smooth(o.flowOnset, o.flowFull, speed);
  const canopy = surface === 'canopy';
  // Cloud is fine mist: many tiny drops and a fog film. Rain: fewer, bigger drops.
  const rateSmall = (cloud * o.mistRate + rain * o.rainSmall) * sweep;
  // the canopy is a big surface but the pilot looks through only part of it
  const rateBig = rain * o.rainBig * sweep * (canopy ? 0.8 : 1);
  // Surface tension: slow flight lets beads grow before they run.
  const stick = 0.62 - 0.4 * flow;
  // Dry air dries the glass; wet air (cloud, rain) barely does.
  const humid = Math.max(cloud, rain);
  const evap = o.evap * (1 - 0.8 * humid) * (1 + flow);
  const fogTarget = cloud * (canopy ? 0.55 : 0.4) + rain * 0.12;
  const fogRate = 0.9;
  const wipe = 0.15 + 1.6 * flow * (1 - cloud * 0.6);
  const frost = cloud * smooth(o.frostAlt, o.frostFull, alt);
  return { rateSmall, rateBig, flow, stick, evap, fogTarget, fogRate, wipe, frost };
}

/**
 * Rain intensity 0..1 from whatever the weather owner exposes, else a
 * heuristic: the storm preset's precipitation under the cloud base.
 */
export function rainFrom(env, altitude, override) {
  if (override && Number.isFinite(override.rain)) return clamp01(override.rain);
  const w = env?.weather;
  if (w && Number.isFinite(w.rain)) return clamp01(w.rain);
  if (Number.isFinite(env?.rain)) return clamp01(env.rain);
  const storm = env?.presets?.[env?.preset]?.storm ?? 0;
  if (!(storm > 0)) return 0;
  const base = env?.clouds?.u?.base?.value ?? 5600;
  // falls out of the base; evaporates (virga) a little way below it
  const below = 1 - smooth(base - 300, base + 200, altitude);
  return clamp01(smooth(0.4, 1, storm) * below);
}
