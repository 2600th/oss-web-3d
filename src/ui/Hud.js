import { normalizeHud } from './hudData.js';
import { computeLayout } from './layout.js';
import { projectPoint, boxClamp, gunLead } from './projection.js';
import { worldToRadar, autoRange } from './radar.js';
import { RadioQueue, Callouts } from './radio.js';
import { resolveTheme, targetColor, isGroundKind } from './theme.js';
import {
  formatHeading, headingTickLabel, formatSpeed, formatAltitude, toKnots, toFeet,
  formatRange, formatScore, formatClock, formatG, formatAmmo, formatPercent, groupThousands,
} from './format.js';

/**
 * Combat HUD: one DPR-aware Canvas 2D overlay redrawn every frame in the UI
 * system's lateUpdate (after the camera has moved, so projected markers sit
 * exactly on their 3D targets).
 *
 * Canvas rather than SVG/DOM: the HUD changes every frame (ladder, tapes,
 * markers), and a single canvas redraw costs a fraction of a millisecond where
 * hundreds of per-frame DOM/SVG attribute writes would force style + layout.
 *
 * Visual language (original): hairline instrument strokes with a dark halo
 * underlay; numerals in B612 Mono (the open typeface Airbus commissioned for
 * cockpit displays); flight data in the HUD ink colour, identification in the
 * palette colours, warnings in a separate hot channel. Shape always repeats
 * what colour says.
 */

const DEG = Math.PI / 180;
const FONT_MONO = '"SS B612 Mono", ui-monospace, monospace';
const FONT_SANS = '"SS B612", system-ui, sans-serif';
const FONT_DISPLAY = '"SS Shoulders", "SS B612", system-ui, sans-serif';

const _p = { x: 0, y: 0, w: 0, depth: 0, behind: false, onScreen: false };
const _q = { x: 0, y: 0, w: 0, depth: 0, behind: false, onScreen: false };
const _e = { x: 0, y: 0, angle: 0 };
const _r = { x: 0, y: 0, dist: 0, clamped: false };
const _lead = { x: 0, y: 0, z: 0, tof: 0 };

const MUZZLE = 1050; // m/s, GSh-23 class

export class Hud {
  constructor(root, settings) {
    this.settings = settings;
    this.canvas = document.createElement('canvas');
    this.canvas.id = 'hud';
    this.canvas.setAttribute('aria-hidden', 'true');
    root.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    this.visible = false;
    this.data = {};
    this.radio = new RadioQueue();
    this.callouts = new Callouts();
    this.theme = resolveTheme(settings);
    this.layout = null;
    this.dpr = 1;
    this.time = 0;
    this.lockFx = { state: 'none', since: 0, id: null };
    this.damageFlash = 0;
    this.banner = null; // { title, text, age, life }
    this.threatLevel = null; // 'warning' | 'alert'
    this.relief = null; // { canvas, bounds }
    this._tracks = new Map();
    this._radarRange = 8000;
    this.touch = false;
    this.occluders = []; // touch button rects, CSS px (UI refreshes them)
    this.safe ={ top: 0, right: 0, bottom: 0, left: 0 };
    this.keyHint = { flares: 'C' };
  }

  applySettings(settings) {
    this.settings = settings;
    this.theme = resolveTheme(settings);
    if (this.layout) this.resize(this.layout.w, this.layout.h);
  }

  setRelief(canvas, bounds) {
    this.relief = { canvas, bounds };
  }

  setTouch(on) {
    this.touch = !!on;
    if (this.layout) this.resize(this.layout.w, this.layout.h);
  }

  setSafeArea(safe) {
    this.safe = safe;
    if (this.layout) this.resize(this.layout.w, this.layout.h);
  }

  resize(w, h) {
    // Cap DPR at 2: past that the strokes are already sub-pixel and the fill
    // cost of a 3x full-screen canvas on a phone is not free.
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    this.dpr = dpr;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    this.layout = computeLayout({ w, h, safe: this.safe, hudScale: this.settings.hudScale ?? 1, touch: this.touch });
  }

  setVisible(v) {
    this.visible = v;
    this.canvas.classList.toggle('show', v);
    if (!v) this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  // ------------------------------------------------------------ event feed --

  pushRadio(msg) {
    if (this.settings.subtitles === false) return;
    this.radio.push(msg);
  }

  callout(kind, text, sub, life) {
    this.callouts.push(kind, text, sub, life);
  }

  showBanner(title, text, life = 4.2) {
    this.banner = { title, text, age: 0, life };
  }

  flashDamage(amount = 0.3) {
    this.damageFlash = Math.min(1, this.damageFlash + 0.35 + amount);
  }

  onLock(state, target) {
    const id = target?.id ?? target ?? null;
    if (state !== this.lockFx.state || id !== this.lockFx.id) {
      this.lockFx = { state, since: this.time, id };
    }
  }

  setThreat(level) {
    this.threatLevel = level;
  }

  clearTransient() {
    this.radio.clear();
    this.callouts.clear();
    this.banner = null;
    this.damageFlash = 0;
    this.threatLevel = null;
    this.lockFx = { state: 'none', since: 0, id: null };
    this._tracks.clear();
  }

  // ----------------------------------------------------------------- frame --

  update(dt, game) {
    this.time += dt;
    this.radio.update(dt);
    this.callouts.update(dt);
    this.damageFlash = Math.max(0, this.damageFlash - dt * 1.6);
    if (this.banner) {
      this.banner.age += dt;
      if (this.banner.age > this.banner.life) this.banner = null;
    }
    if (!this.visible || !this.layout) return;
    const d = normalizeHud(game.hud, game.flight, this.data);
    this._estimateVelocities(d.targets, dt);
    this.draw(d, game);
  }

  _estimateVelocities(targets, dt) {
    if (dt <= 0) return;
    const seen = new Set();
    for (const t of targets) {
      const p = t.position;
      if (!p || t.id === undefined) continue;
      seen.add(t.id);
      let tr = this._tracks.get(t.id);
      if (!tr) {
        tr = { x: p.x, y: p.y, z: p.z, vx: 0, vy: 0, vz: 0 };
        this._tracks.set(t.id, tr);
        continue;
      }
      const k = 1 - Math.exp(-dt * 6);
      tr.vx += ((p.x - tr.x) / dt - tr.vx) * k;
      tr.vy += ((p.y - tr.y) / dt - tr.vy) * k;
      tr.vz += ((p.z - tr.z) / dt - tr.vz) * k;
      tr.x = p.x;
      tr.y = p.y;
      tr.z = p.z;
    }
    if (this._tracks.size > seen.size) for (const id of this._tracks.keys()) if (!seen.has(id)) this._tracks.delete(id);
  }

  get reducedMotion() {
    return this.settings.prefersReducedMotion ?? false;
  }

  /** Square-wave blink; steady when reduced motion is on. */
  blink(hz = 2, duty = 0.6) {
    if (this.reducedMotion) return true;
    return (this.time * hz) % 1 < duty;
  }

  draw(d, game) {
    const ctx = this.ctx;
    const L = this.layout;
    const s = L.s;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, L.w, L.h);
    ctx.globalAlpha = this.settings.hudOpacity ?? 1;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    const cam = game.camera;
    this._view = cam.matrixWorldInverse.elements;
    this._proj = cam.projectionMatrix.elements;
    this._camPos = cam.position;
    this._fov = cam.fov;

    this._drawVignette(d, L);
    if (d.crashed) {
      this._drawCallouts(L, s);
      this._drawRadio(L, s);
      return;
    }
    this._drawLadder(d, game, L, s);
    this._drawTargets(d, game, L, s);
    this._drawFpm(d, game, L, s);
    this._drawThreatArcs(d, game, L, s);
    this._drawHeadingTape(d, L, s);
    this._drawSpeedTape(d, L, s);
    this._drawAltTape(d, L, s);
    this._drawWarnings(d, L, s);
    this._drawObjective(d, L, s);
    this._drawScore(d, L, s);
    this._drawWeapons(d, L, s);
    this._drawHealth(d, L, s);
    this._drawRadar(d, game, L, s);
    this._drawBanner(L, s);
    this._drawCallouts(L, s);
    this._drawRadio(L, s);
  }

