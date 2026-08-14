# Cloud Renderer Comparison Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an isolated, reproducible A/B harness that compares the shipping cloud renderer with pinned Takram packages and produces an evidence-backed adopt/defer/reject decision.

**Architecture:** Define a small backend contract around the real renderer/camera/depth/sun/shadow lifecycle, wrap the current `CloudVolume`, and implement a Takram adapter used only by a dedicated comparison harness. Run one backend at a time through identical deterministic flight scenarios while collecting GPU, CPU, memory, payload, objective-readability, temporal and visual evidence.

**Tech Stack:** Three.js 0.185.1, postprocessing 6.39.4, WebGL2, Takram packages pinned below, Vite, Node test runner, `EXT_disjoint_timer_query_webgl2`, in-app Browser.

## Global Constraints

- Pin `@takram/three-clouds@0.7.6`, `@takram/three-atmosphere@0.19.1`, `@takram/three-geospatial@0.9.1` and `@takram/three-geospatial-effects@0.6.4`.
- Production continues to select the current backend until the comparison is reviewed and accepted.
- Use vanilla Takram classes only; do not import React/R3F wrappers into production code.
- Only one cloud backend renders during timing or memory measurement.
- No second renderer, tone mapper, terrain owner, water owner or world clock.
- Both candidates consume the same real flight camera, stable depth texture, sun/environment inputs, HDR/post chain and deterministic mission route.
- High acceptance: no more than +2 ms median GPU time over current at 1920x1080 and incremental cloud memory at most 64 MiB.
- Phone acceptance: at least 45 FPS, no more than +0.75 ms median GPU time and incremental cloud memory at most 24 MiB; otherwise Takram must use a validated fallback/disable path.
- History clears on camera cut, recon transition, resize and quality change; no persistent disocclusion trail after two resolved frames.
- Objective route and photographic line of sight remain readable; no horizon wall, flat shelf, camera-space disc or terrain-colored invisibility.
- Exact upstream notices and asset provenance ship with any accepted Takram code/assets.
- A failed prototype is removable without changing shipping cloud behavior.

---

### Task 1: Define the comparison contract and wrap the current renderer

**Files:**
- Create: `src/world/cloud/CloudRendererContract.js`
- Create: `src/world/cloud/CurrentCloudRendererAdapter.js`
- Create: `src/world/cloud/cloud-renderer-contract.test.mjs`
- Modify: `src/world/CloudVolume.js` only if a read-only ownership metric cannot be exposed without changing behavior

**Interfaces:**
- Produces `assertCloudRendererBackend(value)` and `CurrentCloudRendererAdapter`.
- Required backend methods: `setSize(width,height,pixelRatio)`, `setQuality(tier)`, `setDepthTexture(texture)`, `update(frame)`, `resetHistory(reason)`, `getShadowOutput()`, `getResourceReport()`, `dispose()`.
- `frame` is a caller-owned object containing `{ dt, renderer, inputBuffer, camera, scene, sunDirection, environment, sceneDepth, cameraCut }`.

- [ ] **Step 1: Write failing interface tests**

Create a fake current effect and assert the adapter forwards every lifecycle method without allocating/replacing the caller-owned frame object:

```js
const backend = new CurrentCloudRendererAdapter(fakeCloudVolume);
assertCloudRendererBackend(backend);
backend.setSize(1920, 1080, 1);
backend.setDepthTexture(depth);
backend.update(frame);
assert.strictEqual(fakeCloudVolume.lastFrame, frame);
assert.strictEqual(backend.getShadowOutput(), fakeCloudVolume.shadowMap);
backend.dispose();
backend.dispose();
assert.equal(fakeCloudVolume.disposeCount, 1);
```

Reject missing methods with an error naming the first missing method.

- [ ] **Step 2: Run RED**

Run: `node --test src/world/cloud/cloud-renderer-contract.test.mjs`

Expected: FAIL because the contract and adapter modules do not exist.

- [ ] **Step 3: Implement the narrow adapter**

