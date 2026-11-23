import * as THREE from 'three/webgpu';
import { positionLocal } from 'three/tsl';
import {
  SITE, DEFAULT_DATE, julianDateLocal, calendarDate, skyState, directionFromHorizontal, equatorialToWorld,
  EQUATORIAL_TO_GALACTIC, sunEvents,
} from './astro.js';
import { lookFor, darkness, twilightGain } from './look.js';
import { sampleTransmittance, skyAmbient } from '../atmosphere/model.js';
import { NightSky, MOON_RADIUS } from '../atmosphere/night/NightSky.js';

/**
 * Time of day for the Environment: a clock (date + local civil time) drives
 * the sun, the moon and the star sphere through a small ephemeris (astro.js),
 * picks the key light, adds the night's own light, and publishes an exposure
 * and grade hint (look.js).
 *
 * Installed by Environment's constructor; the public surface lives on `env`:
 *
 *   env.setTimeOfDay(hours | 'HH:MM' | presetName, { date, transition, weather })
 *   env.timeScale            game minutes per real second (0 = clock stopped)
 *   env.timePresets          names: dawn, morning, noon, afternoon, golden, dusk, night, moonlit-night
 *   env.timeOfDay            this object (`.hours`, `.date`, `.state`, `.config`, `.sunEvents()`)
 *   env.solarDirection       unit vector to the true sun (below the horizon at night)
 *   env.moonDirection        unit vector to the moon
 *   env.moonPhase            { fraction 0..1, waxing, age 0..1 }
 *   env.keyLight             'sun' | 'moon': which body `env.sun` / `env.sunDirection` currently is
 *   env.night                0 by day .. 1 at full night
 *   env.exposureHint         see look.js
 *
 * One key light. `env.sun` (the shadow-casting DirectionalLight) and
 * `env.sunDirection` are the key light: the sun by day and through twilight,
 * the moon once the sun is KEY_HANDOVER degrees down, by which time the sun's
 * direct light has been zero for a while, so the swap happens in the dark.
 * Terrain shadows, cloud lighting and shadows, and VFX lighting all follow
 * `env.sunDirection` and so work under the moon without knowing about it.
 * The atmosphere itself is always lit by the true sun (`env.solarDirection`),
 * which is what paints twilight: Earth's shadow, the belt of Venus, the glow
 * over the sunset point.
 *
 * `env.setSun(elevation, azimuth)` and the legacy weather presets still work:
 * they put the sun in "manual" mode (the clock keeps driving moon and stars).
 */

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
const clamp01 = (x) => Math.min(1, Math.max(0, x));
const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };

/** Sun elevation (deg) below which the moon takes over as the key light. */
export const KEY_HANDOVER = -3.4;

/**
 * Named times. Hours are local civil time (IST, UTC+5:30) on the given date;
 * on 1999-06-21 over Kargil: sunrise 05:13, solar noon 12:27, sunset 19:41.
 * `weather` are overrides on the 'default' weather preset (Environment.PRESETS).
 */
export const TIME_PRESETS = {
  dawn: { hours: 5.25, weather: { coverage: 0.34, haze: 1.6, cirrus: 0.5 } },
  morning: { hours: 8.0, weather: { coverage: 0.36, haze: 1.3, cirrus: 0.4 } },
  noon: { hours: 12.45, weather: { coverage: 0.45, haze: 0.9, cirrus: 0.25 } },
  afternoon: { hours: 15.75, weather: { coverage: 0.46, haze: 1.1, cirrus: 0.3 } },
  golden: { hours: 18.75, weather: { coverage: 0.4, haze: 2.0, cirrus: 0.45 } },
  dusk: { hours: 19.9, weather: { coverage: 0.36, haze: 1.8, cirrus: 0.5 } },
  // new moon on 13 June 1999: no moon all night, the galactic centre due south at 01:00
  night: { hours: 1.0, date: { year: 1999, month: 6, day: 14 }, weather: { coverage: 0.3, haze: 1.0, cirrus: 0.25 } },
  // full moon on 28 June 1999, 25 degrees up in the south-east at 23:00
  'moonlit-night': { hours: 23.0, date: { year: 1999, month: 6, day: 28 }, weather: { coverage: 0.36, haze: 1.2, cirrus: 0.35 } },
};

