import * as THREE from 'three';
import { Engine } from './core/Engine.js';
import { Settings, guessTier } from './core/Settings.js';
import { Environment } from './world/Environment.js';
import { Sky } from './world/Sky.js';
import { Terrain } from './world/Terrain.js';
import { terrainHeight } from './world/heightfield.js';
import { TERRAIN_NOISE_GLSL } from './world/terrainNoise.glsl.js';

/**
 * TEMPORARY terrain verification harness.
 * Replaced by the real game bootstrap once the world reads correctly.
 */

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

const camera = engine.camera;
const pos = new THREE.Vector3(0, 5600, 0);
let yaw = 0.6;
let pitch = -0.18;
let speed = 260;

const keys = new Set();
addEventListener('keydown', (e) => {
  keys.add(e.code);
  if (e.code === 'Digit1') settings.setTier('low'), engine.applySettings();
  if (e.code === 'Digit2') settings.setTier('medium'), engine.applySettings();
  if (e.code === 'Digit3') settings.setTier('high'), engine.applySettings();
});
addEventListener('keyup', (e) => keys.delete(e.code));
canvas.addEventListener('click', () => canvas.requestPointerLock());
addEventListener('mousemove', (e) => {
  if (document.pointerLockElement !== canvas) return;
  yaw -= e.movementX * 0.0022;
  pitch = THREE.MathUtils.clamp(pitch - e.movementY * 0.0022, -1.5, 1.5);
});

const debug = document.createElement('div');
debug.id = 'debug';
document.body.appendChild(debug);

terrain.prime(pos);

const forward = new THREE.Vector3();
const right = new THREE.Vector3();
const up = new THREE.Vector3(0, 1, 0);

function frame() {
  const dt = Math.min(engine.clock.getDelta(), 0.05);

  camera.rotation.set(pitch, yaw, 0, 'YXZ');
  camera.getWorldDirection(forward);
  right.crossVectors(forward, up).normalize();

  if (keys.has('ShiftLeft')) speed = 900;
  else if (keys.has('ControlLeft')) speed = 60;
  else speed = 260;

  const move = new THREE.Vector3();
  if (keys.has('KeyW')) move.add(forward);
  if (keys.has('KeyS')) move.sub(forward);
  if (keys.has('KeyD')) move.add(right);
  if (keys.has('KeyA')) move.sub(right);
  if (keys.has('KeyE')) move.y += 1;
  if (keys.has('KeyQ')) move.y -= 1;
  if (move.lengthSq() > 0) pos.addScaledVector(move.normalize(), speed * dt);

  camera.position.copy(pos);
  environment.update(dt, pos);
  sky.update(camera);
  terrain.update(pos, settings.tier.terrainBudget);

  engine.render(dt);

  const ground = terrainHeight(pos.x, pos.z);
  debug.textContent =
    `fps ${engine.fps.toFixed(0)}  scale ${engine.renderScale.toFixed(2)}  tier ${settings.tierName}\n` +
    `pos ${pos.x.toFixed(0)} ${pos.y.toFixed(0)} ${pos.z.toFixed(0)}\n` +
    `ground ${ground.toFixed(0)}m  agl ${(pos.y - ground).toFixed(0)}m\n` +
    `tris ${(terrain.triangleCount / 1000).toFixed(0)}k  calls ${engine.renderer.info.render.calls}`;

  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);

window.__verifyTerrain = (level = 3) => terrain.verifyAgainst(terrainHeight, level);

/** Place the free camera for screenshot-driven iteration. */
window.__pose = (p = {}) => {
  if (p.x !== undefined) pos.x = p.x;
  if (p.z !== undefined) pos.z = p.z;
  if (p.agl !== undefined) pos.y = terrainHeight(pos.x, pos.z) + p.agl;
  if (p.y !== undefined) pos.y = p.y;
  if (p.yaw !== undefined) yaw = p.yaw;
  if (p.pitch !== undefined) pitch = p.pitch;
  if (p.fov !== undefined) {
    camera.fov = p.fov;
    camera.updateProjectionMatrix();
  }
  terrain.prime(pos);
  return { x: pos.x, y: Math.round(pos.y), z: pos.z, ground: Math.round(terrainHeight(pos.x, pos.z)) };
};

/**
 * Evaluate an arbitrary GLSL expression from the terrain noise library at a
 * point, so individual pieces of the height function can be diffed against the
 * JS mirror instead of guessing which one drifted.
 *   __probeGLSL('vec4(t_hash(vec2(uP)), 0, 0, 1)', 3, 7)
 */
const probeTarget = new THREE.WebGLRenderTarget(1, 1, {
  format: THREE.RGBAFormat,
  type: THREE.FloatType,
  depthBuffer: false,
});
const probeScene = new THREE.Scene();
const probeCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const probeGeom = new THREE.BufferGeometry().setAttribute(
  'position',
  new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3),
);
const probeQuad = new THREE.Mesh(probeGeom);
probeQuad.frustumCulled = false;
probeScene.add(probeQuad);

window.__probeGLSL = (expr, x, z) => {
  if (probeQuad.material?.dispose) probeQuad.material.dispose();
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
Object.assign(window, { THREE, engine, terrain, environment, camera, state: { pos } });
