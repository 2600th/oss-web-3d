import * as THREE from 'three';
import { Environment } from '../world/Environment.js';
import { Sky } from '../world/Sky.js';
import { Terrain, configureTerrain } from '../world/Terrain.js';
import { Water } from '../world/Water.js';
import { CloudVolume } from '../world/CloudVolume.js';
import { CloudField } from '../world/CloudField.js';
import { terrainHeight, maxHeightAlong } from '../world/heightfield.js';
import { FlightFx } from '../fx/FlightFx.js';
import { computeMotionProfile } from '../fx/post/motionProfile.js';
import { setFxResolution, setSceneDepth } from '../fx/gpu/FrameUniforms.js';
import { Audio } from '../fx/Audio.js';
import { FlightModel } from '../flight/FlightModel.js';
import { AssistController } from '../flight/AssistController.js';
import { Aircraft } from '../flight/Aircraft.js';
import { ChaseCamera } from '../flight/ChaseCamera.js';
import { Mission } from './Mission.js';
import { ReconCamera, CAPTURE_THRESHOLD } from './ReconCamera.js';
import { NavigationHintTracker } from './NavigationHint.js';
import { Leaderboard } from './Leaderboard.js';
import { terrainVisibility } from './TerrainVisibility.js';
import { resolveSeed, sortieLabel, sortieParams } from './sortieParams.js';
import { ACQUISITION_SCORE } from './acquisition.js';
import { REHEAT_THRESHOLD } from '../flight/burner.js';
import { acceptsLaunchKey } from './sortieState.js';
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

/** Seconds the view takes to travel between the chase boom and the nose optic. */
const RECON_ENTER_SECONDS = 0.26;
const RECON_EXIT_SECONDS = 0.36;

/**
 * How long the one-time assisted-controls note stays up. It is orientation, not
 * a failure: a single sentence is read well inside four seconds, and leaving it
 * pinned over the briefing made the player dismiss a bar that had already done
 * its job. Failure notices in the same widget still persist until dismissed.
 */
const ASSIST_NOTICE_MS = 4000;

/**
 * Auto-capture controller. The dwell floor stops a framing that clips the
 * threshold for a single frame mid-slew from firing; the ceiling is well inside
 * EXCELLENT, where waiting for better is a worse bet than banking the shot; and
 * the falloff is the drop from the run's peak that counts as "turned over".
 * The dwell ceiling exists so a perfectly steady hold at a merely good score
 * still resolves instead of waiting forever for an improvement that never comes.
 */
/**
 * Screens the player sits still on, and therefore the ones the menu theme plays
 * under. Flight, and both debriefs, book their own cue.
 */
const MENU_MUSIC_STATES = new Set(['title', 'briefing', 'paused']);

const AUTO_CAPTURE_MIN_DWELL = 0.25;
const AUTO_CAPTURE_MAX_DWELL = 1.4;
const AUTO_CAPTURE_CEILING = 0.86;
const AUTO_CAPTURE_FALLOFF = 0.012;

/**
 * The sortie used to open here, always. START was a constant and findPostSites
 * is a pure deterministic search, so every sortie anyone flew was the same five
 * posts in the same places in the same order — in a world that is infinite and
 * deterministic and cost nothing to move around in. Kept only as the fallback
 * for a seed that somehow resolves to nothing.
 */
const FALLBACK_ORIGIN = new THREE.Vector3(21000, 0, 6000);

/** Scratch for projecting the nozzle into screen space each frame. */
const _heatNdc = new THREE.Vector3();
/** Scratch for projecting the velocity vanishing point each frame. */
const _motionNdc = new THREE.Vector3();

/** Ease with zero first *and* second derivative at both ends, so no visible kick. */
function smootherstep(t) {
  const x = t < 0 ? 0 : t > 1 ? 1 : t;
  return x * x * x * (x * (x * 6 - 15) + 10);
}

/** Half-resolution, hard-capped scene source for lake refraction. */
export function waterRefractionSize(width, height, tier, out = null) {
  if (tier !== 'high' && tier !== 'medium') return null;
  const scale = tier === 'high' ? 0.5 : 0.5;
  const capW = tier === 'high' ? 960 : 768;
  const capH = tier === 'high' ? 540 : 432;
  const factor = Math.min(scale, capW / Math.max(width, 1), capH / Math.max(height, 1));
  const result = out ?? [0, 0];
  result[0] = Math.max(1, Math.floor(width * factor));
  result[1] = Math.max(1, Math.floor(height * factor));
  return result;
}

/** Select the refraction colour format that the current driver can render. */
export function waterRefractionType(renderer, tier) {
  if (tier !== 'high') return THREE.UnsignedByteType;
  const renderableHalfFloat = Boolean(
    renderer?.capabilities?.isWebGL2 &&
    renderer?.extensions?.has?.('EXT_color_buffer_float'),
  );
  return renderableHalfFloat ? THREE.HalfFloatType : THREE.UnsignedByteType;
}

