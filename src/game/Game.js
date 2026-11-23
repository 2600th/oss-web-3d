import * as THREE from 'three/webgpu';
import { FlightModel } from '../flight/FlightModel.js';
import { AssistController } from '../flight/AssistController.js';
import { Aircraft } from '../flight/Aircraft.js';
import { CameraRig } from '../flight/CameraRig.js';
import { Terrain } from '../world/terrain/Terrain.js';
import { terrainHeight } from '../world/terrain/heightfield.js';
import { Environment } from '../world/Environment.js';
import { Events } from './Events.js';
import { Flow } from './Flow.js';

export const PHYSICS_STEP = 1 / 120;
const MAX_STEPS = 12;
const D2R = Math.PI / 180;

/**
 * Orchestrator. Owns the world, the player, the flow state machine and a list
 * of *systems*.
 *
 * A system is any object with optional hooks:
 *   init(game)            async-capable, called once after the world is built
 *   fixedUpdate(dt, game) at PHYSICS_STEP, after the player's flight step
 *   update(dt, game)      once per frame, before render
 *   lateUpdate(dt, game)  after the camera has moved (HUD, screen-space work)
 *   onCrash(game)
 *   dispose()
 * Register with `game.addSystem(system)`; systems find each other through
 * `game.systems.<name>` (set `system.name`).
 *
 * Player control: `game.input.mode` is 'standard' (assisted: the stick asks
 * for coordinated turns and a flight path, AssistController flies it) or
 * 'expert' (direct pitch / roll / yaw). `game.autopilot`, when set, flies the
 * aircraft instead (title flyby, dev bot). `game.playerControl` is true only
 * during a sortie.
 */
export class Game {
  constructor(r, input, post) {
    this.r = r;
    this.input = input;
    this.post = post;
    this.scene = r.scene;
    this.camera = r.camera;
    this.time = 0;
    this.timeScale = 1;
    this.paused = false;
    this.events = new Events();
    /** Per-frame snapshot for the HUD; shape documented in docs/v2/ARCHITECTURE.md. */
    this.hud = {};
    this.systems = {};
    this._systemList = [];
    this._acc = 0;

    this.env = new Environment(r);
    this.env.addTo(this.scene);
    const t = r.tier;
    this.terrain = new Terrain(r, { grid: t.terrainGrid, levels: t.terrainLevels });
    this.terrain.addTo(this.scene);

    this.flight = new FlightModel();
    this.assist = new AssistController();
    this.player = new Aircraft();
    this.player.addTo(this.scene);
    this.cameraRig = new CameraRig(this.camera);
    this._assistOptions = { sensitivity: 'combat', autoThrottle: false, reconActive: false };
    this._direct = { pitch: 0, roll: 0, yaw: 0, throttle: 0.8, brake: 0 };
    this._dead = { pitch: 0.25, roll: 0.55, yaw: 0, throttle: 0, brake: 0 };
    this._neutralIntent = { turn: 0, climb: 0, yaw: 0, speed: 0, boost: false, brake: 0, throttle: 0.78 };

    /** True while the player is flying a sortie. */
    this.playerControl = false;
    /** Optional `{update(dt, flight) -> intent}` that flies instead of the player. */
    this.autopilot = null;
    this.flow = new Flow(this);
  }

  async init() {
    await this.player.load();
    this.spawn();
    for (const s of this._systemList) await s.init?.(this);
    this._initialised = true;
    this.flow.boot();
    if (import.meta.env.DEV) {
      const dev = await import('./dev/index.js');
      this.dev = dev.install(this);
    }
  }

  /** Register a system. If the game is already initialised, init it now. */
  async addSystem(system) {
    this._systemList.push(system);
    if (system.name) this.systems[system.name] = system;
    if (this._initialised) await system.init?.(this);
    return system;
  }

  /** Legacy spawn (internal heading: radians, counter-clockwise from north). */
  spawn(x = -14000, z = 6000, heading = Math.PI * 0.5) {
    const y = terrainHeight(x, z) + 1400;
    this._place(new THREE.Vector3(x, y, z), heading, 230);
  }

