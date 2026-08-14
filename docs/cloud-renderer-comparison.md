# Cloud renderer comparison decision

## Decision

**REJECT Takram as the shipping cloud renderer; defer further Takram integration.** Keep the current renderer unchanged in production. Retain the isolated comparison adapter and harness as research infrastructure.

Takram's cloud pass was within the desktop GPU-regression allowance, but the prototype failed the High-memory, Phone, temporal-validation, context-recovery-evidence, and final visual-quality gates. Its opening capture shows terrain-colored vertical breakup, a noisy horizon shelf, and incomplete-looking cloud volume. That is not a material visual upgrade over the current result.

## Evaluated stack and integration

The isolated prototype pins:

- `@takram/three-clouds@0.7.6`
- `@takram/three-atmosphere@0.19.1`
- `@takram/three-geospatial@0.9.1`
- `@takram/three-geospatial-effects@0.6.4`

The comparison uses the real camera, terrain depth, environment, post chain, deterministic route, and one cloud backend at a time. Takram required explicit `BasicDepthPacking` for the stable depth texture; a WGS84 North-Up-East local frame to translate the game's local Y-up metre coordinates into ECEF; generated Bruneton atmosphere LUTs; and Takram's official pinned 128x128x64 STBN volume. These are compatibility requirements, not production changes.

## Measured evidence

### 1920x1080 High, opening at 3.5 seconds

GPU figures time the dedicated cloud pass after 120 warm-up frames and use 180 valid WebGL timer-query samples. They are not end-to-end frame time or an FPS claim.

| Backend | GPU median | GPU p95 | Owned GPU memory | Objective contrast | Console issues |
|---|---:|---:|---:|---:|---:|
| Current | 0.712320 ms | 0.799296 ms | 10,878,976 B (10.38 MiB) | 0.0015077 | 0 |
| Takram | 1.306640 ms | 1.405408 ms | 90,551,104 B (86.36 MiB) | 0.0437193 | 0 |

Takram regressed median cloud-pass GPU time by 0.594320 ms, which is inside the +2 ms desktop allowance. Its owned memory is 79,672,128 B (75.98 MiB) above current and 23,442,240 B (22.36 MiB) over the 64 MiB High ceiling. Both opening runs recorded 180 end-to-end frame intervals at a 10.0 ms median cadence. The objective was on-screen and terrain-visible in both captures, but a higher local contrast number does not override the failed composited visual review.

Evidence: [current opening JSON](../.agent/cloud-comparison/current-high-opening-1080.json), [Takram opening JSON](../.agent/cloud-comparison/takram-high-opening-1080.json), [current opening capture](../.agent/cloud-comparison/current-high-opening-1080.png), [Takram opening capture](../.agent/cloud-comparison/takram-high-opening-1080.png).

### 390x844 Phone

The current backend measured 0.051360 ms median / 0.062720 ms p95 and 683,968 B owned memory. Takram's Phone profile is explicitly disabled: it produced no timing samples, allocated no Takram targets, and reported `takram-disabled-phone`. This is not a measured 0 ms pass and does not prove a 45 FPS fallback.

Evidence: [current Phone JSON](../.agent/cloud-comparison/current-phone-opening-390x844.json), [Takram Phone JSON](../.agent/cloud-comparison/takram-phone-opening-390x844.json), [current Phone capture](../.agent/cloud-comparison/current-phone-opening-390x844.png), [Takram-disabled Phone capture](../.agent/cloud-comparison/takram-phone-opening-390x844.png).

### Temporal stability and context recovery

The current renderer's fast-motion stop was verified: residual ratios were 0.0057822 after resolved frame 1 and 0.0042936 after frame 2. Takram is **UNVERIFIED** because the derived cloud mask covered 99.9353% and 99.9130% of the frame, leaving zero outside-cloud pixels for the trail measurement. This cannot be interpreted as zero ghosting. The saved Takram fast-motion and current context-loss runs predate the corrected end-to-end cadence schema, so their FPS fields are not accepted as current evidence.

