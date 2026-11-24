// In-page helper for HUD legibility captures (dev server, window.__game).
// Load it with the chrome-devtools `evaluate_script` sourcePath (format
// "script"); it installs window.__hudLeg:
//
//   __hudLeg.freeze()            pause the game (the scene keeps rendering, still;
//                                the HUD keeps what redraw() last drew)
//   __hudLeg.redraw(boost)       redraw only the HUD over that frame; boost 0 =
//                                the night (pre-change) halos, 1 = full day,
//                                null = automatic (metered)
//   __hudLeg.capture()           { png: HUD canvas data URL, regions: [...] }
//                                for tools/hud/hud-contrast.mjs
//   __hudLeg.resume()            unpause
(() => {
  const g = window.__game;
  const hud = g.ui.hud;
  window.__hudLeg = {
    freeze() { g.paused = true; },
    resume() { g.paused = false; },
    redraw(boost = null, ownJet = true, showJet = false) {
      hud.haloBoost = boost;
      hud.ownJetObstacle = ownJet;
      hud.update(0, g);
      if (showJet) {
        // debug: outline the own-jet label obstacles
        const ctx = hud.ctx;
        ctx.save();
        ctx.setLineDash([6, 4]);
        ctx.strokeStyle = '#ff00ff';
        ctx.lineWidth = 1.5;
        for (let i = 0; i < (hud._jetCount ?? 0); i++) { const r = hud._jetRects[i]; ctx.strokeRect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0); }
        ctx.restore();
      }
      return { k: hud._dayK, stats: g.post?.stats ? { adaptedLog2: g.post.stats.adaptedLog2, ev: g.post.stats.ev } : null };
    },
    capture() {
      const L = hud.layout;
      const s = L.s;
      const half = L.tapeH / 2;
      const R = [];
      const add = (name, x0, y0, x1, y1) => R.push({ name, x0, y0, x1, y1 });
      add('speed tape', L.speed.x - 52 * s, L.speed.y - half, L.speed.x + 3, L.speed.y - 16 * s);
      add('speed tape low', L.speed.x - 52 * s, L.speed.y + 16 * s, L.speed.x + 3, L.speed.y + half);
      add('alt tape', L.alt.x - 3, L.alt.y - half, L.alt.x + 68 * s, L.alt.y - 16 * s);
      add('alt tape low', L.alt.x - 3, L.alt.y + 16 * s, L.alt.x + 68 * s, L.alt.y + half);
      add('tape tags', L.speed.x - 90 * s, L.speed.y - half - 18 * s, L.speed.x - 40 * s, L.speed.y - half - 2 * s);
      add('throttle', L.speed.x - 80 * s, L.speed.y - L.tapeH * 0.1, L.speed.x - 68 * s, L.speed.y + L.tapeH * 0.42 + 16 * s);
      add('G / R row', L.speed.x - 64 * s, L.speed.y + half + 10 * s, L.speed.x, L.speed.y + half + 30 * s);
      add('heading tape', L.heading.x - L.heading.w / 2, L.heading.y - 2, L.heading.x + L.heading.w / 2, L.heading.y + 19 * s);
      add('ladder', L.cx - 320 * s, L.cy - L.ladderR, L.cx + 320 * s, L.cy + L.ladderR);
      add('objective', L.objective.x, L.objective.y - 2, L.objective.x + Math.min(360 * s, L.w * 0.3), L.objective.y + 40 * s);
      add('edge arrows L', 0, L.bounds.T + 60 * s, L.arrowInset + 90 * s, L.radar.y - L.radar.r - 12 * s);
      add('edge arrows R', L.w - L.arrowInset - 90 * s, L.bounds.T + 90 * s, L.w, L.weapons.y - 140 * s);
      add('airframe', L.health.x - 2, L.health.y - 34 * s, L.health.x + 190 * s, L.health.y + 2);
      add('score', L.score.x - 150 * s, L.score.y, L.score.x + 2, L.score.y + 60 * s);
      // on-screen target markers with their labels (nearest four)
      const me = g.flight.position;
      const ts = (g.hud?.targets ?? []).filter((t) => t.position && t.alive !== false)
        .map((t) => ({ t, d: Math.hypot(t.position.x - me.x, t.position.y - me.y, t.position.z - me.z) }))
        .sort((a, b) => a.d - b.d);
      const p = { x: 0, y: 0 };
      let n = 0;
      for (const { t } of ts) {
        hud._project(t.position.x, t.position.y, t.position.z, p, 6);
        if (!p.onScreen) continue;
        add(`marker ${t.name ?? t.kind ?? n}`, p.x - 80 * s, p.y - 50 * s, p.x + 80 * s, p.y + 50 * s);
        if (++n >= 4) break;
      }
      return { png: hud.canvas.toDataURL('image/png'), regions: R, w: L.w, h: L.h };
    },
  };
})();
