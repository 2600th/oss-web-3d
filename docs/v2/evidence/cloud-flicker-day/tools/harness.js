(() => {
  const g = window.__game, T = window.__trailer, C = window.__capture;
  const c = g.env.clouds;
  const half = (h) => { // float16 -> number
    const e = (h & 0x7c00) >> 10, f = h & 0x03ff, s = h & 0x8000 ? -1 : 1;
    if (e === 0) return s * 2 ** -14 * (f / 1024);
    if (e === 31) return f ? NaN : s * Infinity;
    return s * 2 ** (e - 15) * (1 + f / 1024);
  };
  const cv = new OffscreenCanvas(1, 1);
  const pendings = [];
  // mask of the frame rendered last: R = cloud opacity, G = 0 near (<400 m: the jet), 128 terrain, 255 sky, B = cloud front km * 2
  const saveMask = (clip, k) => {
    const rt = c.history[1 - c._write];
    const w = rt.width, h = rt.height;
    const p = g.r.renderer.readRenderTargetPixelsAsync(rt, 0, 0, w, h, 1).then(async (px) => {
      if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
      const ctx = cv.getContext('2d');
      const img = ctx.createImageData(w, h);
      const isF32 = px instanceof Float32Array;
      const v = (i) => (isF32 ? px[i] : half(px[i]));
      for (let i = 0; i < w * h; i++) {
        const front = v(i * 4), lim = v(i * 4 + 1), op = v(i * 4 + 2);
        img.data[i * 4] = Math.max(0, Math.min(255, op * 255));
        img.data[i * 4 + 1] = lim < 0.4 ? 0 : lim > 900 ? 255 : 128;
        img.data[i * 4 + 2] = Math.max(0, Math.min(255, front * 2));
        img.data[i * 4 + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
      const blob = await cv.convertToBlob({ type: 'image/png' });
      await fetch(`/__capture/frame?clip=${clip}_mask&i=${k}&ext=png`, { method: 'POST', body: blob });
    });
    pendings.push(p);
  };
  const restore = () => { g.post.fixedDt = undefined; const loop = window.__perf?.loop; if (loop) g.r.renderer.setAnimationLoop(loop); };
  const hold = () => { g.r.renderer.setAnimationLoop(null); window.__perf?.adaptive?.setEnabled(false); };
  const M = {
    each: null,
    // One game frame of exactly 1/30 s, like __capture's. Every FRAME-type node (cloud march and resolve, TRAA,
    // render-to-texture passes) runs once per three.js node frame, and that only advances from the animation
    // loop: a plain render loop has to advance it itself or those passes stay frozen.
    tick(dt = 1 / 30) {
      if (g.flow.state === 'pause') g.flow.resume();
      g.update(dt);
      g.post.fixedDt = dt;
      g.r.renderer._nodes.nodeFrame.update();
      g.post.render();
      g.r.poll?.();
    },
    async step(seconds) {
      hold();
      const n = Math.round(seconds * 30);
      try { for (let i = 0; i < n; i++) { M.tick(); if (i % 4 === 3) await new Promise((r) => setTimeout(r, 0)); } } finally { restore(); }
    },
    // Same stepping as __capture.record (update 1/30, fixedDt, render, snapshot in the same task), but driven by
    // a plain loop instead of requestAnimationFrame, which a covered window throttles to 1 fps.
    async rec(clip, seconds = 2, { format = 'jpg', masks = true, official = false } = {}) {
      const n = Math.round(seconds * 30);
      if (official) {
        const r = await C.record({ clip, seconds, format, quality: 0.98, each: (t, i) => { M.each?.(i); if (masks && i > 0) saveMask(clip, i - 1); } });
        if (masks) saveMask(clip, n - 1);
        await Promise.all(pendings.splice(0));
        return r;
      }
      const canvas = g.r.renderer.domElement;
      const t0 = performance.now();
      hold();
      const oc = new OffscreenCanvas(canvas.width, canvas.height), octx = oc.getContext('2d');
      const type = format === 'png' ? 'image/png' : 'image/jpeg';
      try {
        for (let i = 0; i < n; i++) {
          M.each?.(i);
          M.tick();
          const bm = await createImageBitmap(canvas);
          octx.drawImage(bm, 0, 0); bm.close();
          const blob = await oc.convertToBlob({ type, quality: 0.98 });
          pendings.push(fetch(`/__capture/frame?clip=${clip}&i=${i}&ext=${format === 'png' ? 'png' : 'jpg'}`, { method: 'POST', body: blob }));
          if (masks) saveMask(clip, i);
          await Promise.all(pendings.splice(0));
        }
      } finally { restore(); }
      return { clip, frames: n, wallSeconds: +((performance.now() - t0) / 1000).toFixed(1) };
    },
    async start(m, time) { await T.sortie(m, time != null ? { time } : {}); c.time = 1000; c.weatherDirty = true; c.resetHistory(); },
    scenes: {
      async m2_chase() { await M.start('m2'); T.view('chase'); await M.step(4); },
      async m2_title0() { await M.start('m2'); T.cine('title', { startShot: 0, shift: 0 }); await M.step(2.5); },
      async m2_title3() { await M.start('m2'); T.cine('title', { startShot: 3, shift: 0 }); await M.step(2.5); },
      async m4_chase() { await M.start('m4'); T.view('chase'); await M.step(4); },
      async m4_title0() { await M.start('m4'); T.cine('title', { startShot: 0, shift: 0 }); await M.step(2.5); },
      async m4_title3() { await M.start('m4'); T.cine('title', { startShot: 3, shift: 0 }); await M.step(2.5); },
      async m1_chase() { await M.start('m1'); T.view('chase'); await M.step(4); },
      async m3_chase() { await M.start('m3'); T.view('chase'); await M.step(4); },
      async night_chase() { await M.start('night'); T.view('chase'); await M.step(4); },
      async m2_title1() { await M.start('m2'); T.cine('title', { startShot: 1, shift: 0 }); await M.step(1.2); },
      async m2_orbit() { await M.start('m2'); T.cine('orbit'); await M.step(2.5); },
      async m2_turn() { await M.start('m2'); g.autopilot = { intent: { turn: 0.8, climb: 0.5, yaw: 0, speed: 0, boost: false, brake: 0, throttle: 0.9 }, update() {} }; T.view('chase'); await M.step(3); },
      async m4_turn() { await M.start('m4'); g.autopilot = { intent: { turn: -0.8, climb: 0.5, yaw: 0, speed: 0, boost: false, brake: 0, throttle: 0.9 }, update() {} }; T.view('chase'); await M.step(3); },
      // a cut: the camera jumps to a new shot mid-clip (frame 20), as between two trailer shots
      async m2_cut() { await M.start('m2'); T.view('chase'); await M.step(4); M.each = (i) => { if (i === 20) T.cine('title', { startShot: 2, shift: 0 }); }; },
      async m4_cut() { await M.start('m4'); T.view('chase'); await M.step(4); M.each = (i) => { if (i === 20) T.cine('title', { startShot: 2, shift: 0 }); }; },
      // the start of a clip as a shot recipe makes it: headless fast-forward, pick the camera, record at once
      async m2_fresh() { await M.start('m2'); await T.sim(3); T.view('chase'); },
      async m2_high() { await M.start('m2'); g.spawnAt({ x: -14000, z: 4000, agl: 1500, speed: 240, heading: 270 }); T.view('chase'); await M.step(4); },
    },
    async rayProbe(scene = 'm4_chase', N = 40) {
      const R = g.r.renderer, post = g.post;
      await M.scenes[scene]();
      hold();
      const rays = post._rays.renderTarget, mask = post._rays.mask.renderTarget;
      const fr = [], fm = [];
      const lum = (px, n) => { const o = new Float32Array(n); for (let i = 0; i < n; i++) o[i] = px instanceof Float32Array ? px[i * 4 + 1] : half(px[i * 4 + 1]); return o; };
      try {
        for (let i = 0; i < N; i++) {
          M.tick();
          const a = await R.readRenderTargetPixelsAsync(rays, 0, 0, rays.width, rays.height);
          const b = await R.readRenderTargetPixelsAsync(mask, 0, 0, mask.width, mask.height);
          fr.push(lum(a, rays.width * rays.height)); fm.push(lum(b, mask.width * mask.height));
        }
      } finally { restore(); }
      const stat = (F, w, h) => {
        const n = w * h; const tot = F.map((f) => { let t = 0; for (let i = 0; i < n; i++) t += f[i]; return t / n; });
        let best = -1, bi = 0, pm = 0;
        for (let i = 0; i < n; i++) { let p = 0; for (let t = 1; t < F.length - 1; t++) { const d1 = F[t][i] - F[t - 1][i], d3 = F[t + 1][i] - F[t][i]; if (d1 * d3 < 0) p += Math.min(Math.abs(d1), Math.abs(d3)); } p /= F.length - 2; pm += p; if (p > best) { best = p; bi = i; } }
        let tp = 0; for (let t = 1; t < tot.length - 1; t++) { const d1 = tot[t] - tot[t - 1], d3 = tot[t + 1] - tot[t]; if (d1 * d3 < 0) tp += Math.min(Math.abs(d1), Math.abs(d3)); }
        return { mean: +tot[0].toFixed(4), popMean: +(pm / n).toFixed(5), popOverMeanPct: +(100 * pm / n / tot[0]).toFixed(2), totalPopPct: +(100 * tp / (tot.length - 2) / tot[0]).toFixed(3), worst: { x: bi % w, y: (bi / w) | 0, pop: +best.toFixed(4), series: F.slice(0, 16).map((f) => +f[bi].toFixed(2)) } };
      };
      return { strength: +post.uniforms.godRays.value.toFixed(3), rays: stat(fr, rays.width, rays.height), mask: stat(fm, mask.width, mask.height) };
    },
    go(...a) { window.__mres = null; M.run(...a).then((r) => { window.__mres = r; }, (e) => { window.__mres = 'ERR ' + String(e.stack || e); }); return 'started'; },
    async run(tag, names, seconds = 2, opts = {}) {
      const out = {};
      for (const n of names) {
        M.each = null; g.autopilot = null;
        await M.scenes[n]();
        g.post.options.grain = opts.grain ?? false; g.post.options.motionBlur = opts.mb ?? 1;
        opts.setup?.();
        if (opts.setup) await M.step(1);
        out[n] = await M.rec(`${tag}_${n}`, seconds, opts);
        M.each = null; g.autopilot = null;
        out[n].cam = g.camera.position.toArray().map(Math.round);
        out[n].cloudTime = +c.time.toFixed(2);
      }
      return out;
    },
  };
  window.__m = M;
  return 'ok';
})()
