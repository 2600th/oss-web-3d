// Full-sortie driver for backend / lifecycle checks (dev build: needs
// window.__game, window.__bot and window.__perf; open with `?gputime`).
//
// The dev bot flies (invulnerable). Because the bot alone does not finish a
// strike phase reliably, every `assist` seconds of game time one hostile
// objective target is destroyed through the combat world (the same
// explosion / target:destroyed events as a real kill, credited to the player),
// so every phase and the mission end screens are reached. Call repeatedly
// (each call returns within `budgetMs`) until `done` is true.
//
// window.__sortieOpts = { mission: 'm1', assist: 6, budgetMs: 90000 }
async () => {
  const o = { mission: 'm1', assist: 6, budgetMs: 90000, ...(window.__sortieOpts ?? {}) };
  const game = window.__game;
  if (!game) return { error: 'dev build only' };
  const st = (window.__sortieState ??= { started: false, samples: [], lastKill: 0, kills: 0, t0: performance.now(), frames: 0 });
  if (!st.started) {
    st.started = true;
    window.__bot?.('god');
    if (game.flow.state !== 'sortie') game.flow.startMission(o.mission);
    const count = () => { st.frames++; requestAnimationFrame(count); };
    requestAnimationFrame(count);
  }
  const combat = game.systems.combat;
  const end = performance.now() + o.budgetMs;
  while (performance.now() < end) {
    await new Promise((r) => setTimeout(r, 2000));
    const t = game.hud.time ?? 0;
    if (game.flow.state === 'sortie' && t - st.lastKill > o.assist) {
      const live = combat.world.targets.filter((e) => e.alive && e.team === 'hostile');
      const pick = live.find((e) => e.isTarget || e.objective) ?? live[0];
      if (pick) { combat.world.kill(pick, combat.world.player); st.kills++; }
      st.lastKill = t;
    }
    const s = window.__perf?.profiler?.summary();
    st.samples.push({ t: Math.round(t), flow: game.flow.state, phase: game.hud.mission?.phase, gpu: s?.total ?? null, cpu: +(window.__perf?.cpu?.frame ?? 0).toFixed(2), heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null });
    if (['debrief', 'remembrance'].includes(game.flow.state)) break;
  }
  const done = ['debrief', 'remembrance'].includes(game.flow.state);
  const g = st.samples.map((x) => x.gpu).filter((x) => x != null).sort((a, b) => a - b);
  const c = st.samples.map((x) => x.cpu).sort((a, b) => a - b);
  const secs = (performance.now() - st.t0) / 1000;
  return {
    done, flow: game.flow.state, backend: game.r.backend, tier: game.r.tier.name,
    result: game.flow.result && { state: game.flow.result.state, score: game.flow.result.score, rank: game.flow.result.rank, reason: game.flow.result.reason },
    assistedKills: st.kills, gameTime: Math.round(game.hud.time ?? 0), realSeconds: Math.round(secs), avgFps: +(st.frames / secs).toFixed(1),
    gpuMs: g.length ? { p50: g[g.length >> 1], p95: g[Math.floor(g.length * 0.95)], max: g[g.length - 1] } : null,
    cpuMs: { p50: c[c.length >> 1], max: c[c.length - 1] },
    phases: [...new Set(st.samples.map((x) => x.phase))],
    heapMB: st.samples.at(-1)?.heapMB,
  };
}
