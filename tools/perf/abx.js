// Interleaved A/B of one runtime switch: the two settings alternate in short
// blocks inside a single run, so slow drift (other load on the machine, the
// scene changing) lands on both alike. Far tighter than whole rounds.
//
//   window.__abx = { set: (legacy) => { ... }, name, scenario: 'combat' | 'cruise',
//                    seconds: 30, block: 400, skip: 100 }
//   evaluate_script({ sourcePath: 'tools/perf/abx.js' })
//
// `set(true)` selects the old behaviour, `set(false)` the new one. Frames in
// the first `skip` ms of a block are dropped (the switch itself, and GPU times
// that still belong to the other setting). Same page setup as frame.js.
// The result is ms per frame for each setting and the change in percent, with
// the standard error of that change over the block pairs.
async () => {
  const o = { scenario: 'combat', seconds: 30, block: 400, skip: 100, ...(window.__abx ?? {}) };
  const game = window.__game;
  const perf = window.__perf;
  if (!game || !perf?.profiler?.available || !perf.enableCpu) return { error: 'needs the dev build on WebGPU (window.__perf with timestamps)' };
  if (document.hidden) return { error: 'tab is hidden' };
  perf.enableCpu();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const frame = () => new Promise((r) => requestAnimationFrame(r));
  const adaptive = perf.adaptive;
  const wasOn = adaptive?.enabled;
  if (adaptive) adaptive.setEnabled(false);
  if (game.flow.state === 'pause') game.flow.resume();
  const pose = { x: -36450, z: 1860, agl: 700, heading: 270, speed: 230, ...(o.pose ?? {}) };
  const fire = () => { if (o.scenario === 'combat') window.__vfxTest?.('combat'); };
  let timer = null;
  try {
    const fires = game.systems.vfx?.emitters?.fires;
    if (fires) fires.length = 0;
    game.spawnAt(pose);
    fire();
    await sleep(2500);
    game.spawnAt(pose);
    fire();
    timer = setInterval(fire, 2500);
    let respawn = performance.now();
    const blocks = []; // { legacy, cpu, n, gpu, g }
    const t0 = performance.now();
    let k = 0;
    while (performance.now() - t0 < o.seconds * 1000) {
      // pairs in ABBA order
      const legacy = (k & 3) === 0 || (k & 3) === 3;
      k++;
      o.set(legacy);
      const b = { legacy, cpu: 0, n: 0, gpu: 0, g: 0 };
      const start = performance.now();
      let seen = perf.profiler.sampleCount;
      let s0 = null;
      while (performance.now() - start < o.block) {
        await frame();
        const s = perf.cpu.sum;
        const tot = s.update + s.render + s.tail + s.async;
        if (performance.now() - start >= o.skip) {
          if (s0 !== null) { b.cpu += tot - s0.tot; b.n += s.frames - s0.frames; }
          s0 = { tot, frames: s.frames };
          if (perf.profiler.sampleCount !== seen) { b.gpu += perf.profiler.lastTotal; b.g++; }
        }
        seen = perf.profiler.sampleCount;
      }
      blocks.push(b);
      // stay over the same ground: back to the pose every 10 s, between pairs
      if ((k & 3) === 0 && performance.now() - respawn > 10000) { game.spawnAt(pose); respawn = performance.now(); }
    }
    const side = (legacy) => {
      const bs = blocks.filter((b) => b.legacy === legacy && b.n > 0);
      const n = bs.reduce((a, b) => a + b.n, 0);
      const g = bs.reduce((a, b) => a + b.g, 0);
      const cpu = bs.reduce((a, b) => a + b.cpu, 0) / n;
      const gpu = g ? bs.reduce((a, b) => a + b.gpu, 0) / g : 0;
      return { cpu: +cpu.toFixed(3), gpu: +gpu.toFixed(3), overall: +(cpu + gpu).toFixed(3), frames: n, gpuFrames: g };
    };
    const A = side(true);
    const B = side(false);
    // change per adjacent pair of blocks (CPU per frame; GPU from the totals above)
    const d = [];
    for (let i = 0; i + 1 < blocks.length; i += 2) {
      const [x, y] = blocks[i].legacy ? [blocks[i], blocks[i + 1]] : [blocks[i + 1], blocks[i]];
      if (x.n && y.n) d.push(y.cpu / y.n - x.cpu / x.n + (x.g && y.g ? y.gpu / y.g - x.gpu / x.g : B.gpu - A.gpu));
    }
    const mean = d.reduce((a, v) => a + v, 0) / d.length;
    const sd = Math.sqrt(d.reduce((a, v) => a + (v - mean) ** 2, 0) / Math.max(1, d.length - 1));
    const sorted = d.slice().sort((a, b) => a - b);
    return {
      name: o.name, scenario: o.scenario, legacy: A, new: B,
      changeMs: +(B.overall - A.overall).toFixed(3),
      changePct: +((B.overall - A.overall) / A.overall * 100).toFixed(2),
      cpuPct: +((B.cpu - A.cpu) / A.cpu * 100).toFixed(2), gpuPct: A.gpu ? +((B.gpu - A.gpu) / A.gpu * 100).toFixed(2) : null,
      pairs: d.length, pairMedianMs: +sorted[d.length >> 1].toFixed(3),
      sePct: +(sd / Math.sqrt(d.length) / A.overall * 100).toFixed(2),
    };
  } finally {
    clearInterval(timer);
    o.set(false);
    if (adaptive) adaptive.setEnabled(wasOn);
  }
}
