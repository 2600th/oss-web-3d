# Cloud Renderer Comparison Design

## Goal

Determine with real evidence whether Takram's `three-geospatial` cloud and atmosphere stack can deliver a materially better modern-game sky than the current custom WebGL cloud renderer without breaking mission readability, performance, memory or lifecycle constraints.

This is an isolated A/B prototype and evaluation first. Takram does not become the shipping default unless it wins the gates below.

## Why prototype instead of replacing directly

Takram is the strongest reviewed production reference: it offers depth-aware postprocessing integration, temporal reconstruction, multilayer volumetric clouds, Beer shadow maps and physically based atmosphere LUTs. Its current cloud/atmosphere packages are nevertheless Beta, pull React/R3F peer dependencies into this vanilla application, add substantial assets and render targets, and are moving toward an incompatible node-based API.

The earlier single-file cloud demo is useful for Perlin-Worley density research but its renderer, TAA, readback and lifecycle architecture are not suitable for direct adoption. The CK42BB repositories are art-direction documents rather than executable packages.

## Prototype architecture

Create a narrow renderer contract shared by both candidates:

- construction from renderer capabilities and quality tier;
- size/pixel-ratio update;
- depth texture and camera matrices;
- sun/environment inputs;
- per-frame update and render/composite;
- cloud-shadow output contract;
- history reset on camera cut, quality change and resize;
- deterministic disposal and resource accounting.

Adapters:

1. `CurrentCloudRendererAdapter` wraps the existing `CloudVolume` behavior without changing its shipping result.
2. `TakramCloudRendererAdapter` pins `@takram/three-clouds@0.7.6`, `@takram/three-atmosphere@0.19.1`, `@takram/three-geospatial@0.9.1` and `@takram/three-geospatial-effects@0.6.4`, then maps Takram's depth, atmosphere, temporal and shadow outputs into the comparison contract.

Only one backend renders at a time. The comparison harness uses the real flight camera, terrain depth, sun, HDR/post chain and opening mission route. It must not run both cloud renderers concurrently during timing or memory measurement.

## Isolation

- The production game continues to select the current backend while evaluation is underway.
- Takram dependencies and attribution remain isolated to the prototype until accepted.
- No second tone mapper, renderer, terrain owner, water owner or world clock is introduced.
- React/R3F wrapper exports are not used; only vanilla renderer/effect classes are allowed.
- All upstream versions, assets and notices are pinned and recorded.

## Comparison scenarios

Run each backend through the same deterministic scenarios:

1. Opening route at 3.5, 10 and 25 seconds.
2. Side-bank flyby with terrain foreground and sky background.
3. Fast yaw/pitch camera motion followed by a stop to expose temporal ghosting.
4. Camera cut between chase and recon.
5. Objective acquisition at 8 km, 3 km and photographic framing range.
6. Sun-facing and backlit cloud views for crown, silver-lining and base readability.
7. High desktop at 1920x1080 and Phone at 390x844.

## Measurement

- GPU time uses `EXT_disjoint_timer_query_webgl2` after warmup, reporting median, p95 and disjoint samples.
- CPU frame time and allocation behavior are captured after at least 120 warmup frames.
- GPU memory is estimated from every owned texture/render target format, dimensions, layers and history buffer, with assets reported separately.
- Boot payload records compressed and uncompressed bytes added by code and cloud/atmosphere data.
- Temporal stability uses controlled camera motion plus frame-difference/edge-trail measurements and composited screenshots.
- Objective readability records target contrast, cue visibility and whether clouds obscure the required reconnaissance line of sight.
- Disposal tests account for all textures, render targets, materials, effects, event handlers and history buffers.

## Acceptance gates

Takram may replace the current backend only if all conditions hold:

- Independent visual review finds clearly superior cloud volume, crowns, lighting, scale and atmospheric integration in final composited captures.
- No horizon fog wall, ruler-flat shelf, camera-space discs or terrain-colored invisibility.
- The central opening route and active objective remain readable; authored weather may frame but not block reconnaissance.
- 1920x1080 High sustains the project frame target with no more than a 2 ms median GPU regression over the current backend.
- Phone Low remains at or above 45 FPS on the available test surface and adds no more than 0.75 ms median GPU time; otherwise Takram must be disabled on Phone with a validated fallback.
- Incremental cloud framebuffer/texture memory stays within 64 MiB on High and 24 MiB on Phone, excluding shared composer targets.
- No visible history smear after a camera cut and no persistent disocclusion trail after two resolved frames.
- Zero console/WebGL/shader warnings across resize, quality switch, recon cut, context loss/recovery and disposal.
- Full test suite, GLSL checks and production build pass.

If Takram does not win, retain the current renderer and separately evaluate only its most valuable concepts: neighborhood/variance temporal rejection and Beer shadow maps. A failed prototype must be fully removable without changing the production backend.

## Deliverables

- Both adapters and the isolated comparison harness.
- Reproducible benchmark command/runbook.
- High and Phone metrics in machine-readable JSON.
- Side-by-side contact sheets for every scenario.
- A written adopt/defer/reject decision with exact package versions, attribution, measured costs and remaining risks.
