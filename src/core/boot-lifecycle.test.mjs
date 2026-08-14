import assert from 'node:assert/strict';
import { installContextRecovery, installPageLifecycle, showBootFailure, supportsWebGL2 } from './BootLifecycle.js';

class Target {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, fn) { this.listeners.set(type, fn); }
  removeEventListener(type, fn) { if (this.listeners.get(type) === fn) this.listeners.delete(type); }
  fire(type, event = {}) { this.listeners.get(type)?.(event); }
}

{
  assert.equal(supportsWebGL2({ createElement: () => ({ getContext: (name) => name === 'webgl2' ? {} : null }) }), true);
  assert.equal(supportsWebGL2({ createElement: () => ({ getContext: () => null }) }), false);
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