export class Game {
  constructor(engine, settings, input) {
    this.engine = engine;
    this.settings = settings;
    this.input = input;

    // One seed decides where the sortie is and what the light is doing. `?seed=N`
    // pins one for sharing or debugging; otherwise everyone flying today gets
    // the same world, which is the only thing that makes a shared fastest-sortie
    // board comparable.
    this.sortie = sortieParams(resolveSeed(globalThis.location?.search ?? ''));

    this.state = 'loading';
    this.accumulator = 0;
    this.crashTimer = 0;
    this.cinematicTime = 0;

    this.environment = new Environment();
    // The sortie's hour of the morning and its weather, before anything bakes
    // an environment map or primes a clipmap against the default sun.
    this.environment.setSun(this.sortie.sunElevationDeg, this.sortie.sunAzimuthDeg);
    this.environment.uniforms.uCloudCoverage.value = this.sortie.cloudCoverage;
    this.environment.addTo(engine.scene);

    this.sky = new Sky(this.environment);
    engine.scene.add(this.sky.mesh);

    this.terrain = new Terrain(engine.renderer, this.environment);
    engine.scene.add(this.terrain.group);
    this.terrain.setQuality(settings.tier);
    this.terrainResolution = settings.tier.terrainRes;

    this.water = new Water(engine.renderer, this.environment, { quality: settings.tier.name });
    engine.scene.add(this.water);
    this._waterRefractionTarget = null;
    this._waterDrawingSize = new THREE.Vector2();
    this._waterRefractionDimensions = [0, 0];
    this._waterFrustum = new THREE.Frustum();
    this._waterViewProjection = new THREE.Matrix4();
    this._waterLakeBounds = new THREE.Sphere();
    this._waterRefractionSource = {
      colorTexture: null,
      depthTexture: null,
      width: 0,
      height: 0,
      near: engine.camera.near,
      far: engine.camera.far,
    };

    // CloudVolume no longer draws the sky — CloudField does. What it still owns
    // is the live transmittance map the terrain samples for cloud shadows, and
    // both are placed from the same weather model, so a shadow on the ground
    // still belongs to a cloud that is really overhead.
    this.clouds = new CloudVolume(this.environment, engine.camera);
    this.clouds.setShadowOnly(true);
    engine.setClouds(null);

    this.cloudField = new CloudField(this.environment, engine.camera);
    this.cloudField.initialize(engine.renderer);
    this.cloudField.setQuality(settings.tier);
    engine.scene.add(this.cloudField.mesh);

    this.fx = new FlightFx(this.environment);
    this.fx.setQuality(settings.tier);
    engine.scene.add(this.fx.group);
    engine.renderer.getDrawingBufferSize(this._waterDrawingSize);
    this.clouds.initialize(engine.renderer);
    // Soft particles read composer depth. Declaring the need here is what makes
    // the composer allocate the texture on tiers whose post chain wants none —
    // which is every tier below high, including the reference hardware's.
    this._applySceneDepthRequirement();
    this._syncSceneDepth();

    this.audio = new Audio(settings);

    this.envMap = this.sky.bakeEnvironment(engine.renderer, this.environment);
    engine.scene.environment = this.envMap;

    this.flight = new FlightModel();
    this._impactEvent = {
      position: new THREE.Vector3(),
      velocity: new THREE.Vector3(),
      normal: new THREE.Vector3(0, 1, 0),
      speed: 0,
      strength: 0,
    };
    this.assist = new AssistController();
    this._controlMode = settings.controlMode === 'direct' ? 'direct' : 'assisted';
    this._assistOptions = {
      sensitivity: settings.controlSensitivity,
      autoThrottle: settings.autoThrottle,
      reconActive: false,
    };
    this._neutralFlightControl = { pitch: 0, roll: 0, yaw: 0, throttle: 0.8, brake: 0 };
    this._touchReconWas = false;
    this.touchControls = null;
    this.chase = new ChaseCamera(engine.camera);
    this.recon = new ReconCamera(engine.camera);
    this.navigationHint = new NavigationHintTracker();
    this._navigationAimWorld = new THREE.Vector3();
    this._navigationCameraSpace = new THREE.Vector3();
    this._navigationNdc = new THREE.Vector3();
    this._navigationToTarget = new THREE.Vector3();
    this._navigationEdgeNdc = new THREE.Vector2();
    this.aircraft = new Aircraft(this.environment);
    this.aircraft.addTo(engine.scene);

    const ui = document.getElementById('ui');
    this.screens = new Screens(ui, {
      onLaunch: () => this.launch(),
      onResume: () => this.resume(),
      onRestart: () => this.restart(),
      onQuality: (tier) => this.setQuality(tier),
      onMasterVolume: (value) => this._setMasterVolume(value),
      onMusicVolume: (value) => this._setMusicVolume(value),
      onControlMode: (value) => this._setControlMode(value),
      onControlSensitivity: (value) => this.settings.setControlSensitivity(value),
      onAutoThrottle: (value) => this.settings.setAutoThrottle(value),
      onVerticalMode: (value) => this.settings.setVerticalMode(value),
    });
    this.screens.setOptions({
      masterVolume: settings.masterVolume,
      musicVolume: settings.musicVolume,
      controlMode: settings.controlMode,
      controlSensitivity: settings.controlSensitivity,
      autoThrottle: settings.autoThrottle,
      verticalMode: settings.verticalMode,
    });
    this.screens.setControlContext({ controlMode: this._controlMode, modality: input.modality });
    this.leaderboard = new Leaderboard();
    this.screens.setLeaderboard({ leaderboard: this.leaderboard });
    this.hud = new Hud(ui);

    this._skipHandlers = new Set();
    this.skipSignal = {
      on: (fn) => this._skipHandlers.add(fn),
      off: (fn) => this._skipHandlers.delete(fn),
    };

    this.reconActive = false;
    this.evaluation = null;
    /** Seconds the current framing has held above the capture threshold. */
    this._autoDwell = 0;
    /** Best score seen during that hold, so the shutter can wait for the peak. */
    this._autoPeak = 0;
    /** Which post the hold belongs to; a different one starts a new hold. */
    this._autoPost = null;
    this.terrainWarning = false;
    /**
     * How far the view has travelled from the chase boom into the nose camera.
     *
     * Recon and chase drive the same PerspectiveCamera, and only one of them
     * used to run per frame. Releasing the recon key therefore rewrote the
     * camera's position, orientation and field of view in a single frame — 31 m
     * of dolly, most of a right angle of rotation and a 17-to-70-degree lens
     * change, all in 8 ms. That is a hard cut, and the game read it as a glitch
     * rather than as an edit. Both rigs now run every frame and this weight
     * blends their poses.
     */
    this._reconBlend = 0;
    this._chasePosition = new THREE.Vector3();
    this._chaseQuaternion = new THREE.Quaternion();
    this._chaseFov = 58;
    this._reconPosition = new THREE.Vector3();
    this._reconQuaternion = new THREE.Quaternion();
    this._postCrashImpulse = 0;
    this._sunWorld = new THREE.Vector3();
    this._sunNdc = new THREE.Vector3();
    this._cameraForward = new THREE.Vector3(0, 0, -1).applyQuaternion(engine.camera.quaternion);
    this._cameraForwardNow = new THREE.Vector3();
    this._cameraDelta = new THREE.Vector3();
    this._cameraRight = new THREE.Vector3();
    this._cameraUp = new THREE.Vector3();
    this._motionInput = {
      airspeed: 0,
      angularX: 0,
      angularY: 0,
      dt: 0,
      flying: false,
      reconActive: false,
      reducedMotion: false,
    };
    this._motionProfile = {
      angularX: 0,
      angularY: 0,
      radialPixels: 0,
      amount: 0,
      edgeStart: 0.45,
      combinedPixels: 0,
    };
    this._motionWasReconActive = false;
    this._reducedMotion = false;
    this._motionMediaQuery = null;
    this._motionMediaListener = null;
    this._installMotionPreference();
    this._installControlLifecycle();
    this._cinematicLook = new THREE.Vector3();
    this._disposed = false;
  }

  async load() {
    this.screens.setProgress(0.1, 'Calibrating flight systems');
    this.flight.reset(this._startPosition(), Math.PI * 0.62, 260);
    this.terrain.prime(this.flight.position);
    this.screens.setProgress(0.35, 'Streaming Himalayan terrain');

    try {
      await this.aircraft.load('./models/mig21.glb', this.envMap);
    } catch (error) {
      // A missing airframe should not take the whole experience down; the world
      // and the mission are still flyable, and the failure is visible.
      console.error('[game] aircraft model failed to load', error);
      // The exhaust is built in Aircraft's constructor, so without this the
      // sortie is flown by a disembodied afterburner.
      this.aircraft.setExhaustVisible(false);
      this.screens.showNotice?.('Aircraft model unavailable — continuing with flight instruments.');
    }
    this.screens.setProgress(0.75, 'Preparing reconnaissance sites');

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
    if (this._controlMode === 'assisted' && !this.settings.assistedNoticeSeen) {
      this.screens.showNotice(
        'Assisted Controls active. Direct mode is available under Pause → Flying.',
        () => this.settings.setAssistedNoticeSeen(true),
        ASSIST_NOTICE_MS,
      );
    }
  }

