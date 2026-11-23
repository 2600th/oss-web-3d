import { Renderer } from '../engine/Renderer.js';

/**
 * Boot + lifecycle robustness (engine pass).
 *
 * Backend choice, made *before* the renderer touches the canvas:
 *   1. `?webgl` forces WebGL2.
 *   2. WebGPU when `navigator.gpu` exists and an adapter is actually returned
 *      (a blocklisted GPU, or Chrome with WebGPU disabled, has `navigator.gpu`
 *      but no adapter).
 *   3. Otherwise WebGL2.
 * If the WebGPU renderer still fails to initialise (device creation refused,
 * driver crash), the canvas is replaced — a canvas that has handed out a
 * "webgpu" context can never give a "webgl2" one — and WebGL2 is tried. Only
 * when neither works does the boot-failure overlay appear.
 *
 * We choose ourselves rather than relying on three's built-in fallback because
 * that fallback warns on the console and reuses the same canvas.
 */

/** Is there a usable WebGPU adapter? Never throws. */
export async function probeWebGPU() {
  try {
    if (typeof navigator === 'undefined' || !navigator.gpu) return false;
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    return !!adapter;
  } catch {
    return false;
  }
}

/** Can this browser create a WebGL2 context? Uses a throwaway canvas. */
export function probeWebGL2() {
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2');
    const ok = !!gl;
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
    return ok;
  } catch {
    return false;
  }
}

function freshCanvas(old) {
  const c = old.cloneNode(false);
  old.replaceWith(c);
  return c;
}

/**
 * Create and initialise the engine Renderer on the best available backend.
 * Returns { r, canvas, fallbackReason } or throws an Error whose message is
 * fit for the player when no backend works.
 */
export async function createRenderer(canvas, params) {
  const force = params.has('webgl');
  const webgpu = !force && await probeWebGPU();
  let fallbackReason = force ? 'forced (?webgl)' : webgpu ? null : 'WebGPU unavailable';
  if (webgpu) {
    try {
      const r = new Renderer(canvas);
      await r.init();
      if (r.backend === 'webgpu') return { r, canvas, fallbackReason };
      // three fell back by itself (should not happen after a good probe): keep it
      return { r, canvas, fallbackReason: 'WebGPU init fell back' };
    } catch (e) {
      fallbackReason = `WebGPU init failed: ${e?.message ?? e}`;
      canvas = freshCanvas(canvas);
    }
  }
  if (!probeWebGL2()) {
    throw new Error('This browser supports neither WebGPU nor WebGL2, or graphics acceleration is turned off. Enable hardware acceleration, or try a current Chrome, Edge, Firefox or Safari.');
  }
  const r = new Renderer(canvas, { forceWebGL: true });
  await r.init();
  if (fallbackReason) console.info(`[boot] WebGL2 backend (${fallbackReason})`);
  return { r, canvas, fallbackReason };
}

/** Show the full-screen boot/status overlay (index.html #boot-status). */
export function showStatus(message, { button = 'Reload', onClick = () => location.reload() } = {}) {
  const el = document.getElementById('boot-status');
  if (!el) return;
  el.querySelector('[data-boot-message]').textContent = message;
  const b = el.querySelector('button');
  if (b) { b.textContent = button; b.onclick = onClick; }
  el.hidden = false;
  el.style.display = 'grid';
  document.getElementById('boot')?.remove();
}

/**
 * Device / context loss: stop the loop (every frame would throw) and tell the
 * player. A full in-place rebuild would have to re-create every GPU-generated
 * resource the feature areas own (baked cloud noise, LUTs, particle state), so
 * we restart instead, straight back to the menu; on a second loss in the same
 * session we restart on WebGL2, which survives most GPU-process crashes.
 */
export function handleDeviceLoss(r, stop) {
  r.onLost = (info) => {
    stop();
    let count = 0;
    try { count = Number(sessionStorage.getItem('ss.deviceLost') ?? 0) + 1; sessionStorage.setItem('ss.deviceLost', String(count)); } catch { /* storage blocked */ }
    const url = new URL(location.href);
    url.searchParams.delete('mission');
    if (count >= 2 && r.backend === 'webgpu') url.searchParams.set('webgl', '');
    showStatus(
      `The graphics device was reset (${info?.message || info?.reason || 'driver or GPU process restart'}). Your settings and progress are saved.`,
      { button: count >= 2 && r.backend === 'webgpu' ? 'Restart in compatibility mode' : 'Restart', onClick: () => location.replace(url.toString()) },
    );
  };
}
