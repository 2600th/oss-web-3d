import * as THREE from 'three/webgpu';
import { BASE_EXPOSURE } from '../world/system.js';
import { NightStage } from '../world/atmosphere/night/nightStage.js';
import { LightSprites } from '../world/timeofday/lights/LightSprites.js';
import { attachNavLights, attachHeadlights, villageLights, addVillageLights } from '../world/timeofday/lights/fixtures.js';

/**
 * Time-of-day system (`game.systems.timeofday`). Auto-registered by main.js;
 * order 12 = right after the atmosphere system (10), whose exposure
 * calibration this builds on.
 *
 * The clock, ephemeris, night sky and night lighting live in the Environment
 * (src/world/timeofday/TimeOfDay.js, installed by Environment itself, so
 * `env.setTimeOfDay` exists whether or not this system runs). This system is
 * the glue to everything outside the Environment:
 *
 *   - PostFX: applies `env.exposureHint` (exposure range + grade) and adds the
 *     night scene stages (night aerial perspective 21, cloud flashes 31);
 *   - events: `explosion` lights nearby cloud; emits `timeofday:phase`;
 *   - lights on things: navigation lights on the player and on hostile
 *     aircraft, village lights, vehicle headlights, cockpit night lighting;
 *   - dev URL flags: `?tod=HH:MM`, `?tod=<preset>`, `?tod=cycle[:minutesPerSecond]`,
 *     `?date=YYYY-MM-DD`, `?preset=` for the time-only preset names, and
 *     `?nonight` (profiling: no night sky layer, stages or light sprites).
 *
 * Public surface:
 *   lights                      LightSprites (add / remove / removeGroup)
 *   attachNavLights(object3d, opts?)      -> handles
 *   attachHeadlights(object3d, opts?)     -> handles   (also via event `vehicle:spawn {entity}`)
 *   detachLights(object3d)
 *   cloudFlash(position, { color, intensity, range, duration })   lightning, big explosions
 */

export const order = 12;

const FLASH_BY_SIZE = {
  small: { intensity: 1.2, range: 220, duration: 0.3 },
  medium: { intensity: 2.2, range: 400, duration: 0.45 },
  large: { intensity: 3.5, range: 650, duration: 0.6 },
  huge: { intensity: 5, range: 950, duration: 0.85 },
};

const lerp = (a, b, t) => a + (b - a) * t;

