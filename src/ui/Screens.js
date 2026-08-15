import { gradeFor } from '../game/ReconCamera.js';
import {
  formatDuration,
  isRankable,
  sanitiseName,
  NAME_MAX,
  NAME_MIN,
} from '../game/Leaderboard.js';

/**
 * Title sequence, briefing, pause, both debriefs, and the states nobody wants
 * to see: loading, a failed asset, a lost context.
 *
 * Tone is the hard constraint here, not layout. The dedication is real
 * remembrance and is kept completely separate from anything scored: it appears
 * before the mission exists, on its own, with no UI chrome around it, and the
 * word "score" never shares a screen with it. The sortie itself is openly
 * fictional — invented callsigns, invented positions — so that nothing in the
 * gameplay can be mistaken for a depiction of real events or real people.
 *
 * The hard failure surfaces are *not* built here. They live in the bootstrap in
 * index.html, because the failure that matters most — the module graph not
 * loading at all — happens before this file has been evaluated. This class
 * delegates to that surface rather than owning a second copy of it.
 */

/** performance.now() where it exists; the fallback keeps jsdom-less tests happy. */
const now = () => (globalThis.performance?.now?.() ?? Date.now());

const el = (tag, className, parent, text) => {
  const node = document.createElement(tag);
  if (tag === 'button') node.type = 'button';
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  if (parent) parent.appendChild(node);
  return node;
};

/**
 * Windows has no country-flag glyphs, so 🇮🇳 falls back to the two regional
 * indicator letters and "Jai Hind. 🇮🇳" renders as "JAI HIND. IN" — which looks
 * like a bug on the most solemn line in the experience. Measure whether the
 * pair composes into a single glyph and drop it if not.
 */
function supportsFlagEmoji() {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 24;
    canvas.height = 24;
    const ctx = canvas.getContext('2d');
    ctx.font = '16px sans-serif';
    const flag = ctx.measureText('\u{1F1EE}\u{1F1F3}').width;
    const single = ctx.measureText('\u{1F1EE}').width;
    // Composed: one glyph, so the pair is no wider than ~1.4 letters.
    return flag < single * 1.6;
  } catch {
    return false;
  }
}

const JAI_HIND = 'Jai Hind.';
const HAS_FLAG_GLYPH = supportsFlagEmoji();

/**
 * Write "Jai Hind." followed by the flag into an element.
 *
 * Where the emoji composes, it is used directly. Where it does not, the line
 * previously just lost the flag — but the flag is part of the specified copy,
 * so dropping it on the platform most players are on is not an acceptable
 * fallback. An inline tricolour draws the same thing with no font dependency.
 */
function writeJaiHind(node) {
  node.textContent = '';
  node.appendChild(document.createTextNode(JAI_HIND + ' '));
  if (HAS_FLAG_GLYPH) {
    node.appendChild(document.createTextNode('\u{1F1EE}\u{1F1F3}'));
    return;
  }
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 27 18');
  svg.setAttribute('class', 'flag');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Flag of India');
  const bands = [
    ['0', '#ff9933'],
    ['6', '#ffffff'],
    ['12', '#138808'],
  ];
  for (const [y, fill] of bands) {
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('x', '0');
    rect.setAttribute('y', y);
    rect.setAttribute('width', '27');
    rect.setAttribute('height', '6');
    rect.setAttribute('fill', fill);
    svg.appendChild(rect);
  }
  const wheel = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  wheel.setAttribute('cx', '13.5');
  wheel.setAttribute('cy', '9');
  wheel.setAttribute('r', '2.4');
  wheel.setAttribute('fill', 'none');
  wheel.setAttribute('stroke', '#000080');
  wheel.setAttribute('stroke-width', '0.7');
  svg.appendChild(wheel);
  node.appendChild(svg);
}

const DISCLAIMER =
  'A work of fiction. Not affiliated with, endorsed by, or representing the Indian Air Force, ' +
  'the Indian Army, the Ministry of Defence, or any broadcaster or production. ' +
  'All callsigns, positions and events depicted are invented.';

/**
 * What the loading bar should say while it is parked at each anchor.
 *
 * The labels name what is happening *during* the wait that follows the call,
 * not what the call just finished, because the wait is the only part the player
 * experiences. The long one is the 5.4 MB airframe: `Game.load` sets 0.35 and
 * then awaits the GLB, and on a slow link that is where the whole load appears
 * to stop.
 */
const LOAD_STAGES = [
  [0.15, 'Preparing sector'],
  [0.4, 'Loading airframe'],
  [0.8, 'Plotting objectives'],
  [1.01, 'Ready'],
];

/** Every persisted renderer tier must have an honest, reversible UI state. */
export const QUALITY_CHOICES = Object.freeze(['phone', 'low', 'medium', 'high']);

const CONTROL_COPY = Object.freeze({
  assisted: Object.freeze({
    keyboard: Object.freeze([
      ['W / Up', 'Climb'],
      ['S / Down', 'Descend'],
      ['A / Left', 'Turn left'],
      ['D / Right', 'Turn right'],
      ['Shift', 'Boost (hold)'],
      ['X', 'Slow down (hold)'],
      ['Z', 'Airbrake'],
      ['Space', 'Toggle recon'],
      ['F / V', 'Zoom in / out'],
      ['Enter', 'Manual shutter'],
      ['Tab', 'Cycle objective'],
      ['Esc', 'Pause'],
    ]),
    touch: Object.freeze([
      ['Drag left / right', 'Turn'],
      ['Drag up', 'Climb'],
      ['Drag down', 'Descend'],
      ['BOOST', 'Boost while held'],
      ['RECON', 'Toggle recon'],
      ['SHOOT', 'Manual shutter'],
      ['+ / −', 'Zoom'],
    ]),
    gamepad: Object.freeze([
      ['Left stick', 'Turn and climb'],
      ['RT / LT', 'Speed up / slow down'],
      ['RB', 'Reconnaissance'],
    ]),
  }),
  direct: Object.freeze({
    keyboard: Object.freeze([
      ['W / S', 'Pitch down / up (hold)'],
      ['A / D', 'Roll (hold)'],
      ['Q / E', 'Rudder (hold)'],
      ['Shift / X', 'Throttle (hold)'],
      ['Z', 'Airbrake (hold)'],
      ['Space', 'Recon camera (hold)'],
      ['F / V', 'Zoom in / out'],
      ['Enter', 'Manual shutter'],
      ['Tab', 'Cycle objective'],
      ['Esc', 'Pause'],
    ]),
    touch: Object.freeze([
      ['Drag', 'Pitch and roll while held'],
      ['THR', 'Throttle strip'],
      ['RECON', 'Recon camera'],
      ['SHOOT', 'Manual shutter'],
      ['+ / −', 'Zoom'],
    ]),
    gamepad: Object.freeze([
      ['Left stick', 'Pitch and roll'],
      ['Right stick', 'Rudder'],
      ['RT / LT', 'Throttle'],
      ['RB', 'Recon camera (hold)'],
    ]),
  }),
});

