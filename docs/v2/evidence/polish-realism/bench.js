/*
 * Benchmark poses for the realism pass (docs/v2/evidence/polish-realism/).
 * Dev tool, not shipped: load it into a dev page (`?mission=free&quality=high`)
 * as a classic script (chrome-devtools `evaluate_script` with `sourcePath`,
 * format "script"), then `await __bench.pose('noon-a2a')` and screenshot.
 *
 * Every pose is deterministic: the jet is placed with `game.spawnAt` (level,
 * given heading), the game is paused, the cloud clock is pinned, and the
 * camera is held at a jet-local offset. While paused the bench itself keeps
 * the environment, terrain streaming and the time-of-day / atmosphere glue
 * ticking (Game.update skips them while paused).
 */
(() => {
  const DATE = { year: 1999, month: 6, day: 21 };
  // jet: spawnAt args. cam: jet-local camera offset (nose -Z, up +Y, right +X).
  // look: jet-local look-at point. tod: env.setTimeOfDay arg. weather: env.setPreset name (before the clock).
  const POSES = {
    // M1: first light down the Drass valley, sun low in the east-north-east
    'm1-dawn-valley': { tod: 5.67, jet: { x: -26500, z: 8300, agl: 520, heading: 290, speed: 240 }, cam: [-6, 9, 46], look: [0, -30, -600] },
    // M2: midday over Batalik, high sun
    'm2-midday': { tod: 'noon', jet: { x: 22000, z: -17000, alt: 5000, heading: 20, speed: 250 }, cam: [-8, 8, 40], look: [0, -25, -900] },
    // golden hour over Tololing, looking toward the low sun
    'golden-hour': { tod: 'golden', jet: { x: -26000, z: 1500, alt: 5400, heading: 265, speed: 250 }, cam: [10, 8, 48], look: [0, -40, -900] },
    // dusk, after sunset, over the Drass ridges toward the afterglow
    dusk: { tod: 'dusk', jet: { x: -24000, z: 4000, alt: 5300, heading: 300, speed: 250 }, cam: [-8, 8, 48], look: [0, -30, -900] },
    // full moon, 23:00, Kargil
    'night-moon': { tod: 'moonlit-night', jet: { x: 2000, z: -4000, alt: 5000, heading: 150, speed: 250 }, cam: [-8, 8, 46], look: [0, -40, -900] },
    // storm over Kargil, afternoon
    storm: { weather: 'storm', tod: 15.75, jet: { x: 2000, z: -6000, alt: 4600, heading: 60, speed: 250 }, cam: [-8, 8, 46], look: [0, -30, -900] },
    // air-to-air, front-right three-quarter, 15 m, noon
    'a2a-noon': { tod: 'noon', jet: { x: 5000, z: -9000, alt: 5600, heading: 120, speed: 250 }, cam: [11, 3.2, -9], look: [0, 0, 0.5] },
    // air-to-air at golden hour, sun on the camera side (right wing toward the sun)
    'a2a-golden': { tod: 'golden', jet: { x: 10000, z: -15000, alt: 5400, heading: 205, speed: 250 }, cam: [11, 2.5, -8], look: [0, 0, 0.5] },
    // air-to-air from behind-left and above at noon (upper surfaces + ground below)
    'a2a-noon-high': { tod: 'noon', jet: { x: 5000, z: -9000, alt: 5600, heading: 300, speed: 250 }, cam: [-9, 6, 14], look: [0, 0, -2] },
    // low level down the Drass valley, mid-morning
    'low-valley': { tod: 9.5, jet: { x: -24000, z: 8000, agl: 150, heading: 280, speed: 230 }, cam: [0, 5, 30], look: [0, -8, -400] },
    // cockpit, noon, heading east over Kargil
    cockpit: { tod: 'noon', mode: 'cockpit', jet: { x: -2000, z: -3000, alt: 5200, heading: 70, speed: 250 } },
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // the hold timer lives on window so re-loading this script stops the old one
  const state = { name: null };

  function stop() {
    if (window.__benchTimer) clearInterval(window.__benchTimer);
    window.__benchTimer = null;
  }
  stop();

  async function pose(name, { settle = 4500, cloudTime = 600 } = {}) {
    const g = window.__game;
    const T = g.camera.constructor; // eslint-disable-line no-unused-vars
    const p = POSES[name];
    if (!p) throw new Error(`no pose ${name}`);
    stop();
    state.name = name;
    const ui = document.getElementById('ui');
    if (ui) ui.style.display = 'none';
    const dev = document.getElementById('dev-overlay');
    if (dev) dev.style.display = 'none';
    try { g.systems.combat.world.god = true; } catch { /* no combat */ }
    g.paused = false;
    g.cameraRig.devHold = false;
    g.cameraRig.setMode(p.mode === 'cockpit' ? 'cockpit' : 'chase');
    // weather first (time presets then apply their own overrides); a fixed
    // date unless the time preset carries one (the moonlit night)
    g.env.setPreset(p.weather ?? 'default');
    const dated = typeof p.tod === 'string' && /night/.test(p.tod);
    g.env.setTimeOfDay(p.tod, dated ? undefined : { date: p.date ?? DATE });
    g.env.timeScale = 0;
    g.spawnAt(p.jet);
    await sleep(3000);
    // capture the rig's jet-local camera (cockpit view: the pilot eye)
    const V = g.camera.position.constructor;
    const Q = g.camera.quaternion.constructor;
    g.player.group.updateMatrixWorld(true);
    const inv = g.player.group.matrixWorld.clone().invert();
    const localPos = g.camera.position.clone().applyMatrix4(inv);
    const jq = new Q(); g.player.group.getWorldQuaternion(jq);
    const localQ = jq.clone().invert().multiply(g.camera.quaternion.clone());
    g.paused = true;
    g.spawnAt(p.jet);
    g.player.group.updateMatrixWorld(true);
    g.cameraRig.devHold = true;
    if (g.env.clouds) g.env.clouds.time = cloudTime;
    const cam = g.camera;
    const tmp = new V();
    const tq = new Q();
    const tick = () => {
      const m = g.player.group.matrixWorld;
      if (p.cam) {
        cam.position.set(...p.cam).applyMatrix4(m);
        cam.up.set(0, 1, 0);
        cam.lookAt(tmp.set(...p.look).applyMatrix4(m));
      } else {
        cam.position.copy(localPos).applyMatrix4(m);
        g.player.group.getWorldQuaternion(tq);
        cam.quaternion.copy(tq).multiply(localQ);
      }
      cam.updateMatrixWorld(true);
      if (g.env.clouds) g.env.clouds.time = cloudTime;
      g.post.setFrameState({ airspeed: 0, agl: 1e4, mach: 0, streaks: 0, shock: 0, shockAmp: 0, water: null, dof: null });
      g.env.update(1e-3, cam, g.player.group.position);
      g.terrain.update(cam);
      try { g.systems.atmosphere?.update?.(1e-3, g); } catch { /* optional */ }
      try { g.systems.timeofday?.update?.(1e-3, g); } catch { /* optional */ }
    };
    tick();
    window.__benchTimer = setInterval(tick, 0);
    await sleep(settle);
    return { name, ev: g.post.stats.ev, avgLog2: g.post.stats.avgLog2, hours: g.env.timeOfDay.hours, sunEl: g.env.timeOfDay.state.sun.elevation };
  }

  function release() {
    stop();
    const g = window.__game;
    g.cameraRig.devHold = false;
    g.paused = false;
    const ui = document.getElementById('ui');
    if (ui) ui.style.display = '';
  }

  window.__bench = { POSES, pose, release, stop, names: Object.keys(POSES) };
  return Object.keys(POSES);
})();
