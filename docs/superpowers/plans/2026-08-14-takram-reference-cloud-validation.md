# Takram Reference Cloud Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render faithful Takram reference clouds and an altitude-translated Himalayan variant in the isolated comparison build, expose raw cloud-buffer diagnostics, and produce fresh Chrome evidence without changing production clouds.

**Architecture:** A pure profile module owns exact upstream parameters and deterministic Himalayan altitude translation. The existing Takram adapter consumes a selected profile and official pinned assets. The comparison harness adds Takram aerial perspective and raw buffer display modes behind isolated URL parameters while retaining its lifecycle auditor and benchmarks.

**Tech Stack:** Three.js 0.185.1, postprocessing 6.39.4, `@takram/three-clouds@0.7.6`, `@takram/three-atmosphere@0.19.1`, `@takram/three-geospatial@0.9.1`, Vite, Node test runner, Chrome comparison harness.

## Global Constraints

- Preserve the production `CloudVolume`, `CurrentCloudRendererAdapter`, game entry point and production bundle output exactly.
- Keep all Takram profiles, assets, diagnostics and aerial-perspective code inside the isolated comparison build.
- Use exact pinned Takram default layer values, vanilla coverage `0.4`, local-weather repeat `100 x 100`, and velocity `0.001, 0` for `takram-reference`.
- `takram-himalayan` may change only layer altitude; density, shape, detail, weather, coverage and repeat remain identical to `takram-reference`.
- Require at least `500` metres between every validation camera and every zero-density layer boundary.
- Missing or invalid official assets make a reference run ineligible; do not silently label a fallback run as faithful.
- Use test-driven development: each production behavior must be preceded by a test that fails for the intended missing behavior.
- Do not commit diagnostic captures or benchmark JSON unless the repository already tracks their directory; keep transient evidence under `.agent/cloud-comparison/`.

---

### Task 1: Pure Takram profile and scenario-altitude contract

**Files:**
- Create: `src/world/cloud/TakramCloudProfiles.js`
- Create: `src/world/cloud/takram-cloud-profiles.test.mjs`
- Modify: `src/world/cloud/TakramCloudRendererAdapter.js`
- Modify: `src/world/cloud/takram-cloud-renderer.test.mjs`

**Interfaces:**
- Produces `TAKRAM_PROFILE_NAMES`, `getTakramCloudProfile(name)`, `deriveHimalayanCloudProfile({ terrainMin, terrainMax, cameraAltitude })`, `nearestLayerBoundaryDistance(layers, altitude)`, and `validateTakramProfileScenario(profile, sample)`.
- `TakramCloudRendererAdapter` consumes `profileName` and applies a cloned profile so upstream defaults are never mutated.

- [ ] **Step 1: Write failing pure-profile tests**

Add literal expectations for the three exact pinned upstream layers, coverage `0.4`, repeat `[100, 100]`, velocity `[0.001, 0]`, and a Himalayan fixture with `terrainMin=4_700`, `terrainMax=6_300`, `cameraAltitude=7_235.246`. Assert that only `altitude` changes, the camera is at least `500` metres from every boundary, and cumulus is not wholly below terrain.

- [ ] **Step 2: Verify the pure-profile tests fail for the missing module**

Run:

```powershell
node --test src/world/cloud/takram-cloud-profiles.test.mjs
```

Expected: failure with `ERR_MODULE_NOT_FOUND` for `TakramCloudProfiles.js`.

- [ ] **Step 3: Implement the minimal pure profile module**

Use frozen literal source data. Place both cumulus layers above the opening camera with one deterministic offset: `max(terrainMax + 350 - 750, cameraAltitude + 500 - 750)`. This keeps the lowest cumulus base at least 350 metres above the terrain envelope and 500 metres above the camera while preserving the exact 650/1,200 metre layer thicknesses. Raise the cirrus base to at least 300 metres above the translated green-layer top. Reject unknown profile names and samples that violate the `500` metre boundary or terrain-envelope rules.

