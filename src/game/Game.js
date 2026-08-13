import * as THREE from 'three';
import { Environment } from '../world/Environment.js';
import { Sky } from '../world/Sky.js';
import { Terrain } from '../world/Terrain.js';
import { Clouds } from '../world/Clouds.js';
import { terrainHeight, maxHeightAlong } from '../world/heightfield.js';
import { FlightFx } from '../fx/FlightFx.js';
import { Audio } from '../fx/Audio.js';
import { FlightModel } from '../flight/FlightModel.js';
import { Aircraft } from '../flight/Aircraft.js';
import { ChaseCamera } from '../flight/ChaseCamera.js';
import { Mission } from './Mission.js';
import { ReconCamera, CAPTURE_THRESHOLD } from './ReconCamera.js';
import { Hud } from '../ui/Hud.js';
import { Screens } from '../ui/Screens.js';

/**
 * Orchestrates the whole experience: world, aircraft, mission, interface, and
 * the state machine that moves between the title sequence, the briefing, flight
 * and the debrief.
 *
 * Physics runs on a fixed 120 Hz accumulator. A jet covering 250 m per second is
 * exactly the case where variable-step integration gives different flight
 * behaviour on different machines, and where one long frame tunnels the
 * aircraft straight through a ridge.
 */

const PHYSICS_STEP = 1 / 120;
const MAX_STEPS = 6;

const START = new THREE.Vector3(21000, 0, 6000);

export class Game {
  constructor(engine, settings, input) {
    this.engine = engine;
    this.settings = settings;
    this.input = input;

    this.state = 'loading';
    this.accumulator = 0;
    this.crashTimer = 0;
    this.cinematicTime = 0;

    this.environment = new Environment();
    this.environment.addTo(engine.scene);

    this.sky = new Sky(this.environment);
    engine.scene.add(this.sky.mesh);

    this.terrain = new Terrain(engine.renderer, this.environment);
    engine.scene.add(this.terrain.group);
    this.terrain.setQuality(settings.tier);

    this.clouds = new Clouds(this.environment);
    this.clouds.setQuality(settings.tier);
    engine.scene.add(this.clouds.mesh);

    this.fx = new FlightFx(this.environment);
    this.fx.setQuality(settings.tier);
    engine.scene.add(this.fx.group);

    this.audio = new Audio(settings);

    this.envMap = this.sky.bakeEnvironment(engine.renderer, this.environment);
    engine.scene.environment = this.envMap;

    this.flight = new FlightModel();
    this.chase = new ChaseCamera(engine.camera);
    this.recon = new ReconCamera(engine.camera);
    this.aircraft = new Aircraft(this.environment);
    this.aircraft.addTo(engine.scene);

    const ui = document.getElementById('ui');
    this.screens = new Screens(ui, {
      onLaunch: () => this.launch(),
      onResume: () => this.resume(),
      onRestart: () => this.restart(),
      onQuality: (tier) => this.setQuality(tier),
    });
    this.hud = new Hud(ui);

    this._skipHandlers = new Set();
    this.skipSignal = {
      on: (fn) => this._skipHandlers.add(fn),
      off: (fn) => this._skipHandlers.delete(fn),
    };

    this.reconActive = false;
    this.evaluation = null;
    this.terrainWarning = false;
  }

  async load() {
    this.screens.setProgress(0.1);
    this.flight.reset(this._startPosition(), Math.PI * 0.62, 260);
    this.terrain.prime(this.flight.position);
    this.screens.setProgress(0.35);

    try {
      await this.aircraft.load('./models/mig21.glb', this.envMap);
    } catch (error) {
      // A missing airframe should not take the whole experience down; the world
      // and the mission are still flyable, and the failure is visible.
      console.error('[game] aircraft model failed to load', error);
    }
    this.screens.setProgress(0.75);

    this.mission = new Mission(this.engine.scene, this.flight.position, 5);
    this.screens.setTargets(this.mission.posts);
    this.hud.setObjectiveCount(this.mission.posts.length);
    this.screens.setQuality(this.settings.tierName);
    this.screens.setProgress(1);

    // Give the terrain a couple of frames at the cinematic viewpoint before the
    // curtain lifts, so the title never opens on half-generated clipmap levels.
    this._setupCinematic();
    this.terrain.prime(this.engine.camera.position);
  }

  async begin() {
    this.screens.hideLoading();
    this.state = 'title';
    await this.screens.playTitle(this.skipSignal);
    // Guard against the title resolving after something else has already moved
    // the game on — skipping straight into flight would otherwise be undone by
    // this line landing a frame later.
    if (this.state !== 'title') return;
    this.state = 'briefing';
    this.screens.show(this.screens.briefingLayer);
  }

  _startPosition() {
    const p = START.clone();
    p.y = terrainHeight(p.x, p.z) + 1500;
    return p;
  }

