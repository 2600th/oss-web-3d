/*
 * Benchmark poses for the MiG skin pass. Dev tool, not shipped.
 * Load docs/v2/evidence/polish-realism/bench.js first (classic script), then
 * this file; it adds poses to `__bench.POSES`. Then
 * `await __bench.pose('mig-chase-noon')` and screenshot.
 *
 * cam / look are jet-local (nose -Z, up +Y, right +X), in metres.
 * `await __bench.hostiles()` parks a hostile LOD0 22 m off the left wing and a
 * hostile LOD1 22 m off the right wing for the two `hostile` poses.
 */
(() => {
  const noon = { tod: 'noon', jet: { x: 5000, z: -9000, alt: 5600, heading: 120, speed: 250 } };
  const gold = { tod: 'golden', jet: { x: 10000, z: -15000, alt: 5400, heading: 205, speed: 250 } };
  Object.assign(window.__bench.POSES, {
    // chase, 12 m behind and a little above
    'mig-chase-noon': { ...noon, cam: [0, 2.4, 12], look: [0, 0.1, -2] },
    'mig-chase-golden': { ...gold, cam: [1.5, 2.4, 12], look: [0, 0.1, -2] },
    // close side pass, 9.5 m abeam: sunlit side, shaded side, golden hour
    'mig-side-noon': { ...noon, cam: [9.5, 0.6, -0.5], look: [0, -0.1, 0.3] },
    'mig-side-shade': { ...noon, cam: [-9.5, 0.6, -0.5], look: [0, -0.1, 0.3] },
    'mig-side-golden': { ...gold, cam: [9.5, 0.8, -0.5], look: [0, -0.1, 0.3] },
    // rear quarter: nozzle, rear fuselage, stabilators
    'mig-nozzle': { ...noon, cam: [2.6, 1.2, 10.5], look: [0, -0.5, 6] },
    // nose: intake, shock cone, canopy
    'mig-nose': { ...noon, cam: [2.6, 0.5, -8.6], look: [0, -0.5, -5] },
    // from below: belly, pylons, gear doors, wing roots, gun pack
    'mig-belly': { ...noon, cam: [4.5, -4.5, -2], look: [0, -0.6, 1] },
    // from above: wing root walkway, spine, canopy
    'mig-top': { ...noon, cam: [3.5, 5.5, 1.5], look: [0, 0, 0] },
    // canopy and forward fuselage
    'mig-canopy': { ...noon, cam: [2.6, 1.3, -5.2], look: [0, 0.2, -2.6] },
    'mig-canopy-close': { ...noon, cam: [1.9, 0.9, -4.6], look: [0, 0.1, -2.9], fov: 45 },
    'mig-canopy-golden': { ...gold, cam: [2.6, 1.3, -5.2], look: [0, 0.2, -2.6] },
    // skin at 3 m: panel lines, rivets, streaks on the fuselage side over the wing root
    'mig-skin-close': { ...noon, cam: [3.2, 0.5, 0.2], look: [0.6, -0.5, 1.4], fov: 40 },
    // cockpit: pilot eye, looking down at the panel; and forward at golden hour
    'mig-cockpit-panel': { ...noon, mode: 'cockpit', cam: [0, 0.22, -2.95], look: [0, -0.12, -3.6] },
    'mig-cockpit-golden': { ...gold, mode: 'cockpit' },
    // hostile LOD0 and LOD1 (see hostiles())
    hostile: { ...noon, cam: [-12.5, 0.6, -0.5], look: [-22, -0.1, 0.3] },
    'hostile-lod1': { ...noon, cam: [12.5, 0.6, -0.5], look: [22, -0.1, 0.3] },
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
        const g = window.__game, c = g.camera;
        if (c.fov !== fov) { c.fov = fov; c.updateProjectionMatrix(); }
        // debug hostiles ride with the (re-spawned) player
        for (const [name2, x] of [['dbg-hostile0', -22], ['dbg-hostile1', 22]]) {
          const h = g.scene.getObjectByName(name2);
          if (!h) continue;
          h.position.set(x, 0, 0).applyMatrix4(g.player.group.matrixWorld);
          h.quaternion.copy(g.player.group.quaternion);
        }
      }, 0);
      return inner(name, opts);
    };
    pose.pinned = true;
    window.__bench.pose = pose;
  }

  window.__bench.hostiles = async () => {
    const g = window.__game;
    if (g.scene.getObjectByName('dbg-hostile0')) return;
    const { loadModel } = await import('/src/assets/loadModel.js');
    for (const lod of [0, 1]) {
      const h = await loadModel('mig21_hostile', { lod });
      h.name = `dbg-hostile${lod}`;
      g.scene.add(h);
    }
  };
  return Object.keys(window.__bench.POSES);
})();
