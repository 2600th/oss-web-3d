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

test('pinch gestures are suppressed only when they start on an active flight control', () => {
  const { controls } = setup();
  let backgroundPrevented = false;
  controls.layer.dispatch('gesturestart', {
    target: controls.layer,
    preventDefault() { backgroundPrevented = true; },
  });
  assert.equal(backgroundPrevented, false, 'the full-screen touch layer must leave browser zoom available');

  let controlPrevented = false;
  controls.layer.dispatch('gesturestart', {
    target: { closest: () => controls.stickZone },
    preventDefault() { controlPrevented = true; },
  });
  assert.equal(controlPrevented, true, 'multi-touch flight input must not trigger browser zoom');
  controls.dispose();
});

test('touch CSS switches throttle and Boost without violating phone safe-area lanes', () => {
  const css = readFileSync(new URL('../ui/styles.css', import.meta.url), 'utf8');
  assert.match(css, /#touch\.assisted\s+\.throttle-zone[^}]*display:\s*none/s);
  assert.match(css, /#touch:not\(\.assisted\)\s+\.boost-btn[^}]*display:\s*none/s);
  assert.match(css, /#touch\.assisted\.recon-open\s+\.boost-btn[^}]*display:\s*none/s);
  // Safe-area insets are declared once on the rail's tokens now, so a notched
  // phone moves every action button by moving --act-edge and --act-bottom.
  assert.match(css, /--act-edge:\s*max\([^;]*safe-area-inset-right/s);
  assert.match(css, /--act-bottom:\s*max\([^;]*safe-area-inset-bottom/s);
  assert.match(css, /\.touch-btn\s*\{[^}]*right:\s*var\(--act-right\)/s);
  assert.match(css, /\.boost-btn\s*\{[^}]*bottom:\s*var\(--act-bottom\)/s);
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

function assertInside(control, viewport) {
  assert.ok(
    control.left >= 0 && control.top >= 0
      && control.right <= viewport.width && control.bottom <= viewport.height,
    `${control.name} must stay inside ${viewport.width}x${viewport.height}: ${JSON.stringify(control)}`,
  );
}

function lastRuleBody(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [...css.matchAll(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 'gs'))].at(-1)?.[1] ?? '';
}

/*
 * Layout tests read the stylesheet's own tokens rather than restating its
 * numbers.
 *
 * The previous version hardcoded every rectangle — 96x58 at (14, 96), 84x46 at
 * (126, 96), 84x46 at (84, 150), 44x44 at (84, 374) — and so it passed on a
 * layout where Shoot and Recon were different sizes in different columns and
 * the zoom buttons floated 172px above the shutter, in the middle of the
 * photograph. Every separation it checked held. The thing a player actually
 * complains about — that none of it lines up — was not among them. These derive
 * the geometry from --act-* and check alignment as well as clearance.
 */
function sliceBlocks(css) {
  const coarse = css.indexOf('@media (pointer: coarse) {');
  const portrait = css.indexOf('@media (pointer: coarse) and (max-height: 880px)');
  const landscape = css.indexOf('@media (pointer: coarse) and (max-height: 420px)');
  const altimeter = css.indexOf('/* Radar altimeter');
  assert.ok(coarse > 0 && portrait > coarse && landscape > portrait && altimeter > landscape,
    'the coarse-pointer layout blocks must appear in base / portrait / landscape order');
  return {
    base: css.slice(0, coarse),
    coarse: css.slice(coarse, portrait),
    portrait: css.slice(portrait, landscape),
    landscape: css.slice(landscape, altimeter),
  };
}

/** First px literal declared for a property, e.g. `max(14px, ...)` -> 14. */
function px(body, name) {
  const value = Number(body.match(new RegExp(`${name}:[^;]*?([\\d.]+)px`))?.[1]);
  assert.ok(Number.isFinite(value), `${name} must be declared with a px value`);
  return value;
}

function pct(body, name) {
  const value = Number(body.match(new RegExp(`${name}:\\s*([\\d.]+)%`))?.[1]);
  assert.ok(Number.isFinite(value), `${name} must be declared as a percentage`);
  return value;
}

function ruleValue(body, selector, property, pattern) {
  const rule = [...body.matchAll(new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`, 'gs'))].at(-1)?.[1] ?? '';
  const value = Number(rule.match(new RegExp(`${property}:\\s*${pattern}`))?.[1]);
  assert.ok(Number.isFinite(value), `${selector} must declare ${property}`);
  return value;
}

/**
 * The action rail, as the stylesheet describes it.
 *
 * Every button is one cell: `right` and `width` come from .touch-btn and only
 * the slot index varies. Reproducing that mechanism here rather than listing
 * rectangles is the point — a rule that drifts out of the column no longer has
 * a slot to be described by.
 */
function railFor(css, viewport, overrides = '') {
  const base = sliceBlocks(css).base;
  const read = (name) => (new RegExp(`${name}:`).test(overrides) ? px(overrides, name) : px(base, name));
  const w = read('--act-w');
  const h = read('--act-h');
  const gap = read('--act-gap');
  const right = new RegExp('--act-right:').test(overrides) ? px(overrides, '--act-right') : px(base, '--act-edge');
  const bottom = read('--act-bottom');
  const pitch = h + gap;
  const cell = (slot, height = h, name = 'action') =>
    rect(viewport.width - right - w, viewport.height - bottom - slot * pitch - height, w, height, name);
  return { w, h, gap, right, bottom, pitch, cell, lane: right + w + gap, zoomWidth: (w - gap) / 2 };
}

test('the action rail is one column: one width, one right edge, one pitch', () => {
  const css = readFileSync(new URL('../ui/styles.css', import.meta.url), 'utf8');
  // Geometry belongs to .touch-btn, so no individual button can invent its own.
  const shared = lastRuleBody(css, '.touch-btn');
  assert.match(shared, /right:\s*var\(--act-right\)/);
  assert.match(shared, /width:\s*var\(--act-w\)/);
  assert.match(shared, /height:\s*var\(--act-h\)/);
  for (const button of ['.boost-btn', '.recon-btn', '.shutter-btn']) {
    const body = [...css.matchAll(new RegExp(`\\${button}\\s*\\{([^}]*)\\}`, 'gs'))].map((m) => m[1]).join(' ');
    assert.doesNotMatch(body, /(?:^|[;{\s])width:/, `${button} must not restate the rail width`);
    assert.doesNotMatch(body, /(?:^|[;{\s])right:/, `${button} must not restate the rail's right edge`);
  }
  // Vertically, every button names a whole slot. Anything else — a raw pixel
  // offset, a half-pitch — is how Shoot and the zoom pair drifted 172px apart.
  const slot = (n) => (n === 0
    ? /^\s*bottom:\s*var\(--act-bottom\);/m
    : new RegExp(`^\\s*bottom:\\s*calc\\(var\\(--act-bottom\\) \\+ var\\(--act-pitch\\)${n > 1 ? ` \\* ${n}` : ''}\\);`, 'm'));
  for (const [selector, index] of [
    ['.boost-btn', 0],
    ['.recon-btn', 0],
    ['#touch.assisted .recon-btn', 1],
    ['#touch.assisted.recon-open .recon-btn', 0],
    ['.shutter-btn', 1],
    ['.zoom-btn', 2],
  ]) {
    assert.match(lastRuleBody(css, selector), slot(index), `${selector} must sit in slot ${index}`);
  }

  // The zoom pair fills exactly one cell, so the column keeps one left edge.
  const rail = railFor(css, { width: 402, height: 691 });
  assert.equal(rail.zoomWidth * 2 + rail.gap, rail.w);
  assert.ok(rail.zoomWidth >= 44, `zoom buttons are ${rail.zoomWidth}px wide, under the 44px touch minimum`);
  assert.match(lastRuleBody(css, '.zoom-in'), /right:\s*var\(--act-right\)/);
  assert.match(lastRuleBody(css, '.zoom-out'), /right:\s*calc\(var\(--act-right\)/);
  // Direct mode moves the whole column by moving the token, not the buttons.
  assert.match(css, /#touch:not\(\.assisted\)\s*\{[^}]*--act-right:/s);
});

test('the optical gate has one vertical inset, so it stays concentric with the reticle', () => {
  const css = readFileSync(new URL('../ui/styles.css', import.meta.url), 'utf8');
  // The reticle is drawn at 50%/50% and ReconCamera scores framing from the
  // optical axis. A gate with independent top and bottom insets puts the
  // best-scoring point off-centre in the frame that asks the pilot to aim.
  assert.doesNotMatch(css, /--gate-top\b/, 'the gate must not carry a separate top inset');
  assert.doesNotMatch(css, /--gate-bottom\b/, 'the gate must not carry a separate bottom inset');
  // The base rule, not a breakpoint's size override — its anchor is the invariant.
  assert.match(sliceBlocks(css).base.match(/\.recon-reticle\s*\{([^}]*)\}/s)[1], /top:\s*50%/);
  const frame = lastRuleBody(css, '.gate-frame');
  assert.match(frame, /top:\s*var\(--gate-y\)/);
  assert.match(frame, /bottom:\s*var\(--gate-y\)/);
  const declarations = [...css.matchAll(/#recon\s*\{([^}]*)\}/gs)].map((m) => m[1]).filter((b) => /--gate-y/.test(b));
  assert.ok(declarations.length >= 3, 'every breakpoint that moves the gate must set --gate-y');
  for (const body of declarations) {
    const y = pct(body, '--gate-y');
    assert.ok(y > 0 && y < 50, `--gate-y: ${y}% cannot describe a centred gate`);
  }
});

test('402x691 Assisted controls hold the flight and recon lanes and stay in column', () => {
  const css = readFileSync(new URL('../ui/styles.css', import.meta.url), 'utf8');
  const blocks = sliceBlocks(css);
  const gateX = pct(css.slice(css.indexOf('@media (max-width: 720px)')), '--gate-x');
  const gateY = pct(blocks.portrait, '--gate-y');
  const headTop = ruleValue(blocks.portrait, '.recon-head', 'top', 'max\\((\\d+)px');
  const qualityTop = ruleValue(blocks.portrait, '.quality', 'top', 'max\\((\\d+)px');
  const expTop = ruleValue(blocks.portrait, '.recon-frame-no', 'top', 'max\\((\\d+)px');
  const inset = px(blocks.portrait, '--tape-inset');
  const tapeWidth = ruleValue(blocks.coarse, '.tape', 'width', '(\\d+)px');
  const tapeTop = ruleValue(blocks.portrait, '.tape', 'top', 'max\\((\\d+)px');
  const tapeVh = ruleValue(blocks.portrait, '.tape', 'height', 'min\\((\\d+)vh');
  const tapeMax = ruleValue(blocks.portrait, '.tape', 'height', 'min\\(\\d+vh,\\s*(\\d+)px');
  const throttleVh = ruleValue(blocks.portrait, '.throttle-zone', 'height', 'min\\((\\d+)vh');
  const throttleMax = ruleValue(blocks.portrait, '.throttle-zone', 'height', 'min\\(\\d+vh,\\s*(\\d+)px');

  // The device class the layout is actually played on: a large phone in Safari
  // with both toolbars showing. It sits inside the portrait block, which is why
  // that block's cutoff is 880px rather than the 700px it used to be.
  for (const viewport of [
    { width: 402, height: 691 },
    { width: 390, height: 664 },
    { width: 430, height: 745 },
    { width: 375, height: 667 },
    { width: 320, height: 568 },
    { width: 393, height: 852 },
  ]) {
    const label = `${viewport.width}x${viewport.height}`;
    const rail = railFor(css, viewport);
    const boost = rail.cell(0, rail.h, 'Boost');
    const reconFlight = rail.cell(1, rail.h, 'Recon');
    const reconOpen = rail.cell(0, rail.h, 'Recon (camera up)');
    const shutter = rail.cell(1, rail.h, 'Shutter');
    const zoomRow = rail.cell(2, 44, 'zoom row');
    const zoomIn = rect(zoomRow.right - rail.zoomWidth, zoomRow.top, rail.zoomWidth, 44, 'Zoom in');
    const zoomOut = rect(zoomRow.left, zoomRow.top, rail.zoomWidth, 44, 'Zoom out');

    // Alignment, not just clearance — this is what a separation-only suite missed.
    for (const cell of [boost, reconFlight, shutter, zoomRow]) {
      assert.equal(cell.left, boost.left, `${cell.name} is out of column at ${label}`);
      assert.equal(cell.right, boost.right, `${cell.name} is out of column at ${label}`);
    }
    assert.equal(zoomIn.right, zoomRow.right, `zoom pair must reach the column edge at ${label}`);
    assert.equal(zoomOut.left, zoomRow.left, `zoom pair must reach the column edge at ${label}`);
    assert.equal(zoomOut.right + rail.gap, zoomIn.left);
    assert.equal(shutter.top - zoomRow.bottom, rail.gap, `zoom must sit one gap above Shoot at ${label}`);
    assert.equal(reconOpen.top - shutter.bottom, rail.gap, `Shoot must sit one gap above Recon at ${label}`);

    const stickWidth = Math.min(viewport.width * 0.42, 340);
    const stickHeight = Math.min(viewport.height * 0.38, 256);
    const stick = rect(0, viewport.height - stickHeight, stickWidth, stickHeight, 'stick');

    const tapeHeight = Math.min((viewport.height * tapeVh) / 100, tapeMax);
    const leftTape = rect(inset, tapeTop, tapeWidth, tapeHeight, 'left HUD tape');
    const rightTape = rect(viewport.width - inset - tapeWidth, tapeTop, tapeWidth, tapeHeight, 'right HUD tape');
    assert.equal(leftTape.left, viewport.width - rightTape.right,
      `the tapes must be a symmetric pair at ${label}`);

    const agl = rect(rightTape.left, tapeTop - 32, tapeWidth, 28, 'AGL badge');
    const objectives = rect(viewport.width - rail.right - 96, viewport.height - 8 - 51, 96, 51, 'objectives HUD');
    const targetWidth = Math.min(220, viewport.width * 0.56);
    const target = rect((viewport.width - targetWidth) / 2, 88, targetWidth, 51, 'target HUD');

    const flightHud = [leftTape, rightTape, agl, target, objectives];
    for (const control of [stick, boost, reconFlight]) {
      assertInside(control, viewport);
      for (const hud of flightHud) assertSeparated(control, hud);
    }
    assertSeparated(boost, reconFlight);
    assertSeparated(target, leftTape);
    assertSeparated(target, rightTape);

    // The edge cue dodges live HUD rectangles at runtime, so it follows the rail
    // wherever the rail goes — but its bounds come from the safe-area probe, and
    // on a phone with no notch every env() there is zero. --hud-margin floors it
    // so it keeps the same edge as everything else instead of touching the bezel.
    const margin = px(sliceBlocks(css).base, '--hud-margin');
    const cue = placeNavigationCue({
      viewport,
      safeInsets: { top: margin, right: margin, bottom: margin, left: margin },
      cueSize: { width: 112, height: 58 },
      edgeNdc: { x: 1, y: 0 },
      avoidRects: [stick, boost, reconFlight, ...flightHud],
      gap: 8,
    }).rect;
    cue.name = 'navigation cue';
    assertInside(cue, viewport);
    assert.ok(viewport.width - cue.right >= margin, `the cue must keep a ${margin}px margin at ${label}`);
    for (const obstacle of [stick, boost, reconFlight, ...flightHud]) assertSeparated(cue, obstacle);

    // Direct mode: the throttle keeps the bezel and the column steps inboard.
    const throttleHeight = Math.min((viewport.height * throttleVh) / 100, throttleMax);
    const throttle = rect(viewport.width - rail.right - 58, viewport.height - rail.bottom - throttleHeight,
      58, throttleHeight, 'Direct throttle');
    const directRail = railFor(css, viewport, `--act-right: ${rail.right + 58 + rail.gap}px`);
    assertSeparated(throttle, directRail.cell(0, directRail.h, 'Direct Recon'));
    assertSeparated(throttle, rightTape);
    assertSeparated(throttle, agl);
    assertInside(throttle, viewport);

    // Recon readouts live above the gate on a phone, clear of both thumbs.
    const gateTop = (viewport.height * gateY) / 100;
    const gateLeft = (viewport.width * gateX) / 100;
    assert.ok(Math.abs((gateTop + (viewport.height - gateTop)) / 2 - viewport.height / 2) < 0.001,
      `the gate must stay concentric with the reticle at ${label}`);
    const head = rect(gateLeft, headTop, viewport.width - 2 * gateLeft, 32, 'recon header');
    const quality = rect(gateLeft, qualityTop, viewport.width - 2 * gateLeft, 22, 'quality HUD');
    const exposure = rect(viewport.width - gateLeft - 47, expTop, 47, 9, 'exposure counter');
    // 62px is where the acquisition notice ends, and it does not scale with the
    // viewport — which is why these three are pinned rather than measured off
    // the gate.
    assert.ok(head.top >= 70, `the recon header must clear the notice at ${label}`);
    assertSeparated(head, quality);
    assertSeparated(quality, exposure);
    assert.ok(exposure.bottom + 8 <= gateTop, `the readouts must clear the gate at ${label}`);
    for (const control of [stick, reconOpen, shutter, zoomIn, zoomOut]) {
      assertInside(control, viewport);
      for (const readout of [head, quality, exposure]) assertSeparated(control, readout);
    }
  }
});

test('short landscape keeps the same column and a gate clear of it', () => {
  const css = readFileSync(new URL('../ui/styles.css', import.meta.url), 'utf8');
  const blocks = sliceBlocks(css);
  const overrides = blocks.landscape.match(/:root\s*\{([^}]*)\}/s)?.[1] ?? '';
  assert.match(overrides, /--act-h:/, 'landscape must retune the column through its tokens');
  const gateX = pct(blocks.landscape, '--gate-x');
  const gateY = pct(blocks.landscape, '--gate-y');
  const footGap = px(blocks.landscape, '--gate-foot-gap');
  const expGap = px(blocks.landscape, '--gate-exposure-gap');
  const headTop = ruleValue(blocks.landscape, '.recon-head', 'top', 'max\\((\\d+)px');
  const inset = px(blocks.landscape, '--tape-inset');
  const tapeWidth = ruleValue(blocks.landscape, '.tape', 'width', '(\\d+)px');
  const tapeTop = ruleValue(blocks.landscape, '.tape', 'top', 'max\\((\\d+)px');
  const throttleWidth = px(blocks.base, '--throttle-w');
  const throttleVh = ruleValue(blocks.landscape, '.throttle-zone', 'height', 'min\\((\\d+)vh');
  const throttleMax = ruleValue(blocks.landscape, '.throttle-zone', 'height', 'min\\(\\d+vh,\\s*(\\d+)px');
  const actGap = px(blocks.base, '--act-gap');
  const actEdge = px(blocks.base, '--act-edge');
  const actW = px(blocks.base, '--act-w');
  // The lane anything outside #touch has to leave: it cannot see the per-mode
  // --act-right override, so it clears the *Direct* column, which is the wider
  // of the two. Everything below is checked in that mode, because the previous
  // suite checked Assisted only and Direct is where the throttle strip exists.
  const laneMax = actEdge + throttleWidth + actGap + actW + actGap;

  for (const viewport of [
    { width: 568, height: 320 },
    { width: 667, height: 375 },
    { width: 844, height: 390 },
  ]) {
    const label = `${viewport.width}x${viewport.height}`;
    const rail = railFor(css, viewport, overrides);
    const recon = rail.cell(0, rail.h, 'Recon');
    const shutter = rail.cell(1, rail.h, 'Shutter');
    const zoomRow = rail.cell(2, 44, 'zoom row');
    for (const cell of [recon, shutter, zoomRow]) {
      assertInside(cell, viewport);
      assert.equal(cell.right, recon.right, `${cell.name} is out of column at ${label}`);
    }
    assertSeparated(zoomRow, shutter);
    assertSeparated(shutter, recon);

    const stickWidth = Math.min(viewport.width * 0.42, 340);
    const stickHeight = Math.min(viewport.height * 0.38, 256);
    const stick = rect(0, viewport.height - stickHeight, stickWidth, stickHeight, 'stick');

    const tapeHeight = Math.min(viewport.height * 0.22, 84);
    const leftTape = rect(inset, tapeTop, tapeWidth, tapeHeight, 'left HUD tape');
    const rightTape = rect(viewport.width - inset - tapeWidth, tapeTop, tapeWidth, tapeHeight, 'right HUD tape');
    assert.equal(leftTape.left, viewport.width - rightTape.right, `the tapes must stay symmetric at ${label}`);
    for (const cell of [recon, shutter, zoomRow]) assertSeparated(cell, rightTape);
    assertSeparated(stick, rightTape);

    // The landscape gate is narrow enough to stay off the column entirely.
    const gateLeft = (viewport.width * gateX) / 100;
    const gateTop = (viewport.height * gateY) / 100;
    const gate = rect(gateLeft, gateTop, viewport.width - 2 * gateLeft, viewport.height - 2 * gateTop, 'optical gate');
    assert.ok(Math.abs((gate.top + gate.bottom) / 2 - viewport.height / 2) < 0.001,
      `the gate must stay concentric with the reticle at ${label}`);
    for (const cell of [recon, shutter, zoomRow]) assertSeparated(cell, gate);

    // The header clears the acquisition notice and stays in the gate's upper
    // half. It is not held off the gate itself: on a 320px-tall landscape
    // screen there is no band between the notice at y=62 and a gate big enough
    // to hold the reticle, so the header sits over the top of the frame the way
    // a viewfinder overlay does. Above it — where a taller screen has room — is
    // what the percentage buys.
    const head = rect(gateLeft, headTop, gate.width, 26, 'recon header');
    assert.ok(head.top >= 70, `the header must clear the notice at ${label}`);
    assert.ok(head.bottom < gate.top + gate.height / 2, `the header must stay at the top at ${label}`);
    assert.equal(head.left, gate.left, `the header must keep the gate's width at ${label}`);
    assert.equal(head.right, gate.right, `the header must keep the gate's width at ${label}`);
    // The readouts take whichever right edge is further inboard, the gate's or
    // the Direct-mode lane.
    const readoutRight = Math.max(gateLeft, laneMax);
    const quality = rect(stickWidth + 8, viewport.height - (gateTop - footGap) - 22,
      viewport.width - readoutRight - stickWidth - 8, 22, 'quality HUD');
    const exposure = rect(viewport.width - readoutRight - 47, viewport.height - (gateTop - expGap) - 9,
      47, 9, 'exposure counter');
    for (const readout of [quality, exposure]) {
      assertInside(readout, viewport);
      assertSeparated(stick, readout);
      for (const cell of [recon, shutter, zoomRow]) assertSeparated(cell, readout);
    }
    assertSeparated(quality, exposure);

    // Direct mode: the throttle strip takes the bezel, the column steps inboard
    // of it, and the objectives block clears the column in that wider state.
    // The tapes are back on the bezel now, so the strip has to stay under them.
    const directRail = railFor(css, viewport, `${overrides}\n--act-right: ${actEdge + throttleWidth + actGap}px;`);
    const throttleHeight = Math.min((viewport.height * throttleVh) / 100, throttleMax);
    const throttle = rect(viewport.width - actEdge - throttleWidth,
      viewport.height - directRail.bottom - throttleHeight, throttleWidth, throttleHeight, 'Direct throttle');
    const agl = rect(rightTape.left, tapeTop + tapeHeight + 6, tapeWidth, 28, 'AGL badge');
    const objectives = rect(viewport.width - laneMax - 95, viewport.height - 8 - 51, 95, 51, 'objectives HUD');
    assertInside(throttle, viewport);
    assertInside(objectives, viewport);
    assertSeparated(throttle, rightTape);
    assertSeparated(throttle, agl);
    for (const cell of [0, 1, 2].map((n) => directRail.cell(n, n === 2 ? 44 : directRail.h, `Direct slot ${n}`))) {
      assertInside(cell, viewport);
      assertSeparated(cell, throttle);
      assertSeparated(cell, rightTape);
      assertSeparated(cell, objectives);
      assertSeparated(cell, quality);
      assertSeparated(cell, exposure);
    }
  }
});

