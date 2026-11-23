# Ground polish: seating, ground LOD, terrain shadow reach, WebGL2 thin casters, cloud error flood, river roads

All captures come from the dev server at `quality=high`, with the camera held by
script. "Before" shots were taken on the old code, or the old behaviour was
reproduced exactly at runtime (as noted for each one).

## 1. Ground vehicles hovering on slopes

**What was wrong:** units hovered on slopes. On m1 the low edge of a unit floated
0.18 m above the ground with no berm under it. A sangar on a slope had its
uphill side buried by 1.04 m.

**Cause:** `seatUnit` fitted a plane, clamped pitch and roll, and then sank the
unit by a fixed `bury` amount. The fixed sink was wrong for both cases: it was
too little for the low edge on a slope, and too much for the high side.

**Fix (`src/assets/unitRig.js`):**
- Fit a least-squares plane over the footprint grid. Pitch and roll are exact
  for the model's `'YXZ'` rotation order.
- Set the base at `max(lowest contact - sink, highest contact - maxBury)`, so
  the high side is never buried more than `maxBury` (per type).
- If the low side still hangs, lean up to a steeper limit first. Add a berm
  sized to the remaining gap only after that.
- `scatterSites` now looks for flat pads (6 m scale, `padSlope`), so fewer
  sites need a berm. On m1 the mean 6 m site slope fell from 0.230 to 0.194,
  and the maximum from 0.43 to 0.36.

**Result:** every edge that hangs more than 0.04 m (0.1 m for aligned units)
has a berm, and no side is buried more than `maxBury`.

**Tests (`unitRig.test.mjs`):**
- A bumpy, twisted slope for 10 types × 4 yaws, checked through the real
  rotation.
- An exact case for an even slope.

**Evidence:**
- `before-sangar-hover.jpeg`, `before-sangar-slope.jpg` → `after-sangar-seated.jpeg`
- `before-aaa-slope-side.jpeg` → `after-aaa-slope-side.jpeg`

## 2. Ground units use the shipped `*_lod1.glb`

**What was wrong:** ground units did not use their shipped `*_lod1.glb` models
at distance.

**Fix (`src/ai/models.js`):**
- `UnitLOD` (a `THREE.LOD`) switches at the catalogue distance (220 m for the
  AAA gun), corrected for FOV and zoom, with 10 % hysteresis.
- Aim pivots are driven on LOD0 and copied to the same-named nodes on LOD1
  every update. A test showed an angle difference of 0.
- Shadow cameras keep the main view's level.
- Wrecks use the same path.

**No GLB was changed.**

**Checks:**
- A convoy at about 250 m, LOD0 against LOD1 forced: the crop diff mean is 1.3
  of 255. Only 25 px differ by more than 24, almost all on the headlight
  sprite. See `convoy-lod0-vs-lod1-250m.jpg`.
- A killed AAA's wreck is a UnitLOD with synced pivots, seated with hang 0.

**Cost:** with 21 units at 762 m, the frame drops from 826.5k to 789.7k
triangles (-36.8k).

## 3. Terrain self-shadow reached only about 46 m above the ground

**What was wrong:** terrain did not shadow anything more than about 46 m above
the ground.

**Cause:** the sweep texture was R8, storing `byte * 0.25 - 16` m, so it
saturated at 47.75 m. To hide the cut-off, `env.terrainShadow` faded the term
out between 36 and 46 m. A unit on a ridge under a low sun, or a jet low in a
valley at dawn, therefore got no terrain shadow at all.

**Fix (`src/world/terrain/shadow*.js`, `material.js`):**
- The texture is now R16F, in metres, clamped to [-64, 8000].
- Half floats keep 0.002 m steps at the terrain's own shadow edge, and relative
  error stays below 0.1 % up to 8 km, so there is no banding at any range.
- The fade is gone.
- The receiver penumbra widens with height (0.02 m per metre).
- The worker writes `Float16Array` where it exists, and otherwise uses an
  exact bit conversion (`shadowConst.test.mjs`).

**Checks (golden hour, a column of probe spheres in a valley shadow 265 m
deep):**
- Old function: spheres at 60, 120 and 250 m were lit.
- New function: spheres at 15, 60 and 120 m are shaded, 250 m is half-shaded
  (penumbra), and 330 m is lit.
