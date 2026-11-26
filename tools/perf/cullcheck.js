// Checks the two culling shortcuts against the real scene: flies a set of poses
// (chase and cockpit views) and asserts on every frame that
//  - no terrain surface and no shadow-receiving mesh lies in the depth slice of a
//    sun cascade that was not redrawn (SunShadows._markReceivers), and
//  - no terrain is visible within the AO range while the AO prepass draws no
//    terrain block (Terrain near layer).
// Terrain is found by marching view rays against terrainHeight(); meshes by the
// view depth of their box corners. All the *Viol counts must be 0.
// Dev build, ?mission=free; set window.__valCombat = true to add the VFX test.
//   evaluate_script({ sourcePath: 'tools/perf/cullcheck.js' })
async () => {
  const g = window.__game; const node = g.env.sunShadows.node; const t = g.terrain;
  const { terrainHeight } = await import('/src/world/terrain/heightfield.js');
  window.__trailer?.god?.(true);
  const cam = g.camera;
  const V = cam.position.constructor;
  const p = new V(), q = new V();
  const stats = { frames: 0, cascadeSkips: [0, 0, 0, 0], terrainViol: 0, meshViol: 0, aoSkipFrames: 0, aoViol: 0, samples: 0, detail: [] };
  let seed = 12345; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  const poses = [
    { x: -36450, z: 1860, agl: 700, heading: 270, speed: 230 }, { x: -36450, z: 1860, agl: 250, heading: 200, speed: 200 },
    { x: -30000, z: 3000, agl: 160, heading: 90, speed: 200 }, { x: -30000, z: 3000, agl: 420, heading: 10, speed: 220 },
    { x: -33000, z: 500, agl: 350, heading: 135, speed: 210 }, { x: -38000, z: 4000, agl: 500, heading: 315, speed: 240 },
    { x: -34500, z: 2500, agl: 300, heading: 60, speed: 200 }, { x: -36450, z: 1860, agl: 1200, heading: 90, speed: 230 },
  ];
  const views = ['chase', 'cockpit'];
  const check = () => {
    stats.frames++;
    cam.updateMatrixWorld();
    const need = node.needed, lo = node._lo, hi = node._hi;
    const tanY = Math.tan(cam.fov * Math.PI / 360) / (cam.zoom || 1), tanX = tanY * cam.aspect;
    // --- terrain against skipped cascades and the AO near range: march view rays
    let nearAny = false; t.group.traverse((o) => { if (o.isMesh && o.visible && (o.layers.mask & 8)) nearAny = true; });
    if (t.nearRange > 0 && !nearAny) stats.aoSkipFrames++;
    for (let i = 0; i < need.length; i++) if (!need[i]) stats.cascadeSkips[i]++;
    for (let s = 0; s < 160; s++) {
      const nx = (rnd() * 2 - 1) * tanX, ny = (rnd() * 2 - 1) * tanY;
      let wasAbove = true; let prevD = 0;
      for (let d = 2; d <= 900; d += d < 120 ? 4 : d < 300 ? 8 : 20) {
        p.set(nx * d, ny * d, -d).applyMatrix4(cam.matrixWorld);
        const above = p.y > terrainHeight(p.x, p.z);
        stats.samples++;
        if (wasAbove && !above) {
          // first hit between prevD and d
          for (let i = 0; i < need.length; i++) if (!need[i] && d >= lo[i] + 0.5 && prevD <= hi[i] - 0.5) { stats.terrainViol++; if (stats.detail.length < 5) stats.detail.push({ kind: 'cascade', i, d, pose: [cam.position.x | 0, cam.position.y | 0, cam.position.z | 0] }); }
          if (t.nearRange > 0 && !nearAny && d <= Math.min(cam.far, t.nearRange)) { stats.aoViol++; if (stats.detail.length < 5) stats.detail.push({ kind: 'ao', d }); }
          break;
        }
        wasAbove = above; prevD = d;
      }
    }
    // --- meshes against skipped cascades: exact corner depths
    const e = cam.matrixWorldInverse.elements;
    g.scene.traverseVisible((o) => {
      if (!o.isMesh || !o.receiveShadow || !(o.layers.mask & cam.layers.mask)) return;
      for (let a = o; a; a = a.parent) if (a.userData.cascadeReceiver) return;
      const bb = o.geometry.boundingBox; if (!bb) return;
      let dmin = Infinity, dmax = -Infinity;
      for (let c = 0; c < 8; c++) { q.set(c & 1 ? bb.max.x : bb.min.x, c & 2 ? bb.max.y : bb.min.y, c & 4 ? bb.max.z : bb.min.z).applyMatrix4(o.matrixWorld).applyMatrix4(cam.matrixWorldInverse); dmin = Math.min(dmin, -q.z); dmax = Math.max(dmax, -q.z); }
      for (let i = 0; i < need.length; i++) if (!need[i] && dmax >= lo[i] + 0.5 && dmin <= hi[i] - 0.5) { stats.meshViol++; if (stats.detail.length < 5) stats.detail.push({ kind: 'mesh', i, name: o.name, dmin, dmax }); }
    });
  };
  for (const pose of poses) for (const view of views) {
    g.spawnAt(pose); window.__trailer?.view?.(view);
    if (window.__valCombat) window.__vfxTest('combat');
    await new Promise(r => setTimeout(r, 300));
    const t0 = performance.now();
    while (performance.now() - t0 < 2200) { await new Promise(r => requestAnimationFrame(r)); check(); }
  }
  window.__trailer?.view?.('chase');
  return stats;
}
