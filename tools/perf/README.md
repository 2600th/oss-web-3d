# tools/perf

Perf, load and lifecycle tooling. The browser scripts are run with the
chrome-devtools MCP (`evaluate_script({ sourcePath })`), or pasted into a
DevTools snippet. Results and the latest numbers are in
`docs/v2/evidence/polish-perf/README.md`.

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
| `regress.mjs` | `node tools/perf/regress.mjs <dir> <new> [base=after] [tol=0.25]`: fails (exit 1) if a tier/res grew beyond tolerance or broke its hard budget |
| `ab.js` | A/B cost of one scene component at a time (hide, measure, restore) from the GPU total. Use for things inside the main scene pass, and on WebGL2 |
| `imgdiff.mjs` | pixel diff of two screenshots, to show a perf change is invisible |
| `sortie.js` | flies a full mission with the dev bot (invulnerable) plus assisted kills, until the debrief. Used for the WebGL2 runs. The dev bot alone loops `weapon:switch` and never finishes a strike phase |
| `balance.js` + `balance-table.mjs` | difficulty measurement: batches of real bot sorties (`dev.run`, damage on, headless stepping) with per-run telemetry (kills by time, health by phase, minimum health, top-ups, first night contact, escaped trucks); the table script prints win rate, time, damage, failures and phase timing. Used for `docs/v2/evidence/polish-balance/` |
| `cycles.js` | N x (sortie, debrief, retry) then quit to menu. Records heap, `renderer.info.memory`, scene size, listeners and VFX counts per step in `window.__cycleRows` |
| `heapsummary.mjs`, `heapbuffers.mjs` | `.heapsnapshot` analysis: largest groups; largest ArrayBuffers with retainer chains (`DEPTH=` env) |
| `loadprobe.js` + `loadreport.js` | cold-load milestones and bytes by type. Pass the probe as `navigate_page({ initScript })`, then run the report. Boot stage marks are in `window.__boot` |

## Regression check

```
# in a fresh isolated tab, brought to front, dev server on 5193
for tier in low medium high ultra, res in 1920x1080 2560x1440:
  navigate ?mission=free&gputime&quality=<tier>; emulate <res>x1
  evaluate_script(sourcePath=tools/perf/bench.js, filePath=<dir>/new-<tier>-<1080|1440>.json)
node tools/perf/regress.mjs <dir> new after
```

Copy the baseline `docs/v2/evidence/polish-perf/raw/after-*.json` into
`<dir>` first, or point `<dir>` at that folder.
