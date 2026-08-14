const AVOID_SELECTOR = [
  '.tape',
  '.objectives',
  '.throttle',
  '.target-block',
  '.stick-zone',
  '.boost-zone',
  '.boost-btn',
  '.throttle-zone',
  '.recon-btn',
  '.recon-head',
  '.quality',
  '.recon-frame-no',
  '.shutter-btn',
  '.zoom-btn',
].join(', ');

const DEFAULT_CUE_SIZE = { width: 150, height: 64 };
const HEADING_PX_PER_DEG = 3.2;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function edgeFor(point = {}) {
  const x = Number.isFinite(point.x) ? point.x : 0;
  const y = Number.isFinite(point.y) ? point.y : 0;
  if (Math.abs(x) >= Math.abs(y)) return x < 0 ? 'left' : 'right';
  return y < 0 ? 'bottom' : 'top';
}

function rectAt(left, top, width, height) {
  return { left, top, right: left + width, bottom: top + height, width, height };
}

function clears(rect, obstacles, gap) {
  return obstacles.every((other) => (
    rect.right <= other.left - gap
    || rect.left >= other.right + gap
    || rect.bottom <= other.top - gap
    || rect.top >= other.bottom + gap
  ));
}

export function* edgeCandidates(edge, bounds, cueSize, edgeNdc) {
  const { left, top, right, bottom } = bounds;
  const maxLeft = right - cueSize.width;
  const maxTop = bottom - cueSize.height;
  const targetX = clamp(
    ((edgeNdc.x + 1) * 0.5 * (right - left)) + left - cueSize.width / 2,
    left,
    maxLeft,
  );
  const targetY = clamp(
    ((1 - edgeNdc.y) * 0.5 * (bottom - top)) + top - cueSize.height / 2,
    top,
    maxTop,
  );
  const fixed = edge === 'left' || edge === 'right'
    ? (edge === 'left' ? left : maxLeft)
    : (edge === 'top' ? top : maxTop);
  const start = edge === 'left' || edge === 'right' ? top : left;
  const end = edge === 'left' || edge === 'right' ? maxTop : maxLeft;
  const ideal = edge === 'left' || edge === 'right' ? targetY : targetX;
  const vertical = edge === 'left' || edge === 'right';
  const candidate = { left: vertical ? fixed : ideal, top: vertical ? ideal : fixed };
  yield candidate;
  for (let offset = 1; offset <= Math.ceil(end - start); offset += 1) {
    if (ideal - offset >= start) {
      if (vertical) candidate.top = ideal - offset;
      else candidate.left = ideal - offset;
      yield candidate;
    }
    if (ideal + offset <= end) {
      if (vertical) candidate.top = ideal + offset;
      else candidate.left = ideal + offset;
      yield candidate;
    }
  }
}

function* projectedCandidates(bounds, cueSize, projectedNdc) {
  const maxLeft = bounds.right - cueSize.width;
  const maxTop = bounds.bottom - cueSize.height;
  const idealLeft = clamp(
    bounds.left + ((projectedNdc.x + 1) * 0.5 * (bounds.right - bounds.left)) - cueSize.width / 2,
    bounds.left,
    maxLeft,
  );
  const idealTop = clamp(
    bounds.top + ((1 - projectedNdc.y) * 0.5 * (bounds.bottom - bounds.top)) - cueSize.height / 2,
    bounds.top,
    maxTop,
  );
  yield { left: idealLeft, top: idealTop };
  const step = 4;
  const maxRadius = Math.ceil(Math.max(bounds.right - bounds.left, bounds.bottom - bounds.top) / step);
  for (let radius = 1; radius <= maxRadius; radius += 1) {
    for (const [x, y] of [[0, -radius], [0, radius], [-radius, 0], [radius, 0]]) {
      yield {
        left: clamp(idealLeft + x * step, bounds.left, maxLeft),
        top: clamp(idealTop + y * step, bounds.top, maxTop),
      };
    }
    for (let x = -radius; x <= radius; x += 1) {
      if (x === 0) continue;
      for (const y of [-radius, radius]) {
        yield {
          left: clamp(idealLeft + x * step, bounds.left, maxLeft),
          top: clamp(idealTop + y * step, bounds.top, maxTop),
        };
      }
    }
    for (let y = -radius + 1; y < radius; y += 1) {
      if (y === 0) continue;
      for (const x of [-radius, radius]) {
        yield {
          left: clamp(idealLeft + x * step, bounds.left, maxLeft),
          top: clamp(idealTop + y * step, bounds.top, maxTop),
        };
      }
    }
  }
}

