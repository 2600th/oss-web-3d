# Performance and robustness pass (engine)

Reference machine: RTX 5090, Chrome (WebGPU, Windows), shared GPU process with
several other agents' tabs open. GPU numbers are three's timestamp queries
(per pass, summed per frame), so they are not affected by that contention;
wall-clock numbers (flush, load times) are, and are marked as noisy.
Reproduce with `tools/perf/README.md`.

## GPU per tier, busy combat (`tools/perf/bench.js`)

Scenario: fixed pose 2.5 km east of Tiger Hill, 700 m AGL, heading into the
cloud field; VFX combat burst (10 missile trails, flares, 3 explosions, 2 fires,
a burning aircraft) every 2.5 s. 3 rounds x 90 frames; mean per category
after a spike filter, median of rounds. Adaptive resolution off during the
measurement. Raw JSON: `raw/before-*.json`, `raw/after-*.json`.

### Before (603a14b)

| tier | canvas | GPU ms | shadow | scene | sky/AP | clouds | vfx | post | other | passes | draws | tris | flush ms | CPU ms |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| low | 1920x1080 | **0.63** | 0.02 | 0.16 | 0.02 | 0.11 | 0.17 | 0.15 | 0.01 | 32 | 210 | 1.03M | 3.05 | 1.27 |
| low | 2560x1440 | **0.81** | 0.01 | 0.26 | 0.02 | 0.05 | 0.20 | 0.26 | 0.01 | 32 | 156 | 0.73M | 2.11 | 0.74 |
| medium | 1920x1080 | **0.89** | 0.02 | 0.23 | 0.03 | 0.09 | 0.27 | 0.24 | 0.01 | 34 | 154 | 1.00M | 1.96 | 0.70 |
| medium | 2560x1440 | **1.30** | 0.02 | 0.41 | 0.02 | 0.09 | 0.34 | 0.40 | 0.01 | 34 | 154 | 1.00M | 1.98 | 0.75 |
| high | 1920x1080 | **1.05** | 0.04 | 0.31 | 0.01 | 0.15 | 0.29 | 0.25 | 0.01 | 34 | 176 | 1.60M | 2.10 | 0.80 |
| high | 2560x1440 | **1.45** | 0.04 | 0.41 | 0.02 | 0.09 | 0.49 | 0.38 | 0.01 | 34 | 176 | 1.60M | 1.75 | 0.77 |
| ultra | 1920x1080 | **1.28** | 0.04 | 0.41 | 0.02 | 0.22 | 0.29 | 0.28 | 0.01 | 34 | 259 | 3.80M | 2.90 | 1.19 |
| ultra | 2560x1440 | **2.17** | 0.04 | 0.51 | 0.02 | 0.09 | 1.09 | 0.43 | 0.01 | 34 | 176 | 2.91M | 1.87 | 0.83 |

### After (this branch)

| tier | canvas | GPU ms | shadow | scene | sky/AP | clouds | vfx | post | other | passes | draws | tris | flush ms | CPU ms |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| low | 1920x1080 | **0.59** | 0.02 | 0.16 | 0.02 | 0.10 | 0.15 | 0.16 | 0.01 | 32 | 216 | 1.46M | 1.43 | 0.59 |
| low | 2560x1440 | **0.97** | 0.01 | 0.28 | 0.02 | 0.05 | 0.37 | 0.22 | 0.01 | 32 | 169 | 1.16M | 1.02 | 0.46 |
| medium | 1920x1080 | **0.80** | 0.02 | 0.24 | 0.02 | 0.14 | 0.16 | 0.22 | 0.01 | 34 | 135 | 0.96M | 0.88 | 0.38 |
| medium | 2560x1440 | **1.24** | 0.02 | 0.36 | 0.02 | 0.17 | 0.29 | 0.39 | 0.01 | 34 | 219 | 1.71M | 1.25 | 0.63 |
| high | 1920x1080 | **0.96** | 0.02 | 0.31 | 0.02 | 0.19 | 0.16 | 0.26 | 0.01 | 34 | 221 | 2.10M | 1.20 | 0.65 |
| high | 2560x1440 | **1.29** | 0.02 | 0.47 | 0.02 | 0.16 | 0.28 | 0.35 | 0.01 | 34 | 136 | 1.13M | 0.99 | 0.43 |
| ultra | 1920x1080 | **1.08** | 0.01 | 0.34 | 0.02 | 0.20 | 0.25 | 0.26 | 0.01 | 34 | 138 | 1.99M | 1.07 | 0.43 |
| ultra | 2560x1440 | **1.55** | 0.01 | 0.54 | 0.02 | 0.23 | 0.32 | 0.43 | 0.01 | 34 | 221 | 3.09M | 1.33 | 0.77 |

How to read it:

- **Shadow halves on every tier (0.04 to 0.02 / 0.01 ms).** Terrain blocks are
  now culled against the sun's shadow frustum as well as the view, and drawn
  into the shadow map only when they are inside it. They used to be drawn
  unculled. This is a real change.
