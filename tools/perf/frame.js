// Whole-frame benchmark: CPU and GPU cost of a frame at the display's own pace
// (rAF), at a fixed pose, for a fixed stretch of game time. Use it for A/B work
// on frame time; bench.js stays the per-pass GPU benchmark.
//
//   overall = cpu.frame + gpu.total   (ms per frame)
//   cpu.frame = update + render + tail (poll, profiler, adaptive, HUD) + async
//               (the profiler's query callback), from `perf.cpu.sum`
//   gpu.total = mean of the per-frame timestamp totals, spike frames dropped
//
// Open `?mission=free&quality=high` (no `gputime`: that adds per-pass
// bookkeeping players do not pay for; with it the result also has GPU
// categories), emulate 1920x1080x1, bring the tab to the front, then
// evaluate_script({ sourcePath: 'tools/perf/frame.js' }).
// Do not record a trace at the same time: the sampling profiler adds about
// 70 % to the CPU numbers. traceprofile.mjs is for finding hot spots.
//
// Options: window.__frameOpts = { scenario: 'combat' | 'cruise', cycles: 3, settle: 2500 }
// 'combat' fires the VFX combat scene every 2.5 s and measures whole cycles.
async () => {
  const o = { scenario: 'combat', cycles: 3, settle: 2500, ...(window.__frameOpts ?? {}) };
  const game = window.__game;
  const perf = window.__perf;
  if (!game || !perf?.profiler?.available || !perf.enableCpu) return { error: 'needs the dev build on WebGPU (window.__perf with timestamps)' };
  perf.enableCpu();
  if (document.hidden) return { error: 'tab is hidden' };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const frame = () => new Promise((r) => requestAnimationFrame(r));
  const adaptive = perf.adaptive;
  const wasOn = adaptive?.enabled;
  if (adaptive) adaptive.setEnabled(false);
  if (game.flow.state === 'pause') game.flow.resume();
  const CYCLE = 2500;
  const fire = () => { if (o.scenario === 'combat') window.__vfxTest?.('combat'); };
  let timer = null;
  try {
    // ground fires from earlier runs burn for minutes: start every run without them
    const fires = game.systems.vfx?.emitters?.fires;
    if (fires) fires.length = 0;
    game.spawnAt({ x: -36450, z: 1860, agl: 700, heading: 270, speed: 230 });
    fire();
    await sleep(o.settle);
    // re-place so every run measures the same stretch of ground and sky
    game.spawnAt({ x: -36450, z: 1860, agl: 700, heading: 270, speed: 230 });
    fire();
    timer = setInterval(fire, CYCLE);
    await frame();
    perf.profiler.reset();
    const gpuTotals = [];
    let seen = perf.profiler.sampleCount;
    const acc = { n: 0, draws: 0, tris: 0, passes: 0 };
    const sum0 = { ...perf.cpu.sum };
    const t0 = performance.now();
    const end = t0 + CYCLE * o.cycles;
    const intervals = [];
    let last = t0;
    while (performance.now() < end) {
      await frame();
      const now = performance.now();
      intervals.push(now - last);
      last = now;
      acc.n++;
      if (perf.profiler.sampleCount !== seen) { seen = perf.profiler.sampleCount; gpuTotals.push(perf.profiler.lastTotal); }
      const info = game.r.renderer.info.render;
      acc.draws += info.drawCalls; acc.tris += info.triangles; acc.passes += info.frameCalls;
    }
    const wall = performance.now() - t0;
    const sum1 = { ...perf.cpu.sum };
    clearInterval(timer);
    timer = null;
    await sleep(250);
    const s = perf.profiler.summary?.();
    const gs = gpuTotals.slice().sort((a, b) => a - b);
    const cut = gs.length ? gs[gs.length >> 1] * 1.6 + 0.2 : 0;
    const kept = gpuTotals.filter((v) => v <= cut);
    const gpuTotal = kept.length ? +(kept.reduce((a, b) => a + b, 0) / kept.length).toFixed(3) : null;
    intervals.sort((a, b) => a - b);
    const q = (p) => +intervals[Math.min(intervals.length - 1, Math.floor(intervals.length * p))].toFixed(2);
    const nf = sum1.frames - sum0.frames;
    const d = (k) => +((sum1[k] - sum0[k]) / nf).toFixed(3);
    const cpu = { update: d('update'), render: d('render'), tail: d('tail'), async: d('async') };
    cpu.frame = +(cpu.update + cpu.render + cpu.tail + cpu.async).toFixed(3);
    return {
      scenario: o.scenario, backend: game.r.backend, tier: game.r.tier.name,
      canvas: [game.r.renderer.domElement.width, game.r.renderer.domElement.height],
      frames: acc.n, fps: +(acc.n / wall * 1000).toFixed(1),
      interval: { p50: q(0.5), p95: q(0.95), p99: q(0.99), max: q(1) },
      cpu,
      gpu: { total: gpuTotal, frames: kept.length, cats: s?.cats ?? {} },
      overall: +(cpu.frame + (gpuTotal ?? 0)).toFixed(3),
      top: (s?.passes ?? []).slice(0, 14).map((p) => `${p.label}: ${p.ms}`),
      draws: Math.round(acc.draws / acc.n), triangles: Math.round(acc.tris / acc.n), passes: Math.round(acc.passes / acc.n),
    };
  } finally {
    clearInterval(timer);
    if (adaptive) adaptive.setEnabled(wasOn);
  }
}
