import { CAPTURE_THRESHOLD, gradeFor, ZOOM_STEPS } from '../game/ReconCamera.js';

/**
 * In-flight instrumentation and the photography overlay.
 *
 * Built from DOM rather than drawn into the canvas: text stays crisp at any
 * resolution scale, it costs no fill rate on a frame that is already terrain
 * bound, and the whole thing is styled by the same sheet as the title sequence
 * and the debrief, which is what keeps them feeling like one instrument rather
 * than three developer panels.
 *
 * Every value is written through `set()`, which skips the DOM entirely when the
 * text has not changed. At 120 fps most of these fields are static most of the
 * time, and blind writes to textContent are the usual reason HUDs show up in a
 * profile.
 */

const el = (tag, className, parent, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  if (parent) parent.appendChild(node);
  return node;
};

function set(node, value) {
  const s = String(value);
  if (node._v !== s) {
    node._v = s;
    node.textContent = s;
  }
}

function toggle(node, className, on) {
  if (node._c === undefined) node._c = {};
  if (node._c[className] === on) return;
  node._c[className] = on;
  node.classList.toggle(className, on);
}

export class Hud {
  constructor(root) {
    this.root = el('div', '', root);
    this.root.id = 'hud';

    this._buildTapes();
    this._buildHeading();
    this._buildThrottle();
    this._buildObjectives();
    this._buildTarget();
    this._buildWarnings();
    el('div', 'reticle', this.root);

    this._buildRecon(root);

    this.photoPop = el('div', 'photo-pop', root);
    this.photoImg = el('img', '', this.photoPop);
    const meta = el('div', 'meta', this.photoPop);
    this.photoName = el('span', '', meta, '');
    this.photoGrade = el('b', '', meta, '');
    this._popTimer = 0;
  }

  _buildTapes() {
    const make = (side, label, unit, step, majorEvery, pixelsPerUnit) => {
      const tape = el('div', `tape ${side}`, this.root);
      const strip = el('div', 'tape-strip', tape);
      el('div', 'tape-label', tape, label);
      el('div', 'tape-unit', tape, unit);
      const readout = el('div', 'tape-readout', tape, '0');

      // Pre-build a fixed pool of ticks and recycle them by repositioning, so
      // the tape never allocates or reflows the tree while flying.
      const ticks = [];
      for (let i = 0; i < 26; i++) {
        const tick = el('div', 'tape-tick', strip);
        ticks.push(tick);
      }
      return { tape, strip, ticks, readout, step, majorEvery, pixelsPerUnit, height: 0 };
    };

    this.speedTape = make('left', 'IAS', 'KM/H', 50, 2, 0.34);
    this.altTape = make('right', 'ALT', 'M', 250, 2, 0.062);
  }

  _updateTape(t, value) {
    if (!t.height) t.height = t.tape.clientHeight || 320;
    const half = t.height / 2;
    const range = half / t.pixelsPerUnit;
    const first = Math.ceil((value - range) / t.step) * t.step;

    for (let i = 0; i < t.ticks.length; i++) {
      const v = first + i * t.step;
      const offset = (value - v) * t.pixelsPerUnit;
      const tick = t.ticks[i];
      if (Math.abs(offset) > half + 12 || v < 0) {
        if (tick._hidden !== true) {
          tick.style.display = 'none';
          tick._hidden = true;
        }
        continue;
      }
      if (tick._hidden !== false) {
        tick.style.display = '';
        tick._hidden = false;
      }
      const major = Math.round(v / t.step) % t.majorEvery === 0;
      toggle(tick, 'major', major);
      set(tick, major ? String(Math.round(v)) : '');
      const y = Math.round(offset);
      if (tick._y !== y) {
        tick._y = y;
        tick.style.transform = `translateY(${y}px)`;
      }
    }
    set(t.readout, Math.round(value).toLocaleString('en-US'));
  }