  _setupCinematic() {
    this.cinematicCentre = new THREE.Vector3(21000, 0, 6000);
    this.cinematicCentre.y = terrainHeight(21000, 6000) + 2100;
    this.cinematicTime = 0;
    this._updateCinematic(0);
  }

  /** Slow orbit over the range behind the title and briefing. */
  _updateCinematic(dt) {
    this.cinematicTime += dt;
    const camera = this.engine.camera;
    const a = 0.55 + this.cinematicTime * 0.016;
    const r = 5200;
    camera.position.set(
      this.cinematicCentre.x + Math.cos(a) * r,
      this.cinematicCentre.y + Math.sin(this.cinematicTime * 0.05) * 260,
      this.cinematicCentre.z + Math.sin(a) * r,
    );
    const look = this.cinematicCentre.clone();
    look.y -= 900;
    camera.up.set(0, 1, 0);
    camera.lookAt(look);
    if (camera.fov !== 42) {
      camera.fov = 42;
      camera.updateProjectionMatrix();
    }
    camera.updateMatrixWorld();
  }

  launch() {
    this.screens.hideAll();
    this.flight.reset(this._startPosition(), Math.PI * 0.62, 260);
    this.chase.reset(this.flight);
    this.terrain.prime(this.flight.position);
    this.fx.reset();
    this.mission.begin();
    this.hud.show(true);
    this.state = 'flying';
    this.engine.camera.fov = this.chase.baseFov;
    this.engine.camera.updateProjectionMatrix();
  }

  restart() {
    this.mission.dispose();
    this.mission = new Mission(this.engine.scene, this._startPosition(), 5);
    this.screens.setTargets(this.mission.posts);
    this.hud.setObjectiveCount(this.mission.posts.length);
    this.launch();
  }

  pause() {
    if (this.state !== 'flying') return;
    this.state = 'paused';
    this.hud.show(false);
    this.screens.show(this.screens.pauseLayer);
  }

  resume() {
    if (this.state !== 'paused') return;
    this.state = 'flying';
    this.screens.hideAll();
    this.hud.show(true);
  }

  setQuality(tier) {
    this.settings.setTier(tier);
    this.engine.applySettings();
    this.terrain.setQuality(this.settings.tier);
    this.clouds.setQuality(this.settings.tier);
    this.fx.setQuality(this.settings.tier);
    this.screens.setQuality(tier);
  }

  _finish(success) {
    this.state = success ? 'complete' : 'failed';
    this.hud.show(false);
    this.reconActive = false;
    this.screens.showDebrief(this.mission, success);
  }

  update(dt) {
    const input = this.input;
    input.update(dt, this.settings.invertPitch);

    // Browsers require a gesture before audio can start, so the first key press
    // of the session is what brings the engine up.
    if (input.anyPress() || input.keys.size) {
      this.audio.start();
      this.audio.resume();
    }

    if (this.state === 'title' && input.anyPress()) {
      for (const fn of [...this._skipHandlers]) fn();
      input.clearPresses();
    }

    if (input.consumePress('Escape')) {
      if (this.state === 'flying') this.pause();
      else if (this.state === 'paused') this.resume();
    }

    if ((this.state === 'briefing' || this.state === 'complete' || this.state === 'failed') &&
        input.consumePress('Enter')) {
      if (this.state === 'briefing') this.launch();
      else this.restart();
    }

    switch (this.state) {
      case 'title':
      case 'briefing':
        this._updateCinematic(dt);
        this.terrain.update(this.engine.camera.position, this.settings.tier.terrainBudget);
        this.clouds.update(dt, this.engine.camera.position);
        break;

      case 'flying':
        this._updateFlight(dt);
        break;

      case 'paused':
        break;

      default:
        // Debrief screens keep the last camera pose; the world stays alive
        // behind them so the moment does not feel like a modal dialog.
        this.terrain.update(this.engine.camera.position, 1);
        break;
    }

    this.environment.update(dt, this.engine.camera.position);
    this.sky.update(this.engine.camera);
    this.screens.refreshTargets(this.mission?.posts ?? []);
    input.clearPresses();
  }

