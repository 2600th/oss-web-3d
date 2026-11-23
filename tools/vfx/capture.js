/**
 * Evidence capture rig for the VFX pass (paste into the page, or load with the
 * chrome-devtools `evaluate_script` `sourcePath`). Defines `window.__cap`:
 *
 *   await __cap.setup({ x, z, agl, heading, speed, tod, weather })
 *       spawn the player there, hold it level, set the time of day, fly 1.5 s
 *       unpaused so terrain streams, then freeze (game.paused + camera devHold)
 *   __cap.seed(n)               deterministic Math.random from here on
 *   __cap.cam(spec)             spec = { rel: [right, up, back], look: [r, u, b] }
 *                                    | { from: [x,y,z], to: [x,y,z] } | fn(game) -> {from, to}
 *                               re-applied every tick, with terrain.update and the
 *                               VFX camera uniforms, so a paused frame is coherent
 *   await __cap.step(seconds)   advance the simulation at 60 Hz (no rendering)
 *   __cap.fire(on)              hold / release the player's gun trigger (combat)
 *   __cap.at(r, u, b)           world point relative to the player
 *
 * The same script drives the before and after shots, so poses and times match.
 */
(() => {
  const g = window.__game;
  const T = window.__vfxTest;
  const V3 = g.flight.position.constructor;
  let spec = null;
  let timer = null;
  let grabRT = null;
  const fov0 = window.__capFov0 ??= g.camera.fov;
  const RT = g.post.scenePass.renderTarget.constructor; // THREE.RenderTarget
  const UBYTE = 1009; // THREE.UnsignedByteType
  const realRandom = Math.random;

  const frame = () => {
    const f = g.flight, q = f.orientation;
    return {
      p: f.position,
      fwd: new V3(0, 0, -1).applyQuaternion(q), up: new V3(0, 1, 0).applyQuaternion(q), right: new V3(1, 0, 0).applyQuaternion(q),
    };
  };
  const at = (r, u, b) => {
    const f = frame();
    return f.p.clone().addScaledVector(f.right, r).addScaledVector(f.up, u).addScaledVector(f.fwd, -b);
  };
  // `apply` only poses the camera; the VFX camera uniforms are refreshed by the
  // simulation's own lateUpdate (devCamera below runs first in it), so the
  // camera velocity that streaks rain and sparks is the real one.
  const apply = (cam = g.camera) => {
    if (!spec) return;
    let from, to;
    if (typeof spec === 'function') ({ from, to } = spec(g));
    else {
      from = spec.from ? new V3(...spec.from) : at(...spec.rel);
      to = spec.to ? new V3(...spec.to) : spec.look ? at(...spec.look) : g.flight.position.clone();
    }
    cam.position.copy(from);
    cam.up.set(0, 1, 0);
    cam.lookAt(to);
    const fov = spec.fov ?? fov0;
    if (cam.fov !== fov) { cam.fov = fov; cam.updateProjectionMatrix(); }
    cam.updateMatrixWorld();
    g.terrain?.update?.(cam);
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  window.__cap = {
    at,
    async setup({ x = -14000, z = 4000, agl = 900, heading = 270, speed = 240, tod = 13, weather = null, preset = 'default' } = {}) {
      Math.random = realRandom;
      g.systems.combat.world.god = true;
      // effects only: no HUD or menus over the frame
      for (const id of ['ui', 'dev-overlay']) { const el = document.getElementById(id); if (el) el.style.visibility = 'hidden'; }
      g.paused = false;
      g.timeScale = 1;
      g.cameraRig.devHold = false;
      spec = null;
      g.spawnAt({ x, z, agl, heading, speed });
      // a crash while the page sat idle ends the sortie: rearm and re-arm combat
      const c = g.systems.combat;
      c.resetForSortie();
      c.active = true;
      g.flight.crashed = false;
      // the held jet flies level through whatever terrain lies ahead: no
      // crashes (each one would raise its own blast and fire in the frame)
      g.flight.checkTerrainCollision = () => false;
      g.env.setPreset(preset);
      g.env.weather.set({ rain: 0, snow: 0, lightning: 0, ...(weather ?? {}) });
      g.env.setTimeOfDay(tod);
      T.hold(true, g.flight.position.y, speed);
      // straight and level, every frame (the harness hold only pins height)
      const q0 = g.flight.orientation.clone();
      const vfx = g.systems.vfx;
      const base = vfx._capBaseCam ??= vfx.devCamera;
      vfx.devCamera = (camera) => {
        const f = g.flight;
        f.orientation.copy(q0);
        if (f.rates?.set) f.rates.set(0, 0, 0);
        f.velocity.set(0, 0, -speed).applyQuaternion(q0);
        base?.(camera);
        apply(camera);
      };
      // no G-LOC greyout over the frame (the hold fights the flight model)
      const scr = g.systems.camera?.screen;
      if (scr) { scr.o.gOnset = 99; scr.o.negOnset = -99; scr.reset(); }
      // fly a second of sim time (works in a background tab, where the
      // animation loop is throttled), then let terrain stream in real time
      g.paused = true;
      await T.step(1.0);
      g.cameraRig.devHold = true;
      clearInterval(timer);
      timer = setInterval(apply, 0);
      spec = { rel: [0, 3, 20], look: [0, 0, -100] };
      for (let i = 0; i < 6; i++) { apply(); await sleep(250); }
      spec = null;
      return { pos: g.flight.position.toArray().map(Math.round) };
    },
    /**
     * Render the full post chain into a target a few times (temporal AA and
     * motion blur settle on a still frame) and read it back as a JPEG data
     * URL. Works in a background tab, where the canvas is not presented.
     */
    async grab(frames = 8, quality = 0.88) {
      const renderer = g.r.renderer;
      const src = renderer.domElement;
      const W = src.width, H = src.height;
      if (!grabRT || grabRT.width !== W || grabRT.height !== H) {
        grabRT?.dispose();
        grabRT = new RT(W, H, { type: UBYTE, depthBuffer: false });
      }
      for (let i = 0; i < frames; i++) {
        apply();
        renderer._nodes?.nodeFrame?.update?.();
        renderer.setRenderTarget(grabRT);
        g.post.render();
        renderer.setRenderTarget(null);
      }
      const px = await renderer.readRenderTargetPixelsAsync(grabRT, 0, 0, W, H);
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      const ctx = c.getContext('2d');
      const img = new ImageData(new Uint8ClampedArray(px.buffer, px.byteOffset, W * H * 4), W, H);
      if (g.r.backend !== 'webgpu') {
        const t = document.createElement('canvas'); t.width = W; t.height = H;
        t.getContext('2d').putImageData(img, 0, 0);
        ctx.translate(0, H); ctx.scale(1, -1); ctx.drawImage(t, 0, 0);
      } else ctx.putImageData(img, 0, 0);
      return c.toDataURL('image/jpeg', quality);
    },
    seed(n = 1) {
      let a = n >>> 0;
      Math.random = () => {
        a |= 0; a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    },
    unseed() { Math.random = realRandom; },
    cam(s) { spec = s; apply(); g.systems.vfx?.shared?.update(0, g); },
    async step(seconds) { const r = await T.step(seconds); apply(); return r; },
    fire(on) {
      // the input's virtual (touch) action set: independent of page focus
      if (on) g.input._virtual.add('fireGun'); else g.input._virtual.delete('fireGun');
    },
    release() { clearInterval(timer); spec = null; g.cameraRig.devHold = false; g.paused = false; Math.random = realRandom; },
  };
  return 'ok';
})();
