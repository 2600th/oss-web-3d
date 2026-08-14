import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const here = new URL('./', import.meta.url);
const [hud, screens, css] = await Promise.all([
  readFile(new URL('Hud.js', here), 'utf8'),
  readFile(new URL('Screens.js', here), 'utf8'),
  readFile(new URL('styles.css', here), 'utf8'),
]);

globalThis.window = {
  matchMedia: () => ({ matches: false }),
};
globalThis.document = {
  createElement: (tag) => {
    if (tag !== 'canvas') return {};
    return {
      getContext: () => ({
        font: '',
        measureText: (value) => ({ width: value.length * 8 }),
      }),
    };
  },
  removeEventListener: () => {},
};
globalThis.cancelAnimationFrame = () => {};

const ScreenModule = await import('./Screens.js');
const { Screens } = ScreenModule;

class FakeElement {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.attributes = new Map();
    this.listeners = new Map();
    this.className = '';
    this.textContent = '';
    this.value = '';
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

  dispatch(type) {
    this.listeners.get(type)?.({ type, preventDefault() {} });
  }
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
        onInvertPitch() {},
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

test('invert pitch toggle keeps a stable accessible name while state changes', () => {
  const screensInstance = buildPause();
  const button = screensInstance.invertButton;
  assert.equal(button.getAttribute('aria-label'), 'Invert pitch');
  assert.equal(button.getAttribute('aria-pressed'), 'false');
  button.dispatch('click');
  assert.equal(button.getAttribute('aria-label'), 'Invert pitch');
  assert.equal(button.getAttribute('aria-pressed'), 'true');
  assert.equal(button.textContent, 'On');
});