- For a like-for-like comparison, both functions were applied to the same
  spheres. The old one was emulated exactly (clamp to [-16, 47.75] plus the
  36-46 m fade).

**Evidence:**
- `before/after-golden-probe-column.jpeg`
- `before/after-golden-probe-120m-agl.jpeg`
- `after-dawn-jet-valley-shadow-110m.jpeg`

**Cost:**
- Memory: 2 B per texel instead of 1. That is +9.4 MB on the 3073² high/ultra
  pack (18.9 MB total) and +4.2 MB on the 2049² pack.
- Upload: 18.9 MB each time the sun moves enough to re-sweep (at most once
  every 250 ms, and only after the sun has moved 0.14°).
- Worker: 85-100 ms per sweep on this loaded, shared machine, off the main
  thread.
- Shader: still one fetch, now R16F instead of R8, and the fade math is
  removed from `makeShadowFn`.
- GPU time: toggling the term on and off moved the frame total by 0.03 ms,
  which is inside the run-to-run noise (see "GPU timing" below).

**Not visually conclusive:** jet shadows from terrain. The jet's direct sun was
weak or cut by cloud shadow in every take, so the probe spheres stand in for
it. `after-dawn-jet-valley-shadow-110m.jpeg` shows the jet in the valley
shadow at 110 m AGL.

## 4. WebGL2: thin masts cast a faint razor-thin line shadow

**What was wrong:** on WebGL2 (and the low tier), a 0.16 m mast standing many
metres above the ground cast a hard, razor-thin line shadow.

**Cause:** these paths use disc PCF with a fixed radius of about 0.14 m. The
WebGPU medium+ path uses PCSS, which widens the penumbra with the distance to
the blocker; disc PCF cannot.

**Fix (`src/world/shadows/SunShadows.js`; outside the strict file list, but it
is where this shadow setup lives):**
- Each tap also compares against a depth 6 m nearer the light.
- If anything that high above the receiver is seen, that part of the occlusion
  is re-filtered over a 0.51 m disc.
- Thin, distant casters fade the way PCSS fades them, and contact shadows stay
  sharp.

**Evidence:** `before-webgl-mast-line.jpeg` → `after-webgl-mast-line.jpeg`, and
the zoomed `webgl-mast-line-crop-before-top-after-bottom.jpg`. The "before" is
the new filter with `farRadius = radius`, which reproduces the old filter.

**Cost:** per shadowed fragment on WebGL2 and the low tier:
- `2 × taps + max(4, taps / 2)` compares, against `taps` before.
- Plus `taps` more only where a far occluder is seen.
- GPU time was not measurable: on this machine WebGL2 timer queries captured
  only 2-6 frames per window.

## 5. `Clouds.js:913` "boundingSphere" error flood

**Cause (reproduced):**
- A single frame with a non-finite camera position in `Terrain.update` made the
  clipmap trim index NaN. `trim.geometry = trimGeo[NaN]` left a mesh with
  undefined geometry.
- NaN bounds pass `Frustum.intersectsBox` (`NaN < 0` is false), so the mesh
  stayed visible.
- The next scene render threw `Cannot read properties of undefined (reading
  'boundingSphere')`.
- The cloud march samples scene depth, so three renders the scene lazily inside
  `Clouds.renderPasses`. The reproduced stack's nearest app frame is
  `Clouds.renderPasses (Clouds.js:913)`, then `PostFX.render`.
- The throw left the renderer bound to the march target, and the eased terrain
  clearance stayed NaN for good.
- A persistent NaN camera repeats the error every frame. The likely source of
  one is the lock or action camera's spring state in `src/camera/views.js`
  (`springVec`). Once NaN, it stays NaN. That file belongs to another owner
  and was not changed.

**Fix:**
- `Terrain.update` keeps the last layout when the camera is non-finite, never
  assigns an undefined trim, and recovers a NaN clearance.
- The cloud passes restore renderer state in `finally`.
- `PassGuard` (`src/world/clouds/passGuard.js`) reports a failure once, naming
  renderables without geometry, then backs off exponentially. It warns on
  failures 1, 2, 4, 8 and so on.