export function createSystem(game) {
  const env = game.env;
  const post = game.post;
  const tod = env?.timeOfDay;
  if (!env || !tod) return null;
  const params = new URLSearchParams(globalThis.location?.search ?? '');
  const tierName = game.r.tier.name;
  const low = tierName === 'low' || game.r.backend !== 'webgpu';

  // ------------------------------------------------------------ scene stages
  const enabled = tod.skyInstalled !== false; // `?nonight`: profiling baseline without the night layer
  const stage = new NightStage({ slots: low ? 2 : 4 });
  if (enabled) {
    post.addSceneStage(stage.aerial(env.atmosphere), 21);
    if (env.clouds) post.addSceneStage(stage.clouds(env.atmosphere, env.clouds), 31);
  }

  // ---------------------------------------------------------- lights on things
  const sprites = new LightSprites({ capacity: low ? 256 : 640 });
  if (enabled) game.scene.add(sprites.mesh);
  const lit = new Map(); // object3d -> { entity?, handles }
  const attach = (object3d, entity, fn, opts) => {
    if (!object3d || lit.has(object3d)) return lit.get(object3d)?.handles ?? null;
    const handles = fn(sprites, object3d, opts);
    lit.set(object3d, { entity, handles });
    return handles;
  };
  const detach = (object3d) => {
    if (!lit.has(object3d)) return;
    sprites.removeGroup(object3d);
    lit.delete(object3d);
  };

  // ----------------------------------------------------------------- post glue
  const day = {}; // PostFX's daylight grade, captured once
  const captureGrade = () => {
    const u = post.uniforms ?? {};
    if (u.lookSat) day.lookSat = u.lookSat.value;
    if (u.shadowTint) day.shadowTint = u.shadowTint.value.clone();
    if (u.highlightTint) day.highlightTint = u.highlightTint.value.clone();
    if (u.vignette) day.vignette = u.vignette.value;
  };
  let lastHint = null;
  const applyHint = () => {
    const h = env.exposureHint;
    if (!h) return;
    const o = post.options?.exposure;
    if (o) {
      // Same reference the atmosphere system sets, plus the time-of-day bias.
      o.baseEV = Math.log2(BASE_EXPOSURE) + 0.5 * Math.log2(env.exposureScale || 1) + h.ev;
      o.minEV = h.minEV;
      o.maxEV = h.maxEV;
      o.speedDown = h.speedDown;
    }
    // Lens flare reference: the *daylight* sun (twilight compression scales
    // the atmosphere's sun irradiance, which must not move this).
    const a = env.atmosphere.u;
    if (post.uniforms?.sunRefLum) post.uniforms.sunRefLum.value = tod.sunIrradiance * a.sunDiscGain.value / 3;
    if (h === lastHint) return;
    lastHint = h;
    const u = post.uniforms ?? {};
    const g = h.grade;
    if (u.lookSat && day.lookSat !== undefined) u.lookSat.value = day.lookSat * g.saturation;
    if (u.shadowTint && day.shadowTint) u.shadowTint.value.set(day.shadowTint.x * g.shadowTint[0], day.shadowTint.y * g.shadowTint[1], day.shadowTint.z * g.shadowTint[2]);
    if (u.highlightTint && day.highlightTint) u.highlightTint.value.set(day.highlightTint.x * g.highlightTint[0], day.highlightTint.y * g.highlightTint[1], day.highlightTint.z * g.highlightTint[2]);
    if (u.vignette && day.vignette !== undefined) u.vignette.value = Math.min(0.6, day.vignette * g.vignette);
  };

  // The camera system feeds PostFX the key light as "the sun" for the lens
  // flare. The moon should not throw a starburst and ghosts: scale the flare
  // by how much of a sun the key light is. (Post owner: read `env.keyLight`
  // directly and this wrapper can go.)
  if (post.setFrameState) {
    const setFrameState = post.setFrameState.bind(post);
    post.setFrameState = (s) => {
      if (s && typeof s.sunIntensity === 'number' && env.keyLight === 'moon') s.sunIntensity = 0;
      setFrameState(s);
    };
  }

  // ------------------------------------------------------------ cockpit night
  const cockpit = { mats: null, dim: -1 };
  const _panel = new THREE.Vector3();
  const updateCockpit = () => {
    const rig = game.cameraRig;
    const n = env.night;
    // The displays are authored to be readable in daylight; at night exposure
    // they would be blinding, so they dim like a real night-mode panel.
    const model = rig?.cockpitModel;
    if (model && !cockpit.mats) {
      cockpit.mats = [];
      model.traverse((o) => {
        for (const m of (Array.isArray(o.material) ? o.material : [o.material])) {
          if (m?.emissive && (m.emissiveMap || m.emissive.getHex() !== 0)) cockpit.mats.push({ m, base: m.emissiveIntensity ?? 1 });
        }
      });
    }
    const dim = lerp(1, 0.32, n);
    if (cockpit.mats && Math.abs(dim - cockpit.dim) > 0.005) {
      cockpit.dim = dim;
      for (const c of cockpit.mats) c.m.emissiveIntensity = c.base * dim;
    }
    // Amber flood lighting on the panel: one pooled VFX light (no extra light
    // in any material's pipeline), only in first person at night.
    const lights = game.systems.vfx?.lights;
    const view = rig?.view;
    if (lights?.request && n > 0.05 && (view === 'cockpit' || view === 'hud') && game.player?.sockets?.cockpit) {
      const g = game.player.group;
      g.updateWorldMatrix(true, false);
      _panel.copy(game.player.sockets.cockpit.position);
      _panel.z -= 0.55; _panel.y -= 0.28;
      _panel.applyMatrix4(g.matrixWorld);
      lights.request(_panel.x, _panel.y, _panel.z, 1, 0.42, 0.14, 0.12 * n, 1.6);
    }
  };

  // ---------------------------------------------------------------- dev flags
  const applyUrl = () => {
    const date = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(params.get('date') ?? '');
    const d = date ? { year: +date[1], month: +date[2], day: +date[3] } : undefined;
    const preset = params.get('preset');
    if (preset && tod.presets[preset] && env.preset !== preset && !['morning', 'noon', 'golden'].includes(preset)) env.setPreset(preset);
    const t = params.get('tod');
    if (!t) { if (d) env.setTimeOfDay(tod.hours, { date: d }); return; }
    if (t.startsWith('cycle')) {
      const start = params.get('from');
      env.setTimeOfDay(start ?? 16, { date: d });
      env.timeScale = Number(t.split(':')[1]) || 20; // a day in 72 s
    } else {
      try { env.setTimeOfDay(t, { date: d }); } catch (e) { console.warn('[timeofday]', e.message); }
    }
  };

  let phase = '';
  let scan = 0;
  const system = {
    name: 'timeofday',
    env,
    clock: tod,
    lights: sprites,
    stage,
    attachNavLights: (object3d, opts) => attach(object3d, null, attachNavLights, opts),
    attachHeadlights: (object3d, opts) => attach(object3d, null, attachHeadlights, opts),
    detachLights: detach,
    cloudFlash: (position, opts) => stage.flash(position, opts),

    init() {
      captureGrade();
      applyUrl();
      if (game.player?.group) attach(game.player.group, null, attachNavLights, { phase: 0 });
      try {
        addVillageLights(sprites, villageLights(undefined, { density: low ? 0.5 : 1 }));
      } catch (e) { console.warn('[timeofday] village lights unavailable', e); }

      const ev = game.events;
      ev.on?.('explosion', (p) => {
        if (!p?.position) return;
        const f = FLASH_BY_SIZE[p.size] ?? FLASH_BY_SIZE.medium;
        stage.flash(p.position, f);
      });
      ev.on?.('aircraft:spawn', ({ entity }) => {
        if (entity?.object3d) attach(entity.object3d, entity, attachNavLights, { intensity: 0.8 });
      });
      ev.on?.('aircraft:despawn', ({ entity }) => detach(entity?.object3d));
      ev.on?.('vehicle:spawn', ({ entity }) => {
        if (entity?.object3d) attach(entity.object3d, entity, attachHeadlights);
      });
    },

    update(dt) {
      applyHint();
      updateCockpit();
      if (tod.state.phase !== phase) {
        phase = tod.state.phase;
        game.events.emit?.('timeofday:phase', { phase, hours: tod.hours, night: env.night, keyLight: env.keyLight });
      }
      // Vehicles: gameplay spawns trucks without an event; pick them up here.
      scan += dt;
      if (scan > 1) {
        scan = 0;
        for (const u of game.systems.ai?.ground ?? []) {
          const e = u.entity;
          if (e?.kind === 'truck' && e.alive && e.object3d && !lit.has(e.object3d)) attach(e.object3d, e, attachHeadlights);
        }
        for (const [obj, rec] of lit) {
          if (rec.entity && (rec.entity.alive === false || !obj.parent)) detach(obj);
        }
      }
    },

    lateUpdate(dt) {
      // after the camera and the aircraft have their final pose for the frame
      const h = tod.horizonRadiance;
      if (h) stage.u.fog.value.set(h[0], h[1], h[2]);
      stage.update(dt, game.camera.position);
      for (const obj of lit.keys()) obj.updateWorldMatrix(true, false);
      sprites.update(game.camera, env.night);
    },

    dispose() {
      sprites.mesh.removeFromParent();
      sprites.dispose();
    },
  };
  return system;
}
