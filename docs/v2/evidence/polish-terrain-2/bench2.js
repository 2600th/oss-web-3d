/*
 * Fixed camera poses for the terrain / cloud pass (docs/v2/evidence/polish-terrain-2/).
 * Dev tool, not shipped. Load into a dev page (`?mission=free&quality=high`)
 * as a classic script (chrome-devtools `evaluate_script` with `sourcePath`,
 * format "script"), then `await __bench2.pose('valley-100m')` and screenshot.
 *
 * Unlike polish-realism/bench.js the camera is placed in world space (the jet
 * is parked 1.5 km above the ground well away from it and hidden), so a pose
 * looks at the same patch of ground whatever the jet does. While held, the
 * environment, the terrain LOD and the time-of-day glue keep ticking; the
 * cloud clock is pinned.
 */
(() => {
  const DATE = { year: 1999, month: 6, day: 21 };
  // cam: world x, z and either agl (above terrainHeight) or y. yaw: degrees,
  // 0 = north (-Z), 90 = east. pitch: degrees, negative = down.
  const POSES = {
    // Drass valley floor (fields and scrub by the river), mid-morning
    'valley-100m': { tod: 10.5, cam: { x: -24600, z: 8150, agl: 100 }, yaw: 250, pitch: -14 },
    // the same ground at noon from 60 m: what the scrub looks like close in
    'valley-50m': { tod: 12.2, cam: { x: -24600, z: 8150, agl: 50 }, yaw: 250, pitch: -18 },
    // a grassy / scree slope, 250 m, mid-afternoon
    'slope-250m': { tod: 15, cam: { x: -26300, z: 9000, agl: 250 }, yaw: 330, pitch: -30 },
    // a ridge seen from 1 km
    'ridge-1km': { tod: 11, cam: { x: -25000, z: 2600, y: 5250 }, yaw: 180, pitch: -12 },
    // river bank and gravel bars, 80 m
    'river-bank': { tod: 11.5, cam: { x: -28200, z: 7900, agl: 80 }, yaw: 270, pitch: -22 },
    // snow line breaking up into patches, 300 m
    snowline: { tod: 11, cam: { x: -22300, z: 300, y: 5300 }, yaw: 170, pitch: -14 },
    // golden hour, into the sun, clouds
    'golden-clouds': { tod: 'golden', cam: { x: -26000, z: 1500, y: 5500 }, yaw: 270, pitch: 2 },
    // storm over Kargil, afternoon
    storm: { weather: 'storm', tod: 15.75, cam: { x: 2000, z: -6000, y: 4300 }, yaw: 200, pitch: 4 },
    // moonlit night over the valley floor
    night: { tod: 'moonlit-night', cam: { x: -24600, z: 8150, agl: 120 }, yaw: 250, pitch: -14 },
    // noon at 200 m over valley scrub (the "oil puddle" case)
    'noon-200m': { tod: 12.5, cam: { x: -25200, z: 8350, agl: 200 }, yaw: 300, pitch: -20 },
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  function stop() {
    if (window.__bench2Timer) clearInterval(window.__bench2Timer);
    window.__bench2Timer = null;
  }
  stop();

  let hf = null;
  /** Wait for the boot screen to finish (posing during it stalls the first frame). */
  async function ready(timeout = 90000) {
    const t0 = performance.now();
    while (performance.now() - t0 < timeout) {
      if (window.__game?.terrain && !/SHADERS AND FIRST FRAME|SRTM ELEVATION/.test(document.body.innerText)) return true;
      await sleep(500);
    }
    return false;
  }
  async function pose(nameOrPose, { settle = 4000, cloudTime = 600 } = {}) {
    await ready();
    const g = window.__game;
    const p = typeof nameOrPose === 'string' ? POSES[nameOrPose] : nameOrPose;
    if (!p) throw new Error(`no pose ${nameOrPose}`);
    hf ??= { terrainHeight: (x, z) => window.__game.terrain.height(x, z) }; // the game's own module instance (HMR can split it)
    stop();
    for (const id of ['ui', 'dev-overlay']) { const el = document.getElementById(id); if (el) el.style.display = 'none'; }
    try { g.systems.combat.world.god = true; } catch { /* no combat */ }
    g.paused = false;
    g.cameraRig.devHold = false;
    g.env.setPreset(p.weather ?? 'default');
    const dated = typeof p.tod === 'string' && /night/.test(p.tod);
    g.env.setTimeOfDay(p.tod, dated ? undefined : { date: p.date ?? DATE });
    g.env.timeScale = 0;
    // park the jet far above the pose, out of view
    g.spawnAt({ x: p.cam.x + 3000, z: p.cam.z + 3000, agl: 1600, heading: 0, speed: 240 });
    await sleep(600);
    g.paused = true;
    g.cameraRig.devHold = true;
    if (g.player?.group) g.player.group.visible = false;
    if (g.env.clouds) g.env.clouds.time = cloudTime;
    const cam = g.camera;
    const y = p.cam.y ?? hf.terrainHeight(p.cam.x, p.cam.z) + p.cam.agl;
    const yaw = (p.yaw * Math.PI) / 180;
    const pitch = (p.pitch * Math.PI) / 180;
    const look = [p.cam.x + Math.sin(yaw) * Math.cos(pitch) * 1000, y + Math.sin(pitch) * 1000, p.cam.z - Math.cos(yaw) * Math.cos(pitch) * 1000];
    const tick = () => {
      cam.position.set(p.cam.x, y, p.cam.z);
      if (cam.fov !== (p.fov ?? 62) || cam.zoom !== 1) { cam.fov = p.fov ?? 62; cam.zoom = 1; cam.updateProjectionMatrix(); }
      cam.up.set(0, 1, 0);
      cam.lookAt(look[0], look[1], look[2]);
      cam.updateMatrixWorld(true);
      if (g.env.clouds) g.env.clouds.time = cloudTime;
      g.post.setFrameState?.({ airspeed: 0, agl: 1e4, mach: 0, streaks: 0, shock: 0, shockAmp: 0, water: null, dof: null });
      g.env.update(1e-3, cam, cam.position);
      g.terrain.update(cam);
      try { g.systems.atmosphere?.update?.(1e-3, g); } catch { /* optional */ }
      try { g.systems.timeofday?.update?.(1e-3, g); } catch { /* optional */ }
    };
    tick();
    window.__bench2Timer = setInterval(tick, 0);
    await sleep(settle);
    return { pose: nameOrPose.name ?? nameOrPose, y: Math.round(y), ground: Math.round(hf.terrainHeight(p.cam.x, p.cam.z)), hours: g.env.timeOfDay?.hours };
  }

  function release() {
    stop();
    const g = window.__game;
    g.cameraRig.devHold = false;
    g.paused = false;
    if (g.player?.group) g.player.group.visible = true;
    const ui = document.getElementById('ui');
    if (ui) ui.style.display = '';
  }

  window.__bench2 = { POSES, pose, ready, release, stop, names: Object.keys(POSES) };
  return Object.keys(POSES);
})();
