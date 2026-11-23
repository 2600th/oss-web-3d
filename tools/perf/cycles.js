// Lifecycle / leak check (dev build, window.__game): run `cycles` sorties of
// `mission` -> debrief -> retry, then quit to the menu, and record after each
// step: JS heap, three's GPU resource counts (renderer.info.memory), the scene
// graph size, event-bus listeners, combat world sizes and VFX counts.
// Every hostile target is destroyed through the combat world as soon as it
// exists (same events as real kills) so a sortie ends in ~10-20 s.
// Heap is sampled as the minimum over 2 s (GC noise); pass `--js-flags=--expose-gc`
// to Chrome to get exact numbers (window.gc is then used).
//
// window.__cycleOpts = { mission: 'm1', cycles: 5 }
async () => {
  const o = { mission: 'm1', cycles: 5, ...(window.__cycleOpts ?? {}) };
  const game = window.__game;
  if (!game) return { error: 'dev build only' };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const r = game.r.renderer;
  const snap = async (label) => {
    let heap = Infinity;
    for (let i = 0; i < 10; i++) {
      window.gc?.();
      if (performance.memory) heap = Math.min(heap, performance.memory.usedJSHeapSize);
      await sleep(200);
    }
    let nodes = 0;
    game.scene.traverse(() => nodes++);
    let listeners = 0;
    for (const s of game.events._map.values()) listeners += s.size;
    const c = game.systems.combat;
    const v = game.systems.vfx?.stats?.();
    return {
      label, flow: game.flow.state,
      heapMB: Number.isFinite(heap) ? +(heap / 1048576).toFixed(1) : null,
      geometries: r.info.memory.geometries, textures: r.info.memory.textures,
      programs: r.info.memory.programs ?? r._pipelines?.programs?.vertex?.size ?? null,
      renderObjects: r._objects?.chainMaps ? Object.values(r._objects.chainMaps).reduce((n, m) => n + (m?.size ?? 0), 0) : null,
      sceneNodes: nodes, listeners,
      targets: c?.world?.targets?.length, missiles: c?.world?.missiles?.length, flares: c?.world?.flares?.length,
      vfxEmitters: v?.emitters, vfxDebris: v?.debris,
    };
  };
  const finish = async () => {
    const end = performance.now() + 90000;
    while (performance.now() < end && game.flow.state === 'sortie') {
      const c = game.systems.combat;
      for (const e of c.world.targets) if (e.alive && e.team === 'hostile') c.world.kill(e, c.world.player);
      await sleep(500);
    }
    if (game.flow.state === 'remembrance') game.flow.confirm();
    await sleep(1500);
  };
  const rows = window.__cycleRows = [await snap('start')];
  window.__bot?.('god');
  game.flow.startMission(o.mission);
  for (let i = 1; i <= o.cycles; i++) {
    await sleep(3000);
    await finish();
    rows.push(await snap(`debrief ${i}`));
    if (i < o.cycles) game.flow.retry();
  }
  game.flow.quitToMenu();
  await sleep(3000);
  rows.push(await snap('menu'));
  return rows;
}
