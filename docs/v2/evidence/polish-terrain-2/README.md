# Terrain and sky polish 2: ground cover, close-range detail, terrain AO, clouds

Branch `worktree-agent-aa7e2ae32fff1a1d5`, based on `webgpu-aaa` at d708635.

## How the shots were taken

- Every pair was taken at 1600×900 on the WebGPU backend with tier `high`, unless noted.
- Poses are fixed world-space cameras from `bench2.js`. The jet is parked out of view, the cloud clock is pinned and the FOV is pinned at 62°.
- **Caveat:** the `before-*` set was shot before the FOV pin was added, so framing differs by a few percent in some pairs (for example `valley-100m`). Same camera position, yaw, pitch, time of day and weather.

| Pose | What it checks | Before | After |
|---|---|---|---|
| valley-100m | scrub and grass on the Drass valley floor, 10:30 | `before-valley-100m.jpeg` | `after-valley-100m.jpeg` |
| valley-50m | the same ground at noon, from 50 m | `before-valley-50m.jpeg` | `after-valley-50m.jpeg` |
| noon-200m | the "oil puddle" case, 200 m at noon | `before-noon-200m.jpeg` | `after-noon-200m.jpeg` |
| slope-250m | scree and talus slope with a river below, 15:00 | `before-slope-250m.jpeg` | `after-slope-250m.jpeg` |
| ridge-1km | a ridge from 1 km, cumulus over it | `before-ridge-1km.jpeg` | `after-ridge-1km.jpeg` |
| river-bank | gravel bars, wet edge, riparian green and fields, 80 m | `before-river-bank.jpeg` | `after-river-bank.jpeg` |
| snowline | the snow line breaking into patches | `before-snowline.jpeg` | `after-snowline.jpeg` |
| golden-clouds | golden hour into the sun | `before-golden-clouds.jpeg` | `after-golden-clouds.jpeg` |
| storm | the storm preset from a valley, 15:45 | `before-storm.jpeg` | `after-storm.jpeg` |
| night | moonlit valley floor | `before-night.jpeg` | `after-night.jpeg` |
| WebGL2 | `?webgl`, noon-200m | — | `after-webgl2-noon-200m.jpeg` |

**Best pairs**
- `river-bank`: round black discs become cushion shrubs and boulders. A wet gravel edge appears, green only by the water, and an irrigated village with walls and poplar rows.
- `valley-100m` and `noon-200m`: the black "holes" are gone. The flat-floor ripple ("worms") is gone.
- `golden-clouds`: the white plateau to the right of the sun now resolves into lit cloud edges and gaps.
- `slope-250m`: the green wash along the river becomes a patchy riparian strip plus distinct village oases.

## 1. Ground cover (was: dark round blotches)

**Cause.** The old scrub was one dark disc per cell. Its albedo was under half the ground's, it had no lit top and no shape variation, and it was sharp-edged at every distance. From 100–500 m and at night it read as holes or oil.

**Now** (`material.js`, "shrubs and boulders"):
- 5 m cells, nearest 2×2 searched, each holding at most one clump.
- Shrub density comes from moisture (the new ground layer), vegetation and slope, and falls off with altitude. Clumps group by a 140 m cluster noise, so there are bare patches and denser stands.
- Shape: three lobes plus a ragged rim, radius 0.35–1.25 m. Cushion species colours (sage, caragana green, dry cushion), varied per clump.
- Lighting: a lit crown highlight, a contact AO ring, and a short capsule cast shadow on the anti-sun side (direct light only). A dome normal is used near the camera.
- Far away each clump fades to the mean cover, so there are no aliasing dots.
- Boulders (rotated hexagonal hulls, 0.35–1.75 m) gather on debris fans, talus and gravel. Their shading model is the same as the shrubs'.
- **Fields:** irrigated strip fields appear only where the ground layer says the land is irrigable. That means near water but not in it, on flat ground below about 3,600 m. They are grouped into villages by a 2.6 km noise.
  - Plots run along the river (the flow direction at the centre of each 420 m block), warped by a few metres.
  - Plots are barley or alfalfa green, ripening, fallow or stubble, with drill rows near the camera.
  - Stone walls bound the plots, and poplar or willow rows line some long edges, with their shadow.
  - Walls, rows and crops are prefiltered to their mean cover once a pixel spans several metres. Without this, moiré stripes appeared at 3–5 km.