/** Place an edge cue inside safe insets while maintaining a gap from live HUD controls. */
export function placeNavigationCue({
  viewport,
  safeInsets = {},
  cueSize,
  edgeNdc = { x: 0, y: 0 },
  projectedNdc = null,
  avoidRects = [],
  gap = 8,
}) {
  const size = {
    width: Math.min(cueSize.width, viewport.width),
    height: Math.min(cueSize.height, viewport.height),
  };
  const bounds = {
    left: Math.max(0, safeInsets.left ?? 0),
    top: Math.max(0, safeInsets.top ?? 0),
    right: viewport.width - Math.max(0, safeInsets.right ?? 0),
    bottom: viewport.height - Math.max(0, safeInsets.bottom ?? 0),
  };
  size.width = Math.min(size.width, Math.max(0, bounds.right - bounds.left));
  size.height = Math.min(size.height, Math.max(0, bounds.bottom - bounds.top));

  if (projectedNdc && Number.isFinite(projectedNdc.x) && Number.isFinite(projectedNdc.y)) {
    let fallback;
    for (const candidate of projectedCandidates(bounds, size, projectedNdc)) {
      const rect = rectAt(candidate.left, candidate.top, size.width, size.height);
      fallback ??= { ...candidate, edge: 'sector', rect };
      if (clears(rect, avoidRects, gap)) return { ...candidate, edge: 'sector', rect };
    }
    return fallback;
  }

  const preferred = edgeFor(edgeNdc);
  const opposites = { left: 'right', right: 'left', top: 'bottom', bottom: 'top' };
  const perpendicular = preferred === 'left' || preferred === 'right'
    ? ['top', 'bottom']
    : ['left', 'right'];
  const edges = [preferred, ...perpendicular, opposites[preferred]];
  let fallback;
  for (const edge of edges) {
    for (const candidate of edgeCandidates(edge, bounds, size, edgeNdc)) {
      const rect = rectAt(candidate.left, candidate.top, size.width, size.height);
      fallback ??= { ...candidate, edge, rect };
      if (clears(rect, avoidRects, gap)) return { ...candidate, edge, rect };
    }
  }
  return fallback;
}

function makeElement(tag, className, parent, text) {
  const node = parent.ownerDocument.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  parent.appendChild(node);
  return node;
}

function setText(node, value) {
  const next = String(value);
  if (node._navigationValue === next) return;
  node._navigationValue = next;
  node.textContent = next;
}

export class NavigationCue {
  constructor(hudRoot, headingStrip, options = {}) {
    this.hudRoot = hudRoot;
    this.headingStrip = headingStrip;
    this.options = options;
    this.safeAreaProbe = makeElement('span', 'navigation-safe-area', hudRoot);
    this.root = makeElement('div', 'navigation-cue hidden', hudRoot);
    this.root.setAttribute('aria-hidden', 'true');

    this.leftChevron = makeElement('span', 'nav-edge-chevron nav-edge-left', this.root, '‹');
    this.rightChevron = makeElement('span', 'nav-edge-chevron nav-edge-right', this.root, '›');
    this.direction = makeElement('span', 'nav-direction', this.root, '');
    this.searchBracket = makeElement('span', 'nav-search-bracket', this.root);
    this.acquisition = makeElement('span', 'nav-acquisition', this.root);
    for (const corner of ['tl', 'tr', 'br', 'bl']) {
      makeElement('i', `nav-acquisition-corner ${corner}`, this.acquisition);
    }

    this.headingCaret = makeElement('i', 'target-bearing-caret', headingStrip);
    this.status = makeElement('span', 'nav-announcer', hudRoot);
    this.status.setAttribute('role', 'status');
    this.status.setAttribute('aria-live', 'polite');
    this.status.setAttribute('aria-atomic', 'true');
  }

  _viewport() {
    if (typeof this.options.viewport === 'function') return this.options.viewport();
    const view = this.hudRoot.ownerDocument?.defaultView ?? globalThis.window;
    return { width: view?.innerWidth ?? 0, height: view?.innerHeight ?? 0 };
  }

  _avoidRects() {
    const doc = this.hudRoot.ownerDocument;
    if (!doc?.querySelectorAll) return [];
    return [...doc.querySelectorAll(AVOID_SELECTOR)]
      .filter((node) => node !== this.root && node.getClientRects?.().length)
      .map((node) => node.getBoundingClientRect())
      .filter((rect) => rect.width > 0 && rect.height > 0);
  }

