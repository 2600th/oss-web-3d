import * as THREE from 'three/webgpu';
import { Fn, float, positionWorld, uniform } from 'three/tsl';
import { Atmosphere } from './atmosphere/Atmosphere.js';
import { Clouds } from './clouds/Clouds.js';
import { Weather } from './weather/Weather.js';
import { TimeOfDay } from './timeofday/TimeOfDay.js'; // [timeofday]
import { installSunShadows } from './shadows/SunShadows.js'; // [shadows]
import { SHADOW_LAYER } from './terrain/Terrain.js'; // [shadows]

/**
 * Sky, sun, ambient, aerial perspective and volumetric clouds.
 *
 * Public surface (see docs/v2/ARCHITECTURE.md):
 *   sunDirection         THREE.Vector3, unit, world, toward the sun
 *   sun                  DirectionalLight; colour/intensity from atmospheric transmittance
 *   ambient              HemisphereLight fill (most ambient comes from scene.environment)
 *   cloudShadow          TSL Fn(worldPos: vec3) -> float, 1 = sunlit
 *   applyCloudShadow(m)  hook cloudShadow into a node material's received shadow
 *   inCloud              0..1, how deep the camera is in cloud
 *   sunVisibility        0..1, cloud shadow at the focus (player) position
 *   cloudVisibility      TSL Fn(screenUv, viewDistanceMetres) -> float, how much of something
 *                        at that distance shows through the cloud in front of it
 *   weather              rain / snow / wind / humidity / lightning state (src/world/weather/Weather.js);
 *                        `rain`, `wind`, `lightning` here are shortcuts into it
 *   setPreset(name)      'default' | 'morning' | 'noon' | 'golden' | 'overcast' | 'storm'
 *   setSun(elevDeg, azDeg)
 *   update(dt, camera, focus)
 *   atmosphere, clouds   the subsystems (uniforms under .u for live tuning)
 *
 * [timeofday] Time of day, moon, stars and night lighting are installed by
 * ./timeofday/TimeOfDay.js (setTimeOfDay, timeScale, timePresets, solarDirection,
 * moonDirection, moonPhase, keyLight, night, exposureHint). `sunDirection` / `sun`
 * are the *key light*: the sun by day, the moon at night.
 */

export const PRESETS = {
  // Late-morning summer: scattered-to-broken cumulus building over the ridges.
  // Weather fields (all optional): rain, snow, lightning (strike rate), wind
  // [east, south] m/s, humidity (how readily wings and tips pull vapour).
  default: { sun: [44, 112], coverage: 0.42, type: 0.5, ridge: 0.5, haze: 1.0, cirrus: 0.3, storm: 0, sigma: 0.03, envTint: 1, exposure: 1, wind: [9, 4], humidity: 0.3 },
  morning: { sun: [17, 80], coverage: 0.36, type: 0.4, ridge: 0.4, haze: 1.5, cirrus: 0.4, storm: 0, sigma: 0.028, envTint: 1, exposure: 1.15, wind: [4, 2], humidity: 0.5 },
  noon: { sun: [74, 176], coverage: 0.45, type: 0.6, ridge: 0.55, haze: 0.9, cirrus: 0.25, storm: 0, sigma: 0.03, envTint: 1, exposure: 0.95, wind: [10, 5], humidity: 0.25 },
  // Sun 3.5 degrees up: long warm light, rim-lit cloud, peach haze on the horizon.
  // (cirrus was 0.42: at this sun angle the sheet is lit edge-on and nearly
  // white, and that much of it flattened the whole upper sky)
  golden: { sun: [3.5, 287], coverage: 0.4, type: 0.5, ridge: 0.45, haze: 2.2, cirrus: 0.2, storm: 0, sigma: 0.028, envTint: 1, exposure: 1.7, wind: [6, 2], humidity: 0.4 },
  overcast: { sun: [40, 150], coverage: 0.95, type: 0.3, ridge: 0.15, haze: 2.6, cirrus: 0, storm: 0.25, sigma: 0.033, envTint: 0.7, exposure: 1.3, rain: 0.35, wind: [12, 6], humidity: 0.65 },
  storm: { sun: [32, 205], coverage: 0.86, type: 0.95, ridge: 0.3, haze: 3.2, cirrus: 0, storm: 1, sigma: 0.042, envTint: 0.5, exposure: 1.4, rain: 1, lightning: 1, wind: [21, 11], humidity: 0.85 },
};

const GROUND_ALBEDO = [0.26, 0.23, 0.2];

