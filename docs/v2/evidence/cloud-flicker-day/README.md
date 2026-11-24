# Cloud flicker, day and golden hour

High tier, 1920x1080, WebGPU, film grain off, 60 frames at a fixed 1/30 s step
per scene (`tools/harness.js`), measured with `tools/flicker.py`.

**Metric.** `pop` of a pixel = min(|f(t) - f(t-1)|, |f(t+1) - f(t)|) when the
two steps have opposite signs (a value that goes up and comes straight back),
in 8-bit luma levels, after compensating camera motion with dense optical
flow. The tables give the share of pixels with pop over 4 levels / over 8
levels, in percent, per region. Regions come from masks read back from the
cloud history: `horizon` = a band around the horizon line, `edge` = cloud
against terrain or aircraft, `jet` = a ring around the player aircraft.

## Result

| Scene | Region | Before >4 / >8 | God rays only >4 / >8 | Final >4 / >8 |
|---|---|---|---|---|
| m4 chase (golden hour) | horizon | 0.481 / 0.127 | 0.459 / 0.124 | **0.077 / 0.006** |
| m4 cut (golden hour, after a camera cut) | horizon | 0.432 / 0.104 | 0.406 / 0.101 | **0.062 / 0.007** |
| m1 chase | horizon | 0.516 / 0.111 | 0.456 / 0.094 | **0.059 / 0.002** |
| m1 chase | edge | 0.651 / 0.020 | 0.656 / 0.025 | 0.645 / 0.026 |
| night chase | horizon | 0.089 / 0.005 | 0.085 / 0.004 | **0.027 / 0.0007** |
| night chase | edge | 0.010 / 0.002 | 0.009 / 0.002 | 0.011 / 0.002 |
| m2 chase (day) | horizon | 0.710 / 0.075 | 0.687 / 0.074 | 0.670 / 0.052 |
| m2 chase | edge | 0.544 / 0.061 | 0.640 / 0.091 | 0.573 / 0.075 |
| m2 cut | edge | 0.565 / 0.056 | 0.570 / 0.062 | 0.571 / 0.073 |
| m2 fresh (first frames after a history reset) | edge | 0.469 / 0.043 | 0.506 / 0.043 | 0.475 / 0.042 |
| m2 title shot 0 (side tracking, jet over cloud) | edge | 0.081 / 0.006 | 0.056 / 0.004 | 0.059 / 0.004 |
| m2 title shot 0 | jet | 0.010 / 0.004 | 0.010 / 0.003 | 0.008 / 0.003 |
| m4 title shot 0 | edge | 0.108 / 0.018 | 0.116 / 0.016 | 0.132 / 0.022 |
| m4 title shot 0 | jet | 0.072 / 0.004 | 0.067 / 0.004 | 0.061 / 0.004 |
| m3 chase (storm) | horizon | 2.23 / 0.50 | 1.93 / 0.31 | 2.54 / 0.57 |
| m3 chase | edge | 2.22 / 0.74 | 2.58 / 0.97 | 2.68 / 1.04 |
| m2 turn | all | ~0 | ~0 | ~0 |

"God rays only" is the final god-ray code with the original cloud resolve; it
separates the two changes.

Large-scale flicker (frames averaged into 32 px tiles, `tools/tiles.py`; mean
tile pop in levels), m4 chase, from the god-ray change: top third
0.069 -> 0.006, middle third 0.127 -> 0.031, whole-frame mean luma
0.028 -> 0.008. God-ray target read back directly: frame-to-frame pop 1.25 %
of the mean -> 0.05 %; mean brightness 0.1319 -> 0.1247.

A repeat run of the final code on m4 chase gave horizon 0.062 / 0.005, so
run-to-run spread is about a fifth of the value. Differences smaller than
that in the table (most of the `edge` rows) are not changes.

## What was wrong, what changed

1. **Horizon flicker over distant cloud at low sun (m4, m1, night):** fixed,
   about 6 to 8 times fewer popping pixels. Cause: in the cloud resolve
   (`src/world/clouds/Clouds.js`), pixels not marched this frame took a
   bilinear guess across depth edges, and a history fetch straddling two
   surfaces was thrown away and rebuilt at a fixed slow blend. Now the guess
   and the history fetch stay on the pixel's own surface, and a texel with a
   young history averages its samples (`src/world/clouds/temporal.js`).
2. **Whole shafts of light pulsing at golden hour:** fixed (tile numbers
   above). Cause: the god-ray emitter mask (`src/fx/post/godRays.js`) changed
   with the sub-pixel alignment of the sun and lit cloud rims, and the radial
   march stepped over thin emitters. Now overlapping footprints, a temporally
   accumulated mask and a mip-matched march.