- Tests: `passGuard.test.mjs`.

**Verified in page:**
- One NaN camera frame: 0 errors (was 1 error plus a NaN clearance).
- 3 s of NaN camera: 0 errors, and the terrain stays intact.
- A mesh with undefined geometry injected into the scene: the guard names it
  (`Scene/injectedBroken`). The scene pass's own errors are now attributed to
  `PostFX.render` rather than Clouds, and stop as soon as the mesh is removed.

## 6. Black Road: the convoy drove on the river

**What was wrong:** the night convoys drove in the river.
- col1: 17 of 57 points wet, worst 21 m inside the water.
- col2: 35 of 54 points wet.
- m1 convoy: 29 of 60 points wet.
- 3-5 km of each drive was wet.

**Cause:** `traceValleyRoad` scored candidates by the lowest ground, and the
lowest ground is the riverbed.

**Fix (`src/ai/sites.js`):**
- The fan trace now only finds the valley axis.
- The road is laid beside the axis, resampled every 40 m. A Viterbi pass picks
  a lateral offset (up to 200 m) that minimises a sum of:
  - height
  - `bankPenalty`: a smooth ramp inside 25 m of the bank, hard in the water
  - side-slope
  - lateral moves
  - water crossed between points
- `findSite` valley, flat and pad modes and `scatterSites` pay the same
  penalty. No unit is placed within 6 m of water.

**Routes after merging the mission-balance branch** (col1 7200 m, col2 6800 m;
wet metres measured every 5 m along the drive):

| route | wet before | wet after | mean / max 6 m slope before | after | length before → after |
|---|---|---|---|---|---|
| m1 convoy | 4285 m | 100 m | 0.151 / 1.46 | 0.148 / 0.89 | 9440 → 9699 m |
| night col1 | 2010 m | 95 m | 0.098 / 1.01 | 0.100 / 0.95 | 7200 → 7508 m |
| night col2 | 4685 m | 90 m | 0.114 / 1.08 | 0.098 / 0.44 | 6880 → 6960 m |

**Remaining crossings:** each route keeps two crossings of about 45 m, roughly
perpendicular to the river. The Drass meanders from wall to wall, and even at
40× the water cost these crossings stay, so they are forced. They are
candidates for a bridge or ford prop:
- m1: (-29925, 8030) and (-31945, 7919)
- col1: (-29946, 8023) and (-31537, 7911)
- col2: (-32965, 7801) and (-34812, 7948)

**Ends and arrival:**
- The m1 and col1 ends move by 345 m and 50 m.
- col2 now starts on the dry bank, and the axis from there follows the main
  valley west: it ends at (-38725, 7149) instead of turning south-west to
  (-35924, 3146).
- The new col2 route passes the mission's road guns and second picket
  87-253 m away. The old route was 1.9-3.8 km from them.
- Arrival comes 0-0.3 min later, because the routes are up to 4 % longer.
- road1's anchor point is 618 m from the old col1 route and 631 m from the new
  one, on ground 68 m above the road. That comes from the mission data, not
  from this change, and was left alone.
- No mission data was edited.

**Units in every mission:** none of the 129 ground units is in water or within
6 m of it (`riverEdge` checked per unit). The road guns sit 20-88 m from the
water, on 4 m pad slopes of 0.04-0.29.

**Tests (`ai.test.mjs`):** a road over a synthetic valley with a carved,
meandering river stays dry (the old trace was 29 % wet). Sites and valley
starts avoid the water.

**Evidence:**
- `before-night-convoy-in-river.jpeg`: the old route, same convoy, at night.
- `after-night-convoy-dry-bank.jpeg`: the new route, trucks 10-15 m from the
  water, headlight pools on the gravel bank.

## GPU timing

Other agents' tabs share this GPU, so the in-game profiler's frame totals
(`?gputime`, about 0.6 ms with categories swinging between identical runs) and
the WebGL2 timer queries could not resolve deltas this small.
`Terrain.gpuTime()` hung while the profiler was also resolving timestamps.

The costs above are given as memory, triangles and per-fragment work. Measured
GPU deltas were within noise. They should be re-measured on an idle GPU.
