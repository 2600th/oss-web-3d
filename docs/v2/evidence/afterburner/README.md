# Afterburner exhaust

The reheat plume of the MiG-21 (player and hostiles: both go through
`entity.engine` in `src/vfx/effects/AircraftFx.js`).

Overview: `sheet-before.jpg` and `sheet-after.jpg`. Rows are noon, golden hour
(18.5 h) and night (22 h); columns are chase, 3/4 rear at about 25 m, and
straight into the nozzle.

## What was wrong
- The plume was a smooth, featureless orange cone. Its Mach disks were in the
  shader but never read: every sample used the mipmapped noise with per-pixel
  jittered coordinates (so the noise averaged out), and the flame was purely
  additive under a luminance cap of 1.5.
- Light-up threw six needle sparks at 60 m/s and a star sprite
  (`before-lightup-0.05s.png`).
- The nozzle was a white ball: a core sprite, a 3.4 m halo sprite and a point
  light of intensity 1100 (about 15 times the noon sun on the fin 4 m away,
  which is why the whole tail looked gilded in the `before-nozzle-*` shots).
- Nothing changed with altitude or speed.

## What changed

### The flame (`Shells` mode `'plume'`, `src/vfx/core/Shells.js`)
Still one instanced bounding cylinder drawn by its back faces and ray-marched
per pixel, but the volume is new:
- **Sheath**: a Gaussian tube that tapers, orange going red. Turbulence scrolls
  down it at about 30 m/s and grows downstream. The noise also warps the radius,
  so the tail's silhouette is torn while the root stays smooth. Two planar
  noise projections, sampled at LOD 0 (no seam round the axis, no mip blur).
- **Root**: yellow-white flame standing off the nozzle, with a short
  blue-white core inside the first nozzle diameter.
- **Shock cells**: one lozenge per cell from a single periodic function (the
  old loop over five disks is gone), each 0.85 times the last, with a soft Mach
  disk at its head.
- **Absorption**: samples are composited front to back and the result is
  premultiplied, with up to 60 % opacity. Over snow and bright cloud the flame
  keeps its colour instead of adding up to white.
- **Flameholder**: a ray that enters the nozzle aperture is intersected with a
  plane 2.2 nozzle radii up the pipe: two V-gutter rings, eight struts and the
  exhaust cone. Dull red on dry thrust, the darker pattern inside the flame in
  reheat. It has real parallax and costs no extra draw.
- **Nozzle ring**: 24 flap seams.
- **Night**: emission is scaled to 0.45 under a night sky. The exposure only
  rises from about 1.1 to 1.8 while the scene darkens tenfold, so an unscaled
  flame clipped to a white sausage.

### The engine side (`src/vfx/core/ring.js`, unit-tested)
- `airState(altitude)`: ISA temperature, pressure and density.
- `shockCells(altitude, mach, nozzleRadius)`: nozzle pressure ratio from an
  R-25-like engine pressure ratio (2.6 at sea-level static, following intake
  temperature) times intake ram; fully expanded jet Mach number; cell length by
  Prandtl-Pack, `1.306 D sqrt(Mj^2 - 1)`. That gives 0.9 m on the runway, 1.35 m
  at 5.3 km and Mach 0.7, and 1.6 m at 10 km.
- `plumeState(throttle, reheat, altitude, mach, radius)`: adds `spacing`,
  `contrast` (diamonds fainter in thin air) and `spread` (the jet swells where it
  leaves the nozzle), and the flame lengthens as density^-0.3: 8 m at sea
  level, 9 m at 5.3 km, 10.3 m at 10 km.
- `burnerState()` / `burnerStep(state, target, dt)`: the engagement sequence.
  - Light-up: the flame comes up at 18/s and overshoots by a `pop` that decays
    over 0.15 s. While it lasts the flame is longer, wider, yellower and has no
    diamonds (a fuel-rich torch); they form as it settles, by about 0.6 s.
  - Stage-up: unchanged rule, reheat amount 0.45 to 1 as the throttle goes
    0.86 to 1.
  - Collapse: 6.5/s, monotonic, from the tail.

### Around it (`AircraftFx.js`, `types.js`)
- The sparks and the star are gone. Light-up is the lunge itself, a soft 0.14 s
  bloom at the nozzle and a brighter light for the length of the pop.
