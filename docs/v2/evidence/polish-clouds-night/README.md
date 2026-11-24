# Night cloud flicker

**Symptom.** At night, distant clouds flicker and shimmer: their edges and the cloud band along the horizon.

**Cause.** The cloud resolve wrote this frame's raw sparse-march opacity into `aux.b` (`src/world/clouds/Clouds.js`, `_resolvePass`).

- That value belongs to one march block, one Bayer phase and one jitter, and nothing filters it over time.
- On a distant rim it flips between hit (opaque) and miss (clear) every frame, block by block.
- The night stage (`src/world/atmosphere/night/nightStage.js`, `clouds()`) multiplies its moonlit haze by that opacity.
- So the haze over every far cloud edge switched on and off, in march-sized blocks.
- In daylight that haze term is close to zero, which is why only the night looked broken.

**Fix.** `aux.b` is now `1 - resolved transmittance`, the same temporally accumulated value the cloud colour uses. Nothing else in the cloud march, resolve or composite changed.

## Numbers

All numbers come from the same build and page, with WebGPU high tier at 1024×768.

**Paused, fixed camera.** Sky band (rows 30–50 % of the frame), absolute luminance change between frames shown from the same pose.

| case | pixels changing > 3 levels | 99.9th percentile | max |
| --- | --- | --- | --- |
| night still, before | 0.346 % | 5.8 | 16.4 |
| night still, after | 0.007 % | 2.7 | 6.9 |
| night, camera swinging 3 mrad every frame, before | 0.340 % | 4.9 | 15.4 |
| night, camera swinging, after | 0.041 % | 2.9 | 11.8 |

**Flying.** Normal chase camera, night mission, temporal high-pass (|f − (f₋₁ + f₊₁)/2|) over the sky band, three runs of 30 frames each.

| | high-pass mean | pixels changing > 3 levels |
| --- | --- | --- |
| before | 0.78–0.79 | 2.6–2.7 % |
| after | 0.58–0.60 | 0.37–0.48 % |

**Day and golden hour.** No change beyond the frame-to-frame noise.

- Mean change between frames at noon: 0.94 before, 0.93 after. At golden hour: 0.90 before, 0.88 after.
- Comparing the 6-frame mean images, before against after, differs by 0.8 levels at noon and 1.0 at golden hour.
- That residual is cloud drift (wind time differs between the two loads) plus the jet's position, not shading.

See `metrics.json` for the raw values.

## Files

- `flicker_map_night_still.png` and `flicker_map_night_swing.png`: per-pixel change between frames (×25, red) over the frame, before on top and after below.
  - Before, every distant cloud edge and the horizon cloud band light up in block-stepped outlines.
- `edge_crop_frames.png`: four consecutive frames of the worst horizon spot, at 4×.
  - Before, dark march-sized blocks pop in and out; after, the four frames match.
- `before_*.jpg` and `after_*.jpg`: one full frame each of night, noon and golden hour, from the same pose.

## Ruled out on the way

None of these changed the on-screen flicker, so none of them shipped:

- unjittering the cloud march from TRAA;
- a far-field history and clamp scheme;
- a looser same-surface test along far ridgelines.

The TRAA jitter does make the half-res cloud history at a thin rim wander a little, but that is filtered before it reaches the screen.
