import * as THREE from 'three';
import { Engine } from './core/Engine.js';
import { Settings, guessTier, isTouchDevice } from './core/Settings.js';
import { Input } from './core/Input.js';
import { TouchControls } from './core/TouchControls.js';
import {
  installContextRecovery,
  installPageLifecycle,
  showBootFailure,
  supportsWebGL2,
} from './core/BootLifecycle.js';
import { Game } from './game/Game.js';
import { configureTerrain } from './world/Terrain.js';
import { terrainHeight } from './world/heightfield.js';
import { TERRAIN_NOISE_GLSL } from './world/terrainNoise.glsl.js';

/**
 * Diagnostic log, installed before anything else runs.
 *
 * There is no automated GLSL compile check in this project -- `npm run check` is
 * a lint for backticks and reversed-edge smoothstep, nothing more -- so a broken
 * shader surfaces only as a console warning and a black screen. The screenshot
 * harness drives the page from outside and cannot see messages that were emitted
 * before it attached, which is exactly when shader compilation happens. Buffering
 * them here means __audit() can report them after the fact.
 */
const canvas = document.getElementById('viewport');
if (!supportsWebGL2()) {
  showBootFailure('WebGL2 is unavailable. Update your browser or graphics driver, then reload.');
} else {
  await start(canvas);
}

