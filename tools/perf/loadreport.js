// Run after a cold navigation that injected tools/perf/loadprobe.js: waits for
// the boot loader to finish, then reports load milestones and bytes by type
// (Resource Timing; same-origin, so transfer sizes are exact).
async () => {
  for (let i = 0; i < 600 && !(window.__load?.bootDone); i++) await new Promise((r) => setTimeout(r, 100));
  await new Promise((r) => setTimeout(r, 1500)); // late fetches (music prefetch, models)
  const nav = performance.getEntriesByType('navigation')[0];
  const res = performance.getEntriesByType('resource');
  const kind = (u) => {
    const p = new URL(u).pathname;
    if (/\.js$/.test(p)) return 'js';
    if (/\.css$/.test(p)) return 'css';
    if (/\.stp$|\/terrain\/dem\.json$/.test(p)) return 'terrain';
    if (/textures\/terrain\//.test(p)) return 'terrain textures';
    if (/\.(glb|gltf)$/.test(p)) return 'models';
    if (/\/audio\//.test(p)) return 'audio';
    if (/\.(woff2?|ttf)$/.test(p)) return 'fonts';
    if (/\.(png|jpe?g|webp|ktx2|avif)$/.test(p)) return 'images';
    return 'other';
  };
  const by = {};
  let all = 0;
  for (const r of res) {
    if (!r.name.startsWith(location.origin)) continue;
    const k = kind(r.name);
    const b = r.transferSize || r.encodedBodySize || 0;
    (by[k] ??= { n: 0, kB: 0 }).n++;
    by[k].kB += b / 1024;
    all += b;
  }
  for (const v of Object.values(by)) v.kB = Math.round(v.kB);
  const L = window.__load ?? {};
  const r1 = (x) => (x == null ? null : Math.round(x));
  return {
    url: location.search || '/',
    domContentLoaded: r1(nav?.domContentLoadedEventEnd),
    contextCreated: r1(L.ctx), firstFrame: r1(L.firstFrame), bootDone: r1(L.bootDone),
    boot: window.__boot ?? null, // stage marks from src/main.js (absent before this pass)
    totalMB: +(all / 1048576).toFixed(2), requests: res.length, by,
  };
}
