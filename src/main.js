import * as THREE from 'three';
import { Engine } from './core/Engine.js';
import { Settings, guessTier } from './core/Settings.js';
import { Input } from './core/Input.js';
import { Game } from './game/Game.js';
import { terrainHeight } from './world/heightfield.js';
import { TERRAIN_NOISE_GLSL } from './world/terrainNoise.glsl.js';

const canvas = document.getElementById('viewport');
const settings = new Settings();
const engine = new Engine(canvas, settings);
if (!settings.autoDetected) settings.setTier(guessTier(engine.renderer));
engine.applySettings();

const input = new Input();
const game = new Game(engine, settings, input);

const debug = document.createElement('div');
debug.id = 'debug';
document.body.appendChild(debug);
if (new URLSearchParams(location.search).has('debug')) debug.classList.add('show');

await game.load();

// The frame loop must be running *before* the title sequence starts: begin()
// does not resolve until the player skips or the last card fades, so awaiting
// it here would leave the page on a single static frame with no render loop.
function frame() {
  const dt = Math.min(engine.clock.getDelta(), 0.1);
  game.update(dt);
  engine.render(dt);

  if (debug.classList.contains('show')) {
    const f = game.flight;
    debug.textContent =
      `${engine.fps.toFixed(0)} fps  scale ${engine.renderScale.toFixed(2)}  ${settings.tierName}\n` +
      `state ${game.state}  tris ${(game.terrain.triangleCount / 1000).toFixed(0)}k\n` +
      `ias ${(f.airspeed * 3.6).toFixed(0)} km/h  alt ${f.altitude.toFixed(0)}  agl ${f.agl.toFixed(0)}\n` +
      `G ${f.gLoad.toFixed(1)}  aoa ${(f.angleOfAttack * 57.3).toFixed(1)}  thr ${(f.throttleSmoothed * 100).toFixed(0)}%` +
      `${f.stalling ? ' STALL' : ''}${f.crashed ? ' CRASHED' : ''}\n` +
      `objectives ${game.mission.captured}/${game.mission.posts.length}`;
  }

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
game.begin();

// ---------------------------------------------------------------------------
// Development hooks. Not part of the gameplay path — used by the screenshot
// driven iteration loop, the GPU/CPU terrain agreement check, and profiling.

window.__verifyTerrain = (level = 3) => game.terrain.verifyAgainst(terrainHeight, level);

/**
 * Frame-rate probe that also reports whether it can be believed.
 *
 * Chrome throttles requestAnimationFrame when a tab is occluded or between
 * window state changes, and does so while still reporting
 * document.visibilityState === 'visible'. A measurement taken during one of
 * those windows read 10 fps for a scene actually running at 116, and drove the
 * resolution scaler to its floor. Check `throttled` before trusting a number.
 */
window.__perf = async (ms = 1500) => {
  const start = performance.now();
  let frames = 0;
  let worst = 0;
  let last = start;
  await new Promise((resolve) => {
    const tick = (now) => {
      frames++;
      worst = Math.max(worst, now - last);
      last = now;
      if (now - start < ms) requestAnimationFrame(tick);
      else resolve();
    };
    requestAnimationFrame(tick);
  });
  const elapsed = (performance.now() - start) / 1000;
  const rafFps = frames / elapsed;
  return {
    rafFps: +rafFps.toFixed(1),
    frameMs: +((elapsed * 1000) / frames).toFixed(2),
    worstFrameMs: +worst.toFixed(1),
    renderScale: +engine.renderScale.toFixed(2),
    drawingBuffer: [engine.renderer.domElement.width, engine.renderer.domElement.height],
    tier: settings.tierName,
    throttled: rafFps < 25,
  };
};

/** Jump straight into flight at a chosen place, skipping the title. */
window.__fly = (p = {}) => {
  if (game.state === 'title') for (const fn of [...game._skipHandlers]) fn();
  game.launch();
  const pos = new THREE.Vector3(p.x ?? 21000, 0, p.z ?? 6000);
  pos.y = p.y ?? terrainHeight(pos.x, pos.z) + (p.agl ?? 1200);
  game.flight.reset(pos, p.heading ?? Math.PI * 0.62, p.speed ?? 260);
  game.terrain.prime(game.flight.position);
  game.chase.reset(game.flight);
  return { x: pos.x, y: Math.round(pos.y), z: pos.z };
};

/**
 * Fly to a given observation post on a run that actually works: searches the
 * approach bearings for one with clear line of sight and safe ground clearance,
 * and sets the altitude so the fixed camera's depression puts the target on the
 * optical axis. Without this the harness kept spawning the aircraft inside a
 * mountain or behind the ridge the post sits on.
 */
window.__toPost = (index = 0, range = 2000) => {
  const post = game.mission.posts[index];
  if (!post) return null;
  game.launch();

  const depression = THREE.MathUtils.degToRad(11);
  const agl = range * Math.tan(depression);
  let best = null;

  for (let i = 0; i < 48; i++) {
    const a = (i / 48) * Math.PI * 2;
    const pos = new THREE.Vector3(
      post.position.x + Math.cos(a) * range,
      0,
      post.position.z + Math.sin(a) * range,
    );
    pos.y = post.position.y + agl;
    if (pos.y - terrainHeight(pos.x, pos.z) < 180) continue;
    const visibility = game.recon.lineOfSight(pos, post.aimPoint);
    if (!best || visibility > best.visibility) best = { pos, visibility, a };
  }
  if (!best) return { post: post.callsign, error: 'no clear approach found' };

  const flat = new THREE.Vector3(
    post.position.x - best.pos.x,
    0,
    post.position.z - best.pos.z,
  ).normalize();
  game.flight.reset(best.pos, Math.atan2(-flat.x, -flat.z), 215);
  game.terrain.prime(game.flight.position);
  game.chase.reset(game.flight);
  return {
    post: post.callsign,
    at: post.position.toArray().map((v) => Math.round(v)),
    range,
    approachVisibility: +best.visibility.toFixed(2),
  };
};

window.__mission = () =>
  game.mission.posts.map((p) => ({
    id: p.id,
    callsign: p.callsign,
    pos: p.position.toArray().map((v) => Math.round(v)),
    alt: Math.round(p.position.y),
    captured: p.captured,
    best: +p.bestScore.toFixed(3),
  }));

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

Object.assign(window, { THREE, engine, game, settings, input });
