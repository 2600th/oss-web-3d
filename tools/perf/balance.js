// Balance batch driver for the dev bot (dev build: needs window.__game.dev).
// Run with the chrome-devtools MCP: evaluate_script({ sourcePath: 'tools/perf/balance.js' })
// installs it once per page load; then start a plan and poll it:
//
//   window.__balRun([{ id: 'storm', difficulty: 'normal', n: 12 },
//                    { id: 'night', difficulty: 'hard', n: 8, bot: { cloud: true }, variant: 'cloud-bot' }], 'after')
//   window.__bal            -> { running, done: [record...], err }
//   window.__all            -> every record this page has produced
//
// Each record is `game.dev.run`'s (outcome, time, damage by source, death,
// hostile missiles, phases, kills, ammo, bot counters) plus `ex`:
//   kills      ['F@46', 'T@36', ...] fighters / trucks destroyed, mission seconds
//   phaseHp    ['second@54:100', ...] phase start and the player's health then
//   minHp      lowest health in the sortie (0..100)
//   resupply   'seconds:health' when a mission top-up happened
//   spotFirst  first second any night contact was on the HUD (about 5 s resolution)
//   arrived    trucks that reached the end of their road
//
// For A/B runs `game.dev.tuning` holds the live AI tables (CLOUD, ROUGH_AIR);
// change them in the page, not by importing the module again (Vite serves an
// edited module under a new ?t= URL, so a fresh import is a different copy).
// Summarise saved records with `node tools/perf/balance-table.mjs <file.json>`.
async () => {
  for (let i = 0; i < 80 && !(window.__game?.dev && window.__game.flow?.state && window.__game.flow.state !== 'boot'); i++) await new Promise((r) => setTimeout(r, 500));
  const g = window.__game;
  if (!g?.dev?.run) return { error: 'dev build only' };
  if (window.__installed === g) return 'already';
  window.__installed = g;
  const ex = (window.__ex = { cur: null });
  const now = () => Math.round(g.systems.missions.runner?.time ?? 0);
  g.events.on('mission:start', () => { ex.cur = { kills: [], phaseHp: [], minHp: 100, resupply: null, spotFirst: null }; });
  g.events.on('mission:phase', ({ phase }) => { ex.cur?.phaseHp.push(`${phase.id}@${now()}:${Math.round(g.systems.combat.player.health)}`); });
  g.events.on('target:destroyed', ({ target }) => { if (ex.cur && (target.class === 'air' || target.kind === 'truck')) ex.cur.kills.push(`${target.kind === 'truck' ? 'T' : 'F'}@${now()}`); });
  g.events.on('player:hit', ({ health }) => { if (ex.cur) ex.cur.minHp = Math.min(ex.cur.minHp, Math.round(health * 100)); });
  g.events.on('player:resupply', (e) => { if (ex.cur) ex.cur.resupply = `${now()}:${Math.round(e.health * 100)}`; });
  const snap = () => { const r = g.systems.missions.runner; if (ex.cur && r) ex.cur.arrived = r.view.arrived('night_trucks'); };
  g.events.on('mission:complete', snap);
  g.events.on('mission:failed', snap);
  const run = g.dev.run;
  g.dev.run = async (id, opts = {}) => {
    const iv = setInterval(() => {
      const sp = g.systems.missions.spotter;
      if (ex.cur && sp && ex.cur.spotFirst == null && sp.stats().spotted > 0) ex.cur.spotFirst = now();
    }, 20);
    const r = await run(id, opts);
    clearInterval(iv);
    if (r) { r.ex = ex.cur; if (opts.variant) r.variant = opts.variant; }
    return r;
  };
  window.__balRun = (plan, tag) => {
    const st = (window.__bal = { tag, plan, done: [], running: true, err: null, t0: performance.now() });
    (async () => {
      try {
        for (const p of plan) for (let i = 0; i < p.n; i++) {
          const r = await g.dev.run(p.id, { difficulty: p.difficulty, special: p.special, bot: p.bot ?? {}, variant: p.variant });
          if (!r) continue;
          r.tag = tag;
          st.done.push(r);
          (window.__all ??= []).push(r);
        }
      } catch (e) { st.err = String((e && e.stack) || e); }
      st.running = false;
    })();
    return 'started';
  };
  return 'installed';
}
