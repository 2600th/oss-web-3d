import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

class FakeNode {
  constructor(tag = 'div') {
    this.tag = tag;
    this.children = [];
    this.parentNode = null;
    this.style = {};
    this.listeners = new Map();
    this.attributes = new Map();
    const classes = new Set();
    this.classList = {
      toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)),
      contains: (name) => classes.has(name),
    };
  }
  appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
  remove() {
    if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((node) => node !== this);
    this.parentNode = null;
  }
  setAttribute(name, value) { this.attributes.set(name, value); }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
  }
  removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
  dispatch(type, event = {}) {
    event.preventDefault ??= () => {};
    for (const fn of this.listeners.get(type) ?? []) fn(event);
  }
  setPointerCapture() {}
  getBoundingClientRect() { return { left: 0, top: 0, width: 200, height: 200 }; }
}

const fakeWindow = new FakeNode('window');
const fakeDocument = new FakeNode('document');
fakeDocument.hidden = false;
fakeDocument.defaultView = fakeWindow;
fakeWindow.document = fakeDocument;
fakeDocument.createElement = (tag) => {
  const node = new FakeNode(tag);
  node.ownerDocument = fakeDocument;
  return node;
};
globalThis.document = fakeDocument;
const { TouchControls } = await import('./TouchControls.js');
const { Input } = await import('./Input.js');
const { placeNavigationCue } = await import('../ui/NavigationCue.js');

function setup() {
  const calls = [];
  const input = {
    touchRecon: false,
    setTouchAxes: (...values) => calls.push(['axes', ...values]),
    setTouchThrottle: (value) => calls.push(['throttle', value]),
    setTouchBoost: (held) => calls.push(['boost', held]),
    toggleTouchRecon() { this.touchRecon = !this.touchRecon; calls.push(['recon']); },
    pressTouch: (value) => calls.push(['press', value]),
    releaseTouch: () => calls.push(['release']),
  };
  const root = new FakeNode('root');
  root.ownerDocument = fakeDocument;
  const controls = new TouchControls(input, root);
  controls.setEnabled(true);
  return { calls, input, root, controls };
}

function pointer(pointerId, clientX, clientY) {
  return { pointerId, clientX, clientY, preventDefault() {} };
}

function latestAxes(calls) {
  const entry = calls.findLast(([kind]) => kind === 'axes');
  assert.ok(entry, 'stick must emit axes');
  const [, pitch, roll] = entry;
  return { pitch, roll, magnitude: Math.hypot(pitch, roll) };
}

function drag(controls, calls, dx, dy, pointerId = 1) {
  controls.stickZone.dispatch('pointerdown', pointer(pointerId, 100, 100));
  controls.stickZone.dispatch('pointermove', pointer(pointerId, 100 + dx, 100 + dy));
  return latestAxes(calls);
}

test('Assisted stick uses one radial deadzone and uniform directional shaping', (t) => {
  const cardinalSetup = setup();
  t.after(() => cardinalSetup.controls.dispose());
  cardinalSetup.controls.setMode('assisted');
  const cardinal = drag(cardinalSetup.controls, cardinalSetup.calls, 34, 0);

  const diagonalSetup = setup();
  t.after(() => diagonalSetup.controls.dispose());
  diagonalSetup.controls.setMode('assisted');
  const component = 34 / Math.sqrt(2);
  const diagonal = drag(diagonalSetup.controls, diagonalSetup.calls, component, component);

  assert.ok(Math.abs(cardinal.magnitude - diagonal.magnitude) <= 0.05,
    `cardinal ${cardinal.magnitude} and diagonal ${diagonal.magnitude} must feel equally strong`);

  const deadzoneSetup = setup();
  t.after(() => deadzoneSetup.controls.dispose());
  deadzoneSetup.controls.setMode('assisted');
  const insideDeadzone = drag(deadzoneSetup.controls, deadzoneSetup.calls, 4, 4);
  assert.equal(insideDeadzone.magnitude, 0);

  const saturatedSetup = setup();
  t.after(() => saturatedSetup.controls.dispose());
  saturatedSetup.controls.setMode('assisted');
  const beyondRing = drag(saturatedSetup.controls, saturatedSetup.calls, 200, 200);
  assert.ok(Math.abs(beyondRing.magnitude - 1) < 1e-6, 'dragging beyond the ring must stay saturated');

});