  /**
   * Place the player. `heading` is compass degrees (0 = north, 90 = east);
   * `alt` is metres MSL, or give `agl`.
   */
  spawnAt({ x, z, alt, agl = 1400, heading = 0, speed = 240 }) {
    const y = alt ?? terrainHeight(x, z) + agl;
    this._place(new THREE.Vector3(x, Math.max(y, terrainHeight(x, z) + 150), z), -heading * D2R, speed);
  }

  _place(position, heading, speed) {
    this.flight.reset(position, heading, speed);
    this.assist.reset?.();
    this.player.syncTo(this.flight);
    this.cameraRig.reset(this.flight);
    this._acc = 0;
    this.events.emit('player:respawn', {});
  }

  _control(step) {
    const f = this.flight;
    if (f.destroyed) return this._dead;
    if (this.autopilot) return this.assist.update(step, this.autopilot.intent, f, this._assistOptions);
    if (!this.playerControl) return this.assist.update(step, this._neutralIntent, f, this._assistOptions);
    const input = this.input;
    if (input.mode === 'expert') {
      const c = this._direct;
      c.pitch = input.pitch;
      c.roll = input.roll;
      c.yaw = input.yaw;
      c.throttle = input.throttle;
      c.brake = input.brake;
      return c;
    }
    return this.assist.update(step, input.intent, f, this._assistOptions);
  }

  update(rawDt) {
    const real = Math.min(rawDt, 0.1);
    this.input.update(real);
    this.flow.update(real);
    if (this.paused) return;
    const dt = real * this.timeScale;
    this.time += dt;

    if (this.playerControl) {
      if (this.input.pressed.controlMode) {
        const mode = this.input.setMode(this.input.mode === 'standard' ? 'expert' : 'standard');
        this.assist.reset?.();
        this.events.emit('controls:mode', { mode });
      }
      // Until a camera system takes the action over, cycle the foundation rig.
      if (this.input.pressed.camera && !this.systems.camera) {
        this.cameraRig.mode = this.cameraRig.mode === 'chase' ? 'cockpit' : 'chase';
        this.events.emit('camera:mode', { mode: this.cameraRig.mode });
      }
    }
    if (this.autopilot) this.autopilot.update(dt, this.flight, this);

    this._acc += dt;
    let steps = 0;
    while (this._acc >= PHYSICS_STEP && steps < MAX_STEPS) {
      if (!this.flight.crashed) {
        this.flight.update(PHYSICS_STEP, this._control(PHYSICS_STEP));
        if (this.flight.checkTerrainCollision(PHYSICS_STEP)) this.onCrash();
      }
      for (const s of this._systemList) s.fixedUpdate?.(PHYSICS_STEP, this);
      this._acc -= PHYSICS_STEP;
      steps++;
    }
    if (steps === MAX_STEPS) this._acc = 0;

    this.player.syncTo(this.flight);
    for (const s of this._systemList) s.update?.(dt, this);
    this.cameraRig.update(dt, this.flight, this.player);
    this.env.update(dt, this.camera, this.flight.position);
    this.terrain.update(this.camera);
    for (const s of this._systemList) s.lateUpdate?.(dt, this);
  }

  /** Ground collision = destroyed. The mission system decides what follows. */
  onCrash() {
    this.cameraRig.addTrauma(1);
    this.events.emit('explosion', { position: this.flight.impactPoint.clone(), size: 'large', kind: 'ground', velocity: this.flight.impactVelocity.clone() });
    this.events.emit('player:crash', { position: this.flight.impactPoint.clone(), velocity: this.flight.impactVelocity.clone() });
    for (const s of this._systemList) s.onCrash?.(this);
    // Outside a sortie (menu flyby) there is nobody to tell: just fly again.
    if (!this.playerControl && this.flow.cinematic.active) {
      const ap = this.autopilot;
      if (ap?.start) { ap.s = 0; ap.dir = 1; this.spawnAt(ap.start()); }
    }
  }
}