The current backend also completed a real context loss at frame 150 and restoration at frame 154, rebuilding history and continuing with 180 valid GPU samples and no console issues. No equivalent saved Takram context-loss run exists, so Takram fails that evidence gate.

Evidence: [current temporal JSON](../.agent/cloud-comparison/current-high-fast-motion-1080.json), [Takram temporal JSON](../.agent/cloud-comparison/takram-high-fast-motion-1080.json), [current frame-1 heatmap](../.agent/cloud-comparison/current-temporal-frame-1.png), [current frame-2 heatmap](../.agent/cloud-comparison/current-temporal-frame-2.png), [current context-loss JSON](../.agent/cloud-comparison/current-high-context-loss-1080.json), [current context-loss capture](../.agent/cloud-comparison/current-high-context-loss-1080.png).

### Isolated comparison payload

These are comparison-build chunks, not production boot-cost measurements:

| Chunk | Raw | Gzip |
|---|---:|---:|
| Comparison entry | 176,414 B | 52,663 B |
| Takram | 292,762 B | 66,569 B |
| Postprocessing | 690,167 B | 204,286 B |

The normal production entry does not import Takram; therefore these figures describe the removable prototype, not a shipped payload regression.

## Hard-gate result

| Required gate | Result | Evidence-based reason |
|---|---|---|
| Clearly superior final composited visuals | **FAIL** | Takram shows horizon noise/shelf, vertical terrain-colored breakup, and weak cloud-body definition. |
| No fog wall, flat shelf, discs, or terrain-colored invisibility | **FAIL** | The opening capture contains a noisy shelf and terrain-colored transparency/breakup. |
| Opening objective remains readable | **PASS** | On-screen, terrain visibility 1.0, contrast 0.0437193; this gate alone is insufficient. |
| High median GPU regression no more than +2 ms | **PASS** | +0.594320 ms dedicated cloud-pass median. |
| High owned memory at most 64 MiB | **FAIL** | 86.36 MiB total; 75.98 MiB incremental over current. |
| Phone at least 45 FPS and no more than +0.75 ms | **FAIL** | Takram disabled; no timing/FPS samples or measured fallback. |
| Phone owned memory at most 24 MiB | **PASS** | Disabled profile owns 0 B, but this does not rescue the failed Phone experience gate. |
| No trail after two resolved frames | **FAIL** | UNVERIFIED: approximately 99.9% full-frame mask left zero valid outside pixels. |
| Zero warnings through context recovery and lifecycle | **FAIL** | Opening runs were clean, but no saved Takram context-loss/recovery result exists. |
| Production build isolation | **PASS** | Takram remains confined to the dedicated comparison build. |
| Full tests, GLSL checks, and builds | **PASS** | Fresh verification: 234/234 tests, GLSL check, production build, and isolated comparison build passed. |

## Why Takram is stronger, but not a drop-in

The Takram/three-geospatial stack is a stronger research foundation than a simple copied cloud demo: it supplies depth-aware volumetric composition, temporal reconstruction, multilayer weather, Beer shadow maps, physically based atmosphere LUTs, official stochastic sampling data, and explicit geospatial transforms.

Those same assumptions make it unsuitable as a drop-in replacement here. The game uses a compact local Y-up world, custom stable depth and composer ownership, tight Phone/High budgets, and an authored reconnaissance corridor. Takram assumes an ellipsoidal ECEF world, requires coordinate/depth/LUT/STBN adaptation, owns large full-resolution history and shadow resources, and has no acceptable enabled Phone profile in this prototype. The visual defects also show that successful shader compilation and geospatial correctness are not sufficient integration quality.

## Recommended next cloud architecture

Continue shipping the current lightweight renderer and evolve it behind the existing `CloudRenderer` contract. Prototype only the high-value ideas independently: neighborhood/variance temporal rejection with reliable disocclusion masks, a budgeted low-resolution Beer shadow map, and authored weather volumes that preserve the objective corridor. Keep atmosphere LUT work separable from cloud rendering, use explicit local-world coordinates, retain a real Phone tier, and require matching composited captures plus cloud-only GPU/memory/temporal gates before any production switch.
