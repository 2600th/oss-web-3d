/*
 * A/B GPU cost of the realism features in a shared browser (dev tool).
 * Load as a classic script after bench.js, then
 *   await __gpucost.ab('a2a-noon', { seconds: 20, rounds: 3 })
 * Holds a bench pose, then alternates feature OFF / ON `rounds` times and
 * collects the renderer's whole-frame GPU timestamp (`info.render.timestamp`,
 * resolved asynchronously; only fresh values are kept) for `seconds` each.
 * Returns medians per state and the median difference. Per-pass timestamps
 * are not used: under heavy contention three's per-pass resolves come back
 * empty, while the frame total still resolves every few frames.
 */
(() => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : NaN; };

  async function collect(seconds) {
    const r = window.__game.r.renderer;
    const out = [];
    let last = r.info.render.timestamp;
    const t0 = performance.now();
    while (performance.now() - t0 < seconds * 1000) {
      await new Promise((res) => requestAnimationFrame(res));
      const v = r.info.render.timestamp;
      if (v !== last && v > 0) { out.push(v); last = v; }
    }
    return out;
  }

  // feature switches: off() / on()
  const FEATURES = {
    ao: {
      off: () => { const a = window.__game.post.ao; if (a) a.enabled = false; },
      on: () => { const a = window.__game.post.ao; if (a) a.enabled = true; },
    },
    // crepuscular rays: forced on at full strength for the "on" state
    // (normally only a low sun near the frame turns them on)
    rays: {
      off: () => { window.__game.post.options.godRays = 0; },
      on: () => { window.__game.post.options.godRays = 0.5; },
    },
  };
  // both new passes together (the worst case: low sun in frame)
  FEATURES.all = {
    off: () => { FEATURES.ao.off(); FEATURES.rays.off(); },
    on: () => { FEATURES.ao.on(); FEATURES.rays.on(); },
  };

  async function ab(pose, { seconds = 20, rounds = 3, feature = 'ao', settle = 3000 } = {}) {
    if (pose) await window.__bench.pose(pose);
    const f = FEATURES[feature];
    const res = { off: [], on: [], rounds: [] };
    for (let k = 0; k < rounds; k++) {
      f.off(); await sleep(settle);
      const a = await collect(seconds);
      f.on(); await sleep(settle);
      const b = await collect(seconds);
      res.off.push(...a); res.on.push(...b);
      res.rounds.push({ off: +median(a).toFixed(3), on: +median(b).toFixed(3), nOff: a.length, nOn: b.length });
    }
    f.on();
    const g = window.__game;
    return {
      pose, feature, tier: g.r.tier.name, canvas: [g.r.renderer.domElement.width, g.r.renderer.domElement.height],
      off: +median(res.off).toFixed(3), on: +median(res.on).toFixed(3),
      delta: +(median(res.on) - median(res.off)).toFixed(3),
      deltaRounds: res.rounds.map((x) => +(x.on - x.off).toFixed(3)), rounds: res.rounds,
    };
  }

  async function total(pose, { seconds = 20, settle = 3000 } = {}) {
    if (pose) await window.__bench.pose(pose);
    await sleep(settle);
    const a = await collect(seconds);
    return { pose, tier: window.__game.r.tier.name, median: +median(a).toFixed(3), n: a.length };
  }

  window.__gpucost = { ab, total, collect, FEATURES };
  return Object.keys(FEATURES);
})();
