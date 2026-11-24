// DEV ONLY (installed from dev/index.js behind `import.meta.env.DEV`).
//
// Helpers for shooting trailer footage with the capture tool (capture.js):
// start a sortie, fast-forward headless until something is about to happen,
// pick a camera, record. Shot recipes live with the trailer project
// (trailer/shots.js), which calls these through window.__trailer.
//
//   const T = window.__trailer;
//   await T.sortie('m1', { bot: true });                 // the bot flies, player can't die
//   await T.until(() => T.nearest('air') < 3000, 240);   // headless, up to 240 s of game time
//   T.view('chase');  T.missileCam(true);
//   await T.rec('m1-merge', 8);

import { terrainHeight } from '../../world/terrain/heightfield.js';

export function installTrailer(game, dev) {
  const rig = game.cameraRig;
  const combat = () => game.systems.combat;
  const world = () => combat()?.world;

  const T = {
    /** Make the player invulnerable (footage, not gameplay). */
    god(on = true) { const w = world(); if (w) w.god = on; },

    /**
     * Start a sortie. opts: bot (true: the dev bot flies it), special
     * (loadout), time (hours, overrides the mission's light).
     */
    async sortie(id, { bot = false, special, time } = {}) {
      dev.setBot(false);
      rig.stopCinematic?.();
      rig.devHold = false;
      special ??= game.flow.missions.find((m) => m.id === id)?.special;
      if (!game.flow.startMission(id, { special })) throw new Error(`could not start ${id}`);
      if (game.ui?.screen && game.ui.screen !== 'sortie') game.ui.show?.('sortie');
      T.god(true);
      if (bot) { dev.setBot({ god: true }); game.autopilot = dev.bot; }
      if (typeof time === 'number') game.env?.setTimeOfDay?.(time);
      await T.sim(0.5);
      rig.stopCinematic?.('sortie');
      return game.flow.state;
    },

    /** Headless fast-forward (no rendering). */
    async sim(seconds, dt = 1 / 30) {
      const n = Math.round(seconds / dt);
      for (let i = 0; i < n; i++) {
        if (game.flow.state === 'pause') game.flow.resume();
        game.update(dt);
        if (i % 60 === 59) await new Promise((r) => setTimeout(r, 0));
      }
    },

    /** Fast-forward until pred() is true (checked every 0.25 s) or maxSeconds pass. Returns the game seconds spent, or -1. */
    async until(pred, maxSeconds = 120, dt = 1 / 30) {
      let t = 0;
      while (t < maxSeconds) {
        if (pred()) return t;
        await T.sim(0.25, dt);
        t += 0.25;
        if (game.flow.state !== 'sortie') return -1;
      }
      return -1;
    },

    /** Distance (m) to the nearest live hostile of a class ('air' | 'ground' | any). */
    nearest(cls = null) {
      const w = world();
      if (!w) return Infinity;
      const p = game.flight.position;
      let best = Infinity;
      for (const t of w.targets) {
        if (!t.alive || t.team !== 'hostile' || (cls && t.class !== cls)) continue;
        best = Math.min(best, t.position.distanceTo(p));
      }
      return best;
    },

    /** Player camera view: 'chase' | 'cockpit' | 'hud'. Stops any cinematic. */
    view(mode) { rig.stopCinematic?.(); rig.setMode(mode); },
    /** Cinematic path (camera/cinematics.js) by name. */
    cine(name, opts = {}) { rig.playCinematic(name, opts).catch(() => {}); },
    missileCam(on = true) { rig.options.missileCam = on; },
    killCam(on = true) { rig.options.killCam = on; },

    /** Record `seconds` to captures/<clip>/ (capture.js). */
    rec(clip, seconds, opts = {}) { return window.__capture.record({ clip, seconds, ...opts }); },

    /** Height of the ground under the jet, and AGL. */
    agl() { const p = game.flight.position; return p.y - terrainHeight(p.x, p.z); },
    status() { return dev.status(); },
  };
  window.__trailer = T;
  return T;
}
