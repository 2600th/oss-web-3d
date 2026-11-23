// A/B cost of scene components from the GPU total (timestamps): hides one
// thing at a time, measures, restores. Use when per-pass attribution is not
// enough (everything in the main scene pass is one pass; on WebGL2 three's
// timer queries nest, so only the frame total is reliable).
// evaluate_script({ sourcePath: 'tools/perf/ab.js' }) on a page with ?gputime.
async () => {
  const game = window.__game;
  const perf = window.__perf;
  if (!game || !perf?.profiler?.available) return { error: 'needs ?gputime (dev)' };
  if (document.hidden) return { error: 'tab hidden' };
  const frames = (window.__abOpts?.frames) ?? 60;
  const waitFrames = async (n) => { for (let i = 0; i < n; i++) await new Promise((r) => requestAnimationFrame(r)); };
  const measure = async () => { await waitFrames(5); perf.profiler.reset(); perf.profiler.window = frames; await waitFrames(frames + 5); return perf.profiler.summary().total; };
  const vfx = game.systems.vfx;
  const toggles = {
    terrain: (on) => { game.terrain.group.visible = on; },
    sky: (on) => { game.env.sky.visible = on; },
    player: (on) => { game.player.group.visible = on; },
    vfxLayer: (on) => { if (vfx?.scene) vfx.scene.visible = on; },
    ground: (on) => { game.scene.traverse((o) => { if (o.userData?.__abGround === undefined && o.isMesh && o !== game.env.sky && !isUnder(o, game.terrain.group) && !isUnder(o, game.player.group)) o.userData.__abGround = o.visible; if (o.userData?.__abGround !== undefined) o.visible = on ? o.userData.__abGround : false; }); },
  };
  function isUnder(o, root) { for (let q = o; q; q = q.parent) if (q === root) return true; return false; }
  const base = [];
  const out = {};
  base.push(await measure());
  for (const [name, set] of Object.entries(toggles)) {
    set(false);
    const off = await measure();
    set(true);
    base.push(await measure());
    out[name] = off;
  }
  const b = base.slice().sort((x, y) => x - y)[base.length >> 1];
  return {
    backend: game.r.backend, tier: game.r.tier.name, canvas: [game.r.renderer.domElement.width, game.r.renderer.domElement.height],
    baseline: +b.toFixed(3), baselines: base.map((x) => +x.toFixed(3)),
    cost: Object.fromEntries(Object.entries(out).map(([k, v]) => [k, +(b - v).toFixed(3)])),
  };
}