  /**
   * Tell the engine whether anything in the scene needs composer depth.
   *
   * Everything above phone does. Phone stays off deliberately: the soft-depth
   * define costs a texture fetch on the most fill-bound geometry in the frame,
   * and a depth attachment costs bandwidth that tier does not have to spare.
   */
  _applySceneDepthRequirement() {
    this.engine.setSceneDepthRequired(this.settings.tier.name !== 'phone');
  }

  /**
   * Re-read the composer's depth texture and push it to every scene consumer.
   *
   * The composer allocates this in applySettings — after Game's constructor —
   * and swaps it whenever a depth-reading pass is added or removed, so it has
   * to be re-read rather than bound once. setSceneDepth() matters most: it
   * compiles FX_SOFT_DEPTH into every registered FX material, and because it
   * was called exactly once from the constructor it always compiled against a
   * null texture. Every particle system and ribbon spent the whole session with
   * hard edges against the world.
   */
  _syncSceneDepth() {
    const depth = this.engine.composer.stableDepthTexture;
    if (depth === this._sceneDepthTexture) return;
    this._sceneDepthTexture = depth;
    this.cloudField.setDepthTexture(depth);
    this.clouds.setDepthTexture(depth);
    setSceneDepth(depth, this._waterDrawingSize.x, this._waterDrawingSize.y);
  }

  _startPosition() {
    const { x, z } = this.sortie?.origin ?? { x: FALLBACK_ORIGIN.x, z: FALLBACK_ORIGIN.z };
    const p = new THREE.Vector3(x, 0, z);
    p.y = terrainHeight(p.x, p.z) + 1500;
    return p;
  }

  _setupCinematic() {
    const { x, z } = this.sortie?.origin ?? { x: FALLBACK_ORIGIN.x, z: FALLBACK_ORIGIN.z };
    this.cinematicCentre = new THREE.Vector3(x, 0, z);
    this.cinematicCentre.y = terrainHeight(x, z) + 2100;
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
    const look = this._cinematicLook.copy(this.cinematicCentre);
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
    this.navigationHint?.reset();
    this._resetFlightControls(true);
    this.screens.hideAll();
    this.flight.reset(this._startPosition(), Math.PI * 0.62, 260);
    this.chase.reset(this.flight);
    this.reconActive = false;
    this._reconBlend = 0;
    this._resetMotionBaseline();
    this.terrain.prime(this.flight.position);
    this.fx.reset();
    this.fx.resetImpact?.();
    this.aircraft?.setCrashPresentation?.(false);
    // Launch is always reached through a gesture (click or key), which is what
    // browsers require to create an AudioContext. Starting audio here rather
    // than relying on a prior keypress fixes a mouse-only launch, where the
    // context did not exist yet so the sortie cue was simply dropped and the
    // score never played for that flight.
    this.audio.start();
    this.audio.resume();
    this.audio.resetEngine();
    this.audio.music?.play('sortie');
    this.mission.begin();
    this.hud.show(true);
    this.state = 'flying';
    this.engine.camera.fov = this.chase.baseFov;
    this.engine.camera.updateProjectionMatrix();
  }

  restart() {
    this.navigationHint?.reset();
    for (const post of this.mission.posts) {
      if (!post.photo) continue;
      this.recon.releaseShot(post.photo);
      post.photo = null;
    }
    // Pick the sortie up again, in case the day turned over while the tab sat
    // on the debrief. An explicit ?seed keeps its sortie forever, which is the
    // point of pinning one.
    const next = sortieParams(resolveSeed(globalThis.location?.search ?? ''));
    if (next.seed !== this.sortie.seed) {
      this.sortie = next;
      this.environment.setSun(next.sunElevationDeg, next.sunAzimuthDeg);
      this.environment.uniforms.uCloudCoverage.value = next.cloudCoverage;
      this.terrain.prime(this._startPosition());
    }
    this.mission.dispose();
    this.mission = new Mission(this.engine.scene, this._startPosition(), 5);
    this.screens.setTargets(this.mission.posts);
    this.hud.setObjectiveCount(this.mission.posts.length);
    this.launch();
  }

  pause() {
    if (this.state !== 'flying') return;
    this._resetFlightControls();
    this.state = 'paused';
    this.hud.show(false);
    this.screens.show(this.screens.pauseLayer);
    // Nothing drives the flight bed while paused, so without this the engine
    // holds its last gain and the menu theme plays over a frozen afterburner.
    this.audio?.quietFlightBed?.(0.5);
  }

  resume() {
    if (this.state !== 'paused') return;
    this.state = 'flying';
    this.screens.hideAll();
    this.hud.show(true);
    // Pausing handed the score to the menu theme; unpausing has to hand it back,
    // because nothing else on the flying path ever calls play() again.
    this.audio.music?.play('sortie');
  }

  setQuality(tier) {
    const previousResolution = this.terrainResolution;
    this.settings.setTier(tier);
    this.engine.applySettings();
    // The new tier's post chain may want depth where the old one did not, or
    // the other way round; either way the scene's own need is unchanged and has
    // to be re-asserted before anything reads the texture.
    this._applySceneDepthRequirement();
    this._syncSceneDepth();
    if (this.settings.tier.terrainRes !== previousResolution) {
      this._rebuildTerrain(this.settings.tier.terrainRes, previousResolution);
    } else {
      this.terrain.setQuality(this.settings.tier);
    }
    this.water.setQuality(this.settings.tier.name);
    if (tier === 'low' || tier === 'phone') this._disposeWaterRefraction();
    this.fx.setQuality(this.settings.tier);
    this.cloudField.setQuality(this.settings.tier);
    this.clouds.setQuality(this.settings.tier);
    this.screens.setQuality(tier);
  }

  /** Attach touch UI after Game construction without coupling boot order. */
  setTouchControls(touchControls) {
    this.touchControls = touchControls ?? null;
    this.touchControls?.setMode?.(this._controlMode);
  }

  /** Apply a settings mode change once, clearing every held cross-mode input. */
  _syncControlMode() {
    const nextMode = this.settings.controlMode === 'direct' ? 'direct' : 'assisted';
    if (nextMode === this._controlMode) return;
    this._controlMode = nextMode;
    this._resetFlightControls();
    this.touchControls?.setMode?.(nextMode);
  }