- **Riparian green:** only where the moisture layer is high, so it follows water channels and drains. Elsewhere the ground stays dry steppe.
- Instanced 3D clumps were **not** done. The shading-only clumps hold up at 50 m and above; below about 20 m AGL they are flat.

## 2. Close-range detail (50–300 m AGL)

- **Debris fans and talus.** `groundData.js` G channel marks ground below steep faces: high upslope relief, a gentle local slope, and a drop from above. These areas get more talus weight and paler, coarser scree.
- **Wet gravel at the river edge.** A ragged strip about 11 m wide. Albedo is halved where wet, with sand in the hollows. Gravel bars come from the existing river layer.
- **Patchy snow line.** The line is perturbed by macro noise (±230 m), slope shedding, curvature, wind streaks and a new 97 m patch octave (`DETAIL.SNOW_PATCH`). It breaks into patches instead of a contour.
  - The terms live in `snow.js` so `assets/system.js` (`siteSnow`) uses the identical formula. The berm bug was the missing macro term.
- **Flat-floor ripple ("worms").** The cavity albedo term used the unit-amplitude detail field even where the detail amplitude is about 0, on valley floors. It is now scaled by `smoothstep(0.6, 4, amp)`, with the coarse octave and ledge down-weighted.
- **Rock albedo.** Rock tan, rust and ochre scree were warmed and made slightly more saturated, for example rock tan (0.225, 0.168, 0.118).
  - These are against the reference set used by the earlier texture and realism passes:
    - https://commons.wikimedia.org/wiki/File:Drass_and_Tololing_Range.jpg
    - https://commons.wikimedia.org/wiki/File:The_Tiger_Hill_(3976856895).jpg
    - https://commons.wikimedia.org/wiki/File:Panorama_of_Kargil.jpg
    - https://commons.wikimedia.org/wiki/File:Landscape_on_kargil_to_leh_road.jpg
    - https://commons.wikimedia.org/wiki/File:Lower_Suru_Valley_landscape_near_Purtikchay_between_Sanku_and_Panikhar.JPG
  - The correction was judged by eye against those photos. They were not pixel-sampled in this pass.
- Strata on outcrops come from the existing ledge term and `streakAt`. Neither was rebuilt.
- Instanced 3D boulders with GPU culling were **not** done.

## 3. Terrain AO

Both options are done.

**Freed sampler slots.** `tex.surf` and `tex.river` are merged with a new ground layer into one `DataArrayTexture`, `tex.land`, with 3 layers. The terrain fragment stage now uses **14 of 16** sampled textures, measured with `renderer.debug.getShaderAsync` on the WebGPU backend; it was 15.

**GTAO on the terrain.**
- The scene pass skips `terrainLit` materials, so the terrain samples `post.ao` itself (r = AO, g = −view depth).
- It uses the same same-surface depth test (4 % of depth, 0.2 m minimum) and the same intensity.
- `world/system.js` binds it each frame through `terrain.bindNearAO(post.ao)`.
- Low tier and WebGL2 have no `post.ao`; there a 1×1 white placeholder keeps the shader unchanged.

**Heightfield near AO.**
- `groundData.js` R channel: sky visibility above the local tangent plane, scanned in 8 directions at 1, 2, 3, 5 and 8 texels at full DEM resolution. The scan runs in a worker in about 3.7 s on the hi pack and about 1.9 s on lo in the browser.
- It darkens gullies, stream cuts and the feet of walls, which the coarse sky-visibility term missed.
- Strength: `terrain.uniforms.nearAO`.