Use a frozen list of required method names for validation. Add behavior-neutral public `CloudVolume.resetHistory(reason)` and `CloudVolume.getResourceReport()` methods. The current adapter maps `setSize(width,height,pixelRatio)` to the existing physical-size `setSize(width,height)`, maps `update(frame)` to `cloudVolume.update(frame.renderer, frame.inputBuffer, frame.dt)`, returns `cloudVolume.shadowContract`, and reports its owned reduced-resolution MRT histories plus 256x256 shadow target. Do not alter rendering, density, weather or lighting.

- [ ] **Step 4: Run GREEN**

Run:

```powershell
node --test src/world/cloud/cloud-renderer-contract.test.mjs src/world/cloud/cloud.test.mjs
npm run check
```

Expected: both cloud suites and GLSL check PASS.

- [ ] **Step 5: Commit**

```powershell
git add -- src/world/cloud/CloudRendererContract.js src/world/cloud/CurrentCloudRendererAdapter.js src/world/cloud/cloud-renderer-contract.test.mjs src/world/CloudVolume.js
git commit -m "refactor: define cloud renderer contract"
```

---

### Task 2: Isolate and construct the pinned Takram backend

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `src/world/cloud/TakramCloudRendererAdapter.js`
- Create: `src/world/cloud/takram-cloud-renderer.test.mjs`
- Modify: `public/THIRD_PARTY_NOTICES.txt`

**Interfaces:**
- Consumes the Task 1 contract.
- Produces `TakramCloudRendererAdapter`, but production `Game`/`Engine` imports remain unchanged.
- Constructor accepts `{ renderer, quality, camera, scene, sunDirection, stableDepthTexture }` and preallocates all selected quality resources.

- [ ] **Step 1: Install exact packages and record lockfile evidence**

Install the four exact Takram versions as development dependencies with legacy peer resolution. Import only each package's vanilla `.` export; never import its `./r3f` export. Verify React/R3F are absent from the lockfile and production bundle.

Run:

```powershell
npm install --save-dev --save-exact --legacy-peer-deps @takram/three-clouds@0.7.6 @takram/three-atmosphere@0.19.1 @takram/three-geospatial@0.9.1 @takram/three-geospatial-effects@0.6.4
```

- [ ] **Step 2: Write failing construction/lifecycle tests**

Assert that the adapter:

```js
const backend = new TakramCloudRendererAdapter(options);
assertCloudRendererBackend(backend);
assert.strictEqual(backend.camera, camera);
assert.strictEqual(backend.depthTexture, stableDepthTexture);
assert.equal(backend.activeLayerCount <= 4, true);
backend.resetHistory('camera-cut');
assert.equal(backend.historyGeneration, 1);
backend.dispose();
backend.dispose();
assert.equal(resourceTracker.liveCount, 0);
```

The test must also prove that `setQuality({name:'phone'})` selects the explicit fallback/disabled profile rather than allocating High targets.

- [ ] **Step 3: Run RED**

Run: `node --test src/world/cloud/takram-cloud-renderer.test.mjs`

Expected: FAIL because the Takram adapter does not exist.

- [ ] **Step 4: Implement vanilla Takram construction**

Use vanilla `CloudsEffect`/atmosphere classes only. Map the real stable depth texture and camera matrices into Takram's effect. Configure authored opening weather separately from package defaults so the central reconnaissance corridor is clear. Convert its Beer-shadow output to the Task 1 shadow report without modifying production terrain yet.

Quality mapping:

```js
const profiles = {
  high: { takram: 'high', enabled: true },
  medium: { takram: 'medium', enabled: true },
  low: { takram: 'low', enabled: true },
  phone: { takram: 'low', enabled: false },
};
```

Dispose every effect-owned MRT, history, atmosphere LUT, shadow texture, material and listener exactly once.

- [ ] **Step 5: Add exact third-party notices**

Copy all notices required by the selected Takram packages and bundled assets, including their upstream Bruneton/INRIA, Epic, Intel, Sony and GLM notices where applicable. Verify the notice is copied into `dist` by the production build.

- [ ] **Step 6: Run GREEN and production isolation checks**

Run:

```powershell
node --test src/world/cloud/cloud-renderer-contract.test.mjs src/world/cloud/takram-cloud-renderer.test.mjs
npm run build
rg -n "react|@react-three" dist/assets/index-*.js
```

Expected: tests/build PASS and the production application entry has no React/R3F runtime import. Takram may appear only in the isolated comparison chunk.