test('upward Assisted drag produces semantic climb=1 through the real Input seam', () => {
  const target = new FakeNode('window');
  target.document = fakeDocument;
  const input = new Input(target);
  const root = new FakeNode('root');
  const controls = new TouchControls(input, root);
  controls.setEnabled(true);
  controls.setMode('assisted');
  const calls = [];
  const setAxes = input.setTouchAxes.bind(input);
  input.setTouchAxes = (pitch, roll) => { calls.push(['axes', pitch, roll]); setAxes(pitch, roll); };
  const upward = drag(controls, calls, 0, -68);
  input.update(1 / 60);
  assert.equal(upward.pitch, -1);
  assert.equal(input.intent.climb, 1);
  controls.dispose();
  input.dispose();
});

test('Assisted mode disables throttle and exposes momentary Boost down, up, and cancel', () => {
  const { calls, controls } = setup();
  controls.setMode('assisted');
  assert.equal(controls.throttleZone.getAttribute?.('aria-hidden') ?? controls.throttleZone.attributes.get('aria-hidden'), 'true');
  assert.equal(controls.boostButton.getAttribute?.('aria-hidden') ?? controls.boostButton.attributes.get('aria-hidden'), 'false');

  controls.throttleZone.dispatch('pointerdown', pointer(2, 190, 20));
  assert.equal(calls.some(([kind]) => kind === 'throttle'), false, 'hidden Assisted throttle cannot mutate input');

  controls.boostButton.dispatch('pointerdown', pointer(3, 0, 0));
  controls.boostButton.dispatch('pointerup', pointer(3, 0, 0));
  controls.boostButton.dispatch('pointerdown', pointer(4, 0, 0));
  controls.boostButton.dispatch('pointercancel', pointer(4, 0, 0));
  assert.deepEqual(calls.filter(([kind]) => kind === 'boost'), [
    ['boost', true], ['boost', false], ['boost', true], ['boost', false],
  ]);
  controls.dispose();
});

test('switching mode releases stick and Boost state before exposing Direct controls', () => {
  const { calls, controls } = setup();
  controls.setMode('assisted');
  drag(controls, calls, 50, 0, 5);
  controls.boostButton.dispatch('pointerdown', pointer(6, 0, 0));
  calls.length = 0;

  controls.setMode('direct');

  assert.ok(calls.some(([kind]) => kind === 'release'));
  assert.ok(calls.some(([kind, held]) => kind === 'boost' && held === false));
  assert.equal(controls.throttleZone.attributes.get('aria-hidden'), 'false');
  assert.equal(controls.boostButton.attributes.get('aria-hidden'), 'true');
  controls.dispose();
});

test('Direct mode preserves legacy component-shaped stick, throttle, and recon behavior', () => {
  const { calls, input, controls } = setup();
  controls.setMode('direct');
  const diagonal = drag(controls, calls, 34, -34);
  const legacyComponent = ((0.5 - 0.12) / (1 - 0.12)) ** 1.35;
  assert.ok(Math.abs(diagonal.pitch + legacyComponent) < 1e-6);
  assert.ok(Math.abs(diagonal.roll - legacyComponent) < 1e-6);

  controls.throttleZone.dispatch('pointerdown', pointer(7, 190, 50));
  assert.ok(calls.some(([kind, value]) => kind === 'throttle' && Math.abs(value - 0.75) < 1e-6));
  controls.reconButton.dispatch('pointerdown', pointer(8, 0, 0));
  assert.equal(input.touchRecon, true);
  assert.ok(calls.some(([kind]) => kind === 'recon'));
  controls.dispose();
});

