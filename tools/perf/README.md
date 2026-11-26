# tools/perf

Perf, load and lifecycle tooling. The browser scripts are run with the
chrome-devtools MCP (`evaluate_script({ sourcePath })`), or pasted into a
DevTools snippet. Write result files to `captures/perf/` (gitignored).

## Rules for measuring in a shared browser

- **Do not use rAF or fps as a GPU metric.** Use the timestamp totals
  (`window.__perf.profiler`). Chrome quantises timestamps to about 0.07 to
  0.1 ms, so the profiler reports spike-filtered means, not medians.
- **Bring the tab to the front before every run**
  (`select_page({ bringToFront: true })`). A background or occluded tab gets
  rAF at about 1.5 fps, and `bench.js` refuses to run when `document.hidden`.
- **Use a fresh isolated context** (`new_page({ isolatedContext })`) for heap
  and load numbers. A reused tab keeps bfcache documents in the same isolate
  and the HTTP cache is warm.
- **Long scripts:** `evaluate_script` has a protocol timeout. Scripts that
  run for minutes (`cycles.js`, `sortie.js`) store progress on `window`;
  poll it with a second call.
- **Wall-clock numbers** (flush, load) are affected by every other tab using
  the GPU process. Repeat them and report the median.
- **Frame time (CPU + GPU) A/B: interleave.** Whole rounds of `frame.js` differ
  by several percent from one to the next (other load on the machine, the
  scene itself), which hides a 1 to 3 % change. Give the change a runtime
  switch and run `abx.js`: the two settings alternate every 0.4 s in one run,
  and the result carries its own standard error. Do not record a trace at the
  same time (the sampling profiler adds about 70 % CPU), and close every other
  tab that runs the game.

## URL flags (engine)

| flag | effect |
|---|---|
| `?perfhud` | GPU ms per pass, CPU per system, draws, memory overlay (dev and prod; Shift+F3 toggles). Turns adaptive resolution off unless `&adaptive` |
| `?gputime` | profiler, per-system CPU timing and `window.__perf` without the HUD |
| `?noadaptive` / `?adaptive` | adaptive resolution off / on regardless of the above |
| `?gpubudget=ms` | adaptive budget (default 13.5) |
| `?scale=0.75` | fixed render scale |
| `?notimestamps` | no timestamp queries (adaptive falls back to frame interval) |
| `?quality=low\|medium\|high\|ultra` | tier |
| `?webgl` | force the WebGL2 backend |

## Scripts

| file | what |
|---|---|
| `bench.js` | GPU benchmark, busy-combat scenario at a fixed pose. Per-category and top-pass GPU ms, flush wall time, draws, CPU. Open `?mission=free&gputime&quality=X`, set the viewport (`emulate 2560x1440x1`), run with `filePath` = `<dir>/<prefix>-<tier>-<res>.json` |
| `summarize.mjs` | `node tools/perf/summarize.mjs <dir> <prefix>`: markdown table of bench results |
| `regress.mjs` | `node tools/perf/regress.mjs [dir=captures/perf] [new] [base=after] [tol=0.25]`: fails (exit 1) if a tier/res grew beyond tolerance or broke its hard budget |
| `frame.js` + `framesum.mjs` | whole-frame cost at the display's pace: CPU ms per frame (update, render, tail) plus GPU ms, at a fixed pose, `combat` or `cruise`. Runs on the plain URL (`?mission=free&quality=X`, no `gputime`), so it measures what players run. `framesum.mjs` prints one line per result file |
| `abx.js` | interleaved A/B of one runtime switch (`window.__abx = { set, scenario, seconds }`): ms per frame for both settings, the change in percent and its standard error |
| `traceprofile.mjs` | self and inclusive CPU time per function from a Chrome trace: for finding hot spots, not for measuring |
| `shotdiff.mjs` | compares two sets of reference frames (clips `<tag>-<view>` under `captures/`): mean difference, pixels over a threshold, brightness. Capture the same build twice first: that is the noise floor |
| `cullcheck.js` | asserts, frame by frame over a set of poses, that nothing visible lies in a sun cascade that was skipped or in the AO range while the AO prepass draws no terrain |
| `ab.js` | A/B cost of one scene component at a time (hide, measure, restore) from the GPU total. Use for things inside the main scene pass, and on WebGL2 |
| `imgdiff.mjs` | pixel diff of two screenshots, to show a perf change is invisible |
| `sortie.js` | flies a full mission with the dev bot (invulnerable) plus assisted kills, until the debrief. Used for the WebGL2 runs. The dev bot alone loops `weapon:switch` and never finishes a strike phase |
| `balance.js` + `balance-table.mjs` | difficulty measurement: batches of real bot sorties (`dev.run`, damage on, headless stepping) with per-run telemetry (kills by time, health by phase, minimum health, top-ups, first night contact, escaped trucks); the table script prints win rate, time, damage, failures and phase timing |
| `cycles.js` | N x (sortie, debrief, retry) then quit to menu. Records heap, `renderer.info.memory`, scene size, listeners and VFX counts per step in `window.__cycleRows` |
| `heapsummary.mjs`, `heapbuffers.mjs` | `.heapsnapshot` analysis: largest groups; largest ArrayBuffers with retainer chains (`DEPTH=` env) |
| `loadprobe.js` + `loadreport.js` | cold-load milestones and bytes by type. Pass the probe as `navigate_page({ initScript })`, then run the report. Boot stage marks are in `window.__boot` |

## Regression check

```
mkdir -p captures/perf
# in a fresh isolated tab, brought to front, dev server on 5193
for tier in low medium high ultra, res in 1920x1080 2560x1440:
  navigate ?mission=free&gputime&quality=<tier>; emulate <res>x1
  evaluate_script(sourcePath=tools/perf/bench.js, filePath=captures/perf/new-<tier>-<1080|1440>.json)
node tools/perf/regress.mjs captures/perf new after
```

There is no checked-in baseline. Run the same loop on the commit you compare
against first, with prefix `after` instead of `new`. Without base files the
script still checks the hard budgets in `regress.mjs`.

## Runtime switches for A/B

Every frame-time optimisation keeps a switch that restores the old behaviour,
so `abx.js` can measure it and a suspected regression can be bisected live:

| switch (old behaviour) | what the new behaviour does |
|---|---|
| `__perf.profiler.detailed = true; __perf.profiler.eager = true` | profiler keeps per-pass labels and rebuilds its summary every frame (`?gputime` / `?perfhud` still do the former) |
| `__perf.trackInterval = 0` | timestamp queries on every frame instead of about 20 frames a second |
| `__game.env.clouds.slowInterval = 0` | cloud shadow map and deck probe every frame instead of about 30 times a second |
| `__game.terrain.nearCull = false` | AO depth prepass draws every terrain block in view, not only those within the AO range |
| `__game.env.sunShadows.node.cullEmpty = false` | every sun cascade is redrawn every frame, also one whose slice has nothing to receive it |
| `__game.env.atmosphere.skyViewAlways = true` | sky-view LUT redrawn every frame instead of when altitude, sun elevation or haze moved |
