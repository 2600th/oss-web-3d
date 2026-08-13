import { gradeFor } from '../game/ReconCamera.js';

/**
 * Title sequence, briefing, pause and both debriefs.
 *
 * Tone is the hard constraint here, not layout. The dedication is real
 * remembrance and is kept completely separate from anything scored: it appears
 * before the mission exists, on its own, with no UI chrome around it, and the
 * word "score" never shares a screen with it. The sortie itself is openly
 * fictional — invented callsigns, invented positions — so that nothing in the
 * gameplay can be mistaken for a depiction of real events or real people.
 */

const el = (tag, className, parent, text) => {
  const node = document.createElement(tag);
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

const JAI_HIND = supportsFlagEmoji() ? 'Jai Hind. \u{1F1EE}\u{1F1F3}' : 'Jai Hind.';

const DISCLAIMER =
  'A work of fiction. Not affiliated with, endorsed by, or representing the Indian Air Force, ' +
  'the Indian Army, the Ministry of Defence, or any broadcaster or production. ' +
  'All callsigns, positions and events depicted are invented.';

export class Screens {
  constructor(root, callbacks) {
    this.root = root;
    this.callbacks = callbacks;
    this.current = null;

    this._buildLoading();
    this._buildTitle();
    this._buildBriefing();
    this._buildDebrief();
    this._buildPause();
  }

  // ------------------------------------------------------------- loading --

  _buildLoading() {
    const layer = document.createElement('div');
    layer.id = 'loading';
    document.body.appendChild(layer);
    const stack = el('div', 'stack centre', layer);
    stack.style.setProperty('--gap', '0.9rem');
    const inner = el('div', '', stack);
    el('div', 'eyebrow', inner, '1999 • KARGIL');
    const bar = el('div', 'load-bar', inner);
    this.loadFill = el('i', '', bar);
    this.loadingLayer = layer;
  }

  setProgress(t) {
    this.loadFill.style.transform = `scaleX(${Math.max(0, Math.min(1, t))})`;
  }

  hideLoading() {
    this.loadingLayer.classList.add('done');
    setTimeout(() => this.loadingLayer.remove(), 900);
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
    el('div', 'jaihind', this.t3, JAI_HIND);

    this.titlePrompt = el('div', 'prompt', stack, 'Press any key to continue');
    el('div', 'disclaimer', layer, DISCLAIMER);

    this.titleLayer = layer;
    for (const s of [this.t1, this.t2, this.t3, this.titlePrompt]) {
      s.style.transition = 'opacity 1100ms ease';
      s.style.opacity = '0';
    }
  }

  /**
   * Runs the staged title fade. Resolves when the player skips or it finishes,
   * so the caller can simply await it.
   */
  playTitle(skipSignal) {
    this.show(this.titleLayer);
    const stages = [
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
        resolve();
      };

      for (const s of stages) {
        timers.push(setTimeout(() => (s.node.style.opacity = '1'), s.at));
        if (Number.isFinite(s.hold)) {
          timers.push(setTimeout(() => (s.node.style.opacity = '0'), s.at + s.hold));
        }
      }
      // The prompt only appears at the end; before that a key press skips ahead.
      skipSignal.on(finish);
    });
  }

  // ------------------------------------------------------------ briefing --

  _buildBriefing() {
    const layer = el('div', 'layer', this.root);
    el('div', 'scrim', layer);
    const centre = el('div', 'centre', layer);
    const grid = el('div', 'briefing', centre);

    const left = el('div', '', grid);
    el('h2', 'brief-heading', left, 'Sortie Briefing');
    el('div', 'brief-sub', left, 'Fictional operation • Western Himalaya');
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

    const right = el('div', '', grid);
    const controls = el('div', 'panel', right);
    el('div', 'panel-title', controls, 'Controls');
    const grid2 = el('div', 'controls-grid', controls);
    for (const [key, label] of CONTROLS) {
      el('kbd', '', grid2, key);
      el('div', '', grid2, label);
    }

    const menu = el('div', 'menu', right);
    menu.style.marginTop = '20px';
    this.launchButton = el('button', '', menu, 'Begin Sortie');
    this.launchButton.addEventListener('click', () => this.callbacks.onLaunch());

    el('div', 'disclaimer', layer, DISCLAIMER);
    this.briefingLayer = layer;
  }

  setTargets(posts) {
    this.targetList.innerHTML = '';
    this._targetRows = posts.map((post) => {
      const li = el('li', '', this.targetList);
      el('span', 'mark', li, '□');
      el('span', 'name', li, post.callsign);
      el('span', '', li, post.id);
      return li;
    });
  }

  refreshTargets(posts) {
    if (!this._targetRows) return;
    posts.forEach((post, i) => {
      const row = this._targetRows[i];
      if (!row) return;
      row.classList.toggle('done', post.captured);
      row.firstChild.textContent = post.captured ? '■' : '□';
    });
  }

  // ------------------------------------------------------------- debrief --

  _buildDebrief() {
    const layer = el('div', 'layer letterbox', this.root);
    el('div', 'scrim', layer);
    const centre = el('div', 'centre', layer);
    const stack = el('div', 'stack debrief', centre);
    stack.style.setProperty('--gap', '1.5rem');

    this.resultTitle = el('h2', 'result-title', stack, '');
    this.resultLine = el('div', 'result-line', stack, '');
    this.resultQuote = el('div', 'lede', stack, '');
    this.resultJai = el('div', 'jaihind', stack, '');
    this.contactSheet = el('div', 'contact-sheet', stack);
    this.statsRow = el('div', 'stats', stack);

    const menu = el('div', 'menu', stack);
    this.debriefButton = el('button', '', menu, 'Retry Sortie');
    this.debriefButton.addEventListener('click', () => this.callbacks.onRestart());

    this.debriefLayer = layer;
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
    this.resultJai.textContent = success ? JAI_HIND : '';
    this.resultJai.style.display = success ? '' : 'none';
    this.debriefButton.textContent = success ? 'Fly Again' : 'Retry Sortie';

    this.contactSheet.innerHTML = '';
    for (const post of mission.posts) {
      if (post.photo) {
        const card = el('div', 'contact', this.contactSheet);
        const img = el('img', '', card);
        img.src = post.photo.dataUrl;
        img.alt = `Reconnaissance photograph of ${post.callsign}`;
        const meta = el('div', 'meta', card);
        el('span', '', meta, post.callsign);
        el('b', '', meta, gradeFor(post.bestScore));
      } else {
        el('div', 'contact missing', this.contactSheet, `${post.callsign} — NO IMAGERY`);
      }
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
    const resume = el('button', '', menu, 'Resume');
    resume.addEventListener('click', () => this.callbacks.onResume());

    const qualityWrap = el('div', '', menu);
    el('div', 'panel-title', qualityWrap, 'Graphics quality');
    const row = el('div', 'quality-row', qualityWrap);
    this.qualityButtons = {};
    for (const tier of ['low', 'medium', 'high']) {
      const b = el('button', '', row, tier);
      b.addEventListener('click', () => this.callbacks.onQuality(tier));
      this.qualityButtons[tier] = b;
    }

    const restart = el('button', '', menu, 'Abort and Restart');
    restart.addEventListener('click', () => this.callbacks.onRestart());
    this.pauseLayer = layer;
  }

  setQuality(tier) {
    for (const [name, button] of Object.entries(this.qualityButtons)) {
      button.setAttribute('aria-pressed', String(name === tier));
    }
  }

  // ---------------------------------------------------------------- misc --

  show(layer) {
    for (const l of [this.titleLayer, this.briefingLayer, this.debriefLayer, this.pauseLayer]) {
      l.classList.toggle('show', l === layer);
      l.style.pointerEvents = l === layer ? 'auto' : 'none';
    }
    this.current = layer;
  }

  hideAll() {
    this.show(null);
  }
}

const CONTROLS = [
  ['W / S', 'Pitch down / up'],
  ['A / D', 'Roll left / right'],
  ['Q / E', 'Rudder'],
  ['Shift / Ctrl', 'Throttle — hold Shift for reheat'],
  ['Z', 'Airbrake'],
  ['Space', 'Reconnaissance camera (hold)'],
  ['F / V', 'Zoom in / out'],
  ['Enter', 'Shutter'],
  ['Tab', 'Cycle objective'],
  ['Esc', 'Pause'],
];