## 4. Clouds (`src/world/clouds/Clouds.js`)

References:
- A. Schneider and N. Vos, "The Real-Time Volumetric Cloudscapes of Horizon Zero Dawn", SIGGRAPH 2015 Advances in Real-Time Rendering.
- A. Schneider, "Nubis: Authoring Real-Time Volumetric Cloudscapes with the Decima Engine", SIGGRAPH 2017 Advances.
- S. Hillaire, "Physically Based Sky, Atmosphere and Cloud Rendering in Frostbite", SIGGRAPH 2016 PBS course.
- M. Wrenninge et al., "Oz: The Great and Volumetric", SIGGRAPH 2013 talk (octave multiple scattering).

**Remap erosion (Nubis).** `n = (n − erode) / (1 − 0.85·erode)` replaces the plain subtraction. The detail eats thin rims far more than dense cores, so edges fray while bodies stay solid.

**Wisps.** In the outer rim (within 2.5 × softness of the edge), density follows the detail noise. The result is fibres and holes rather than a smooth ramp.

**Silver lining and forward scattering.**
- The forward lobe was HG(g = 0.96), which peaks near 97 sr⁻¹. Every thin rim clipped to a flat white plateau with a block-shaped edge.
- It is now HG(`silverG` = 0.9), capped at `phaseCap`.
- The dual-lobe phase weight changed from 0.72 forward to 0.62 forward / back (Hillaire 2016), keeping the Wrenninge octaves.
- Powder and multiple-scattering octaves are unchanged.

**Sun-glow region.** Rays within about 28° of the sun (`glow`) get three things:
- 35 % shorter march steps;
- softer rims (`glowSoft`);
- less fresh weight in the temporal resolve (`glowHistory`), except for near cloud, whose parallax needs fresh samples.

These address resolution and temporal stability where they show most. The cloud buffer scale itself was not raised: that is the engine's tier table, not mine (see notes).

**Base darkening.** The storm absorb term is stronger under dense cores: `storm·(0.45·wet + 0.35)·(1 − 0.8·h)`, scaled with coverage. The ambient "pouch" floor was raised from 0.35 to 0.62, so non-storm cumulus bases are not crushed.

**Storm anvils.**
- A new `anvilTarget` pass looks upwind (8 taps × 3 lateral, fanning out) for tall, wet, well-covered cells.
- The march spreads the top 70–95 % of the layer into a flat shelf there.
- It runs only while `storm > 0`.

**Rain shafts.**
- Rain falls only under dense, wet cores; before, any cloud over 30 % cover rained.
- Shafts are slanted downwind by the fall (wind / 7 m/s).
- They are streaked by two weather-noise octaves, and thinner just under the base (virga).
- Sampling: 10 samples (6 on low), spaced quadratically so that shafts a few km away resolve.
- Rain colour is darker (ambient × 0.5) and picks up a little forward-scattered sun.

**What it looks like**
- Golden hour: clearly better. The rims are soft and the bright area near the sun shows structure.
- Storm preset (coverage 0.86): it is almost overcast, so the anvil shelf merges with the deck and is not distinguishable. The darker base is visible but modest.
- Rain shafts: read as slanted veils under cells at 3–8 km, but **subtle**. They are not the dramatic dark curtains of reference photos.
- With coverage lowered to 0.55 under the storm preset (a live override, not a preset), isolated cells show dark bases and rain veils.
- An isolated-thunderstorm preset would show the anvil better. Presets live in `Environment.js`, which I do not own.

## 5. Small items

- **`siteSnow`** (`src/assets/system.js`) now calls `snowCover(...)` from `terrain/snow.js` with the same macro, detail, streak and patch terms as the shader. Berms no longer paint snow on rock the terrain shows bare.
- **`SWEEP_REACH`** (`src/world/shadows/shadowMath.js`; the brief said `terrain/shadowMath.js`) is now `{ full: SHADOW_MAX − 500, none: SHADOW_MAX }`. The test was updated. Nothing in the game reads it any more.
- **Scorches:** `vfx.scorches` has not landed. `terrain.setScorches([{x, z, radius, age}], {life})` is a clean hook: up to 16 burn rings darken the albedo, in a branch skipped when the count is 0.

