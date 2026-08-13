import * as THREE from 'three';
import { Engine } from './core/Engine.js';
import { Settings, guessTier } from './core/Settings.js';
import { Input } from './core/Input.js';
import { Environment } from './world/Environment.js';
import { Sky } from './world/Sky.js';
import { Terrain } from './world/Terrain.js';
import { terrainHeight } from './world/heightfield.js';
import { TERRAIN_NOISE_GLSL } from './world/terrainNoise.glsl.js';
import { FlightModel, AIRCRAFT } from './flight/FlightModel.js';
import { Aircraft } from './flight/Aircraft.js';
import { ChaseCamera } from './flight/ChaseCamera.js';

/**
 * Bootstrap and frame loop.
 *
 * Physics runs on a fixed 120 Hz step with an accumulator. A jet covering 250 m
 * every second is exactly the case where variable-step integration starts
 * producing different flight behaviour on different machines, and where a
 * single long frame can tunnel the aircraft through a ridge.
 */

const PHYSICS_STEP = 1 / 120;
const MAX_STEPS = 6;

const canvas = document.getElementById('viewport');
const settings = new Settings();
const engine = new Engine(canvas, settings);
if (!settings.autoDetected) settings.setTier(guessTier(engine.renderer));
engine.applySettings();

const environment = new Environment();
environment.addTo(engine.scene);

const sky = new Sky(environment);
engine.scene.add(sky.mesh);

const terrain = new Terrain(engine.renderer, environment);
engine.scene.add(terrain.group);
terrain.setQuality(settings.tier);

const envMap = sky.bakeEnvironment(engine.renderer, environment);
engine.scene.environment = envMap;

const input = new Input();
const flight = new FlightModel();
const chase = new ChaseCamera(engine.camera);
const aircraft = new Aircraft(environment);
aircraft.addTo(engine.scene);

const START = new THREE.Vector3(21000, 0, 6000);
START.y = terrainHeight(START.x, START.z) + 1500;
flight.reset(START, Math.PI * 0.62, 265);
terrain.prime(flight.position);
chase.reset(flight);

aircraft.load('./models/mig21.glb', envMap).catch((err) => {
  console.error('[aircraft] failed to load', err);
});

// ---------------------------------------------------------------------------

const debug = document.createElement('div');
debug.id = 'debug';
document.body.appendChild(debug);

let freeCamera = false;
let paused = false;
const freePos = new THREE.Vector3();
let freeYaw = 0;
let freePitch = 0;

let accumulator = 0;

function step(dt) {
  input.update(dt, settings.invertPitch);

  if (input.consumePress('KeyF')) {
    freeCamera = !freeCamera;
    if (freeCamera) {
      freePos.copy(engine.camera.position);
      const e = new THREE.Euler().setFromQuaternion(engine.camera.quaternion, 'YXZ');
      freeYaw = e.y;
      freePitch = e.x;
    }
  }
  if (input.consumePress('KeyR')) {
    flight.reset(START, Math.PI * 0.62, 265);
    chase.reset(flight);
  }
  if (input.consumePress('Digit1')) applyTier('low');
  if (input.consumePress('Digit2')) applyTier('medium');
  if (input.consumePress('Digit3')) applyTier('high');

  accumulator += dt;
  let steps = 0;
  if (paused) accumulator = 0;
  while (accumulator >= PHYSICS_STEP && steps < MAX_STEPS) {
    flight.update(PHYSICS_STEP, input);
    flight.checkTerrainCollision(PHYSICS_STEP);
    accumulator -= PHYSICS_STEP;
    steps++;
  }
  if (steps === MAX_STEPS) accumulator = 0;

  const focus = freeCamera ? freePos : flight.position;

  if (freeCamera) {
    const speed = input.keys.has('ShiftLeft') ? 1400 : 320;
    const forward = new THREE.Vector3(0, 0, -1).applyEuler(new THREE.Euler(freePitch, freeYaw, 0, 'YXZ'));
    const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();
    if (input.keys.has('KeyW')) freePos.addScaledVector(forward, speed * dt);
    if (input.keys.has('KeyS')) freePos.addScaledVector(forward, -speed * dt);
    if (input.keys.has('KeyD')) freePos.addScaledVector(right, speed * dt);
    if (input.keys.has('KeyA')) freePos.addScaledVector(right, -speed * dt);
    engine.camera.position.copy(freePos);
    engine.camera.rotation.set(freePitch, freeYaw, 0, 'YXZ');
    engine.camera.updateMatrixWorld();
  } else {
    chase.update(dt, flight);
  }

  aircraft.update(dt, flight);
  environment.update(dt, engine.camera.position);
  sky.update(engine.camera);
  terrain.update(focus, settings.tier.terrainBudget);
}

function applyTier(name) {
  settings.setTier(name);
  engine.applySettings();
  terrain.setQuality(settings.tier);
}

