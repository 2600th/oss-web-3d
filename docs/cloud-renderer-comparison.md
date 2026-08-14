# Cloud renderer comparison decision

## Decision

**REJECT/DEFER Takram as the shipping cloud renderer.** Keep the current renderer unchanged in production. The isolated Takram adapter and comparison harness remain useful research infrastructure, but the reference integration is technically faithful and visually unsuitable for a modern AAA production bar.

The post-fix raw marcher is active and uses the intended Takram inputs. That corrects the earlier null-depth diagnostic, but it does not change the composited result: the reference scene loses recognizable cloud bodies behind terrain, and the Himalayan opening reads as a noisy continuous shelf with vertical curtains rather than convincing discrete volumes. Phone remains disabled and temporal validation is inconclusive.

## Evaluated stack and integration

The isolated prototype pins:

- `@takram/three-clouds@0.7.6`
- `@takram/three-atmosphere@0.19.1`
- `@takram/three-geospatial@0.9.1`
- `@takram/three-geospatial-effects@0.6.4`

The comparison uses the real camera, stable terrain depth, environment, post chain, deterministic route, and one cloud backend at a time. The Takram path uses `BasicDepthPacking`, a WGS84 North-Up-East local frame to translate the game's local Y-up metres into ECEF, generated Bruneton atmosphere LUTs, the official pinned 128x128x64 STBN volume, and official pinned cloud textures. The official cloud-asset payload is **2,859,264 B** and the STBN payload is **1,048,576 B**. These are compatibility requirements of the isolated reference integration, not production changes.

## Fresh Chrome evidence

Unless a capture is explicitly identified as visual-only, the following figures are fresh Chrome High runs at **1920x889**, pixel ratio 1, after 120 warm-up frames with 180 valid samples. GPU timings are dedicated cloud-pass timings, not end-to-end frame times.

### Reference raw cloud evidence

The earlier reference-sky [raw result](../.agent/cloud-comparison/takram-final/reference-alpha-result.json) with `alphaOccupancy=0` was an **invalid diagnostic**: its depth input was null. It must not be used as evidence that the marcher produced no clouds.

After the depth fix, the raw reference-sky output has alpha occupancy **0.82970**, **3,568** connected components, and a maximum horizontal run of **1,920 px**. GPU median is **1.706512 ms** and p95 is **8.583136 ms**. The [post-fix raw capture](../.agent/cloud-comparison/takram-final/reference-alpha-fixed.png) visibly contains broad, stacked cloud sheets; see its [result JSON](../.agent/cloud-comparison/takram-final/reference-alpha-fixed-result.json). This is evidence that the adapted Takram raw march is functioning.

That evidence does not pass visual integration: the [reference composite](../.agent/cloud-comparison/takram-final/reference-composite-fixed.png) is terrain-occluded and does not show recognizable cloud bodies. Its [result JSON](../.agent/cloud-comparison/takram-final/reference-composite-fixed-result.json) is retained as supporting composition evidence, rather than as a fresh 1920x889 performance comparison.

### Himalayan opening: visual failure despite valid raw output

The [Himalayan raw capture](../.agent/cloud-comparison/takram-final/himalayan-alpha.png) records alpha occupancy **0.17834**, top-band alpha **0.35627**, **202** components, and a maximum run of **1,582 px** ([result JSON](../.agent/cloud-comparison/takram-final/himalayan-alpha-result.json)). The raw output therefore contains cloud coverage, not an empty march.

The corresponding [opening composite](../.agent/cloud-comparison/takram-final/himalayan-opening-composite-1080.png) is visually unsuitable: it is a noisy continuous shelf with vertical curtains, not readable, sculpted cloud volumes. Its [result JSON](../.agent/cloud-comparison/takram-final/himalayan-opening-composite-1080-result.json) reports GPU median **1.189824 ms**, p95 **7.903648 ms**, **120.4819 FPS**, total owned resources **82,810,624 B** (78.97 MiB), and objective contrast **0.07627**. The resource result exceeds the 64 MiB High ceiling; the contrast reading does not override the human composited visual review.

The [side-bank composite](../.agent/cloud-comparison/takram-final/himalayan-side-bank-composite.png) and its [result JSON](../.agent/cloud-comparison/takram-final/himalayan-side-bank-composite-result.json) measure GPU median **1.117488 ms**, p95 **8.454944 ms**, and **59.8802 FPS**. They are supporting performance/visual evidence, not a passing visual result.

### Temporal, transition, resize, and context lifecycle

The [fast-motion stop](../.agent/cloud-comparison/takram-final/fast-motion-stop.png) measures GPU median **0.721584 ms**, p95 **8.006400 ms**, and **119.0476 FPS** ([result JSON](../.agent/cloud-comparison/takram-final/fast-motion-stop-result.json)). Temporal stability remains **UNVERIFIED**: the cloud masks cover **99.9996%** and **99.9994%** of the frames, so the measurement has no valid outside-cloud pixels for a trail conclusion. It is not evidence of zero ghosting.