  _resetFlightControls(forLaunch = false) {
    if (forLaunch && this.input?.resetForLaunch) this.input.resetForLaunch();
    else if (this.input?.releaseAll) this.input.releaseAll();
    else this.input?.releaseTouch?.();
    this.assist?.reset?.();
    this.accumulator = 0;
    this.reconActive = false;
    this._touchReconWas = false;
  }

  _installControlLifecycle(target = globalThis.window, visibilityTarget = globalThis.document) {
    this._disposeControlLifecycle();
    this._onControlBlur = () => this._resetFlightControls();
    this._onControlVisibility = () => {
      const hidden = Boolean(visibilityTarget?.hidden);
      if (hidden) this._resetFlightControls();
      // The frame loop stops when the tab hides, so every continuous audio bed
      // would otherwise hold its last gain forever.
      this.audio?.setHidden(hidden);
    };
    if (target?.addEventListener) {
      this._controlLifecycleTarget = target;
      target.addEventListener('blur', this._onControlBlur);
    }
    if (visibilityTarget?.addEventListener) {
      this._controlVisibilityTarget = visibilityTarget;
      visibilityTarget.addEventListener('visibilitychange', this._onControlVisibility);
    }
  }

  _disposeControlLifecycle() {
    if (this._controlLifecycleTarget && this._onControlBlur) {
      this._controlLifecycleTarget.removeEventListener?.('blur', this._onControlBlur);
    }
    if (this._controlVisibilityTarget && this._onControlVisibility) {
      this._controlVisibilityTarget.removeEventListener?.('visibilitychange', this._onControlVisibility);
    }
    this._controlLifecycleTarget = null;
    this._controlVisibilityTarget = null;
    this._onControlBlur = null;
    this._onControlVisibility = null;
  }

  _updateReconMode() {
    if (this._controlMode === 'assisted') {
      const touchRecon = Boolean(this.input.touchRecon);
      const touchEdge = this.input.modality === 'touch' && touchRecon !== Boolean(this._touchReconWas);
      const pressed = this.input.consumePress('Space');
      if (pressed || touchEdge) this.reconActive = !this.reconActive;
      this._touchReconWas = touchRecon;
    } else {
      this.reconActive = Boolean(this.input.reconHeld);
      this._touchReconWas = Boolean(this.input.touchRecon);
    }
  }

  _flightControlForStep(step) {
    if (this._controlMode === 'direct') return this.input;
    const options = this._assistOptions;
    options.sensitivity = this.settings.controlSensitivity;
    options.autoThrottle = this.settings.autoThrottle;
    options.reconActive = this.reconActive;
    const control = this.assist.update(step, this.input.intent, this.flight, options);
    return isFiniteFlightControl(control) ? control : this._neutralFlightControl;
  }

  _rebuildTerrain(resolution, previousResolution = this.terrainResolution) {
    const oldTerrain = this.terrain;
    let replacement = null;
    try {
      configureTerrain({ res: resolution });
      replacement = new Terrain(this.engine.renderer, this.environment);
      replacement.setQuality(this.settings.tier);
      const focus = this.state === 'flying' ? this.flight.position : this.engine.camera.position;
      replacement.prime(focus);
      this.engine.scene.add(replacement.group);
      this.engine.scene.remove(oldTerrain.group);
      this.terrain = replacement;
      this.terrainResolution = resolution;
      oldTerrain.dispose();
      return true;
    } catch (error) {
      replacement?.group?.removeFromParent();
      replacement?.dispose?.();
      configureTerrain({ res: previousResolution });
      console.error('[game] terrain quality rebuild failed', error);
      this.screens.showNotice?.('Terrain quality could not be changed on this device.');
      return false;
    }
  }

  _setMasterVolume(value) {
    this.settings.setMasterVolume(value);
    this.audio.setVolume(this.settings.masterVolume);
  }

  _setMusicVolume(value) {
    this.settings.setMusicVolume(value);
    this.audio.music?.setVolume(this.settings.musicVolume);
  }

  _setControlMode(value) {
    this.settings.setControlMode(value);
    this._syncControlMode();
    this.screens.setOptions({ controlMode: this._controlMode });
    this.screens.setControlContext({
      controlMode: this._controlMode,
      modality: this.input.modality,
    });
  }

  _finish(success) {
    this.state = success ? 'complete' : 'failed';
    // Before the cue, not after: endSortie reopens the cabin filter the last
    // manoeuvre may have closed, and the closing cue is the thing it would
    // otherwise be muffling.
    this.audio.endSortie?.();
    this.audio.music?.play(success ? 'return' : 'loss');
    this.hud.show(false);
    this.reconActive = false;
    // The debrief holds whatever pose the camera had, but the blend must not
    // survive into the next sortie: a retry that resumed at 0.7 would open on a
    // half-telephoto view of the start position.
    this._reconBlend = 0;
    this.screens.showDebrief(this.mission, success);
  }

