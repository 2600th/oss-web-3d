import { CAPTURE_THRESHOLD, gradeFor, ZOOM_STEPS, apertureFor } from '../game/ReconCamera.js';
import { NavigationCue } from './NavigationCue.js';

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
 *
 * Two rules the layout obeys everywhere:
 *
 *   Numbers are monospaced. Proportional digits change width as they count, so
 *   an airspeed readout physically shivers between 199 and 200 and a tape of
 *   labels never lines up. The condensed display face is for *labels*; anything
 *   that changes at frame rate uses the mono stack.
 *
 *   Legibility comes from a local scrim and a phosphor halo, never from raising
 *   opacity. The scene behind is high contrast in both directions — brilliant
 *   snow and near-black rock in the same frame — and a HUD opaque enough to
 *   survive the snow reads as a sticker over the rock.
 */

const el = (tag, className, parent, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  if (parent) parent.appendChild(node);
  return node;
};

const svgEl = (tag, parent, attrs) => {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
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

function setAriaHidden(node, hidden) {
  const value = hidden ? 'true' : 'false';
  if (node._ariaHidden === value) return;
  node._ariaHidden = value;
  node.setAttribute('aria-hidden', value);
}

/** Pixels of heading tape per degree. Shared by layout and by the transform. */
const HEADING_PX_PER_DEG = 3.2;

export class Hud {
  constructor(root) {
    this.root = el('div', '', root);
    this.root.id = 'hud';
    setAriaHidden(this.root, true);
    this._disposed = false;

    // Everything that should settle under g load lives inside one wrapper, so
    // the parallax is a single composited transform rather than one per widget.
    this.plate = el('div', 'hud-plate', this.root);

    this._buildTapes();
    this._buildHeading();
    this._buildThrottle();
    this._buildObjectives();
    this._buildTarget();
    this._buildWarnings();
    el('div', 'reticle', this.plate);
    this.navigationCue = new NavigationCue(this.root, this.headingStrip);

    this._buildRecon(root);

    this.photoPop = el('div', 'photo-pop', root);
    this.photoPop.setAttribute('role', 'status');
    this.photoPop.setAttribute('aria-live', 'polite');
    this.photoPop.setAttribute('aria-hidden', 'true');
    this.photoImg = el('img', '', this.photoPop);
    this.photoImg.alt = '';
    this.photoDev = el('div', 'developing', this.photoPop, 'DEVELOPING');
    const meta = el('div', 'meta', this.photoPop);
    this.photoName = el('span', '', meta, '');
    this.photoGrade = el('b', '', meta, '');
    this._popTimer = 0;
    this._popShot = null;

    // Reduced motion is read once. It gates the settle and the gate weave —
    // both are texture, not information, so losing them costs nothing.
    this._calm = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    this._parallaxX = 0;
    this._parallaxY = 0;
    this._lastHeading = 0;

    // Tape geometry is measured, not assumed, and a window resize or an
    // orientation change invalidates it. Caching it once at first use meant a
    // resized window left both tapes scaled wrong — ticks at the wrong pitch,
    // the readout pointing at the wrong value — for the rest of the session.
    // A ResizeObserver rather than a window resize listener because the tapes
    // also change size from media queries and safe-area insets, which fire no
    // window event on some browsers.
    this._invalidate = () => {
      this.speedTape.height = 0;
      this.altTape.height = 0;
    };
    if (window.ResizeObserver) {
      this._observer = new ResizeObserver(this._invalidate);
      this._observer.observe(this.speedTape.tape);
      this._observer.observe(this.altTape.tape);
    } else {
      window.addEventListener('resize', this._invalidate);
      window.addEventListener('orientationchange', this._invalidate);
    }
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this._popShot = null;
    this._observer?.disconnect();
    this.navigationCue.dispose();
    window.removeEventListener('resize', this._invalidate);
    window.removeEventListener('orientationchange', this._invalidate);
    this.root.remove();
    this.recon.remove();
    this.photoPop.remove();
  }

  _buildTapes() {
    const make = (side, label, unit, step, majorEvery, pixelsPerUnit) => {
      const tape = el('div', `tape ${side}`, this.plate);
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

  /**
   * Extend a tape's tick pool to span the height it just measured.
   *
   * The pool was a fixed 26. ALT steps 250 m at 0.062 px/m — 15.5 px a tick —
   * so 26 ticks cover about 400 px and the tape visibly ran out of graduations
   * on any viewport taller than roughly 1000 px. Growing here rather than at
   * construction keeps the file's rule that tape geometry is measured, not
   * assumed, and it reuses the ResizeObserver that already invalidates height.
   * Ticks are only ever added, so this settles after the first frame at a size.
   */
  _growTicks(t) {
    const needed = Math.ceil(t.height / (t.step * t.pixelsPerUnit)) + 2;
    for (let i = t.ticks.length; i < needed; i++) {
      t.ticks.push(el('div', 'tape-tick', t.strip));
    }
  }

  _updateTape(t, value) {
    if (!t.height) {
      t.height = t.tape.clientHeight || 320;
      this._growTicks(t);
    }
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
    const strip = el('div', 'heading-strip', this.plate);
    this.headingStrip = strip;
    const inner = el('div', 'heading-inner', strip);
    this.headingInner = inner;
    this.headingTicks = [];
    // Three laps of 0..355, at -360 / 0 / +360, so the strip is 3456 px wide and
    // the 520 px window is covered at every heading. One lap — which is what
    // this used to lay out, despite a comment claiming otherwise — leaves the
    // left half of the window empty between 000 and 080 and the right half
    // empty between 280 and 359, because `.heading-inner` is anchored at
    // `left: 50%` and slid by `-heading * 3.2`. The compass simply vanished
    // through north, which is the one heading a pilot most needs it at.
    for (const lap of [-1, 0, 1]) {
      for (let deg = 0; deg < 360; deg += 5) {
        const tick = el('div', 'heading-tick', inner);
        const major = deg % 30 === 0;
        if (major) {
          tick.classList.add('major');
          const label = el('span', '', tick);
          label.textContent = CARDINALS[deg] ?? String(deg).padStart(3, '0');
          if (CARDINALS[deg]) tick.classList.add('cardinal');
        }
        tick.style.left = `${(lap * 360 + deg) * HEADING_PX_PER_DEG}px`;
        this.headingTicks.push(tick);
      }
    }
    el('div', 'heading-caret', strip);
    this.headingReadout = el('div', 'heading-readout', this.plate, '000°');
  }

  _updateHeading(deg) {
    const wrapped = ((deg % 360) + 360) % 360;
    const x = -wrapped * HEADING_PX_PER_DEG;
    if (this.headingInner._x !== x) {
      this.headingInner._x = x;
      this.headingInner.style.transform = `translateX(${x}px)`;
    }
    set(this.headingReadout, `${String(Math.round(wrapped) % 360).padStart(3, '0')}°`);
    return wrapped;
  }

  _buildThrottle() {
    const wrap = el('div', 'throttle', this.plate);
    el('div', 'block-label', wrap, 'THROTTLE');
    const bar = el('div', 'throttle-bar', wrap);
    this.throttleFill = el('div', 'throttle-fill', bar);
    // The reheat gate is drawn where it physically is on a MiG-21's quadrant —
    // past the stop, not at the end of a continuous scale.
    el('div', 'throttle-gate', bar);
    this.throttleReadout = el('div', 'throttle-readout', wrap, '  0%');
  }

  _buildObjectives() {
    const wrap = el('div', 'objectives', this.plate);
    this.objectiveCount = el('div', 'count', wrap, '0/0');
    el('div', 'block-label', wrap, 'OBJECTIVES');
    this.objectivePips = el('div', 'objective-pips', wrap);
    this._pips = [];
  }

  _buildTarget() {
    const wrap = el('div', 'target-block', this.plate);
    this.targetName = el('div', 'name', wrap, '--');
    this.targetRange = el('div', 'range', wrap, '-- KM');
    this.targetBearing = el('div', 'bearing', wrap, 'BRG ---');
  }

  _buildWarnings() {
    const wrap = el('div', 'warnings', this.plate);
    this.warnStall = el('div', 'warn', wrap, 'STALL');
    this.warnTerrain = el('div', 'warn hard', wrap, 'PULL UP');
    this.warnG = el('div', 'warn', wrap, 'G LIMIT');
  }

  // ------------------------------------------------------------ recon --
  //
  // The photography overlay is the one screen where the interface *is* the
  // verb, so it is built as an optical instrument rather than as a frame: a
  // lens vignette and edge falloff, film grain, chromatic fringing at the
  // field edge, a reticle with real stadia and a magnification scale, an
  // exposure readout derived from the selected zoom, and a two-blade capping
  // shutter instead of a white flash. Everything except the shutter is static
  // DOM and CSS — no per-frame writes, so the whole thing is free at 120 fps.

  _buildRecon(root) {
    this.recon = el('div', '', root);
    this.recon.id = 'recon';
    setAriaHidden(this.recon, true);

    const optic = el('div', 'optic', this.recon);
    el('div', 'optic-vignette', optic);
    el('div', 'optic-falloff', optic);
    el('div', 'optic-fringe warm', optic);
    el('div', 'optic-fringe cool', optic);
    el('div', 'optic-grain', optic);

    el('div', 'gate', this.recon);
    const frame = el('div', 'gate-frame', this.recon);
    this.gateFrame = frame;
    for (let i = 0; i < 4; i++) el('span', '', frame);

    this._buildReticle(this.recon);

    const head = el('div', 'recon-head', this.recon);
    // The instrument name and its state are separate elements so a narrow
    // viewport can drop the name. Ellipsising one string cut it at "RECON
    // CAMERA — NO TARGET…", which discards the only half that changes.
    this.reconStatus = el('div', 'recon-status', head);
    el('span', 'recon-status-name', this.reconStatus, 'RECON CAMERA');
    this.reconStatusState = el('span', 'recon-status-state', this.reconStatus, 'STANDBY');
    const heading = el('div', 'recon-optics', head);
    this.reconZoom = el('b', '', heading, 'x1.0');
    this.reconExposure = el('span', '', heading, '1/1000 f/5.6');

    const quality = el('div', 'quality', this.recon);
    const bar = el('div', 'quality-bar', quality);
    this.qualityFill = el('div', 'quality-fill', bar);
    const threshold = el('div', 'quality-threshold', bar);
    threshold.style.left = `${CAPTURE_THRESHOLD * 100}%`;
    const legend = el('div', 'quality-legend', quality);
    this.qualityLabel = el('span', '', legend, 'NO TARGET');
    this.qualityDetail = el('b', '', legend, '');
    this.reconFrame = el('div', 'recon-frame-no', this.recon, 'EXP 000');

    // Two blades sweeping across the gate. A white full-screen flash is what a
    // phone camera app does; a focal-plane shutter darkens, and darkening also
    // avoids blowing out a scene that has just been graded for bright snow.
    const shutter = el('div', 'shutter', this.recon);
    this.bladeTop = el('div', 'blade top', shutter);
    this.bladeBottom = el('div', 'blade bottom', shutter);
    this.flash = el('div', 'shutter-flash', this.recon);
  }

  _buildReticle(parent) {
    const svg = svgEl('svg', parent, {
      class: 'recon-reticle',
      viewBox: '0 0 240 240',
      'aria-hidden': 'true',
    });

    // Centre cross with a gap, so the target is never hidden by the aiming mark.
    for (const [x1, y1, x2, y2] of [
      [120, 92, 120, 110], [120, 130, 120, 148],
      [92, 120, 110, 120], [130, 120, 148, 120],
    ]) {
      svgEl('line', svg, { x1, y1, x2, y2, class: 'ret-line' });
    }
    svgEl('circle', svg, { cx: 120, cy: 120, r: 2.2, class: 'ret-dot' });

    // Stadia: the ladder a recon operator judges range and framing against.
    for (let i = 1; i <= 4; i++) {
      const d = i * 26;
      const long = i % 2 === 0;
      const len = long ? 9 : 5;
      svgEl('line', svg, {
        x1: 120 - d, y1: 120 - len, x2: 120 - d, y2: 120 + len, class: 'ret-tick',
      });
      svgEl('line', svg, {
        x1: 120 + d, y1: 120 - len, x2: 120 + d, y2: 120 + len, class: 'ret-tick',
      });
      svgEl('line', svg, {
        x1: 120 - len, y1: 120 - d, x2: 120 + len, y2: 120 - d, class: 'ret-tick',
      });
      svgEl('line', svg, {
        x1: 120 - len, y1: 120 + d, x2: 120 + len, y2: 120 + d, class: 'ret-tick',
      });
    }

    // Magnification scale down the left of the reticle, one pip per zoom step.
    this._zoomPips = [];
    for (let i = 0; i < ZOOM_STEPS.length; i++) {
      const y = 96 + i * 12;
      const pip = svgEl('rect', svg, {
        x: 26, y: y - 1.5, width: 12, height: 3, class: 'ret-pip',
      });
      this._zoomPips.push(pip);
    }
    svgEl('line', svg, { x1: 22, y1: 92, x2: 22, y2: 148, class: 'ret-tick' });
  }

  setObjectiveCount(total) {
    this.objectivePips.innerHTML = '';
    this._pips = [];
    for (let i = 0; i < total; i++) this._pips.push(el('i', '', this.objectivePips));
  }

  show(on) {
    toggle(this.root, 'show', on);
    setAriaHidden(this.root, !on);
    if (!on) {
      toggle(this.recon, 'show', false);
      toggle(this.root, 'recon-open', false);
      setAriaHidden(this.recon, true);
      // The photo card lives outside #hud so it can sit above the gate, which
      // means hiding the HUD does not hide it — it would otherwise linger over
      // the debrief.
      toggle(this.photoPop, 'show', false);
      this.photoPop.setAttribute('aria-hidden', 'true');
      this._popTimer = 0;
      this._popShot = null;
    }
  }

  /**
   * Show the plate that was just exposed.
   *
   * The shot may still be developing — the encode is deliberately off the
   * shutter frame — so the card comes up immediately with the frame number and
   * the grade, and the image drops in when it exists. Waiting for the JPEG
   * before acknowledging the shutter would put the latency back exactly where
   * moving the encode was meant to take it from.
   */
  showPhoto(post, shot) {
    this._popShot = shot;
    set(this.reconFrame, `EXP ${String(shot.frame ?? 0).padStart(3, '0')}`);
    set(this.photoName, `${post.callsign} · EXP ${String(shot.frame ?? 0).padStart(3, '0')}`);
    set(this.photoGrade, shot.grade);
    toggle(this.photoPop, 'show', true);
    this.photoPop.setAttribute('aria-hidden', 'false');
    this.photoImg.alt = `Recon photograph of ${post.callsign}, grade ${shot.grade}`;
    toggle(this.photoPop, 'wet', !shot.dataUrl);
    this._popTimer = 3.4;

    if (shot.dataUrl) {
      this.photoImg.src = shot.dataUrl;
      return;
    }
    this.photoImg.removeAttribute('src');
    shot.ready?.then(() => {
      // Another exposure may have replaced this one while the plate developed.
      if (this._disposed || this._popShot !== shot) return;
      if (shot.dataUrl) this.photoImg.src = shot.dataUrl;
      toggle(this.photoPop, 'wet', false);
    });
  }

  /**
   * @param {object} s  snapshot of flight + mission state for this frame
   */
  update(dt, s) {
    this._updateTape(this.speedTape, s.speedKmh);
    this._updateTape(this.altTape, s.altitude);
    const heading = this._updateHeading(s.heading);
    this._updateSettle(dt, s, heading);
    this.navigationCue.update({
      ...s.navigation,
      targetCallsign: s.target?.callsign,
      targetRange: s.targetRange,
    });

    const scale = Math.max(0.001, s.throttle);
    if (this.throttleFill._s !== scale) {
      this.throttleFill._s = scale;
      this.throttleFill.style.transform = `scaleX(${scale})`;
    }
    toggle(this.throttleFill, 'reheat', s.reheat);
    set(this.throttleReadout, `${String(Math.round(s.throttle * 100)).padStart(3, ' ')}%`);

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
      toggle(this.targetName, 'complete', false);
    } else {
      set(this.targetName, 'ALL OBJECTIVES');
      set(this.targetRange, 'COMPLETE');
      set(this.targetBearing, 'RETURN TO BASE');
      toggle(this.targetName, 'complete', true);
    }

    toggle(this.warnStall, 'show', s.stalling);
    toggle(this.warnTerrain, 'show', s.terrainWarning);
    toggle(this.warnG, 'show', s.gLoad > 9.6);

    // ---- recon overlay ----
    toggle(this.recon, 'show', s.reconActive);
    toggle(this.root, 'recon-open', s.reconActive);
    setAriaHidden(this.recon, !s.reconActive);
    if (s.reconActive) {
      const zoom = ZOOM_STEPS[0] / ZOOM_STEPS[s.zoomIndex];
      set(this.reconZoom, `x${zoom.toFixed(1)}`);
      set(this.reconExposure, `1/1000 ${apertureFor(s.zoomIndex)}`);
      for (let i = 0; i < this._zoomPips.length; i++) {
        toggle(this._zoomPips[i], 'on', i <= s.zoomIndex);
      }

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
        set(this.reconStatusState, 'NO TARGET IN FRAME');
        set(this.qualityLabel, 'FRAME THE OBJECTIVE');
        set(this.qualityDetail, '');
      } else if (ev.visibility < 0.35) {
        set(this.reconStatusState, ev.post.callsign);
        set(this.qualityLabel, 'LINE OF SIGHT OBSTRUCTED');
        set(this.qualityDetail, gradeFor(q));
      } else if (q >= CAPTURE_THRESHOLD) {
        // Past the threshold the camera is taking the shot itself, and it waits
        // for the peak. Without a line saying so the arming delay reads as the
        // shutter having failed, and the pilot breaks the very hold it wants.
        set(this.reconStatusState, ev.post.callsign);
        set(this.qualityLabel, 'AUTO CAPTURE ARMED');
        set(this.qualityDetail, gradeFor(q));
      } else {
        set(this.reconStatusState, ev.post.callsign);
        set(this.qualityLabel, hintFor(ev));
        set(this.qualityDetail, gradeFor(q));
      }
    }

    this._updateShutter(s.shutterFlash);

    if (this._popTimer > 0) {
      this._popTimer -= dt;
      if (this._popTimer <= 0) {
        toggle(this.photoPop, 'show', false);
        this.photoPop.setAttribute('aria-hidden', 'true');
      }
    }
  }

  /**
   * A capping shutter driven off the same decaying `flash` value the old white
   * rectangle used, so nothing upstream had to change. The blades close and
   * reopen over the first 45% of the decay and the residual veil carries the
   * rest, which is what gives the press a mechanical weight rather than a blink.
   */
  _updateShutter(flashValue) {
    const flash = Math.max(0, flashValue);
    const p = Math.min(1, (1 - flash) / 0.45);
    const closed = flash > 0 ? 1 - Math.abs(1 - 2 * p) : 0;
    if (this._blade !== closed) {
      this._blade = closed;
      const pct = closed * 50;
      this.bladeTop.style.transform = `translateY(${(pct - 100).toFixed(2)}%)`;
      this.bladeBottom.style.transform = `translateY(${(100 - pct).toFixed(2)}%)`;
    }
    // A small residual veil, not a white-out: the plate is being exposed, not
    // a flashgun going off in the pilot's face.
    const veil = flash * 0.22;
    if (this.flash._o !== veil) {
      this.flash._o = veil;
      this.flash.style.opacity = String(veil);
    }
  }

  /**
   * A faint settle of the whole instrument plate under load.
   *
   * A HUD is projected onto a combiner bolted to an airframe; under 6 g and a
   * hard reversal the pilot's eye moves relative to it. Six pixels at the
   * extremes is enough to read as physical and small enough that nobody ever
   * consciously notices it — which is the point. Driven from g load and the
   * rate of change of heading because those are already in the snapshot; asking
   * Game for a roll angle would have meant changing a shared call site for
   * decoration.
   */
  _updateSettle(dt, s, heading) {
    if (this._calm || dt <= 0) return;
    let delta = heading - this._lastHeading;
    if (delta > 180) delta -= 360;
    else if (delta < -180) delta += 360;
    this._lastHeading = heading;

    const yawRate = Math.max(-1, Math.min(1, delta / dt / 45));
    const pull = Math.max(-1, Math.min(1, (s.gLoad - 1) / 7));
    const k = 1 - Math.exp(-4.5 * dt);
    this._parallaxX += (-yawRate * 6 - this._parallaxX) * k;
    this._parallaxY += (pull * 5 - this._parallaxY) * k;

    const x = Math.round(this._parallaxX * 10) / 10;
    const y = Math.round(this._parallaxY * 10) / 10;
    if (this.plate._x !== x || this.plate._y !== y) {
      this.plate._x = x;
      this.plate._y = y;
      this.plate.style.transform = `translate3d(${x}px, ${y}px, 0)`;
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
  if (weakest.v > 0.78) return 'GOOD FRAME — HOLD IT';
  if (weakest.k === 'CLOSE THE RANGE' && ev.range < 320) return 'TOO CLOSE — PULL BACK';
  return weakest.k;
}

const CARDINALS = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' };