/** Briefing rows for one selected control mode and the current input device. */
export function controlRows(mode = 'assisted', modality = 'keyboard') {
  const safeMode = mode === 'direct' ? 'direct' : 'assisted';
  const safeModality = ['touch', 'gamepad'].includes(modality) ? modality : 'keyboard';
  return CONTROL_COPY[safeMode][safeModality].map((row) => [...row]);
}

const COARSE_POINTER = window.matchMedia?.('(pointer: coarse)').matches ?? false;
const REDUCED_MOTION = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  'a[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function visibleFocusables(layer) {
  return [...layer.querySelectorAll(FOCUSABLE_SELECTOR)].filter((node) => {
    if (node.tabIndex < 0) return false;
    if (node.closest('[hidden], [aria-hidden="true"], [inert]')) return false;
    return node.getClientRects().length > 0;
  });
}

export class Screens {
  constructor(root, callbacks) {
    this.root = root;
    this.callbacks = callbacks;
    this.current = null;
    this._destroyed = false;
    this._loadingRemoveTimer = 0;
    this._titleCleanup = null;
    this._focusFrame = 0;
    this._returnFocus = null;
    this._noticeDismiss = null;
    this._noticeTimer = 0;
    this._noticeRemaining = 0;
    this._noticeStartedAt = 0;
    this._onNoticeVisibility = null;
    this._onDialogKeyDown = (event) => this._trapDialogFocus(event);

    this._buildVeil();
    this._buildNotice();
    this._buildLoading();
    this._buildTitle();
    this._buildBriefing();
    this._buildDebrief();
    this._buildPause();

    const layers = [
      [this.titleLayer, 'Operation Safed Sagar title and dedication'],
      [this.briefingLayer, 'Sortie briefing'],
      [this.debriefLayer, 'Sortie debrief'],
      [this.pauseLayer, 'Pause and options'],
    ];
    for (const [layer, label] of layers) {
      layer.setAttribute('role', 'dialog');
      layer.setAttribute('aria-label', label);
      layer.setAttribute('aria-modal', 'true');
      layer.setAttribute('aria-hidden', 'true');
      layer.inert = true;
    }
    document.addEventListener('keydown', this._onDialogKeyDown);
  }

  // --------------------------------------------------------- transitions --

  /**
   * A single reusable wipe used for every cinematic change of screen.
   *
   * Cross-fading two absolutely positioned layers over a live 3D scene reads as
   * a web page swapping divs, which is exactly what the brief rules out. A hard
   * bar driven across the frame reads as a cut. It is deliberately *not* used
   * for the pause menu: pausing is not a cinematic moment, and wiping in and
   * out of it every time the player presses Escape would be exhausting.
   */
  _buildVeil() {
    this.veil = el('div', 'veil', this.root);
    el('i', '', this.veil);
  }

  _sweep() {
    if (REDUCED_MOTION) return;
    this.veil.classList.remove('run');
    // Force a reflow so removing and re-adding the class actually restarts the
    // animation; without it the class change is coalesced and nothing plays.
    void this.veil.offsetWidth;
    this.veil.classList.add('run');
  }

  // ------------------------------------------------------------ notices --

  _buildNotice() {
    this.noticeBar = el('div', 'notice', this.root);
    this.noticeBar.setAttribute('role', 'status');
    this.noticeBar.setAttribute('aria-live', 'polite');
    this.noticeBar.setAttribute('aria-hidden', 'true');
    this.noticeText = el('span', '', this.noticeBar, '');
    const dismiss = el('button', 'notice-dismiss', this.noticeBar, 'Dismiss');
    dismiss.setAttribute('aria-label', 'Dismiss notice');
    dismiss.addEventListener('click', () => this.clearNotice());
  }

  /**
   * A non-blocking message the player still needs to be told about.
   *
   * Two kinds share this bar and they expire differently. A *failure* — the
   * airframe not loading, a terrain quality change refused — persists until
   * dismissed, because the notice is the only thing on screen explaining why
   * the game looks wrong. An *orientation* note like the assisted-controls one
   * has been read within a couple of seconds and then just sits over the
   * briefing, so it passes `autoDismissMs` and retires itself.
   *
   * @param {string} text
   * @param {(() => void)|null} [onDismiss]
   * @param {number} [autoDismissMs] 0 keeps the notice until dismissed
   */
  showNotice(text, onDismiss = null, autoDismissMs = 0) {
    this._stopNoticeTimer();
    this._noticeDismiss = typeof onDismiss === 'function' ? onDismiss : null;
    // Expose the live region *before* writing into it. Assistive technology
    // generally ignores mutations inside an aria-hidden subtree and does not
    // re-announce on unhide, so setting the text first meant the notice could
    // reach the screen without ever being announced.
    this.noticeBar.setAttribute('aria-hidden', 'false');
    this.noticeBar.classList.add('show');
    this.noticeText.textContent = text;
    if (Number.isFinite(autoDismissMs) && autoDismissMs > 0) this._startNoticeTimer(autoDismissMs);
  }

  clearNotice() {
    this._stopNoticeTimer();
    this.noticeBar.classList.remove('show');
    this.noticeBar.setAttribute('aria-hidden', 'true');
    const acknowledge = this._noticeDismiss;
    this._noticeDismiss = null;
    acknowledge?.();
  }

  /**
   * Count down only while the page is actually being looked at.
   *
   * A plain setTimeout keeps running in a background tab, so alt-tabbing away
   * from the briefing burned the whole window and the player came back to a
   * notice that had already fired its onDismiss — and that callback is what
   * marks the assist note as seen, so it would never have been shown again.
   * The remaining time is banked on hide and re-armed on show.
   */
  _startNoticeTimer(ms) {
    this._noticeRemaining = ms;
    this._noticeStartedAt = now();
    if (!this._onNoticeVisibility) {
      this._onNoticeVisibility = () => this._syncNoticeTimer();
      document.addEventListener('visibilitychange', this._onNoticeVisibility);
    }
    // Do not start the clock for a player who is not looking at the page. The
    // banking logic below only runs on a visibilitychange, so a notice *armed*
    // while the tab was already in the background used to spend its whole
    // window unseen — and the assist note's onDismiss marks it seen forever, so
    // it would never be shown again. The title sequence resolves on its own
    // timers, which keep running in a background tab, so this is reachable
    // simply by opening the game in a new tab and looking away.
    if (document.visibilityState === 'hidden') return;
    this._noticeTimer = setTimeout(() => {
      this._noticeTimer = 0;
      this.clearNotice();
    }, ms);
  }