  _updateFlight(dt) {
    const input = this.input;
    const flight = this.flight;

    if (!flight.crashed) {
      if (input.consumePress('Tab')) this.mission.cycleTarget(1);
      if (input.consumePress('KeyF')) this.recon.zoomIn();
      if (input.consumePress('KeyV')) this.recon.zoomOut();
      this.reconActive = input.reconHeld;
    } else {
      this.reconActive = false;
    }

    this.accumulator += dt;
    let steps = 0;
    while (this.accumulator >= PHYSICS_STEP && steps < MAX_STEPS) {
      flight.update(PHYSICS_STEP, input);
      if (!flight.crashed && flight.checkTerrainCollision(PHYSICS_STEP)) {
        this.onCrash();
      }
      this.accumulator -= PHYSICS_STEP;
      steps++;
    }
    if (steps === MAX_STEPS) this.accumulator = 0;

    this.aircraft.update(dt, flight);
    this.mission.update(dt, flight.position);

    // Terrain proximity, measured against the ground actually ahead.
    //
    // This used to divide AGL by descent rate, which sounds like closure and is
    // not: flying level at a wall of rock has a descent rate of zero, so the
    // expression pinned to AGL / 1 and only warned below about 7 m — long past
    // the point of being useful, and never at all in the case that matters
    // most. Sampling the highest ground along the projected path catches rising
    // terrain while there is still room to pull.
    const look = 7.5; // seconds of flight path
    const aheadX = flight.position.x + flight.velocity.x * look;
    const aheadZ = flight.position.z + flight.velocity.z * look;
    const ridge = maxHeightAlong(flight.position.x, flight.position.z, aheadX, aheadZ, 10);
    const lowestClearance = Math.min(
      flight.agl,
      flight.position.y + flight.velocity.y * look - ridge,
    );
    this.terrainWarning = !flight.crashed && lowestClearance < 260;

    if (this.reconActive) {
      this.recon.update(dt, flight);
      this.evaluation = this._evaluateBest();
      if (
        this.input.consumePress('Enter') &&
        this.recon.shutterCooldown <= 0 &&
        this.evaluation
      ) {
        this._takePhoto(this.evaluation);
      }
    } else {
      this.evaluation = null;
      this.chase.update(dt, flight, flight.crashed ? 0.85 : 0);
    }

    this.terrain.update(flight.position, this.settings.tier.terrainBudget);
    this.clouds.update(dt, flight.position);
    this.fx.update(dt, flight, this.engine.camera.position);

    // Closing rate between camera and aircraft, for the Doppler shift. The
    // chase camera trails, so hard acceleration opens the gap and drops the
    // engine note fractionally.
    const closing = _tmp.subVectors(flight.position, this.engine.camera.position);
    const distance = closing.length();
    const closingRate =
      distance > 1 ? flight.velocity.dot(closing) / distance - flight.airspeed : 0;
    this.audio.update(
      dt,
      flight,
      closingRate,
      this.terrainWarning ? 'terrain' : flight.stalling ? 'stall' : 'none',
    );

    this._updateHud(dt);

    if (flight.crashed) {
      this.crashTimer += dt;
      if (this.crashTimer > 2.1) this._finish(false);
    } else if (this.mission.state === 'complete') {
      this._finish(true);
    }
  }

  /** The post the camera is best placed to photograph right now. */
  _evaluateBest() {
    let best = null;
    for (const post of this.mission.posts) {
      const ev = this.recon.evaluate(post);
      if (!ev.inFrame) continue;
      if (!best || ev.score > best.score) best = ev;
    }
    // Fall back to the steering target so the overlay can explain itself even
    // when nothing is framed.
    if (!best && this.mission.target) return this.recon.evaluate(this.mission.target);
    return best;
  }

  _takePhoto(evaluation) {
    const shot = this.recon.capture(this.engine.renderer, this.engine.scene, evaluation);
    this.mission.photosTaken++;

    const post = evaluation.post;
    if (evaluation.score > post.bestScore) {
      post.bestScore = evaluation.score;
      post.photo = shot;
    }
    if (evaluation.score >= CAPTURE_THRESHOLD && !post.captured) {
      post.captured = true;
    }
    this.hud.showPhoto(post, shot);
    this.audio.shutter();
    if (post.captured) this.audio.confirm();
  }

  onCrash() {
    this.crashTimer = 0;
    this.mission.fail('terrain');
    this.audio.impact(Math.min(1, this.flight.impactSpeed / 320));
  }

  _updateHud(dt) {
    const flight = this.flight;
    const mission = this.mission;
    const target = mission.target;

    let bearing = 0;
    let range = 0;
    if (target) {
      const b = mission.bearingTo(target, flight.position);
      bearing = b.bearing;
      range = b.range;
    }

    const euler = _euler.setFromQuaternion(flight.orientation, 'YXZ');
    const heading = (-euler.y * 180) / Math.PI;

    this.hud.update(dt, {
      speedKmh: flight.airspeed * 3.6,
      altitude: flight.altitude,
      heading,
      throttle: flight.throttleSmoothed,
      reheat: flight.reheat,
      captured: mission.captured,
      total: mission.posts.length,
      target,
      targetBearing: bearing,
      targetRange: range,
      stalling: flight.stalling,
      terrainWarning: this.terrainWarning,
      gLoad: flight.gLoad,
      reconActive: this.reconActive,
      zoomIndex: this.recon.zoomIndex,
      evaluation: this.evaluation,
      shutterFlash: this.recon.flash,
    });
  }
}

const _euler = new THREE.Euler();
const _tmp = new THREE.Vector3();
