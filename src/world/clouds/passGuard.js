/**
 * [ground polish] Fault isolation for the cloud passes (Clouds.renderPasses).
 *
 * The march samples the scene pass's depth, so three renders the whole scene
 * lazily *inside* the march's QuadMesh.render: any exception from a scene
 * object (seen: "reading 'boundingSphere'" from a mesh whose geometry was
 * undefined) surfaces at Clouds.js with the clouds as the nearest app frame,
 * and used to leave the renderer bound to the march target with its state
 * unrestored, every frame. The guard turns that into one diagnostic warning
 * naming the broken objects, then skips the passes with an exponential
 * backoff so a persistent fault cannot flood the console or wedge the tab.
 */

const RENDERABLE = ['isMesh', 'isLine', 'isPoints', 'isSprite'];

function pathOf(o) {
  const parts = [];
  for (let n = o; n && parts.length < 6; n = n.parent) parts.unshift(n.name || n.type || '?');
  return parts.join('/');
}

/** Renderable objects under `root` with no usable geometry, as name paths (at most `max`). */
export function brokenRenderables(root, max = 8) {
  const out = [];
  if (!root?.traverse) return out;
  root.traverse((o) => {
    if (out.length >= max || !RENDERABLE.some((k) => o[k])) return;
    const g = o.geometry;
    if (!g || !g.isBufferGeometry) out.push(pathOf(o));
  });
  return out;
}

export class PassGuard {
  /**
   * @param {string} label prefix for the warning
   * @param {{ warn?: (...a: any[]) => void, maxSkip?: number }} [opts]
   */
  constructor(label, { warn = (...a) => console.warn(...a), maxSkip = 240 } = {}) {
    this.label = label;
    this.warn = warn;
    this.maxSkip = maxSkip;
    this.errors = 0; // total failures
    this.skipped = 0; // frames skipped in all
    this._skip = 0; // frames still to skip
    this._backoff = 0;
    this._quiet = 0; // failures since the last warning
  }

  /** False while backing off after a failure (counts the skipped frame). */
  ready() {
    if (this._skip <= 0) return true;
    this._skip--;
    this.skipped++;
    return false;
  }

  /** A clean frame: forget the backoff. */
  ok() { this._backoff = 0; }

  /** Record a failure; `root` (the scene) is scanned once for the usual culprit. */
  fail(err, root) {
    this.errors++;
    this._backoff = Math.min(this.maxSkip, Math.max(1, this._backoff * 2));
    this._skip = this._backoff;
    // first failure, then every power of two: a persistent fault stays visible
    // without one line per frame
    if ((this.errors & (this.errors - 1)) === 0) {
      const broken = brokenRenderables(root);
      const why = broken.length ? ` Renderables without geometry: ${broken.join(', ')}.` : '';
      const quiet = this._quiet ? ` (${this._quiet} similar failures not logged)` : '';
      this.warn(`[${this.label}] pass failed, skipping ${this._skip} frame(s)${quiet}: ${err?.message ?? err}.${why}`, err);
      this._quiet = 0;
    } else this._quiet++;
  }
}