/**
 * [shadows] `receivedShadowNode` is a function, not a node, so three leaves it
 * out of a material's program cache key: two node materials that differ only
 * in that hook share one compiled shader, and whichever compiled first wins
 * (a unit material could silently lose its cloud / terrain shadow, and a hook
 * installed after the first compile never took effect). Fold the hook's kind
 * into the key.
 */
const _baseKeys = new WeakMap();
function keyShadowHook(material, tag) {
  if (typeof material.customProgramCacheKey !== 'function') return;
  if (!_baseKeys.has(material)) {
    const base = material.customProgramCacheKey;
    _baseKeys.set(material, base);
    material.customProgramCacheKey = function customProgramCacheKey() {
      return `${base.call(this)}|shadowHook:${this.userData.shadowHook ?? ''}`;
    };
  }
  material.userData.shadowHook = tag;
}

export class Environment {
  constructor(r) {
    this.r = r;
    const renderer = r.renderer;
    const params = new URLSearchParams(globalThis.location?.search ?? '');
    const tier = r.tier;
    const low = tier.name === 'low' || r.backend !== 'webgpu';

    this.sunDirection = new THREE.Vector3();
    this.inCloud = 0;
    this.sunVisibility = 1;
    this.preset = 'default';
    /** Multiplier the preset suggests for PostFX exposure (see system.js). */
    this.exposureScale = 1;

    this.atmosphere = new Atmosphere(renderer, r.camera);
    this.clouds = params.has('noclouds') ? null : new Clouds(renderer, r.camera, this.atmosphere, {
      steps: tier.cloudSteps, scale: tier.cloudScale, low,
    });

    /**
     * TSL Fn(worldPosition: vec3) -> float, 1 = fully sunlit. Reads the clouds'
     * top-down sun shadow map. Use applyCloudShadow(material) to hook it up.
     */
    this.cloudShadow = this.clouds ? this.clouds.shadowAt : Fn(([p]) => float(1).add(p.x.mul(0)));
    /** TSL Fn(screenUv, viewDistanceMetres) -> 0..1 through the cloud in front (see Clouds.visibilityAt). */
    this.cloudVisibility = this.clouds ? this.clouds.visibilityAt : Fn(([st, d]) => float(1).add(st.x.mul(0)).add(d.mul(0)));
    /** Rain, snow, wind, humidity, lightning (see src/world/weather/Weather.js). */
    this.weather = new Weather(this);
    // Light shafts: the aerial-perspective froxels march the same shadow map.
    if (this.clouds && !low) this.atmosphere.setShadowFn(this.cloudShadow);

    this.sky = this.atmosphere.makeSkyMesh();
    this.sky.scale.setScalar(200000);

    this.sun = new THREE.DirectionalLight(0xffffff, 4);
    // [shadows] Camera-fitted cascades with a sun-sized penumbra replace the one
    // 120 m box that followed the player (see src/world/shadows/SunShadows.js).
    // The terrain's shadow is its heightfield sweep, not this map.
    this.sunShadows = installSunShadows(this.sun, r.camera, {
      tier, backend: r.backend, layers: 1 | (1 << SHADOW_LAYER),
    });
    /**
     * [shadows] TSL Fn(worldPos) -> 0..1, the terrain's heightfield shadow at a
     * point near the ground (set by the terrain; null until then). Folded into
     * `applyCloudShadow` so units and props in a ridge's shadow are not sunlit.
     */
    this.terrainShadow = null;

    this.ambient = new THREE.HemisphereLight(0x9cc4ff, 0x6b5a48, 0.2);
    /** Strength of the hemisphere fill relative to the physical sky irradiance. */
    this.ambientFill = 0.25;

    this.group = new THREE.Group();
    this.group.name = 'environment';
    this.group.add(this.sky, this.sun, this.sun.target, this.ambient);

    // Reflection / ambient environment: PMREM of the sky (no sun disc; the
    // DirectionalLight carries the sun), lower hemisphere = lit ground colour.
    this._envGround = uniform(new THREE.Vector3(0.1, 0.1, 0.1));
    this._envTint = uniform(new THREE.Vector3(1, 1, 1));
    this._envScene = this.atmosphere.makeEnvironmentScene(this._envGround, this._envTint);
    this._pmrem = new THREE.PMREMGenerator(renderer);
    this._envTarget = null;
    this._envAltitude = -1e9;
    this._envAge = 1e9;
    this._lightAltitude = -1e9;
    this._dirty = true;

    // [timeofday] clock, ephemeris, night sky; adds its radiance to the sky dome
    // and the reflection environment built above.
    this.timeOfDay = new TimeOfDay(this, { tier: tier.name, low, sky: !params.has('nonight') });

    this.setPreset(params.get('preset') && PRESETS[params.get('preset')] ? params.get('preset') : 'default');
  }

  get presets() { return Object.keys(PRESETS); }

