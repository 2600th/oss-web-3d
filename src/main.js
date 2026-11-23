import { inject } from '@vercel/analytics';
import { PostFX } from './engine/PostFX.js';
import { installPerf } from './engine/Perf.js';
import { Input } from './core/Input.js';
import { createRenderer, showStatus, handleDeviceLoss } from './core/BootLifecycle.js';
import { loadDEM } from './world/terrain/heightfield.js';
import { Game } from './game/Game.js';

inject();

async function start() {
  const params = new URLSearchParams(location.search);
  // Backend: WebGPU if an adapter exists, else WebGL2; overlay only if neither
  // works (src/core/BootLifecycle.js). The DEM download runs in parallel.
  const dem = loadDEM();
  const { r } = await createRenderer(document.getElementById('viewport'), params);
  await dem;

  const input = new Input();
  const post = new PostFX(r);
  const game = new Game(r, input, post);
  // Systems self-register: every src/<area>/system.js exporting
  // `createSystem(game)` (and optionally `order`, lower first) is loaded here,
  // so feature areas never need to edit this file or Game.js to plug in.
  const modules = Object.values(import.meta.glob('./*/system.js', { eager: true }))
    .sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
  for (const m of modules) {
    const system = await m.createSystem(game);
    if (system) await game.addSystem(system);
  }
  await game.init();

  // GPU pass timing, adaptive resolution, ?perfhud (src/engine/Perf.js).
  const perf = await installPerf({ r, game, params });

  let last = performance.now();
  const loop = (now) => {
    const dt = Math.max(0, (now - last) / 1000);
    last = now;
    perf.frame(dt, () => game.update(dt), () => post.render());
  };
  perf.loop = loop; // tools/perf/bench.js pauses it for its queue-flush timing
  r.renderer.setAnimationLoop(loop);
  handleDeviceLoss(r, () => r.renderer.setAnimationLoop(null));

  if (import.meta.env.DEV) {
    window.__game = game;
    window.__renderer = r;
  }
  console.info(`[boot] backend=${r.backend} tier=${r.tier.name}`);
}

start().catch((e) => {
  console.error(e);
  showStatus('The experience could not start: ' + (e?.message ?? e));
});