The [chase-to-recon cut result](../.agent/cloud-comparison/takram-final/chase-to-recon-cut-result.json) records the history reset exactly at the camera cut and has clean lifecycle evidence. The [resize result](../.agent/cloud-comparison/takram-final/resize-result.json) is likewise clean. These validate the transition contracts, not the final visual-quality gate.

Context restoration is now **VERIFIED** after `a62fc43`: the live supported loss at frame **140** and restore at frame **150** reset history before rendering and fully recreate resources. The [fixed capture](../.agent/cloud-comparison/takram-final/context-restore-fixed.png) and [result JSON](../.agent/cloud-comparison/takram-final/context-restore-fixed-result.json) record GPU median **0.806544 ms**, p95 **0.823328 ms**, **120.4819 FPS**, and `consoleIssues=[]`. This replaces the archived [pre-fix context error](../.agent/cloud-comparison/takram-final/context-restore-pre-fix-error.json); it does not change the visual decision.

### Phone and isolated payload

The [High-to-Phone result](../.agent/cloud-comparison/takram-final/high-to-phone-result.json) is **UNVERIFIED** because Takram is disabled on Phone. It owns **0 B** of render targets and **21,580,460 B** of retained resources. This is a disabled-path observation, not a timing, FPS, memory-budget, or fallback-quality pass.

The fresh comparison-build chunks are isolated from the normal production entry and therefore are not production boot-cost measurements:

| Chunk | Raw | Gzip |
|---|---:|---:|
| Comparison entry | 212.59 kB | 62.88 kB |
| Takram | 292.76 kB | 67.08 kB |
| Postprocessing | 692.87 kB | 206.32 kB |

## Hard-gate result

| Required gate | Result | Evidence-based reason |
|---|---|---|
| Clearly superior final composited visuals | **FAIL** | Reference clouds become terrain-occluded/no recognizable bodies; Himalayan output is a noisy shelf with vertical curtains. |
| No fog wall, flat shelf, discs, or terrain-colored invisibility | **FAIL** | The Himalayan opening visibly contains the continuous shelf/curtain failure mode. |
| Opening objective remains readable | **PASS** | Measured opening contrast is 0.07627, but this gate alone cannot accept the composition. |
| High median GPU regression no more than +2 ms | **NOT COMPARABLE** | Fresh Takram timings exist, but no matching fresh current-backend 1920x889 run is used as a baseline. |
| High owned memory at most 64 MiB | **FAIL** | 82,810,624 B (78.97 MiB) in the fresh opening run. |
| Phone at least 45 FPS and no more than +0.75 ms | **FAIL (disabled)** | The Phone route is disabled and UNVERIFIED; it establishes no usable fallback. |
| Phone owned memory at most 24 MiB | **UNVERIFIED** | Zero target bytes are only a disabled-path observation, not a functioning Phone profile. |
| No trail after two resolved frames | **UNVERIFIED** | Nearly full-frame masks leave no valid outside-cloud pixels for the temporal test. |
| Zero warnings through context recovery and lifecycle | **PASS** | Verified live loss/restore has `consoleIssues=[]`, reset-before-render, and full resource recreation. |
| Production build isolation | **PASS** | The normal production entry does not import the isolated comparison chunks. |
| Full tests, GLSL checks, and builds | **PASS** | Fresh final verification: 271/271 tests, GLSL check, production build, isolated comparison build, and diff check passed. |

## Scope of comparison evidence

Earlier current-backend 1920x1080 captures are prior evidence with a different viewport and older cadence schema. They are intentionally not used as a direct baseline for the fresh Takram 1920x889 figures above. This report makes no fresh current-versus-Takram FPS or GPU-regression claim until matched captures exist.

## Why Takram is stronger, but not a drop-in

The Takram/three-geospatial stack is a stronger research foundation than a simple copied cloud demo: it supplies depth-aware volumetric composition, temporal reconstruction, multilayer weather, Beer shadow maps, physically based atmosphere LUTs, official stochastic sampling data, and explicit geospatial transforms.

Those same assumptions make it unsuitable as a drop-in replacement here. The game uses a compact local Y-up world, custom stable depth and composer ownership, tight Phone/High budgets, and an authored reconnaissance corridor. Takram assumes an ellipsoidal ECEF world, requires coordinate/depth/LUT/STBN adaptation, owns large full-resolution history and shadow resources, and has no enabled Phone profile in this prototype. The fresh raw evidence establishes technical fidelity; the final composited imagery establishes that this integration is visually unsuitable for shipping.

## Recommended next cloud architecture

Continue shipping the current lightweight renderer and evolve it behind the existing `CloudRenderer` contract. Prototype only the high-value ideas independently: neighborhood/variance temporal rejection with reliable disocclusion masks, a budgeted low-resolution Beer shadow map, and authored weather volumes that preserve the objective corridor. Keep atmosphere LUT work separable from cloud rendering, use explicit local-world coordinates, retain a real Phone tier, and require matched composited captures plus cloud-only GPU, memory, temporal, and visual gates before any production switch.
