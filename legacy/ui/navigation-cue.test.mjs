import assert from 'node:assert/strict';
import test from 'node:test';

const navigationCueModule = await import('./NavigationCue.js').catch(() => ({}));
const { NavigationCue, edgeCandidates, placeNavigationCue } = navigationCueModule;

function intersects(a, b) {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

function gapBetween(a, b) {
  if (intersects(a, b)) return -1;
  const dx = Math.max(b.left - a.right, a.left - b.right, 0);
  const dy = Math.max(b.top - a.bottom, a.top - b.bottom, 0);
  return Math.hypot(dx, dy);
}

function layoutFixture(kind) {
  if (kind === 'phone') {
    return {
      viewport: { width: 390, height: 844 },
      safeInsets: { top: 47, right: 12, bottom: 34, left: 12 },
      cueSize: { width: 112, height: 58 },
      edgeNdc: { x: 1, y: 0.2 },
      avoidRects: [
        { left: 318, top: 290, right: 378, bottom: 590 },
        { left: 214, top: 600, right: 306, bottom: 820 },
      ],
      gap: 8,
    };
  }
  return {
    viewport: { width: 1920, height: 1080 },
    safeInsets: { top: 24, right: 24, bottom: 24, left: 24 },
    cueSize: { width: 150, height: 64 },
    edgeNdc: { x: -1, y: 0.1 },
    avoidRects: [{ left: 86, top: 340, right: 206, bottom: 740 }],
    gap: 8,
  };
}

test('edge placement stays inside desktop safe insets and clears the flight tape', () => {
  assert.equal(typeof placeNavigationCue, 'function', 'placeNavigationCue must be exported');
  const fixture = layoutFixture('desktop');
  const placed = placeNavigationCue(fixture);
  const tapeRect = fixture.avoidRects[0];

  assert.ok(placed.left >= fixture.safeInsets.left);
  assert.ok(placed.top >= fixture.safeInsets.top);
  assert.ok(placed.rect.right <= fixture.viewport.width - fixture.safeInsets.right);
  assert.ok(placed.rect.bottom <= fixture.viewport.height - fixture.safeInsets.bottom);
  assert.equal(intersects(placed.rect, tapeRect), false);
  assert.ok(gapBetween(placed.rect, tapeRect) >= fixture.gap);
  assert.equal(placed.edge, 'left');
});

test('transit edge candidates are lazy and reuse one scratch record', () => {
  assert.equal(typeof edgeCandidates, 'function');
  let reads = 0;
  const edgeNdc = {
    get x() { reads += 1; return 1; },
    get y() { reads += 1; return 0; },
  };
  const candidates = edgeCandidates(
    'right',
    { left: 12, top: 47, right: 378, bottom: 810 },
    { width: 112, height: 58 },
    edgeNdc,
  );

  assert.equal(reads, 0, 'constructing the iterator must not eagerly scan the edge');
  const first = candidates.next();
  assert.equal(first.done, false);
  assert.equal(reads, 2);
  const second = candidates.next();
  assert.equal(second.done, false);
  assert.equal(second.value, first.value, 'candidate iteration should reuse a single scratch record');
  candidates.return();
});

test('phone placement moves along the requested edge to clear touch controls by eight pixels', () => {
  assert.equal(typeof placeNavigationCue, 'function', 'placeNavigationCue must be exported');
  const fixture = layoutFixture('phone');
  const placed = placeNavigationCue(fixture);
  const touchRects = fixture.avoidRects;

  assert.ok(placed.left >= fixture.safeInsets.left && placed.top >= fixture.safeInsets.top);
  assert.ok(placed.rect.right <= fixture.viewport.width - fixture.safeInsets.right);
  assert.ok(placed.rect.bottom <= fixture.viewport.height - fixture.safeInsets.bottom);
  for (const touchRect of touchRects) {
    assert.ok(gapBetween(placed.rect, touchRect) >= 8);
  }
  assert.equal(placed.edge, 'right');
});

class FakeClassList {
  constructor(node) { this.node = node; }
  _classes() { return this.node.className.split(/\s+/).filter(Boolean); }
  toggle(name, on) {
    const classes = new Set(this._classes());
    if (on) classes.add(name); else classes.delete(name);
    this.node.className = [...classes].join(' ');
  }
  add(name) { this.toggle(name, true); }
  contains(name) { return this._classes().includes(name); }
}

class FakeElement {
  constructor(tag, ownerDocument) {
    this.tagName = tag.toUpperCase();
    this.ownerDocument = ownerDocument;
    this.children = [];
    this.attributes = new Map();
    this.className = '';
    this.classList = new FakeClassList(this);
    this.style = {};
    this._text = '';
    this.textWrites = 0;
    this.rect = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
  }
  appendChild(child) { this.children.push(child); child.parentElement = this; return child; }
  remove() { this.removed = true; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  getBoundingClientRect() { return this.rect; }
  getClientRects() { return this.rect.width || this.rect.height ? [this.rect] : []; }
  set textContent(value) { this._text = String(value); this.textWrites += 1; }
  get textContent() { return this._text; }
  find(className) {
    if (this.classList.contains(className)) return this;
    for (const child of this.children) {
      const found = child.find(className);
      if (found) return found;
    }
    return null;
  }
  findAll(className, found = []) {
    if (this.classList.contains(className)) found.push(this);
    for (const child of this.children) child.findAll(className, found);
    return found;
  }
}

function buildCue(options = {}) {
  const obstacles = [];
  const fakeDocument = {
    createElement: (tag) => new FakeElement(tag, fakeDocument),
    querySelectorAll: () => obstacles,
    defaultView: { innerWidth: 390, innerHeight: 844 },
  };
  const hud = new FakeElement('div', fakeDocument);
  const heading = new FakeElement('div', fakeDocument);
  hud.appendChild(heading);
  heading.rect = { left: 80, top: 30, right: 310, bottom: 70, width: 230, height: 40 };
  const cue = new NavigationCue(hud, heading, {
    viewport: () => ({ width: 390, height: 844 }),
    safeInsets: () => ({ top: 47, right: 12, bottom: 34, left: 12 }),
    ...options,
  });
  return { cue, hud, obstacles };
}

test('HUD-created cues resolve live CSS safe-area insets', () => {
  const { cue } = buildCue({ safeInsets: undefined });
  cue.root.ownerDocument.defaultView.getComputedStyle = () => ({
    paddingTop: '47px', paddingRight: '17px', paddingBottom: '34px', paddingLeft: '23px',
  });

  cue.update(transit);
  assert.equal(cue.root.style.left, '223px');
});

const transit = {
  targetId: 'raven', targetCallsign: 'RAVEN', targetRange: 18600,
  phase: 'transit', bearingDelta: 2, trend: 'CLOSING', altitude: 'ABOVE',
  projected: null, edgeNdc: { x: 1, y: 0.15 }, masked: false, label: null,
  reconPresentation: 'normal',
};

test('DOM cue wraps the target-bearing caret and distinguishes left and right transit guidance', () => {
  assert.equal(typeof NavigationCue, 'function', 'NavigationCue must be exported');
  const { cue } = buildCue();

  cue.update(transit);
  assert.match(cue.root.className, /edge-right/);
  assert.equal(cue.direction.textContent, 'RAVEN · RIGHT 2° · 18.6 KM');
  assert.equal(cue.headingCaret.style.transform, 'translateX(6.4px)');

  cue.update({ ...transit, bearingDelta: -2, edgeNdc: { x: -1, y: 0.15 } });
  assert.match(cue.root.className, /edge-left/);
  assert.equal(cue.direction.textContent, 'RAVEN · LEFT 2° · 18.6 KM');
  assert.equal(cue.headingCaret.style.transform, 'translateX(-6.4px)');
});

test('vertical edge placement keeps the shortest-turn chevron for both bearing directions', () => {
  const { cue } = buildCue();

  cue.update({ ...transit, bearingDelta: -37, edgeNdc: { x: 0.1, y: 1 } });
  assert.match(cue.root.className, /edge-top/);
  assert.match(cue.root.className, /turn-left/);
  assert.doesNotMatch(cue.root.className, /turn-right/);
  assert.equal(cue.direction.textContent, 'RAVEN · LEFT 37° · 18.6 KM');

  cue.update({ ...transit, bearingDelta: 24, edgeNdc: { x: -0.1, y: -1 } });
  assert.match(cue.root.className, /edge-bottom/);
  assert.match(cue.root.className, /turn-right/);
  assert.doesNotMatch(cue.root.className, /turn-left/);
  assert.equal(cue.direction.textContent, 'RAVEN · RIGHT 24° · 18.6 KM');
});

/**
 * A base in frame gets a marker on it, in every phase.
 *
 * The rule used to be narrower — `projected` was only honoured during search
 * and acquisition — so a base you were looking straight at still got an edge
 * arrow through the whole transit. And the marker goes exactly on the
 * projected point, with none of the avoid-rect nudging the edge cue uses: a
 * marker pushed clear of a HUD tape is no longer marking anything.
 */
test('a base in frame is marked where it is, in every phase', () => {
  const { cue, obstacles } = buildCue();
  const obstacle = new FakeElement('div', cue.root.ownerDocument);
  obstacle.rect = { left: 120, top: 120, right: 320, bottom: 520, width: 200, height: 400 };
  obstacles.push(obstacle);

  for (const phase of ['transit', 'search', 'acquisition']) {
    cue.update({ ...transit, phase, projected: { x: 0.45, y: 0 }, edgeNdc: { x: -1, y: -1 } });
    assert.match(cue.root.className, /on-target/, `${phase} must mark a visible base`);
    assert.doesNotMatch(cue.root.className, /edge-/, `${phase} must not also show an edge arrow`);
    assert.equal(cue.lastPlacement.edge, 'target');
  }

  // Exactly on the projected point, in the fixture's 390-wide viewport.
  cue.update({ ...transit, phase: 'transit', projected: { x: 0.45, y: 0 }, edgeNdc: { x: -1, y: -1 } });
  assert.equal(Math.round(cue.lastPlacement.left), Math.round((0.45 + 1) * 0.5 * 390));
  assert.equal(Math.round(cue.lastPlacement.top), Math.round((1 - 0) * 0.5 * 844));

  // Out of frame it goes back to the arrow.
  cue.update({ ...transit, phase: 'transit', projected: null, edgeNdc: { x: -1, y: 0 } });
  assert.doesNotMatch(cue.root.className, /on-target/);
  assert.match(cue.root.className, /edge-left/);
});

test('a masked but visible base is still marked, hollow rather than hidden', () => {
  const { cue } = buildCue();
  const masked = {
    ...transit,
    phase: 'acquisition',
    targetRange: 2100,
    masked: true,
    label: 'RIDGE MASKED',
    edgeNdc: { x: -1, y: 0.35 },
    projected: { x: 0.9, y: 0.9 },
  };

  // Knowing the base is behind that ridge is worth as much as knowing where it
  // is, so the marker stays and the styling carries the masking.
  cue.update(masked);
  assert.match(cue.root.className, /on-target/);
  assert.match(cue.root.className, /dashed/);
  assert.equal(cue.direction.textContent, 'RIDGE MASKED');

  // Masked and out of frame is the arrow again.
  cue.update({ ...masked, projected: null });
  assert.doesNotMatch(cue.root.className, /on-target/);
  assert.match(cue.root.className, /edge-left/);
  assert.match(cue.root.className, /dashed/);
});

test('phase still drives the cue class, and ridge masking is dashed', () => {
  const { cue } = buildCue();

  cue.update({ ...transit, phase: 'search', projected: { x: 0.2, y: -0.1 } });
  assert.match(cue.root.className, /phase-search/);

  cue.update({ ...transit, phase: 'acquisition', projected: { x: -0.1, y: 0.2 } });
  assert.match(cue.root.className, /phase-acquisition/);
  // No reticle geometry to find: the cue is an arrow and a label.
  assert.equal(cue.root.findAll('nav-acquisition-corner').length, 0);
  assert.ok(!cue.root.find('nav-search-bracket'));

  cue.update({ ...transit, phase: 'acquisition', projected: null, masked: true, label: 'RIDGE MASKED' });
  assert.match(cue.root.className, /dashed/);
  assert.equal(cue.direction.textContent, 'RIDGE MASKED');
});

test('one polite announcer deduplicates unchanged navigation updates', () => {
  const { cue, hud } = buildCue();
  assert.equal(hud.findAll('nav-announcer').length, 1);
  assert.equal(cue.status.getAttribute('role'), 'status');
  assert.equal(cue.status.getAttribute('aria-live'), 'polite');

  cue.update(transit);
  const writes = cue.status.textWrites;
  cue.update({ ...transit });
  assert.equal(cue.status.textWrites, writes);
  cue.update({ ...transit, trend: 'OPENING' });
  assert.equal(cue.status.textWrites, writes + 1);
});

test('navigation cue queries current obstacle rectangles on every update', () => {
  const { cue, obstacles } = buildCue();
  const first = new FakeElement('div', cue.root.ownerDocument);
  first.rect = { left: 250, top: 300, right: 390, bottom: 500, width: 140, height: 200 };
  obstacles.push(first);
  cue.update(transit);
  const firstTop = cue.root.style.top;

  first.rect = { left: 250, top: 80, right: 390, bottom: 650, width: 140, height: 570 };
  cue.update(transit);
  assert.notEqual(cue.root.style.top, firstTop);
});

test('the marker follows the projection and never retains a stale one', () => {
  const { cue } = buildCue();
  cue.update({ ...transit, phase: 'acquisition', projected: { x: 0.65, y: -0.35 }, edgeNdc: { x: 1, y: -0.2 } });
  assert.match(cue.root.className, /on-target/);
  const first = { left: cue.root.style.left, top: cue.root.style.top };

  cue.update({ ...transit, phase: 'acquisition', projected: { x: -0.45, y: 0.2 }, edgeNdc: { x: -1, y: 0.25 } });
  assert.match(cue.root.className, /on-target/);
  assert.notDeepEqual(
    { left: cue.root.style.left, top: cue.root.style.top },
    first,
    'the marker must move with the base, not hold its last position',
  );

  cue.update({ ...transit, phase: 'acquisition', projected: null, edgeNdc: { x: -1, y: 0.25 } });
  assert.doesNotMatch(cue.root.className, /on-target/);
});

test('navigation DOM is HUD-owned and dispose removes the cue, caret, probe, and announcer', () => {
  const { cue, hud } = buildCue();
  cue.update(transit);

  assert.equal(cue.safeAreaProbe.parentElement, hud);
  assert.equal(cue.root.parentElement, hud);
  assert.equal(cue.status.parentElement, hud);
  assert.equal(cue.headingStrip.parentElement, hud);
  assert.equal(cue.headingCaret.parentElement, cue.headingStrip);

  cue.dispose();
  assert.equal(cue.safeAreaProbe.removed, true);
  assert.equal(cue.root.removed, true);
  assert.equal(cue.headingCaret.removed, true);
  assert.equal(cue.status.removed, true);
});

/**
 * The caption belongs under the reticle, not through it.
 *
 * Measured before the fix: the search bracket is 126px wide and
 * "SEARCH · CLOSING · TARGET BELOW" is 219px, so a caption centred in the cue
 * ran 107px out through the right-hand border. Shortening the text is not a
 * fix — every phase's label is wider than a frame that has to stay small
 * enough to sit on a target — so the caption gets its own band beneath it.
 */
/**
 * The cue is an arrow and a label on one row.
 *
 * The search bracket and acquisition corner-frame are gone. Both were
 * fixed-size reticles: the bracket was 126px across and
 * "SEARCH · CLOSING · TARGET BELOW" is 219px, so the label ran 107px out
 * through the border, and shortening could never fix it because every phase's
 * label is wider than a frame small enough to sit on a target.
 */
test('the cue carries no reticle and sizes itself to its content', async () => {
  const { readFile } = await import('node:fs/promises');
  const css = await readFile(new URL('./styles.css', import.meta.url), 'utf8');
  const source = await readFile(new URL('./NavigationCue.js', import.meta.url), 'utf8');

  assert.doesNotMatch(css, /nav-search-bracket/, 'the search bracket is gone');
  assert.doesNotMatch(css, /nav-acquisition/, 'the acquisition frame is gone');
  assert.doesNotMatch(source, /this\.searchBracket|nav-acquisition/, 'no reticle elements are built');

  const cue = /\.navigation-cue \{([^}]*)\}/.exec(css);
  assert.ok(cue, '.navigation-cue must be styled');
  assert.match(cue[1], /display:\s*flex/, 'arrow and label share one row');
  assert.match(cue[1], /align-items:\s*center/, 'the arrow must sit on the label centreline');
  assert.match(cue[1], /width:\s*max-content/, 'the cue must size to its own content');
  assert.doesNotMatch(cue[1], /height:\s*\d+px/, 'a fixed height is a box, and there is no box');

  // The arrow sits on the side it points to.
  assert.match(css, /\.nav-edge-left \{ order: 0; \}/);
  assert.match(css, /\.nav-direction \{[^}]*order:\s*1/);
  assert.match(css, /\.nav-edge-right \{ order: 2; \}/);
});

test('the cue exposes a caption clamp so a wide label cannot leave the frame', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('./NavigationCue.js', import.meta.url), 'utf8');
  assert.match(source, /_keepCaptionOnScreen\(onTarget = false\)/, 'placement must clamp the caption');
  assert.match(
    source,
    /setText\(this\.direction, text\);\s*\n\s*this\._keepCaptionOnScreen\(onTarget\);/,
    'the clamp must run after the text is set, or it measures the previous label',
  );
  assert.ok(typeof NavigationCue?.prototype?._keepCaptionOnScreen === 'function');
  // On target the label gives, never the marker.
  assert.match(source, /const node = onTarget \? this\.direction : this\.root;/);
});
