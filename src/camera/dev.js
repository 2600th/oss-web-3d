// DEV ONLY (imported by camera/system.js behind `import.meta.env.DEV`).
// Repeatable camera / post scenarios for evidence screenshots and tuning:
//
//   await __camTest('lowpass')   valley run at ~70 m AGL and ~340 m/s, chase view
//   await __camTest('roll')      full-deflection aileron roll at 300 m/s (expert mode)
//   await __camTest('cloud')     overcast, flying through the deck at 6.6 km
//   await __camTest('rain')      storm preset under the base, heavy rain
//   await __camTest('cockpitRain')  same, cockpit view
//   await __camTest('kill')      a bandit ahead is destroyed: slow-mo kill cam
//   await __camTest('lock')      a bandit 1.6 km ahead, lock cam held
//   await __camTest('sun')       nose on the sun at 20 deg elevation
//   await __camTest('title')     the title flyby cinematic
//   await __camTest('sortie')    briefing -> sortie transition shot
//   __camTest.reset()            undo scenario state (preset, input, overrides)
//
// Each scenario returns after setting the scene up; callers wait / screenshot.
import { Autopilot } from '../game/Autopilot.js';
import { terrainHeight, maxHeightAlong } from '../world/terrain/heightfield.js';
import { traceValleyRoad } from '../ai/sites.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export function installCameraDev(game, sys) {
  const rig = game.cameraRig;
  const input = game.input;
  let saved = null;

  const save = () => {
    if (saved) return;
    saved = { preset: game.env?.preset ?? 'default', mode: rig.mode, control: input.mode };
  };

  const reset = () => {
    game.autopilot = null;
    input.setTouchAxes?.(0, 0);
    input.setTouchThrottle?.(null);
    input.setAction?.('lookTarget', false);
    rig.lockHeld = false;
    rig.devHold = false;
    sys.devLock = false;
    sys.weatherOverride = null;
    if (saved) {
      game.env?.setPreset?.(saved.preset);
      rig.setMode(saved.mode);
      input.setMode?.(saved.control);
      saved = null;
    }
    // a scenario that ended in the rocks: fly the same sortie again
    if (game.flow.state !== 'sortie' && game.flow.state !== 'title' && game.flow._last) game.flow.retry();
    // a dev sortie (?mission=) can race the ui's first-run memorial card
    if (game.flow.state === 'sortie' && game.ui?.screen && game.ui.screen !== 'sortie') game.ui.show?.('sortie');
    rig.stopCinematic?.();
    if (rig._override && rig._override.view !== 'cinematic') rig._endOverride(0);
    game.timeScale = 1;
  };

  /** Fly the valley west of the start line at a fixed AGL with a set throttle. */
  const valley = (agl, throttle, speed) => {
    const path = traceValleyRoad(-16000, 9100, (270 * Math.PI) / 180, { length: 15000, step: 200 });
    const ap = new Autopilot(path, { agl, lookahead: 1500 });
    const u = ap.update.bind(ap);
    ap.update = (dt, f) => {
      const i = u(dt, f);
      // terrain following much tighter than the title flyby's (which keeps 260 m spare)
      const p = f.position, v = f.velocity;
      const ahead = Math.max(maxHeightAlong(p.x, p.z, p.x + v.x * 2.5, p.z + v.z * 2.5, 10), terrainHeight(p.x, p.z));
      const target = ahead + agl;
      i.climb = Math.max(-0.3, Math.min(0.3, -v.y / 120));
      // evidence runs need the jet *at* the AGL now, not in ten seconds:
      // ease the height there directly (position only: touching the velocity
      // would read as a huge G load to the flight model and the VFX)
      p.y += (target - p.y) * Math.min(1, dt * 1.2);
      i.throttle = throttle; i.boost = throttle > 0.95;
      return i;
    };
    game.autopilot = ap;
    const s = ap.start();
    game.spawnAt({ ...s, alt: undefined, agl, speed });
    return ap;
  };

  const ahead = (dist, dAlt = 0) => {
    const f = game.flight;
    return { x: f.position.x + f.forward.x * dist, z: f.position.z + f.forward.z * dist, alt: f.position.y + dAlt };
  };

  // Every scenario flies with the player invulnerable (evidence, not gameplay).
  const god = () => { const w = game.systems.combat?.world; if (w) w.god = true; };
  /** Safe straight-ish cruise down the valley, high enough for anything. */
  const cruise = (agl = 1500, speed = 260) => { god(); return valley(agl, 0.8, speed); };
  const headingDeg = () => (Math.atan2(game.flight.forward.x, -game.flight.forward.z) * 180) / Math.PI;

  const scenarios = {
    async lowpass() {
      save(); god(); rig.setMode('chase');
      valley(40, 1, 340);
      await wait(2500);
    },
    async roll() {
      save(); god(); rig.setMode('chase');
      game.spawnAt({ x: -14000, z: 4000, agl: 2600, heading: 270, speed: 300 });
      input.setMode?.('expert');
      await wait(1200);
      input.setTouchAxes?.(0, 1);
      await wait(450);
    },
    async cloud() {
      save(); god(); rig.setMode('chase');
      game.env?.setPreset?.('overcast');
      game.spawnAt({ x: -14000, z: 4000, alt: 6300, heading: 270, speed: 280 });
      await wait(6000);
    },
    async rain() {
      save(); god(); rig.setMode('chase');
      game.env?.setPreset?.('storm');
      sys.weatherOverride = { rain: 1 };
      valley(260, 0.85, 260);
      await wait(4000);
    },
    async cockpitRain() {
      await scenarios.rain();
      rig.setMode('cockpit');
      await wait(2500);
    },
    /** opts.hold: keep the kill cam on screen (for screenshots). */
    async kill(opts = {}) {
      save(); rig.setMode('chase');
      cruise(1400);
      await wait(1500);
      const p = ahead(700, 30);
      const [e] = game.systems.ai.spawnFighters({ at: { x: p.x, z: p.z, alt: p.alt }, count: 1, heading: headingDeg(), speed: 230 });
      await wait(900);
      const combat = game.systems.combat;
      rig.devHold = !!opts.hold;
      e.alive = false;
      game.events.emit('explosion', { position: e.position.clone(), size: 'large', kind: 'air', velocity: e.velocity?.clone?.() });
      game.events.emit('target:destroyed', { target: e, killer: combat.player, position: e.position.clone(), score: 100 });
      await wait(opts.after ?? 500);
      return e;
    },
    async lock() {
      save(); rig.setMode('chase');
      cruise(1500);
      await wait(1500);
      const p = ahead(1600, 120);
      const f = game.flight;
      const [e] = game.systems.ai.spawnFighters({ at: { x: p.x + f.right.x * 350, z: p.z + f.right.z * 350, alt: p.alt }, count: 1, heading: headingDeg() - 25, speed: 240 });
      sys.devLock = e;
      rig.lockHeld = true;
      await wait(1500);
      return e;
    },
    async sun() {
      save(); god(); rig.setMode('chase');
      // straight and level (no autopilot turns) so the sun stays in frame
      game.spawnAt({ x: -14000, z: 4000, alt: 5200, heading: 270, speed: 240 });
      await wait(800);
      game.env?.setSun?.(9, headingDeg() + 7);
      await wait(1800);
    },
    async title() {
      reset();
      game.flow.toTitle();
      await wait(3000);
    },
    async sortie() {
      reset();
      // through the briefing, as a player would (the intro only plays on
      // briefing -> sortie, not on a dev ?mission= start or a resume)
      const id = game.flow.selected ?? 'm1';
      game.flow.selectMission(id);
      await wait(300);
      game.flow.startMission(id);
      await wait(400);
    },
  };

  const run = async (name, opts) => {
    const s = scenarios[name];
    if (!s) throw new Error(`no camera scenario "${name}" (${Object.keys(scenarios).join(', ')})`);
    return s(opts);
  };
  run.list = () => Object.keys(scenarios);
  run.reset = reset;
  window.__camTest = run;
  return run;
}