- [ ] **Step 7: Commit**

```powershell
git add -- package.json package-lock.json src/world/cloud/TakramCloudRendererAdapter.js src/world/cloud/takram-cloud-renderer.test.mjs public/THIRD_PARTY_NOTICES.txt
git commit -m "feat: add isolated Takram cloud backend"
```

---

### Task 3: Build the deterministic A/B comparison harness

**Files:**
- Create: `src/world/cloud/comparison.html`
- Create: `src/world/cloud/CloudComparisonHarness.js`
- Create: `src/world/cloud/cloud-comparison.test.mjs`
- Create: `tools/cloud-comparison.vite.config.js`
- Modify: `package.json`

**Interfaces:**
- Consumes both adapters.
- Produces URLs such as `src/world/cloud/comparison.html?backend=takram&quality=high&scenario=opening-3.5`.
- Exposes DEV-only `window.__cloudComparison` with read-only `status()`, `startRun()`, `result()` and `dispose()` methods.

- [ ] **Step 1: Write failing scenario determinism tests**

Define immutable scenarios for opening 3.5/10/25 seconds, side-bank flyby, fast camera motion/stop, chase-to-recon cut, objective ranges 8 km/3 km/frame range, sun-facing and backlit views, resize, High-to-Phone quality switch, WebGL context loss and context restoration. Assert equal camera transforms, sun, terrain seed, depth setup and warmup frames for both backend names.

```js
const a = createScenario('opening-3.5', 'current');
const b = createScenario('opening-3.5', 'takram');
assert.deepEqual(stripBackend(a), stripBackend(b));
assert.equal(a.warmupFrames, 120);
```

- [ ] **Step 2: Run RED**

Run: `node --test src/world/cloud/cloud-comparison.test.mjs`

Expected: FAIL because the harness/scenario module does not exist.

- [ ] **Step 3: Implement the one-backend harness**

Reuse the real project renderer, camera, terrain, sky, sun/environment and final post chain. Construct only the selected adapter. Reject unknown query parameters visibly. Reset history on every scenario transition. The harness must render the same HUD-free world view for image comparison and must dispose the selected backend/scene/renderer on pagehide. Add `npm run build:cloud-comparison`, backed by `tools/cloud-comparison.vite.config.js`, which builds only this multi-page experiment to `.agent/cloud-comparison-dist`; the normal `npm run build` remains unchanged and excludes Takram.

- [ ] **Step 4: Add objective-readability sampling**

Project the active observation post, sample a bounded screen region around it, and report target/background contrast plus terrain/cloud occlusion state. Use the existing shared terrain visibility contract rather than a second raycast implementation.

- [ ] **Step 5: Run GREEN**

Run:

```powershell
node --test src/world/cloud/cloud-comparison.test.mjs
npm run check
npm run build
```

Expected: deterministic scenario tests, GLSL check and build PASS.

- [ ] **Step 6: Commit**

```powershell
git add -- src/world/cloud/comparison.html src/world/cloud/CloudComparisonHarness.js src/world/cloud/cloud-comparison.test.mjs tools/cloud-comparison.vite.config.js package.json package-lock.json
git commit -m "feat: add cloud renderer comparison harness"
```

---

### Task 4: Instrument GPU, CPU, memory and temporal stability

**Files:**
- Create: `src/world/cloud/CloudBenchmark.js`
- Create: `src/world/cloud/cloud-benchmark.test.mjs`
- Modify: `src/world/cloud/CloudComparisonHarness.js`

**Interfaces:**
- Produces result JSON version `cloud-comparison-v1` with backend, versions, scenario, viewport, quality, GPU median/p95/disjoint count, CPU median/p95, FPS, resource bytes, payload bytes, objective contrast, temporal trail metrics and console issues.

- [ ] **Step 1: Write failing statistic/resource tests**

Use deterministic samples:

```js
assert.deepEqual(summarizeSamples([1, 2, 3, 4, 100]), { median: 3, p95: 100 });
assert.equal(bytesForTarget({ width: 1920, height: 1080, channels: 4, bytesPerChannel: 2, history: 2 }), 66355200);
```

