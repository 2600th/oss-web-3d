import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const here = new URL('./', import.meta.url);
const [hud, screens, css, game, indexHtml] = await Promise.all([
  readFile(new URL('Hud.js', here), 'utf8'),
  readFile(new URL('Screens.js', here), 'utf8'),
  readFile(new URL('styles.css', here), 'utf8'),
  readFile(new URL('../game/Game.js', here), 'utf8'),
  readFile(new URL('../../index.html', here), 'utf8'),
]);

test('HUD owns the navigation cue lifecycle and navigation CSS stays unfilled and calm', () => {
  assert.match(hud, /new NavigationCue\(this\.root, this\.headingStrip\)/);
  assert.match(hud, /this\.navigationCue\.update\(\{[\s\S]*?\.\.\.s\.navigation/);
  assert.match(hud, /targetCallsign:\s*s\.target\?\.callsign/);
  assert.match(hud, /targetRange:\s*s\.targetRange/);
  assert.match(hud, /this\.navigationCue\.dispose\(\)/);
  // The cue is an arrow and a label. The search bracket and acquisition
  // corner-frame are gone: both were fixed-size reticles the label could never
  // fit inside, and it ran out through their borders.
  assert.doesNotMatch(css, /\.nav-search-bracket/);
  assert.doesNotMatch(css, /\.nav-acquisition/);
  assert.match(css, /\.navigation-cue\s*\{[^}]*width:\s*max-content/);
  assert.match(css, /\.navigation-cue\.turn-left \.nav-edge-left[\s\S]*?display:\s*block/);
  assert.match(css, /\.navigation-cue\.turn-right \.nav-edge-right[\s\S]*?display:\s*block/);
  // Phone tightens the type rather than pinning a box round it.
  assert.match(
    css,
    /@media \(max-width: 720px\), \(max-aspect-ratio: 3 \/ 4\)[\s\S]*?\.nav-direction\s*\{[^}]*font-size:\s*9px/,
  );
  assert.match(
    css,
    /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.navigation-cue[\s\S]*?transition:\s*none/,
  );
});

globalThis.window = {
  matchMedia: () => ({ matches: false }),
};
// Document listeners are recorded rather than discarded so the notice tests can
// drive a real visibilitychange instead of poking the timer internals.
const documentListeners = new Map();
globalThis.document = {
  visibilityState: 'visible',
  createElement: (tag) => {
    if (tag !== 'canvas') return {};
    return {
      getContext: () => ({
        font: '',
        measureText: (value) => ({ width: value.length * 8 }),
      }),
    };
  },
  addEventListener: (type, fn) => {
    if (!documentListeners.has(type)) documentListeners.set(type, new Set());
    documentListeners.get(type).add(fn);
  },
  removeEventListener: (type, fn) => documentListeners.get(type)?.delete(fn),
  dispatchVisibility: (state) => {
    globalThis.document.visibilityState = state;
    for (const fn of documentListeners.get('visibilitychange') ?? []) fn();
  },
};
globalThis.cancelAnimationFrame = () => {};

const ScreenModule = await import('./Screens.js');
const { Screens, controlRows } = ScreenModule;

class FakeElement {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.attributes = new Map();
    this.listeners = new Map();
    this.className = '';
    this.textContent = '';
    this.value = '';
    this.style = {};
    this._classes = new Set();
    this.classList = {
      add: (...names) => { for (const n of names) this._classes.add(n); },
      remove: (...names) => { for (const n of names) this._classes.delete(n); },
      contains: (name) => this._classes.has(name),
    };
  }

  /** Only the `= ''` clear-out form is used, which is all this needs to model. */
  get innerHTML() { return ''; }

  set innerHTML(value) {
    if (value === '') this.children.length = 0;
  }

  appendChild(child) {
    this.children.push(child);
    child.parentElement = this;
    return child;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  addEventListener(type, handler) {
    this.listeners.set(type, handler);
  }

  removeEventListener(type, handler) {
    if (this.listeners.get(type) === handler) this.listeners.delete(type);
  }

  dispatch(type) {
    this.listeners.get(type)?.({ type, preventDefault() {} });
  }

  contains(node) {
    if (node === this) return true;
    return this.children.some((child) => child.contains?.(node));
  }

  focus() {}
}

function buildPause() {
  const original = document.createElement;
  document.createElement = (tag) => new FakeElement(tag);
  try {
    const instance = Object.assign(Object.create(Screens.prototype), {
      callbacks: {
        onResume() {},
        onRestart() {},
        onQuality() {},
        onMasterVolume() {},
        onMusicVolume() {},
        onControlMode() {},
        onControlSensitivity() {},
        onAutoThrottle() {},
        onVerticalMode() {},
      },
    });
    instance._buildPause();
    return instance;
  } finally {
    document.createElement = original;
  }
}

function ruleBody(selector, last = false) {
  const start = last ? css.lastIndexOf(selector) : css.indexOf(selector);
  assert.notEqual(start, -1, `missing CSS rule ${selector}`);
  const open = css.indexOf('{', start);
  const close = css.indexOf('}', open);
  return css.slice(open + 1, close);
}

function leadingPx(body, property) {
  const match = body.match(new RegExp(`${property}:\\s*(?:max\\()?([0-9]+)px`));
  assert.ok(match, `missing ${property} pixel anchor in ${body}`);
  return Number(match[1]);
}

function directPx(body, property) {
  const match = body.match(new RegExp(`${property}:\\s*([0-9]+)px`));
  assert.ok(match, `missing ${property} in ${body}`);
  return Number(match[1]);
}

test('recon visibility keeps visual, DOM, and assistive states in sync', () => {
  assert.match(
    hud,
    /setAriaHidden\(this\.recon, !s\.reconActive\)/,
    'the active recon surface must not remain aria-hidden',
  );
  assert.match(
    hud,
    /toggle\(this\.root, 'recon-open', s\.reconActive\)/,
    'the flight HUD needs an explicit recon composition state',
  );
  assert.match(css, /#hud\.recon-open[\s\S]*?\.tape/, 'recon mode must remove competing flight tapes');
});

test('dialogs expose modal semantics, trap focus, and restore the invoking control', () => {
  assert.match(screens, /setAttribute\('aria-modal', 'true'\)/);
  assert.match(screens, /_trapDialogFocus\(event\)/);
  assert.match(screens, /_returnFocus/);
  assert.match(screens, /getClientRects\(\)\.length/);
  assert.match(
    screens,
    /querySelectorAll\(FOCUSABLE_SELECTOR\)/,
    'focus must be selected from a filtered visible-control collection',
  );
  assert.doesNotMatch(
    screens,
    /layer\.querySelector\('button:not\(\[disabled\]\)'\)/,
    'generic first-button focus selects the hidden success card on failed debriefs',
  );
});

test('reduced-motion title bypasses inline fades and the cinematic wait', () => {
  assert.match(screens, /REDUCED_MOTION \? 'none' : 'opacity 1100ms ease'/);
  assert.match(screens, /const stages = REDUCED_MOTION\s*\?/);
  assert.match(screens, /node: this\.titlePrompt, at: 0, hold: Infinity/);
});

test('title prompt remains inert until the live reveal state', () => {
  const base = css.match(/\.prompt\s*\{([\s\S]*?)\}/)?.[1] ?? '';
  const live = css.match(/\.prompt\.live\s*\{([\s\S]*?)\}/)?.[1] ?? '';
  assert.match(base, /animation:\s*none/, 'the hidden prompt must not have an opacity animation');
  assert.match(base, /pointer-events:\s*none/, 'the hidden prompt must not intercept pointer input');
  assert.match(live, /animation:\s*pulse/, 'the pulse begins only when the prompt is revealed');
  assert.match(live, /pointer-events:\s*auto/, 'the revealed prompt becomes interactive');
});

test('visible focus collection excludes explicit negative tab order', () => {
  let focused = '';
  const excluded = {
    tabIndex: -1,
    closest: () => null,
    getClientRects: () => [{}],
    focus: () => {
      focused = 'excluded';
    },
  };
  const included = {
    tabIndex: 0,
    closest: () => null,
    getClientRects: () => [{}],
    focus: () => {
      focused = 'included';
    },
  };
  const layer = {
    querySelectorAll: () => [excluded, included],
    contains: () => false,
  };
  const instance = Object.assign(Object.create(Screens.prototype), { current: layer });
  instance._trapDialogFocus({
    key: 'Tab',
    shiftKey: false,
    preventDefault: () => {},
  });
  assert.equal(focused, 'included');
});

test('disposing an active dialog restores its opener before removal', () => {
  let focusOptions = null;
  const opener = {
    isConnected: true,
    focus: (options) => {
      focusOptions = options;
    },
  };
  let removals = 0;
  const removable = { remove: () => removals++ };
  const instance = Object.assign(Object.create(Screens.prototype), {
    _destroyed: false,
    _onDialogKeyDown: () => {},
    _focusFrame: 0,
    _returnFocus: opener,
    _titleCleanup: null,
    _raf: 0,
    _loadingRemoveTimer: 0,
    current: removable,
    veil: removable,
    noticeBar: removable,
    loadingLayer: removable,
    titleLayer: removable,
    briefingLayer: removable,
    debriefLayer: removable,
    pauseLayer: removable,
  });

  instance.dispose();

  assert.deepEqual(focusOptions, { preventScroll: true });
  assert.equal(removals, 7);
  assert.equal(instance.current, null);
});

test('phone CSS uses the live HUD class names and reserves modal and touch safe zones', () => {
  assert.doesNotMatch(css, /#hud \.target-callout/);
  assert.match(css, /#hud \.target-block/);
  assert.match(css, /\.target-list \.id/);
  assert.match(
    css,
    /\.layer\.show ~ #touch[\s\S]*?pointer-events:\s*none/,
    'touch flight zones must not intercept modal actions',
  );
  assert.match(css, /@media \(pointer: coarse\)[\s\S]*?\.recon-head/);
  assert.match(css, /@media \(pointer: coarse\)[\s\S]*?\.quality/);
});

test('browser zoom remains available outside active flight controls', () => {
  assert.match(indexHtml, /content="width=device-width, initial-scale=1, viewport-fit=cover"/);
  assert.doesNotMatch(indexHtml, /maximum-scale|user-scalable/i);
  assert.match(css, /#viewport\s*\{[^}]*touch-action:\s*manipulation/s);
  assert.match(css, /#touch\s*\{[^}]*touch-action:\s*manipulation/s);
  assert.match(css, /\.touch-zone\s*\{[^}]*touch-action:\s*none/s);
  assert.match(css, /\.touch-btn\s*\{[^}]*touch-action:\s*none/s);
});

test('coarse-pointer pause controls retain a 44px touch target', () => {
  assert.match(
    css,
    /@media \(pointer: coarse\)[\s\S]*?\.menu \.segmented button,[\s\S]*?\.menu button\.toggle,[\s\S]*?\.menu \.quality-row button,[\s\S]*?\.menu input\[type='range'\][\s\S]*?min-height:\s*44px/,
  );
});

test('390x844 recon zoom controls clear the throttle and each other by at least 8px', () => {
  const viewport = { width: 390, height: 844 };
  const throttleCss = ruleBody('.throttle-zone');
  const zoomCss = ruleBody('.zoom-btn', true);
  const zoomInCss = ruleBody('.zoom-in');
  const zoomOutCss = ruleBody('.zoom-out');
  const throttleHeight = Number(throttleCss.match(/height:\s*min\([^,]+,\s*([0-9]+)px\)/)?.[1]);
  assert.ok(Number.isFinite(throttleHeight));

  const rect = ({ right, bottom, width, height }) => ({
    left: viewport.width - right - width,
    right: viewport.width - right,
    top: viewport.height - bottom - height,
    bottom: viewport.height - bottom,
    width,
    height,
  });
  const throttle = rect({
    right: leadingPx(throttleCss, 'right'),
    bottom: leadingPx(throttleCss, 'bottom'),
    width: directPx(throttleCss, 'width'),
    height: Math.min(viewport.height * 0.4, throttleHeight),
  });
  const zoomWidth = directPx(zoomCss, 'width');
  const zoomHeight = directPx(zoomCss, 'height');
  const zoomIn = rect({
    right: leadingPx(zoomInCss, 'right'),
    bottom: leadingPx(zoomInCss, 'bottom'),
    width: zoomWidth,
    height: zoomHeight,
  });
  const zoomOut = rect({
    right: leadingPx(zoomOutCss, 'right'),
    bottom: leadingPx(zoomOutCss, 'bottom'),
    width: zoomWidth,
    height: zoomHeight,
  });

  assert.ok(zoomWidth >= 44 && zoomHeight >= 44, `zoom target is only ${zoomWidth}x${zoomHeight}`);
  assert.ok(throttle.left - zoomOut.right >= 8, `zoom/throttle gap is ${throttle.left - zoomOut.right}px`);
  assert.ok(zoomOut.top - zoomIn.bottom >= 8, `zoom button gap is ${zoomOut.top - zoomIn.bottom}px`);
});

test('phone quality is represented by a real selected pause-menu choice', () => {
  assert.deepEqual(ScreenModule.QUALITY_CHOICES, ['phone', 'low', 'medium', 'high']);
  const screensInstance = buildPause();
  screensInstance.setQuality('phone');
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(screensInstance.qualityButtons).map(([name, button]) => [
        name,
        button.getAttribute('aria-pressed'),
      ]),
    ),
    { phone: 'true', low: 'false', medium: 'false', high: 'false' },
  );
});

test('control rows match the selected mode and active input modality', () => {
  assert.deepEqual(controlRows('assisted', 'keyboard')[0], ['W / Up', 'Climb']);
  assert.deepEqual(controlRows('assisted', 'keyboard')[1], ['S / Down', 'Descend']);
  assert.equal(
    controlRows('assisted', 'touch').some(([key]) => /W|Shift|Ctrl|Space/.test(key)),
    false,
  );
  assert.match(controlRows('direct', 'keyboard').flat().join(' '), /hold/i);
  assert.match(controlRows('assisted', 'gamepad').flat().join(' '), /left stick/i);
});

test('briefing reveal is gated on a shown layer and respects reduced motion', () => {
  // Both grid columns must carry the hook the CSS animates, or the stagger
  // silently applies to nothing.
  assert.equal((screens.match(/el\('div', 'brief-col', grid\)/g) ?? []).length, 2);
  // Ungated, the whole sequence would run at boot while the layer is still
  // invisible and be over before the player ever reaches the briefing.
  assert.match(css, /\.layer\.show \.brief-col > \*\s*\{[^}]*animation:\s*brief-rise/);
  assert.match(css, /@keyframes brief-rise/);
  assert.match(
    css,
    /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.layer\.show \.brief-col > \*[\s\S]*?animation:\s*none/,
  );
  // The launch button lands last so the eye is delivered to the only control.
  assert.match(css, /\.brief-col \+ \.brief-col > \*:nth-child\(2\)\s*\{\s*--brief-step:\s*4/);
  // The title screen's tracking orphans the last word in the briefing column.
  assert.match(css, /\.briefing \.eyebrow\s*\{[^}]*letter-spacing:\s*0\.3em/);
});

test('setControlContext renders only the active modality rows', () => {
  const grid = new FakeElement('div');
  const instance = Object.assign(Object.create(Screens.prototype), {
    controlsGrid: grid,
    _controlMode: null,
    _controlModality: null,
  });
  const original = document.createElement;
  document.createElement = (tag) => new FakeElement(tag);
  try {
    instance.setControlContext({ controlMode: 'assisted', modality: 'touch' });
  } finally {
    document.createElement = original;
  }
  const copy = grid.children.map((node) => node.textContent).join(' ');
  assert.match(copy, /Drag up Climb/);
  assert.doesNotMatch(copy, /W \/ Up|Shift|keyboard/i);
});

test('flight options keep accessible state and emit authoritative values', () => {
  const calls = [];
  const screensInstance = buildPause();
  screensInstance.callbacks = {
    ...screensInstance.callbacks,
    onControlMode: (value) => calls.push(['mode', value]),
    onControlSensitivity: (value) => calls.push(['sensitivity', value]),
    onAutoThrottle: (value) => calls.push(['auto', value]),
    onVerticalMode: (value) => calls.push(['vertical', value]),
  };

  screensInstance.setOptions({
    controlMode: 'direct',
    controlSensitivity: 'high',
    autoThrottle: false,
    verticalMode: 'upToDive',
  });
  assert.equal(screensInstance.controlModeButtons.direct.getAttribute('aria-pressed'), 'true');
  assert.equal(screensInstance.sensitivityButtons.high.getAttribute('aria-pressed'), 'true');
  assert.equal(screensInstance.autoThrottleButton.getAttribute('aria-pressed'), 'false');
  assert.equal(screensInstance.verticalModeButtons.upToDive.getAttribute('aria-pressed'), 'true');

  screensInstance.controlModeButtons.assisted.dispatch('click');
  screensInstance.sensitivityButtons.low.dispatch('click');
  screensInstance.autoThrottleButton.dispatch('click');
  screensInstance.verticalModeButtons.upToClimb.dispatch('click');
  assert.deepEqual(calls, [
    ['mode', 'assisted'],
    ['sensitivity', 'low'],
    ['auto', true],
    ['vertical', 'upToClimb'],
  ]);
});

test('assisted notice is concise, acknowledged on dismiss, and legacy inversion UI is gone', () => {
  assert.doesNotMatch(screens, /Invert pitch|onInvertPitch|invertButton|_setInvert/);
  assert.match(game, /Assisted Controls active\.[^'\n]*Pause[^'\n]*Flying/);
  assert.match(game, /setAssistedNoticeSeen\(true\)/);
  assert.match(game, /onControlMode:[\s\S]*setControlMode/);
  assert.match(game, /onControlSensitivity:[\s\S]*setControlSensitivity/);
  assert.match(game, /onAutoThrottle:[\s\S]*setAutoThrottle/);
  assert.match(game, /onVerticalMode:[\s\S]*setVerticalMode/);

  let acknowledged = 0;
  const notice = Object.assign(Object.create(Screens.prototype), {
    noticeText: { textContent: '' },
    noticeBar: {
      classList: { add() {}, remove() {} },
      setAttribute() {},
    },
  });
  notice.showNotice('Assisted Controls active.', () => acknowledged++);
  notice.clearNotice();
  notice.clearNotice();
  assert.equal(acknowledged, 1);
});

/**
 * A notice bar with just enough of the real thing to observe. `shown` tracks the
 * `show` class rather than the text, because the text is set once and never
 * cleared — the class is what actually decides whether the bar is on screen.
 */
function buildNotice() {
  let shown = false;
  const instance = Object.assign(Object.create(Screens.prototype), {
    noticeText: { textContent: '' },
    noticeBar: {
      classList: {
        add: (name) => { if (name === 'show') shown = true; },
        remove: (name) => { if (name === 'show') shown = false; },
      },
      setAttribute() {},
    },
    _noticeTimer: 0,
    _noticeRemaining: 0,
    _noticeStartedAt: 0,
    _onNoticeVisibility: null,
    _noticeDismiss: null,
  });
  return { instance, isShown: () => shown };
}

test('the assist notice retires itself; failure notices do not', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let clock = 0;
  const realPerformance = globalThis.performance;
  globalThis.performance = { now: () => clock };
  const advance = (ms) => { clock += ms; t.mock.timers.tick(ms); };
  t.after(() => { globalThis.performance = realPerformance; });

  // Game passes a window only for the orientation note, and 4s is what it uses.
  assert.match(game, /const ASSIST_NOTICE_MS = 4000;/);
  assert.match(game, /Assisted Controls active[\s\S]*?ASSIST_NOTICE_MS,/);

  const timed = buildNotice();
  let acknowledged = 0;
  timed.instance.showNotice('Assisted Controls active.', () => acknowledged++, 4000);
  assert.equal(timed.isShown(), true);
  advance(3999);
  assert.equal(timed.isShown(), true, 'must not retire early');
  advance(1);
  assert.equal(timed.isShown(), false);
  assert.equal(acknowledged, 1, 'auto-dismiss still marks the notice seen');

  // A notice with no window is a failure the player needs left on screen.
  const persistent = buildNotice();
  persistent.instance.showNotice('Aircraft model unavailable.');
  advance(60000);
  assert.equal(persistent.isShown(), true);
});

test('a backgrounded tab does not burn the notice window', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let clock = 0;
  const realPerformance = globalThis.performance;
  globalThis.performance = { now: () => clock };
  const advance = (ms) => { clock += ms; t.mock.timers.tick(ms); };
  t.after(() => {
    globalThis.performance = realPerformance;
    globalThis.document.visibilityState = 'visible';
  });

  const { instance, isShown } = buildNotice();
  let acknowledged = 0;
  instance.showNotice('Assisted Controls active.', () => acknowledged++, 4000);

  advance(1000);
  globalThis.document.dispatchVisibility('hidden');
  advance(30000);
  assert.equal(isShown(), true, 'the window is banked, not spent, while hidden');
  assert.equal(acknowledged, 0);

  globalThis.document.dispatchVisibility('visible');
  advance(2999);
  assert.equal(isShown(), true, 'the remaining 3s resumes from where it stopped');
  advance(1);
  assert.equal(isShown(), false);
  assert.equal(acknowledged, 1);
});

test('flying option layout remains phone-safe and does not force wide controls', () => {
  assert.match(css, /\.flying-options[\s\S]*?display:\s*grid/);
  assert.match(css, /@media \(max-width: 720px\), \(max-aspect-ratio: 3 \/ 4\)[\s\S]*?\.flying-options/);
  assert.doesNotMatch(css, /\.flying-options[^}]*min-width:\s*[4-9][0-9]{2}px/);
});

test('legacy invert pitch option is absent', () => {
  const screensInstance = buildPause();
  assert.equal(screensInstance.invertButton, undefined);
});

// -------------------------------------------------------------- leaderboard --

const { Leaderboard } = await import('../game/Leaderboard.js');

function memoryStore(seed = {}) {
  const data = new Map(Object.entries(seed));
  return {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, v),
  };
}

/**
 * Run a body with the fake element factory installed. The board renders rows
 * lazily, well after construction, so the override has to survive the whole
 * test rather than just the build call.
 */
function withDom(body) {
  const original = document.createElement;
  document.createElement = (tag) => new FakeElement(tag);
  try {
    return body();
  } finally {
    document.createElement = original;
  }
}

/** The record card's board. Call inside withDom. */
function buildBoard(store = memoryStore()) {
  const instance = Object.assign(Object.create(Screens.prototype), { callbacks: {} });
  instance._buildLeaderboard(new FakeElement('div'));
  instance.setLeaderboard({ leaderboard: new Leaderboard(store) });
  return instance;
}

const sortie = (captured, total, elapsed) => ({
  captured,
  elapsed,
  posts: Array.from({ length: total }, (_, i) => ({ callsign: `P${i}`, captured: i < captured })),
});

// The empty-board placeholder carries its text directly; ranked rows carry it
// in four column spans.
const rowsOf = (board) => board.boardList.children.map((li) => ({
  text: li.children.length
    ? li.children.map((c) => c.textContent).join(' ')
    : li.textContent,
  mine: li.classList.contains('mine'),
}));

test('the record card offers the board only to a sortie that could place on it', () => withDom(() => {
  const board = buildBoard();

  board._showBoardFor(sortie(5, 5, 372), 'GOOD');
  assert.notEqual(board.boardEntry.style.display, 'none', 'a complete sortie can record');
  assert.equal(board.boardNote.textContent, '');

  board._showBoardFor(sortie(3, 5, 95), 'GOOD');
  assert.equal(board.boardEntry.style.display, 'none');
  assert.match(board.boardNote.textContent, /Secure every objective/);
}));

test('the board is hidden entirely when no store was configured', () => withDom(() => {
  const board = buildBoard();
  board.setLeaderboard(null);
  board._showBoardFor(sortie(5, 5, 372), 'GOOD');
  assert.equal(board.boardSection.style.display, 'none');
}));

test('recording a time ranks it, marks the row, and retires the form', () => withDom(() => {
  const board = buildBoard();
  board._board.submit({ name: 'KESTREL', seconds: 298, grade: 'EXCELLENT', at: 1 });
  board._board.submit({ name: 'MERLIN', seconds: 512, grade: 'GOOD', at: 2 });

  board._showBoardFor(sortie(5, 5, 372), 'GOOD');
  assert.deepEqual(rowsOf(board).map((r) => r.text), [
    '1 KESTREL 4:58 EXCELLENT',
    '2 MERLIN 8:32 GOOD',
  ]);

  board.boardName.value = 'falcon';
  board._recordTime();
  assert.equal(board.boardNote.textContent, 'Recorded at number 2.');
  assert.deepEqual(rowsOf(board), [
    { text: '1 KESTREL 4:58 EXCELLENT', mine: false },
    { text: '2 FALCON 6:12 GOOD', mine: true },
    { text: '3 MERLIN 8:32 GOOD', mine: false },
  ]);
  assert.equal(board.boardEntry.style.display, 'none', 'one entry per sortie');
}));

test('a callsign that cannot be used is refused without touching the board', () => withDom(() => {
  const board = buildBoard();
  board._showBoardFor(sortie(5, 5, 372), 'GOOD');
  board.boardName.value = 'x';
  board._recordTime();

  assert.match(board.boardNote.textContent, /Callsign must be 3–12 characters/);
  assert.notEqual(board.boardEntry.style.display, 'none', 'so it can be corrected');
  assert.deepEqual(rowsOf(board).map((r) => r.text), ['No sorties recorded yet.']);
}));

test('the callsign field arrives filled in from the last sortie', () => withDom(() => {
  const store = memoryStore();
  const first = buildBoard(store);
  first._showBoardFor(sortie(5, 5, 372), 'GOOD');
  first.boardName.value = 'falcon';
  first._recordTime();

  const later = buildBoard(store);
  later._showBoardFor(sortie(5, 5, 400), 'GOOD');
  assert.equal(later.boardName.value, 'FALCON');
}));

test('the board sits on the record card, never beside the remembrance lines', () => {
  // The separation the _buildDebrief comment describes is the brief's rule, and
  // a ranked list of times is precisely what that rule exists to keep away.
  const start = screens.indexOf('_buildDebrief() {');
  const build = screens.slice(start, screens.indexOf('_showRecord() {', start));
  const endingStart = build.indexOf('this.endingCard =');
  const ending = build.slice(endingStart, build.indexOf('this.recordCard =', endingStart));
  assert.ok(endingStart > -1 && ending.length > 0, 'ending card block not found');
  assert.equal(ending.includes('_buildLeaderboard'), false);
  assert.ok(build.includes('this._buildLeaderboard(this.recordCard)'));
});

test('Tab walks every control in a dialog, not just its two ends', () => {
  // Input.js has Tab in PREVENT_DEFAULT and cancels it globally, so the trap
  // cannot lean on the browser's own tab order — it has to do the move itself.
  // Nothing exposed this until the leaderboard added a dialog with more than a
  // row of buttons: you could not Tab from the callsign field to the button.
  const order = [];
  const make = (name) => ({ name, focus() { order.push(name); } });
  const nodes = [make('field'), make('save'), make('again')];
  let active = nodes[0];
  const realActive = Object.getOwnPropertyDescriptor(globalThis.document, 'activeElement');
  Object.defineProperty(globalThis.document, 'activeElement', {
    configurable: true,
    get: () => active,
  });
  try {
    const screensInstance = Object.assign(Object.create(Screens.prototype), {
      current: {
        contains: (n) => nodes.includes(n),
        querySelectorAll: () => nodes,
      },
    });
    // visibleFocusables filters on tabIndex and rects, so stub the collection.
    const originalCurrent = screensInstance.current;
    screensInstance.current = originalCurrent;
    for (const n of nodes) { n.tabIndex = 0; n.getClientRects = () => [{}]; n.closest = () => null; }

    const tab = (shiftKey = false) => {
      let prevented = false;
      screensInstance._trapDialogFocus({
        key: 'Tab', shiftKey, preventDefault() { prevented = true; },
      });
      return prevented;
    };

    assert.equal(tab(), true, 'the trap always owns the keystroke');
    assert.deepEqual(order, ['save'], 'field -> save, the step that used to be impossible');
    active = nodes[1];
    tab();
    assert.deepEqual(order, ['save', 'again']);
    active = nodes[2];
    tab();
    assert.deepEqual(order, ['save', 'again', 'field'], 'and wraps at the end');
    active = nodes[0];
    tab(true);
    assert.deepEqual(order.slice(-1), ['again'], 'shift-Tab wraps backwards');
  } finally {
    if (realActive) Object.defineProperty(globalThis.document, 'activeElement', realActive);
    else delete globalThis.document.activeElement;
  }
});

test('a notice armed while the tab is hidden does not spend its window unseen', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let clock = 0;
  const realPerformance = globalThis.performance;
  globalThis.performance = { now: () => clock };
  const advance = (ms) => { clock += ms; t.mock.timers.tick(ms); };
  t.after(() => {
    globalThis.performance = realPerformance;
    globalThis.document.visibilityState = 'visible';
  });

  const { instance, isShown } = buildNotice();
  let acknowledged = 0;
  // The title sequence resolves on its own timers, which keep running in a
  // background tab, so the briefing — and this notice — can open while the
  // player is looking at something else entirely.
  globalThis.document.visibilityState = 'hidden';
  instance.showNotice('Assisted Controls active.', () => acknowledged++, 4000);

  advance(60000);
  assert.equal(isShown(), true, 'the window has not started');
  assert.equal(acknowledged, 0, 'and the note is not yet marked seen');

  globalThis.document.dispatchVisibility('visible');
  advance(3999);
  assert.equal(isShown(), true, 'the full window runs once the player is back');
  advance(1);
  assert.equal(isShown(), false);
  assert.equal(acknowledged, 1);
});

test('a sortie that ended in the mountain never takes a place on the board', () => withDom(() => {
  const board = buildBoard();
  // Securing the last site and hitting a ridge in the same update leaves the
  // mission failed with every objective captured.
  board._showBoardFor(sortie(5, 5, 372), 'GOOD', false);
  assert.equal(board.boardEntry.style.display, 'none');
  assert.match(board.boardNote.textContent, /Secure every objective/);

  board._showBoardFor(sortie(5, 5, 372), 'GOOD', true);
  assert.notEqual(board.boardEntry.style.display, 'none');
}));

/** A Screens reduced to the nodes the title sequence touches. */
function buildTitle() {
  return Object.assign(Object.create(Screens.prototype), {
    current: null,
    show(layer) { this.current = layer; },
    titleLayer: new FakeElement('div'),
    t1: new FakeElement('div'),
    t2: new FakeElement('div'),
    t3: new FakeElement('div'),
    titlePrompt: new FakeElement('button'),
    _destroyed: false,
    _titleCleanup: null,
  });
}

function fakeSkipSignal() {
  const handlers = new Set();
  return {
    on: (fn) => handlers.add(fn),
    off: (fn) => handlers.delete(fn),
    fire: () => { for (const fn of [...handlers]) fn(); },
  };
}

test('the title holds on the prompt until the player asks for it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const screensInstance = buildTitle();
  const skip = fakeSkipSignal();
  let resolved = false;
  const running = screensInstance.playTitle(skip).then(() => { resolved = true; });
  await Promise.resolve();

  // A browser will not start audio without a gesture, and this screen used to
  // spend the only one available on dismissing itself. Nothing plays yet.
  assert.match(screensInstance.titlePrompt.textContent, /begin/, 'the prompt asks to begin, not continue');
  assert.equal(screensInstance.titlePrompt.style.opacity, '1');
  assert.equal(screensInstance.titlePrompt.tabIndex, 0, 'and is reachable by keyboard');
  assert.deepEqual(
    [screensInstance.t1, screensInstance.t2, screensInstance.t3].map((n) => n.style.opacity),
    ['0', '0', '0'],
    'no card plays before the gesture',
  );

  t.mock.timers.tick(60000);
  assert.deepEqual(
    [screensInstance.t1, screensInstance.t2, screensInstance.t3].map((n) => n.style.opacity),
    ['0', '0', '0'],
    'and waiting does not start it either',
  );
  assert.equal(resolved, false, 'the gate does not resolve playTitle');

  // The gesture starts the sequence rather than skipping it.
  skip.fire();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(screensInstance.titlePrompt.style.opacity, '0', 'the prompt steps aside');
  assert.match(screensInstance.titlePrompt.textContent, /continue/, 'and becomes the skip prompt');
  assert.equal(resolved, false, 'the cards are running, not skipped');

  t.mock.timers.tick(1000);
  assert.equal(screensInstance.t1.style.opacity, '1', 'the first card plays after the gate');

  // A second press still skips, exactly as it always did.
  skip.fire();
  await running;
  assert.equal(resolved, true);
});

test('a pointer press on the layer opens the gate, and the prompt click does too', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const release of ['pointerdown', 'click']) {
    const screensInstance = buildTitle();
    const skip = fakeSkipSignal();
    screensInstance.playTitle(skip);
    await Promise.resolve();
    assert.match(screensInstance.titlePrompt.textContent, /begin/);

    const node = release === 'pointerdown' ? screensInstance.titleLayer : screensInstance.titlePrompt;
    node.dispatch(release);
    await Promise.resolve();
    await Promise.resolve();
    assert.match(
      screensInstance.titlePrompt.textContent,
      /continue/,
      `${release} must open the gate`,
    );
    t.mock.timers.tick(1000);
    assert.equal(screensInstance.t1.style.opacity, '1', `${release} must start the cards`);
  }
});