- **Scene and post are flat within noise.** Post includes the exposure
  meter, now run every 4th frame; it was about 0.02 ms per frame.
- **VFX is the largest and most variable cost, and changes are not ours.**
  The vfx-layer moves with where the burst is in its 2.5 s cycle. The perfhud
  showed 2.06 ms vfx at ultra 1440p right after a burst; the bench mean was
  0.32 ms after and 1.09 ms before. The before/after gap in this column is
  timing variance, not a fix. The VFX owner is polishing `src/vfx`, which was
  left alone. Their capacity instances are always drawn, so the cost scales
  with resolution even when few particles are live.
- **Draws and tris** depend on which ground units and fires are in view in a
  round. They are context, not a metric.
- **Flush and CPU** are wall clock and came out lower in the after run. The
  shared GPU process makes them too noisy to credit to any one change.

Top passes after (ms): `scene > output` 0.16 to 0.54; `vfx-layer > output`
0.15 to 0.37; `RTT` (TRAA/post input) 0.05 to 0.18; `Clouds.march` 0.06 to
0.16; `Render Pipeline` 0.03 to 0.10. Shadow 2048^2 is 0.01 to 0.02.

### Budgets

| target | measured | verdict |
|---|---|---|
| high 2560x1440 <= 8 ms GPU (5090) | 1.29 ms mean (ultra 1440p peaks at 3.1 ms right after a VFX burst) | met, about 6x headroom |
| high 1440p, mid-range (RTX 3060 / RX 6600 class) | **estimate** 8 to 11 ms (5090 x6 to x8 fill-rate ratio, plus fixed per-pass overhead) | near budget; adaptive resolution holds 13.5 ms |
| low, integrated GPUs | low 1080p 0.59 ms here; **estimate** x15 to x25 for Iris Xe / Radeon 680M gives 9 to 15 ms | adaptive resolution (min scale 0.5 on low) brings it under 13.5 ms |

The mid-range and integrated numbers are estimates from fill-rate ratios. They
are not measured: no such GPU was available.

**Night scene: unmeasured.** The day/night branch had not merged into
`webgpu-aaa` (head a6a8232) when this pass finished.

### Adaptive resolution and `?perfhud`

- `src/engine/AdaptiveResolution.js` drives `Renderer.setRenderScale` from the
  GPU frame total (timestamps). Budget is 13.5 ms (`?gpubudget=`), scale 0.6 to 1
  (0.5 on low), in 0.05 steps. It drops in proportion to the overshoot and
  climbs one step at a time with headroom. It holds after a resize, a hidden tab
  or a hitch. With no timestamps it falls back to the frame interval with
  8 s hysteresis.
- Test: a 0.4 ms budget dropped 1.0 to 0.6 within 2 decisions; restoring
  13.5 ms climbed back step by step to 1.0. Unit tests are in
  `src/engine/adaptive.test.mjs`.
- `?perfhud` works in dev and prod and is off by default (Shift+F3 toggles it).
  It shows backend, tier, canvas and scale; GPU ms per category with the top
  passes; CPU update/render and the top systems; draws, tris, geometries,
  textures; and heap. Screenshots: `perfhud-webgpu-high-combat.jpeg` and
  `perfhud-webgpu-ultra-1440-combat.jpeg`.

## Load time and size (production build, cold, isolated context)

| | before | after |
|---|---|---|
| bytes before the title is interactive | 32.31 MB / 128 requests | 27.25 MB (the 5.2 MB hostile GLB now loads ~4 s after the title) |
| by type (whole session) | terrain 9.0 MB, models 10.8 MB, audio 6.0 MB, terrain textures 5.0 MB, images 1.7 MB, JS 452 kB, fonts 101 kB | same assets; PerfHud split into a 2 kB lazy chunk |
| JS (gzip) | ~450 kB | index 173 kB + three 296 kB |
| DOMContentLoaded / main module start | 59 ms | module starts at 49 to 71 ms |
| title interactive (boot loader done) | 7.07 s | 7.8 to 8.1 s (noise: see below) |
| first sortie frame (`?mission=m1`) | not measured comparably | WebGPU 6.0 s (4.6 s of it is adapter/device creation); WebGL2 2.05 s |

Stage marks after (`window.__boot`, ms): module 49, renderer 3519,
dem 3519 (downloaded in parallel with the renderer), world 4603, systems 4609,
init 4873, first frame 4876, boot loader done 7831.

Wall-clock load time did not improve measurably. It is dominated by:

- **WebGPU adapter and device creation in a GPU process shared with about six
  other tabs.** The renderer stage takes 3.5 to 4.6 s on WebGPU and 0.28 s on
  WebGL2 in the same session.
- **The main-thread terrain texture build.** `buildTerrainTextures` takes
  0.77 s, `loadPack` 0.37 s and `initTerrain` 0.14 s.