  update(dt) {
    const input = this.input;
    input.update(dt, this.settings.verticalMode);
    this._syncControlMode();
    this.screens.setControlContext({ controlMode: this._controlMode, modality: input.modality });

    // Browsers require a gesture before audio can start, so the first key press
    // of the session is what brings the engine up.
    if (input.anyPress() || input.keys.size) {
      this.audio.start();
      this.audio.resume();
    }

    // The menu theme owns every screen the player is sitting still on. Every
    // other state already books its own cue, and Music.play is a no-op for the
    // cue that is already running, so this costs a Set lookup on all but the
    // one frame that actually changes screen.
    if (MENU_MUSIC_STATES.has(this.state)) this.audio.music?.play('menu');

    if (this.state === 'title' && input.anyPress()) {
      for (const fn of [...this._skipHandlers]) fn();
      input.clearPresses();
    }

    if (input.consumePress('Escape')) {
      if (this.state === 'flying') this.pause();
      else if (this.state === 'paused') this.resume();
    }

    // See acceptsLaunchKey: Enter is also the shutter, so a debrief must not
    // accept it. Restart stays on the debrief's own button.
    if (acceptsLaunchKey(this.state) && input.consumePress('Enter')) {
      this.launch();
    }

    switch (this.state) {
      case 'title':
      case 'briefing':
        this._updateCinematic(dt);
        this.terrain.update(this.engine.camera.position, this.settings.tier.terrainBudget);
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
    // The volume is shadow-only now, so nothing in the post chain drives it;
    // the terrain still needs its stripe refreshed every frame.
    this.clouds.update(this.engine.renderer, null, dt);
    this._syncSceneDepth();
    this.cloudField.update();
    this._updateWaterRefraction(dt);
    this._updatePostEffects(dt);
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
      this._updateReconMode();
    } else {
      this.reconActive = false;
    }

    this.accumulator += dt;
    let steps = 0;
    while (this.accumulator >= PHYSICS_STEP && steps < MAX_STEPS) {
      flight.update(PHYSICS_STEP, this._flightControlForStep(PHYSICS_STEP));
      if (!flight.crashed && flight.checkTerrainCollision(PHYSICS_STEP)) {
        this.onCrash();
      }
      this.accumulator -= PHYSICS_STEP;
      steps++;
    }
    if (steps === MAX_STEPS) this.accumulator = 0;
    // What the flight model actually integrated, which is less than `dt` once
    // the step cap bites. The sortie clock is ranked, so it follows this.
    const simDt = steps * PHYSICS_STEP;

    this.aircraft.update(dt, flight);
    this.mission.update(dt, flight.position, simDt);

    // Terrain proximity, measured against the ground actually ahead.
    //
    // This used to divide AGL by descent rate, which sounds like closure and is
    // not: flying level at a wall of rock has a descent rate of zero, so the
    // expression pinned to AGL / 1 and only warned below about 7 m — long past
    // the point of being useful, and never at all in the case that matters
    // most. Sampling the highest ground along the projected path catches rising
    // terrain while there is still room to pull.
    // Deliberately *not* a function of current altitude. Flying a valley at
    // 200 m is the fantasy this game is built around, and gating on AGL lit the
    // warning permanently through ordinary low-level flight — measured at 100%
    // of samples over a level run at 230 m, which trains the player to ignore
    // it. What matters is whether the path ahead still clears the ground on it.
    const look = 7.5; // seconds of flight path
    const aheadX = flight.position.x + flight.velocity.x * look;
    const aheadZ = flight.position.z + flight.velocity.z * look;
    const ridge = maxHeightAlong(flight.position.x, flight.position.z, aheadX, aheadZ, 10);
    const projectedClearance = flight.position.y + flight.velocity.y * look - ridge;
    this.terrainWarning = !flight.crashed && projectedClearance < 120;

    this._updateCameraRig(dt, flight);

    // Surface detail has to survive the optic. See Terrain.setZoomScale.
    const halfFov = THREE.MathUtils.degToRad(this.engine.camera.fov) * 0.5;
    this.terrain.setZoomScale(
      Math.tan(THREE.MathUtils.degToRad(this.chase.baseFov) * 0.5) / Math.tan(halfFov),
    );
    this.terrain.update(this._terrainFocus(flight), this.settings.tier.terrainBudget);
    // aircraft.update ran above, so the nozzle it publishes is this frame's.
    this.fx.update(dt, flight, this.engine.camera.position, this.engine.camera, this.aircraft);

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

  /**
   * Where the terrain clipmap should put its finest levels.
   *
   * Normally that is the aircraft. Under the recon camera it is not: the optic
   * narrows the field of view to as little as 8.5 degrees, which magnifies the
   * ground being photographed by up to seven times, and the clipmap chooses its
   * levels by world distance alone. A level-3 cell is 32 m, so at a 3 km
   * stand-off it lands on nearly fifty screen pixels and the target ridge reads
   * as flat triangles — in the one shot the whole mission exists to take.
   *
   * Sliding the clipmap centre toward the aim point puts levels 0-2 on the
   * ground in frame. Nothing about gameplay depends on where the centre is —
   * collision, scoring and post placement all run on the JS heightfield mirror,
   * not on the clipmap — and the aircraft's own surroundings are off-frame
   * while the optic is up. The shift follows the transition weight, so the
   * regeneration is spread across the same frames as the camera move.
   */
  _terrainFocus(flight) {
    if (this._reconBlend <= 0) return flight.position;
    const focus = this._terrainFocusPoint ?? (this._terrainFocusPoint = new THREE.Vector3());
    const axis = this._terrainFocusAxis ?? (this._terrainFocusAxis = new THREE.Vector3());
    // The blended camera's own axis, so the fine levels follow what is on
    // screen rather than where the airframe happens to point.
    this.engine.camera.getWorldDirection(axis);
    // Roughly where the optical axis meets the ground, clamped so a shallow
    // look-ahead cannot throw the centre kilometres down a valley.
    const reach = THREE.MathUtils.clamp(flight.agl * 4.2, 400, 2600);
    focus.copy(flight.position).addScaledVector(axis, reach);
    return focus.lerp(flight.position, 1 - smootherstep(this._reconBlend));
  }

  /**
   * Drive both camera rigs and blend the view between them.
   *
   * Order matters. The chase runs first so that its exponential smoothing keeps
   * integrating while recon is up — parked, it would resume from a `lookAt`
   * point tens of seconds stale and whip across the valley on release. Recon
   * runs second and its *pure* pose is what evaluate() and capture() see, so
   * scoring and the photographic plate are never taken through a half-finished
   * transition. Only the displayed camera is blended.
   *
   * Entry is quicker than exit: the player pressed a key and wants the optic,
   * whereas coming back out reads better as the view settling than as a snap.
   */
  _updateCameraRig(dt, flight) {
    const camera = this.engine.camera;
    const settled = this._reconBlend <= 0 && !this.reconActive;

    this.chase.update(dt, flight, flight.crashed ? 0.85 : 0);

    if (settled) {
      this.evaluation = null;
      return;
    }

    this._chasePosition.copy(camera.position);
    this._chaseQuaternion.copy(camera.quaternion);
    this._chaseFov = camera.fov;

    this.recon.update(dt, flight);
    this._reconPosition.copy(camera.position);
    this._reconQuaternion.copy(camera.quaternion);
    const reconFov = camera.fov;

    if (this.reconActive) {
      this.evaluation = this._evaluateBest();
      this._updateAutoCapture(dt);
    } else {
      this.evaluation = null;
      this._autoDwell = 0;
      this._autoPeak = 0;
      this._autoPost = null;
    }

    const target = this.reconActive ? 1 : 0;
    const seconds = this.reconActive ? RECON_ENTER_SECONDS : RECON_EXIT_SECONDS;
    const step = dt / seconds;
    this._reconBlend = target > this._reconBlend
      ? Math.min(target, this._reconBlend + step)
      : Math.max(target, this._reconBlend - step);

    const w = smootherstep(this._reconBlend);
    camera.position.copy(this._chasePosition).lerp(this._reconPosition, w);
    camera.quaternion.copy(this._chaseQuaternion).slerp(this._reconQuaternion, w);
    // Field of view interpolates geometrically, not linearly. A lens racking
    // from 70 to 17 degrees covers equal *ratios* in equal time; a linear ramp
    // spends most of its run near the wide end and then lurches.
    const fov = this._chaseFov * (reconFov / this._chaseFov) ** w;
    if (Math.abs(camera.fov - fov) > 0.005) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }
    camera.updateMatrixWorld();
  }

  /**
   * How the aircraft is being flown, for the energy term of the plate score.
   *
   * A photograph is now partly a record of the pass that took it, so the score
   * needs the same speed and ground clearance the HUD is showing.
   */
  _flightStateForScoring() {
    const p = this.flight.position;
    return {
      speed: this.flight.velocity.length(),
      agl: p.y - terrainHeight(p.x, p.z),
    };
  }