async function start(canvas) {
const __log = [];
const restoreConsole = [];
if (import.meta.env.DEV) {
  for (const level of ['error', 'warn']) {
    const original = console[level].bind(console);
    restoreConsole.push(() => { console[level] = original; });
    console[level] = (...args) => {
      if (__log.length < 200) __log.push({ level, text: args.map(String).join(' ').slice(0, 600) });
      original(...args);
    };
  }
}
const onError = (e) => {
  if (import.meta.env.DEV) __log.push({ level: 'error', text: String(e.message) });
  showBootFailure('The experience encountered an error. Reload to try again.');
};
const onRejection = (e) => {
  if (import.meta.env.DEV) __log.push({ level: 'error', text: `unhandled rejection: ${String(e.reason)}` });
  showBootFailure('The experience could not continue. Reload to try again.');
};
window.addEventListener('error', onError);
window.addEventListener('unhandledrejection', onRejection);

const settings = new Settings();
const engine = new Engine(canvas, settings);
if (!settings.autoDetected) settings.setTier(guessTier(engine.renderer));

// Terrain grid resolution has to be fixed before Terrain is constructed — it
// sets buffer sizes and constants compiled into the shaders — so it is applied
// here rather than through the usual applySettings path, and changing it later
// requires a reload. Every other quality knob stays live.
configureTerrain({ res: settings.tier.terrainRes });
engine.applySettings();

const input = new Input();
const game = new Game(engine, settings, input);

const touch = new TouchControls(input, document.getElementById('ui'));
game.setTouchControls(touch);
touch.setEnabled(isTouchDevice());
// Touch counts as the gesture that unlocks audio, which iOS requires and which
// the keyboard path would otherwise never receive on a phone.
if (isTouchDevice()) {
  const unlock = () => {
    game.audio.start();
    game.audio.resume();
  };
  window.addEventListener('pointerdown', unlock, { once: true });
  window.addEventListener('touchend', unlock, { once: true });
}

const debug = import.meta.env.DEV ? document.createElement('div') : null;
if (debug) {
  debug.id = 'debug';
  document.body.appendChild(debug);
  if (new URLSearchParams(location.search).has('debug')) debug.classList.add('show');
}

try {
  await game.load();
} catch (error) {
  console.error('[boot] load failed', error);
  showBootFailure('Essential game resources failed to load. Check your connection and reload.');
  window.removeEventListener('error', onError);
  window.removeEventListener('unhandledrejection', onRejection);
  for (const restore of restoreConsole) restore();
  touch.dispose();
  input.dispose();
  game.dispose();
  engine.dispose();
  return;
}

// The frame loop must be running *before* the title sequence starts: begin()
// does not resolve until the player skips or the last card fades, so awaiting
// it here would leave the page on a single static frame with no render loop.
let running = true;
let frameId = 0;
function frame() {
  if (!running) return;
  engine.timer.update();
  // Bound the step: returning from a background tab hands back a delta of
  // several seconds, which would teleport the aircraft through a mountain.
  const dt = Math.min(engine.timer.getDelta(), 0.1);
  game.update(dt);
  engine.render(dt);

  if (debug?.classList.contains('show')) {
    const f = game.flight;
    debug.textContent =
      `${engine.fps.toFixed(0)} fps  scale ${engine.renderScale.toFixed(2)}  ${settings.tierName}\n` +
      `state ${game.state}  tris ${(game.terrain.triangleCount / 1000).toFixed(0)}k\n` +
      `ias ${(f.airspeed * 3.6).toFixed(0)} km/h  alt ${f.altitude.toFixed(0)}  agl ${f.agl.toFixed(0)}\n` +
      `G ${f.gLoad.toFixed(1)}  aoa ${(f.angleOfAttack * 57.3).toFixed(1)}  thr ${(f.throttleSmoothed * 100).toFixed(0)}%` +
      `${f.stalling ? ' STALL' : ''}${f.crashed ? ' CRASHED' : ''}\n` +
      `objectives ${game.mission.captured}/${game.mission.posts.length}`;
  }

  frameId = requestAnimationFrame(frame);
}
frameId = requestAnimationFrame(frame);
void game.begin().catch((error) => {
  console.error('[boot] start failed', error);
  showBootFailure('The sortie could not start. Reload to try again.');
});

let disposeDevResources = () => {};
const removeContextRecovery = installContextRecovery(
  canvas,
  () => showBootFailure('Graphics context lost. Waiting for recovery…'),
  () => showBootFailure('Graphics context restored. Reload to resume safely.'),
);
installPageLifecycle(() => {
  running = false;
  cancelAnimationFrame(frameId);
  removeContextRecovery();
  window.removeEventListener('error', onError);
  window.removeEventListener('unhandledrejection', onRejection);
  for (const restore of restoreConsole) restore();
  disposeDevResources();
  touch.dispose();
  input.dispose();
  game.dispose();
  engine.dispose();
});

// ---------------------------------------------------------------------------
// Development hooks. Not part of the gameplay path — used by the screenshot
// driven iteration loop, the GPU/CPU terrain agreement check, and profiling.

if (import.meta.env.DEV) {
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

/**
 * Cost of one rendered frame, measured without relying on requestAnimationFrame.
 *
 * This exists because __perf above cannot be trusted under automation, and two
 * other plausible approaches were tried and both lie:
 *
 *   gl.finish() does not block in Chrome's WebGL — commands are handed to the
 *   GPU process asynchronously — so a loop bracketed with it measured 0.45 ms
 *   per frame, i.e. 2200 fps, for a scene that plainly was not running that
 *   fast.
 *
 *   EXT_disjoint_timer_query_webgl2 should be authoritative, but with the
 *   window occluded its results did not scale with pixel count at all: 0.43 MP
 *   measured 4.3 ms and 6.8 MP measured 0.7 ms. Whatever it timed, it was not
 *   the work.
 *
 * gl.readPixels does block, because it has to return data the GPU has not
 * produced yet, so bracketing a burst of renders with one read gives a real
 * number. The check that this is measuring anything at all is that the result
 * must scale with pixel count — see __benchScaling.
 */
window.__gpuBench = (frames = 45) => {
  const gl = engine.renderer.getContext();
  const px = new Uint8Array(4);
  const drain = () => {
    engine.renderer.setRenderTarget(null);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  };

  engine.composer.render(1 / 60);
  drain(); // flush anything already queued before starting the clock

  const t0 = performance.now();
  for (let i = 0; i < frames; i++) engine.composer.render(1 / 60);
  drain();
  const ms = (performance.now() - t0) / frames;

  const w = engine.renderer.domElement.width;
  const h = engine.renderer.domElement.height;
  return {
    frameMs: +ms.toFixed(2),
    fps: +(1000 / ms).toFixed(0),
    megapixels: +((w * h) / 1e6).toFixed(2),
    drawingBuffer: [w, h],
    renderScale: +engine.renderScale.toFixed(2),
    tier: settings.tierName,
  };
};

/** Validate __gpuBench by checking its result actually tracks pixel count. */
window.__benchScaling = () => {
  const original = engine.renderScale;
  const out = [];
  for (const scale of [0.5, 0.75, 1.0]) {
    engine.renderScale = scale;
    engine.resize();
    out.push(window.__gpuBench(30));
  }
  engine.renderScale = original;
  engine.resize();
  return out;
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

/**
 * Fly to a post and enter recon mode the way the pilot does.
 *
 * Worth a hook rather than a few lines at the console, because there are two
 * ways to get this wrong and both look like product bugs. Recon is a *held*
 * key, and Input recomputes reconHeld from the pressed-key set every frame, so
 * assigning input.reconHeld or game.reconActive is overwritten before it is
 * ever read. And the recon camera is the engine camera — the chase camera owns
 * it until recon mode takes over — so calling recon.evaluate() outside recon
 * mode scores the chase camera's pose at its 58 degree field of view, which
 * reports zero screen coverage and looks exactly like broken scoring.
 */
window.__recon = async (index = 0, range = 1500, zoom = 2) => {
  const approach = window.__toPost(index, range);
  if (!approach || approach.error) return approach;
  // Hiding the title screens moves focus, and the blur handler clears the
  // pressed-key set, so a keydown sent too early is silently dropped. When that
  // happens the evaluation comes back null, which reads like broken scoring.
  // Resend until the mode actually latches rather than guessing a delay.
  for (let i = 0; i < 20 && !game.reconActive; i++) {
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true }));
    await new Promise((r) => setTimeout(r, 50));
  }
  game.recon.setZoom(zoom);
  game.recon._fovSmoothed = game.recon.fov; // skip the ease, so a probe is deterministic
  await new Promise((r) => setTimeout(r, 400));
  const ev = game.evaluation;
  return {
    approach,
    evaluation: ev && {
      callsign: ev.post.callsign,
      inFrame: ev.inFrame,
      range: Math.round(ev.range),
      visibility: +ev.visibility.toFixed(3),
      framing: +ev.framing.toFixed(3),
      coverage: +ev.coverage.toFixed(3),
      rangeQuality: +ev.rangeQuality.toFixed(3),
      angleQuality: +ev.angleQuality.toFixed(3),
      score: +ev.score.toFixed(3),
    },
  };
};

