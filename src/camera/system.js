import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { ScreenState } from '../fx/ScreenState.js';
import { explosionTrauma, flightRumble, inDanger, clamp } from './cameraMath.js';

export const order = 85;

const COCKPIT_URL = './models/mig21_cockpit.glb';
const LOOK_RANGE_YAW = 2.4; // rad, free-look limit (over the shoulder)
const LOOK_RANGE_PITCH = 1.1;

/**
 * Camera + post integration system (order 85, camera/post extras).
 *
 *  - input: KeyC (or input.actions.camera) cycles chase / cockpit / HUD;
 *    hold KeyV (or input.actions.lookTarget, pad R3) for the target-lock cam;
 *    hold the right mouse button and drag, or use the right stick, to free look;
 *    KeyB toggles the missile-follow cam.
 *  - events -> camera shake (vfx:shake, explosions, hits, guns, near misses),
 *    kill cam (target:destroyed), death cam (player:destroyed / player:crash),
 *    missile cam (missile:launch).
 *  - screen state (G-LOC greyout, redout, damage, wet lens, flash) -> PostFX.
 *  - feeds PostFX the sun, airspeed and camera cuts every frame.
 *  - loads the optional dedicated cockpit model (public/models/mig21_cockpit.glb).
 *
 * game.systems.camera exposes { rig, screen, options }.
 */
export function createSystem(game) {
  const rig = game.cameraRig;
  const post = game.post;
  const screen = new ScreenState();
  const off = [];
  const on = (type, fn) => off.push(game.events.on(type, fn));
  const hostileMissiles = new Set();
  const params = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');
  let gunRumble = 0;
  let pointer = null;

  rig.attach(game);
  if (post?.options) rig.options.reducedMotion = post.options.reducedMotion;
  if (params.has('nokillcam')) rig.options.killCam = false;

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
      if (rig.options.missileCam && (missile.kind ?? 'aam') !== 'rocket') rig.followMissile(missile);
    } else {
      hostileMissiles.add(missile);
    }
  });
  on('missile:end', ({ missile, reason } = {}) => {
    if (!missile) return;
    if (hostileMissiles.has(missile)) {
      hostileMissiles.delete(missile);
      const d = missile.position?.distanceTo?.(playerPos()) ?? Infinity;
      if (reason !== 'hit' && d < 150) rig.addTrauma(0.25 * (1 - d / 150));
    }
  });
  on('target:destroyed', ({ target, killer, position } = {}) => {
    if (!isPlayer(killer)) return;
    const h = game.hud ?? {};
    const danger = inDanger({
      threats: h.threats?.length ?? hostileMissiles.size,
      warning: h.warning,
      agl: game.flight.agl,
      health: h.health ?? 1,
      crashed: game.flight.crashed,
    });
    if (!danger) rig.killCam(target, position);
  });
  on('player:destroyed', ({ position, velocity } = {}) => {
    rig.addTrauma(1);
    rig.deathCam(position ?? game.flight.position, velocity ?? game.flight.velocity);
  });
  on('player:crash', ({ position } = {}) => {
    rig.addTrauma(1);
    if (rig.view !== 'death') rig.deathCam(position ?? game.flight.position);
  });
  on('player:respawn', () => { screen.reset(); rig.reset(game.flight); });

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

  async function loadCockpit() {
    // Probe first: the dev server answers unknown paths with index.html.
    try {
      const res = await fetch(COCKPIT_URL, { method: 'HEAD' });
      const type = res.headers.get('content-type') ?? '';
      if (!res.ok || type.includes('text/html')) return;
    } catch { return; }
    try {
      const loader = new GLTFLoader();
      loader.setMeshoptDecoder(MeshoptDecoder);
      const gltf = await loader.loadAsync(COCKPIT_URL);
      const model = gltf.scene;
      // Convention: model space = airframe space (nose -Z, metres) with its
      // origin at the cockpit socket; an optional node named "eye" marks the
      // pilot's eye, which the rig then uses.
      const socket = game.player.sockets.cockpit;
      const eyeNode = model.getObjectByName('eye') ?? model.getObjectByName('Eye') ?? model.getObjectByName('pilot_eye');
      model.traverse((o) => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = true; o.frustumCulled = false; } });
      socket.add(model);
      model.updateMatrixWorld(true);
      game.player.group.updateMatrixWorld(true);
      if (eyeNode) rig.eye.copy(game.player.group.worldToLocal(eyeNode.getWorldPosition(rig.eye)));
      else rig.eye.copy(socket.position);
      rig.useCockpitEye = true;
      model.visible = false;
      rig.cockpitModel = model;
      console.info('[camera] dedicated cockpit model loaded');
    } catch (e) {
      console.warn('[camera] cockpit model failed to load', e);
    }
  }

  return {
    name: 'camera',
    rig,
    screen,
    options: rig.options,

    async init() {
      // Terrain vertices are placed by a positionNode: give its materials
      // camera-only velocity (see PostFX.useStaticVelocity).
      if (post?.useStaticVelocity && game.terrain?.group) {
        const mats = new Set();
        game.terrain.group.traverse((o) => { if (o.material) for (const m of [].concat(o.material)) mats.add(m); });
        for (const m of mats) post.useStaticVelocity(m);
      }
      // Canopy / gunsight glass on the player's jet: keep the velocity behind it.
      if (post?.useTransparentVelocity && game.player?.group) {
        game.player.group.traverse((o) => {
          if (o.isMesh) for (const m of [].concat(o.material)) post.useTransparentVelocity(m);
        });
      }
      loadCockpit();
      if (params.get('cinematic')) rig.playCinematic(params.get('cinematic'));
    },

    update(dt) {
      if (actionPressed('camera', 'KeyC')) rig.cycleMode();
      if (actionPressed('missileCam', 'KeyB')) rig.options.missileCam = !rig.options.missileCam;
      const pad = input?.gamepad;
      rig.lockHeld = actionHeld('lookTarget', 'KeyV') || !!pad?.buttons?.[11]?.pressed;
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
    },

    lateUpdate(dt) {
      const ts = game.timeScale ?? 1;
      const rdt = ts > 1e-3 ? dt / ts : dt;
      const f = game.flight;
      screen.update(rdt, {
        gLoad: f.gLoad,
        health: game.hud?.health,
        inCloud: game.env?.inCloud ?? 0,
        alive: !f.crashed && rig.view !== 'death',
      });
      if (post?.setFrameState) {
        const sunI = game.env?.sun ? clamp(game.env.sun.intensity / 3.2, 0, 1.5) : 1;
        const sunUp = game.env?.sunDirection ? clamp(game.env.sunDirection.y * 8 + 0.3, 0, 1) : 1;
        post.setFrameState({
          sunDirection: game.env?.sunDirection,
          sunIntensity: sunI * sunUp,
          // speed-driven blur/streaks only when the lens rides with the jet
          airspeed: rig.view === 'chase' || rig.view === 'cockpit' || rig.view === 'hud' || rig.view === 'lock' ? f.airspeed : 0,
          reheat: !!f.reheat,
          screen,
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
}
