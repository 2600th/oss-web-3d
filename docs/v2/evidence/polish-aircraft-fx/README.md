# Aircraft FX polish: wingtip vapour, rudder and airbrakes, convoy headlight beams

Branch `worktree-agent-ace0f6550478cfe9d`. In-game shots: Chrome, WebGPU,
quality `high` unless the file name says otherwise, 1600 x 900, game paused
with the camera held (`cameraRig.devHold`). The G-LOC greyout was switched off
in the page for the turn shots, so the colours are the effect's own.

## 1. Wingtip vapour

**What was wrong.** In hard turns at dawn the wingtip vortices were thick,
brown, opaque ropes. At noon they were heavy white tubes. At night they were
dark grey ropes.

**Cause.** There were two causes.

- **Lighting.** Every trail, the vortex included, was lit like smoke. Sun
  irradiance was used raw, with no 1/pi, against 0.34 x sky radiance / pi.
  - With a low sun that is about 100:1. The lit side came out saturated
    orange and the far side near black.
  - Condensation is water. It is lit mostly by the sky around it, plus a rim
    and a forward-scatter lobe toward the sun.
- **Shape.** The vortex style started at 0.11 m radius, grew 0.3 m/sqrt(s),
  lived 2.6 s, and had optical depth 1. By its tail it was a 1.5-2 m opaque
  rope.
  - The over-wing sheet lived 0.11 s, which is a 40 m flat band at combat
    speed.

**Fix.** Commit `c238a00`.

- **Lighting.** `Shared.vapourLight(ndl, cosSun, shadow)` is new in
  `src/vfx/core/shared.js`. It adds:
  - the sun irradiance / pi as a wrapped rim;
  - a forward lobe of cosSun^6;
  - the zenith and horizon sky (the new `horizonColor` uniform) and ground
    ambient.

  It is used by the condensation trails (a style with `glow < 0`), the vapour
  wisps (thin particles) and the vapour cone.
- **Shape.**
  - The vortex is now 4.5 cm growing 0.13 m/sqrt(s) over 1.25 s, at about half
    the density. It is a translucent thread.
  - The sheet lasts 0.035 s, about one wingspan.
- **Gating.** `vapourGates(amount, humidity)` in `src/vfx/core/ring.js`:
  - tip threads need some moisture;
  - the sheet over the wing and the wisps need high G and humid air (tested).
- **Chase-view artefact.** Trail segments the camera sits next to now fade out.
  At night they were drawing as flat panes in the chase view.

**Screenshots.** The before shots are from the same hard-turn setup.

| | Before | After |
|---|---|---|
| Dawn, chase | `before-vapour-dawn-chase.png` | `after-vapour-dawn-chase.png` |
| Dawn, side / fly-by | `before-vapour-dawn-side.png` | `after-vapour-dawn-flyby.png` |
| Noon, chase | `before-vapour-noon-chase.png` | `after-vapour-noon-chase.png` |
| Night, chase | `before-vapour-night-chase.png` | `after-vapour-night-chase.png` |

**References.** All were found by web search. I read the explanatory pages.
For the photo pages I relied on their search captions; I did not inspect each
image.

- Vortex-core condensation, with a worked humidity example (marginal at 35 %
  RH with the core at 80 % of ambient pressure):
  https://en.wikipedia.org/wiki/Wingtip_vortices
- Fog in the core when the air is nearly saturated:
  https://aiaa.org/detail/lesson/Aerospace-Micro-Lesson-55
- Vapour cones: zones where pressure and temperature fall below the dew point:
  https://sfu.ca/physics/demos/demos-experiments/vapour-cones.html
- F-16 minimum-radius turn showing LERX vortex condensation (USAF photo):
  https://www.shaw.af.mil/News/Photos/igphoto/2000552208
- F-16 demo jet in a high-G turn (USAF photo):
  https://www.volkfield.ang.af.mil/Media/Photos/igphoto/2000329116/
- Fighter in a high-G vertical turn with wing condensation (Gripen):
  https://uk.flightaware.com/photos/view/872819-2ebee1a77e0c437ea47fa24f3f1067e29a895044
