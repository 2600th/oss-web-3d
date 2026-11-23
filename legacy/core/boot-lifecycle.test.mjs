import assert from 'node:assert/strict';
import { acquireWebGL2, installContextRecovery, installPageLifecycle, showBootFailure, supportsWebGL2 } from './BootLifecycle.js';

class Target {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, fn) { this.listeners.set(type, fn); }
  removeEventListener(type, fn) { if (this.listeners.get(type) === fn) this.listeners.delete(type); }
  fire(type, event = {}) { this.listeners.get(type)?.(event); }
}

{
  // Availability is answered without creating anything. The old probe made a
  // throwaway context and released it through WEBGL_lose_context — an extension
  // that need not exist, and when it does not the probe context leaks. Desktop
  // has contexts to spare; iOS keeps a small budget and evicts aggressively, so
  // a leaked probe could cost the renderer its own context and the experience
  // never started.
  assert.equal(supportsWebGL2({ WebGL2RenderingContext: function () {} }), true);
  assert.equal(supportsWebGL2({}), false);
  assert.equal(supportsWebGL2(undefined), false);
}

{
  // The one context the app will use, created on the real canvas.
  const asked = [];
  const context = { real: true };
  const canvas = { getContext: (name, attrs) => { asked.push([name, attrs]); return name === 'webgl2' ? context : null; } };
  assert.equal(acquireWebGL2(canvas), context);
  assert.equal(asked[0][0], 'webgl2');
  assert.equal(asked[0][1].alpha, false, 'attributes must match the renderer, or getContext returns the old ones');
  assert.equal(asked[0][1].antialias, false);
  assert.equal(asked[0][1].depth, true);

  assert.equal(acquireWebGL2({ getContext: () => null }), null, 'a refused context is null, not a throw');
  assert.equal(acquireWebGL2({ getContext: () => { throw new Error('blocked'); } }), null, 'a throwing getContext is survivable');
  assert.equal(acquireWebGL2(null), null);
  assert.equal(acquireWebGL2({}), null, 'a canvas with no getContext is not a canvas');
}

{
  const canvas = new Target();
  const seen = [];
  const remove = installContextRecovery(canvas, () => seen.push('lost'), () => seen.push('restored'));
  let prevented = false;
  canvas.fire('webglcontextlost', { preventDefault() { prevented = true; } });
  canvas.fire('webglcontextrestored');
  assert.deepEqual(seen, ['lost', 'restored']);
  assert.equal(prevented, true, 'loss must be cancelled so the browser may restore the context');
  remove();
  assert.equal(canvas.listeners.size, 0);
}

{
  const page = new Target();
  let disposals = 0;
  const remove = installPageLifecycle(() => disposals++, page);
  page.fire('pagehide');
  page.fire('pagehide');
  assert.equal(disposals, 1, 'page teardown must be idempotent');
  remove();
}

{
  const message = { textContent: '' };
  const status = { hidden: true, style: { display: 'none' }, querySelector: () => message };
  let seam;
  const doc = { getElementById: () => status, defaultView: { __sagar: { fail: (...args) => { seam = args; } } } };
  showBootFailure('WebGL2 unavailable', doc);
  assert.equal(status.hidden, false);
  assert.equal(status.style.display, 'grid');
  assert.equal(message.textContent, 'WebGL2 unavailable');
  assert.deepEqual(seam, ['boot', 'WebGL2 unavailable']);
}

console.log('boot lifecycle contracts passed');
