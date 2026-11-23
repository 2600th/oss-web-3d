import * as THREE from 'three/webgpu';
import { loadModel } from '../assets/loadModel.js';
import { ScreenState } from '../fx/ScreenState.js';
import { waterDrivers, rainFrom } from '../fx/waterModel.js';
import {
  explosionTrauma, flightRumble, inDanger, clamp, smoothstep, speedOfSound, machCrossing,
} from './cameraMath.js';

export const order = 85;

const LOOK_RANGE_YAW = 2.4; // rad, free-look limit (over the shoulder)
const LOOK_RANGE_PITCH = 1.1;
const _v = new THREE.Vector3();
const _g = new THREE.Vector3();

/**
 * Camera + post integration system (order 85, camera/post extras).
 *
 *  - input: KeyC (or input.actions.camera) cycles chase / cockpit / HUD;
 *    hold KeyV (or input.actions.lookTarget, pad R3) for the target-lock cam;
 *    hold the right mouse button and drag, or use the right stick, to free look;
 *    KeyB toggles the missile-follow cam.
 *  - events -> camera shake (vfx:shake, explosions, hits, guns, near misses),
 *    kill cam (target:destroyed), death cam (player:destroyed / player:crash),
 *    missile cam (missile:launch / missile:end), sortie intro shot
 *    (flow:state briefing -> sortie), camera:request {mode:'cinematic'|'restore'}.
 *  - feel: Mach-crossing thump, afterburner light-off pulse (rig), fast+low
 *    rumble, action-camera target selection.
 *  - screen state (G-LOC greyout, redout, damage, flash) and screen water
 *    (cloud / rain -> drops, runs, fog film, frost) -> PostFX.
 *  - feeds PostFX the sun, flight path, speed, Mach, AGL, view, depth of field
 *    and camera cuts every frame.
 *  - loads the cockpit overlay (assets id `mig21_cockpit`) for the cockpit view.
 *
 * game.systems.camera exposes { rig, screen, options, setOption(key, value) }.
 */
