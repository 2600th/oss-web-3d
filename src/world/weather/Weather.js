import * as THREE from 'three/webgpu';

/**
 * Weather state (`game.env.weather`): what is falling, how hard the wind
 * blows, how humid the air is, and lightning. It owns no rendering: the
 * clouds read their uniforms from it (rain shafts, the flash inside the
 * volume), VFX draws near-camera rain/snow, vapour and wind drift, and the
 * camera/post owner reads `rain`, `snow` and `wetness` for lens water.
 *
 * Gameplay picks per-mission weather either by preset
 * (`env.setPreset('storm')`, which fills this from the preset's fields) or
 * directly:
 *
 *   env.weather.set({ rain: 0..1, snow: 0..1, lightning: 0..1 (strike rate),
 *                     wind: [east, south] m/s or Vector3, humidity: 0..1 })
 *
 * Live, read-only fields (updated every frame):
 *   rain        0..1  liquid rain at the camera (below the freezing level, under cloud)
 *   snow        0..1  snow / ice crystals at the camera (above ~5 km, in or under cloud)
 *   precipitation 0..1  rain + snow
 *   wetness     0..1  how wet the lens/canopy should be (rain, or flying inside cloud)
 *   humidity    0..1  vapour readiness of the air around the camera (preset base, 1 in cloud)
 *   wind        Vector3 m/s, world (shared with the clouds and every smoke trail)
 *   visibilityKm      rough meteorological visibility for the preset's haze
 *   lightning   { intensity 0..1, position: Vector3, distance } of the flash in progress
 * Events: `onLightning(fn)` -> fn({ position, distance }) once per strike
 * (also emitted on the game bus as `weather:lightning` by src/world/system.js).
 */

/** Freezing level over Ladakh in summer: rain below, snow above (metres ASL). */
const FREEZE_LOW = 4700;
const FREEZE_HIGH = 5500;

const smooth = (a, b, x) => THREE.MathUtils.smoothstep(x, a, b);

export class Weather {
  constructor(env) {
    this.env = env;
    this.rain = 0;
    this.snow = 0;
    this.precipitation = 0;
    this.wetness = 0;
    this.humidity = 0.3;
    this.visibilityKm = 120;
    this.wind = new THREE.Vector3(9, 0, 4);
    this.lightning = { intensity: 0, position: new THREE.Vector3(), distance: Infinity };
    /** Scene fill-light kick of the current flash (Environment adds it to its hemisphere light). */
    this.flashFill = 0;

    // requested (preset / mission) values
    this.settings = { rain: 0, snow: 0, lightning: 0, humidity: 0.3 };
    this._strike = null;
    this._nextStrike = 4;
    this._listeners = [];
  }

  /** Set any of { rain, snow, lightning, wind, humidity }. Unspecified fields keep their value. */
  set(o = {}) {
    const s = this.settings;
    for (const k of ['rain', 'snow', 'lightning', 'humidity']) if (typeof o[k] === 'number') s[k] = THREE.MathUtils.clamp(o[k], 0, 1);
    if (o.wind) {
      if (o.wind.isVector3) this.wind.copy(o.wind);
      else if (Array.isArray(o.wind)) this.wind.set(o.wind[0] ?? 0, 0, o.wind[1] ?? 0);
    }
    const c = this.env.clouds;
    if (c) {
      c.wind.copy(this.wind);
      c.u.rain.value = Math.max(s.rain, s.snow * 0.6);
    }
    if (!(s.lightning > 0)) this._strike = null;
    return this;
  }

  onLightning(fn) {
    this._listeners.push(fn);
    return () => { this._listeners = this._listeners.filter((f) => f !== fn); };
  }

