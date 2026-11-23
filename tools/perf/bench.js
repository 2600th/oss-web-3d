// GPU frame benchmark for Safed Sagar v2. Paste into DevTools, or run with the
// chrome-devtools MCP: evaluate_script({ sourcePath: 'tools/perf/bench.js' }).
// Needs a page opened with `?gputime` (or `?perfhud`) so window.__perf exists.
//
// Scenario ("combat"): the player is placed at a fixed pose 2.5 km east of
// Tiger Hill, 700 m above the ridge, heading west into the sun-side cloud
// field; the VFX combat scene (10 missile trails, flares, 3 explosions, 2
// fires, a burning aircraft) is fired every 2.5 s so the frame stays busy.
// Each round re-places the player and measures `frames` frames of per-pass GPU
// timestamps; the result is the median of `rounds` rounds.
//
// Options: window.__benchOpts = { rounds: 3, frames: 90, scenario: 'combat'|'cruise', settle: 1500, flushFrames: 30 }
async () => {
  const o = { rounds: 3, frames: 90, scenario: 'combat', settle: 1500, ...(window.__benchOpts ?? {}) };
  const game = window.__game ?? window.__perf?.game;
  const perf = window.__perf;
  if (!game || !perf?.profiler?.available) return { error: 'open the page with ?gputime (dev build, or prod with ?perfhud)' };
  if (document.hidden) return { error: 'tab is hidden: rAF and the game loop are stopped (open it in its own window)' };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFrames = async (n) => { for (let i = 0; i < n; i++) await new Promise((r) => requestAnimationFrame(r)); };
  // keep the adaptive-resolution controller out of the measurement
  const adaptive = perf.adaptive;
  const wasOn = adaptive?.enabled;
  if (adaptive) adaptive.setEnabled(false);
  if (game.flow.state === 'pause') game.flow.resume();
  const pose = { x: -36450, z: 1860, agl: 700, heading: 270, speed: 230 };
  const rounds = [];
  let vfxTimer = null;
  try {
    for (let k = 0; k < o.rounds; k++) {
      game.spawnAt(pose);
      if (o.scenario === 'combat' && window.__vfxTest) {
        window.__vfxTest('combat');
        clearInterval(vfxTimer);
        vfxTimer = setInterval(() => { try { window.__vfxTest('combat'); } catch { /* harness gone */ } }, 2500);
      }
      await sleep(o.settle);
      perf.profiler.reset();
      perf.profiler.window = o.frames;
      await waitFrames(o.frames + 10);
      await sleep(200);
      const info = game.r.renderer.info.render; // the last complete frame (reset at frame start)
      rounds.push({ ...perf.profiler.summary(), drawCalls: info.drawCalls, triangles: info.triangles });
    }
    // Cross-check without timestamps: pause the loop, render `flushFrames`
    // frames back to back and wait for the queue to drain. This is an upper
    // bound on GPU time per frame (it includes inter-pass gaps, buffer uploads
    // and the present copy, which per-pass timestamps do not see) as long as
    // the CPU encodes faster than the GPU draws (cpuMs < wallMs).
    const renderer = game.r.renderer;
    const device = renderer.backend.device;
    const gl = renderer.backend.gl;
    const flush = async () => { if (device) await device.queue.onSubmittedWorkDone(); else { gl.finish(); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4)); } };
    renderer.setAnimationLoop(null);
    const walls = [];
    try {
      for (let k = 0; k < o.rounds; k++) {
        await flush();
        const t0 = performance.now();
        for (let i = 0; i < (o.flushFrames ?? 30); i++) { game.update(1 / 60); game.post.render(); }
        const t1 = performance.now();
        await flush();
        const t2 = performance.now();
        walls.push({ wall: (t2 - t0) / (o.flushFrames ?? 30), cpu: (t1 - t0) / (o.flushFrames ?? 30) });
      }
    } finally {
      let last = performance.now();
      renderer.setAnimationLoop(perf.loop ?? ((now) => { const dt = (now - last) / 1000; last = now; game.update(dt); game.post.render(); }));
    }
    rounds.walls = walls;
  } finally {
    clearInterval(vfxTimer);
    if (adaptive) adaptive.setEnabled(wasOn);
  }
  const med = (a) => a.slice().sort((x, y) => x - y)[a.length >> 1];
  const cats = {};
  for (const c of new Set(rounds.flatMap((r) => Object.keys(r.cats)))) cats[c] = +med(rounds.map((r) => r.cats[c] ?? 0)).toFixed(3);
  const passes = {};
  for (const r of rounds) for (const p of r.passes) (passes[p.label] ??= []).push(p.ms);
  const top = Object.entries(passes).map(([label, v]) => ({ label, ms: +med(v).toFixed(3) })).sort((a, b) => b.ms - a.ms).slice(0, 16);
  const r = game.r;
  return {
    backend: r.backend, tier: r.tier.name,
    canvas: [r.renderer.domElement.width, r.renderer.domElement.height],
    renderScale: r.renderScale,
    total: +med(rounds.map((x) => x.total)).toFixed(3),
    wallMs: +med(rounds.walls.map((w) => w.wall)).toFixed(3),
    cpuMs: +med(rounds.walls.map((w) => w.cpu)).toFixed(3),
    totals: rounds.map((x) => x.total),
    cats, top,
    passes: rounds[0].passes.reduce((n, p) => n + p.n, 0),
    drawCalls: med(rounds.map((x) => x.drawCalls)), triangles: med(rounds.map((x) => x.triangles)),
  };
}