  /** The post the camera is best placed to photograph right now. */
  _evaluateBest() {
    let best = null;
    const flightState = this._flightStateForScoring();
    for (const post of this.mission.posts) {
      // A post already in the bag must not compete for the shot. Leaving them
      // in meant flying past a captured site while lining up the next one
      // handed the overlay to the wrong target and re-fired the capture
      // confirmation on a post that was finished several minutes ago.
      if (post.captured) continue;
      const ev = this.recon.evaluate(post, flightState);
      if (!ev.inFrame) continue;
      // First unobstructed sighting confirms the position, and the HUD switches
      // from a sector and a range band to the precise solution. See
      // acquisition.js — the briefing's "positions are unconfirmed" was never
      // true of the instrument.
      if (!post.acquired && ev.visibility > 0 && ev.score >= ACQUISITION_SCORE) {
        post.acquired = true;
        this.screens.showNotice?.(`${post.callsign} ACQUIRED — POSITION CONFIRMED`);
      }
      if (!best || ev.score > best.score) best = ev;
    }
    // Fall back to the steering target so the overlay can explain itself even
    // when nothing is framed.
    if (!best && this.mission.target) return this.recon.evaluate(this.mission.target, flightState);
    return best;
  }

  /**
   * Work the shutter for the pilot.
   *
   * Flying the aircraft, holding a 17-degree lens on a ridge and finding Enter
   * at the same moment is three jobs; the camera can do the third. It arms once
   * the framing would actually secure the site and then waits for the *peak*
   * rather than firing on the first crossing, because `_evaluateBest` drops a
   * post the instant it is secured — auto-capture gets exactly one plate per
   * site, and grabbing it the moment the score grazes CAPTURE_THRESHOLD would
   * fill the contact sheet with USABLE where a pilot flying the same line by
   * hand would have held two beats longer and come away with EXCELLENT.
   *
   * So: hold while the score is still climbing, and release when it turns over,
   * tops out, or has simply been steady long enough that this framing is
   * plainly the best on offer. Enter still fires immediately, which is the only
   * way to keep a deliberately weak frame for the contact sheet.
   */
  _updateAutoCapture(dt) {
    const ev = this.evaluation;
    // Consumed unconditionally: a press during the shutter cooldown has to be
    // spent, not buffered into a capture on some later frame.
    const manual = this.input.consumePress('Enter');

    // The hold belongs to one site, not to the camera. _evaluateBest can swap
    // which post is being scored between frames — a second site coming into
    // frame, or the current one being secured — and without this the new post
    // inherits the previous one's banked dwell and peak: it would be
    // photographed after a single frame of framing, at a score that was never
    // its own peak, which is the exact failure the peak-seeking exists to stop.
    const post = ev?.post ?? null;
    if (post !== this._autoPost) {
      this._autoPost = post;
      this._autoDwell = 0;
      this._autoPeak = 0;
    }

    const locked = Boolean(ev) && ev.inFrame && !ev.post.captured && ev.score >= CAPTURE_THRESHOLD;
    if (locked) {
      this._autoDwell += dt;
      this._autoPeak = Math.max(this._autoPeak, ev.score);
    } else {
      this._autoDwell = 0;
      this._autoPeak = 0;
    }

    if (this.recon.shutterCooldown > 0) return;
    if (manual) {
      // The manual shutter may re-shoot a position that is already secured.
      // Auto-capture deliberately will not — captured posts stay out of
      // _evaluateBest so that flying past a finished site while lining up the
      // next one cannot steal the overlay — but a pilot who thinks they can do
      // better than one auto-fired frame should be allowed to try, and
      // _takePhoto only replaces the plate when the new score actually beats
      // the stored one.
      const shot = ev ?? this._evaluateSecured();
      if (shot) this._fireShutter(shot);
      return;
    }
    if (!ev) return;
    if (!locked || this._autoDwell < AUTO_CAPTURE_MIN_DWELL) return;

    const turnedOver = ev.score <= this._autoPeak - AUTO_CAPTURE_FALLOFF;
    const topped = ev.score >= AUTO_CAPTURE_CEILING;
    if (turnedOver || topped || this._autoDwell >= AUTO_CAPTURE_MAX_DWELL) this._fireShutter(ev);
  }

  /**
   * The best framed position among those already secured.
   *
   * Only consulted by the manual shutter, so re-shooting stays an explicit act.
   */
  _evaluateSecured() {
    let best = null;
    const flightState = this._flightStateForScoring();
    for (const post of this.mission.posts) {
      if (!post.captured) continue;
      const ev = this.recon.evaluate(post, flightState);
      if (!ev.inFrame) continue;
      if (!best || ev.score > best.score) best = ev;
    }
    return best;
  }

  _fireShutter(evaluation) {
    this._takePhoto(evaluation);
    this._autoDwell = 0;
    this._autoPeak = 0;
    this._autoPost = null;
  }

  _takePhoto(evaluation) {
    // Capture can happen on the same update that opens recon. The post stack
    // has not reached its end-of-frame update yet, so explicitly clear the
    // prior chase blur before ReconCamera renders the plate.
    this._disableMotionBlur();
    const shot = this.recon.capture(this.engine, evaluation);
    this.mission.photosTaken++;

    const post = evaluation.post;
    const improved = evaluation.score > post.bestScore;
    if (improved) {
      const replacing = post.captured && Boolean(post.photo);
      if (post.photo) this.recon.releaseShot(post.photo);
      post.bestScore = evaluation.score;
      post.photo = shot;
      this.recon.retainShot(shot);
      // Say so when a re-shoot actually beat the stored plate, or the player
      // has no way to know whether the second run was worth flying.
      if (replacing) {
        this.screens.showNotice?.(`${post.callsign} — IMAGERY IMPROVED`);
      }
    }
    // Fire the confirmation on the *transition*, not on the state. Testing
    // post.captured after the fact replayed the objective-secured cue on every
    // subsequent photo of the same site.
    const secured = evaluation.score >= CAPTURE_THRESHOLD && !post.captured;
    if (secured) post.captured = true;

    this.hud.showPhoto(post, shot);
    this.audio.shutter();
    if (secured) this.audio.confirm();
  }

  onCrash() {
    this.crashTimer = 0;
    this.mission.fail('terrain');
    const strength = Math.min(1, this.flight.impactSpeed / 320);
    const impact = this._impactEvent;
    impact.position.copy(this.flight.impactPoint);
    impact.velocity.copy(this.flight.impactVelocity);
    impact.normal.copy(this.flight.impactNormal);
    impact.speed = this.flight.impactSpeed;
    impact.strength = strength;
    this.fx.crash(impact);
    this.aircraft.setCrashPresentation(true);
    this._postCrashImpulse = Math.max(this._postCrashImpulse, 0.5 + strength * 0.5);
    this.audio.impact(strength);
  }