/** Release the recon key again. */
window.__reconEnd = () =>
  window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space', bubbles: true }));

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
disposeDevResources = () => {
  probeQuad.material?.dispose?.();
  probeQuad.geometry.dispose();
  probeTarget.dispose();
};

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

/**
 * One-call health report for the screenshot harness.
 *
 * Forces every material in the scene to compile first. Three.js compiles lazily
 * on first draw, so a shader that only appears in a rare state -- the crash
 * effect, a cloud layer at a particular altitude -- would otherwise report clean
 * right up until the moment it is needed. renderer.compile() walks the graph and
 * surfaces those failures now, into the buffered log above.
 */
window.__audit = async () => {
  engine.renderer.compile(engine.scene, engine.camera);
  await new Promise((r) => requestAnimationFrame(r));
  const gl = engine.renderer.getContext();
  const glErrors = [];
  for (let i = 0; i < 8; i++) {
    const e = gl.getError();
    if (e === gl.NO_ERROR) break;
    glErrors.push(e);
  }
  return {
    log: __log.filter((m) => !/DevTools|favicon/.test(m.text)),
    glErrors,
    programs: engine.renderer.info.programs?.length ?? 0,
    calls: engine.renderer.info.render.calls,
    triangles: engine.renderer.info.render.triangles,
    state: game.state,
    tier: settings.tierName,
  };
};

/**
 * Luminance and chroma statistics of the frame currently in the back buffer.
 *
 * The overhaul's headline problem was measured this way rather than judged by
 * eye: the original image spanned only luminance 78..222 with a 2.9% spread
 * between its mean channels, which is the numeric signature of "grey milk".
 * Keeping the measurement in the product means the claim stays checkable.
 */
window.__stats = (stride = 7) => {
  const gl = engine.renderer.getContext();
  const w = gl.drawingBufferWidth;
  const h = gl.drawingBufferHeight;
  const px = new Uint8Array(w * h * 4);
  engine.composer.render(1 / 60);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);

  const hist = new Array(16).fill(0);
  let n = 0;
  let sum = 0;
  let min = 255;
  let max = 0;
  let rs = 0;
  let gs = 0;
  let bs = 0;
  let satSum = 0;
  for (let i = 0; i < px.length; i += 4 * stride) {
    const r = px[i];
    const g = px[i + 1];
    const b = px[i + 2];
    const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    hist[Math.min(15, L >> 4)]++;
    sum += L;
    n++;
    if (L < min) min = L;
    if (L > max) max = L;
    rs += r;
    gs += g;
    bs += b;
    const mx = Math.max(r, g, b);
    satSum += mx > 0 ? (mx - Math.min(r, g, b)) / mx : 0;
  }
  const mean = [rs / n, gs / n, bs / n];
  return {
    size: [w, h],
    meanLuma: +(sum / n).toFixed(1),
    min: +min.toFixed(1),
    max: +max.toFixed(1),
    shadows: +((hist.slice(0, 6).reduce((a, v) => a + v, 0) / n) * 100).toFixed(1),
    midPile: +((hist.slice(10, 13).reduce((a, v) => a + v, 0) / n) * 100).toFixed(1),
    histogram16: hist.map((v) => +((v / n) * 100).toFixed(1)),
    meanRGB: mean.map((v) => +v.toFixed(1)),
    channelSpread: +(((Math.max(...mean) - Math.min(...mean)) / 255) * 100).toFixed(1),
    meanSaturation: +((satSum / n) * 100).toFixed(1),
  };
};

Object.assign(window, { THREE, engine, game, settings, input });
}
}