/** Night photometry, renderer units (the sun is 4.6 at the top of the atmosphere). Live-tunable. */
export const NIGHT_DEFAULTS = {
  /** Full-moon irradiance above the atmosphere: about 1/4 of the sun (compressed; really 1/400000; see look.js). */
  moonIrradiance: 1.2,
  /** Perceptual blue shift of moonlight (it is physically slightly warm). */
  moonTint: [0.4, 0.66, 1.0],
  /** Airglow + starlight radiance at the zenith; the horizon is (1 + airglowHorizon) x brighter. */
  airglow: [0.0056, 0.0084, 0.0138],
  airglowHorizon: 4.5,
  /** Irradiance the airglow puts on the ground, relative to its plain integral (readability floor). */
  airglowAmbient: 1.5,
  /** Disc: lunar albedo 0.12 under sunlight, x this gain at night (reads as a bright disc with bloom). */
  moonDiscNightGain: 6,
  earthshine: 0.02,
  starGain: 2.2,
  galaxyGain: 0.06,
  /** Lowest elevation (deg) the key light is allowed to shine from (alpenglow / moonrise). */
  minKeyElevation: 0.6,
};

const parseHours = (v) => {
  if (typeof v === 'number') return v;
  const m = /^(\d{1,2})(?::(\d{1,2}))?$/.exec(String(v).trim());
  return m ? Number(m[1]) + Number(m[2] ?? 0) / 60 : NaN;
};

export class TimeOfDay {
  constructor(env, { tier = 'high', low = false, site = SITE, sky = true } = {}) {
    this.env = env;
    this.site = { ...site };
    this.config = { ...NIGHT_DEFAULTS };
    this.presets = TIME_PRESETS;
    /** Game minutes per real second. */
    this.timeScale = 0;
    /** True while env.setSun() / a legacy preset owns the sun. */
    this.manual = true;
    this.jd = julianDateLocal(DEFAULT_DATE, 10, this.site.tz);
    this._transition = null;
    this._applied = { solar: new THREE.Vector3(), moon: new THREE.Vector3(), t: 0, key: '', envSolar: new THREE.Vector3(), envMoon: new THREE.Vector3(), envT: -1e9, envKey: '' };
    this._clock = 0;
    this._moonTOA = [0, 0, 0];
    /** The atmosphere's daylight sun irradiance (renderer units), before twilight compression. */
    this.sunIrradiance = env.atmosphere.u.sunIrradiance.value.x;
    this.twilightGain = 1;
    this.state = {
      hours: 10, date: { ...DEFAULT_DATE },
      sun: { elevation: 45, azimuth: 110 },
      moon: { elevation: -10, azimuth: 0, phase: 0, waxing: true, age: 0 },
      key: 'sun', night: 0, moonlight: 0, phase: 'day',
    };

    env.solarDirection = new THREE.Vector3(0.5, 0.7, 0.5).normalize();
    env.moonDirection = new THREE.Vector3(0, -1, 0);
    env.moonPhase = { fraction: 0, waxing: true, age: 0 };
    env.keyLight = 'sun';
    env.night = 0;
    env.exposureHint = lookFor(45, 0);

    this.sky = new NightSky({ tier, low, stars: sky });
    /** False with `?nonight` (profiling): the night sky is not added to the dome. */
    this.skyInstalled = sky;
    this._installOn(env);
  }

  /* -------------------------------------------------------------- install */

  _installOn(env) {
    const self = this;
    env.setTimeOfDay = (hours, opts) => self.set(hours, opts);
    Object.defineProperty(env, 'timeScale', {
      configurable: true, enumerable: true,
      get: () => self.timeScale,
      set: (v) => { self.timeScale = Number(v) || 0; if (self.timeScale !== 0) self.manual = false; },
    });
    Object.defineProperty(env, 'timePresets', { configurable: true, get: () => Object.keys(TIME_PRESETS) });

    if (!this.skyInstalled) return;
    // Night radiance on the sky dome and (diffuse part only) in the reflection environment.
    const skyMat = env.sky.material;
    skyMat.colorNode = skyMat.colorNode.add(this.sky.radiance(positionLocal));
    skyMat.needsUpdate = true;
    const envMesh = env._envScene?.children?.[0];
    if (envMesh?.material?.colorNode) {
      envMesh.material.colorNode = envMesh.material.colorNode.add(this.sky.radiance(positionLocal, { full: false }).mul(env._envTint));
      envMesh.material.needsUpdate = true;
    }
    env.group.add(this.sky.group);
  }

  /* ------------------------------------------------------------------ API */

  get hours() { return this.state.hours; }
  get date() { return this.state.date; }