export function createSystem(game) {
  const rig = game.cameraRig;
  const post = game.post;
  const screen = new ScreenState();
  const off = [];
  const on = (type, fn) => off.push(game.events.on(type, fn));
  const hostileMissiles = new Set();
  const params = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');
  const machState = {};
  let gunRumble = 0;
  let pointer = null;
  let shock = null; // { t } sonic ripple phase
  let lastFlow = null;
  let pendingSortie = false;
  let actionPick = 0;

  rig.attach(game);
  if (post?.options) rig.options.reducedMotion = post.options.reducedMotion;
  if (params.has('nokillcam')) rig.options.killCam = false;
  if (params.has('actioncam')) rig.options.actionCam = true;

  const isPlayer = (e) => !!e && (e === game.player || e === game.playerEntity || e.isPlayer === true ||
    e.id === 'player' || e.object3d === game.player?.group);
  const playerPos = () => game.flight.position;

  // --- events -----------------------------------------------------------------
  on('vfx:shake', ({ amount = 0.2 } = {}) => rig.addTrauma(amount));
  on('explosion', ({ position, size = 'medium' } = {}) => {
    if (!position) return;
    const d = position.distanceTo(playerPos());
    rig.addTrauma(explosionTrauma(d, size));
    screen.explosion(d, size);
  });
  on('player:hit', ({ damage = 0.1 } = {}) => {
    rig.addTrauma(0.35 + Math.min(0.5, damage * 2));
    screen.hit(damage);
  });
  on('weapon:gun', ({ firing, entity } = {}) => {
    if (!entity || isPlayer(entity)) gunRumble = firing ? 1 : 0;
  });
  on('missile:launch', ({ missile } = {}) => {
    if (!missile) return;
    if (isPlayer(missile.owner)) {
      rig.addTrauma(0.12);
      if (rig.options.missileCam && (missile.kind ?? 'aam') !== 'rocket' && !dangerNow()) rig.followMissile(missile);
    } else {
      hostileMissiles.add(missile);
    }
  });
  on('missile:end', ({ missile, reason } = {}) => {
    if (!missile) return;
    rig.missileEnded?.(missile, reason);
    if (hostileMissiles.has(missile)) {
      hostileMissiles.delete(missile);
      const d = missile.position?.distanceTo?.(playerPos()) ?? Infinity;
      if (reason !== 'hit' && d < 150) rig.addTrauma(0.25 * (1 - d / 150));
    }
  });
  on('target:destroyed', ({ target, killer, position } = {}) => {
    if (!isPlayer(killer)) return;
    if (!dangerNow()) rig.killCam(target, position);
  });
  on('player:destroyed', ({ position, velocity } = {}) => {
    rig.addTrauma(1);
    rig.deathCam(position ?? game.flight.position, velocity ?? game.flight.velocity);
  });
  on('player:crash', ({ position } = {}) => {
    rig.addTrauma(1);
    if (rig.view !== 'death') rig.deathCam(position ?? game.flight.position);
  });
  on('player:respawn', () => {
    screen.reset();
    rig.reset(game.flight);
    post?.water?.clear();
    machState.above = undefined;
  });
  // Briefing -> sortie: the intro shot. Started next frame: the ui stops any
  // running cinematic when it switches screens on the same event.
  on('flow:state', ({ state, resumed } = {}) => {
    if (state === 'sortie' && !resumed && (lastFlow === 'briefing' || lastFlow === 'debrief' || lastFlow === 'select')) pendingSortie = true;
    lastFlow = state;
  });
  on('camera:request', ({ mode } = {}) => {
    if (mode === 'restore') rig.stopCinematic?.('sortie');
  });

  // --- free look: right mouse drag ------------------------------------------
  const canvas = game.r?.canvas;
  const onDown = (e) => {
    if (e.button !== 2) return;
    pointer = { id: e.pointerId, x: e.clientX, y: e.clientY };
    rig.look.active = true;
    rig.look.targetYaw = rig.look.yaw;
    rig.look.targetPitch = rig.look.pitch;
    canvas.setPointerCapture?.(e.pointerId);
  };
  const onMove = (e) => {
    if (!pointer || e.pointerId !== pointer.id) return;
    const k = 0.005;
    rig.look.targetYaw = clamp(rig.look.targetYaw + (e.clientX - pointer.x) * k, -LOOK_RANGE_YAW, LOOK_RANGE_YAW);
    rig.look.targetPitch = clamp(rig.look.targetPitch - (e.clientY - pointer.y) * k, -LOOK_RANGE_PITCH, LOOK_RANGE_PITCH);
    pointer.x = e.clientX;
    pointer.y = e.clientY;
  };
  const onUp = (e) => {
    if (!pointer || e.pointerId !== pointer.id) return;
    pointer = null;
    rig.look.active = false;
  };
  const onMenu = (e) => e.preventDefault();
  if (canvas?.addEventListener) {
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);
    canvas.addEventListener('contextmenu', onMenu);
  }

  // Bindings: prefer the gameplay owner's input.actions when it exists.
  const input = game.input;
  const actionPressed = (name, code) => {
    const p = input?.pressed?.[name];
    if (p !== undefined) return !!p;
    const a = input?.actions?.[name];
    if (a !== undefined && a !== null) {
      if (typeof a === 'object') return !!(a.pressed ?? a.down);
      return !!a;
    }
    return input?.consumePress?.(code) ?? false;
  };
  const actionHeld = (name, code) => {
    const a = input?.actions?.[name];
    if (a !== undefined && a !== null) return typeof a === 'object' ? !!(a.held ?? a.down) : !!a;
    return input?.keys?.has?.(code) ?? false;
  };

  function dangerNow() {
    const h = game.hud ?? {};
    return inDanger({
      threats: h.threats?.length ?? hostileMissiles.size,
      warning: h.warning,
      agl: game.flight.agl,
      health: h.health ?? 1,
      crashed: game.flight.crashed,
    });
  }

  /** The enemy the action camera frames: the selected air target, else the nearest hostile fighter within 3.5 km. */
  function pickActionTarget() {
    const h = game.hud ?? {};
    const P = playerPos();
    const sel = h.target?.entity ?? h.lock?.target;
    if (sel?.position && sel.alive !== false && (sel.class === 'air' || sel.kind === 'fighter' || sel.kind === 'ace') && sel.position.distanceTo(P) < 3500) return sel;
    let best = null;
    let bd = 3500;
    for (const t of h.targets ?? []) {
      const e = t.entity ?? t;
      if (!e?.position || e.alive === false || e.team !== 'hostile' || (t.class ?? e.class) !== 'air') continue;
      const d = e.position.distanceTo(P);
      if (d < bd) { bd = d; best = e; }
    }
    return best;
  }

  /** Tag the player's airframe for the motion blur's player shutter (opaque), keep glass see-through (blended). */
  function tagPlayer(root) {
    if (!post || !root) return;
    root.traverse((o) => {
      if (!o.isMesh) return;
      for (const m of [].concat(o.material)) {
        if (m?.transparent) post.useTransparentVelocity?.(m);
        else post.usePlayerVelocity?.(m);
      }
    });
  }

  async function loadCockpit() {
    // First-person overlay from the assets area (emissive displays, periscope,
    // `eye` / `hud` sockets). It parents to the airframe model with an identity
    // transform; the interior itself is part of mig21.glb.
    try {
      const model = await loadModel('mig21_cockpit', { castShadow: false });
      const player = game.player;
      if (!player?.model) return;
      model.traverse((o) => { if (o.isMesh) o.frustumCulled = false; });
      model.visible = false;
      player.model.add(model);
      player.group.updateMatrixWorld(true);
      const eye = model.userData?.sockets?.eye ?? model.getObjectByName('eye');
      if (eye) {
        rig.eye.copy(player.group.worldToLocal(eye.getWorldPosition(rig.eye)));
        rig.useCockpitEye = true;
      }
      rig.cockpitModel = model;
      tagPlayer(model);
    } catch (e) {
      console.warn('[camera] cockpit overlay unavailable', e);
    }
  }

  /** Screen-water surface for a view: lens on the riding chase views, canopy in first person. */
  const surfaceFor = (view) => (view === 'cockpit' || view === 'hud' ? 'canopy'
    : view === 'chase' || view === 'lock' || view === 'action' ? 'lens' : 'none');

  const api = {
    name: 'camera',
    rig,
    screen,
    options: rig.options,
    /** Runtime weather override for dev/testing ({rain}); null = follow env. */
    weatherOverride: null,
    /** Last screen-water drivers (debug). */
    water: null,

    /** Set a camera or camera-post option by name (UI settings hook). */
    setOption(key, value) {
      if (key in rig.options) rig.options[key] = value;
      if (post?.options && (key === 'dof' || key === 'screenWater' || key === 'speedStreaks' || key === 'reducedMotion')) post.options[key] = value;
      if (key === 'dof') rig.options.dof = !!value;
    },

    async init() {
      // Terrain vertices are placed by a positionNode: give its materials
      // camera-only velocity (see PostFX.useStaticVelocity).
      if (post?.useStaticVelocity && game.terrain?.group) {
        const mats = new Set();
        game.terrain.group.traverse((o) => { if (o.material) for (const m of [].concat(o.material)) mats.add(m); });
        for (const m of mats) post.useStaticVelocity(m);
      }
      // The player's jet: glass keeps the velocity behind it, the airframe is
      // tagged for the motion blur's short player shutter.
      tagPlayer(game.player?.group);
      loadCockpit();
      if (import.meta.env?.DEV) import('./dev.js').then((m) => m.installCameraDev(game, api));
      if (params.get('cinematic')) rig.playCinematic(params.get('cinematic'));
    },

    update(dt) {
      if (actionPressed('camera', 'KeyC')) rig.cycleMode();
      if (actionPressed('missileCam', 'KeyB')) rig.options.missileCam = !rig.options.missileCam;
      const pad = input?.gamepad;
      rig.lockHeld = actionHeld('lookTarget', 'KeyV') || !!pad?.buttons?.[11]?.pressed || !!api.devLock;
      rig.devLockTarget = api.devLock || null;
      // right stick free look (when the mouse is not driving it)
      if (!pointer && pad?.axes?.length >= 4) {
        const sx = Math.abs(pad.axes[2]) > 0.2 ? pad.axes[2] : 0;
        const sy = Math.abs(pad.axes[3]) > 0.2 ? pad.axes[3] : 0;
        rig.look.active = sx !== 0 || sy !== 0;
        rig.look.targetYaw = sx * LOOK_RANGE_YAW * 0.75;
        rig.look.targetPitch = -sy * LOOK_RANGE_PITCH;
      }

      // near-miss: hostile missile passing within ~45 m
      for (const m of hostileMissiles) {
        if (m.alive === false) { hostileMissiles.delete(m); continue; }
        if (m._nearMissShaken) continue;
        const d = m.position.distanceTo(playerPos());
        if (d < 45) { m._nearMissShaken = true; rig.addTrauma(0.3); }
      }

      const f = game.flight;
      gunRumble = game.hud?.gun?.firing === true ? 1 : gunRumble;
      rig.rumble = Math.max(flightRumble(f), gunRumble * 0.6);

      // sortie intro (skippable: any weapon or camera input ends it)
      if (pendingSortie) {
        pendingSortie = false;
        if (rig.options.sortieIntro && !rig.options.reducedMotion && game.playerControl) {
          rig.playCinematic('sortie', { blendOut: 1.1 }).catch(() => {});
        }
      }
      if (rig.cinematicName === 'sortie' && (input?.pressed?.fireMissile || input?.pressed?.fireGun || input?.pressed?.camera || dangerNow())) {
        rig.stopCinematic('sortie');
      }

      // action camera: re-pick the subject a few times a second
      actionPick -= dt;
      if (actionPick <= 0) {
        actionPick = 0.25;
        rig.actionTarget = rig.options.actionCam && game.playerControl && !dangerNow() ? pickActionTarget() : null;
      }

      // Mach crossing: sonic thump
      const mach = f.airspeed / speedOfSound(f.altitude ?? f.position.y);
      api.mach = mach;
      const x = machCrossing(machState, mach);
      if (x !== 0 && game.playerControl && !f.crashed) {
        rig.sonicThump(x);
        if (x > 0) shock = { t: 0 };
        game.events.emit('camera:sonic', { direction: x, mach });
      }
    },

    lateUpdate(dt) {
      const ts = game.timeScale ?? 1;
      const rdt = ts > 1e-3 ? dt / ts : dt;
      const f = game.flight;
      const env = game.env;
      const view = rig.view;
      const inCloud = env?.inCloud ?? 0;
      screen.update(rdt, {
        gLoad: f.gLoad,
        health: game.hud?.health,
        inCloud,
        alive: !f.crashed && view !== 'death',
      });
      if (post?.setFrameState) {
        const sunI = env?.sun ? clamp(env.sun.intensity / 3.2, 0, 1.5) : 1;
        const sunUp = env?.sunDirection ? clamp(env.sunDirection.y * 8 + 0.3, 0, 1) : 1;
        const riding = view === 'chase' || view === 'cockpit' || view === 'hud' || view === 'lock' || view === 'action';
        const mach = api.mach ?? 0;
        // water on the glass
        const surface = surfaceFor(view);
        const rain = rainFrom(env, f.position.y, api.weatherOverride);
        const drivers = waterDrivers({ rain, inCloud, airspeed: f.airspeed, altitude: f.position.y, surface });
        // gravity on the glass, in screen uv (y down): world down seen by the camera
        const cam = game.camera;
        _g.set(0, -1, 0).transformDirection(cam.matrixWorldInverse);
        drivers.gravity = [_g.x * 0.12, -_g.y * 0.12];
        drivers.surface = surface;
        api.water = drivers;
        // sonic ripple
        let shockPhase = 0;
        if (shock) {
          shock.t += rdt;
          shockPhase = shock.t / 0.45;
          if (shockPhase >= 1) { shock = null; shockPhase = 0; }
        }
        // the jet's distance shell for the motion blur (chase-like views)
        const camDist = cam.position.distanceTo(f.position);
        const nearShell = view === 'chase' || view === 'lock' || view === 'action' ? camDist + 16 : 0;
        post.setFrameState({
          sunDirection: env?.sunDirection,
          sunIntensity: sunI * sunUp,
          // speed-driven blur/streaks only when the lens rides with the jet
          airspeed: riding ? f.airspeed : 0,
          agl: f.agl,
          mach: riding ? mach : 0,
          view,
          flightDir: f.velocity.lengthSq() > 1 ? _v.copy(f.velocity).normalize() : null,
          nearShell,
          reheat: !!f.reheat,
          screen,
          water: surface === 'none' ? null : drivers,
          waterSurface: surface,
          streaks: riding ? smoothstep(0.86, 0.97, mach) * (1 - smoothstep(1.25, 1.6, mach)) * 0.9 + smoothstep(240, 360, f.airspeed) * (1 - smoothstep(30, 250, f.agl)) * 0.35 : 0,
          shock: shockPhase,
          shockAmp: shockPhase > 0 ? 0.012 * rig.options.fovEffects : 0,
          dof: rig.dofOut,
        });
        if (rig.cut) post.notifyCut();
      }
      rig.clearCut();
    },

    dispose() {
      for (const o of off) o();
      if (canvas?.removeEventListener) {
        canvas.removeEventListener('pointerdown', onDown);
        canvas.removeEventListener('pointermove', onMove);
        canvas.removeEventListener('pointerup', onUp);
        canvas.removeEventListener('pointercancel', onUp);
        canvas.removeEventListener('contextmenu', onMenu);
      }
    },
  };
  return api;
}