- I found no MiG-21-specific photo of wing vapour. The MiG-21 is rated to
  +8.5 g in later variants, so a hard pull in humid air is in its envelope.

## 2. Rudder and airbrakes

**What was wrong.** The rudder and the airbrakes did not move. They were part
of the one `airframe` mesh, with no pivots.

**Fix.** Commit `1e5f449`.

- **Mesh.** `tools/blender/build_mig_moving.mjs` cuts the rudder and the two
  forward airbrake panels out of `airframe`, in place, in `mig21.glb`,
  `mig21_hostile.glb` and `mig21_hostile_lod1.glb`.
  - Each panel goes onto `<name>_hinge` (fixed frame) → `<name>` (pivot,
    rotation.x) → mesh.
  - The script is idempotent; `--check` reports only.
  - `probe_mig_moving.mjs` lists the islands it found.
- **Animation** (`src/assets/controlSurfaces.js`):
  - Rudder: +-25 deg, washed out to +-8 deg at high speed, 60 deg/s. It is
    driven by the commanded yaw (`flight.yawCommand`), or by the yaw rate when
    there is no command.
  - Airbrakes: 35 deg in about a second, blown back at high speed
    (`airbrakeTravel`), driven by `flight.airbrake` (Ctrl / Z).
- **Hostiles.** They use the same rig through `demandsFromRates()`. The rudder
  comes from the yaw rate and the airbrakes from hard deceleration.
- **Tests.** `controlSurfaces.test.mjs` has 13 tests, covering rates, limits,
  player and hostile demands, and that the pivots exist in all three GLBs.

**Screenshots:**

- `after-rudder-right.png`: rudder at about 21 deg.
- `after-airbrakes-open.png` and `after-airbrakes-closed.png`.

**Not verified visually:** the hostile animation in flight. The node test
checks that the pivots exist in the hostile GLBs, and the code path is shared.

**Known limitations:**

- The forward airbrake panels in this mesh are narrow (about 0.6 x 0.1 m).
  Their inner face shows the primer-coloured interior when they are open.
- The ventral airbrake has no separate panel in the mesh, so it is not
  animated.

## 3. Convoy headlight beams

**What was wrong.** At night the trucks had glowing lamp sprites, but nothing
lit the road. From the air a convoy read as pairs of dots, with no pools of
light.

**Fix.** This commit.

- **Renderer.** `src/world/timeofday/lights/HeadlightBeams.js` (new) draws all
  beams as one instanced draw of light volumes in the VFX layer, which can read
  scene depth. There is no light per vehicle and nothing new casts shadows.
  - **Box.** Each beam is a box in front of the lamps, rasterised by its back
    faces.
  - **Ground pool.** The scene point behind each pixel is rebuilt from depth
    and lit by a dipped-beam pattern:
    - +-24 deg spread;
    - a sharp cut-off just under the horizon, with 2 % spill;
    - 1/d^2 falloff, flattened so the hot spot lies down the road.
  - **Soft cone.** It is not drawn on `low`. It is a few-step single-scatter
    march with a Henyey-Greenstein phase, jittered per pixel so the slab steps
    do not band.
- **Tuning** (`src/world/timeofday/lights/beams.js`, pure and node-tested):
  - `BEAM` holds the tuning values.
  - `BEAM_TIERS` sets per-tier capacity, march steps, range and draw distance:

    | Tier | Beams | March steps | Range | Draw distance |
    |---|---|---|---|---|
    | low | 12 | 0 (pool only) | 34 m | 6 km |
    | medium (also WebGL2) | 24 | 4 | 40 m | 9 km |
    | high | 48 | 6 | 45 m | 12 km |
    | ultra | 64 | 8 | 50 m | 15 km |

  - `beamSlots()` picks the nearest beams.
- **Hook-up** (`src/timeofday/system.js`):
  - Every vehicle given headlights also gets a beam.
  - The beam is created lazily once `systems.vfx` is ready.
  - Dead or unparented vehicles lose their sprites and beam on the same frame.
    This check was a 1 s scan and is now per frame.
  - Beams fade in over `env.night` from 0.25 to 0.65, and the mesh is not
    drawn at all by day.