- The halo sprite is gone, and the core sprite now only shows on dry thrust.
- Beyond 250 m a small dot with a 2.2 pixel floor (`G.burner`) fades in, so a lit
  burner still reads when the flame is under a pixel wide.
- The light is 220 at night and a fifth of that by day (`BURNER` in `types.js`).
- Heat haze reaches further behind a lit burner.
- Low tier: 6 samples instead of 12, one noise tap, no flameholder noise.

## References
- Prandtl-Pack shock-cell spacing: Tam and Tanna, "Shock associated noise of
  supersonic jets from convergent-divergent nozzles", J. Sound Vib. 81 (1982).
- [Shock diamonds and Mach disks in an F-15E plume](https://theaviationist.com/2020/03/30/watch-shock-diamonds-and-mach-disks-form-in-the-exhaust-plume-of-an-f-15es-engine/)
  (same reference as the earlier VFX pass).
- The colours and the MiG-21 proportions are from memory of night and dusk
  photographs of R-25 reheat runs; no image was fetched or traced for this work.

## GPU cost
WebGPU, high tier, canvas 1920x949, `?gputime` profiler, medians of 4 to 5
windows of 60 frames, one fresh page per build.

| ms | before | after |
|---|---|---|
| Live chase camera, player and one wingman in reheat: VFX layer | 0.034 | 0.029 |
| Same: frame total | 1.27 | 1.26 |
| Frozen camera 1.5 m behind the flame tip, looking up it: VFX layer | 0.062 | 0.098 |
| Same: frame total | 0.75 | 1.00 |

- In play the cost is unchanged within noise (runs of the same build differ by
  about 0.007 ms).
- The close-up is the worst case I could build. The VFX layer costs 0.036 ms
  more there.
- The frame totals of the close-up differ by more than the VFX layer does. The
  two runs had different cloud and terrain in view after a respawn, so I would
  not read that 0.25 ms as plume cost.
- This machine renders the whole frame in about 1 ms. On a slow integrated GPU
  the close-up difference will be proportionally larger; it was not measured on
  one.

## Verified
- `npm test` (324 pass, including the new `ring.test.mjs` cases) and
  `npm run build`.
- WebGPU high, WebGL2 high (`after-webgl2-side-golden.png`) and WebGL2 low
  (`after-low-webgl2-side-noon.png`): no console errors or warnings.
- A harness wingman (`__vfxTest('wingman')`) in reheat beside the player, live.

## How the shots were taken
`__vfxTest.freeze()` and `__vfxTest.cam({ rel, look, fov })` after 5 to 7 s of
full reheat at 5.3 km. Positions are right, up, back from the aircraft origin:
chase `[1.2, 3.4, 22]` fov 42, side `[13, 4.5, 22]` fov 30, nozzle
`[0, -0.61, 20]` fov 24. PNGs are scaled to 1440 px wide and palette-quantised.

Two traps for anyone repeating this:
- Setting `game.paused` and moving `game.camera` by hand leaves the VFX camera
  uniforms stale (they are only written in `lateUpdate`), and the plume then
  draws as bright lines along its bounding cylinder. Use the harness camera.
- A frozen refresh runs the light pool with no requests, so the burner light
  goes out. For these shots the live lights were saved before the freeze and
  restored after it.

## Known limits
- **Into the nozzle at night** there is still a wide orange glow round the
  aircraft. The camera sits on the axis and looks through the flame's tail from
  a few metres. It is smaller than before but not small.
- **The flameholder** reads as a clean graphic (two rings and a cross). It has no
  texture of its own, and the flame noise over it is subtle.
- **Against sunlit snow or cloud** by day the flame is faint from abeam. That is
  how a real one looks, but it is less than the brief's "clearly visible".
- **Frozen frames are grainy**: 12 jittered samples, and the jitter relies on
  TAA, which does not accumulate while paused. Live it is smooth. On low tier
  with no TAA some grain remains.
- **Light-up timing** in the shots is counted from `flight.reheat` going true
  with `performance.now()`, so the 0.05 s frame is within a frame or two, not
  exact.
- **The night gain and the day/night light scale** are picture fixes, not
  physics: one physical flame radiance cannot serve both ends of this exposure
  range.
- **The engine pressure ratio model** is a two-line approximation, not R-25
  data.
- **Not checked**: other missions and combat scenes beyond a wingman, medium
  and ultra tiers, the cockpit view, and hostiles at several kilometres (the far
  dot was looked at once, at 1.2 km by day).