  // Shortcuts into the weather state.
  get rain() { return this.weather.rain; }
  get snow() { return this.weather.snow; }
  get wind() { return this.weather.wind; }
  get lightning() { return this.weather.lightning; }
  onLightning(fn) { return this.weather.onLightning(fn); }

  setSun(elevationDeg, azimuthDeg) {
    const el = THREE.MathUtils.degToRad(elevationDeg);
    const az = THREE.MathUtils.degToRad(azimuthDeg);
    // azimuth from north (-Z) clockwise toward east (+X)
    this.sunDirection.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)).normalize();
    // [timeofday] an explicit sun position takes the sun off the clock
    this.solarDirection?.copy(this.sunDirection);
    this.timeOfDay?.manualSun();
    this._dirty = true;
  }

  /**
   * [timeofday] Rebuild lights and ambient on the next update; with
   * `environment` (default) also the PMREM reflection map, which costs ~10 ms.
   */
  invalidate(environment = true) { if (environment) this._dirty = true; else this._lightsDirty = true; }

  /**
   * Weather + time-of-day preset. Options override individual fields, e.g.
   * setPreset('default', { coverage: 0.7 }).
   */
  setPreset(name, overrides = {}) {
    // [timeofday] names that only exist as times of day (dawn, afternoon, dusk,
    // night, moonlit-night): default weather + that clock time.
    if (!PRESETS[name] && this.timeOfDay?.presets[name]) {
      this.timeOfDay.set(name);
      this.preset = name;
      return this.timeOfDay.presets[name];
    }
    const p = { ...(PRESETS[name] ?? PRESETS.default), ...overrides };
    this.preset = PRESETS[name] ? name : 'default';
    if (p.sun) this.setSun(p.sun[0], p.sun[1]); // [timeofday] sun: null = weather only
    this.atmosphere.setHaze(p.haze);
    this.exposureScale = p.exposure;
    this._envTintScalar = p.envTint;
    const c = this.clouds;
    if (c) {
      c.u.coverage.value = p.coverage;
      c.u.typeBase.value = p.type;
      c.u.ridgeBoost.value = p.ridge;
      c.u.cirrusCov.value = p.cirrus;
      c.u.storm.value = p.storm;
      c.u.sigma.value = p.sigma;
      c.weatherDirty = true;
      c.resetHistory();
    }
    this.weather.set({ rain: p.rain ?? 0, snow: p.snow ?? 0, lightning: p.lightning ?? 0, wind: p.wind ?? [9, 4], humidity: p.humidity ?? 0.3 });
    this._dirty = true;
    return p;
  }

  /** Cloud coverage 0..1 without changing anything else. */
  setCoverage(v) {
    if (!this.clouds) return;
    this.clouds.u.coverage.value = v;
    this.clouds.weatherDirty = true;
  }

  /**
   * Make a node material receive cloud shadows (terrain, buildings, aircraft).
   * Safe to call again after a material is rebuilt.
   * [shadows] Also the terrain's heightfield shadow (`terrainShadow`) for
   * anything near the ground, unless `terrain: false` or the material is the
   * terrain's own (it shades itself with the same sweep).
   */
  applyCloudShadow(material, { terrain = true } = {}) {
    if (!material) return material;
    const ts = terrain && !material.terrainLit ? this.terrainShadow : null;
    if (material.userData?.cloudShadowFn === this.cloudShadow && (material.userData.terrainShadowFn ?? null) === ts) return material;
    const shadow = this.cloudShadow;
    material.receivedShadowNode = ts
      ? Fn(([s]) => s.mul(shadow(positionWorld)).mul(ts(positionWorld)))
      : Fn(([s]) => s.mul(shadow(positionWorld)));
    material.userData.cloudShadowFn = shadow;
    material.userData.terrainShadowFn = ts;
    keyShadowHook(material, ts ? 'cloud+terrain' : 'cloud');
    material.needsUpdate = true;
    return material;
  }

  _updateLights(altitude) {
    const atm = this.atmosphere;
    const e = atm.sunIrradianceAt(altitude);
    const amb = atm.ambientAt(altitude);
    // [timeofday] at night the moon is the key light; the night sky adds to the ambient
    this.timeOfDay?.shade(altitude, e, amb, true);
    const m = Math.max(e[0], e[1], e[2], 1e-4);
    this.sun.color.setRGB(e[0] / m, e[1] / m, e[2] / m);
    this.sun.intensity = m;

    const up = Math.max(this.sunDirection.y, 0);
    const vis = this.clouds ? 0.35 + 0.65 * this.sunVisibility : 1;
    const ground = GROUND_ALBEDO.map((a, i) => a * (e[i] * up * vis + amb.irradiance[i]) / Math.PI);
    // Hemisphere fill: irradiance from above / from the ground, scaled down
    // because scene.environment already provides the image-based ambient.
    const f = this.ambientFill;
    const sm = Math.max(...amb.irradiance, 1e-4);
    this.ambient.color.setRGB(amb.irradiance[0] / sm, amb.irradiance[1] / sm, amb.irradiance[2] / sm);
    const gi = ground.map((g) => g * Math.PI);
    this.ambient.groundColor.setRGB(gi[0] / sm, gi[1] / sm, gi[2] / sm);
    this.ambient.intensity = sm * f;
    this._sunBase = m;
    this._ambientBase = sm * f;

    const t = this._envTintScalar ?? 1;
    this._envGround.value.set(ground[0], ground[1], ground[2]);
    this._envTint.value.set(t, t, t);

    if (this.clouds) {
      const u = this.clouds.u;
      const ec = atm.sunIrradianceAt(7200);
      u.sunE.value.set(ec[0], ec[1], ec[2]);
      const ac = atm.ambientAt(7200);
      this.timeOfDay?.shade(7200, ec, ac, false); // [timeofday] moonlit clouds
      // Radiance arriving from above (sky) and from below (ground + horizon haze).
      u.ambTop.value.set(ac.zenith[0] * 0.6 + ac.horizon[0] * 0.4, ac.zenith[1] * 0.6 + ac.horizon[1] * 0.4, ac.zenith[2] * 0.6 + ac.horizon[2] * 0.4);
      u.ambBot.value.set(ground[0] * 0.8 + ac.horizon[0] * 0.3, ground[1] * 0.8 + ac.horizon[1] * 0.3, ground[2] * 0.8 + ac.horizon[2] * 0.3);
      u.sunDir.value.copy(this.sunDirection);
    }
    this.sunIrradiance = e;
    this.skyAmbient = amb;
  }

  _updateEnvironmentMap(scene) {
    const old = this._envTarget;
    this._envTarget = this._pmrem.fromScene(this._envScene, 0, 0.1, 100, { size: 128, renderTarget: old ?? null });
    if (scene && scene.environment !== this._envTarget.texture) scene.environment = this._envTarget.texture;
  }

  /** Keep the shadow frustum on the focus (usually the player aircraft). */
  update(dt, camera, focus = camera.position) {
    const atm = this.atmosphere;
    this.timeOfDay?.update(dt, camera); // [timeofday] moves solarDirection / sunDirection
    this.sunShadows.update(camera, this.keyLight); // [shadows] refit cascades on FOV / aspect changes
    this.sky.position.copy(camera.position);
    this.sun.target.position.copy(focus);
    this.sun.position.copy(focus).addScaledVector(this.sunDirection, 2000);
    // [timeofday] the atmosphere is lit by the true sun even while the moon is the key light
    atm.u.sunDir.value.copy(this.solarDirection ?? this.sunDirection);

    const alt = camera.position.y;
    if (this._dirty || this._lightsDirty || Math.abs(alt - this._lightAltitude) > 150) {
      this._lightsDirty = false;
      this._lightAltitude = alt;
      this._updateLights(alt);
    }

    this.weather.update(dt, camera);
    if (this.clouds) {
      this.clouds.update(dt, camera, focus);
      this.inCloud = this.clouds.inCloud;
      this.sunVisibility = this.clouds.sunVisibility;
    }
    // Light inside cloud, and lightning as scene light. The cloud shadow map
    // only covers what is below the layer, so in the cloud the direct sun has
    // to be taken down here: it falls off to a fraction as the cloud closes
    // in and the (white, directionless) fill comes up. A flash kicks the fill.
    if (this._sunBase !== undefined) {
      const k = THREE.MathUtils.clamp(this.inCloud, 0, 1);
      this.sun.intensity = this._sunBase * (1 - 0.86 * k);
      this.ambient.intensity = this._ambientBase * (1 + 5 * k) + this.weather.flashFill * 2.2;
    }
    atm.update(camera);

    this._envAge += dt;
    if (this._dirty || (this._envAge > 2 && Math.abs(alt - this._envAltitude) > 400)) {
      this._envAltitude = alt;
      this._envAge = 0;
      this._updateEnvironmentMap(this._scene);
    }
    this._dirty = false;
  }

  addTo(scene) {
    this._scene = scene;
    scene.add(this.group);
  }

  dispose() {
    this.atmosphere.dispose();
    this.sunShadows.dispose(); // [shadows]
    this.clouds?.dispose();
    this.timeOfDay?.dispose();
    this._pmrem.dispose();
    this._envTarget?.dispose();
  }
}