**Problems found while tuning:**

1. **The nearest truck's pool was nearly missing.**
   - The vehicle roots stay level and their models are slope-seated. On a rise
     the road ahead sat above the dipped cut-off.
   - Fix: the beam axis now follows the road slope sampled 16 m ahead, through
     `terrainHeight`. This is a read-only import from
     `src/world/terrain/heightfield.js`.
2. **The pool came out faceted and sawtoothed at its far edge.**
   - At a few degrees of incidence, the flat-shaded terrain triangles'
     screen-derivative normal swings cos(incidence) by about 2x from facet to
     facet.
   - Fix: the incidence term is now mostly that of the road plane under the
     lamps, with 35 % of the real normal kept, gated off for surfaces turned
     away.
3. **The cone showed grain and bands near the lamp.**
   - Fix: a lamp-size softening of the 1/r^2 peak, plus interleaved-gradient
     jitter of the march.

**Screenshots** (Black Road night sortie, `?mission=night`):

- `before-headlights-near.png` and `before-headlights-far.png`: lamp dots only.
- `after-headlights-near.png`: pools and a faint cone on the two nearest
  trucks.
- `after-headlights-far.png`: the convoy from 600 m, five pools strung along
  the river road.
- `after-headlights-ground.png`: a low chase view next to a truck.
- `after-headlights-destroyed.png`: a truck killed through
  `combat.world.kill`. Its beam is gone on the next frame (items 5 → 4) and the
  next truck's beam stays.
- `after-headlights-day.png`: `env.setTimeOfDay(12)`. `on = 0`, the mesh is
  hidden and nothing is drawn.
- `after-headlights-near-low.png`: `?quality=low`, pool only.
- `after-headlights-near-webgl.png`: `?webgl`, medium tier. There were no
  console errors on `low` or `webgl`.

**Reference.** The low-beam shape comes from a headlamp patent:
https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/6626565. It
describes a sharp horizontal cut-off line, the brightest zone just under it,
and about 40 m of road lit.

**Seen in passing, not touched:**

- In the Black Road sortie, some trucks drive through the river water.
- This is AI and ground pathing, which is outside this task's paths.

## GPU cost (`?gputime`, high, WebGPU, 1600 x 900)

**Headlight beams.** An A/B test in the same paused frame, with the beams'
`update` swapped for one that hides the mesh. The figure is the mean GPU time
per frame over about 230 frames each.

- **Method.** I summed the renderer's raw per-pass timestamp queries per
  frame.
  - `__perf.profiler.result` read 0 ms totals in my page. I did not
    investigate why.
  - Chrome quantises each pass to about 0.065 ms, so only the mean is
    meaningful.

| View | Beams on | Beams off | Delta |
|---|---|---|---|
| Convoy from 60 m above, 2 beams large on screen (5 drawn) | 0.701 / 0.699 ms | 0.694 ms | about +0.006 ms |
| Low chase next to a truck (5 drawn) | 0.853 / 0.849 ms | 0.862 ms | within noise (±0.01 ms) |

- The beams stay well under the +0.3 ms budget on this GPU.
- The cost scales with the screen area the volumes cover and with the march
  steps. Low has no march, at most 12 beams and a 34 m range.
- I did not measure on a low-end GPU.

**Vapour.** Not A/B measured.

- The change adds a few ALU ops per condensation pixel (`vapourLight`).
- It also cuts work. Vortex segments are now about 0.58x as many (life 2.6 s
  / 3 m spacing became 1.25 s / 2.5 m) and much thinner on screen, and the
  sheet lives about a third as long.
- There are no new draws or passes. The net cost should be at or below the old
  effect's, but that is reasoned, not measured.

**Rudder and airbrakes.** Three extra pivot nodes per MiG.

- The meshes were split from `airframe`, adding 3 small meshes per aircraft
  (+3 draws: the rudder and two airbrake panels).
- GLB sizes grew by +38 KB, +38 KB and +14 KB.
- The CPU cost is three extra actuator updates per aircraft.