  /** Sunrise / solar noon / sunset (local hours) for the current date. */
  sunEvents(date = this.state.date) { return sunEvents(date, this.site.lat, this.site.lon, this.site.tz); }

  /**
   * Set the clock.
   *   hours: local civil hours (number), 'HH:MM', or a name from TIME_PRESETS
   *   date: { year, month, day } (default: keep the current date; presets may carry one)
   *   transition: seconds to sweep there (0 = cut). The clock runs the short
   *     way round, so the sun and stars visibly move.
   *   weather: for presets, false to leave clouds / haze alone
   */
  set(hours, { date, transition = 0, weather = true } = {}) {
    let preset = null;
    if (typeof hours === 'string' && TIME_PRESETS[hours]) {
      preset = TIME_PRESETS[hours];
      date = date ?? preset.date;
      hours = preset.hours;
    }
    const h = parseHours(hours);
    if (!Number.isFinite(h)) throw new Error(`setTimeOfDay: bad time "${hours}"`);
    const d = date ? { year: date.year, month: date.month, day: date.day } : this._localDate();
    const target = julianDateLocal(d, ((h % 24) + 24) % 24, this.site.tz);
    // weather only (sun: null keeps Environment.setPreset from touching the sun)
    if (preset && weather && preset.weather) this.env.setPreset('default', { ...preset.weather, sun: null });
    const wasManual = this.manual;
    this.manual = false;
    if (transition > 0 && !wasManual) {
      // sweep at most 12 hours: jump whole days first, then run the clock
      let dh = ((target - this.jd) * 24) % 24;
      if (dh > 12) dh -= 24; else if (dh < -12) dh += 24;
      this._transition = { from: target - dh / 24, to: target, t: 0, duration: transition };
      this.jd = this._transition.from;
    } else {
      this._transition = null;
      this.jd = target;
      this.env.clouds?.resetHistory?.();
      this._applied.t = this._applied.envT = -1e9; // refresh lights now
    }
    this._compute();
    return this.state;
  }

  /** Environment.setSun() calls this: the sun is now where the caller put it. */
  manualSun() {
    this.manual = true;
    this._transition = null;
    this._applied.t = this._applied.envT = -1e9;
  }

  _localDate() {
    const c = calendarDate(this.jd + this.site.tz / 24);
    return { year: c.year, month: c.month, day: c.day };
  }

  /* --------------------------------------------------------------- update */

  /** Called by Environment.update() before anything reads the sun. */
  update(dt, camera) {
    this._clock += dt;
    const tr = this._transition;
    if (tr) {
      tr.t = Math.min(1, tr.t + dt / tr.duration);
      const k = tr.t * tr.t * (3 - 2 * tr.t);
      this.jd = tr.from + (tr.to - tr.from) * k;
      if (tr.t >= 1) this._transition = null;
    } else if (this.timeScale !== 0 && !this.manual) {
      this.jd += dt * this.timeScale / 1440;
    }
    this._compute();
    this._syncSky(camera);

    // Lights, ambient and the reflection environment are rebuilt on demand:
    // ask for that when the bodies have moved enough to matter.
    const a = this._applied;
    const env = this.env;
    const moved = a.solar.dot(env.solarDirection) < 0.9999975 // 0.13 degrees
      || (this.state.night > 0 && a.moon.dot(env.moonDirection) < 0.99997) // 0.45 degrees
      || a.key !== this.state.key;
    if (moved && this._clock - a.t > 0.2) {
      a.solar.copy(env.solarDirection);
      a.moon.copy(env.moonDirection);
      a.key = this.state.key;
      a.t = this._clock;
      // Lights and ambient are cheap (0.3 ms); the reflection environment is
      // a PMREM render (~10 ms on the CPU side), so it follows more coarsely.
      const big = a.envSolar.dot(env.solarDirection) < 0.99985 // 1 degree
        || (this.state.night > 0 && a.envMoon.dot(env.moonDirection) < 0.9994) // 2 degrees
        || a.envKey !== a.key || this._clock - a.envT > 8;
      if (big && this._clock - a.envT > 1) {
        a.envSolar.copy(env.solarDirection); a.envMoon.copy(env.moonDirection); a.envKey = a.key; a.envT = this._clock;
        env.invalidate(true);
      } else env.invalidate(false);
    }
    this.sky.update();
  }

