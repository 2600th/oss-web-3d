import * as THREE from 'three/webgpu';
import { FlightModel } from '../flight/FlightModel.js';
import { AssistController } from '../flight/AssistController.js';
import { Aircraft } from '../flight/Aircraft.js';
import { CameraRig } from '../flight/CameraRig.js';
import { Terrain } from '../world/terrain/Terrain.js';
import { terrainHeight } from '../world/terrain/heightfield.js';
import { Environment } from '../world/Environment.js';
import { Events } from './Events.js';

export const PHYSICS_STEP = 1 / 120;
const MAX_STEPS = 12;

/**
 * Orchestrator. Owns the world, the player, and a list of *systems*.
 *
 * A system is any object with optional hooks:
 *   init(game)            async-capable, called once after the world is built
 *   fixedUpdate(dt, game) at PHYSICS_STEP, after the player's flight step
 *   update(dt, game)      once per frame, before render
 *   lateUpdate(dt, game)  after the camera has moved (HUD, screen-space work)
 *   dispose()
 * Register with `game.addSystem(system)`; systems find each other through
 * `game.systems.<name>` (set `system.name`).
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
    // (terrain owner) `env` lets the terrain follow the sun for its long-range
    // shadows and pick up cloud shadows; grid/levels are now derived from the tier.
    this.terrain = new Terrain(r, { grid: t.terrainGrid, levels: t.terrainLevels, env: this.env });
    this.terrain.addTo(this.scene);

    this.flight = new FlightModel();
    this.assist = new AssistController();
    this.player = new Aircraft();
    this.player.addTo(this.scene);
    this.cameraRig = new CameraRig(this.camera);
    this._assistOptions = { sensitivity: 1, autoThrottle: true, reconActive: false };
  }

  async init() {
    await this.player.load();
    this.spawn();
    for (const s of this._systemList) await s.init?.(this);
    this._initialised = true;
  }

  /** Register a system. If the game is already initialised, init it now. */
  async addSystem(system) {
    this._systemList.push(system);
    if (system.name) this.systems[system.name] = system;
    if (this._initialised) await system.init?.(this);
    return system;
  }

  spawn(x = -14000, z = 6000, heading = Math.PI * 0.5) {
    const y = terrainHeight(x, z) + 1400;
    this.flight.reset(new THREE.Vector3(x, y, z), heading, 230);
    this.assist.reset?.();
    this.cameraRig.reset(this.flight);
  }

  _control(step) {
    const ctl = this.assist.update(step, this.input.intent, this.flight, this._assistOptions);
    return ctl;
  }

  update(rawDt) {
    const dt = Math.min(rawDt, 0.1) * this.timeScale;
    if (this.paused) return;
    this.time += dt;
    this.input.update(dt);

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

  onCrash() {
    this.cameraRig.addTrauma(1);
    this.events.emit('player:crash', { position: this.flight.impactPoint.clone(), velocity: this.flight.impactVelocity.clone() });
    for (const s of this._systemList) s.onCrash?.(this);
    setTimeout(() => this.spawn(), 2500);
  }
}