Assert unsupported timer-query capability returns `supported:false` and never fabricates GPU values.

- [ ] **Step 2: Run RED**

Run: `node --test src/world/cloud/cloud-benchmark.test.mjs`

Expected: FAIL because benchmark helpers do not exist.

- [ ] **Step 3: Implement query and CPU timing**

Wrap only the selected backend render with `EXT_disjoint_timer_query_webgl2`. Discard disjoint queries. Warm 120 frames, record at least 180 valid frames, then compute median and nearest-rank p95. Use `performance.now()` for CPU timing around the same backend work.

- [ ] **Step 4: Implement memory/payload accounting**

Sum owned textures and render targets by real dimensions, channels, bytes/channel, layers, samples and history count. Keep cloud assets separate. Read built chunk/asset byte sizes from the Vite manifest rather than estimating source size.

- [ ] **Step 5: Implement temporal trail metric**

After controlled motion and a stop/camera cut, capture the composited frames and calculate edge residual outside the current cloud mask for two resolved frames. Report the residual ratio and retain the source frames for visual review; do not reduce acceptance to this scalar alone.

For resize, quality and context scenarios, assert the backend resets history before its next render, recreates only the resources whose dimensions/type changed, and releases the superseded resources exactly once.

- [ ] **Step 6: Run GREEN**

Run:

```powershell
node --test src/world/cloud/cloud-benchmark.test.mjs src/world/cloud/cloud-comparison.test.mjs
npm run build
```

Expected: tests and build PASS.

- [ ] **Step 7: Commit**

```powershell
git add -- src/world/cloud/CloudBenchmark.js src/world/cloud/cloud-benchmark.test.mjs src/world/cloud/CloudComparisonHarness.js
git commit -m "feat: measure cloud renderer cost and stability"
```

---

### Task 5: Execute the comparison and decide

**Files:**
- Create evidence: `.agent/cloud-comparison/` (ignored, not committed)
- Create: `docs/cloud-renderer-comparison.md`
- Modify production cloud selection only if Takram passes every gate and the user approves the adoption decision

**Interfaces:**
- Consumes the completed harness.
- Produces metrics JSON, final contact sheets and an adopt/defer/reject report.

- [ ] **Step 1: Run 1920x1080 High matrix**

For every deterministic scenario, run current then Takram in fresh tabs/process states. Save JSON and composited captures. Ensure only one backend is alive during each run.

- [ ] **Step 2: Run 390x844 Phone matrix**

Repeat with Phone settings. If Takram's Phone profile is disabled, capture and benchmark the validated fallback and report that decision explicitly.

- [ ] **Step 3: Build contact sheets and inspect visually**

Create labeled side-by-side sheets for matching backend/scenario/timestamp pairs. Inspect clouds, terrain occlusion, crowns, lighting, horizon silhouettes, objective readability and temporal trails. Numeric alpha or metrics alone cannot pass visual acceptance.

- [ ] **Step 4: Evaluate hard gates**

Reject Takram as shipping default if any hard limit fails: High +2 ms median GPU, High 64 MiB incremental cloud memory, Phone 45 FPS, Phone +0.75 ms median GPU, Phone 24 MiB, two-frame temporal clearing, zero console/WebGL warnings, objective readability or final visual superiority.

- [ ] **Step 5: Write the decision report**

Record exact package/commit versions, machine/browser/viewport, metrics, screenshots, visual verdict, attribution, integration risks and one of:

- `ADOPT`: all gates pass and Takram is materially superior.
- `DEFER`: promising visual advantage but one or more bounded gates fail.
- `REJECT`: no material visual advantage or structural incompatibility.

If not `ADOPT`, leave production backend selection unchanged. If `ADOPT`, stop and request explicit user approval before changing the shipping default.

- [ ] **Step 6: Run full verification**

Run:

```powershell
$tests=@(rg --files src -g '*.test.mjs' -g '*.test.js' | Sort-Object)
node --test $tests
npm run check
npm run build
npm audit --omit=dev
git diff --check
```

Expected: zero failures, clean build/check/audit/diff.

- [ ] **Step 7: Commit harness and report**

```powershell
git add -- docs/cloud-renderer-comparison.md
git commit -m "docs: record cloud renderer comparison"
```
