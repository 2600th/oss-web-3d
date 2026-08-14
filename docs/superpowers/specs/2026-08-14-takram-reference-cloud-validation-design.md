# Takram Reference Cloud Validation Design

## Goal

Make the isolated cloud comparison render a faithful Takram reference configuration and a Takram-guided Himalayan configuration so a human can judge the actual volumetric result in the existing terrain, camera, HDR, depth and post-processing pipeline. This work does not change the shipping cloud renderer.

## Confirmed Problem

The existing Takram comparison is not a faithful reference configuration. It enables one sparse layer from 6,000 to 7,250 metres with density scale `0.08`, coverage `0.2`, and local-weather repeat `620 x 540`. The `opening-3.5` camera resolves to about 7,235 metres geodetic altitude, only about 15 metres below that layer's zero-density upper boundary. Upward rays therefore leave through negligible density while downward rays are clipped by terrain depth, producing a clear sky and terrain-coloured vertical noise rather than readable clouds.

Takram's pinned `CloudLayers.DEFAULT` instead defines two cumulus layers and one cirrus layer, uses density scale `0.2` for cumulus, and the vanilla example sets coverage to `0.4`. `CloudsEffect` defaults local-weather repeat to `100 x 100`. The vanilla integration also supplies precomputed atmosphere textures, official cloud textures, STBN noise, and composes `CloudsEffect` with `AerialPerspectiveEffect`.

## Scope and Isolation

- Preserve the production game and `CurrentCloudRendererAdapter` output exactly.
- Keep Takram code, assets, routes and diagnostics confined to the comparison build.
- Preserve the existing renderer contract, stable depth texture, WGS84 North-Up-East transform, sun transform, history lifecycle, benchmarking and deterministic disposal.
- Do not use React or React Three Fiber wrappers.
- Do not accept the Takram backend for production as part of this change.
- Preserve exact upstream versions and attribution already recorded by the comparison prototype; add hashes and notices for any newly copied official assets.

## Reference Profiles

The comparison query gains a required `profile` dimension for the Takram backend.

### `takram-reference`

This profile reproduces the pinned upstream vanilla guidance:

- coverage `0.4`;
- local-weather repeat `100 x 100`;
- local-weather velocity `0.001, 0`;
- `CloudLayers.DEFAULT` values exactly:
  - red: altitude `750`, height `650`, density `0.2`, full shape/detail, bias `0.35`, filter width `0.6`, shadow enabled;
  - green: altitude `1,000`, height `1,200`, density `0.2`, full shape/detail, bias `0.35`, filter width `0.6`, shadow enabled;
  - blue: altitude `7,500`, height `500`, density `0.003`, shape `0.4`, no detail, bias `0.35`, filter width `0.5`;
- official pinned local-weather, shape, shape-detail, turbulence, STBN and Bruneton atmosphere textures;
- Takram haze and accurate lighting enabled for the ordinary composited reference view;
- a dedicated reference camera scenario that is clearly outside every layer boundary and does not place cumulus below the visible terrain.

The exact upstream layer altitudes are geodetic and mostly below Himalayan terrain. Therefore this profile proves reference fidelity and integration correctness, not final mission art direction.

### `takram-himalayan`

This profile preserves Takram's vanilla density model, shape/detail amounts, weather exponents, filter widths, coverage, repeat, assets and lighting. It changes only layer altitude placement to fit the existing terrain:

- red cumulus is translated above representative valley/ridge clearance while retaining its `650` metre thickness;
- green cumulus is translated by the same offset while retaining its `1,200` metre thickness;
- cirrus is raised only as needed to remain above the opening camera and cumulus crowns;
- the opening camera must be at least `500` metres from every layer's top or bottom zero-density boundary;
- no active cumulus interval may be fully below the visible terrain envelope of its validation scenario.

The exact Himalayan altitude offset is derived once from deterministic scenario terrain samples and is exposed in the machine-readable result. It is not tuned independently per frame or camera.

## Composition and Diagnostics