  _buildHeading() {
    const strip = el('div', 'heading-strip', this.root);
    const inner = el('div', 'heading-inner', strip);
    this.headingInner = inner;
    this.headingTicks = [];
    // 0..355 in 5-degree steps, laid out once; the strip slides beneath a caret.
    for (let deg = 0; deg < 360; deg += 5) {
      const tick = el('div', 'heading-tick', inner);
      const major = deg % 30 === 0;
      if (major) {
        tick.classList.add('major');
        const label = el('span', '', tick);
        label.textContent = CARDINALS[deg] ?? String(deg).padStart(3, '0');
      }
      tick.style.left = `${deg * 3.2}px`;
      this.headingTicks.push(tick);
    }
    el('div', 'heading-caret', strip);
    this.headingReadout = el('div', 'heading-readout', this.root, '000');
  }

  _updateHeading(deg) {
    // Duplicate the strip either side of the wrap so it never shows an edge.
    const wrapped = ((deg % 360) + 360) % 360;
    const x = -wrapped * 3.2;
    if (this.headingInner._x !== x) {
      this.headingInner._x = x;
      this.headingInner.style.transform = `translateX(${x}px)`;
    }
    set(this.headingReadout, `${String(Math.round(wrapped) % 360).padStart(3, '0')}°`);
  }

  _buildThrottle() {
    const wrap = el('div', 'throttle', this.root);
    el('div', 'throttle-label', wrap, 'THROTTLE');
    const bar = el('div', 'throttle-bar', wrap);
    this.throttleFill = el('div', 'throttle-fill', bar);
  }

  _buildObjectives() {
    const wrap = el('div', 'objectives', this.root);
    this.objectiveCount = el('div', 'count', wrap, '0/0');
    el('div', '', wrap, 'OBJECTIVES');
    this.objectivePips = el('div', 'objective-pips', wrap);
    this._pips = [];
  }

  _buildTarget() {
    const wrap = el('div', 'target-block', this.root);
    this.targetName = el('div', 'name', wrap, '--');
    this.targetRange = el('div', 'range', wrap, '-- KM');
    this.targetBearing = el('div', '', wrap, 'BRG ---');
  }

  _buildWarnings() {
    const wrap = el('div', 'warnings', this.root);
    this.warnStall = el('div', 'warn caution', wrap, 'STALL');
    this.warnTerrain = el('div', 'warn danger', wrap, 'PULL UP');
    this.warnG = el('div', 'warn caution', wrap, 'G LIMIT');
  }

  _buildRecon(root) {
    this.recon = el('div', '', root);
    this.recon.id = 'recon';
    el('div', 'gate', this.recon);
    const frame = el('div', 'gate-frame', this.recon);
    for (let i = 0; i < 4; i++) el('span', '', frame);
    el('div', 'recon-cross', this.recon);
    this.reconStatus = el('div', 'recon-status', this.recon, 'RECON CAMERA — STANDBY');
    this.reconZoom = el('div', 'recon-zoom', this.recon, 'ZOOM 1.0X');

    const quality = el('div', 'quality', this.recon);
    const bar = el('div', 'quality-bar', quality);
    this.qualityFill = el('div', 'quality-fill', bar);
    const threshold = el('div', 'quality-threshold', bar);
    threshold.style.left = `${CAPTURE_THRESHOLD * 100}%`;
    const legend = el('div', 'quality-legend', quality);
    this.qualityLabel = el('span', '', legend, 'NO TARGET');
    this.qualityDetail = el('b', '', legend, '');

    this.flash = el('div', 'shutter-flash', this.recon);
  }

  setObjectiveCount(total) {
    this.objectivePips.innerHTML = '';
    this._pips = [];
    for (let i = 0; i < total; i++) this._pips.push(el('i', '', this.objectivePips));
  }

  show(on) {
    toggle(this.root, 'show', on);
    if (!on) {
      toggle(this.recon, 'show', false);
      // The photo card lives outside #hud so it can sit above the gate, which
      // means hiding the HUD does not hide it — it would otherwise linger over
      // the debrief.
      toggle(this.photoPop, 'show', false);
      this._popTimer = 0;
    }
  }

  showPhoto(post, shot) {
    this.photoImg.src = shot.dataUrl;
    set(this.photoName, post.callsign);
    set(this.photoGrade, shot.grade);
    toggle(this.photoPop, 'show', true);
    this._popTimer = 3.4;
  }