  _compute() {
    const env = this.env;
    const st = this.state;
    const s = skyState(this.jd, this.site.lat, this.site.lon);
    const local = calendarDate(this.jd + this.site.tz / 24);
    st.hours = local.hours;
    st.date.year = local.year; st.date.month = local.month; st.date.day = local.day;
    this._sky = s;

    const v = _a;
    if (this.manual) {
      const d = env.solarDirection;
      st.sun.elevation = Math.asin(Math.max(-1, Math.min(1, d.y))) * R2D;
      st.sun.azimuth = (Math.atan2(d.x, -d.z) * R2D + 360) % 360;
    } else {
      st.sun.elevation = s.sun.elevation;
      st.sun.azimuth = s.sun.azimuth;
      directionFromHorizontal(s.sun.elevation, s.sun.azimuth, v);
      env.solarDirection.set(v[0], v[1], v[2]);
    }
    st.moon.elevation = s.moon.elevation;
    st.moon.azimuth = s.moon.azimuth;
    st.moon.phase = s.moon.phase;
    st.moon.waxing = s.moon.waxing;
    st.moon.age = s.moon.age;
    directionFromHorizontal(s.moon.elevation, s.moon.azimuth, v);
    env.moonDirection.set(v[0], v[1], v[2]);
    env.moonPhase.fraction = s.moon.phase;
    env.moonPhase.waxing = s.moon.waxing;
    env.moonPhase.age = s.moon.age;

    // Key light. Its direction never grazes below minKeyElevation: the world
    // is flat, so a sun just under the horizon (which still lights the peaks
    // on a round planet) shines along the ground instead, and the terrain's
    // own shadow sweep leaves only the summits lit: alpenglow.
    const sunEl = st.sun.elevation;
    const key = sunEl > KEY_HANDOVER ? 'sun' : 'moon';
    const minEl = this.config.minKeyElevation;
    const src = key === 'sun' ? env.solarDirection : env.moonDirection;
    const el = Math.max(Math.asin(Math.max(-1, Math.min(1, src.y))) * R2D, key === 'sun' ? minEl : 2);
    const h = Math.hypot(src.x, src.z) || 1;
    const ce = Math.cos(el * D2R);
    env.sunDirection.set(src.x / h * ce, Math.sin(el * D2R), src.z / h * ce);
    st.key = env.keyLight = key;

    // How much the moon counts: phase (compressed), ramped in after the handover.
    const phaseGain = Math.pow(clamp01(s.moon.phase), 1.4);
    const ramp = smooth(0, 1, (KEY_HANDOVER - sunEl) / 4.5);
    const up = smooth(-1.5, 6, s.moon.elevation);
    this._moonGain = phaseGain * ramp;
    st.moonlight = phaseGain * up * smooth(0, -6, sunEl);
    st.night = env.night = darkness(sunEl);
    st.phase = sunEl > 0.5 ? 'day' : sunEl > -9 ? 'twilight' : 'night';
    this.twilightGain = twilightGain(sunEl);
    env.atmosphere.u.sunIrradiance.value.setScalar(this.sunIrradiance * this.twilightGain);
    env.exposureHint = lookFor(sunEl, st.moonlight);
  }

  _syncSky(camera) {
    const env = this.env;
    const u = this.sky.u;
    const c = this.config;
    const st = this.state;
    u.moonDir.value.copy(env.moonDirection);
    u.solarDir.value.copy(env.solarDirection);
    const m = equatorialToWorld(this.jd, this.site.lat, this.site.lon, _m9);
    u.eqToWorld.value.set(m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8]);
    // world -> galactic = (equatorial -> galactic) x transpose(equatorial -> world)
    const g = EQUATORIAL_TO_GALACTIC;
    for (let r = 0; r < 3; r++) {
      for (let k = 0; k < 3; k++) {
        _g9[r * 3 + k] = g[r * 3] * m[k * 3] + g[r * 3 + 1] * m[k * 3 + 1] + g[r * 3 + 2] * m[k * 3 + 2];
      }
    }
    u.worldToGalactic.value.set(_g9[0], _g9[1], _g9[2], _g9[3], _g9[4], _g9[5], _g9[6], _g9[7], _g9[8]);
    // moon-fixed axes: celestial north projected onto the sky at the moon
    _pole.set(m[2], m[5], m[8]);
    _right.crossVectors(_pole, env.moonDirection).normalize();
    _up.crossVectors(env.moonDirection, _right).normalize();
    u.moonRight.value.copy(_right);
    u.moonUp.value.copy(_up);

