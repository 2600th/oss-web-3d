import { normalizeHud } from './hudData.js';
import { computeLayout } from './layout.js';
import { projectPoint, boxClamp, gunLead } from './projection.js';
import { worldToRadar, autoRange } from './radar.js';
import { RadioQueue, Callouts } from './radio.js';
import { resolveTheme, targetColor, isGround } from './theme.js';
import {
  rect, overlap, inside, instrumentKeepOut, panelKeepOut, pickPlateSlot,
  labelTier, mustLabel, sortForLabels, foldMarkers, placeLabels, leaderSlots, easeAlpha,
} from './declutter.js';
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
const _coaming = { x: 0, y: 0, w: 0, depth: 0, behind: false, onScreen: false };
// Top of the gunsight housing in MiG-21 model space (nose -Z, metres): in the
// cockpit view the pitch ladder is a collimated image above it, never drawn
// over the instrument panel.
const COAMING = [0, 0.1, -3.6];

const MUZZLE = 1050; // m/s, GSh-23 class

// feel: hit / kill / damage-direction marks (seconds, wall clock)
const HIT_TICK = 0.22;
const KILL_MARK = 0.75;
const DAMAGE_DIR = 1.4;

/** Stable key for a HUD target row: the combat entity when there is one. */
const keyOf = (t) => t?.entity ?? t;

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
    this.keyHint = { flares: 'G' };
    // declutter state (see declutter.js)
    this._dt = 0;
    this._instr = [];
    this._keep = [];
    this._bannerRect = null;
    this._radioGeo = null;
    this._radioRect = null;
    this._radioLift = 0; // 0 = usual slot, 1 = portrait top slot (over the objective line)
    this._radioHold = 0;
    this._labels = new Map(); // target key -> {a, slot, n}: label opacity and last slot
    // feel (see the event feed below)
    this._firing = new Map(); // entity -> time until which it counts as firing on us
    this._hits = new Map(); // entity -> age of the last player hit on it
    this._kills = []; // {p, age, color, ground}
    this._dmgDir = []; // {p, age, sev}
    this.flicker = 0;
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

  /**
   * Red edge flash. `sev` is 0..1 (see feel.js damageSeverity): a stray round
   * is a tint at the frame edge, a missile is a hard flash. Repeated hits
   * hold the flash up without stacking it into a red-out.
   */
  flashDamage(sev = 0.3) {
    const a = Math.min(1, 0.14 + 0.7 * Math.max(0, sev));
    this.damageFlash = Math.min(1, Math.max(this.damageFlash, a) + a * 0.15);
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

  /**
   * A hostile is shooting at us (gun burst, flak, a missile in the air) for
   * `seconds` more; Infinity until `ceaseFire`. Its marker and label are
   * never folded or dropped while this holds.
   */
  markFiring(entity, seconds = 2) {
    if (!entity) return;
    const until = this.time + seconds;
    if (!(this._firing.get(entity) > until)) this._firing.set(entity, until);
  }

  ceaseFire(entity, linger = 1.5) {
    if (entity && this._firing.has(entity)) this._firing.set(entity, this.time + linger);
  }

  isFiring(t) {
    return (this._firing.get(keyOf(t)) ?? -1) > this.time;
  }

  /** Player struck `target`: a hit tick on its marker. */
  hitMark(target) {
    if (target) this._hits.set(keyOf(target), 0);
  }

  /** Player destroyed something at `position`: a mark that opens and fades there. */
  killMark(position, target) {
    if (!position) return;
    const t = target ?? {};
    this._kills.push({ p: { x: position.x, y: position.y, z: position.z }, age: 0, color: targetColor(this.theme, t), ground: isGround(t) });
    if (this._kills.length > 4) this._kills.shift();
  }

  /**
   * We were hit from `position` (world; the shooter's live position when
   * known). `sev` 0..1. Drawn as a wedge on the threat ring pointing at the
   * source; a heavy hit also makes the HUD flicker for a moment.
   */
  damageFrom(position, sev = 0.5) {
    if (position) {
      this._dmgDir.push({ p: position, age: 0, sev });
      if (this._dmgDir.length > 4) this._dmgDir.shift();
    }
    if (sev > 0.45 && !this.reducedMotion) this.flicker = Math.max(this.flicker, 0.1 + 0.2 * sev);
  }

  clearTransient() {
    this.radio.clear();
    this.callouts.clear();
    this.banner = null;
    this.damageFlash = 0;
    this.threatLevel = null;
    this.lockFx = { state: 'none', since: 0, id: null };
    this._tracks.clear();
    this._labels.clear();
    this._firing.clear();
    this._hits.clear();
    this._kills.length = 0;
    this._dmgDir.length = 0;
    this.flicker = 0;
  }

  // ----------------------------------------------------------------- frame --

  update(dt, game) {
    this.time += dt;
    this._dt = dt;
    this.radio.update(dt);
    this.callouts.update(dt);
    this.damageFlash = Math.max(0, this.damageFlash - dt * 1.6);
    this.flicker = Math.max(0, this.flicker - dt);
    for (const [k, a] of this._hits) {
      if (a + dt > HIT_TICK) this._hits.delete(k);
      else this._hits.set(k, a + dt);
    }
    for (const k of this._kills) k.age += dt;
    while (this._kills.length && this._kills[0].age > KILL_MARK) this._kills.shift();
    for (const k of this._dmgDir) k.age += dt;
    while (this._dmgDir.length && this._dmgDir[0].age > DAMAGE_DIR) this._dmgDir.shift();
    for (const [e, until] of this._firing) if (until < this.time || e.alive === false) this._firing.delete(e);
    if (this.banner) {
      this.banner.age += dt;
      if (this.banner.age > this.banner.life) this.banner = null;
    }
    // Heavy hit: the HUD glass flickers for a moment (CSS opacity on the
    // canvas, so nothing in the draw path has to know).
    if (this.flicker > 0) {
      this.canvas.style.opacity = Math.random() < 0.55 ? '1' : '0.3';
      this._flickering = true;
    } else if (this._flickering) {
      this.canvas.style.opacity = '';
      this._flickering = false;
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

    // What target markers and labels must keep off this frame.
    this._radioGeo = this._measureRadio(L, s);
    this._bannerRect = this._bannerBox(L, s);
    this._instr = instrumentKeepOut(L, s);
    this._keep = [...this._instr, ...panelKeepOut(L, s)];
    if (this._bannerRect) this._keep.push(this._bannerRect);

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
    this._drawDamageDir(L, s);
    this._drawHeadingTape(d, L, s);
    this._drawSpeedTape(d, L, s);
    this._drawAltTape(d, L, s);
    this._drawRecon(d, L, s);
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

  /** Screen y of the cockpit coaming in the cockpit view, else null. */
  _coamingY(game) {
    const g = game.player?.group;
    if (!g || game.cameraRig?.view !== 'cockpit') return null;
    const e = g.matrixWorld.elements;
    const [x, y, z] = COAMING;
    this._project(
      e[0] * x + e[4] * y + e[8] * z + e[12],
      e[1] * x + e[5] * y + e[9] * z + e[13],
      e[2] * x + e[6] * y + e[10] * z + e[14], _coaming);
    return _coaming.behind ? null : _coaming.y;
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
    // Cut windows for the kill callout and the orders banner so a rung never
    // strikes through their text (on a landscape phone the banner sits over
    // the bottom of the ladder).
    let wins = 0;
    if (this.callouts.items.length) {
      ctx.rect(L.callout.x - 112 * s, L.callout.y - 24 * s, 224 * s, 66 * s);
      wins++;
    }
    const br = this._bannerRect;
    if (br && !(wins && br.y0 < L.callout.y + 42 * s && br.y1 > L.callout.y - 24 * s)) {
      ctx.rect(br.x0, br.y0, br.x1 - br.x0, br.y1 - br.y0);
      wins++;
    }
    if (wins) ctx.clip('evenodd');
    else ctx.clip();
    const yCut = this._coamingY(game);
    if (yCut !== null) { ctx.beginPath(); ctx.rect(0, 0, this.layout.w, yCut); ctx.clip(); }

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
    const lt = lk.target;
    // Gameplay hands over the combat entity; prefer its `targets[]` entry
    // (it carries isAce / isTarget / class for colour and shape).
    for (const t of d.targets) if (t === lt || t.entity === lt || (t.id != null && t.id === lt)) return t;
    return lt.position ? lt : null;
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
      const isLock = !!lockT && (lockT === t || (lockT.id != null && lockT.id === t.id));
      const firing = this.isFiring(t);
      const key = keyOf(t);
      const hitAge = this._hits.get(key);
      this._project(p.x, p.y, p.z, _p, 6);
      // On touch, a marker under a button is as good as off-screen: hand it
      // to the edge arrows, which stay clear of the thumbs.
      const hidden = _p.onScreen && this._occluded(_p.x, _p.y, 18 * s);
      const o = { t, key, dist, color, isLock, firing, x: _p.x, y: _p.y, hit: hitAge };
      if (_p.onScreen && !hidden) on.push(o);
      else off.push(o);
    }
    // Rank: lock, firing on us, selected, lead, priority, then nearest (see
    // declutter.js). A dug-in position is a dozen entities within a few
    // hundred metres: markers closer than `merge` px fold into the most
    // important one, which carries a "+n" -- except the lock, the selected
    // target and anything shooting at us, which never fold and never host.
    const instr = this._instr;
    for (const o of on) {
      o.selected = !!o.t.selected;
      o.keep = o.isLock || o.firing || o.selected;
      // a marker whose centre lands on a flight instrument (a ridge on the
      // horizon right under the altitude box) shrinks to a pip and writes no text
      o.pip = !o.keep && instr.some((r) => inside(o.x, o.y, r));
      o.tier = labelTier({ isLock: o.isLock, firing: o.firing, selected: o.selected, isAce: o.t.isAce, isTarget: o.t.isTarget });
      o.had = this._labels.has(o.key);
    }
    sortForLabels(on);
    const merge = 30 * s;
    const shown = foldMarkers(on, merge, (o) => (o.pip ? merge * 1.6 : merge));
    for (const o of shown) {
      o.m = markerSize(o.dist, s);
      // label margin: text keeps outside the firing ring
      o.lm = o.firing ? o.m * 1.5 + 6 * s : o.m;
    }
    this._placeRadio(L, s, shown);

    // What labels must keep off: instruments, panels, the radio plate, touch
    // buttons, the lock reticle (the target box stays readable), every marker.
    const obstacles = this._keep.slice();
    if (this.radio.current && this.radio.alpha > 0.05 && this._radioRect) obstacles.push(this._radioRect);
    if (this.touch) for (const r of this.occluders ?? []) obstacles.push(rect(r.x, r.y, r.x + r.w, r.y + r.h));
    const lockBox = lockT && lockState !== 'none' ? this._lockBox(d, lockT, s) : null;
    if (lockBox) obstacles.push(lockBox);
    for (const o of shown) {
      const k = o.pip ? 4 * s : o.lm;
      const crest = !o.pip && (o.t.isAce || o.t.isTarget) ? 13 * s : 0; // chevron above the shape
      o.box = rect(o.x - k, o.y - k - crest, o.x + k, o.y + k);
      obstacles.push(o.box);
    }
    const bounds = rect(L.bounds.L - 8, L.bounds.T - 8, L.bounds.R + 8, L.bounds.B + 8);

    // Shapes first: every marker is drawn, labelled or not.
    for (const o of shown) {
      if (o.pip) {
        this._drawPip(o, s);
        continue;
      }
      // the selected (next-to-lock) target draws heavy, like the lock
      this._drawMarker(o.t, o.x, o.y, o.dist, o.color, s, o.isLock || o.selected, o.isLock ? lockState : 'none', null, o.m);
      if (o.firing) this._drawFiringRing(o, s);
    }

    // Labels: rank order, rationed. Ordinary labels share a small budget and
    // drop out when no slot is clear; lock / firing / selected always place.
    // A label repeating the name of a better-ranked neighbour (five TRUCKs in
    // a column) shows only its range.
    const items = [];
    const labelled = [];
    for (const o of shown) {
      if (o.pip) continue;
      const name = o.t.name ?? '';
      const near = (h) => h.t.name === name && h.color === o.color && Math.abs(h.x - o.x) < 180 * s && Math.abs(h.y - o.y) < 90 * s;
      const twins = o.tier <= 1 && !!name ? labelled.filter(near) : [];
      // ...and says nothing at all when its range reads the same as one of theirs
      const range = formatRange(o.dist);
      if (twins.length && !o.keep && !o.extra && twins.some((h) => formatRange(h.dist) === range)) continue;
      const cands = this._labelSlots(o, L, s, twins.length > 0);
      const mem = this._labels.get(o.key);
      items.push({ must: mustLabel(o), cands: cands.map((c) => c.boxes), prev: mem && mem.n === cands.length ? mem.slot : -1, self: o.box });
      o.cands = cands;
      labelled.push(o);
    }
    const picks = placeLabels(items, obstacles, bounds, { budget: L.touch ? 2 : 3 });
    const base = this.settings.hudOpacity ?? 1;
    const seen = new Set();
    for (let i = 0; i < labelled.length; i++) {
      const o = labelled[i];
      const pick = picks[i];
      if (pick < 0) {
        if (o.extra) this._drawExtra(o, s, null);
        continue;
      }
      seen.add(o.key);
      let mem = this._labels.get(o.key);
      if (!mem) this._labels.set(o.key, (mem = { a: o.had ? 1 : 0, slot: pick, n: o.cands.length }));
      // off-priority labels sit back a little; a label fades up rather than popping in
      const target = o.tier >= 1 || o.keep ? 1 : 0.72;
      mem.a = this.reducedMotion ? target : easeAlpha(mem.a, target, this._dt);
      mem.slot = pick;
      mem.n = o.cands.length;
      this.ctx.globalAlpha = base * mem.a;
      this._drawMarkerLabels(o, s, o.cands[pick], o.isLock ? lockState : 'none');
      this.ctx.globalAlpha = base;
    }
    for (const k of this._labels.keys()) if (!seen.has(k)) this._labels.delete(k);

    // Hit confirmation on the struck marker (folded markers pass it to their host).
    for (const o of shown) if (o.hit != null && !o.pip) this._drawHitTick(o, s);
    this._drawKillMarks(s);

    // Off-screen arrows: firing first, then priority, then nearest; capped.
    off.sort((a, b) => rankOff(b) - rankOff(a) || a.dist - b.dist);
    const cap = L.touch ? 6 : 9;
    const drawn = [];
    for (let i = 0; i < off.length && drawn.length < cap; i++) this._drawEdgeArrow(off[i], L, s, drawn);
    // Arrow text once every arrow has its count: "range +n" inward of the
    // arrow, stepped further in if a better-ranked arrow's text is there,
    // dropped (the arrow stays) if both places are taken.
    const ctx = this.ctx;
    ctx.font = `400 ${10 * s}px ${FONT_SANS}`;
    const taken = [];
    for (const h of drawn) {
      const txt = h.extra ? `${h.range} +${h.extra}` : h.range;
      const w = ctx.measureText(txt).width / 2 + 2 * s;
      const ca = Math.cos(h.angle);
      const sa = Math.sin(h.angle);
      for (const back of [20, 34, 48]) {
        const tx = h.x - ca * back * s;
        const ty = h.y - sa * back * s;
        const r = rect(tx - w, ty - 7 * s, tx + w, ty + 7 * s);
        if (taken.some((q) => overlap(q, r) > 0)) continue;
        taken.push(r);
        this._text(txt, tx, ty, h.color, 10 * s);
        break;
      }
    }
    // Lock reticle draws over everything else
    if (lockT && lockState !== 'none') this._drawLock(d, lockT, L, s);
    this._drawGunPipper(d, game, L, s, lockT);
  }

  /** Screen rect the lock reticle (box, ticks and LOCK / ACQ plate) covers, or null. */
  _lockBox(d, t, s) {
    const p = t.position;
    if (!p) return null;
    this._project(p.x, p.y, p.z, _q);
    if (_q.behind) return null;
    const state = d.lock.state;
    const prog = Math.min(1, Math.max(0, d.lock.progress ?? 1));
    const r = (state === 'acquiring' ? 46 - 26 * prog : 24) * s;
    const box = rect(_q.x - r - 7 * s, _q.y - r - 7 * s, _q.x + r + 7 * s, _q.y + r + 27 * s);
    box.w = 2;
    return box;
  }

  /** A hostile that is shooting at us: a ring in the warning colour that pulses. */
  _drawFiringRing(o, s) {
    const ctx = this.ctx;
    const on = this.blink(3, 0.7);
    ctx.beginPath();
    ctx.arc(o.x, o.y, o.m * 1.5 + 4 * s, 0, Math.PI * 2);
    this._stroke(this.theme.warning, on ? 1.8 : 1.1);
  }

  /** Hit tick: four short diagonal strokes around a marker the player just struck. */
  _drawHitTick(o, s) {
    const age = o.hit;
    if (!(age >= 0 && age < HIT_TICK)) return;
    const ctx = this.ctx;
    const k = 1 - age / HIT_TICK;
    const pop = this.reducedMotion ? 1 : 1 + 0.35 * k;
    const r0 = (o.m + 3 * s) * pop;
    const r1 = r0 + 8 * s;
    ctx.beginPath();
    for (const [sx, sy] of CORNERS) {
      ctx.moveTo(o.x + sx * r0 * 0.707, o.y + sy * r0 * 0.707);
      ctx.lineTo(o.x + sx * r1 * 0.707, o.y + sy * r1 * 0.707);
    }
    ctx.globalAlpha = (this.settings.hudOpacity ?? 1) * Math.min(1, k * 1.6);
    this._stroke(this.theme.ink, 2.2);
    ctx.globalAlpha = this.settings.hudOpacity ?? 1;
  }

  /** Kill confirmation where the target died: an X and a ring that opens and fades. */
  _drawKillMarks(s) {
    if (!this._kills.length) return;
    const ctx = this.ctx;
    const base = this.settings.hudOpacity ?? 1;
    for (const k of this._kills) {
      this._project(k.p.x, k.p.y, k.p.z, _q);
      if (!_q.onScreen) continue;
      const u = Math.min(1, k.age / KILL_MARK);
      const e = easeOut(u);
      const r = (10 + 26 * (this.reducedMotion ? 0.5 : e)) * s;
      ctx.globalAlpha = base * (1 - u);
      ctx.beginPath();
      if (k.ground) {
        ctx.moveTo(_q.x, _q.y - r);
        ctx.lineTo(_q.x + r, _q.y);
        ctx.lineTo(_q.x, _q.y + r);
        ctx.lineTo(_q.x - r, _q.y);
        ctx.closePath();
      } else ctx.arc(_q.x, _q.y, r, 0, Math.PI * 2);
      this._stroke(k.color, 2);
      const x = 9 * s;
      ctx.beginPath();
      ctx.moveTo(_q.x - x, _q.y - x);
      ctx.lineTo(_q.x + x, _q.y + x);
      ctx.moveTo(_q.x + x, _q.y - x);
      ctx.lineTo(_q.x - x, _q.y + x);
      this._stroke(k.color, 2.4);
    }
    ctx.globalAlpha = base;
  }

  _occluded(x, y, pad) {
    const list = this.occluders;
    if (!this.touch || !list?.length) return false;
    for (const r of list) {
      if (x > r.x - pad && x < r.x + r.w + pad && y > r.y - pad && y < r.y + r.h + pad) return true;
    }
    return false;
  }

  _drawMarker(t, x, y, dist, color, s, isLock, lockState, slot = 'stack', size = 0) {
    const ctx = this.ctx;
    const m = size || markerSize(dist, s);
    const ground = isGround(t);
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
    if (slot === 'stack') {
      const o = { t, x, y, dist, color, m, isLock, extra: 0 };
      this._drawMarkerLabels(o, s, this._labelSlots(o, this.layout, s)[0], lockState);
    }
  }

  /**
   * Candidate label layouts for a marker, best first: name above / range
   * below (the default), then name + range stacked beside the marker on the
   * side away from the screen centre, then the other side, then the block
   * out on a short leader line (eight directions, two reaches). Each carries
   * the boxes it would cover so the placer can test it. `noName` drops the
   * name (a neighbour of the same kind already says it).
   */
  _labelSlots(o, L, s, noName = false) {
    const ctx = this.ctx;
    const { t, x, y } = o;
    const m = o.lm ?? o.m;
    const nameSize = (t.isAce ? 12 : 11) * s;
    const name = !noName && t.name ? (t.isAce ? t.name.toUpperCase() : t.name) : '';
    ctx.font = `${t.isAce ? 700 : 400} ${nameSize}px ${FONT_SANS}`;
    const nw = name ? ctx.measureText(name).width : 0;
    const range = formatRange(o.dist);
    ctx.font = `400 ${11 * s}px ${FONT_SANS}`;
    const rw = ctx.measureText(range).width;
    ctx.font = `700 ${10 * s}px ${FONT_SANS}`;
    const xw = o.extra ? ctx.measureText(`+${o.extra}`).width : 0;
    const tw = t.isTarget ? ctx.measureText('TGT').width : 0;
    const pad = 2 * s;
    // stack (name above the crest, range under the shape)
    const nameY = y - m - (t.isAce ? 22 : t.isTarget ? 20 : 9) * s;
    const rangeY = y + m + 11 * s;
    const stack = { mode: 'stack', name, range, nameY, rangeY, boxes: [] };
    if (name) stack.boxes.push(rect(x - nw / 2 - pad, nameY - nameSize * 1.1, x + nw / 2 + pad, nameY + pad));
    stack.boxes.push(rect(x - rw / 2 - pad, rangeY - pad, x + rw / 2 + pad, rangeY + 12 * s));
    if (tw) stack.boxes.push(rect(x + m + 3 * s, y - 6 * s, x + m + 5 * s + tw, y + 6 * s));
    if (xw) stack.boxes.push(rect(x - 16 * s - xw, y + 9 * s, x - 14 * s, y + 21 * s));
    // beside: name over range, TGT dropped (the crest chevron still says it),
    // the "+n" count trailing the range on the same side
    const w = Math.max(nw, rw + (xw ? xw + 6 * s : 0));
    const side = (dir) => {
      const x0 = x + dir * (m + 6 * s);
      const c = { mode: dir > 0 ? 'right' : 'left', dir, x0, name, range, rw, boxes: [] };
      const ny = name ? y - 7 * s : y;
      c.nameY = ny;
      c.rangeY = name ? y + 7 * s : y;
      c.boxes.push(rect(x0 - dir * pad, (name ? ny : y) - 7 * s, x0 + dir * (w + pad), c.rangeY + 7 * s));
      return c;
    };
    const out = side(x >= (L?.cx ?? x) ? 1 : -1);
    const cands = [stack];
    // the same without the TGT tag, before moving the text off-axis
    if (tw) cands.push({ ...stack, noTag: true, boxes: stack.boxes.filter((_, i) => i !== stack.boxes.length - (xw ? 2 : 1)) });
    cands.push(out, side(-out.dir));
    // leader line: the block (name over range) pulled clear of a crowd
    const h = (name ? nameSize * 1.15 : 0) + 13 * s;
    for (const ls of leaderSlots(x, y, m + (t.isAce || t.isTarget ? 6 * s : 0), w + 2 * pad, h + 2 * pad, [16 * s, 40 * s])) {
      cands.push({ mode: 'leader', name, range, rw, ...ls, boxes: [ls.box] });
    }
    return cands;
  }

  _drawMarkerLabels(o, s, slot, lockState) {
    const ctx = this.ctx;
    const { t, x, y, color } = o;
    const m = o.lm ?? o.m;
    const nameSize = (t.isAce ? 12 : 11) * s;
    const nameOpts = { font: FONT_SANS, weight: t.isAce ? 700 : 400 };
    if (slot.mode === 'stack') {
      if (slot.name) this._text(slot.name, x, slot.nameY, color, nameSize, { ...nameOpts, baseline: 'bottom' });
      this._text(slot.range, x, slot.rangeY, color, 11 * s, { baseline: 'top' });
      if (t.isTarget && !slot.noTag) this._text('TGT', x + m + 4 * s, y, color, 10 * s, { align: 'left', weight: 700 });
      if (o.extra) this._drawExtra(o, s, null);
      if (t.lockable && !o.isLock && lockState === 'none' && o.dist < 4000 && !isGround(t)) {
        // small "in envelope" dot under the range
        ctx.beginPath();
        ctx.arc(x, slot.rangeY + 16 * s, 1.8 * s, 0, Math.PI * 2);
        this._fillHalo(color);
      }
      return;
    }
    if (slot.mode === 'leader') {
      const b = slot.box;
      ctx.beginPath();
      ctx.moveTo(slot.ax, slot.ay);
      ctx.lineTo(slot.lx, slot.ly);
      this._stroke(color, 1);
      const pad = 2 * s;
      const tx = slot.align === 'left' ? b.x0 + pad : slot.align === 'right' ? b.x1 - pad : (b.x0 + b.x1) / 2;
      let ty = b.y0 + pad;
      if (slot.name) {
        this._text(slot.name, tx, ty, color, nameSize, { ...nameOpts, align: slot.align, baseline: 'top' });
        ty += nameSize * 1.15;
      }
      const rangeTxt = o.extra ? `${slot.range}  +${o.extra}` : slot.range;
      this._text(rangeTxt, tx, ty, color, 11 * s, { align: slot.align, baseline: 'top' });
      return;
    }
    const align = slot.dir > 0 ? 'left' : 'right';
    if (slot.name) this._text(slot.name, slot.x0, slot.nameY, color, nameSize, { ...nameOpts, align });
    this._text(slot.range, slot.x0, slot.rangeY, color, 11 * s, { align });
    if (o.extra) this._drawExtra(o, s, slot);
  }

  /** "+n" count for markers folded into this one. */
  _drawExtra(o, s, slot) {
    if (!o.extra) return;
    if (slot && slot.mode !== 'stack') {
      const dir = slot.dir;
      this._text(`+${o.extra}`, slot.x0 + dir * (slot.rw + 6 * s), slot.rangeY, o.color, 10 * s, { align: dir > 0 ? 'left' : 'right', weight: 700 });
    } else {
      this._text(`+${o.extra}`, o.x - 15 * s, o.y + 15 * s, o.color, 10 * s, { align: 'right', weight: 700 });
    }
  }

  /** A marker sitting on an instrument: a small filled pip, no text. */
  _drawPip(o, s) {
    const ctx = this.ctx;
    const r = 3.6 * s;
    ctx.beginPath();
    if (isGround(o.t)) {
      ctx.moveTo(o.x, o.y - r);
      ctx.lineTo(o.x + r, o.y);
      ctx.lineTo(o.x, o.y + r);
      ctx.lineTo(o.x - r, o.y);
      ctx.closePath();
    } else {
      ctx.rect(o.x - r * 0.8, o.y - r * 0.8, r * 1.6, r * 1.6);
    }
    this._fillHalo(o.color);
  }

  _drawEdgeArrow(o, L, s, drawn = null) {
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
    // Arrows that land on top of one another (a whole position below or
    // behind) fold into the first, more important one, which counts them.
    const near = 34 * s;
    const host = drawn?.find((h) => Math.abs(h.x - _e.x) < near && Math.abs(h.y - _e.y) < near);
    if (host) {
      host.extra++;
      return;
    }
    // a hostile shooting at us points in the warning colour, filled
    const color = o.firing ? this.theme.warning : o.color;
    drawn?.push({ x: _e.x, y: _e.y, angle: _e.angle, color, extra: 0, range: formatRange(o.dist) });
    const big = o.t.isTarget || o.t.isAce || o.firing;
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
    if (big) this._fillHalo(color);
    else this._stroke(color, 1.6);
    // range text is drawn by the caller once every arrow is placed
  }

  _drawLock(d, t, L, s) {
    const ctx = this.ctx;
    const th = this.theme;
    const p = t.position;
    this._project(p.x, p.y, p.z, _q);
    // under a thumb button the edge arrow stands in for the reticle
    if (_q.behind || this._occluded(_q.x, _q.y, 18 * s)) return;
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
    let t = lockT && !isGround(lockT) ? lockT : null;
    let best = 1600;
    if (!t) {
      for (const c of d.targets) {
        if (c.alive === false || !c.position || isGround(c) || c.team === 'friendly') continue;
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
    // Gameplay's own aim point (gun.lead) wins: it knows the real ballistics.
    const lead = d.gun?.lead;
    if (!t && !lead) return;
    const p = t?.position ?? lead;
    const dist = Math.hypot(p.x - f.position.x, p.y - f.position.y, p.z - f.position.z);
    if (dist > 1600 || (!gunActive && dist > 1200)) return;
    if (lead) {
      _lead.x = lead.x;
      _lead.y = lead.y;
      _lead.z = lead.z;
    } else {
      const tr = this._tracks.get(t.id);
      const tv = t.velocity ?? t.entity?.velocity ?? (tr ? { x: tr.vx, y: tr.vy, z: tr.vz } : null);
      gunLead(f.position, f.velocity, p, tv, MUZZLE, _lead);
    }
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

  /**
   * Where the last hits came from: a solid wedge just inside the threat ring,
   * pointing at the shooter (its live position) or the hit point, fading out.
   * The missile arcs are outlined and pulse; these are filled and do not.
   */
  _drawDamageDir(L, s) {
    if (!this._dmgDir.length) return;
    const ctx = this.ctx;
    const base = this.settings.hudOpacity ?? 1;
    const R = Math.min(L.ladderR * 0.92, L.tapeH * 0.55) - 16 * s;
    const cx = L.cx;
    const cy = L.cy;
    for (const h of this._dmgDir) {
      this._project(h.p.x, h.p.y, h.p.z, _q);
      // a source straight ahead and on screen still gets a direction: from centre
      const ang = Math.atan2(_q.y - cy, _q.x - cx);
      const k = 1 - h.age / DAMAGE_DIR;
      const w = 0.16 + 0.12 * h.sev;
      const t = (5 + 6 * h.sev) * s;
      ctx.globalAlpha = base * Math.min(1, k * 1.5) * (0.55 + 0.45 * h.sev);
      ctx.fillStyle = this.theme.warning;
      ctx.strokeStyle = this.theme.halo;
      ctx.lineWidth = 2;
      // band on the ring with a short point outward, toward the shooter
      ctx.beginPath();
      ctx.arc(cx, cy, R - t / 2, ang - w, ang + w);
      ctx.arc(cx, cy, R + t / 2, ang + w, ang + w * 0.35, true);
      ctx.lineTo(cx + Math.cos(ang) * (R + t * 1.7), cy + Math.sin(ang) * (R + t * 1.7));
      ctx.arc(cx, cy, R + t / 2, ang - w * 0.35, ang - w, true);
      ctx.closePath();
      ctx.stroke();
      ctx.fill();
    }
    ctx.globalAlpha = base;
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
    // a hostile radar has us locked but nothing is in the air yet
    if (d.lockWarning && !items.some((i) => i[0].startsWith('MISSILE'))) items.push(['RADAR LOCK', th.caution, 2]);
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

  /**
   * Recon optic (gameplay's `recon`, held on the optic key): a framing gate
   * that tightens as quality rises, a focus box on the post being framed and
   * a hold bar that fills while the frame is good enough to keep.
   */
  _drawRecon(d, L, s) {
    const r = d.recon;
    if (!r) return;
    const th = this.theme;
    const ctx = this.ctx;
    const tally = `${r.captured ?? 0}/${r.total ?? 0}`;
    if (!r.active) {
      // a quiet reminder while the optic is stowed
      this._text(`RECON  ${tally}`, L.cx, L.cy + L.tapeH * 0.5 + 20 * s, th.dim, 11 * s, { weight: 700 });
      return;
    }
    const q = Math.max(0, Math.min(1, r.quality ?? 0));
    const good = q >= 0.42; // recon.js OPTIC.threshold
    const col = good ? th.good : th.ink;
    const gw = Math.min(L.fieldW * 0.34, 300 * s) * (1 - 0.25 * q);
    const gh = gw * 0.62;
    const c = 22 * s;
    ctx.beginPath();
    for (const [sx, sy] of CORNERS) {
      const x = L.cx + sx * gw;
      const y = L.cy + sy * gh;
      ctx.moveTo(x, y - sy * c);
      ctx.lineTo(x, y);
      ctx.lineTo(x - sx * c, y);
    }
    this._stroke(col, 2);
    // centre cross
    ctx.beginPath();
    ctx.moveTo(L.cx - 10 * s, L.cy);
    ctx.lineTo(L.cx + 10 * s, L.cy);
    ctx.moveTo(L.cx, L.cy - 10 * s);
    ctx.lineTo(L.cx, L.cy + 10 * s);
    this._stroke(th.dim, 1.2);
    // focus box on the framed post
    const f = r.focus?.position;
    if (f) {
      this._project(f.x, f.y, f.z, _q);
      if (!_q.behind) {
        const b = 16 * s;
        ctx.beginPath();
        ctx.rect(_q.x - b, _q.y - b, b * 2, b * 2);
        this._stroke(col, good ? 2.2 : 1.4);
      }
    }
    // labels + hold bar under the gate
    const y0 = L.cy + gh + 18 * s;
    this._text(`RECON  ${tally}`, L.cx - gw, L.cy - gh - 12 * s, col, 12 * s, { align: 'left', weight: 700 });
    this._text(good ? 'HOLD' : q > 0 ? 'FRAME IT' : 'NO SUBJECT', L.cx + gw, L.cy - gh - 12 * s, col, 12 * s, { align: 'right', weight: 700 });
    const bw = gw * 2;
    ctx.fillStyle = th.faint;
    ctx.fillRect(L.cx - gw, y0, bw, 4 * s);
    ctx.fillStyle = col;
    ctx.fillRect(L.cx - gw, y0, bw * Math.max(0, Math.min(1, r.progress ?? 0)), 4 * s);
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
    // In portrait the new-orders banner takes this line's place outright, and
    // so does a radio line that has moved up off the targets (_placeRadio).
    if (L.portrait && (this.banner || this._radioLift > 0.5)) return;
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
    // the other pylon (missiles while the special is up, and vice versa)
    for (const k of cur === 'gun' ? ['msl', 'sp'] : [cur === 'sp' ? 'msl' : 'sp']) {
      const o = d.weapons?.[k];
      if (o) rows.push({ label: o.short ?? o.name ?? k.toUpperCase(), value: formatAmmo(o.ammo) });
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
      if (t.isTarget || !isGround(t)) dists.push(Math.hypot(t.position.x - me.x, t.position.z - me.z));
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
      if (isGround(t)) {
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
    const wipe = this.reducedMotion ? 1 : easeOut(Math.min(1, t / 0.35));
    const box = this._bannerRect ?? this._bannerBox(L, s);
    const y = box.y0;
    const w = (box.x1 - box.x0) * wipe;
    ctx.globalAlpha = a * (this.settings.hudOpacity ?? 1);
    // near-opaque where it sits over the flight field (portrait: objective
    // line; landscape phone: low between the tapes, over ground markers)
    ctx.fillStyle = L.portrait ? 'rgba(4,10,14,0.97)' : L.touch ? 'rgba(4,10,14,0.86)' : 'rgba(4,10,14,0.66)';
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

  /** Banner plate rect, or null. */
  _bannerBox(L, s) {
    if (!this.banner) return null;
    // full width in portrait, where it stands in for the objective line
    const full = L.portrait ? L.bounds.R - L.bounds.L : Math.min(L.w - 40, 460 * s);
    let y = L.bannerY;
    // landscape phone: the banner sits low between the tapes; a long radio
    // line under it pushes it up rather than the two plates stacking
    const g = this._radioGeo;
    if (L.touch && !L.portrait && g) y = Math.min(y, L.radio.y - g.H - 56 * s);
    return rect(L.cx - full / 2, y, L.cx + full / 2, y + 52 * s);
  }

  /** Wrap and measure the current radio line once per message. */
  _measureRadio(L, s) {
    const c = this.radio.current;
    if (!c || this.settings.subtitles === false) return null;
    const scale = { small: 0.88, medium: 1, large: 1.25 }[this.settings.subtitleSize] ?? 1;
    const fs = Math.max(13, 15 * s * scale);
    const call = c.callsign ? c.callsign.toUpperCase() : '';
    const key = `${c.text}|${call}|${L.radio.maxW}|${fs}`;
    if (this._radioCache?.key === key) return this._radioCache;
    const ctx = this.ctx;
    const font = `400 ${fs}px ${FONT_SANS}`;
    ctx.font = `700 ${fs}px ${FONT_SANS}`;
    const cw = call ? ctx.measureText(call).width + 12 * s : 0;
    const lines = wrapText(ctx, c.text, L.radio.maxW - cw - 24 * s, font);
    ctx.font = font;
    let tw = 0;
    for (const ln of lines) tw = Math.max(tw, ctx.measureText(ln).width);
    const lh = fs * 1.35;
    this._radioCache = { key, call, cw, lines, fs, lh, W: cw + tw + 24 * s, H: lines.length * lh + 14 * s };
    return this._radioCache;
  }

  /** Radio plate rect at `lift` (0 = layout slot, 1 = portrait top slot). */
  _radioRectAt(L, g, lift) {
    let y = L.radio.y;
    if (lift > 0 && L.touch && L.portrait) {
      const hi = L.objective.y - 6 * L.s + g.H;
      const k = lift * lift * (3 - 2 * lift);
      y += (hi - y) * k;
    }
    return rect(L.radio.x - g.W / 2, y - g.H, L.radio.x + g.W / 2, y);
  }

  /**
   * Phone portrait: the subtitle plate sits over the ground ahead, which is
   * where ground targets are. When it would cover a marker it slides up over
   * the objective line (as the orders banner does) and comes back once the
   * low slot has been clear for a moment.
   */
  _placeRadio(L, s, shown) {
    const g = this._radioGeo;
    const dt = Math.min(0.1, this._dt || 0.016);
    let want = 0;
    if (g && L.touch && L.portrait && !this.banner && this.radio.alpha > 0) {
      const marks = shown.map((o) => rect(o.x - o.m - 6 * s, o.y - o.m - 20 * s, o.x + o.m + 6 * s, o.y + o.m + 24 * s));
      want = pickPlateSlot([this._radioRectAt(L, g, 0), this._radioRectAt(L, g, 1)], marks);
      this._radioHold = want === 1 ? 1.5 : Math.max(0, this._radioHold - dt);
      if (this._radioHold > 0) want = 1;
    } else {
      this._radioHold = 0;
    }
    const step = this.reducedMotion ? 1 : dt / 0.3;
    this._radioLift += Math.max(-step, Math.min(step, want - this._radioLift));
    this._radioRect = g ? this._radioRectAt(L, g, this._radioLift) : null;
  }

  _drawRadio(L, s) {
    const g = this._radioGeo ?? this._measureRadio(L, s);
    if (!g) return;
    const a = this.radio.alpha;
    if (a <= 0) return;
    const ctx = this.ctx;
    const th = this.theme;
    const { call, cw, lines, fs, lh, W, H } = g;
    const r = this._radioRectAt(L, g, this._radioLift);
    const x0 = r.x0;
    const y0 = r.y0;
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

/** Marker half-size: grows as the target closes inside 6 km. */
function markerSize(dist, s) {
  return (11 + Math.max(0, 1 - dist / 6000) * 5) * s;
}

function rankOff(o) {
  return (o.firing ? 8 : 0) + (o.t.isAce ? 2 : 0) + (o.t.isTarget ? 1 : 0);
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