  _updateWaterRefraction(dt) {
    const camera = this.engine.camera;
    this.water.update(dt, camera);
    this.engine.renderer.getDrawingBufferSize(this._waterDrawingSize);
    setFxResolution(this._waterDrawingSize.x, this._waterDrawingSize.y);
    const tier = this.settings.tier.name;
    if (tier !== 'high' && tier !== 'medium') {
      this.water.clearRefractionSource();
      return;
    }
    if (!this._waterBatchInView(camera)) {
      this.water.clearRefractionSource();
      return;
    }

    const dimensions = waterRefractionSize(
      this._waterDrawingSize.x,
      this._waterDrawingSize.y,
      tier,
      this._waterRefractionDimensions,
    );
    const width = dimensions[0];
    const height = dimensions[1];
    const textureType = waterRefractionType(this.engine.renderer, tier);
    let target = this._waterRefractionTarget;
    if (target && target.texture.type !== textureType) {
      target.dispose();
      target = null;
      this._waterRefractionTarget = null;
    }
    if (!target) {
      target = new THREE.WebGLRenderTarget(width, height, {
        format: THREE.RGBAFormat,
        type: textureType,
        internalFormat: textureType === THREE.HalfFloatType ? 'RGBA16F' : null,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        depthBuffer: true,
        stencilBuffer: false,
      });
      target.texture.name = 'water-refraction-color';
      target.depthTexture = new THREE.DepthTexture(width, height, THREE.UnsignedIntType);
      target.depthTexture.name = 'water-refraction-depth';
      this._waterRefractionTarget = target;
    } else if (target.width !== width || target.height !== height) {
      target.setSize(width, height);
    }

    this.engine.renderSceneToTarget(target, this.engine.scene, camera, this.water);
    const source = this._waterRefractionSource;
    source.colorTexture = target.texture;
    source.depthTexture = target.depthTexture;
    source.width = width;
    source.height = height;
    source.near = camera.near;
    source.far = camera.far;
    this.water.setRefractionSource(source);
  }

  /** Frustum-test the exact accepted lake batch with reusable scratch state. */
  _waterBatchInView(camera) {
    const water = this.water;
    const field = water?.field;
    const count = Math.min(
      water?.visibleLakeCount ?? 0,
      field?.activeCount ?? 0,
      field?.active?.length ?? 0,
    );
    if (!water?.visible || count <= 0) return false;

    this._waterViewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this._waterFrustum.setFromProjectionMatrix(this._waterViewProjection);
    const bounds = this._waterLakeBounds;
    for (let i = 0; i < count; i++) {
      const lake = field.active[i];
      if (!lake) continue;
      bounds.center.set(lake.x, lake.level, lake.z);
      // rMax encloses the accepted shoreline. The extra margin conservatively
      // covers vertical displacement without admitting behind-camera lakes.
      bounds.radius = Math.max(lake.rMax ?? lake.rMean ?? 1, 1) + 16;
      if (this._waterFrustum.intersectsSphere(bounds)) return true;
    }
    return false;
  }

  _disposeWaterRefraction() {
    this.water?.clearRefractionSource();
    this._waterRefractionTarget?.dispose();
    this._waterRefractionTarget = null;
    if (this._waterRefractionSource) {
      this._waterRefractionSource.colorTexture = null;
      this._waterRefractionSource.depthTexture = null;
    }
  }

  _updatePostEffects(dt) {
    const camera = this.engine.camera;
    camera.getWorldDirection(this._cameraForwardNow);

    this._sunWorld.copy(camera.position).addScaledVector(this.environment.sunDir, 100000);
    this._sunNdc.copy(this._sunWorld).project(camera);
    const sunFacing = THREE.MathUtils.smoothstep(
      this._cameraForwardNow.dot(this.environment.sunDir),
      -0.02,
      0.18,
    );
    const sunOnScreen = Math.abs(this._sunNdc.x) < 1.12 &&
      Math.abs(this._sunNdc.y) < 1.12 && this._sunNdc.z >= -1 && this._sunNdc.z <= 1;
    const sunVisibility = sunOnScreen ? sunFacing : 0;
    this.engine.setSunScreenPosition(
      this._sunNdc.x * 0.5 + 0.5,
      this._sunNdc.y * 0.5 + 0.5,
      sunVisibility,
    );

    this._cameraDelta.subVectors(this._cameraForwardNow, this._cameraForward);
    this._cameraRight.set(1, 0, 0).applyQuaternion(camera.quaternion);
    this._cameraUp.set(0, 1, 0).applyQuaternion(camera.quaternion);
    // The release frame used to need its angular velocity discarded, because
    // recon and chase were a hard cut and the measured delta was most of a right
    // angle in one frame — which the blur read as a whip pan. The transition is
    // now a bounded eased move, so the delta it produces is real camera motion
    // and blurring it is the correct answer rather than an artifact.
    const motionInput = this._motionInput ?? (this._motionInput = {});
    motionInput.airspeed = this.flight.airspeed;
    motionInput.angularX = this._cameraDelta.dot(this._cameraRight);
    motionInput.angularY = this._cameraDelta.dot(this._cameraUp);
    motionInput.dt = dt;
    motionInput.flying = this.state === 'flying';
    motionInput.reconActive = Boolean(this.reconActive);
    motionInput.reducedMotion = Boolean(this._reducedMotion || this.chase?.reducedMotion);
    const motionProfile = computeMotionProfile(
      motionInput,
      this._motionProfile ?? (this._motionProfile = {}),
    );
    const speedMotion = this.state === 'flying'
      ? THREE.MathUtils.clamp((this.flight.airspeed - 160) / 360, 0, 1) * 0.18
      : 0;
    // Radial streaks converge on where the aircraft is going, not on the middle
    // of the screen. Projecting a point well ahead along the velocity vector
    // gives the vanishing point directly.
    const velocity = this.flight?.velocity;
    if (velocity && velocity.lengthSq() > 1) {
      _motionNdc.copy(this.flight.position).addScaledVector(velocity, 60);
      _motionNdc.project(this.engine.camera);
      motionProfile.opticalCenter = {
        x: _motionNdc.x * 0.5 + 0.5,
        y: 0.5 - _motionNdc.y * 0.5,
      };
    }
    this.engine.setMotionBlur(motionProfile);

    const reheat = this.state === 'flying'
      ? THREE.MathUtils.clamp(
        (this.flight.throttleSmoothed - REHEAT_THRESHOLD) / (1 - REHEAT_THRESHOLD), 0, 1)
      : 0;
    const crashHeat = this._postCrashImpulse * 0.34 * (this._reducedMotion ? 0.2 : 1);
    // Project the nozzle so the shimmer sits on the exhaust rather than on a
    // fixed point in the frame. The airframe can legitimately be absent — a
    // failed model load is survivable — in which case the effect keeps its
    // previous centre.
    let heatCentre = null;
    const nozzle = this.aircraft?.nozzlePosition;
    if (nozzle) {
      _heatNdc.copy(nozzle).project(this.engine.camera);
      heatCentre = { x: _heatNdc.x * 0.5 + 0.5, y: 0.5 - _heatNdc.y * 0.5 };
    }
    this.engine.setHeatDistortion(Math.min(0.72, reheat * 0.38 + crashHeat), heatCentre);
    this.engine.setLensArtifacts(
      0.055 + sunVisibility * 0.12,
      0.055 + sunVisibility * 0.075 + speedMotion * 0.08,
    );

    this._postCrashImpulse *= Math.exp(-dt * 2.3);
    if (this._postCrashImpulse < 0.001) this._postCrashImpulse = 0;
    this._cameraForward.copy(this._cameraForwardNow);
    this._motionWasReconActive = Boolean(this.reconActive);
  }

