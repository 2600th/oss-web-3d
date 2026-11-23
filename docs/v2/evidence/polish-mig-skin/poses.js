/*
 * Extra benchmark poses for the MiG skin pass. Dev tool, not shipped.
 * Load docs/v2/evidence/polish-realism/bench.js first (classic script), then
 * this file; it adds poses to `__bench.POSES`. Then
 * `await __bench.pose('mig-chase-noon')` and screenshot.
 *
 * cam / look are jet-local (nose -Z, up +Y, right +X), in metres.
 */
(() => {
  const noon = { tod: 'noon', jet: { x: 5000, z: -9000, alt: 5600, heading: 120, speed: 250 } };
  const gold = { tod: 'golden', jet: { x: 10000, z: -15000, alt: 5400, heading: 205, speed: 250 } };
  Object.assign(window.__bench.POSES, {
    // the game's chase view distance, slightly above
    'mig-chase-noon': { ...noon, cam: [0, 3.2, 17], look: [0, 0.2, -2] },
    'mig-chase-golden': { ...gold, cam: [2.5, 3.0, 17], look: [0, 0.2, -2] },
    // close side pass, 9 m abeam, sunlit side and shaded side
    'mig-side-noon': { ...noon, cam: [9.5, 0.6, -0.5], look: [0, -0.1, 0.3] },
    'mig-side-shade': { ...noon, cam: [-9.5, 0.6, -0.5], look: [0, -0.1, 0.3] },
    'mig-side-golden': { ...gold, cam: [9.5, 0.8, -0.5], look: [0, -0.1, 0.3] },
    // rear quarter: nozzle, rear fuselage, stabilators
    'mig-nozzle': { ...noon, cam: [3.6, 1.5, 10.5], look: [0, -0.4, 5] },
    // nose: intake, shock cone, gun ports, canopy
    'mig-nose': { ...noon, cam: [3.2, 1.0, -9.5], look: [0, -0.2, -4] },
    // from below: belly, pylons, gear doors, wing roots
    'mig-belly': { ...noon, cam: [4.5, -4.5, -2], look: [0, -0.6, 1] },
    // top, wing root and walkway, canopy
    'mig-top': { ...noon, cam: [3.5, 5.5, 1.5], look: [0, 0, 0] },
    // canopy close
    'mig-canopy': { ...noon, cam: [2.6, 1.3, -5.2], look: [0, 0.2, -2.6] },
    'mig-canopy-golden': { ...gold, cam: [2.6, 1.3, -5.2], look: [0, 0.2, -2.6] },
    // cockpit: pilot eye, looking down at the panel
    'mig-cockpit-panel': { ...noon, mode: 'cockpit', cam: [0, 0.22, -2.95], look: [0, -0.12, -3.6] },
    'mig-cockpit-golden': { ...gold, mode: 'cockpit' },
  });
  // The rig's field of view moves with speed and with the spawn transition;
  // pin it so a pose frames the same on every load.
  const inner = window.__bench.pose;
  if (!inner.pinned) {
    const pose = async (name, opts) => {
      if (window.__fovTimer) clearInterval(window.__fovTimer);
      const p = window.__bench.POSES[name];
      const fov = p?.fov ?? (p?.mode === 'cockpit' ? 74 : 62);
      window.__fovTimer = setInterval(() => {
        const c = window.__game.camera;
        if (c.fov !== fov) { c.fov = fov; c.updateProjectionMatrix(); }
      }, 0);
      return inner(name, opts);
    };
    pose.pinned = true;
    window.__bench.pose = pose;
  }
  return Object.keys(window.__bench.POSES);
})();