test('disable and dispose clear held state and remove every listener', () => {
  const { calls, root, controls } = setup();
  controls.setMode('assisted');
  controls.boostButton.dispatch('pointerdown', pointer(9, 0, 0));
  calls.length = 0;
  controls.setEnabled(false);
  assert.ok(calls.some(([kind]) => kind === 'release'));
  assert.ok(calls.some(([kind, held]) => kind === 'boost' && held === false));

  controls.dispose();
  assert.equal(root.children.length, 0);
  assert.equal([...fakeDocument.listeners.values()].reduce((count, set) => count + set.size, 0), 0);
  assert.equal([...fakeWindow.listeners.values()].reduce((count, set) => count + set.size, 0), 0);
});

test('window blur releases held Boost and permits a fresh pointerdown', (t) => {
  const { calls, controls } = setup();
  t.after(() => controls.dispose());
  controls.setMode('assisted');
  controls.boostButton.dispatch('pointerdown', pointer(14, 0, 0));
  assert.equal(controls._boostId, 14);
  calls.length = 0;

  fakeWindow.dispatch('blur');

  assert.equal(controls._boostId, null);
  assert.ok(calls.some(([kind]) => kind === 'release'));
  assert.ok(calls.some(([kind, held]) => kind === 'boost' && held === false));
  calls.length = 0;
  controls.boostButton.dispatch('pointerdown', pointer(15, 0, 0));
  assert.equal(controls._boostId, 15);
  assert.deepEqual(calls.filter(([kind]) => kind === 'boost'), [['boost', true]]);
});

test('real Input boost intent clears on defaultView blur and re-arms on a fresh press', (t) => {
  const input = new Input(fakeWindow);
  const root = new FakeNode('root');
  root.ownerDocument = fakeDocument;
  const controls = new TouchControls(input, root);
  controls.setEnabled(true);
  controls.setMode('assisted');
  t.after(() => {
    controls.dispose();
    input.dispose();
  });

  controls.boostButton.dispatch('pointerdown', pointer(16, 0, 0));
  input.update(1 / 60);
  assert.equal(input.intent.boost, true);
  assert.equal(controls._boostId, 16);

  fakeWindow.dispatch('blur');
  assert.equal(controls._boostId, null);
  input.update(1 / 60);
  assert.equal(input.intent.boost, false);

  controls.boostButton.dispatch('pointerdown', pointer(17, 0, 0));
  input.update(1 / 60);
  assert.equal(controls._boostId, 17);
  assert.equal(input.intent.boost, true);
});

test('disabled controls ignore stick, throttle, Boost, and recon pointers', () => {
  const { calls, controls } = setup();
  controls.setEnabled(false);
  calls.length = 0;
  controls.stickZone.dispatch('pointerdown', pointer(10, 50, 50));
  controls.throttleZone.dispatch('pointerdown', pointer(11, 190, 20));
  controls.boostButton.dispatch('pointerdown', pointer(12, 0, 0));
  controls.reconButton.dispatch('pointerdown', pointer(13, 0, 0));
  assert.deepEqual(calls, []);
  controls.dispose();
});