  _syncNoticeTimer() {
    if (!this._noticeRemaining) return;
    if (document.visibilityState === 'hidden') {
      if (!this._noticeTimer) return;
      clearTimeout(this._noticeTimer);
      this._noticeTimer = 0;
      this._noticeRemaining = Math.max(0, this._noticeRemaining - (now() - this._noticeStartedAt));
      return;
    }
    if (this._noticeTimer) return;
    this._startNoticeTimer(this._noticeRemaining);
  }

  _stopNoticeTimer() {
    if (this._noticeTimer) clearTimeout(this._noticeTimer);
    this._noticeTimer = 0;
    this._noticeRemaining = 0;
    if (this._onNoticeVisibility) {
      document.removeEventListener('visibilitychange', this._onNoticeVisibility);
      this._onNoticeVisibility = null;
    }
  }

  /**
   * Hand a hard failure to the bootstrap surface in index.html.
   *
   * @param {'webgl2'|'context'|'boot'} kind
   */
  showFailure(kind, detail) {
    window.__sagar?.fail(kind, detail);
  }

  // ------------------------------------------------------------- loading --

  _buildLoading() {
    const layer = document.createElement('div');
    layer.id = 'loading';
    layer.setAttribute('role', 'status');
    layer.setAttribute('aria-live', 'polite');
    layer.setAttribute('aria-busy', 'true');
    document.body.appendChild(layer);
    const stack = el('div', 'stack centre', layer);
    stack.style.setProperty('--gap', '0.9rem');
    const inner = el('div', '', stack);
    el('div', 'eyebrow', inner, '1999 • KARGIL');
    const bar = el('div', 'load-bar', inner);
    bar.setAttribute('role', 'progressbar');
    bar.setAttribute('aria-label', 'Loading sortie');
    bar.setAttribute('aria-valuemin', '0');
    bar.setAttribute('aria-valuemax', '100');
    this.loadFill = el('i', '', bar);
    const legend = el('div', 'load-legend', inner);
    this.loadLabel = el('span', '', legend, 'Preparing sector');
    this.loadPercent = el('b', '', legend, '0%');
    this.loadingLayer = layer;

    this._progress = 0;
    this._progressFloor = 0;
    this._progressCeil = 0;
    this._bytes = null;
    this._raf = 0;
  }

  /**
   * @param {number} t          fraction complete at this stage boundary
   * @param {string} [label]    what the player is waiting for during the *next*
   *                            stage; defaults to a name derived from `t`
   */
  setProgress(t, label) {
    const clamped = Math.max(0, Math.min(1, t));
    this._progressFloor = Math.max(this._progressFloor, clamped);
    this._progress = Math.max(this._progress, clamped);
    this._bytes = null;

    const stage = LOAD_STAGES.findIndex(([edge]) => clamped < edge);
    const next = stage >= 0 ? stage : LOAD_STAGES.length - 1;
    // Creep no further than most of the way to the next anchor: a bar that
    // reaches 100% and then waits is a worse lie than one that slows down.
    this._progressCeil =
      clamped + (LOAD_STAGES[next][0] - clamped) * 0.82;
    this.loadLabel.textContent = label ?? LOAD_STAGES[next][1];
    this._pump();
  }

  /**
   * Real byte progress for the stage in flight.
   *
   * Exists because the only genuinely slow part of the load — the 5.4 MB
   * airframe — reports nothing today, so the bar parks at 35% on a slow link
   * and the experience looks hung. `GLTFLoader` forwards an `onProgress`
   * `ProgressEvent`; pass its `loaded` and `total` straight through. `total` is
   * zero when the response is chunked with no Content-Length, in which case the
   * asymptotic creep below is still the best available answer.
   */
  setLoadBytes(loaded, total) {
    if (!total || total <= 0) return;
    this._bytes = { loaded, total };
    const span = this._progressCeil - this._progressFloor;
    this._progress = Math.max(
      this._progress,
      this._progressFloor + span * Math.min(1, loaded / total),
    );
    const mb = (total / 1048576).toFixed(1);
    this.loadLabel.textContent = `Loading airframe — ${(loaded / 1048576).toFixed(1)} / ${mb} MB`;
    this._paint();
  }