  _disableMotionBlur() {
    const profile = this._motionProfile ?? (this._motionProfile = {});
    profile.angularX = 0;
    profile.angularY = 0;
    profile.radialPixels = 0;
    profile.amount = 0;
    profile.edgeStart = 0.45;
    profile.combinedPixels = 0;
    this.engine?.setMotionBlur?.(profile);
  }

  _resetMotionBaseline() {
    const forward = this._cameraForward ?? (this._cameraForward = new THREE.Vector3());
    this.engine?.camera?.getWorldDirection?.(forward);
    this._motionWasReconActive = Boolean(this.reconActive);
    this._disableMotionBlur();
  }

  _installMotionPreference() {
    this._disposeMotionPreference();
    const query = window.matchMedia?.('(prefers-reduced-motion: reduce)') ?? null;
    this._motionMediaQuery = query;
    this._reducedMotion = Boolean(query?.matches);
    this.chase?.setReducedMotion?.(this._reducedMotion);
    if (!query) return;
    this._motionMediaListener = (event) => {
      this._reducedMotion = Boolean(event.matches);
      this.chase?.setReducedMotion?.(this._reducedMotion);
      if (this._reducedMotion) this._disableMotionBlur();
    };
    if (query.addEventListener) query.addEventListener('change', this._motionMediaListener);
    else query.addListener?.(this._motionMediaListener);
  }

  _disposeMotionPreference() {
    const query = this._motionMediaQuery;
    const listener = this._motionMediaListener;
    if (query && listener) {
      if (query.removeEventListener) query.removeEventListener('change', listener);
      else query.removeListener?.(listener);
    }
    this._motionMediaQuery = null;
    this._motionMediaListener = null;
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this._disposeMotionPreference();
    this._disposeControlLifecycle();
    this._resetFlightControls();
    this.navigationHint?.reset();
    this._disposeWaterRefraction();
    this.mission?.dispose?.();
    this.recon?.dispose?.();
    this.aircraft?.dispose?.();
    this.fx?.dispose?.();
    this.water?.removeFromParent();
    this.water?.dispose?.();
    this.terrain?.group?.removeFromParent();
    this.terrain?.dispose?.();
    this.sky?.mesh?.removeFromParent();
    this.sky?.dispose?.();
    this.engine.setClouds?.(null);
    this.cloudField?.mesh?.removeFromParent();
    this.cloudField?.dispose?.();
    this.clouds?.dispose?.();
    if (this.engine.scene.environment === this.envMap) this.engine.scene.environment = null;
    this.environment?.dispose?.();
    this.screens?.dispose?.();
    this.hud?.dispose?.();
    this.audio?.dispose?.();
    this._skipHandlers?.clear?.();
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
    // The score reads the same range the navigation cue does, so the music
    // tightens on exactly the approach the HUD is calling.
    this.audio.setTension(range, Boolean(target));

    const euler = _euler.setFromQuaternion(flight.orientation, 'YXZ');
    const heading = (-euler.y * 180) / Math.PI;

    let navigation;
    if (!target) {
      navigation = this.navigationHint.update({ complete: true });
    } else {
      const camera = this.engine.camera;
      const aimPoint = this._navigationAimWorld.copy(target.aimPoint);
      const cameraSpace = this._navigationCameraSpace
        .copy(aimPoint)
        .applyMatrix4(camera.matrixWorldInverse);
      const projectedNdc = this._navigationNdc.copy(aimPoint).project(camera);
      const inFront = cameraSpace.z < 0;
      const onScreen = inFront
        && projectedNdc.z >= -1 && projectedNdc.z <= 1
        && Math.abs(projectedNdc.x) <= 1 && Math.abs(projectedNdc.y) <= 1;

      let edgeNdc = null;
      if (inFront) {
        const edgeScale = Math.max(Math.abs(projectedNdc.x), Math.abs(projectedNdc.y));
        if (edgeScale > 1e-6) {
          this._navigationEdgeNdc.set(projectedNdc.x / edgeScale, projectedNdc.y / edgeScale);
        } else {
          this._navigationEdgeNdc.set(0, -1);
        }
        edgeNdc = this._navigationEdgeNdc;
      }

      const toTarget = this._navigationToTarget.subVectors(aimPoint, flight.position);
      const targetDistance = toTarget.length();
      const closingSpeed = targetDistance > 1e-6
        ? flight.velocity.dot(toTarget) / targetDistance
        : 0;
      const visibility = range <= 3000
        ? terrainVisibility(camera.position, aimPoint)
        : 1;

      navigation = this.navigationHint.update({
        targetId: target.id,
        rangeMetres: range,
        headingDeg: heading,
        targetBearingDeg: bearing,
        closingSpeed,
        altitudeDeltaMetres: aimPoint.y - flight.position.y,
        projected: onScreen ? projectedNdc : null,
        edgeNdc,
        terrainVisibility: visibility,
        reconActive: this.reconActive,
        reconFramed: Boolean(this.evaluation?.post === target && this.evaluation.inFrame),
        dt,
      });
    }

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
      // Height above the ground below, not above sea level. In a game whose
      // whole threat model is terrain, this was the one number the pilot could
      // not see — it existed only in the ?debug panel while the altitude tape
      // showed 5,677 at 300 m over a ridge.
      agl: flight.position.y - terrainHeight(flight.position.x, flight.position.z),
      terrainWarning: this.terrainWarning,
      gLoad: flight.gLoad,
      reconActive: this.reconActive,
      zoomIndex: this.recon.zoomIndex,
      evaluation: this.evaluation,
      shutterFlash: this.recon.flash,
      navigation,
    });
  }
}

function isFiniteFlightControl(control) {
  return control !== null && typeof control === 'object' &&
    Number.isFinite(control.pitch) && Number.isFinite(control.roll) &&
    Number.isFinite(control.yaw) && Number.isFinite(control.throttle) &&
    Number.isFinite(control.brake);
}

const _euler = new THREE.Euler();
const _tmp = new THREE.Vector3();