  /** Force a strike now (dev, scripted moments). `position` defaults to a random spot in cloud. */
  strike(camera, position = null) {
    const c = this.env.clouds;
    const base = c ? c.u.base.value : 5600, top = c ? c.u.top.value : 9400;
    if (!position) {
      const a = Math.random() * Math.PI * 2, r = 2500 + Math.random() * 20000;
      position = new THREE.Vector3(camera.position.x + Math.cos(a) * r, base + (top - base) * (0.2 + Math.random() * 0.45), camera.position.z + Math.sin(a) * r);
    }
    // two to four return strokes a few hundredths of a second apart
    const strokes = [];
    let t = 0;
    const n = 2 + Math.floor(Math.random() * 3);
    for (let i = 0; i < n; i++) { strokes.push({ t, amp: i === 0 ? 1 : 0.35 + Math.random() * 0.6 }); t += 0.05 + Math.random() * 0.11; }
    this._strike = { position: position.clone(), strokes, age: 0, end: t + 0.35, power: 0.6 + Math.random() * 0.4 };
    const distance = position.distanceTo(camera.position);
    for (const fn of this._listeners) { try { fn({ position: position.clone(), distance }); } catch (e) { console.error('[weather] lightning listener', e); } }
    return this._strike;
  }

  update(dt, camera) {
    const env = this.env, c = env.clouds, s = this.settings;
    const base = c ? c.u.base.value : 5600, top = c ? c.u.top.value : 9400;
    const y = camera.position.y;
    const inCloud = THREE.MathUtils.clamp(env.inCloud ?? 0, 0, 1);

    // Precipitation falls where there is cloud above (or around) the camera.
    const under = 1 - smooth(base + (top - base) * 0.4, top, y);
    const cover = c ? Math.max(1 - (env.sunVisibility ?? 1), inCloud) : 0;
    const falling = under * smooth(0.15, 0.6, cover);
    const frozen = smooth(FREEZE_LOW, FREEZE_HIGH, y);
    const precip = Math.max(s.rain, s.snow);
    const rainT = Math.max(s.rain, s.snow * 0) * falling * (1 - frozen);
    // snow: frozen precipitation, plus the ice crystals any cloud holds at altitude
    const snowT = Math.max(precip * falling * frozen, s.snow * falling, inCloud * 0.55 * smooth(5300, 6300, y));
    const k = 1 - Math.exp(-dt * 1.2);
    this.rain += (rainT - this.rain) * k;
    this.snow += (snowT - this.snow) * k;
    this.precipitation = Math.min(1, this.rain + this.snow);
    this.wetness = Math.min(1, Math.max(this.rain, inCloud * 0.8, this.snow * 0.3));
    this.humidity = Math.max(s.humidity, inCloud, this.precipitation * 0.8);
    this.visibilityKm = 120 / Math.max(env.atmosphere?.params?.haze ?? 1, 0.2);

    // Lightning: a point light inside the cloud layer; each stroke a sharp
    // rise and a slower decay.
    let flash = 0;
    if (c && dt > 0) {
      if (s.lightning > 0) {
        this._nextStrike -= dt * s.lightning;
        if (!this._strike && this._nextStrike <= 0) {
          this._nextStrike = 2.5 + Math.random() * 7;
          this.strike(camera);
        }
      }
      const st = this._strike;
      if (st) {
        st.age += dt;
        for (const q of st.strokes) {
          const a = st.age - q.t;
          if (a >= 0) flash = Math.max(flash, q.amp * Math.exp(-a / 0.07) * Math.min(1, a / 0.012 + 0.3));
        }
        flash *= st.power;
        this.lightning.position.copy(st.position);
        this.lightning.distance = st.position.distanceTo(camera.position);
        if (st.age > st.end) this._strike = null;
      }
    }
    this.lightning.intensity = flash;
    const d = this.lightning.distance;
    this.flashFill = flash * THREE.MathUtils.clamp(6000 / Math.max(d, 1500), 0.1, 1);
    if (c) {
      c.u.flash.value = flash * 55;
      c.u.flashAmb.value = flash * 0.5 * THREE.MathUtils.clamp(9000 / Math.max(d, 2000), 0.15, 1);
      c.u.flashPos.value.copy(this.lightning.position);
      // the cloud history would smear a 50 ms flash over a dozen frames
      c.u.blendBoost.value = flash > 0.02 ? 0.55 : 0;
    }
  }
}
