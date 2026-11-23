import { inject } from '@vercel/analytics';
import { Renderer } from './engine/Renderer.js';
import { PostFX } from './engine/PostFX.js';
import { Input } from './core/Input.js';
import { loadDEM } from './world/terrain/heightfield.js';
import { Game } from './game/Game.js';

function bootFailure(message) {
  const el = document.getElementById('boot-status');
  if (!el) return;
  el.querySelector('[data-boot-message]').textContent = message;
  el.hidden = false;
  el.style.display = 'grid';
}

inject();

async function start() {
  const canvas = document.getElementById('viewport');
  const params = new URLSearchParams(location.search);
  const r = new Renderer(canvas, { forceWebGL: params.has('webgl') });
  await Promise.all([r.init(), loadDEM()]);

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

  let last = performance.now();
  r.renderer.setAnimationLoop((now) => {
    const dt = Math.max(0, (now - last) / 1000);
    last = now;
    game.update(dt);
    post.render();
  });

  if (import.meta.env.DEV) {
    window.__game = game;
    window.__renderer = r;
  }
  console.info(`[boot] backend=${r.backend} tier=${r.tier.name}`);
}

start().catch((e) => {
  console.error(e);
  bootFailure('The experience could not start: ' + (e?.message ?? e));
});
