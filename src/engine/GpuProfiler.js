import { InspectorBase } from 'three/webgpu';

/**
 * Per-pass GPU timing from WebGPU timestamp queries (the renderer must be
 * created with `trackTimestamp: true`; see Renderer.js, `?gputime` / `?perfhud`).
 *
 * three already writes a begin/end timestamp around every render pass and
 * compute dispatch and keys it by a uid (`r:<call>:<ctx>:f<frame>`); it only
 * reports the per-frame sum. This inspector records, for each uid, *what* was
 * drawn (scene name, quad material, render target) so the durations can be
 * attributed to passes, then groups them into categories (shadow, scene,
 * atmosphere, clouds, vfx, post ...).
 *
 * Cost: one Map insert per pass while enabled, and one query resolve
 * (`mapAsync`, never awaited by the frame) per frame. When the renderer was not
 * created with timestamps it does nothing at all.
 */

/** Raw pass label -> category. First match wins. */
const RULES = [
  [/^shadow/, 'shadow'],
  [/^scene( |$)/, 'scene'],
  [/vfx-layer/, 'vfx'],
  [/^vfx /, 'vfx'],
  [/^Clouds\.|cloud/i, 'clouds'],
  [/^Atmosphere\.|PMREM|pmrem|CubeCamera|env/i, 'sky/AP'],
  [/^Bloom/, 'post'],
  [/TRAA|SMAA|FXAA|ExposureMeter|SunVisibility|MotionBlur|RTT|Render Pipeline|post|output/i, 'post'],
];

function categorize(label) {
  for (const [re, cat] of RULES) if (re.test(label)) return cat;
  return 'other';
}

export class GpuProfiler extends InspectorBase {
  constructor(r) {
    super();
    this.r = r;
    this.labels = new Map();
    /** Latest smoothed result: { total, cats: {name: ms}, passes: [{label, ms, n}] }. */
    this.result = null;
    this._samples = []; // last N frames of {total, cats, passes}
    this.window = 60;
    this._pending = false;
    this.available = false;
    this.lastTotal = NaN;
    this.sampleCount = 0;
  }

  /** Install on the renderer. Returns false when timestamps are unavailable. */
  install() {
    const renderer = this.r.renderer;
    const backend = renderer.backend;
    if (!backend.trackTimestamp) return false;
    this.available = true;
    // three warns once on WebGL2 ("toInspector() is only available with
    // WebGPU") whenever a non-default inspector meets an InspectorNode (its
    // shadow nodes carry some). We never inspect nodes, so present ourselves
    // as the base class to that check; the per-pass hooks still run.
    Object.defineProperty(this, 'constructor', { value: InspectorBase, configurable: true });
    renderer.inspector = this;
    return true;
  }

  _label(scene, camera, rt) {
    const t = rt?.texture?.name;
    if (t === 'ShadowMap' || /^Shadow Map/.test(scene?.name ?? '')) return `shadow ${rt ? rt.width + 'x' + rt.height : ''}`;
    let name = scene?.name || '';
    if (!name && scene?.isQuadMesh) name = scene.material?.name || 'quad';
    if (scene?.isScene && camera === this.r.camera && !scene.name) name = 'scene';
    if (scene === this.r.scene) name = 'scene';
    if (!name) name = scene?.type ?? '?';
    if (t && t !== name) name += ` > ${t}`;
    return name;
  }

  beginRender(uid, scene, camera, renderTarget) {
    if (this.labels.size > 4096) this.labels.clear();
    this.labels.set(uid, this._label(scene, camera, renderTarget));
  }

  beginCompute(uid, computeNodes) {
    if (this.labels.size > 4096) this.labels.clear();
    const n = Array.isArray(computeNodes) ? computeNodes[0] : computeNodes;
    this.labels.set(uid, 'compute: ' + (n?.name || n?.computeNode?.name || 'compute'));
  }

  /** Call once per frame after the frame's last render. Never blocks. */
  sample() {
    if (!this.available || this._pending) return;
    const renderer = this.r.renderer;
    const backend = renderer.backend;
    this._pending = true;
    Promise.all([
      renderer.resolveTimestampsAsync('render'),
      renderer.resolveTimestampsAsync('compute'),
    ]).then(() => {
      const frames = new Map();
      for (const type of ['render', 'compute']) {
        const pool = backend.timestampQueryPool?.[type];
        if (!pool) continue;
        for (const [uid, ms] of pool.timestamps) {
          const m = /:f(\d+)$/.exec(uid);
          const f = m ? +m[1] : 0;
          let fr = frames.get(f);
          if (!fr) frames.set(f, fr = []);
          fr.push([this.labels.get(uid) ?? (type === 'compute' ? 'compute' : '?'), ms]);
          this.labels.delete(uid);
        }
      }
      for (const fr of frames.values()) this._push(fr);
    }).catch(() => {}).finally(() => { this._pending = false; });
  }

  _push(entries) {
    const cats = {};
    const passes = {};
    let total = 0;
    for (const [label, ms] of entries) {
      total += ms;
      const c = categorize(label);
      cats[c] = (cats[c] ?? 0) + ms;
      const p = passes[label] ?? (passes[label] = { ms: 0, n: 0 });
      p.ms += ms;
      p.n++;
    }
    this._samples.push({ total, cats, passes });
    this.lastTotal = total;
    this.sampleCount = (this.sampleCount ?? 0) + 1;
    if (this._samples.length > this.window) this._samples.shift();
    this.result = this.summary();
  }

  /**
   * Means over the sample window, after dropping spike frames (total over 1.6x
   * the median: another process had the GPU). Not a median: Chrome quantises
   * timestamps (~0.07-0.1 ms), so a short pass reads 0 most frames and one
   * quantum now and then; only the mean of such samples is unbiased.
   */
  summary() {
    const s = this._samples;
    if (!s.length) return null;
    const totals = s.map((f) => f.total).sort((x, y) => x - y);
    const cut = totals[totals.length >> 1] * 1.6 + 0.2;
    const keep = s.map((f) => f.total <= cut);
    const med = (arr) => {
      let sum = 0;
      let n = 0;
      arr.forEach((v, i) => { if (keep[i]) { sum += v; n++; } });
      return sum / Math.max(1, n);
    };
    const catNames = new Set();
    const passNames = new Set();
    for (const f of s) { Object.keys(f.cats).forEach((k) => catNames.add(k)); Object.keys(f.passes).forEach((k) => passNames.add(k)); }
    const cats = {};
    for (const c of catNames) cats[c] = +med(s.map((f) => f.cats[c] ?? 0)).toFixed(3);
    const passes = [];
    for (const p of passNames) {
      passes.push({ label: p, cat: categorize(p), ms: +med(s.map((f) => f.passes[p]?.ms ?? 0)).toFixed(3), n: Math.max(...s.map((f) => f.passes[p]?.n ?? 0)) });
    }
    passes.sort((a, b) => b.ms - a.ms);
    return { frames: s.length, total: +med(s.map((f) => f.total)).toFixed(3), cats, passes };
  }

  reset() { this._samples.length = 0; this.result = null; }
}

export { categorize };