3. **Camera cuts** reset the cloud history instead of reprojecting the last
   shot's clouds.

## Not fixed

- **Midday cloud edges against terrain (m2 chase/cut/fresh `edge`, m1 `edge`):
  unchanged**, about 0.6 % of edge pixels pop over 4 levels. Not traced to a
  single cause. Next to try: variance clipping of the history (mean +/-
  gamma * sigma of the neighbourhood, as in takram's `@takram/three-clouds`
  `cloudsResolve.frag` / `varianceClipping.glsl`, MIT) in place of the min/max
  clamp, and their transmittance-weighted mean depth with closest-depth
  velocity dilation for reprojection.
- **m3 (storm):** not improved; edge and horizon are within noise or slightly
  worse. Most of the frame-level flicker there is radial motion-blur streak
  noise over terrain, which was not touched.
- **m4 title shot 0 edge** reads slightly worse (0.108 -> 0.132): inside the
  run-to-run spread, but not shown to be better.
- Clouds still write no motion vectors for TRAA.
- `__capture.step()` renders with clouds and TRAA frozen (FRAME nodes only
  advance in three's animation loop). `__capture.record()` is fine. Not
  changed: `src/game/dev` is out of scope.
- Adaptive resolution resizes reset the cloud history (live play only).

## Look and cost

- Look: same session, god rays only vs final, m2 title shot 0: mean difference
  -0.2 levels, mean absolute difference 0.9. m4 chase before vs final: mean
  -0.7 levels (the rays are about 5 % dimmer on average). The `look-*` sheets
  are before (left) and final (right); the m2 "before" clips were taken before
  the harness pinned the cloud time, so the cloud field differs slightly.
- GPU time (`?gputime`, m4 chase, ms): total 1.30 before, 1.42 after; clouds
  0.29 after (0.31 to 0.34 before, measured in m2 chase).
- Low tier (`?quality=low`) and `?webgl`: loaded, flew m4 chase for a few
  seconds, no console errors or warnings. Not compared visually, and the
  backend actually in use was not confirmed.
- No third-party code was copied; the takram source was read for comparison
  only.

## Files

- `before-m4-chase.mp4`, `after-m4-chase.mp4`: 2 s captures, played twice.
- `horizon-crops-m4-chase-before-over-after.jpg`: six consecutive frames of a
  400x160 px crop of the shafts over the valley (not the horizon line itself),
  before (top row) and final (bottom row). The difference is easier to see in
  the MP4s than in stills.
- `look-*.jpg`: frame 30, before (left), final (right).
- `tools/`: harness (load into the page), metric scripts (Python, numpy,
  Pillow, OpenCV).

## Transparency

An audit by reading the code. Nothing here was checked on screen and nothing
was changed.

How it is built: one scene pass draws opaque and transparent objects. Aerial
perspective (stage 20), clouds (30) and the VFX layer (55) are then applied in
post, each using the opaque depth. The VFX layer has no depth buffer; its
materials clip against scene depth themselves and fade behind cloud with
`Clouds.visibilityAt` (ribbons, particles, afterburner shells, tracers, bolts
and headlight beams all do). Near cloud over far cloud is one front-to-back
march per ray, so it is ordered by construction. No premultiplied-alpha errors
were found in the cloud composite or the VFX materials. Screen water is
applied after everything else.

Likely defects, most visible first:

1. **Light sprites** (`src/world/timeofday/lights/LightSprites.js`) are drawn
   in the main scene without depth write, so a sprite in front of a cloud is
   dimmed and covered by it, and fogged for the distance of what is behind it.
   Fix: move them to the VFX layer with `cloudVisAt`.
2. **Canopy glass** (`src/assets/glass.js`) is in the main scene: its
   reflections and glint are fogged, clouded and overdrawn by VFX as if they
   were at the distance of the terrain behind. Fix: its own late layer after
   stage 55.
3. **VFX get no aerial perspective** (the layer is added after stage 20):
   distant trails and smoke are not hazed. Needs an `apSample` in the VFX
   shared uniforms.
4. **Dense smoke partly behind cloud darkens the cloud's own light** by
   (1 - a * T) in the fade zone. No render-order-only fix.
5. **`visibilityAt` uses one mean cloud depth** with a soft ramp: a trail just
   in front of a distant cumulus starts fading early, and an effect between a
   thin near layer and a far opaque one is fully hidden. Fix: store first-hit
   depth separately, or tighten the ramp.
6. **Night haze and lightning flash** (`nightStage.js`) point-sample the cloud
   aux without depth weighting and can bleed onto aircraft edges.