  _cueSize() {
    const rect = this.root.getBoundingClientRect?.() ?? {};
    return {
      width: rect.width || this.options.cueSize?.width || DEFAULT_CUE_SIZE.width,
      height: rect.height || this.options.cueSize?.height || DEFAULT_CUE_SIZE.height,
    };
  }

  _safeInsets() {
    if (typeof this.options.safeInsets === 'function') return this.options.safeInsets();
    if (this.options.safeInsets) return this.options.safeInsets;
    const view = this.hudRoot.ownerDocument?.defaultView ?? globalThis.window;
    const style = view?.getComputedStyle?.(this.safeAreaProbe);
    const px = (value) => Number.parseFloat(value) || 0;
    return {
      top: px(style?.paddingTop),
      right: px(style?.paddingRight),
      bottom: px(style?.paddingBottom),
      left: px(style?.paddingLeft),
    };
  }

  update(snapshot) {
    const complete = !snapshot || snapshot.phase === 'complete' || snapshot.targetId == null;
    if (complete) {
      this.root.className = 'navigation-cue hidden';
      this.root.setAttribute('aria-hidden', 'true');
      this.headingCaret.className = 'target-bearing-caret hidden';
      if (snapshot?.phase === 'complete') setText(this.status, 'Navigation complete');
      return;
    }

    const masked = snapshot.masked === true;
    const projectedPoint = !masked
      && (snapshot.phase === 'search' || snapshot.phase === 'acquisition')
      ? snapshot.projected
      : null;
    const edgePoint = snapshot.edgeNdc ?? {
      x: Math.sign(snapshot.bearingDelta || 1), y: 0,
    };
    const placement = placeNavigationCue({
      viewport: this._viewport(),
      safeInsets: this._safeInsets(),
      cueSize: this._cueSize(),
      edgeNdc: edgePoint,
      projectedNdc: projectedPoint,
      avoidRects: this._avoidRects(),
      gap: 8,
    });
    this.root.style.left = `${Math.round(placement.left)}px`;
    this.root.style.top = `${Math.round(placement.top)}px`;
    this.lastPlacement = placement;

    const presentation = snapshot.reconPresentation ?? 'normal';
    const turn = snapshot.bearingDelta < 0 ? 'LEFT' : 'RIGHT';
    this.root.className = [
      'navigation-cue',
      `phase-${snapshot.phase}`,
      placement.edge === 'sector' ? 'anchor-sector' : `edge-${placement.edge}`,
      `turn-${turn.toLowerCase()}`,
      masked ? 'dashed' : '',
      presentation === 'dimmed' ? 'dimmed' : '',
      presentation === 'hidden' ? 'hidden' : '',
    ].filter(Boolean).join(' ');
    this.root.setAttribute('aria-hidden', presentation === 'hidden' ? 'true' : 'false');

    const angle = Math.round(Math.abs(snapshot.bearingDelta ?? 0));
    const range = Number.isFinite(snapshot.targetRange)
      ? snapshot.targetRange > 1000
        ? `${(snapshot.targetRange / 1000).toFixed(1)} KM`
        : `${Math.round(snapshot.targetRange)} M`
      : '--';
    const identity = snapshot.targetCallsign ?? String(snapshot.targetId).toUpperCase();
    const text = masked
      ? (snapshot.label || 'RIDGE MASKED')
      : snapshot.phase === 'transit'
        ? `${identity} · ${turn} ${angle}° · ${range}`
        : snapshot.phase === 'search'
          ? `SEARCH · ${snapshot.trend ?? 'HOLDING'} · TARGET ${snapshot.altitude ?? 'LEVEL'}`
          : `${identity} · ACQUIRE · ${range}`;
    setText(this.direction, text);

    const headingRect = this.headingStrip.getBoundingClientRect?.() ?? { width: 0 };
    const halfWidth = Math.max(0, (headingRect.width || 0) / 2 - 8);
    const caretX = Math.round(clamp(snapshot.bearingDelta * HEADING_PX_PER_DEG, -halfWidth, halfWidth) * 10) / 10;
    this.headingCaret.className = `target-bearing-caret${presentation === 'hidden' ? ' hidden' : ''}`;
    this.headingCaret.style.transform = `translateX(${caretX}px)`;

    const announcement = [
      snapshot.phase,
      `turn ${turn.toLowerCase()}`,
      snapshot.trend?.toLowerCase(),
      snapshot.altitude?.toLowerCase(),
      masked ? 'ridge masked' : null,
    ].filter(Boolean).join(', ');
    setText(this.status, announcement);
  }

  dispose() {
    this.safeAreaProbe.remove();
    this.root.remove();
    this.headingCaret.remove();
    this.status.remove();
  }
}