The ordinary reference path uses one Takram cloud effect plus Takram aerial perspective in the same dedicated comparison `EffectPass`, matching upstream ordering. Cloud overlay, shadow and shadow-length change events are wired into the aerial-perspective effect. The production sky and tone-mapping chain remain the final owner; no second tone mapper is introduced.

Three deterministic display modes are available through the isolated comparison URL:

1. `view=composite`: final HDR/post-processed image with the selected Takram profile.
2. `view=cloud-alpha`: Takram's resolved `cloudsPass.outputBuffer` alpha displayed directly, with haze disabled, to prove actual volumetric occupancy.
3. `view=cloud-color`: resolved Takram cloud radiance displayed directly before the final post chain.

Diagnostics are comparison-build-only, publish their mode in the result JSON, and cannot enter the production bundle.

## Scenarios

Both profiles run the existing deterministic opening, side-bank, motion, recon-cut and objective scenarios. The validation set adds:

- `reference-sky`: camera between the exact upstream cumulus and cirrus shells with visible sky silhouettes;
- `himalayan-opening`: the real opening route with altitude-translated cumulus banks framing but not blocking the route;
- `himalayan-side-bank`: an oblique terrain/cloud view exposing cloud bases, crowns and depth intersection;
- `cloud-buffer`: the same camera used for composite, cloud-alpha and cloud-color captures.

All camera poses are terrain-clamped and record geodetic altitude plus distance to the nearest cloud boundary.

## Error Handling and Eligibility

- Missing or invalid official assets make the run ineligible; no 1 x 1 fallback may be labelled a faithful reference.
- A camera within `500` metres of a zero-density layer boundary makes the visual run ineligible.
- Shader, depth, LUT, STBN, history or context warnings are retained in the result JSON and fail the run.
- If Takram aerial perspective cannot integrate without duplicating or corrupting the production atmosphere, the result is explicitly labelled `standalone-cloud-composite`, not `takram-reference`.
- Resource ownership remains exact: copied/loaded assets, effects, passes, render targets, listeners and temporary diagnostic materials must be released exactly once.

## Test Strategy

Implementation is test-first.

### Static and numeric contracts

- `takram-reference` equals the pinned upstream layer, coverage, repeat and velocity values exactly.
- `takram-himalayan` changes only altitude fields and retains all other Takram values exactly.
- deterministic scenario sampling proves the Himalayan camera/terrain/layer separation requirements.
- official asset dimensions, formats, byte counts and hashes match the pinned upstream sources.
- comparison query parsing rejects unsupported profile/view combinations.
- production builds contain no Takram profile, diagnostic, asset or aerial-perspective symbols.

### Runtime contracts

- `cloud-alpha` reads the public Takram resolved cloud buffer, not a reconstructed mask from final colour.
- haze is disabled only for raw diagnostics and restored for composite rendering.
- Clouds and aerial perspective update once per composer frame in upstream order.
- resize, quality, camera cut, profile switch and context restoration reset history before the next render.
- profile switching recreates only resources whose inputs changed and disposes superseded resources exactly once.

### Visual and performance gates

At 1920 x 1080 High, fresh Chrome captures must show:

- at least two recognisable volumetric cloud bodies with irregular silhouettes;
- readable darker bases and brighter crowns or silver lining;
- clear sky gaps and an unobstructed central objective corridor;
- no terrain-aligned speckled curtains, ruler-flat shelf, screen-space discs or full-width haze wall;
- non-empty raw cloud alpha in the same screen regions as composite cloud bodies;
- no persistent temporal trail after two resolved frames;
- zero console, WebGL or shader warnings.

The result records cloud-pass GPU median/p95, end-to-end cadence, exact GPU memory, asset payload and objective contrast. These measurements are compared with the current renderer but do not override human visual rejection.

## Deliverables

- Reference/Himalayan profile module and tests.
- Official pinned comparison assets with hashes and attribution.
- Takram aerial-perspective composition adapter and lifecycle tests.
- Raw cloud-alpha/cloud-colour diagnostic modes.
- Deterministic reference and Himalayan scenarios.
- Fresh machine-readable results and 1920 x 1080 Chrome captures for both profiles.
- An updated comparison decision that distinguishes reference fidelity, Himalayan suitability and production adoption.

