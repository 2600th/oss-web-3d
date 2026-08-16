/** Small DOM-only boot/lifecycle seams, kept independent of Three.js. */

/**
 * The context attributes the renderer is built with.
 *
 * Shared so the probe and the renderer ask for exactly the same thing — a
 * mismatch would make getContext() hand back the already-created context with
 * the *original* attributes, silently ignoring the new ones.
 */
export const GL_ATTRIBUTES = Object.freeze({
  alpha: false,
  antialias: false,
  depth: true,
  stencil: false,
  powerPreference: 'high-performance',
  failIfMajorPerformanceCaveat: false,
});

/**
 * Acquire the one WebGL2 context this application will ever use.
 *
 * It is created on the real viewport canvas and handed to the renderer, rather
 * than probed on a throwaway canvas and discarded. The old probe made a second
 * context purely to answer "is WebGL2 available?", then tried to release it
 * through WEBGL_lose_context — an extension that is not guaranteed to exist,
 * and when it does not, the probe context simply leaked.
 *
 * Desktop browsers allow enough simultaneous contexts that nobody noticed. iOS
 * does not: WebKit keeps a small budget and evicts aggressively, so a leaked
 * probe could cost the real renderer its context and the whole experience
 * failed to start with no useful message.
 *
 * @returns {WebGL2RenderingContext|null}
 */
export function acquireWebGL2(canvas) {
  if (!canvas?.getContext) return null;
  try {
    return canvas.getContext('webgl2', GL_ATTRIBUTES) ?? null;
  } catch {
    return null;
  }
}

/**
 * Whether WebGL2 exists at all, without creating a context.
 *
 * Kept as a cheap pre-check so a browser that has no WebGL2 whatsoever gets the
 * "update your browser" message rather than a renderer construction failure.
 */
export function supportsWebGL2(view = globalThis) {
  return typeof view?.WebGL2RenderingContext !== 'undefined';
}

export function showBootFailure(message, doc = document) {
  const status = doc.getElementById('boot-status');
  if (status) {
    const copy = status.querySelector?.('[data-boot-message]');
    if (copy) copy.textContent = message;
    else status.textContent = message;
    status.hidden = false;
    status.style.display = 'grid';
  }
  doc.defaultView?.__sagar?.fail?.('boot', message);
}

export function installContextRecovery(canvas, onLost, onRestored) {
  const lost = (event) => {
    event.preventDefault();
    onLost?.(event);
  };
  const restored = (event) => onRestored?.(event);
  canvas.addEventListener('webglcontextlost', lost);
  canvas.addEventListener('webglcontextrestored', restored);
  return () => {
    canvas.removeEventListener('webglcontextlost', lost);
    canvas.removeEventListener('webglcontextrestored', restored);
  };
}

export function installPageLifecycle(dispose, target = window) {
  let disposed = false;
  const pagehide = () => {
    if (disposed) return;
    disposed = true;
    dispose();
  };
  target.addEventListener('pagehide', pagehide);
  return () => target.removeEventListener('pagehide', pagehide);
}