test('touch CSS switches throttle and Boost without violating phone safe-area lanes', () => {
  const css = readFileSync(new URL('../ui/styles.css', import.meta.url), 'utf8');
  assert.match(css, /#touch\.assisted\s+\.throttle-zone[^}]*display:\s*none/s);
  assert.match(css, /#touch:not\(\.assisted\)\s+\.boost-btn[^}]*display:\s*none/s);
  assert.match(css, /#touch\.assisted\.recon-open\s+\.boost-btn[^}]*display:\s*none/s);
  assert.match(css, /\.boost-btn\s*\{[^}]*right:\s*max\([^}]*safe-area-inset-right/s);
  assert.match(css, /\.boost-btn\s*\{[^}]*bottom:\s*max\([^}]*safe-area-inset-bottom/s);
});

function rect(left, top, width, height, name) {
  return { left, top, right: left + width, bottom: top + height, width, height, name };
}

function separation(a, b) {
  return Math.max(b.left - a.right, a.left - b.right, b.top - a.bottom, a.top - b.bottom);
}

function assertSeparated(a, b, gap = 8) {
  assert.ok(separation(a, b) >= gap,
    `${a.name} and ${b.name} need ${gap}px separation, got ${separation(a, b).toFixed(1)}px`);
}

function lastRuleBody(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [...css.matchAll(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 'gs'))].at(-1)?.[1] ?? '';
}

test('390x844 Assisted controls maintain eight-pixel flight and recon safe rectangles', () => {
  const css = readFileSync(new URL('../ui/styles.css', import.meta.url), 'utf8');
  const viewport = { width: 390, height: 844 };
  const stickBodies = [...css.matchAll(/\.stick-zone\s*\{([^}]*)\}/gs)];
  const stickMatch = stickBodies.at(-1)?.[1].match(/height:\s*min\((\d+)vh,\s*(\d+)px\)/);
  assert.ok(stickMatch, 'the active coarse-pointer stick height must be explicit');
  const stickHeight = Math.min(viewport.height * Number(stickMatch[1]) / 100, Number(stickMatch[2]));
  const qualityBottom = Number(lastRuleBody(css, '.quality').match(/bottom:\s*max\((\d+)px/)?.[1]);
  assert.ok(Number.isFinite(qualityBottom), 'coarse-pointer quality safe lane must have an explicit bottom');

  const stick = rect(0, viewport.height - stickHeight, Math.min(viewport.width * 0.42, 340), stickHeight, 'stick');
  const boost = rect(viewport.width - 14 - 96, viewport.height - 96 - 58, 96, 58, 'Boost');
  const recon = rect(viewport.width - 126 - 84, viewport.height - 96 - 46, 84, 46, 'Recon');
  const shutter = rect(viewport.width - 84 - 84, viewport.height - 150 - 46, 84, 46, 'Shutter');
  const zoomIn = rect(viewport.width - 84 - 44, viewport.height - 374 - 44, 44, 44, 'Zoom in');
  const zoomOut = rect(viewport.width - 84 - 44, viewport.height - 322 - 44, 44, 44, 'Zoom out');

  const leftTape = rect(5, (viewport.height - 300) / 2, 56, 300, 'left HUD tape');
  const rightTape = rect(viewport.width - 92 - 56, (viewport.height - 300) / 2, 56, 300, 'right HUD tape');
  const target = rect((viewport.width - 220) / 2, 88, 220, 58, 'target HUD');
  const objectives = rect(viewport.width - 92 - 96, viewport.height - 8 - 38, 96, 38, 'objectives HUD');
  const normalHud = [leftTape, rightTape, target, objectives];
  const normalTouch = [stick, boost, recon];
  for (const control of normalTouch) {
    for (const hud of normalHud) assertSeparated(control, hud);
  }
  for (let i = 0; i < normalTouch.length; i += 1) {
    for (let j = i + 1; j < normalTouch.length; j += 1) assertSeparated(normalTouch[i], normalTouch[j]);
  }

  const flightNavigation = placeNavigationCue({
    viewport,
    cueSize: { width: 112, height: 58 },
    edgeNdc: { x: 1, y: 0 },
    avoidRects: [...normalTouch, ...normalHud],
    gap: 8,
  }).rect;
  flightNavigation.name = 'flight navigation cue';
  for (const obstacle of [...normalTouch, ...normalHud]) assertSeparated(flightNavigation, obstacle);

  const reconHead = rect(14, 70, viewport.width - 28, 32, 'recon header');
  const quality = rect(16, viewport.height - qualityBottom - 34, viewport.width - 16 - 92, 34, 'quality HUD');
  const reconControls = [stick, recon, shutter, zoomIn, zoomOut];
  const reconHud = [reconHead, quality];
  for (let i = 0; i < reconControls.length; i += 1) {
    for (let j = i + 1; j < reconControls.length; j += 1) assertSeparated(reconControls[i], reconControls[j]);
  }
  for (const control of reconControls) {
    for (const hud of reconHud) assertSeparated(control, hud);
  }
});