  /**
   * Ease the bar toward the ceiling of the current stage while nothing else is
   * reporting. Asymptotic rather than linear, so it never arrives and never
   * implies a completion time it cannot know.
   */
  _pump() {
    if (this._raf) return;
    let last = performance.now();
    const step = (now) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      this._raf = 0;
      if (!this.loadingLayer.isConnected || this._progress >= 1) {
        this._paint();
        return;
      }
      if (!this._bytes && this._progress < this._progressCeil) {
        this._progress += (this._progressCeil - this._progress) * (1 - Math.exp(-0.55 * dt));
      }
      this._paint();
      this._raf = requestAnimationFrame(step);
    };
    this._raf = requestAnimationFrame(step);
  }

  _paint() {
    const t = Math.max(0, Math.min(1, this._progress));
    this.loadFill.style.transform = `scaleX(${t})`;
    const pct = `${Math.round(t * 100)}%`;
    if (this.loadPercent.textContent !== pct) this.loadPercent.textContent = pct;
    this.loadFill.parentElement.setAttribute('aria-valuenow', String(Math.round(t * 100)));
  }

  hideLoading() {
    this._progress = 1;
    this._paint();
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
    // From here on a thrown error is a runtime problem, not a failure to boot,
    // and the bootstrap should stop escalating every one of them to a full
    // screen the player cannot get past.
    if (window.__sagar) window.__sagar.booted = true;
    this.loadingLayer.setAttribute('aria-busy', 'false');
    this.loadingLayer.classList.add('done');
    clearTimeout(this._loadingRemoveTimer);
    this._loadingRemoveTimer = setTimeout(() => {
      this._loadingRemoveTimer = 0;
      this.loadingLayer.remove();
    }, 900);
  }

  // --------------------------------------------------------------- title --

  _buildTitle() {
    const layer = el('div', 'layer letterbox', this.root);
    el('div', 'scrim', layer);
    const centre = el('div', 'centre', layer);
    const stack = el('div', 'stack', centre);

    // Stage 1 — place and date.
    this.t1 = el('div', 'stack', stack);
    el('div', 'eyebrow', this.t1, '1999 • KARGIL');
    el('div', 'lede', this.t1, 'High above the Himalayas, courage took flight.');

    // Stage 2 — the title itself.
    this.t2 = el('div', 'stack', stack);
    this.t2.style.setProperty('--gap', '1.1rem');
    el('h1', 'title', this.t2, 'Safed Sagar');
    el('div', 'tricolour', this.t2);
    el('div', 'subtitle', this.t2, 'A Reconnaissance Flight Experience');

    // Stage 3 — dedication.
    this.t3 = el('div', 'stack', stack);
    const ded = el('div', 'dedication', this.t3);
    el(
      'p',
      '',
      ded,
      'Inspired by the courage and sacrifice of the Indian Armed Forces during the Kargil War.',
    );
    el(
      'p',
      '',
      ded,
      'With special respect to the Indian Air Force personnel who flew Operation Safed Sagar in ' +
        'support of soldiers fighting on the ground.',
    );
    el('p', '', ded, 'In remembrance of all those who made the supreme sacrifice in service of India.');
    writeJaiHind(el('div', 'jaihind', this.t3));

    // A real button, not a line of decorative text.
    //
    // The prompt used to read "Press any key to continue" on a sequence whose
    // last stage held forever and could only be dismissed by `input.anyPress()`
    // — which is fed exclusively by keydown. A mouse-only desktop player and
    // every touch player were stuck on the title with no way out at all. It is
    // now focusable, clickable and tappable, the whole layer accepts a pointer
    // press, and the label says what actually works on this device.
    this.titlePrompt = el('button', 'prompt', stack, promptLabel());
    this.titlePrompt.type = 'button';
    this.titlePrompt.tabIndex = -1;

    el('div', 'disclaimer', layer, DISCLAIMER);

    this.titleLayer = layer;
    for (const s of [this.t1, this.t2, this.t3, this.titlePrompt]) {
      s.style.transition = REDUCED_MOTION ? 'none' : 'opacity 1100ms ease';
      s.style.opacity = '0';
    }
  }

  /**
   * Runs the staged title fade. Resolves when the player skips or it finishes,
   * so the caller can simply await it.
   *
   * The sequence is gated on a press before any of it plays. That is not a
   * dramatic choice, it is the autoplay policy: a browser will not start audio
   * without a user gesture, and this screen used to consume the only gesture
   * available — its layer dismissed the whole sequence on `pointerdown`, so the
   * press that could have started the score was the same press that ended the
   * cards it belonged under. Measured on a cold load with no input, the context
   * was never even constructed and the dedication played in silence for all
   * 13.4 seconds. Holding on the prompt until the player asks for it buys the
   * gesture honestly, and the score runs from the first card.
   */
  async playTitle(skipSignal) {
    this._titleCleanup?.();
    this.show(this.titleLayer);
    for (const node of [this.t1, this.t2, this.t3, this.titlePrompt]) node.style.opacity = '0';
    this.titlePrompt.classList.remove('live');
    this.titlePrompt.tabIndex = -1;

    await this._awaitTitleGate(skipSignal);
    if (this._destroyed) return;
    await this._runTitleStages(skipSignal);
  }

  /**
   * Hold on the prompt until the player presses something.
   *
   * Resolves on the same three inputs the sequence itself accepts, so whatever
   * a player reaches for works: a press anywhere on the layer, the prompt's own
   * activation, and the keyboard signal Game feeds in.
   */
  _awaitTitleGate(skipSignal) {
    this.titlePrompt.textContent = gateLabel();
    this.titlePrompt.style.opacity = '1';
    this.titlePrompt.classList.add('live');
    this.titlePrompt.tabIndex = 0;
    if (this.current === this.titleLayer) this.titlePrompt.focus({ preventScroll: true });

    return new Promise((resolve) => {
      let done = false;
      const open = () => {
        if (done) return;
        done = true;
        skipSignal.off(open);
        this.titleLayer.removeEventListener('pointerdown', onPointer);
        this.titlePrompt.removeEventListener('click', open);
        if (this._titleCleanup === open) this._titleCleanup = null;
        // Hand the prompt back the way the staged sequence expects to find it.
        this.titlePrompt.style.opacity = '0';
        this.titlePrompt.classList.remove('live');
        this.titlePrompt.tabIndex = -1;
        this.titlePrompt.textContent = promptLabel();
        resolve();
      };
      const onPointer = (e) => {
        e.preventDefault();
        open();
      };
      this._titleCleanup = open;
      this.titleLayer.addEventListener('pointerdown', onPointer);
      this.titlePrompt.addEventListener('click', open);
      skipSignal.on(open);
    });
  }

  _runTitleStages(skipSignal) {
    const stages = REDUCED_MOTION
      ? [
          { node: this.t3, at: 0, hold: Infinity },
          { node: this.titlePrompt, at: 0, hold: Infinity },
        ]
      : [
          { node: this.t1, at: 700, hold: 4200 },
          { node: this.t2, at: 5200, hold: 5200 },
          { node: this.t3, at: 10800, hold: 11500 },
          { node: this.titlePrompt, at: 13400, hold: Infinity },
        ];
    const timers = [];
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        timers.forEach(clearTimeout);
        skipSignal.off(finish);
        this.titleLayer.removeEventListener('pointerdown', onPointer);
        this.titlePrompt.removeEventListener('click', finish);
        if (this._titleCleanup === finish) this._titleCleanup = null;
        resolve();
      };
      this._titleCleanup = finish;
      // Pointer-agnostic: a mouse press, a stylus and a finger all land here,
      // and `pointerdown` fires before the synthesised click so the sequence
      // dismisses on contact rather than on release.
      const onPointer = (e) => {
        e.preventDefault();
        finish();
      };

      for (const s of stages) {
        timers.push(setTimeout(() => (s.node.style.opacity = '1'), s.at));
        if (Number.isFinite(s.hold)) {
          timers.push(setTimeout(() => (s.node.style.opacity = '0'), s.at + s.hold));
        }
      }
      // Focus the prompt when it appears so keyboard and screen-reader users
      // reach it too, and so Enter and Space activate it natively.
      timers.push(
        setTimeout(() => {
          this.titlePrompt.classList.add('live');
          this.titlePrompt.tabIndex = 0;
          if (this.current === this.titleLayer) this.titlePrompt.focus({ preventScroll: true });
        }, stages.at(-1).at),
      );

      this.titleLayer.addEventListener('pointerdown', onPointer);
      this.titlePrompt.addEventListener('click', finish);
      skipSignal.on(finish);
    });
  }

  // ------------------------------------------------------------ briefing --

  _buildBriefing() {
    const layer = el('div', 'layer', this.root);
    el('div', 'scrim', layer);
    const centre = el('div', 'centre', layer);
    const grid = el('div', 'briefing', centre);

    const left = el('div', 'brief-col', grid);
    el('div', 'eyebrow', left, 'Fictional operation • Western Himalaya');
    el('h2', 'brief-heading', left, 'Sortie Briefing');
    const body = el('div', 'brief-body', left);
    body.innerHTML =
      '<p>Enemy observation posts have been established on the ridgelines and passes ' +
      'overlooking the valley. Their positions are unconfirmed.</p>' +
      '<p>Fly the sector, locate each post, and bring back <strong>usable ' +
      'photographs</strong>. Frame the position squarely, get close enough for detail, ' +
      'and keep it in clear line of sight — a ridge between you and the target ruins ' +
      'the plate.</p>' +
      '<p>You are unarmed. Terrain is the only thing out here that can end the sortie.</p>';

    const list = el('div', 'panel', left);
    list.style.marginTop = '20px';
    el('div', 'panel-title', list, 'Objectives');
    this.targetList = el('ul', 'target-list', list);

    const right = el('div', 'brief-col', grid);
    const controls = el('div', 'panel', right);
    el('div', 'panel-title', controls, 'Controls');
    this.controlsGrid = el('div', 'controls-grid', controls);
    this._controlMode = null;
    this._controlModality = null;
    this.setControlContext({ controlMode: 'assisted', modality: COARSE_POINTER ? 'touch' : 'keyboard' });

    const menu = el('div', 'menu', right);
    menu.style.marginTop = '20px';
    this.launchButton = el('button', 'primary', menu, 'Begin Sortie');
    this.launchButton.addEventListener('click', () => this.callbacks.onLaunch());

    el('div', 'disclaimer', layer, DISCLAIMER);
    this.briefingLayer = layer;
  }

  setTargets(posts) {
    this.targetList.innerHTML = '';
    this._targetRows = posts.map((post) => {
      const li = el('li', '', this.targetList);
      const mark = el('span', 'mark', li, '□');
      el('span', 'name', li, post.callsign);
      el('span', 'id', li, post.id);
      li._mark = mark;
      li._done = false;
      return li;
    });
  }

  refreshTargets(posts) {
    if (!this._targetRows) return;
    // Called every frame from the game loop, so it writes only on a change.
    // Blind `classList.toggle` and `textContent` writes for every objective on
    // every frame are exactly the kind of thing that shows up in a profile for
    // no reason at all.
    posts.forEach((post, i) => {
      const row = this._targetRows[i];
      if (!row || row._done === post.captured) return;
      row._done = post.captured;
      row.classList.toggle('done', post.captured);
      row._mark.textContent = post.captured ? '■' : '□';
    });
  }

  setControlContext({ controlMode = 'assisted', modality = 'keyboard' } = {}) {
    const mode = controlMode === 'direct' ? 'direct' : 'assisted';
    const device = ['touch', 'gamepad'].includes(modality) ? modality : 'keyboard';
    if (mode === this._controlMode && device === this._controlModality) return;
    this._controlMode = mode;
    this._controlModality = device;
    if (!this.controlsGrid) return;
    this.controlsGrid.innerHTML = '';
    for (const [key, label] of controlRows(mode, device)) {
      el('kbd', '', this.controlsGrid, key);
      el('div', '', this.controlsGrid, label);
    }
  }

  // ------------------------------------------------------------- debrief --

  _buildDebrief() {
    const layer = el('div', 'layer letterbox', this.root);
    el('div', 'scrim', layer);
    const centre = el('div', 'centre', layer);
    const stack = el('div', 'stack debrief', centre);
    stack.style.setProperty('--gap', '1.5rem');

    // Two separate cards, and the separation is the point rather than a layout
    // preference. The closing lines are real remembrance; graded photographs,
    // imagery quality and a stopwatch are a fictional sortie's results. Stacking
    // them together put "In remembrance" directly above a letter grade, which is
    // exactly the gamification of sacrifice the brief rules out. The ending is
    // shown alone, and the record is a deliberate second step the player asks
    // for. A failed sortie carries no remembrance line, so it skips straight to
    // the record.
    this.endingCard = el('div', 'stack', stack);
    this.resultTitle = el('h2', 'result-title', this.endingCard, '');
    this.resultLine = el('div', 'result-line', this.endingCard, '');
    this.resultQuote = el('div', 'lede', this.endingCard, '');
    this.resultJai = el('div', 'jaihind', this.endingCard, '');
    const endingMenu = el('div', 'menu', this.endingCard);
    this.continueButton = el('button', '', endingMenu, 'Continue');
    this.continueButton.addEventListener('click', () => this._showRecord());

    this.recordCard = el('div', 'stack', stack);
    // "— fictional" came off the heading because the framing is already carried
    // where it belongs: the briefing eyebrow reads "Fictional operation" and so
    // does the page description. Repeating it over the contact sheet made the
    // one line the player reads as a result caption argue with itself.
    el('div', 'eyebrow record-eyebrow', this.recordCard, 'Sortie record');
    this.contactSheet = el('div', 'contact-sheet', this.recordCard);
    this.statsRow = el('div', 'stats', this.recordCard);
    this._buildLeaderboard(this.recordCard);
    const menu = el('div', 'menu', this.recordCard);
    this.debriefButton = el('button', 'primary', menu, 'Retry Sortie');
    this.debriefButton.addEventListener('click', () => this.callbacks.onRestart());

    this.debriefLayer = layer;
  }

  _showRecord() {
    this.endingCard.style.display = 'none';
    this.endingCard.setAttribute('aria-hidden', 'true');
    this.recordCard.style.display = '';
    this.recordCard.setAttribute('aria-hidden', 'false');
    this.debriefButton.focus();
  }

  // --------------------------------------------------------- leaderboard --

  /**
   * Fastest complete sorties on this machine.
   *
   * It sits on the record card and nowhere else. The record card is already the
   * one place in this experience where a number is allowed to be a result — the
   * comment above _buildDebrief spells out why the remembrance card is kept
   * separate from anything scored, and a ranked list of times is exactly the
   * thing that separation exists to keep away from it.
   */
  _buildLeaderboard(parent) {
    this.boardSection = el('section', 'board', parent);
    this.boardSection.setAttribute('aria-label', 'Fastest sorties');
    el('div', 'eyebrow board-eyebrow', this.boardSection, 'Fastest sorties');

    this.boardEntry = el('form', 'board-entry', this.boardSection);
    const label = el('label', 'board-label', this.boardEntry, 'Callsign');
    this.boardName = el('input', 'board-name', this.boardEntry);
    this.boardName.type = 'text';
    this.boardName.maxLength = NAME_MAX;
    this.boardName.placeholder = 'PILOT';
    this.boardName.autocomplete = 'off';
    this.boardName.spellcheck = false;
    this.boardName.id = 'board-callsign';
    label.setAttribute('for', this.boardName.id);
    this.boardSubmit = el('button', 'board-save', this.boardEntry, 'Record time');
    this.boardSubmit.type = 'submit';
    this.boardEntry.addEventListener('submit', (event) => {
      event.preventDefault();
      this._recordTime();
    });

    this.boardNote = el('p', 'board-note', this.boardSection, '');
    this.boardNote.setAttribute('role', 'status');
    this.boardList = el('ol', 'board-list', this.boardSection);
  }

  /** @param {{leaderboard: object}} context */
  setLeaderboard(context) {
    this._board = context?.leaderboard ?? null;
  }

  /**
   * Prepare the board for the sortie that has just ended.
   *
   * @param {boolean} success whether the sortie was completed rather than lost.
   *   Checked as well as the objective count because the two can disagree for a
   *   frame: securing the last site and hitting the ridge in the same update
   *   leaves the mission failed with every objective captured, and a sortie
   *   that ended in the mountain must not take a place on the board.
   */
  _showBoardFor(mission, grade, success = true) {
    if (!this._board) {
      this.boardSection.style.display = 'none';
      return;
    }
    this.boardSection.style.display = '';
    const total = mission.posts.length;
    const rankable = success && isRankable({
      captured: mission.captured,
      total,
      seconds: mission.elapsed,
    });
    this._boardRun = rankable
      ? {
        seconds: mission.elapsed,
        grade,
        objectives: `${mission.captured}/${total}`,
        at: Date.now(),
      }
      : null;
    this._boardName = null;
    this.boardName.value = this._board.lastName();
    this._renderBoard(this._board.read(), {
      rank: null,
      improved: false,
      recorded: false,
      rankable,
    });
  }

  _recordTime() {
    if (!this._board || !this._boardRun) return;
    const name = sanitiseName(this.boardName.value);
    if (!name) {
      this.boardNote.textContent =
        `Callsign must be ${NAME_MIN}–${NAME_MAX} characters: letters, digits, spaces, . _ or -`;
      this.boardName.focus();
      return;
    }
    const result = this._board.submit({ ...this._boardRun, name });
    this._boardName = name;
    const hadFocus = this.boardEntry.contains(document.activeElement);
    this._renderBoard(result.entries, {
      rank: result.rank,
      improved: result.improved,
      recorded: true,
    });
    // _renderBoard hides the form, which would drop focus to <body> and strand
    // a keyboard player outside the dialog's tab ring.
    if (hadFocus) this.debriefButton?.focus();
  }

  /**
   * @param {Array} entries
   * @param {{rank: number|null, improved: boolean, recorded: boolean, rankable: boolean}} state
   */
  _renderBoard(entries, state) {
    const rankable = state.rankable ?? true;
    // The entry form only appears for a run that could actually place. Showing
    // it after a partial sortie invites the player to press a button that is
    // going to refuse them.
    this.boardEntry.style.display = rankable && !state.recorded ? '' : 'none';

    if (!rankable) {
      this.boardNote.textContent = 'Secure every objective to record a sortie time.';
    } else if (state.recorded && state.rank && state.improved) {
      this.boardNote.textContent = `Recorded at number ${state.rank}.`;
    } else if (state.recorded && state.rank) {
      this.boardNote.textContent = `Your best stands at number ${state.rank}.`;
    } else if (state.recorded) {
      this.boardNote.textContent = 'Recorded, but outside the top ten.';
    } else {
      this.boardNote.textContent = '';
    }

    this.boardList.innerHTML = '';
    if (!entries.length) {
      el('li', 'board-empty', this.boardList, 'No sorties recorded yet.');
      return;
    }
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const row = el('li', 'board-row', this.boardList);
      if (state.recorded && entry.name === this._boardName) row.classList.add('mine');
      el('span', 'board-rank', row, String(i + 1));
      el('span', 'board-who', row, entry.name);
      el('span', 'board-time', row, formatDuration(entry.seconds));
      el('span', 'board-grade', row, entry.grade || '');
    }
  }

  /**
   * One exposure on the contact sheet.
   *
   * Presented as a developed plate rather than a thumbnail — gate rails, a
   * frame number, and the bearing, range and altitude it was taken from —
   * because the sheet is the mission's product. A grid of bare screenshots says
   * "gallery"; a stamped plate says "intelligence", which is what the player
   * spent the sortie collecting.
   */
  _buildPlate(post) {
    const card = el('figure', 'plate', this.contactSheet);
    const window_ = el('div', 'plate-window', card);
    const shot = post.photo;

    if (shot.dataUrl) {
      const img = el('img', '', window_);
      img.src = shot.dataUrl;
      img.alt = `Reconnaissance photograph of ${post.callsign}`;
    } else {
      const wait = el('div', 'plate-wet', window_, 'DEVELOPING');
      shot.ready?.then(() => {
        if (!window_.isConnected) return;
        wait.remove();
        if (!shot.dataUrl) {
          el('div', 'plate-wet', window_, 'PLATE SPOILED');
          return;
        }
        const img = el('img', '', window_);
        img.src = shot.dataUrl;
        img.alt = `Reconnaissance photograph of ${post.callsign}`;
      });
    }

    const stamp = el('figcaption', 'plate-stamp', card);
    el('span', 'callsign', stamp, post.callsign);
    el('b', '', stamp, gradeFor(post.bestScore));

    const data = el('div', 'plate-data', card);
    const parts = [`EXP ${String(shot.frame ?? 0).padStart(3, '0')}`];
    if (Number.isFinite(shot.bearing)) {
      parts.push(`BRG ${String(Math.round(shot.bearing)).padStart(3, '0')}°`);
    }
    if (Number.isFinite(shot.range)) {
      parts.push(
        shot.range > 1000 ? `RNG ${(shot.range / 1000).toFixed(1)}KM` : `RNG ${Math.round(shot.range)}M`,
      );
    }
    if (Number.isFinite(shot.altitude)) parts.push(`ALT ${Math.round(shot.altitude)}M`);
    data.textContent = parts.join('  ·  ');
  }

  showDebrief(mission, success) {
    this.resultTitle.textContent = success ? 'Mission Accomplished' : 'Sortie Ended';
    this.resultTitle.className = `result-title ${success ? 'good' : 'bad'}`;
    this.resultLine.textContent = success
      ? 'Reconnaissance complete. Intelligence secured.'
      : 'Mission incomplete.';
    this.resultQuote.textContent = success
      ? 'For those who flew into impossible skies, and those who held the mountains below.'
      : 'Regroup. Return to the skies.';
    this.resultJai.style.display = success ? '' : 'none';
    if (success) writeJaiHind(this.resultJai);
    else this.resultJai.textContent = '';
    this.debriefButton.textContent = success ? 'Fly Again' : 'Retry Sortie';

    // Only a completed sortie gets the remembrance card; a failed one has no
    // memorial line to keep apart, and making the player click past a card that
    // ends "Regroup. Return to the skies." before they can retry is friction
    // for nothing.
    this.endingCard.style.display = success ? '' : 'none';
    this.endingCard.setAttribute('aria-hidden', String(!success));
    this.recordCard.style.display = success ? 'none' : '';
    this.recordCard.setAttribute('aria-hidden', String(success));

    this.contactSheet.innerHTML = '';
    for (const post of mission.posts) {
      if (post.photo) this._buildPlate(post);
      else el('div', 'plate empty', this.contactSheet, `${post.callsign} — NO IMAGERY`);
    }

    const minutes = Math.floor(mission.elapsed / 60);
    const seconds = Math.floor(mission.elapsed % 60);
    const scored = mission.posts.filter((p) => p.captured);
    const avg = scored.length
      ? scored.reduce((a, p) => a + p.bestScore, 0) / scored.length
      : 0;

    this.statsRow.innerHTML = '';
    const stat = (k, v) => {
      const s = el('div', 'stat', this.statsRow);
      el('div', 'k', s, k);
      el('div', 'v', s, v);
    };
    stat('Objectives', `${mission.captured} / ${mission.posts.length}`);
    stat('Imagery quality', scored.length ? gradeFor(avg) : '—');
    stat('Sortie time', `${minutes}:${String(seconds).padStart(2, '0')}`);
    stat('Distance flown', `${(mission.distanceFlown / 1000).toFixed(1)} km`);
    stat('Exposures', String(mission.photosTaken));

    this._showBoardFor(mission, scored.length ? gradeFor(avg) : '', success);

    this.show(this.debriefLayer);
  }

  // --------------------------------------------------------------- pause --

  _buildPause() {
    const layer = el('div', 'layer', this.root);
    el('div', 'scrim', layer);
    const centre = el('div', 'centre', layer);
    const stack = el('div', 'stack', centre);
    el('div', 'eyebrow', stack, 'Sortie paused');
    const menu = el('div', 'menu', stack);
    const resume = el('button', 'primary', menu, 'Resume');
    resume.addEventListener('click', () => this.callbacks.onResume());

    const options = el('div', 'options', menu);

    const qualityWrap = el('div', 'option', options);
    el('div', 'panel-title', qualityWrap, 'Graphics quality');
    const row = el('div', 'segmented', qualityWrap);
    row.setAttribute('role', 'group');
    row.setAttribute('aria-label', 'Graphics quality');
    this.qualityButtons = {};
    for (const tier of QUALITY_CHOICES) {
      const b = el('button', '', row, tier);
      b.setAttribute('aria-pressed', 'false');
      b.addEventListener('click', () => this.callbacks.onQuality(tier));
      this.qualityButtons[tier] = b;
    }

    // The score and the engine start unprompted on a synthesised soundtrack, so
    // "no way to turn it down" is not a missing nicety — it is the first thing a
    // player reaches for. All three of these were already persisted and honoured
    // by Settings; the only thing missing was somewhere to set them.
    const audio = el('div', 'option', options);
    el('div', 'panel-title', audio, 'Audio');
    this.masterSlider = this._slider(audio, 'Master', (v) =>
      this.callbacks.onMasterVolume?.(v),
    );
    this.musicSlider = this._slider(audio, 'Score', (v) => this.callbacks.onMusicVolume?.(v));

    const flying = el('div', 'option flying-options', options);
    el('div', 'panel-title', flying, 'Flying');
    this.controlModeButtons = this._choiceButtons(
      flying, 'Control mode', [['assisted', 'Assisted'], ['direct', 'Direct']],
      (value) => {
        this._setChoice(this.controlModeButtons, value);
        this.setControlContext({ controlMode: value, modality: this._controlModality });
        this.callbacks.onControlMode?.(value);
      },
    );
    this.sensitivityButtons = this._choiceButtons(
      flying, 'Sensitivity', [['low', 'Low'], ['normal', 'Normal'], ['high', 'High']],
      (value) => {
        this._setChoice(this.sensitivityButtons, value);
        this.callbacks.onControlSensitivity?.(value);
      },
    );
    const autoRow = el('div', 'toggle-row', flying);
    el('span', '', autoRow, 'Auto throttle');
    this.autoThrottleButton = el('button', 'toggle', autoRow, 'On');
    this.autoThrottleButton.setAttribute('aria-label', 'Auto throttle');
    this.autoThrottleButton.setAttribute('aria-pressed', 'true');
    this.autoThrottleButton.addEventListener('click', () => {
      const next = this.autoThrottleButton.getAttribute('aria-pressed') !== 'true';
      this._setToggle(this.autoThrottleButton, next);
      this.callbacks.onAutoThrottle?.(next);
    });
    this.verticalModeButtons = this._choiceButtons(
      flying, 'Analogue vertical direction',
      [['upToClimb', 'Up climbs'], ['upToDive', 'Up dives']],
      (value) => {
        this._setChoice(this.verticalModeButtons, value);
        this.callbacks.onVerticalMode?.(value);
      },
    );

    const restart = el('button', '', menu, 'Abort and Restart');
    restart.addEventListener('click', () => this.callbacks.onRestart());
    this.pauseLayer = layer;
  }

  _slider(parent, label, onInput) {
    const row = el('label', 'slider-row', parent);
    el('span', '', row, label);
    const input = document.createElement('input');
    input.type = 'range';
    input.min = '0';
    input.max = '100';
    input.step = '1';
    input.value = '80';
    row.appendChild(input);
    const value = el('b', '', row, '80');
    value.setAttribute('aria-hidden', 'true');
    input.addEventListener('input', () => {
      value.textContent = input.value;
      onInput(Number(input.value) / 100);
    });
    input._value = value;
    return input;
  }

  _choiceButtons(parent, label, choices, onChoice) {
    const wrap = el('div', 'control-choice', parent);
    el('span', 'option-label', wrap, label);
    const row = el('div', 'segmented', wrap);
    row.setAttribute('role', 'group');
    row.setAttribute('aria-label', label);
    const buttons = {};
    for (const [value, copy] of choices) {
      const button = el('button', '', row, copy);
      button.setAttribute('aria-pressed', 'false');
      button.addEventListener('click', () => onChoice(value));
      buttons[value] = button;
    }
    return buttons;
  }

  _setChoice(buttons, selected) {
    for (const [value, button] of Object.entries(buttons)) {
      button.setAttribute('aria-pressed', String(value === selected));
    }
  }

  _setToggle(button, on) {
    button.setAttribute('aria-pressed', String(on));
    button.textContent = on ? 'On' : 'Off';
  }

  /**
   * Seed the option controls from persisted Settings. Safe to call at any time;
   * anything omitted keeps its current value.
   */
  setOptions({
    masterVolume,
    musicVolume,
    controlMode,
    controlSensitivity,
    autoThrottle,
    verticalMode,
  } = {}) {
    const apply = (input, v) => {
      if (typeof v !== 'number') return;
      input.value = String(Math.round(Math.max(0, Math.min(1, v)) * 100));
      input._value.textContent = input.value;
    };
    apply(this.masterSlider, masterVolume);
    apply(this.musicSlider, musicVolume);
    if (controlMode === 'assisted' || controlMode === 'direct') {
      this._setChoice(this.controlModeButtons, controlMode);
      this.setControlContext({ controlMode, modality: this._controlModality });
    }
    if (['low', 'normal', 'high'].includes(controlSensitivity)) {
      this._setChoice(this.sensitivityButtons, controlSensitivity);
    }
    if (typeof autoThrottle === 'boolean') this._setToggle(this.autoThrottleButton, autoThrottle);
    if (verticalMode === 'upToClimb' || verticalMode === 'upToDive') {
      this._setChoice(this.verticalModeButtons, verticalMode);
    }
  }

  setQuality(tier) {
    for (const [name, button] of Object.entries(this.qualityButtons)) {
      button.setAttribute('aria-pressed', String(name === tier));
    }
  }

  // ---------------------------------------------------------------- misc --

  /**
   * Move focus within the open dialog, and never out of it.
   *
   * This moves focus *itself* on every Tab rather than only at the wrap points.
   * The previous version handled first/last and left everything in between to
   * the browser's own tab order — but Input.js has `Tab` in its PREVENT_DEFAULT
   * set and cancels it globally, so that default never ran and focus could only
   * ever reach the first and last control in a layer. Nothing exposed it until
   * the leaderboard added the first dialog with more than a row of buttons:
   * there was no way to Tab from the callsign field to the button beside it.
   * Doing the move here keeps the trap correct whatever Input decides to
   * suppress.
   */
  _trapDialogFocus(event) {
    if (event.key !== 'Tab' || !this.current) return;
    const focusable = visibleFocusables(this.current);
    event.preventDefault();
    if (!focusable.length) return;

    const active = document.activeElement;
    const index = focusable.indexOf(active);
    if (index === -1) {
      // Focus is outside the dialog: pull it back to the near end.
      focusable[event.shiftKey ? focusable.length - 1 : 0].focus();
      return;
    }
    const step = event.shiftKey ? -1 : 1;
    const next = (index + step + focusable.length) % focusable.length;
    focusable[next].focus();
  }

  _restoreDialogFocus() {
    const target = this._returnFocus;
    this._returnFocus = null;
    if (target?.isConnected && typeof target.focus === 'function') target.focus({ preventScroll: true });
  }

  show(layer) {
    // Pausing is not a cinematic beat, so it neither wipes in nor wipes out.
    if (layer !== this.pauseLayer && this.current !== this.pauseLayer) this._sweep();
    if (layer && !this.current) this._returnFocus = document.activeElement;
    cancelAnimationFrame(this._focusFrame);
    this._focusFrame = 0;
    for (const l of [this.titleLayer, this.briefingLayer, this.debriefLayer, this.pauseLayer]) {
      l.classList.toggle('show', l === layer);
      l.style.pointerEvents = l === layer ? 'auto' : 'none';
      l.setAttribute('aria-hidden', String(l !== layer));
      l.inert = l !== layer;
    }
    this.current = layer;
    if (!layer) {
      this._restoreDialogFocus();
      return;
    }
    if (layer && layer !== this.titleLayer) {
      this._focusFrame = requestAnimationFrame(() => {
        this._focusFrame = 0;
        if (!this._destroyed && this.current === layer) {
          visibleFocusables(layer)[0]?.focus({ preventScroll: true });
        }
      });
    }
  }

  hideAll() {
    this.show(null);
  }

  dispose() {
    if (this._destroyed) return;
    this._destroyed = true;
    this._restoreDialogFocus();
    document.removeEventListener('keydown', this._onDialogKeyDown);
    cancelAnimationFrame(this._focusFrame);
    this._focusFrame = 0;
    this._titleCleanup?.();
    this._titleCleanup = null;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
    clearTimeout(this._loadingRemoveTimer);
    this._loadingRemoveTimer = 0;
    // Drop the timer without running clearNotice(), which would fire the
    // pending onDismiss during teardown and mark a notice seen that the player
    // never actually saw.
    this._stopNoticeTimer();
    this._noticeDismiss = null;
    for (const node of [
      this.veil,
      this.noticeBar,
      this.loadingLayer,
      this.titleLayer,
      this.briefingLayer,
      this.debriefLayer,
      this.pauseLayer,
    ]) node?.remove();
    this.current = null;
  }
}

/** Say what actually dismisses the title on *this* device, and nothing else. */
function promptLabel() {
  return COARSE_POINTER ? 'Tap to continue' : 'Press any key or click to continue';
}

/**
 * The label on the gate, which starts the sequence rather than skipping it.
 * "Begin" rather than "continue" because at that point there is nothing yet to
 * continue from, and the press is doing real work: it is what allows the score
 * to play at all.
 */
function gateLabel() {
  return COARSE_POINTER ? 'Tap to begin' : 'Press any key or click to begin';
}
