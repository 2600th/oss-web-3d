/**
 * Before/after evidence scenes for the VFX pass. Load after tools/vfx/capture.js:
 * each `await __scenes.<name>(t)` sets the frame up (paused, camera held) and
 * the caller takes the screenshot. Same script for before and after, so poses,
 * seeds and times match.
 */
(() => {
  const g = window.__game, C = window.__cap, T = window.__vfxTest;
  const V3 = g.flight.position.constructor;
  const vfx = () => g.systems.vfx;

  /** Kill every live effect: jump the VFX clock past every lifetime and drop the CPU emitters. */
  function clear() {
    const v = vfx();
    for (const e of T.entities()) e.alive = false;
    T.entities().length = 0;
    const em = v.emitters;
    for (const item of em.missiles.values()) item.trail.end();
    for (const item of em.flares.values()) item.trail.end();
    for (const item of em.damaged.values()) item.trail?.end();
    for (const w of em.wrecks) w.trail.end();
    em.missiles.clear(); em.flares.clear(); em.damaged.clear(); em.trails.clear();
    em.fires.length = 0; em.wrecks.length = 0; em.pending.length = 0; em.recentBlasts.length = 0;
    for (const d of v.explosions.debris.items) { d.trail?.end(); d.trail = null; d.owner = null; d.active = false; }
    v.explosions.pulses.length = 0;
    v.tracers.free.length = 0;
    v.lights.flashes.length = 0;
    if (v.bolts) v.bolts.clear?.();
    const b = g.systems.combat.world.bullets; b.n = 0;
    for (const m of g.systems.combat.world.missiles) m.alive = false;
    v.shared.time += 400;
    v.shared.u.time.value = v.shared.time;
    T('normal');
  }

  const base = { x: -14000, z: 4000, agl: 900, heading: 270, speed: 240 };
  const fixedCam = (from, to) => C.cam({ from: from.toArray(), to: to.toArray() });

  async function setup(opts = {}, seed = 11) {
    C.fire(false);
    clear();
    const r = await C.setup({ ...base, ...opts });
    clear();
    C.seed(seed);
    return r;
  }

  let H = null;
  import('/src/world/terrain/heightfield.js').then((m) => { H = m; });
  const ground = (dist, lateral = 0) => {
    const p = C.at(lateral, 0, -dist);
    p.y = H.terrainHeight(p.x, p.z);
    return p;
  };

  window.__scenes = {
    clear,
    // ---- gun ----
    async gunSide(tod = 13) {
      await setup({ tod });
      C.cam({ rel: [12, 1, -4], look: [0, -0.8, -5] });
      C.fire(true); await C.step(0.4);
    },
    async gunNight() { return this.gunSide(22.5); },
    async gunChase(tod = 13) {
      await setup({ tod });
      C.cam({ rel: [0, 2.6, 17], look: [0, 0, -80] });
      C.fire(true); await C.step(0.6);
    },
    // ---- afterburner ----
    async burner(view = 'dead6', tod = 13) {
      await setup({ tod });
      T('burner');
      const cams = {
        dead6: { rel: [0, -0.2, 17], look: [0, -0.6, 0] },
        zoom: { rel: [0, -0.4, 13.5], look: [0, -0.6, 6], fov: 30 },
        side: { rel: [9, 0, 9], look: [0, -0.6, 10] },
        quarter: { rel: [6, 1.6, 22], look: [0, -0.6, 8] },
      };
      C.cam(cams[view]);
      await C.step(0.6);
    },
    // ---- missiles ----
    async salvoSide(tod = 13, t = 1.5) {
      await setup({ tod });
      T('salvo');
      await C.step(t);
      // frame the salvo itself: from abeam, a little behind the heads
      const ms = T.entities().filter((e) => e.position && e.kind);
      const c = new V3();
      for (const m of ms) c.add(m.position);
      c.divideScalar(Math.max(1, ms.length));
      const p0 = C.at(0, 0, 0), ahead = C.at(0, 0, -1).sub(p0), right = C.at(1, 0, 0).sub(p0);
      const to = c.clone().addScaledVector(ahead, -260);
      const from = to.clone().addScaledVector(right, -560).addScaledVector(ahead, -120);
      from.y += 60;
      fixedCam(from, to);
    },
    async salvoDusk() { return this.salvoSide(18.7, 1.5); },
    async salvoChase(tod = 13, t = 2.5) {
      await setup({ tod });
      T('salvo');
      await C.step(t);
      C.cam({ rel: [0, 3, 22], look: [0, 0, -300] });
    },
    async salvoChaseNight() { return this.salvoChase(22.5, 2.5); },
    /** Low, end-on, a few kilometres down the trails: the near-plane wedge case. */
    async salvoLow(tod = 13) {
      await setup({ tod });
      T('salvo');
      await C.step(0.6);
      C.cam({ rel: [1.5, -1.2, 6], look: [0, -2, -400] });
    },
    // ---- explosions ----
    async airBurst(t = 0.6, size = 'medium', dist = 150, tod = 13) {
      await setup({ tod });
      const p = C.at(0, 10, -dist - 260);
      const from = C.at(0, 0, -260);
      fixedCam(from, p);
      g.events.emit('explosion', { position: p, size, kind: 'air' });
      await C.step(t);
    },
    async groundBlast(t = 0.6, size = 'large', tod = 13) {
      await setup({ tod, agl: 260 });
      const p = ground(700);
      g.events.emit('explosion', { position: p, size, kind: 'ground' });
      const from = C.at(-180, 0, -150);
      fixedCam(from, new V3(p.x, p.y + 25, p.z));
      await C.step(t);
    },
    async fireColumn(t = 45, tod = 13) {
      await setup({ tod, agl: 600 });
      const p = ground(1500);
      g.events.emit('explosion', { position: p, size: 'large', kind: 'ground' });
      // first viewpoint (in a fixed order) that sees the base of the fire
      const base = new V3(p.x, p.y + 20, p.z);
      const cands = [[-250, 150, 300], [250, 150, 300], [-900, 250, -300], [900, 250, -300], [-1400, 350, -1500], [1400, 350, -1500], [0, 500, 900]];
      let from = C.at(...cands[0]);
      for (const c of cands) { const f = C.at(...c); if (H.lineOfSight(f, base)) { from = f; break; } }
      fixedCam(from, new V3(p.x, p.y + 300, p.z));
      await C.step(t);
    },
    async flak(t = 0.3, tod = 13) {
      await setup({ tod });
      const ps = [C.at(0, 40, -420), C.at(-35, 55, -470), C.at(28, 25, -500)];
      const from = C.at(0, 0, -260);
      fixedCam(from, ps[0]);
      g.events.emit('explosion', { position: ps[0], size: 'small', kind: 'flak' });
      await C.step(0.25);
      g.events.emit('explosion', { position: ps[1], size: 'small', kind: 'flak' });
      await C.step(0.2);
      g.events.emit('explosion', { position: ps[2], size: 'small', kind: 'flak' });
      await C.step(t);
    },
    async debris(t = 0.9, tod = 13) {
      await setup({ tod });
      const p = C.at(0, 0, -340);
      const from = C.at(30, 8, -260);
      fixedCam(from, p);
      g.events.emit('explosion', { position: p, size: 'medium', kind: 'air' });
      await C.step(t);
    },
    // ---- burning aircraft and kills ----
    async burning(t = 2.4, tod = 13) {
      await setup({ tod });
      T('burning', { offset: [60, 20, -160], delay: 3 });
      await C.step(t);
      C.cam({ rel: [100, 30, -95], look: [55, 18, -200] });
    },
    async kill(t = 4.7, tod = 13) {
      await setup({ tod });
      T('burning', { offset: [60, 20, -160], delay: 3 });
      await C.step(t);
      C.cam({ rel: [190, 60, 40], look: [60, -5, -170] });
    },
    // ---- flares ----
    async flares(t = 1.2, tod = 13) {
      await setup({ tod });
      T('flares');
      await C.step(t);
      C.cam({ rel: [70, 4, 225], look: [0, -18, 150] });
    },
    // ---- weather ----
    async lightning(tod = 21.5) {
      await setup({ tod, preset: 'storm', weather: { lightning: 0 } });
      const p = C.at(-900, 700, -2600);
      g.env.weather.strike(g.camera, p);
      C.cam({ rel: [0, 3, 22], look: [-300, 200, -1500] });
      await C.step(0.06);
    },
    async rain(tod = 13) {
      await setup({ tod, preset: 'storm', weather: { rain: 1 } });
      C.cam({ rel: [0, 0.25, -2.6], look: [0, 0.1, -200] });
      await C.step(0.6);
    },
    async cloud(tod = 13) {
      await setup({ tod });
      // hold the camera 'in cloud' (the world system rewrites env.inCloud
      // every frame from the cloud field; this pins it for the shot)
      const env = g.env;
      if (!Object.getOwnPropertyDescriptor(env, 'inCloud')?.get) {
        Object.defineProperty(env, 'inCloud', { get: () => (window.__capInCloud ?? null) ?? env._inCloudReal ?? 0, set: (x) => { env._inCloudReal = x; }, configurable: true });
      }
      window.__capInCloud = 0.9;
      setTimeout(() => { window.__capInCloud = null; }, 20000);
      C.cam({ rel: [0, 0.25, -2.6], look: [0, 0.1, -200] });
      await C.step(0.6);
    },
    async contrail(tod = 13) {
      await setup({ tod, agl: 4200, speed: 260 });
      await C.step(6);
      C.cam({ rel: [-260, 60, 700], look: [0, 0, 600] });
    },
    /** Chase camera flying inside its own contrail: the near-plane wedge case. */
    async contrailChase(tod = 13) {
      await setup({ tod, agl: 4200, speed: 260 });
      C.cam({ rel: [0, 3.5, 24], look: [0, 0, -120] });
      await C.step(6);
    },
  };

  /** [file name, scene, ...args]: the evidence set, shot identically before and after. */
  const SHOTS = [
    ['gun-side-day', 'gunSide', 13], ['gun-side-night', 'gunSide', 22.5], ['gun-chase', 'gunChase'],
    ['burner-dead6-day', 'burner', 'dead6', 13], ['burner-dead6-night', 'burner', 'dead6', 22.5],
    ['burner-zoom-day', 'burner', 'zoom', 13], ['burner-side-day', 'burner', 'side', 13], ['burner-quarter-night', 'burner', 'quarter', 22.5],
    ['salvo-side-day', 'salvoSide', 13, 1.5], ['salvo-side-dusk', 'salvoSide', 18.7, 1.5],
    ['salvo-chase-day', 'salvoChase', 13, 2.5], ['salvo-chase-night', 'salvoChase', 22.5, 2.5], ['salvo-low-day', 'salvoLow', 13],
    ['air-med-0.1s', 'airBurst', 0.1], ['air-med-0.6s', 'airBurst', 0.6], ['air-med-1.5s', 'airBurst', 1.5], ['air-med-5s', 'airBurst', 5],
    ['air-large-0.6s-dusk', 'airBurst', 0.6, 'large', 200, 18.7],
    ['ground-large-0.6s', 'groundBlast', 0.6], ['ground-large-2s', 'groundBlast', 2], ['ground-large-8s', 'groundBlast', 8],
    ['fire-column-45s', 'fireColumn', 45], ['flak-0.3s', 'flak', 0.3], ['flak-4s', 'flak', 4],
    ['debris-0.9s', 'debris', 0.9], ['burning-2.4s', 'burning', 2.4], ['kill-4.7s', 'kill', 4.7],
    ['flares-1.2s', 'flares', 1.2], ['lightning-night', 'lightning'], ['rain-cockpit', 'rain'], ['cloud-cockpit', 'cloud'],
    ['contrail', 'contrail'], ['contrail-chase', 'contrailChase'],
  ];
  window.__scenes.SHOTS = SHOTS;
  /** Run shots (names or a slice of SHOTS) and return { name: jpegDataUrl }. */
  window.__scenes.shoot = async (which) => {
    const list = typeof which === 'string' ? SHOTS.filter((s) => s[0].startsWith(which)) : which.map((n) => SHOTS.find((s) => s[0] === n) ?? n);
    const out = {};
    for (const [name, scene, ...args] of list) {
      await window.__scenes[scene](...args);
      out[name] = await C.grab();
    }
    C.fire(false);
    return out;
  };
  return Object.keys(window.__scenes);
})();