- **First-frame TSL code generation and pipeline creation.** This takes about
  2.8 s.

Bytes on the critical path fell by 5.1 MB.

**KTX2/Basis: not adopted.** The terrain layers are packed in the browser
(canvas `getImageData`) into an RGBA8 `DataArrayTexture`. They would need a
rewrite to a compressed array texture. There is no basisu/toktx tooling in
the repo, and the download would be similar to the current JPEG/WebP. WebGL2
compressed array-texture support also varies by format. The real win is GPU
memory (about 4x on the layer arrays), and this is worth a follow-up with an
offline encoder. Music is already fetched per track and decoded with an LRU
(keep 6). Streaming it through a media element would save decoded PCM
(roughly 30 to 60 MB). That system belongs to the audio owner, so it was left.

## Memory and lifecycle (5 x m1 sortie, debrief, retry, then quit to menu)

Dev build, high, clean isolated context, `tools/perf/cycles.js`:

| step | JS heap MB | geometries | textures | programs | scene nodes | listeners |
|---|---|---|---|---|---|---|
| title | 173.9 | 41 | 103 | 77 | | |
| after sortie 1 | 193.6 | 130 | 222 | 87 | 205 | 90 |
| after sortie 2 | 195.3 | 130 | 222 | 87 | 205 | 90 |
| after sortie 3 | 192.1 | 130 | 222 | 87 | 205 | 90 |
| after sortie 4 | 192.4 | 130 | 222 | 87 | 205 | 90 |
| after sortie 5 | 193.4 | 130 | 222 | 87 | 205 | 90 |
| quit to menu | 195.8 | 130 | 222 | 87 | 205 | 90 |

No growth after the first sortie, which loads the mission assets and
compiles the programs once. Heap snapshots (forced GC): title 186.2 MB;
menu after 5 cycles 208.2 MB (the difference is mission assets and caches
kept for the next sortie).

Fix: terrain textures now free their CPU source arrays once uploaded
(`tex.onUpdate`). This applies to height, amplitude, tile, surface, river and
outer textures, and to the layer albedo and normal arrays.

| production build, title, forced GC | before | after |
|---|---|---|
| heap snapshot total | 281.7 MB | **156.2 MB** |
| ArrayBuffer backing stores | 262.3 MB | 136.7 MB |

Notes: fires and wrecks from the last sortie stay in the VFX pool while at
the menu (capped at 14, reused, so this is not a leak). Absolute heap numbers
in a reused tab are inflated by bfcache documents in the same isolate. Use a
fresh isolated context, as above.

## WebGL2 (`?webgl`)

| run | result | GPU p50 | CPU p50 | console |
|---|---|---|---|---|
| low, m1 full sortie (`tools/perf/sortie.js`) | complete, rank A, debrief reached, ~100 fps | 2.92 ms | 1.65 ms | clean |
| high, m4 full sortie | complete, rank S, 60.8 fps (vsync) | 3.73 ms | | clean |

Screenshot: `webgl2-high-combat.jpeg`.

- First use of a material causes main-thread hitches of up to 95 ms (GLSL
  compile). They happen in the first seconds of a sortie only.
- WebGL2 GPU timing needs `EXT_disjoint_timer_query_webgl2`. It is enabled
  only with `?gputime` or `?perfhud`, and turned off when the extension is
  missing (three would warn every frame otherwise). Three's GL timer queries
  nest, so on WebGL2 only the frame total is reliable, not the per-pass split.

Fixes for WebGL2: the profiler's `InspectorNode` warning is avoided by
presenting `InspectorBase` as the constructor. Timestamps are gated as above.

## Robustness

| check | result |
|---|---|
| no `navigator.gpu` | boots WebGL2, one info line, no overlay |
| `requestAdapter()` returns null | boots WebGL2 |
| WebGPU renderer init throws | fresh canvas, WebGL2 (code path; not forced in a test) |
| neither backend | friendly overlay with the reason (`no-backend-overlay.jpeg`) |
| WebGPU device lost (simulated `device.lost`) | loop stopped, overlay with Reload (`device-lost-overlay.jpeg`); a second loss in the same session offers "Restart in compatibility mode" (`?webgl`) |
| WebGL context lost (`WEBGL_lose_context`) | same overlay; only our own warning in the console |
| tab hidden and resumed | flow pauses; adaptive resolution and the profiler hold; resumes cleanly |
| resize storm / DPR change (zoom, CDP emulation 1280x720 to 1920x1080 at DPR 2 and back) | one resize per frame; DPR changes caught by `Renderer.poll()` |
| console, prod, WebGPU and WebGL2 | clean: only `[boot] backend=... tier=...` info lines |
| console, dev | clean apart from Vite's connect lines |

Console fixes:

- `powerPreference` is now omitted on Windows, where Chrome warns that it is
  ignored. Detection uses `||`, because `userAgentData.platform` is `''` under
  UA emulation.
- Vercel analytics is not injected on localhost, where its script is a 404.
