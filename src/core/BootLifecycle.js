/** Small DOM-only boot/lifecycle seams, kept independent of Three.js. */

export function supportsWebGL2(doc = document) {
  try {
    const canvas = doc.createElement('canvas');
    const context = canvas.getContext('webgl2', { failIfMajorPerformanceCaveat: false });
    if (!context) return false;
    context.getExtension?.('WEBGL_lose_context')?.loseContext?.();
    return true;
  } catch {
    return false;
  }
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
