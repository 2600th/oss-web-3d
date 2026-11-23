/**
 * `?perfhud` overlay (dev and prod, off by default): GPU ms per pass category
 * and the top passes (timestamp queries), CPU ms per system, render scale,
 * draw calls, GPU resource counts and JS heap. Plain DOM, refreshed at 4 Hz,
 * pointer-events off so it never steals input. Toggle with Shift+F3.
 */
const CAT_ORDER = ['shadow', 'scene', 'sky/AP', 'clouds', 'vfx', 'post', 'other'];

export class PerfHud {
  constructor(perf) {
    this.perf = perf;
    const el = this.el = document.createElement('pre');
    el.id = 'perfhud';
    el.setAttribute('aria-hidden', 'true');
    Object.assign(el.style, {
      position: 'fixed', left: '8px', bottom: '8px', zIndex: 2147483000, margin: 0,
      padding: '8px 10px', font: '11px/1.35 ui-monospace, Consolas, monospace',
      color: '#d8f0ff', background: 'rgba(6, 12, 20, 0.78)', border: '1px solid rgba(140, 200, 255, 0.25)',
      borderRadius: '4px', pointerEvents: 'none', whiteSpace: 'pre', minWidth: '300px',
    });
    document.body.appendChild(el);
    this._t = 0;
    this._onKey = (e) => { if (e.code === 'F3' && e.shiftKey) { el.hidden = !el.hidden; e.preventDefault(); } };
    window.addEventListener('keydown', this._onKey);
  }

  update(dt) {
    this._t += dt;
    if (this._t < 0.25 || this.el.hidden) return;
    this._t = 0;
    const { r, profiler, adaptive, cpu } = this.perf;
    const renderer = r.renderer;
    const c = renderer.domElement;
    const lines = [];
    lines.push(`${r.backend} | ${r.tier.name} | ${c.width}x${c.height} @ ${(r.renderScale * 100).toFixed(0)}%${adaptive?.enabled ? ' (adaptive ' + adaptive.source + ')' : ''}`);
    const s = profiler?.result;
    if (s) {
      lines.push(`GPU ${s.total.toFixed(2)} ms  (${(1000 / Math.max(s.total, 0.1)).toFixed(0)} fps-equiv)`);
      const max = Math.max(...Object.values(s.cats), 0.01);
      for (const k of CAT_ORDER) {
        const v = s.cats[k];
        if (v === undefined) continue;
        lines.push(`  ${k.padEnd(7)} ${v.toFixed(2).padStart(6)} ${'#'.repeat(Math.round(18 * v / max))}`);
      }
      lines.push('  top passes');
      for (const p of s.passes.slice(0, 6)) lines.push(`   ${p.ms.toFixed(2).padStart(5)} ${p.label.slice(0, 40)}${p.n > 1 ? ' x' + p.n : ''}`);
    } else {
      lines.push('GPU timing unavailable (no timestamp queries)');
    }
    if (cpu) {
      lines.push(`CPU ${cpu.frame.toFixed(2)} ms  update ${cpu.update.toFixed(2)}  render ${cpu.render.toFixed(2)}`);
      const top = Object.entries(cpu.systems).sort((a, b) => b[1] - a[1]).slice(0, 5);
      if (top.length) lines.push('  ' + top.map(([k, v]) => `${k} ${v.toFixed(2)}`).join('  '));
    }
    const info = renderer.info;
    lines.push(`draws ${info.render.drawCalls}  tris ${(info.render.triangles / 1e6).toFixed(2)}M  geo ${info.memory.geometries}  tex ${info.memory.textures}`);
    const mem = performance.memory;
    if (mem) lines.push(`heap ${(mem.usedJSHeapSize / 1048576).toFixed(0)} MB`);
    this.el.textContent = lines.join('\n');
  }

  dispose() {
    window.removeEventListener('keydown', this._onKey);
    this.el.remove();
  }
}
