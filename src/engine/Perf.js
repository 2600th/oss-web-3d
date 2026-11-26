import { GpuProfiler } from './GpuProfiler.js';
import { AdaptiveResolution } from './AdaptiveResolution.js';

/**
 * Performance plumbing owned by the engine (see tools/perf/README.md):
 *
 *  - GpuProfiler: per-pass GPU ms from timestamp queries, whenever the
 *    renderer tracks timestamps (WebGPU by default — the adaptive resolution
 *    needs it; `?gputime` / `?perfhud` force it on WebGL2 when the timer
 *    extension exists).
 *  - AdaptiveResolution: render scale from GPU time. On by default; `?noadaptive`
 *    disables it, `?scale=0.75` pins a scale, `?gpubudget=10` changes the budget.
 *  - CPU timing per system and per frame (only with `?perfhud` / `?gputime`:
 *    it wraps the system hooks).
 *  - `?perfhud` overlay (lazy-loaded module).
 *
 * `window.__perf` is exposed in dev, and in prod when `?perfhud`/`?gputime` is given.
 */
const TRACK_INTERVAL = 0.045;

export async function installPerf({ r, game, params }) {
  const detailed = params.has('perfhud') || params.has('gputime');
  const profiler = new GpuProfiler(r);
  profiler.detailed = detailed;
  profiler.install();
  const perf = { r, game, profiler, adaptive: null, hud: null, cpu: null };

  const fixed = Number(params.get('scale'));
  if (fixed > 0) r.setRenderScale(Math.min(1, Math.max(0.25, fixed)));
  const budget = Number(params.get('gpubudget'));
  perf.adaptive = new AdaptiveResolution(r, profiler, {
    enabled: !params.has('noadaptive') && !(fixed > 0) && !detailed,
    // low tier is the integrated-GPU / WebGL2 tier: allow a deeper drop
    minScale: r.tier.name === 'low' ? 0.5 : 0.6,
    ...(budget > 0 ? { budgetMs: budget } : {}),
  });
  if (params.has('adaptive')) perf.adaptive.setEnabled(true); // with ?perfhud, to watch it work

  /**
   * Start CPU timing of the frame loop (benchmarks call this on a plain URL, so
   * they measure the configuration players run). `sum` holds plain running
   * totals in ms: update, render, the loop's tail (poll, profiler, adaptive,
   * HUD) and the profiler's own async callback, which runs outside the loop.
   */
  perf.enableCpu = () => {
    if (!perf.cpu) {
      perf.cpu = { frame: 0, update: 0, render: 0, systems: {}, sum: { update: 0, render: 0, tail: 0, async: 0, frames: 0 } };
      profiler.cpuSum = perf.cpu.sum;
    }
    return perf.cpu;
  };
  if (detailed) wrapSystems(game, perf.enableCpu());
  if (params.has('perfhud')) {
    const { PerfHud } = await import('./PerfHud.js');
    perf.hud = new PerfHud(perf);
  }
  if (import.meta.env.DEV || detailed) window.__perf = perf;

  const ema = (a, b) => a + (b - a) * 0.1;
  // Timestamp queries cost CPU on every pass (query writes, a resolve and a
  // readback per frame). Players only need them for the adaptive resolution,
  // which decides from a median about once a second: time one frame every
  // TRACK_INTERVAL seconds (about 20 a second) and leave the others untimed.
  // `?gputime` / `?perfhud` time every frame.
  const backend = r.renderer.backend;
  const dutyCycle = profiler.available && !detailed;
  /** Seconds between timed frames (0 = every frame). */
  perf.trackInterval = TRACK_INTERVAL;
  let sinceTracked = TRACK_INTERVAL;
  let tracked = true;
  /** Wrap the per-frame work: `perf.frame(dt, () => game.update(dt), () => post.render())`. */
  perf.frame = (dt, update, render) => {
    if (dutyCycle) {
      sinceTracked += dt;
      tracked = sinceTracked >= perf.trackInterval;
      if (tracked) sinceTracked = 0;
      backend.trackTimestamp = tracked;
    }
    if (perf.cpu) {
      const t0 = performance.now();
      update();
      const t1 = performance.now();
      render();
      const t2 = performance.now();
      const c = perf.cpu;
      c.update = ema(c.update, t1 - t0);
      c.render = ema(c.render, t2 - t1);
      c.frame = ema(c.frame, t2 - t0);
      c.sum.update += t1 - t0;
      c.sum.render += t2 - t1;
      c.sum.frames++;
      tail(dt);
      c.sum.tail += performance.now() - t2;
    } else {
      update();
      render();
      tail(dt);
    }
  };
  const tail = (dt) => {
    r.poll();
    if (profiler.available && tracked) profiler.sample();
    perf.adaptive.update(dt);
    perf.hud?.update(dt);
  };
  return perf;
}

/** Time every system hook (CPU), smoothed, into cpu.systems[name]. */
function wrapSystems(game, cpu) {
  const ema = (a, b) => a + (b - a) * 0.1;
  for (const s of game._systemList) {
    const name = s.name ?? 'anon';
    cpu.systems[name] = 0;
    let acc = 0;
    for (const hook of ['fixedUpdate', 'update', 'lateUpdate']) {
      const fn = s[hook];
      if (typeof fn !== 'function') continue;
      s[hook] = function (...a) {
        const t = performance.now();
        try { return fn.apply(this, a); } finally { acc += performance.now() - t; }
      };
    }
    // fold the accumulated time once per frame (lateUpdate is the last hook)
    const late = s.lateUpdate;
    s.lateUpdate = function (...a) {
      const out = late?.apply(this, a);
      cpu.systems[name] = ema(cpu.systems[name], acc);
      acc = 0;
      return out;
    };
  }
}