  // -------------------------------------------------------------- helpers --

  _stroke(color, width) {
    const ctx = this.ctx;
    ctx.strokeStyle = this.theme.halo;
    ctx.lineWidth = width + 2.6;
    ctx.stroke();
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.stroke();
  }

  _fillHalo(color) {
    const ctx = this.ctx;
    ctx.strokeStyle = this.theme.halo;
    ctx.lineWidth = 2.6;
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.fill();
  }

  _text(str, x, y, color, size, { font = FONT_SANS, weight = 400, align = 'center', baseline = 'middle', halo = true } = {}) {
    const ctx = this.ctx;
    ctx.font = `${weight} ${size}px ${font}`;
    ctx.textAlign = align;
    ctx.textBaseline = baseline;
    if (halo) {
      // Thin, round-joined, partly transparent: at 10-12 px a heavier halo
      // fills the counters and the glyphs read as embossed over snow.
      ctx.strokeStyle = this.theme.haloText;
      ctx.lineJoin = 'round';
      ctx.lineWidth = Math.min(2.5, Math.max(1.25, size * 0.13)) * 2;
      ctx.strokeText(str, x, y);
    }
    ctx.fillStyle = color;
    ctx.fillText(str, x, y);
  }

  _project(x, y, z, out = _p, margin = 0) {
    return projectPoint(x, y, z, this._view, this._proj, this.layout.w, this.layout.h, out, margin);
  }

  /** Project a world direction (unit) from the camera. */
  _projectDir(dx, dy, dz, out = _p) {
    const c = this._camPos;
    const k = 5000;
    return this._project(c.x + dx * k, c.y + dy * k, c.z + dz * k, out);
  }

  // ----------------------------------------------------------- vignette --

