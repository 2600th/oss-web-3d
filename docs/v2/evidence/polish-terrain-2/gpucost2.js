/*
 * GPU cost probe for the terrain / cloud pass (dev tool, not shipped).
 * Load after bench2.js in a `?gputime` page:
 *   await __gpucost2.totals(['valley-100m', 'golden-clouds'], { seconds: 15 })
 *   await __gpucost2.ab('valley-100m', 'terrainAO', { seconds: 12, rounds: 3 })
 * `totals` returns the median whole-frame GPU time (renderer
 * info.render.timestamp, fresh values only) per pose; run it on this branch and
 * on the base branch (files swapped) for the branch-vs-base delta. `ab`
 * toggles a feature inside one page (OFF / ON alternated `rounds` times).
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

  const FEATURES = {
    // GTAO + heightfield near AO on the terrain (sampling only; the GTAO pass
    // itself runs for the other materials either way)
    terrainAO: {
      off: () => { const u = window.__game.terrain.uniforms; u.aoStrength.value = 0; u.nearAO.value = 0; },
      on: () => { const u = window.__game.terrain.uniforms; u.aoStrength.value = 1; u.nearAO.value = 1; },
    },
  };

  async function totals(poses, { seconds = 15, settle = 3000 } = {}) {
    const out = [];
    for (const p of poses) {
      await window.__bench2.pose(p);
      await sleep(settle);
      const a = await collect(seconds);
      out.push({ pose: p, median: +median(a).toFixed(3), n: a.length });
    }
    const g = window.__game;
    return { tier: g.r.tier.name, canvas: [g.r.renderer.domElement.width, g.r.renderer.domElement.height], out };
  }

  async function ab(pose, feature, { seconds = 12, rounds = 3, settle = 2500 } = {}) {
    await window.__bench2.pose(pose);
    const f = FEATURES[feature];
    const res = { off: [], on: [], d: [] };
    for (let k = 0; k < rounds; k++) {
      f.off(); await sleep(settle);
      const a = await collect(seconds);
      f.on(); await sleep(settle);
      const b = await collect(seconds);
      res.off.push(...a); res.on.push(...b);
      res.d.push(+(median(b) - median(a)).toFixed(3));
    }
    f.on();
    return { pose, feature, off: +median(res.off).toFixed(3), on: +median(res.on).toFixed(3), deltaRounds: res.d };
  }

  window.__gpucost2 = { totals, ab, collect, FEATURES };
  return Object.keys(FEATURES);
})();
