// DEV ONLY (installed from dev/index.js behind `import.meta.env.DEV`).
//
// Frame-exact video capture: the game is stepped by exactly 1/fps per frame,
// whatever the frame actually costs to render, and each rendered frame is
// saved through the dev server (tools/capture/vite-capture.mjs) to
// captures/<clip>/00000.jpg ... Encode with tools/capture/encode.mjs.
//
//   await __capture.record({ clip: 'ridge', seconds: 4 })
//   await __capture.record({ clip: 'launch', seconds: 3, each: (t, i) => { if (i === 10) fire(); } })
//   __capture.step(seconds)      advance without saving (set a scene up)
//
// The tab must be visible (a background tab never presents its canvas; a
// separate window works). Size the viewport to the output first (e.g.
// 1920 x 1080 at DPR 1). The
// animation loop is stopped for the duration and restored afterwards;
// adaptive resolution is switched off, and post-processing runs on the fixed
// frame time (PostFX.fixedDt) so motion blur matches the footage.

export function installCapture(game) {
  const r = game.r;
  const canvas = r.renderer.domElement;
  let busy = false;

  const hold = () => {
    r.renderer.setAnimationLoop(null);
    window.__perf?.adaptive?.setEnabled(false);
  };
  const release = () => {
    game.post.fixedDt = undefined;
    const loop = window.__perf?.loop;
    if (loop) r.renderer.setAnimationLoop(loop);
  };

  const frame = (dt) => {
    // a tab that loses focus auto-pauses the flow; nobody is there to resume
    if (game.flow.state === 'pause') game.flow.resume();
    game.update(dt);
    game.post.fixedDt = dt;
    game.post.render();
  };

  // canvas.toBlob on the WebGPU canvas costs ~1 s a frame (it waits on the
  // compositor); createImageBitmap snapshots it at once. The bitmap goes to a
  // worker that encodes and uploads, so frames pipeline (a few in flight).
  const workerSrc = `
    let cv = null, ctx = null;
    onmessage = async (e) => {
      const { id, bitmap, type, quality, url } = e.data;
      try {
        if (!cv || cv.width !== bitmap.width || cv.height !== bitmap.height) { cv = new OffscreenCanvas(bitmap.width, bitmap.height); ctx = cv.getContext('2d'); }
        ctx.drawImage(bitmap, 0, 0);
        bitmap.close();
        const blob = await cv.convertToBlob({ type, quality });
        const res = await fetch(url, { method: 'POST', body: blob });
        postMessage({ id, ok: res.ok, err: res.ok ? null : res.status + ' ' + (await res.text()) });
      } catch (err) { postMessage({ id, ok: false, err: String(err && err.message || err) }); }
    };`;
  let worker = null;
  const pending = new Map();
  let nextId = 0;
  const encoder = () => {
    if (worker) return worker;
    worker = new Worker(URL.createObjectURL(new Blob([workerSrc], { type: 'text/javascript' })));
    worker.onmessage = (e) => { const p = pending.get(e.data.id); pending.delete(e.data.id); if (p) (e.data.ok ? p.res() : p.rej(new Error(e.data.err))); };
    return worker;
  };
  const send = (bitmap, type, quality, url) => new Promise((res, rej) => {
    const id = nextId++;
    pending.set(id, { res, rej });
    encoder().postMessage({ id, bitmap, type, quality, url: new URL(url, location.href).href }, [bitmap]);
  });

  const api = {
    /** Advance `seconds` at `fps` (rendered, not saved): settle a scene, let terrain stream in. */
    // Driven by the renderer's animation loop, like record(): frame-based
    // nodes (the clouds' temporal resolve, TRAA history) only advance on its
    // ticks, so a plain loop of renders left them frozen through the lead-in.
    async step(seconds, fps = 30) {
      if (busy) throw new Error('capture busy');
      busy = true;
      hold();
      const n = Math.round(seconds * fps);
      let i = 0;
      return await new Promise((resolve, reject) => {
        const done = (err) => { r.renderer.setAnimationLoop(null); busy = false; release(); if (err) reject(err); else resolve(); };
        r.renderer.setAnimationLoop(() => {
          if (i >= n) return done(null);
          try { frame(1 / fps); r.poll?.(); } catch (e) { return done(e); }
          i++;
        });
      });
    },

    /**
     * Record `seconds` of footage to captures/<clip>/.
     * opts: fps (30), format ('jpg' | 'png'), quality (0.93), each(t, i) before
     * every frame's update.
     */
    async record({ clip, seconds, fps = 30, format = 'jpg', quality = 0.93, each = null } = {}) {
      if (!clip) throw new Error('clip name required');
      if (busy) throw new Error('capture busy');
      busy = true;
      window.__perf?.adaptive?.setEnabled(false);
      const type = format === 'png' ? 'image/png' : 'image/jpeg';
      const ext = format === 'png' ? 'png' : 'jpg';
      const n = Math.round(seconds * fps);
      const t0 = performance.now();
      // Driven by the renderer's own animation loop, like a normal frame. The
      // canvas is snapshotted in the same task as its render: once the
      // compositor has presented a WebGPU canvas, reading it back gives the
      // old or an empty frame. The tab must be visible (a background tab
      // never runs the loop).
      return await new Promise((resolve, reject) => {
        const inflight = new Set();
        let i = 0;
        let failed = null;
        const finish = (err) => {
          r.renderer.setAnimationLoop(null);
          Promise.all(inflight).then(() => {
            busy = false;
            release();
            if (err) reject(err);
            else resolve({ clip, frames: n, fps, seconds: n / fps, wallSeconds: +((performance.now() - t0) / 1000).toFixed(1), size: [canvas.width, canvas.height] });
          }, (e) => { busy = false; release(); reject(e); });
        };
        const tick = () => {
          if (failed) return finish(failed);
          if (i >= n) return finish(null);
          if (inflight.size >= 6) return; // let the encoder catch up
          let snap;
          try {
            each?.(i / fps, i);
            frame(1 / fps);
            snap = createImageBitmap(canvas);
            r.poll?.();
          } catch (e) { return finish(e); }
          const k = i++;
          const p = snap
            .then((bm) => send(bm, type, quality, `/__capture/frame?clip=${encodeURIComponent(clip)}&i=${k}&ext=${ext}`))
            .catch((e) => { failed = e; })
            .finally(() => inflight.delete(p));
          inflight.add(p);
        };
        r.renderer.setAnimationLoop(tick);
      });
    },
  };
  window.__capture = api;
  return api;
}
