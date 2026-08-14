import assert from 'node:assert/strict';

class FakeNode {
  constructor(tag = 'div') {
    this.tag = tag;
    this.children = [];
    this.parentNode = null;
    this.style = {};
    this.listeners = new Map();
    const classes = new Set();
    this.classList = {
      toggle: (name, on) => on ? classes.add(name) : classes.delete(name),
      contains: (name) => classes.has(name),
    };
  }
  appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((n) => n !== this); this.parentNode = null; }
  setAttribute() {}
  addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(fn); }
  removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
  dispatch(type, event) { for (const fn of this.listeners.get(type) ?? []) fn(event); }
  setPointerCapture() {}
  getBoundingClientRect() { return { left: 0, top: 0, width: 200, height: 200 }; }
}

const fakeDocument = new FakeNode('document');
fakeDocument.hidden = false;
fakeDocument.createElement = (tag) => new FakeNode(tag);
globalThis.document = fakeDocument;
const { TouchControls } = await import('./TouchControls.js');

const calls = [];
const input = {
  touchRecon: false,
  setTouchAxes: (...v) => calls.push(['axes', ...v]),
  setTouchThrottle: (v) => calls.push(['throttle', v]),
  toggleTouchRecon() { this.touchRecon = !this.touchRecon; calls.push(['recon']); },
  pressTouch: (v) => calls.push(['press', v]),
  releaseTouch: () => calls.push(['release']),
};
const root = new FakeNode('root');
const controls = new TouchControls(input, root);
let prevented = false;
controls.stickZone.dispatch('pointerdown', {
  pointerId: 1, clientX: 50, clientY: 60, preventDefault() { prevented = true; },
});
assert.deepEqual(calls, [], 'disabled controls must not mutate input state');
assert.equal(prevented, false, 'disabled controls must not intercept modal/page gestures');

controls.setEnabled(true);
controls.stickZone.dispatch('pointerdown', {
  pointerId: 2, clientX: 50, clientY: 60, preventDefault() { prevented = true; },
});
assert.equal(calls[0][0], 'axes', 'enabled stick must drive input');
controls.setEnabled(false);
assert.ok(calls.some(([kind]) => kind === 'release'), 'disabling controls must release held input');

controls.dispose();
assert.equal(root.children.length, 0, 'dispose must remove the owned touch layer');
assert.equal([...fakeDocument.listeners.values()].reduce((n, set) => n + set.size, 0), 0, 'dispose must remove document listeners');

console.log('touch control lifecycle contracts passed');