  /**
   * @param {object} s  snapshot of flight + mission state for this frame
   */
  update(dt, s) {
    this._updateTape(this.speedTape, s.speedKmh);
    this._updateTape(this.altTape, s.altitude);
    this._updateHeading(s.heading);

    const scale = Math.max(0.001, s.throttle);
    if (this.throttleFill._s !== scale) {
      this.throttleFill._s = scale;
      this.throttleFill.style.transform = `scaleX(${scale})`;
    }
    toggle(this.throttleFill, 'reheat', s.reheat);

    set(this.objectiveCount, `${s.captured}/${s.total}`);
    for (let i = 0; i < this._pips.length; i++) toggle(this._pips[i], 'done', i < s.captured);

    if (s.target) {
      set(this.targetName, s.target.callsign);
      set(
        this.targetRange,
        s.targetRange > 1000
          ? `${(s.targetRange / 1000).toFixed(1)} KM`
          : `${Math.round(s.targetRange)} M`,
      );
      set(this.targetBearing, `BRG ${String(Math.round(s.targetBearing)).padStart(3, '0')}°`);
    } else {
      set(this.targetName, 'ALL OBJECTIVES');
      set(this.targetRange, 'COMPLETE');
      set(this.targetBearing, 'RETURN TO BASE');
    }

    toggle(this.warnStall, 'show', s.stalling);
    toggle(this.warnTerrain, 'show', s.terrainWarning);
    toggle(this.warnG, 'show', s.gLoad > 9.6);

    // ---- recon overlay ----
    toggle(this.recon, 'show', s.reconActive);
    if (s.reconActive) {
      const zoom = ZOOM_STEPS[0] / ZOOM_STEPS[s.zoomIndex];
      set(this.reconZoom, `ZOOM ${zoom.toFixed(1)}X`);

      const ev = s.evaluation;
      const q = ev ? ev.score : 0;
      const w = Math.max(0.004, q);
      if (this.qualityFill._s !== w) {
        this.qualityFill._s = w;
        this.qualityFill.style.transform = `scaleX(${w})`;
      }
      toggle(this.qualityFill, 'ok', q >= CAPTURE_THRESHOLD * 0.6 && q < CAPTURE_THRESHOLD);
      toggle(this.qualityFill, 'good', q >= CAPTURE_THRESHOLD);

      if (!ev || !ev.inFrame) {
        set(this.reconStatus, 'RECON CAMERA — NO TARGET IN FRAME');
        set(this.qualityLabel, 'FRAME THE OBJECTIVE');
        set(this.qualityDetail, '');
      } else if (ev.visibility < 0.35) {
        set(this.reconStatus, `RECON CAMERA — ${ev.post.callsign}`);
        set(this.qualityLabel, 'LINE OF SIGHT OBSTRUCTED');
        set(this.qualityDetail, gradeFor(q));
      } else {
        set(this.reconStatus, `RECON CAMERA — ${ev.post.callsign}`);
        set(this.qualityLabel, hintFor(ev));
        set(this.qualityDetail, gradeFor(q));
      }
    }

    const flash = Math.max(0, s.shutterFlash);
    if (this.flash._o !== flash) {
      this.flash._o = flash;
      this.flash.style.opacity = String(flash * 0.85);
    }

    if (this._popTimer > 0) {
      this._popTimer -= dt;
      if (this._popTimer <= 0) toggle(this.photoPop, 'show', false);
    }
  }
}

/** The single most useful correction the pilot could make right now. */
function hintFor(ev) {
  const weakest = [
    { k: 'CLOSE THE RANGE', v: ev.rangeQuality },
    { k: 'CENTRE THE TARGET', v: ev.framing },
    { k: 'ZOOM IN / GET CLOSER', v: ev.coverage },
    { k: 'IMPROVE VIEWING ANGLE', v: ev.angleQuality },
  ].sort((a, b) => a.v - b.v)[0];
  if (weakest.v > 0.78) return 'GOOD FRAME — SHOOT';
  if (weakest.k === 'CLOSE THE RANGE' && ev.range < 320) return 'TOO CLOSE — PULL BACK';
  return weakest.k;
}

const CARDINALS = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' };
