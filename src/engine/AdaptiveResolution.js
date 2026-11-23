/**
 * Adaptive resolution: drives `Renderer.renderScale` from the measured GPU
 * frame time so the frame stays inside a budget on slower GPUs, and returns
 * to full resolution when there is headroom.
 *
 * Input, in order of preference:
 *  - GPU time per frame from timestamp queries (GpuProfiler, WebGPU and WebGL2
 *    with EXT_disjoint_timer_query), the real cost of the frame;
 *  - otherwise the frame interval (rAF delta), which only tells us we missed
 *    vsync — used with wide hysteresis so it never oscillates at the refresh cap.
 *
 * Behaviour: decide at most every `interval` seconds on the median of the
 * samples since the last decision; drop fast (proportional to the overshoot,
 * pixels scale with scale^2), climb slowly (one step), and never change while
 * the tab has just resumed or the window is resizing (a resize re-allocates
 * every render target anyway).
 *
 * The pure step function `nextScale` is unit-tested (adaptive.test.mjs).
 */

export const ADAPTIVE_DEFAULTS = {
  budgetMs: 13.5, // GPU ms per frame: 60 fps with ~20 % left for the compositor / CPU-GPU overlap
  minScale: 0.6,
  maxScale: 1,
  step: 0.05,
  interval: 1.0, // seconds between decisions
  upHeadroom: 0.72, // climb only if GPU time at the *next* scale would stay under this fraction of budget
  frameBudgetMs: 1000 / 50, // fallback (no timestamps): frame interval that counts as "too slow"
};

/**
 * One controller decision. `ms` is the measured GPU (or frame) time at `scale`.
 * GPU cost is modelled as fixed + per-pixel; with no better knowledge we take
 * the conservative "all per-pixel" model when climbing (cost ~ scale^2).
 */
export function nextScale(scale, ms, o = ADAPTIVE_DEFAULTS) {
  if (!(ms > 0) || !Number.isFinite(ms)) return scale;
  const q = (s) => +(Math.round(s / o.step) * o.step).toFixed(3);
  if (ms > o.budgetMs) {
    // pixels needed to fit the budget, with 10 % margin; at least one step down
    const target = scale * Math.sqrt((o.budgetMs * 0.9) / ms);
    return Math.max(o.minScale, Math.min(q(target), q(scale - o.step)));
  }
  const up = Math.min(o.maxScale, q(scale + o.step));
  if (up > scale && ms * (up * up) / (scale * scale) < o.budgetMs * o.upHeadroom) return up;
  return scale;
}

export class AdaptiveResolution {
  /**
   * @param r         engine Renderer (setRenderScale)
   * @param profiler  GpuProfiler or null
   * @param opts      ADAPTIVE_DEFAULTS overrides; `enabled`
   */
  constructor(r, profiler, opts = {}) {
    this.r = r;
    this.profiler = profiler;
    this.o = { ...ADAPTIVE_DEFAULTS, ...opts };
    this.enabled = opts.enabled ?? true;
    this.scale = r.renderScale ?? 1;
    this.source = profiler?.available ? 'gpu' : 'frame';
    this._samples = [];
    this._t = 0;
    this._hold = 1; // seconds to ignore after start / resume / resize
    this._lastFrame = 0;
    this._lastGpuFrames = 0;
    this.history = []; // [{t, scale, ms}] last decisions, for the HUD
    const hold = () => { this._hold = Math.max(this._hold, 1); this._samples.length = 0; };
    this._onVis = hold;
    this._onResize = hold;
    globalThis.document?.addEventListener?.('visibilitychange', this._onVis);
    globalThis.addEventListener?.('resize', this._onResize);
  }

  setEnabled(on) {
    this.enabled = !!on;
    this._samples.length = 0;
    if (!on && this.scale !== 1) this._apply(1);
  }

  setBudget(ms) { this.o.budgetMs = ms; }

  _apply(s) {
    this.scale = s;
    this.r.setRenderScale(s);
    this._hold = 0.5; // let the new targets settle before measuring
    this._samples.length = 0;
  }

  /** Call once per frame with the real frame delta (seconds). */
  update(dt) {
    if (!this.enabled) return;
    if (dt > 0.25) { this._hold = Math.max(this._hold, 1); return; } // resumed / hitch
    if (this._hold > 0) { this._hold -= dt; this._samples.length = 0; return; }
    let ms = NaN;
    if (this.source === 'gpu') {
      const p = this.profiler;
      const last = p.lastTotal;
      if (p.sampleCount !== this._lastGpuFrames && Number.isFinite(last)) {
        this._lastGpuFrames = p.sampleCount;
        ms = last;
      }
    } else {
      ms = dt * 1000;
    }
    if (Number.isFinite(ms)) this._samples.push(ms);
    this._t += dt;
    if (this._lastDrop !== undefined) this._lastDrop += dt;
    if (this._t < this.o.interval || this._samples.length < 8) return;
    this._t = 0;
    const a = this._samples.sort((x, y) => x - y);
    const med = a[a.length >> 1];
    this._samples.length = 0;
    let next;
    if (this.source === 'gpu') next = nextScale(this.scale, med, this.o);
    else {
      // Frame interval: it saturates at the refresh rate, so it can only say
      // "missed the budget" (drop) or "inside it" (climb one step, but not
      // within 8 s of the last drop, so we do not oscillate at the boundary).
      const fb = this.o.frameBudgetMs;
      if (med > fb) { next = nextScale(this.scale, med, { ...this.o, budgetMs: fb }); this._lastDrop = 0; }
      else if (med < fb * 0.9 && (this._lastDrop ?? 99) > 8) next = Math.min(this.o.maxScale, +(Math.round((this.scale + this.o.step) / this.o.step) * this.o.step).toFixed(3));
      else next = this.scale;
    }
    this.history.push({ scale: next, ms: +med.toFixed(2) });
    if (this.history.length > 20) this.history.shift();
    if (next !== this.scale) this._apply(next);
  }

  dispose() {
    globalThis.document?.removeEventListener?.('visibilitychange', this._onVis);
    globalThis.removeEventListener?.('resize', this._onResize);
  }
}