- [ ] **Step 4: Extend adapter tests before adapter changes**

Construct reference and Himalayan adapters. Assert reference profile consumer-visible values exactly; assert the Himalayan adapter changes only layer altitude and reports `profileName`, `layerBoundaryDistance`, and the applied translation in `getResourceReport().metadata` or a dedicated `getProfileReport()`.

- [ ] **Step 5: Verify adapter tests fail on the old hard-coded opening profile**

Run:

```powershell
node --test src/world/cloud/takram-cloud-renderer.test.mjs
```

Expected: failures because the constructor lacks `profileName`, still applies coverage `0.2`, repeat `620 x 540`, and one sparse layer.

- [ ] **Step 6: Make the adapter consume the selected profile**

Delete `OPENING_CLOUD_LAYERS`. Add constructor inputs `profileName='takram-reference'` and optional `profileContext`. Apply the profile's coverage, repeat, velocity and cloned layers. Preserve quality, WGS84, depth, LUT, STBN and lifecycle behavior.

- [ ] **Step 7: Run focused profile and adapter tests green**

```powershell
node --test src/world/cloud/takram-cloud-profiles.test.mjs src/world/cloud/takram-cloud-renderer.test.mjs
```

Expected: all pass with no warnings.

- [ ] **Step 8: Commit Task 1**

```powershell
git add src/world/cloud/TakramCloudProfiles.js src/world/cloud/takram-cloud-profiles.test.mjs src/world/cloud/TakramCloudRendererAdapter.js src/world/cloud/takram-cloud-renderer.test.mjs
git commit -m "feat: add faithful Takram cloud profiles"
```

---

### Task 2: Official pinned cloud asset loader

**Files:**
- Create: `src/world/cloud/TakramCloudAssets.js`
- Create: `src/world/cloud/takram-cloud-assets.test.mjs`
- Create: `public/cloud-comparison/takram/local_weather.png`
- Create: `public/cloud-comparison/takram/shape.bin`
- Create: `public/cloud-comparison/takram/shape_detail.bin`
- Create: `public/cloud-comparison/takram/turbulence.png`
- Modify: `src/world/cloud/TakramCloudRendererAdapter.js`
- Modify: `src/world/cloud/CloudComparisonHarness.js`
- Modify: `public/THIRD_PARTY_NOTICES.txt`

**Interfaces:**
- Produces `TAKRAM_CLOUD_ASSET_MANIFEST`, `loadOfficialTakramCloudAssets(loaders)`, and `disposeTakramCloudAssets(assets)`.
- The harness awaits the asset promise before warmup and calls `backend.setCloudTextures(assets)`.

- [ ] **Step 1: Record exact package asset fixtures in a failing test**

Assert these literal pinned fixtures:

- `local_weather.png`: 512 x 512, 679,653 bytes, SHA-256 `B84DAEF855DC5EEBCC9B174FE832BA75A98E44B846DDE201BCE354417CC08031`;
- `shape.bin`: 128 x 128 x 128 R8, 2,097,152 bytes, SHA-256 `EF65CF6156894720C00BF572C49E3E254F8899C4B5158246E5A35A1922E2519C`;
- `shape_detail.bin`: 32 x 32 x 32 R8, 32,768 bytes, SHA-256 `C09112199C6E0281B74FF5283C11C2943AE082650B9B67978CF5D59ED2956E4F`;
- `turbulence.png`: 128 x 128, 49,691 bytes, SHA-256 `EC2B1B0AF4A6A6104102B21E58BEB300B0A3D334C0281D84FDE8C91D322910F9`.

Assert missing, wrong-sized or wrong-hash inputs reject with an ineligible-reference error. Assert disposal releases each loaded texture exactly once.

- [ ] **Step 2: Verify the asset test fails for the missing loader**