  _drawVignette(d, L) {
    const lowHealth = d.hasHealth && d.health < 0.3 ? (0.3 - d.health) / 0.3 : 0;
    const pulse = this.reducedMotion ? 0.5 : 0.5 + 0.5 * Math.sin(this.time * 5);
    const a = Math.max(this.damageFlash * 0.55, lowHealth * (0.18 + 0.12 * pulse));
    if (a <= 0.01) return;
    const ctx = this.ctx;
    const g = ctx.createRadialGradient(L.w / 2, L.h / 2, Math.min(L.w, L.h) * 0.35, L.w / 2, L.h / 2, Math.hypot(L.w, L.h) * 0.6);
    g.addColorStop(0, 'rgba(150,10,0,0)');
    g.addColorStop(1, `rgba(150,10,0,${a.toFixed(3)})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, L.w, L.h);
  }

  // ------------------------------------------------- ladder, FPM, waterline --

  _drawLadder(d, game, L, s) {
    const ctx = this.ctx;
    const th = this.theme;
    const v = game.flight?.velocity;
    const speed = v ? Math.hypot(v.x, v.y, v.z) : 0;
    // Ladder azimuth follows the velocity vector (so it centres on the FPM).
    const hdg = speed > 20 ? Math.atan2(v.x, -v.z) : d.heading * DEG;
    const centrePitch = speed > 20 ? Math.asin(Math.max(-1, Math.min(1, v.y / speed))) / DEG : d.pitch;

    ctx.save();
    ctx.beginPath();
    ctx.ellipse(L.cx, L.cy, L.ladderR * 1.12, L.ladderR, 0, 0, Math.PI * 2);
    if (this.callouts.items.length) {
      // Cut a window for the kill callout so a rung never strikes through it.
      ctx.rect(L.callout.x - 112 * s, L.callout.y - 24 * s, 224 * s, 66 * s);
      ctx.clip('evenodd');
    } else {
      ctx.clip();
    }

    const lo = Math.max(-85, Math.floor((centrePitch - 35) / 5) * 5);
    const hi = Math.min(85, Math.ceil((centrePitch + 35) / 5) * 5);
    const sh = Math.sin(hdg);
    const ch = Math.cos(hdg);
    const dh = 0.6 * DEG;
    for (let p = lo; p <= hi; p += 5) {
      const pr = p * DEG;
      const cp = Math.cos(pr);
      const sp = Math.sin(pr);
      this._projectDir(sh * cp, sp, -ch * cp, _p);
      if (_p.behind) continue;
      const x0 = _p.x;
      const y0 = _p.y;
      this._projectDir(Math.sin(hdg + dh) * cp, sp, -Math.cos(hdg + dh) * cp, _q);
      if (_q.behind) continue;
      let ux = _q.x - x0;
      let uy = _q.y - y0;
      const ul = Math.hypot(ux, uy) || 1;
      ux /= ul;
      uy /= ul;
      // "towards horizon" normal: perpendicular, sign chosen by pitch
      const nx = -uy;
      const ny = ux;
      const horizon = p === 0;
      const major = p % 10 === 0;
      if (!horizon && !major) {
        // minor 5-degree tick: two short marks
        const half = 30 * s;
        const len = 8 * s;
        ctx.beginPath();
        ctx.moveTo(x0 - ux * half, y0 - uy * half);
        ctx.lineTo(x0 - ux * (half - len), y0 - uy * (half - len));
        ctx.moveTo(x0 + ux * half, y0 + uy * half);
        ctx.lineTo(x0 + ux * (half - len), y0 + uy * (half - len));
        this._stroke(th.faint, 1.2);
        continue;
      }
      const half = (horizon ? 230 : 62) * s;
      const gap = (horizon ? 46 : 26) * s;
      const tip = 9 * s * (p > 0 ? 1 : -1); // ticks point toward the horizon
      ctx.beginPath();
      if (p < 0) {
        // dashed below the horizon
        const segs = 3;
        for (const side of [-1, 1]) {
          for (let i = 0; i < segs; i++) {
            const a = gap + ((half - gap) * i) / segs;
            const b = a + ((half - gap) / segs) * 0.6;
            ctx.moveTo(x0 + ux * a * side, y0 + uy * a * side);
            ctx.lineTo(x0 + ux * b * side, y0 + uy * b * side);
          }
        }
      } else {
        ctx.moveTo(x0 - ux * gap, y0 - uy * gap);
        ctx.lineTo(x0 - ux * half, y0 - uy * half);
        ctx.moveTo(x0 + ux * gap, y0 + uy * gap);
        ctx.lineTo(x0 + ux * half, y0 + uy * half);
      }
      if (!horizon) {
        ctx.moveTo(x0 - ux * half, y0 - uy * half);
        ctx.lineTo(x0 - ux * half + nx * tip, y0 - uy * half + ny * tip);
        ctx.moveTo(x0 + ux * half, y0 + uy * half);
        ctx.lineTo(x0 + ux * half + nx * tip, y0 + uy * half + ny * tip);
      }
      this._stroke(horizon ? th.ink : th.dim, horizon ? 1.6 : 1.3);
      if (!horizon) {
        const label = String(Math.abs(p));
        const lx = ux * (half + 16 * s);
        const ly = uy * (half + 16 * s);
        this._text(label, x0 - lx, y0 - ly, th.dim, 11 * s);
        this._text(label, x0 + lx, y0 + ly, th.dim, 11 * s);
      }
    }
    ctx.restore();
  }

  _drawFpm(d, game, L, s) {
    const ctx = this.ctx;
    const th = this.theme;
    const f = game.flight;
    // waterline: where the nose points
    if (f?.forward) {
      this._projectDir(f.forward.x, f.forward.y, f.forward.z, _q);
      if (!_q.behind) {
        const x = _q.x;
        const y = _q.y;
        const w = 10 * s;
        ctx.beginPath();
        ctx.moveTo(x - w * 1.8, y);
        ctx.lineTo(x - w * 0.9, y);
        ctx.lineTo(x - w * 0.45, y + w * 0.6);
        ctx.lineTo(x, y);
        ctx.lineTo(x + w * 0.45, y + w * 0.6);
        ctx.lineTo(x + w * 0.9, y);
        ctx.lineTo(x + w * 1.8, y);
        this._stroke(th.dim, 1.3);
      }
    }
    // flight path marker
    const v = f?.velocity;
    const sp = v ? Math.hypot(v.x, v.y, v.z) : 0;
    let x = L.cx;
    let y = L.cy;
    if (sp > 15) {
      this._projectDir(v.x / sp, v.y / sp, v.z / sp, _p);
      if (!_p.behind) {
        x = _p.x;
        y = _p.y;
      }
    }
    this._fpm = { x, y };
    const r = 7 * s;
    const stall = d.stall;
    const col = stall ? (this.blink(3) ? this.theme.caution : th.dim) : th.ink;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.moveTo(x - r, y);
    ctx.lineTo(x - r * 2.6, y);
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + r * 2.6, y);
    ctx.moveTo(x, y - r);
    ctx.lineTo(x, y - r * 1.9);
    this._stroke(col, 1.7);
  }

  // ------------------------------------------------------------- targets --

  _resolveLockTarget(d) {
    const lk = d.lock;
    if (!lk || !lk.target || lk.state === 'none') return null;
    if (lk.target.position) return lk.target;
    const id = lk.target;
    for (const t of d.targets) if (t.id === id) return t;
    return null;
  }

  _drawTargets(d, game, L, s) {
    const th = this.theme;
    const me = game.flight?.position;
    const lockT = this._resolveLockTarget(d);
    const lockState = d.lock?.state ?? 'none';
    const off = [];
    const on = [];
    for (const t of d.targets) {
      if (t.alive === false || !t.position) continue;
      const p = t.position;
      const dist = t.distance ?? (me ? Math.hypot(p.x - me.x, p.y - me.y, p.z - me.z) : 0);
      const color = targetColor(th, t);
      const isLock = !!lockT && (lockT === t || lockT.id === t.id);
      this._project(p.x, p.y, p.z, _p, 6);
      // On touch, a marker under a button is as good as off-screen: hand it
      // to the edge arrows, which stay clear of the thumbs.
      const hidden = _p.onScreen && this._occluded(_p.x, _p.y, 18 * s);
      if (_p.onScreen && !hidden) on.push({ t, dist, color, isLock, x: _p.x, y: _p.y });
      else off.push({ t, dist, color, x: _p.x, y: _p.y });
    }
    // Labels only where they help: the lock, priority and lead targets, and
    // the two nearest others. Everything else is a bare shape.
    on.sort((a, b) => a.dist - b.dist);
    let free = 2;
    for (const o of on) {
      const keyed = o.isLock || o.t.isTarget || o.t.isAce;
      const labelled = keyed || free-- > 0;
      this._drawMarker(o.t, o.x, o.y, o.dist, o.color, s, o.isLock, o.isLock ? lockState : 'none', labelled);
    }
    // Off-screen arrows: priority first, then nearest; capped.
    off.sort((a, b) => rankOff(b.t) - rankOff(a.t) || a.dist - b.dist);
    const n = Math.min(off.length, L.touch ? 6 : 9);
    for (let i = 0; i < n; i++) this._drawEdgeArrow(off[i], L, s);
    // Lock reticle draws over everything else
    if (lockT && lockState !== 'none') this._drawLock(d, lockT, L, s);
    this._drawGunPipper(d, game, L, s, lockT);
  }

  _occluded(x, y, pad) {
    const list = this.occluders;
    if (!this.touch || !list?.length) return false;
    for (const r of list) {
      if (x > r.x - pad && x < r.x + r.w + pad && y > r.y - pad && y < r.y + r.h + pad) return true;
    }
    return false;
  }

  _drawMarker(t, x, y, dist, color, s, isLock, lockState, labelled = true) {
    const ctx = this.ctx;
    const th = this.theme;
    const near = Math.max(0, 1 - dist / 6000);
    const m = (11 + near * 5) * s;
    const ground = isGroundKind(t.kind);
    ctx.beginPath();
    if (t.team === 'friendly' || t.team === 'blue') {
      ctx.arc(x, y, m * 0.8, 0, Math.PI * 2);
    } else if (ground) {
      // ground: diamond
      ctx.moveTo(x, y - m);
      ctx.lineTo(x + m, y);
      ctx.lineTo(x, y + m);
      ctx.lineTo(x - m, y);
      ctx.closePath();
    } else {
      // air: four corner brackets
      const c = m * 0.45;
      for (const [sx, sy] of CORNERS) {
        ctx.moveTo(x + sx * m, y + sy * (m - c));
        ctx.lineTo(x + sx * m, y + sy * m);
        ctx.lineTo(x + sx * (m - c), y + sy * m);
      }
    }
    this._stroke(color, isLock ? 2.2 : 1.7);

    let labelY = y + m + 11 * s;
    if (t.isAce) {
      // ace: a second, notched frame + chevron crest
      const m2 = m + 5 * s;
      ctx.beginPath();
      ctx.moveTo(x - m2, y - m2 * 0.5);
      ctx.lineTo(x - m2, y - m2);
      ctx.lineTo(x - m2 * 0.3, y - m2);
      ctx.moveTo(x + m2 * 0.3, y - m2);
      ctx.lineTo(x + m2, y - m2);
      ctx.lineTo(x + m2, y - m2 * 0.5);
      ctx.moveTo(x - m2 * 0.3, y - m2);
      ctx.lineTo(x, y - m2 - 6 * s);
      ctx.lineTo(x + m2 * 0.3, y - m2);
      this._stroke(color, 1.5);
    } else if (t.isTarget) {
      // priority: downward chevron above
      const yy = y - m - 7 * s;
      ctx.beginPath();
      ctx.moveTo(x - 6 * s, yy - 6 * s);
      ctx.lineTo(x, yy);
      ctx.lineTo(x + 6 * s, yy - 6 * s);
      this._stroke(color, 2);
    }
    if (!labelled) return;
    // labels
    if (t.name) {
      const tag = t.isAce ? t.name.toUpperCase() : t.name;
      this._text(tag, x, y - m - (t.isAce ? 22 : t.isTarget ? 20 : 9) * s, color, (t.isAce ? 12 : 11) * s, {
        font: FONT_SANS,
        weight: t.isAce ? 700 : 400,
        baseline: 'bottom',
      });
    }
    this._text(formatRange(dist), x, labelY, color, 11 * s, { baseline: 'top' });
    if (t.isTarget) this._text('TGT', x + m + 4 * s, y, color, 10 * s, { align: 'left', weight: 700 });
    if (t.lockable && !isLock && lockState === 'none' && dist < 4000 && !ground) {
      // small "in envelope" dot under the range
      ctx.beginPath();
      ctx.arc(x, labelY + 16 * s, 1.8 * s, 0, Math.PI * 2);
      this._fillHalo(color);
    }
  }

  _drawEdgeArrow(o, L, s) {
    const ctx = this.ctx;
    const ab = L.arrowBox;
    boxClamp(o.x, o.y, ab.cx, ab.cy, ab.hw, ab.hh, _e);
    // keep arrows off the radar disc: slide them up the edge past it
    const rd = L.radar;
    const clear = rd.r + 26 * s;
    if (Math.hypot(_e.x - rd.x, _e.y - rd.y) < clear) {
      if (rd.y > L.h / 2) _e.y = rd.y - clear;
      else _e.y = rd.y + clear;
    }
    // and never under a touch button: walk in toward the box centre
    for (let i = 0; i < 40 && this._occluded(_e.x, _e.y, 14 * s); i++) {
      _e.x += (ab.cx - _e.x) * 0.06;
      _e.y += (ab.cy - _e.y) * 0.06;
    }
    const big = o.t.isTarget || o.t.isAce;
    const a = _e.angle;
    const len = (big ? 15 : 11) * s;
    const wid = (big ? 9 : 7) * s;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    ctx.beginPath();
    ctx.moveTo(_e.x + ca * len, _e.y + sa * len);
    ctx.lineTo(_e.x - sa * wid, _e.y + ca * wid);
    ctx.lineTo(_e.x + sa * wid, _e.y - ca * wid);
    ctx.closePath();
    if (big) this._fillHalo(o.color);
    else this._stroke(o.color, 1.6);
    const tx = _e.x - ca * 20 * s;
    const ty = _e.y - sa * 20 * s;
    this._text(formatRange(o.dist), tx, ty, o.color, 10 * s);
  }

  _drawLock(d, t, L, s) {
    const ctx = this.ctx;
    const th = this.theme;
    const p = t.position;
    this._project(p.x, p.y, p.z, _q);
    if (_q.behind) return;
    const x = _q.x;
    const y = _q.y;
    const state = d.lock.state;
    const since = this.time - (this.lockFx.state === state ? this.lockFx.since : this.time);
    const color = targetColor(th, t);
    if (state === 'acquiring') {
      const prog = Math.min(1, Math.max(0, d.lock.progress ?? Math.min(1, since / 1.2)));
      // Four arcs that close in and complete as the seeker settles.
      const r = (46 - 26 * prog) * s;
      const spin = this.reducedMotion ? 0 : this.time * 2.4;
      for (let i = 0; i < 4; i++) {
        const a0 = spin + (i * Math.PI) / 2 + 0.18;
        const a1 = a0 + (Math.PI / 2 - 0.36) * (0.35 + 0.65 * prog);
        ctx.beginPath();
        ctx.arc(x, y, r, a0, a1);
        this._stroke(color, 1.8);
      }
      this._text('ACQ', x, y + r + 12 * s, color, 10 * s, { weight: 700 });
    } else if (state === 'locked') {
      // Solid rotated square snapping in, then a steady "LOCK" plate.
      const k = this.reducedMotion ? 1 : Math.min(1, since / 0.14);
      const r = (24 + (1 - k) * 18) * s;
      ctx.beginPath();
      ctx.moveTo(x, y - r);
      ctx.lineTo(x + r, y);
      ctx.lineTo(x, y + r);
      ctx.lineTo(x - r, y);
      ctx.closePath();
      this._stroke(color, 2.4);
      // inner cross ticks
      ctx.beginPath();
      ctx.moveTo(x, y - r - 6 * s);
      ctx.lineTo(x, y - r + 5 * s);
      ctx.moveTo(x, y + r + 6 * s);
      ctx.lineTo(x, y + r - 5 * s);
      ctx.moveTo(x - r - 6 * s, y);
      ctx.lineTo(x - r + 5 * s, y);
      ctx.moveTo(x + r + 6 * s, y);
      ctx.lineTo(x + r - 5 * s, y);
      this._stroke(color, 1.8);
      const show = since > 0.6 || this.blink(8, 0.5);
      if (show) {
        const w = 40 * s;
        const h = 15 * s;
        const by = y + r + 10 * s;
        ctx.fillStyle = color;
        ctx.fillRect(x - w / 2, by, w, h);
        this._text('LOCK', x, by + h / 2 + 0.5, th.halo, 11 * s, { weight: 700, halo: false });
      }
    }
  }

  _drawGunPipper(d, game, L, s, lockT) {
    const f = game.flight;
    if (!f?.position) return;
    const gunActive = d.weapon?.current === 'gun' || d.gun?.firing;
    // choose: locked air target, else nearest air target ahead within 1.6 km
    let t = lockT && !isGroundKind(lockT.kind) ? lockT : null;
    let best = 1600;
    if (!t) {
      for (const c of d.targets) {
        if (c.alive === false || !c.position || isGroundKind(c.kind) || c.team === 'friendly') continue;
        const p = c.position;
        const dist = Math.hypot(p.x - f.position.x, p.y - f.position.y, p.z - f.position.z);
        if (dist < best) {
          // only targets in front
          const fx = (p.x - f.position.x) / dist;
          const fy = (p.y - f.position.y) / dist;
          const fz = (p.z - f.position.z) / dist;
          if (fx * f.forward.x + fy * f.forward.y + fz * f.forward.z < 0.7) continue;
          best = dist;
          t = c;
        }
      }
    }
    if (!t) return;
    const p = t.position;
    const dist = Math.hypot(p.x - f.position.x, p.y - f.position.y, p.z - f.position.z);
    if (dist > 1600 || (!gunActive && dist > 1200)) return;
    const tr = this._tracks.get(t.id);
    const tv = t.velocity ?? t.entity?.velocity ?? (tr ? { x: tr.vx, y: tr.vy, z: tr.vz } : null);
    gunLead(f.position, f.velocity, p, tv, MUZZLE, _lead);
    this._project(_lead.x, _lead.y, _lead.z, _q);
    if (_q.behind) return;
    const ctx = this.ctx;
    const th = this.theme;
    const x = _q.x;
    const y = _q.y;
    const r = 17 * s;
    const inRange = dist < 900;
    const col = inRange ? th.ink : th.dim;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    this._stroke(col, 1.4);
    // range arc unwinds as range closes (full at 1600 m)
    const frac = Math.min(1, dist / 1600);
    ctx.beginPath();
    ctx.arc(x, y, r + 4 * s, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2);
    this._stroke(col, inRange ? 3 : 2);
    ctx.beginPath();
    ctx.arc(x, y, 2 * s, 0, Math.PI * 2);
    this._fillHalo(col);
    if (inRange && this.blink(3, 0.7)) this._text('SHOOT', x, y + r + 16 * s, th.ink, 10 * s, { weight: 700 });
  }

  // -------------------------------------------------------------- threats --

  _drawThreatArcs(d, game, L, s) {
    if (!d.threats.length) return;
    const ctx = this.ctx;
    const th = this.theme;
    const cx = L.cx;
    const cy = L.cy;
    const R = Math.min(L.ladderR * 0.92, L.tapeH * 0.55);
    const f = game.flight;
    for (const m of d.threats) {
      let ang;
      if (m.position) {
        this._project(m.position.x, m.position.y, m.position.z, _q);
        if (_q.onScreen) {
          // visible: hard ring on the missile itself
          ctx.beginPath();
          ctx.arc(_q.x, _q.y, 9 * s, 0, Math.PI * 2);
          this._stroke(th.warning, 2);
        }
        ang = Math.atan2(_q.y - cy, _q.x - cx);
      } else if (Number.isFinite(m.bearing) && f) {
        // bearing (deg, relative to nose if < 0 or > 360 not expected) -> screen
        const rel = ((m.bearing - (this.data.heading ?? 0)) * DEG);
        ang = rel - Math.PI / 2;
      } else continue;
      const close = Math.max(0, 1 - (m.distance ?? 4000) / 4000);
      const w = (0.22 + close * 0.25);
      const pulse = this.reducedMotion ? 1 : 0.65 + 0.35 * Math.sin(this.time * (8 + close * 10));
      ctx.beginPath();
      ctx.arc(cx, cy, R, ang - w, ang + w);
      ctx.globalAlpha = (this.settings.hudOpacity ?? 1) * pulse;
      this._stroke(th.warning, 4 + close * 3);
      ctx.beginPath();
      ctx.arc(cx, cy, R + 9 * s, ang - w * 0.6, ang + w * 0.6);
      this._stroke(th.warning, 1.6);
      ctx.globalAlpha = this.settings.hudOpacity ?? 1;
    }
  }

  // ----------------------------------------------------------------- tapes --

  _drawHeadingTape(d, L, s) {
    const ctx = this.ctx;
    const th = this.theme;
    const { x: cx, y, w } = L.heading;
    const span = 70;
    const ppd = w / span;
    const hdg = d.heading;
    ctx.save();
    ctx.beginPath();
    ctx.rect(cx - w / 2 - 2, y - 4, w + 4, 40 * s);
    ctx.clip();
    const start = Math.ceil((hdg - span / 2) / 5) * 5;
    ctx.beginPath();
    for (let a = start; a <= hdg + span / 2; a += 5) {
      const x = cx + (a - hdg) * ppd;
      const major = ((a % 10) + 10) % 10 === 0;
      ctx.moveTo(x, y + 18 * s);
      ctx.lineTo(x, y + (major ? 8 : 13) * s);
    }
    this._stroke(th.dim, 1.2);
    for (let a = Math.ceil((hdg - span / 2) / 10) * 10; a <= hdg + span / 2; a += 10) {
      const x = cx + (a - hdg) * ppd;
      if (Math.abs(x - cx) < 26 * s || Math.abs(x - cx) > w / 2 - 8 * s) continue;
      const lbl = headingTickLabel(a);
      const card = lbl.length === 1;
      this._text(lbl, x, y + 1 * s, card ? th.ink : th.dim, (card ? 13 : 11) * s, { baseline: 'top', weight: card ? 700 : 400 });
    }
    ctx.restore();
    // objective bearing caret
    const obj = d.objective?.marker;
    if (obj && obj.x !== undefined && this._camPos) {
      const f = this.data;
      const me = this._camPos;
      const brg = (Math.atan2(obj.x - me.x, -(obj.z - me.z)) / DEG + 360) % 360;
      let rel = brg - f.heading;
      rel = ((rel + 540) % 360) - 180;
      const x = cx + Math.max(-span / 2, Math.min(span / 2, rel)) * ppd;
      const ctx2 = this.ctx;
      ctx2.beginPath();
      ctx2.moveTo(x, y + 20 * s);
      ctx2.lineTo(x - 5 * s, y + 27 * s);
      ctx2.lineTo(x + 5 * s, y + 27 * s);
      ctx2.closePath();
      this._fillHalo(th.priority);
    }
    // readout box with pointer
    const bw = 44 * s;
    const bh = 20 * s;
    const by = y + 20 * s;
    ctx.beginPath();
    ctx.moveTo(cx - bw / 2, by + 6 * s);
    ctx.lineTo(cx - 5 * s, by + 6 * s);
    ctx.lineTo(cx, by);
    ctx.lineTo(cx + 5 * s, by + 6 * s);
    ctx.lineTo(cx + bw / 2, by + 6 * s);
    ctx.lineTo(cx + bw / 2, by + 6 * s + bh);
    ctx.lineTo(cx - bw / 2, by + 6 * s + bh);
    ctx.closePath();
    ctx.fillStyle = th.haloSoft;
    ctx.fill();
    this._stroke(th.ink, 1.4);
    this._text(formatHeading(hdg), cx, by + 6 * s + bh / 2 + 0.5, th.ink, 14 * s, { font: FONT_MONO, weight: 700 });
  }

  _drawSpeedTape(d, L, s) {
    const th = this.theme;
    const kt = toKnots(d.speed);
    this._tape({
      x: L.speed.x, y: L.speed.y, h: L.tapeH, s,
      value: kt, unitsPerPx: 120 / L.tapeH, minor: 10, major: 50,
      side: -1, label: (v) => String(v), readout: formatSpeed(d.speed), tag: 'KT',
      color: d.stall ? th.caution : th.ink,
    });
    const ctx = this.ctx;
    // G meter under the speed box
    const gx = L.speed.x - 8 * s;
    const gy = L.speed.y + L.tapeH / 2 + 20 * s;
    const g = d.gLoad;
    const gCol = g > 7.5 ? th.warning : g > 6 ? th.caution : th.ink;
    this._text('G', gx - 54 * s, gy, th.dim, 11 * s, { align: 'left' });
    this._text(formatG(g), gx, gy, gCol, 15 * s, { font: FONT_SANS, align: 'right', weight: 700 });
    // throttle column, outboard of the tape labels
    const tx = L.speed.x - 76 * s;
    const th0 = L.speed.y + L.tapeH * 0.42;
    const tH = L.tapeH * 0.5;
    const ctl = Math.min(1, Math.max(0, d.throttle));
    ctx.beginPath();
    ctx.rect(tx, th0 - tH, 5 * s, tH);
    this._stroke(th.faint, 1);
    const fillH = tH * ctl;
    const burnerStart = 0.85;
    ctx.fillStyle = th.dim;
    ctx.fillRect(tx, th0 - Math.min(fillH, tH * burnerStart), 5 * s, Math.min(fillH, tH * burnerStart));
    if (ctl > burnerStart || d.reheat) {
      ctx.fillStyle = th.burner;
      const bh = Math.max(0, fillH - tH * burnerStart);
      ctx.fillRect(tx, th0 - tH * burnerStart - bh, 5 * s, bh);
    }
    // burner detent
    ctx.beginPath();
    ctx.moveTo(tx - 3 * s, th0 - tH * burnerStart);
    ctx.lineTo(tx + 8 * s, th0 - tH * burnerStart);
    this._stroke(th.dim, 1);
    this._text(d.reheat ? 'AB' : 'THR', tx + 2.5 * s, th0 + 10 * s, d.reheat ? th.burner : th.dim, 9 * s, { weight: 700 });
  }

  _drawAltTape(d, L, s) {
    const th = this.theme;
    const ft = toFeet(d.altitude);
    this._tape({
      x: L.alt.x, y: L.alt.y, h: L.tapeH, s,
      value: ft, unitsPerPx: 1200 / L.tapeH, minor: 100, major: 500,
      side: 1, label: (v) => groupThousands(v), readout: formatAltitude(d.altitude), tag: 'FT', wide: true,
      color: th.ink,
    });
    // radar altitude (AGL) under the box
    const aglFt = toFeet(d.agl);
    const low = d.agl < 300;
    const col = d.agl < 120 ? th.warning : low ? th.caution : th.ink;
    const ax = L.alt.x + 8 * s;
    const ay = L.alt.y + L.tapeH / 2 + 20 * s;
    this._text('R', ax, ay, th.dim, 11 * s, { align: 'left' });
    this._text(d.agl > 15000 ? '-----' : groupThousands(Math.round(aglFt / 10) * 10), ax + 62 * s, ay, col, 15 * s, { font: FONT_MONO, align: 'right', weight: 700 });
    // vertical speed caret on the tape edge
    const vs = this._vsFilter(d);
    const k = Math.max(-1, Math.min(1, vs / 60));
    const vy = L.alt.y - k * (L.tapeH / 2 - 10 * s);
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(L.alt.x - 4 * s, vy);
    ctx.lineTo(L.alt.x - 11 * s, vy - 4 * s);
    ctx.lineTo(L.alt.x - 11 * s, vy + 4 * s);
    ctx.closePath();
    this._fillHalo(th.dim);
  }

  _vsFilter(d) {
    const t = this.time;
    if (this._lastAlt === undefined) {
      this._lastAlt = d.altitude;
      this._lastAltT = t;
      this._vs = 0;
      return 0;
    }
    const dt = t - this._lastAltT;
    if (dt > 0.05) {
      const raw = (d.altitude - this._lastAlt) / dt;
      this._vs += (raw - this._vs) * 0.3;
      this._lastAlt = d.altitude;
      this._lastAltT = t;
    }
    return this._vs;
  }

  /**
   * Generic vertical tape. `x` is the spine (the edge nearest the screen
   * centre); `side` is the outward direction (-1 for the speed tape left of
   * centre, +1 for altitude). Ticks, labels and the readout box all extend
   * outward from the spine, and the box's pointer touches the spine.
   */
  _tape({ x, y, h, s, value, unitsPerPx, minor, major, side, label, readout, tag, color, wide }) {
    const ctx = this.ctx;
    const th = this.theme;
    const half = h / 2;
    const tw = (wide ? 66 : 50) * s;
    // tape spine on the inner edge
    const edge = x;
    const outer = x + side * tw;
    ctx.save();
    ctx.beginPath();
    ctx.rect(Math.min(edge, outer) - 4, y - half, tw + 8, h);
    ctx.clip();
    const lo = Math.floor((value - half * unitsPerPx) / minor) * minor;
    const hi = value + half * unitsPerPx;
    ctx.beginPath();
    for (let v = lo; v <= hi; v += minor) {
      const yy = y - (v - value) / unitsPerPx;
      const isMajor = ((v % major) + major) % major === 0;
      ctx.moveTo(edge, yy);
      ctx.lineTo(edge + side * (isMajor ? 10 : 5) * s, yy);
    }
    this._stroke(th.dim, 1.2);
    for (let v = Math.ceil(lo / major) * major; v <= hi; v += major) {
      const yy = y - (v - value) / unitsPerPx;
      if (Math.abs(yy - y) < 16 * s) continue;
      if (v < 0) continue;
      const fade = 1 - Math.pow(Math.abs(yy - y) / half, 4);
      ctx.globalAlpha = (this.settings.hudOpacity ?? 1) * Math.max(0, fade);
      this._text(label(v), edge + side * 14 * s, yy, th.dim, 11 * s, { font: FONT_SANS, align: side < 0 ? 'right' : 'left' });
    }
    ctx.globalAlpha = this.settings.hudOpacity ?? 1;
    ctx.restore();
    // spine
    ctx.beginPath();
    ctx.moveTo(edge, y - half);
    ctx.lineTo(edge, y + half);
    this._stroke(th.faint, 1);
    // readout box pointing at the spine
    const bw = (wide ? 70 : 54) * s;
    const bh = 24 * s;
    const tipX = edge - side * 1 * s;
    const bx0 = edge + side * 8 * s;
    const bx1 = bx0 + side * bw;
    ctx.beginPath();
    ctx.moveTo(tipX, y);
    ctx.lineTo(bx0, y - bh / 2);
    ctx.lineTo(bx1, y - bh / 2);
    ctx.lineTo(bx1, y + bh / 2);
    ctx.lineTo(bx0, y + bh / 2);
    ctx.closePath();
    ctx.fillStyle = th.haloSoft;
    ctx.fill();
    this._stroke(color, 1.5);
    const tx = (bx0 + bx1) / 2 + side * 1 * s;
    this._text(readout, tx, y + 0.5, color, 16 * s, { font: FONT_MONO, weight: 700 });
    this._text(tag, bx1 + side * 0, y - half - 10 * s, th.dim, 10 * s, { align: side < 0 ? 'left' : 'right' });
  }

  // ------------------------------------------------------------- warnings --

  _drawWarnings(d, L, s) {
    const th = this.theme;
    const items = [];
    const w = d.warning;
    if (w === 'pullup') items.push(['PULL UP', th.warning, 4]);
    const threat = this.threatLevel ?? (d.threats.length ? 'warning' : null);
    if (threat || w === 'missile') {
      const alert = threat === 'alert' || d.threats.some((m) => (m.distance ?? 9999) < 1500);
      items.push([alert ? 'MISSILE — BREAK' : 'MISSILE', th.warning, alert ? 6 : 2.5]);
    }
    if (w === 'terrain') items.push(['TERRAIN', th.caution, 2]);
    if (w === 'stall') items.push(['STALL', th.caution, 2.5]);
    if (w === 'damage') items.push(['DAMAGE', th.caution, 1.5]);
    let y = L.warn.y;
    for (const [label, color, hz] of items.slice(0, 2)) {
      const on = this.blink(hz, 0.62);
      this._warnPlate(label, L.warn.x, y, color, s, on);
      y += 34 * s;
    }
    if (items.length && (threat === 'alert' || items[0][0].startsWith('MISSILE')) && d.flares) {
      const n = d.flares.count;
      if (n > 0) this._text(`FLARES  [${this.keyHint.flares}]`, L.warn.x, y - 6 * s, th.dim, 10 * s, { weight: 700 });
    }
  }

  _warnPlate(label, x, y, color, s, on) {
    const ctx = this.ctx;
    ctx.font = `700 ${18 * s}px ${FONT_SANS}`;
    const tw = ctx.measureText(label).width + 26 * s;
    const h = 26 * s;
    ctx.beginPath();
    ctx.rect(x - tw / 2, y - h / 2, tw, h);
    if (on) {
      ctx.fillStyle = color;
      ctx.fill();
      ctx.strokeStyle = this.theme.halo;
      ctx.lineWidth = 2;
      ctx.stroke();
      this._text(label, x, y + 1, '#120404', 18 * s, { font: FONT_SANS, weight: 700, halo: false });
    } else {
      ctx.fillStyle = this.theme.haloSoft;
      ctx.fill();
      this._stroke(color, 2);
      this._text(label, x, y + 1, color, 18 * s, { font: FONT_SANS, weight: 700 });
    }
  }

  // ------------------------------------------------------- corner groups --

  _drawObjective(d, L, s) {
    const o = d.objective;
    if (!o?.text) return;
    // In portrait the new-orders banner takes this line's place outright.
    if (L.portrait && this.banner) return;
    const th = this.theme;
    const ctx = this.ctx;
    let { x, y } = L.objective;
    const maxW = L.portrait ? L.w * 0.5 : Math.min(360 * s, L.w * 0.3);
    // tag
    const tag = 'OBJ';
    ctx.font = `700 ${10 * s}px ${FONT_MONO}`;
    const tw = ctx.measureText(tag).width + 10 * s;
    ctx.fillStyle = th.priority;
    ctx.fillRect(x, y, tw, 16 * s);
    this._text(tag, x + tw / 2, y + 8.5 * s, th.halo, 10 * s, { weight: 700, halo: false });
    const lines = wrapText(ctx, o.text, maxW - tw - 8 * s, `400 ${13 * s}px ${FONT_SANS}`);
    let ly = y + 8.5 * s;
    for (const line of lines.slice(0, 2)) {
      this._text(line, x + tw + 8 * s, ly, th.ink, 13 * s, { font: FONT_SANS, align: 'left' });
      ly += 18 * s;
    }
    if (Number.isFinite(o.total) && o.total > 0) {
      const prog = Math.min(o.total, o.progress ?? 0);
      const bx = x + tw + 8 * s;
      const by = ly - 2 * s;
      const seg = Math.min(12, o.total);
      const sw = Math.min(18 * s, (maxW - tw - 60 * s) / seg);
      for (let i = 0; i < seg; i++) {
        const filled = i < Math.round((prog / o.total) * seg);
        ctx.fillStyle = filled ? th.priority : th.faint;
        ctx.fillRect(bx + i * (sw + 3 * s), by, sw, 4 * s);
      }
      this._text(`${prog}/${o.total}`, bx + seg * (sw + 3 * s) + 6 * s, by + 2 * s, th.dim, 11 * s, { align: 'left' });
    }
  }

  _drawScore(d, L, s) {
    const th = this.theme;
    const { x, y } = L.score;
    if (d.hasScore) {
      this._text('SCORE', x, y + 6 * s, th.dim, 10 * s, { align: 'right' });
      this._text(formatScore(d.score), x, y + 26 * s, th.ink, 20 * s, { font: FONT_MONO, align: 'right', weight: 700 });
    }
    if (d.time !== null) {
      const remaining = d.timeLimit ? d.timeLimit - d.time : null;
      const t = remaining ?? d.time;
      const col = remaining !== null && remaining < 60 ? (this.blink(1, 0.7) ? th.caution : th.dim) : th.ink;
      const ty = y + (d.hasScore ? 50 : 10) * s;
      this._text(remaining !== null ? 'TIME LEFT' : 'TIME', x - 64 * s, ty, th.dim, 10 * s, { align: 'right' });
      this._text(formatClock(t), x, ty, col, 15 * s, { align: 'right', weight: 700 });
    }
  }

  _drawWeapons(d, L, s) {
    const w = d.weapon;
    const gun = d.gun;
    const fl = d.flares;
    if (!w && !gun && !fl) return;
    const th = this.theme;
    const ctx = this.ctx;
    const x = L.weapons.x;
    const top = !!L.weaponsTop;
    const rowH = 19 * s;
    const rows = [];
    const cur = w?.current ?? 'msl';
    if (w && w.current !== 'gun') {
      rows.push({ big: true, label: w.name ?? (cur === 'sp' ? 'SPECIAL' : 'MSL'), value: formatAmmo(w.ammo), ready: w.ready !== false, reload: w.reload });
    }
    if (gun) rows.push({ label: 'GUN', value: formatAmmo(gun.ammo), active: cur === 'gun', firing: gun.firing });
    if (fl) rows.push({ label: 'FLR', value: formatAmmo(fl.count), ready: fl.ready !== false, flare: true });
    // stack from bottom (or from top on landscape touch)
    let y = top ? L.weapons.y : L.weapons.y - rows.reduce((a, r) => a + (r.big ? 44 * s : rowH), 0);
    for (const r of rows) {
      if (r.big) {
        const empty = r.value === '0';
        const col = empty ? th.warning : r.ready ? th.ink : th.dim;
        this._text(r.label, x - 70 * s, y + 13 * s, col, 15 * s, { font: FONT_SANS, align: 'right', weight: 700 });
        this._text(r.value, x, y + 13 * s, col, 22 * s, { font: FONT_MONO, align: 'right', weight: 700 });
        // reload bar
        const bw = 150 * s;
        const by = y + 30 * s;
        ctx.fillStyle = th.faint;
        ctx.fillRect(x - bw, by, bw, 3 * s);
        const rl = Number.isFinite(r.reload) ? r.reload : r.ready ? 1 : 0;
        ctx.fillStyle = rl >= 1 ? th.ink : th.caution;
        ctx.fillRect(x - bw, by, bw * Math.min(1, Math.max(0, rl)), 3 * s);
        if (!r.ready && !empty) this._text('RELOAD', x - bw, by + 10 * s, th.caution, 9 * s, { align: 'left', weight: 700 });
        y += 44 * s;
      } else {
        const col = r.active ? th.ink : th.dim;
        const firing = r.firing && this.blink(12, 0.5);
        if (r.active) {
          ctx.fillStyle = th.faint;
          ctx.fillRect(x - 150 * s, y + 1 * s, 150 * s, rowH - 2 * s);
        }
        this._text(r.label, x - 70 * s, y + rowH / 2, firing ? th.burner : col, 12 * s, { font: FONT_SANS, align: 'right', weight: 700 });
        this._text(r.value, x, y + rowH / 2, r.value === '0' ? th.warning : col, 14 * s, { font: FONT_MONO, align: 'right', weight: 700 });
        if (r.flare) {
          ctx.beginPath();
          ctx.arc(x - 102 * s, y + rowH / 2, 3 * s, 0, Math.PI * 2);
          this._fillHalo(r.ready ? th.good : th.faint);
        }
        y += rowH;
      }
    }
  }

  _drawHealth(d, L, s) {
    if (!d.hasHealth) return;
    const th = this.theme;
    const ctx = this.ctx;
    const { x, y } = L.health;
    const h = d.health;
    const col = h < 0.25 ? th.warning : h < 0.5 ? th.caution : th.ink;
    const segs = 10;
    const sw = 11 * s;
    const sh = 7 * s;
    const by = y - sh;
    this._text('AIRFRAME', x, by - 12 * s, th.dim, 10 * s, { align: 'left' });
    this._text(formatPercent(h), x + segs * (sw + 2 * s) + 6 * s, by + sh / 2, col, 13 * s, { align: 'left', weight: 700 });
    const filled = Math.ceil(h * segs - 0.001);
    for (let i = 0; i < segs; i++) {
      ctx.fillStyle = i < filled ? col : th.faint;
      ctx.fillRect(x + i * (sw + 2 * s), by, sw, sh);
    }
  }

  // ---------------------------------------------------------------- radar --

  _drawRadar(d, game, L, s) {
    const ctx = this.ctx;
    const th = this.theme;
    const { x: cx, y: cy, r } = L.radar;
    const me = game.flight?.position ?? this._camPos;
    if (!me) return;
    const hdg = d.heading;
    const hr = hdg * DEG;
    // range
    const dists = [];
    for (const t of d.targets) {
      if (t.alive === false || !t.position) continue;
      if (t.isTarget || !isGroundKind(t.kind)) dists.push(Math.hypot(t.position.x - me.x, t.position.z - me.z));
    }
    const range = d.radar?.range ?? (this._radarRange = autoRange(dists, this._radarRange));

    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(4,10,14,0.66)';
    ctx.fill();
    ctx.clip();
    if (this.relief) {
      const { canvas, bounds } = this.relief;
      ctx.save();
      ctx.globalAlpha = 0.85 * (this.settings.hudOpacity ?? 1);
      ctx.translate(cx, cy);
      ctx.rotate(-hr);
      const k = r / range;
      ctx.scale(k, k);
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(canvas, bounds.minX - me.x, bounds.minZ - me.z, bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ);
      ctx.restore();
    }
    // camera FOV wedge
    const half = Math.atan(Math.tan((this._fov * DEG) / 2) * (L.w / L.h));
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.sin(-half) * r, cy - Math.cos(half) * r);
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.sin(half) * r, cy - Math.cos(half) * r);
    ctx.strokeStyle = th.faint;
    ctx.lineWidth = 1;
    ctx.stroke();
    // range rings
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.5, 0, Math.PI * 2);
    ctx.strokeStyle = th.faint;
    ctx.stroke();

    // objective marker
    const obj = d.objective?.marker;
    if (obj && obj.x !== undefined) {
      worldToRadar(obj.x - me.x, obj.z - me.z, hdg, range, _r);
      ctx.beginPath();
      ctx.arc(cx + _r.x * r * 0.94, cy + _r.y * r * 0.94, 5 * s, 0, Math.PI * 2);
      this._stroke(th.priority, 1.6);
    }
    // contacts
    for (const t of d.targets) {
      if (t.alive === false || !t.position) continue;
      worldToRadar(t.position.x - me.x, t.position.z - me.z, hdg, range, _r);
      if (_r.clamped && !(t.isTarget || t.isAce)) continue;
      const px = cx + _r.x * r * (_r.clamped ? 0.93 : 1);
      const py = cy + _r.y * r * (_r.clamped ? 0.93 : 1);
      const col = targetColor(th, t);
      const sz = (t.isTarget || t.isAce ? 4.5 : 3.4) * s;
      ctx.beginPath();
      if (isGroundKind(t.kind)) {
        ctx.moveTo(px, py - sz);
        ctx.lineTo(px + sz, py);
        ctx.lineTo(px, py + sz);
        ctx.lineTo(px - sz, py);
        ctx.closePath();
      } else {
        // oriented triangle if we know its velocity
        const tr = this._tracks.get(t.id);
        const vx = t.velocity?.x ?? tr?.vx ?? 0;
        const vz = t.velocity?.z ?? tr?.vz ?? 0;
        const a = Math.hypot(vx, vz) > 5 ? Math.atan2(vx, -vz) - hr : 0;
        const ca = Math.cos(a);
        const sa = Math.sin(a);
        const pt = (fx, fy) => [px + fx * ca - fy * sa, py + fx * sa + fy * ca];
        const [ax, ay] = pt(0, -sz * 1.4);
        const [bx, by] = pt(sz, sz);
        const [qx, qy] = pt(-sz, sz);
        ctx.moveTo(ax, ay);
        ctx.lineTo(bx, by);
        ctx.lineTo(qx, qy);
        ctx.closePath();
      }
      this._fillHalo(col);
      if (t.isAce) {
        ctx.beginPath();
        ctx.arc(px, py, sz + 3 * s, 0, Math.PI * 2);
        this._stroke(col, 1.2);
      }
    }
    // incoming missiles
    for (const m of d.threats) {
      if (!m.position) continue;
      worldToRadar(m.position.x - me.x, m.position.z - me.z, hdg, range, _r);
      if (!this.blink(6, 0.6)) continue;
      ctx.beginPath();
      ctx.arc(cx + _r.x * r, cy + _r.y * r, 2.6 * s, 0, Math.PI * 2);
      ctx.fillStyle = th.warning;
      ctx.fill();
    }
    ctx.restore();

    // rim, heading-up caret, north tick, own ship
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    this._stroke(th.dim, 1.3);
    const na = -hr - Math.PI / 2;
    const nx = cx + Math.cos(na) * (r - 9 * s);
    const ny = cy + Math.sin(na) * (r - 9 * s);
    this._text('N', nx, ny, th.ink, 10 * s, { weight: 700 });
    ctx.beginPath();
    ctx.moveTo(cx, cy - 6 * s);
    ctx.lineTo(cx + 4.5 * s, cy + 5 * s);
    ctx.lineTo(cx, cy + 2.5 * s);
    ctx.lineTo(cx - 4.5 * s, cy + 5 * s);
    ctx.closePath();
    this._fillHalo(th.ink);
    this._text(`${Math.round(range / 1000)} km`, cx + r * 0.7, cy + r * 0.88, th.dim, 10 * s, { align: 'left' });
  }

  // ------------------------------------------------ banner, callouts, radio --

  _drawBanner(L, s) {
    const b = this.banner;
    if (!b) return;
    const ctx = this.ctx;
    const th = this.theme;
    const t = b.age;
    const inA = this.reducedMotion ? 1 : Math.min(1, t / 0.25);
    const outA = Math.min(1, (b.life - t) / 0.4);
    const a = Math.max(0, Math.min(inA, outA));
    const y = L.bannerY;
    const wipe = this.reducedMotion ? 1 : easeOut(Math.min(1, t / 0.35));
    // full width in portrait, where it stands in for the objective line
    const full = L.portrait ? L.bounds.R - L.bounds.L : Math.min(L.w - 40, 460 * s);
    const w = full * wipe;
    ctx.globalAlpha = a * (this.settings.hudOpacity ?? 1);
    ctx.fillStyle = L.portrait ? 'rgba(4,10,14,0.97)' : 'rgba(4,10,14,0.66)';
    ctx.fillRect(L.cx - w / 2, y, w, 52 * s);
    ctx.fillStyle = th.priority;
    ctx.fillRect(L.cx - w / 2, y, w, 2 * s);
    this._text(b.title, L.cx, y + 15 * s, th.priority, 12 * s, { weight: 700 });
    this._text(b.text, L.cx, y + 35 * s, th.ink, 14 * s, { font: FONT_SANS });
    ctx.globalAlpha = this.settings.hudOpacity ?? 1;
  }

  _drawCallouts(L, s) {
    const items = this.callouts.items;
    if (!items.length) return;
    const th = this.theme;
    const ctx = this.ctx;
    let y = L.callout.y;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const color = {
        kill: th.ink, ace: th.ace, ground: th.ink, hit: th.dim, miss: th.dim, info: th.ink, fail: th.caution,
      }[it.kind] ?? th.ink;
      const accent = { kill: th.hostile, ace: th.ace, ground: th.ground, hit: th.hostile }[it.kind] ?? th.dim;
      const a = Math.min(1, (it.life - it.age) / 0.35) * (i === 0 ? 1 : 0.6);
      const pop = this.reducedMotion ? 1 : 1 + 0.18 * Math.max(0, 1 - it.age / 0.12);
      const big = i === 0 && (it.kind === 'kill' || it.kind === 'ace' || it.kind === 'ground');
      const size = (big ? 30 : 17) * s * pop;
      ctx.globalAlpha = Math.max(0, a) * (this.settings.hudOpacity ?? 1);
      this._text(it.text, L.cx, y, color, size, { font: FONT_DISPLAY, weight: 800 });
      if (big) {
        ctx.font = `800 ${size}px ${FONT_DISPLAY}`;
        const tw = ctx.measureText(it.text).width;
        ctx.fillStyle = accent;
        ctx.fillRect(L.cx - tw / 2, y + size * 0.52, tw, 2.5 * s);
      }
      if (it.sub) this._text(it.sub, L.cx, y + size * 0.52 + 13 * s, th.dim, 12 * s, { weight: 700 });
      y += big ? size + 26 * s : size + 6 * s;
    }
    ctx.globalAlpha = this.settings.hudOpacity ?? 1;
  }

  _drawRadio(L, s) {
    const c = this.radio.current;
    if (!c || this.settings.subtitles === false) return;
    const a = this.radio.alpha;
    if (a <= 0) return;
    const ctx = this.ctx;
    const th = this.theme;
    const scale = { small: 0.88, medium: 1, large: 1.25 }[this.settings.subtitleSize] ?? 1;
    const fs = Math.max(13, 15 * s * scale);
    const font = `400 ${fs}px ${FONT_SANS}`;
    const call = c.callsign ? c.callsign.toUpperCase() : '';
    ctx.font = `700 ${fs}px ${FONT_SANS}`;
    const cw = call ? ctx.measureText(call).width + 12 * s : 0;
    const lines = wrapText(ctx, c.text, L.radio.maxW - cw - 24 * s, font);
    ctx.font = font;
    let tw = 0;
    for (const ln of lines) tw = Math.max(tw, ctx.measureText(ln).width);
    const W = cw + tw + 24 * s;
    const lh = fs * 1.35;
    const H = lines.length * lh + 14 * s;
    const x0 = L.radio.x - W / 2;
    const y0 = L.radio.y - H;
    ctx.globalAlpha = a;
    ctx.fillStyle = 'rgba(3,8,12,0.7)';
    ctx.fillRect(x0, y0, W, H);
    // Speaker in the symbology ink, set apart by weight and a rule, so amber
    // stays reserved for objectives.
    ctx.fillStyle = th.ink;
    ctx.fillRect(x0, y0, 2 * s, H);
    if (call) this._text(call, x0 + 12 * s, y0 + 7 * s + lh / 2, th.ink, fs, { font: FONT_SANS, weight: 700, align: 'left', halo: false });
    let y = y0 + 7 * s + lh / 2;
    for (const ln of lines) {
      this._text(ln, x0 + 12 * s + cw, y, '#eef6f8', fs, { font: FONT_SANS, align: 'left', halo: false });
      y += lh;
    }
    ctx.globalAlpha = this.settings.hudOpacity ?? 1;
  }
}

const CORNERS = [[-1, -1], [1, -1], [1, 1], [-1, 1]];

function rankOff(t) {
  return (t.isAce ? 2 : 0) + (t.isTarget ? 1 : 0);
}

function easeOut(t) {
  return 1 - Math.pow(1 - t, 3);
}

/** Greedy word wrap with ctx.measureText. */
export function wrapText(ctx, text, maxW, font) {
  ctx.font = font;
  const words = String(text).split(/\s+/);
  const lines = [];
  let line = '';
  for (const w of words) {
    const t = line ? line + ' ' + w : w;
    if (ctx.measureText(t).width > maxW && line) {
      lines.push(line);
      line = w;
    } else line = t;
  }
  if (line) lines.push(line);
  return lines;
}