function frame() {
  const dt = Math.min(engine.clock.getDelta(), 0.1);
  step(dt);
  engine.render(dt);

  debug.textContent =
    `fps ${engine.fps.toFixed(0)}  scale ${engine.renderScale.toFixed(2)}  ${settings.tierName}\n` +
    `ias ${(flight.airspeed * 3.6).toFixed(0)} km/h  ${flight.airspeed.toFixed(0)} m/s  M${flight.machish.toFixed(2)}\n` +
    `alt ${flight.altitude.toFixed(0)}m  agl ${flight.agl.toFixed(0)}m  G ${flight.gLoad.toFixed(1)}\n` +
    `thr ${(flight.throttleSmoothed * 100).toFixed(0)}%${flight.reheat ? ' AB' : ''}` +
    `${flight.stalling ? '  STALL' : ''}${flight.crashed ? '  CRASHED' : ''}\n` +
    `aoa ${(flight.angleOfAttack * 57.3).toFixed(1)}deg  tris ${(terrain.triangleCount / 1000).toFixed(0)}k` +
    `${freeCamera ? '\nFREE CAM (F)' : ''}`;

  input.clearPresses();
  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);

// ---------------------------------------------------------------------------
// Development hooks. Kept out of the gameplay path; used by the screenshot
// driven iteration loop and by the GPU/CPU terrain agreement check.

window.__verifyTerrain = (level = 3) => terrain.verifyAgainst(terrainHeight, level);

window.__pose = (p = {}) => {
  freeCamera = true;
  if (p.x !== undefined) freePos.x = p.x;
  if (p.z !== undefined) freePos.z = p.z;
  if (p.agl !== undefined) freePos.y = terrainHeight(freePos.x, freePos.z) + p.agl;
  if (p.y !== undefined) freePos.y = p.y;
  if (p.yaw !== undefined) freeYaw = p.yaw;
  if (p.pitch !== undefined) freePitch = p.pitch;
  if (p.fov !== undefined) {
    engine.camera.fov = p.fov;
    engine.camera.updateProjectionMatrix();
  }
  terrain.prime(freePos);
  return { x: freePos.x, y: Math.round(freePos.y), z: freePos.z };
};

window.__freeze = (v = true) => {
  paused = v;
  return { paused };
};

/** Park the camera at a fixed offset from the (frozen) aircraft, for inspection. */
window.__inspect = (dx, dy, dz, fov = 45) => {
  paused = true;
  freeCamera = true;
  freePos.copy(flight.position).add(new THREE.Vector3(dx, dy, dz));
  const dir = new THREE.Vector3().subVectors(flight.position, freePos).normalize();
  freeYaw = Math.atan2(-dir.x, -dir.z);
  freePitch = Math.asin(dir.y);
  engine.camera.fov = fov;
  engine.camera.updateProjectionMatrix();
  terrain.prime(freePos);
  return { dist: +freePos.distanceTo(flight.position).toFixed(1) };
};

window.__fly = (p = {}) => {
  freeCamera = false;
  const pos = new THREE.Vector3(p.x ?? START.x, 0, p.z ?? START.z);
  pos.y = p.y ?? terrainHeight(pos.x, pos.z) + (p.agl ?? 900);
  flight.reset(pos, p.heading ?? Math.PI * 0.62, p.speed ?? 265);
  terrain.prime(flight.position);
  chase.reset(flight);
  return { x: pos.x, y: Math.round(pos.y), z: pos.z };
};

/** Evaluate a GLSL expression from the terrain noise library at a point. */
const probeTarget = new THREE.WebGLRenderTarget(1, 1, {
  format: THREE.RGBAFormat,
  type: THREE.FloatType,
  depthBuffer: false,
});
const probeScene = new THREE.Scene();
const probeCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const probeQuad = new THREE.Mesh(
  new THREE.BufferGeometry().setAttribute(
    'position',
    new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3),
  ),
);
probeQuad.frustumCulled = false;
probeScene.add(probeQuad);

window.__probeGLSL = (expr, x, z) => {
  probeQuad.material?.dispose?.();
  probeQuad.material = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    depthTest: false,
    uniforms: { uP: { value: new THREE.Vector2(x, z) } },
    vertexShader: 'void main(){ gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: `precision highp float;
      uniform vec2 uP; out vec4 fragColor;
      ${TERRAIN_NOISE_GLSL}
      void main(){ fragColor = ${expr}; }`,
  });
  const prev = engine.renderer.getRenderTarget();
  engine.renderer.setRenderTarget(probeTarget);
  engine.renderer.render(probeScene, probeCam);
  const out = new Float32Array(4);
  engine.renderer.readRenderTargetPixels(probeTarget, 0, 0, 1, 1, out);
  engine.renderer.setRenderTarget(prev);
  return Array.from(out);
};

Object.assign(window, { THREE, engine, terrain, environment, flight, aircraft, chase, input, AIRCRAFT });