```powershell
node --test src/world/cloud/takram-cloud-assets.test.mjs
```

Expected: `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Copy the four pinned package assets mechanically**

Create `public/cloud-comparison/takram/` and copy the four binary assets from `node_modules/@takram/three-clouds/assets/`. Recompute SHA-256 after copying and fail if any differs from the manifest fixture.

- [ ] **Step 4: Implement official asset loading and formats**

Use `TextureLoader` for PNGs and `Data3DTexture` for binary volumes. PNGs use `LinearMipmapLinearFilter`, `LinearFilter`, repeat wrapping, `NoColorSpace`; R8 volumes use `LinearFilter`, repeat wrapping on S/T/R, `NoColorSpace`, and the literal dimensions above. Validate before publishing assets. Do not fall back to procedural resources for a faithful run.

- [ ] **Step 5: Write failing adapter/harness tests for official-asset eligibility**

Assert the adapter accepts all four textures, reports `official-pinned`, stops owning procedural cloud textures, excludes them from memory accounting, and does not dispose harness-owned official assets. Assert the harness marks a load failure ineligible before the first benchmark frame.

- [ ] **Step 6: Wire the asset seam minimally**

Add `setCloudTextures(assets)` to the adapter. In the harness, load official cloud assets alongside official STBN and atmosphere LUTs, apply them before warmup, include their exact payload/GPU bytes once, and dispose them from the harness.

- [ ] **Step 7: Extend the shipped third-party notice**

Add the exact `@takram/three-clouds@0.7.6` asset provenance, upstream repository/tag or commit, copyright and MIT terms without changing existing notices.

- [ ] **Step 8: Verify assets, adapter and harness**

```powershell
node --test src/world/cloud/takram-cloud-assets.test.mjs src/world/cloud/takram-cloud-renderer.test.mjs src/world/cloud/cloud-comparison.test.mjs
npm run check
```

Expected: all pass; copied hashes match.

- [ ] **Step 9: Commit Task 2**

```powershell
git add public/cloud-comparison/takram public/THIRD_PARTY_NOTICES.txt src/world/cloud/TakramCloudAssets.js src/world/cloud/takram-cloud-assets.test.mjs src/world/cloud/TakramCloudRendererAdapter.js src/world/cloud/CloudComparisonHarness.js src/world/cloud/cloud-comparison.test.mjs
git commit -m "feat: load official Takram cloud assets"
```

---

### Task 3: Takram aerial-perspective composition

**Files:**
- Create: `src/world/cloud/TakramAtmosphereComposition.js`
- Create: `src/world/cloud/takram-atmosphere-composition.test.mjs`
- Modify: `src/world/cloud/CloudComparisonHarness.js`
- Modify: `src/world/cloud/cloud-comparison.test.mjs`

**Interfaces:**
- Produces `createTakramAtmosphereComposition({ camera, scene, clouds, textures, renderer })` returning `{ effects, passes, updateBindings, getResourceReport, dispose }`.
- `effects` is ordered `[clouds, aerialPerspective]`; `passes` contains any required normal pass before the dedicated effect pass.

- [ ] **Step 1: Write a failing real-object composition test**

Construct pinned `CloudsEffect` and `AerialPerspectiveEffect` objects. Assert cloud change events update aerial `overlay`, `shadow`, and `shadowLength`; both receive the same LUTs and ECEF sun direction; the effect order is clouds then aerial perspective; disposal removes listeners and releases owned normal resources once.

- [ ] **Step 2: Verify RED**

```powershell
node --test src/world/cloud/takram-atmosphere-composition.test.mjs
```

Expected: missing-module failure.

- [ ] **Step 3: Implement minimal composition owner**

Use `AerialPerspectiveEffect` from the pinned Takram atmosphere package and `NormalPass` from postprocessing only when upstream sun/sky lighting requires it. Set no tone mapper. Forward cloud overlay/shadow events exactly as the upstream vanilla example. Snapshot/restore renderer target state around initialization and disposal paths that touch render targets.

- [ ] **Step 4: Write failing harness ordering and isolation tests**

Assert the comparison composer has Render/Depth/Normal as required, then one dedicated effect pass containing Clouds and AerialPerspective in that order, before radiance/final output. Assert production build imports remain unchanged.

- [ ] **Step 5: Wire the composition into Takram comparison only**

Replace the Takram-only dedicated single-effect installation with the composition object's effect list and optional normal pass. Current-backend installation stays unchanged. Include exact extra resources in benchmark accounting and lifecycle auditing.

- [ ] **Step 6: Verify focused composition and comparison tests**

```powershell
node --test src/world/cloud/takram-atmosphere-composition.test.mjs src/world/cloud/cloud-comparison.test.mjs src/world/cloud/cloud-benchmark.test.mjs
npm run check
npm run build
npm run build:cloud-comparison
```

Expected: tests/check/builds pass; production asset scan has no Takram symbols.

- [ ] **Step 7: Commit Task 3**

```powershell
git add src/world/cloud/TakramAtmosphereComposition.js src/world/cloud/takram-atmosphere-composition.test.mjs src/world/cloud/CloudComparisonHarness.js src/world/cloud/cloud-comparison.test.mjs
git commit -m "feat: match Takram cloud atmosphere composition"
```

---

### Task 4: Raw cloud-buffer diagnostics and deterministic validation scenarios

**Files:**
- Create: `src/world/cloud/CloudBufferDebugEffect.js`
- Create: `src/world/cloud/cloud-buffer-debug-effect.test.mjs`
- Modify: `src/world/cloud/CloudComparisonHarness.js`
- Modify: `src/world/cloud/cloud-comparison.test.mjs`
- Modify: `src/world/cloud/comparison.html`

**Interfaces:**
- Query accepts `profile=takram-reference|takram-himalayan` and `view=composite|cloud-alpha|cloud-color` for Takram.
- Produces machine-readable `profile`, `view`, `cameraGeodeticAltitude`, `nearestLayerBoundaryDistance`, `cloudAssetMode`, `compositionMode`, and `eligibility` fields.

- [ ] **Step 1: Write failing query/scenario tests**

Assert literal parsing/defaults, rejection of raw Takram views for the current backend, and new `reference-sky`, `himalayan-opening`, `himalayan-side-bank`, and `cloud-buffer` scenario outputs. Assert Himalayan poses are terrain-clamped and at least `500` metres from a boundary. Assert `reference-sky` is explicitly labelled `sky-only-reference`, bypasses terrain depth only in raw diagnostic views, and can never be reported as an in-scene mission capture.

- [ ] **Step 2: Verify RED**

```powershell
node --test src/world/cloud/cloud-comparison.test.mjs
```

Expected: failures for missing profile/view fields and scenarios.

- [ ] **Step 3: Add parser and deterministic scenario data**

Thread profile/view through harness construction, event application, result JSON and page title. Derive Himalayan profile context from deterministic terrain samples before adapter construction.

- [ ] **Step 4: Write failing real debug-effect test**

Use a 2 x 2 float texture fixture with known RGBA values. Assert alpha mode returns grayscale alpha, colour mode returns RGB, and haze state is restored when switching back to composite. Assert the effect samples `cloudsPass.outputBuffer.texture` by identity after a history swap.

- [ ] **Step 5: Implement the minimal debug effect**

Create a small postprocessing `Effect` with one texture uniform and a numeric mode uniform. In raw modes set `clouds.haze=false`, keep Takram updating first, and display the resolved output buffer. Restore authored haze in composite mode. Keep the effect comparison-only.

- [ ] **Step 6: Add visual eligibility measurements**

Read raw output-buffer pixels after warmup and report alpha occupancy, connected-component count above the fixed alpha threshold, top-half occupancy, maximum full-width run, and whether alpha regions overlap final composite cloud contrast. Mark runs ineligible when raw alpha is empty, camera separation fails, or official assets are absent.

- [ ] **Step 7: Verify diagnostics, scenarios, lifecycle and builds**

```powershell
node --test src/world/cloud/cloud-buffer-debug-effect.test.mjs src/world/cloud/cloud-comparison.test.mjs src/world/cloud/cloud-benchmark.test.mjs
npm run check
npm run build
npm run build:cloud-comparison
```

Expected: all pass; production grep finds no profile/view/debug symbols.

- [ ] **Step 8: Commit Task 4**

```powershell
git add src/world/cloud/CloudBufferDebugEffect.js src/world/cloud/cloud-buffer-debug-effect.test.mjs src/world/cloud/CloudComparisonHarness.js src/world/cloud/cloud-comparison.test.mjs src/world/cloud/comparison.html
git commit -m "feat: add Takram cloud visual diagnostics"
```

---

### Task 5: Chrome visual gate, benchmark evidence and decision update

**Files:**
- Modify: `docs/cloud-renderer-comparison.md`
- Transient evidence: `.agent/cloud-comparison/takram-reference-*.png`, `.agent/cloud-comparison/takram-himalayan-*.png`, `.agent/cloud-comparison/*.json`

**Interfaces:**
- Uses `window.__cloudComparison.startRun()` and the hidden result/artifact nodes already exposed by the isolated harness.
- Produces a human-reviewed reference/Himalayan verdict and leaves both comparison URLs open in Chrome.

- [ ] **Step 1: Run the complete automated verification before Chrome**

```powershell
node --test src/world/cloud/*.test.mjs
npm run check
npm run build
npm run build:cloud-comparison
git diff --check
```

Expected: all tests/check/builds pass and the worktree is free of unrelated changes.

- [ ] **Step 2: Start or reuse the Vite comparison server**

Serve the isolated comparison build on a fixed local port. Verify both URLs load:

```text
/src/world/cloud/comparison.html?backend=takram&quality=high&profile=takram-reference&view=composite&scenario=reference-sky
/src/world/cloud/comparison.html?backend=takram&quality=high&profile=takram-himalayan&view=composite&scenario=himalayan-opening
```

- [ ] **Step 3: Capture raw and composite reference evidence in Chrome**

At 1920 x 1080, run and save `cloud-alpha`, `cloud-color`, and `composite` captures for `reference-sky`. Confirm raw alpha regions correspond to final cloud bodies and console issues are empty.

- [ ] **Step 4: Capture raw and composite Himalayan evidence in Chrome**

At 1920 x 1080, run and save `himalayan-opening` and `himalayan-side-bank` captures in all three views. Confirm at least two irregular bodies, dark bases/bright crowns, clear sky gaps, central corridor readability, and no terrain-coloured vertical curtains or horizon shelf.

- [ ] **Step 5: Run performance, temporal and lifecycle scenarios**

Capture GPU median/p95, cadence, exact memory, official asset payload, objective contrast, fast-motion temporal evidence, recon cut, resize, high-to-phone fallback, and context restore. Do not label unavailable measurements as verified.

- [ ] **Step 6: Update the decision report from measured evidence**

Record whether reference integration is correct, whether the Himalayan profile is visually suitable, and whether production adoption remains rejected/deferred. Link every persisted artifact and distinguish human visual acceptance from numeric alpha presence.

- [ ] **Step 7: Run final verification after the report**

```powershell
node --test src/world/cloud/*.test.mjs
npm run check
npm run build
npm run build:cloud-comparison
git diff --check
git status --short
```

Expected: clean verification; only intentional report/code/assets are present.

- [ ] **Step 8: Commit Task 5 and leave Chrome on the two composite views**

```powershell
git add docs/cloud-renderer-comparison.md
git commit -m "docs: record Takram reference cloud validation"
```