## GPU cost

**Setup**
- 2560×1440 canvas, DPR 1. The canvas was forced through `innerWidth`/`innerHeight` overrides because the shared browser window could not be resized.
- Measured on the WebGPU backend. The GPU was shared with other agents' game instances.
- Measure: median whole-frame GPU timestamp (`renderer.info.render.timestamp`, `?gputime`), quantised to about 0.065 ms. Tool: `gpucost2.js`.
- Branch vs base: the same poses on this branch and with the base files swapped back in (`git checkout d708635 -- …`), in the same page and server. Each pose ran 15 s; valley-100m and golden-clouds ran twice.

| Tier | Pose | Base (ms) | This branch (ms) | Added |
|---|---|---|---|---|
| high | valley-100m (×2) | 1.507, 1.507 | 1.638, 1.638 | **+0.13** |
| high | noon-200m | 1.573 | 1.769 | **+0.20** |
| high | golden-clouds (×2) | 1.769, 1.769 | 1.901, 1.966 | **+0.13 to +0.20** |
| high | storm | 1.376 | 1.507 | **+0.13** |
| ultra | valley-100m (×2) | 1.835, 1.704 | 1.901, 1.966 | **+0.07 to +0.26** |
| ultra | noon-200m | 1.769 | 2.032 | **+0.26** |
| ultra | golden-clouds (×2) | 1.901, 1.901 | 2.097, 2.097 | **+0.20** |
| ultra | storm | 1.573 | 1.638 | **+0.07** |

**Result:**

| Budget | Measured (worst pose) | Status |
|---|---|---|
| high ≤ +0.8 ms | about +0.13 to +0.20 ms | within |
| ultra ≤ +1.2 ms | about +0.20 to +0.26 ms | within |
| low: no regression | not timed (see below) | not measured |

These numbers come from a busy, shared GPU with coarse timer quanta and about 10 resolved frames per 15 s, so treat them as upper-bound estimates. The base and branch runs were separate page loads, minutes apart.

**In-page A/B, terrain AO sampling** (GTAO + heightfield AO, `aoStrength`/`nearAO` 0 → 1), high, valley-100m, 4 rounds: 1.638 → 1.704 ms. Per-round deltas: +0.07, +0.13, +0.07, +0.13.

**Low tier.** Nothing new is built: no `post.ao`, so a placeholder is used. The ground layer does cost about 2 s in a worker at load, with no frame cost. The rain loop keeps 6 samples. The shrub and field branches do run on low (same shader). Low renders without errors, but I did not time it.

## Memory and packs

- No pack was rebuilt. `public/assets/terrain/**` and `public/textures/**` are unchanged, so pack sizes are unchanged.
- **GPU memory:**
  - `tex.land` gains a third RGBA8 layer at 3073² (hi pack): +37.8 MB, about +50 MB with mips.
  - `anvilTarget`: one RGBA8 render target at the weather resolution (1024², +4 MB; 512² on low).
  - The terrain amplitude moved to a vertex varying, so there is no new texture.
- **Load:** the ground worker runs about 3.7 s on hi and 1.9 s on lo, off the main thread. Until it finishes, the ground layer is neutral (open sky, no fans, dry).

## Verification

**Checked:**
- `npm test`: 297 pass, including the new `groundData.test.mjs` (6) and `shadowMath.test.mjs` (8).
- `npm run build` passes and emits `groundWorker-*.js`.
- WebGPU at `high` and `ultra`; `?quality=low`; `?webgl`. All render with no console errors or warnings.

**Not verified:**
- Medium tier.
- Mobile.
- The scorch hook with real data (it was exercised only at count 0).
- Instanced 3D clumps and boulders (not built).