    const n = st.night;
    // stars come out through nautical twilight; a bright moon washes the faint ones out
    const starsOut = smooth(-3.5, -12, st.sun.elevation);
    const wash = 1 - 0.45 * st.moonlight;
    u.starGain.value = c.starGain * starsOut * wash;
    u.galaxyGain.value = c.galaxyGain * smooth(-8, -15, st.sun.elevation) * (1 - 0.75 * st.moonlight);
    u.airglow.value.set(c.airglow[0], c.airglow[1], c.airglow[2]);
    u.airglowHorizon.value = c.airglowHorizon;
    u.earthshine.value = c.earthshine * (1 - st.moon.phase);

    // disc radiance: sunlit regolith through the air toward the moon
    const atm = env.atmosphere;
    const alt = Math.max(camera?.position?.y ?? 4000, 0) / 1000;
    sampleTransmittance(atm.params, atm.tLut, atm.params.Rg + alt, env.moonDirection.y, _t);
    const disc = this.sunIrradiance * 0.12 / Math.PI * (1 + (c.moonDiscNightGain - 1) * n);
    u.moonDisc.value.set(_t[0] * disc, _t[1] * disc, _t[2] * disc);
  }

  /* ----------------------------------------------------- light contribution */

  /**
   * Called from Environment._updateLights for an altitude (metres): `e` is the
   * key light's irradiance (RGB array, the sun's on entry), `amb` the sky
   * ambient { irradiance, zenith, horizon }. Mutates both: the moon replaces
   * the sun as key at night, and the night sky's light is added to the ambient.
   * `primary` marks the camera-altitude call, which also feeds the sky uniforms.
   */
  shade(altitude, e, amb, primary = true) {
    const env = this.env;
    const c = this.config;
    const atm = env.atmosphere;
    const a = atm.params;
    const alt = Math.max(altitude, 0) / 1000;
    const moon = env.moonDirection;
    const E = c.moonIrradiance * this._moonGain;
    const toa = this._moonTOA;
    toa[0] = E * c.moonTint[0]; toa[1] = E * c.moonTint[1]; toa[2] = E * c.moonTint[2];

    // direct moonlight at this altitude
    sampleTransmittance(a, atm.tLut, a.Rg + alt, moon.y, _t);
    const direct = [toa[0] * _t[0], toa[1] * _t[1], toa[2] * _t[2]];
    if (env.keyLight === 'moon') { e[0] = direct[0]; e[1] = direct[1]; e[2] = direct[2]; }

    // sky lit by the moon: the same scattering integral as the day sky
    let ms = null;
    if (E > 1e-5 && moon.y > -0.12) {
      ms = skyAmbient(a, atm.tLut, atm.msLut, Math.max(alt, 0.01), [moon.x, moon.y, moon.z]);
      for (const k of ['irradiance', 'zenith', 'horizon']) for (let i = 0; i < 3; i++) amb[k][i] += ms[k][i] * toa[i];
    }
    // airglow and starlight: always there, only visible once everything else is gone
    const g = c.airglow;
    const hz = 1 + c.airglowHorizon;
    for (let i = 0; i < 3; i++) {
      amb.irradiance[i] += g[i] * Math.PI * (1 + 0.2 * c.airglowHorizon) * c.airglowAmbient;
      amb.zenith[i] += g[i] * 1.1 * c.airglowAmbient;
      amb.horizon[i] += g[i] * (1 + 0.35 * c.airglowHorizon) * c.airglowAmbient;
    }

    if (primary) {
      const u = this.sky.u;
      u.moonHalo.value.set(direct[0], direct[1], direct[2]);
      if (ms) {
        u.moonSkyZenith.value.set(ms.zenith[0] * toa[0], ms.zenith[1] * toa[1], ms.zenith[2] * toa[2]);
        u.moonSkyHorizon.value.set(ms.horizon[0] * toa[0], ms.horizon[1] * toa[1], ms.horizon[2] * toa[2]);
      } else {
        u.moonSkyZenith.value.set(0, 0, 0);
        u.moonSkyHorizon.value.set(0, 0, 0);
      }
      /** Night radiance toward the horizon, for the night aerial-perspective stage. */
      this.horizonRadiance = [
        g[0] * hz + u.moonSkyHorizon.value.x,
        g[1] * hz + u.moonSkyHorizon.value.y,
        g[2] * hz + u.moonSkyHorizon.value.z,
      ];
    }
  }

  dispose() { this.sky.dispose(); }
}

const _a = [0, 0, 0];
const _t = [0, 0, 0];
const _m9 = new Array(9);
const _g9 = new Array(9);
const _pole = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();

export { MOON_RADIUS };
