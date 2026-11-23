# Realism polish: lighting, atmosphere, image pipeline

This pass improves lighting, atmosphere and the image pipeline for a more
photographic frame. I compared the game against real photographs of
Ladakh / Kargil / Drass and real air-to-air and cockpit photographs, then
fixed the largest gaps.

All shots were taken at 1600×900 on the WebGPU backend, tier `high`,
unless the name says otherwise. Each `before-*` / `after-*` pair uses the
same pose, the same time of day and a pinned cloud time (see
[Re-shooting](#re-shooting)).

## Reference photographs

Commons links are `https://commons.wikimedia.org/wiki/File:` followed by the
name. All were viewed online; none are copied into the repository.

**Midday, clear**
- `Drass_and_Tololing_Range.jpg`
- `Ladakh_Sunrise.jpg` (actually a high sun in frame)
- `Zanskar_Range_02.jpg`
- `Indus_River_Valley_from_Khardung_La_(pass),_Ladakh,_North_India.jpg`

**Dawn and golden hour**
- `Sunrise_at_Leh,_Ladakh.jpg`
- `India_-_Ladakh_-_Trekking_-_089_-_frosty_sunrise_over_camp_4_(3895787217).jpg`
- `Sunset_on_NUn_Kun_Massif_(Ladakh-India).jpg`
- `Kargil_sunset.jpg`

**Dusk and night**
- `Ladakh_(14687169333).jpg`
- `Everest_Range_Above_Tengboche_at_Night.jpg`
- `Night_View_of_Himalayas_(10404244223).jpg`

**Overcast**
- `Ladakh_india_monsoon_clouds.jpg`
- `Clouds_and_mountains_(Leh,_Ladakh,_2016).jpg`
- `Clouds_and_sky_on_a_mountain_pass_in_Ladakh.jpg`

**From the air**
- `Himalayan_mountains_from_air_001.jpg`
- `Himalaya_Mountains_view_from_air.JPG`
- `Mount_Everest_as_seen_from_Drukair2_PLW_edit.jpg`

**Air-to-air**
- `A_USAF_F-15C_Eagle_and_an_Indian_air_force_Mirage_2000_fly_together_over_the_Himalayas_during_Cope_India_04.JPG`
- `4477th_Test_and_Evaluation_Squadron_MiG-21_in_flight.jpg`
- https://theaviationist.com/wp-content/uploads/2015/12/DNI_0181-860x574.jpg
- https://theaviationist.com/wp-content/uploads/2015/10/T_scramble_11-706x471.jpg

**Cockpit**
- `4477th_Test_and_Evaluation_Squadron_-_Pilot_flying_MiG-21.jpg`
- `MiGFlug_customer_during_a_supersonic_flight_in_the_Mikoyan_MiG-21_Fishbed_-_at_Mach_1.3.jpg`
- `4477th_Test_and_Evaluation_Squadron_-_MiG-21_Front_Cockpit_Window.jpg`

**Numbers**
- Ambach & Blumthaler 1994, *Meteorol. Z.* 3:211, doi 10.1127/metz/3/1994/211:
  on clear midsummer days in the Alps, diffuse light is about 8% of global
  irradiance.
- Ningombam et al. 2014, aerosol optical depth at Hanle (Ladakh, 4.5 km),
  https://dspace.uohyd.ac.in/handle/1/2738: the 500 nm mean is 0.042 (about
  0.03 in winter, about 0.07 in May).
- Bucholtz 1995, doi 10.1364/AO.34.002765: Rayleigh scattering scales with
  pressure only.

Gaps in the references: I found no air-to-air photo of an IAF Bison, and
no MiG-21 air-to-air at golden hour that I could verify.

### What the photographs agree on

- **Sky.** The zenith is deep cobalt to near navy, and stays blue right up
  to a small, tight glow around the sun. The pale band sits only at the
  horizon.
- **Contrast.** Skylight is weak (about 8–10% of sunlight). Shadows sit 3–5
  stops under sunlit faces and keep texture. Blacks are deep in the
  foreground.
- **Distance.** It goes blue-violet in layers. Near ridges keep full
  contrast. Ridges 20–30 km away turn grey-violet with lifted blacks. A thin
  haze layer sits in the valleys, and the peaks stand above it.
- **Sun.** The aureole is small and bright. The lens adds a thin star, but
  no big coloured ghosts unless the sun is bare in frame.
- **Golden hour.** Lit peaks are gold above valleys more than 5 stops
  darker. Shafts form where ridges and cloud edges cut the low sun.
- **Aircraft.** Grey jets sit 2–3 stops under the snow. Glints are tiny
  and sharp. Recesses (intakes, pylons, wing roots) are darker than open
  panels.
- **Cockpit.** The panel is near black against a white outside view: more
  than 8 stops apart.

## Gap analysis (before)

| Area | Before | Target | Verdict |
|---|---|---|---|
| Tone / contrast | Milky. At noon p5 luminance is 0.31 at a2a-noon-high and 0.32 in the storm shot, because base AgX has a soft toe. Shadows were lifted, not deep. | Deep foreground blacks, punchy midday | **Big gap** |
| Lens flare | Hexagon and orange ghost discs, a long streak and a strong starburst. They show even when the sun is half behind cloud. | Small tight glow, thin star | **Big gap** (reads as a game, not a photo) |
| Valley haze / sun aureole | Mie aerosol decays from sea level. Above the 3–4 km plateau there was almost none: no valley haze band and a weak aureole. | Thin haze layer at the valley floors, bright aureole | **Gap** |
| Aircraft / cockpit ambient | No AO, so the jet looked flat. Pylons, intakes and gauge recesses were as bright as open skin. The cockpit tub was as bright as the outside. | Recesses darker; cockpit dark against the outside | **Gap** (small in sunlight, larger in shade) |
| Sharpness | TRAA softness. The tier's sharpen strength was ignored; PostFX hard-coded 0.25. | Crisp edges without halos | **Gap** |
| Low-sun shafts | None past ridges or cloud gaps. The froxel AP only makes them under a cloud deck. | Shafts at golden hour | **Gap** (high and ultra) |
| Sun:sky ratio | Measured noon sky diffuse is about 6.5% of global, about 8% with the hemisphere fill. | About 8% | **Already right**: not changed |
| IBL from the live sky | Already in place: a PMREM of the live sky plus a sky/ground hemisphere fill. There was no occlusion of the IBL. | — | The source is right and was not changed. The new AO now occludes IBL and the fill on objects. A specular horizon-occlusion term was not added. |
| Aerial perspective, blue-violet distance | Already Hillaire froxels, with Rayleigh by pressure. | — | Fine. Only the Mie profile changed. |
| Shadows | The cascades are already tuned (`SUN_SHADOW_TIERS`). | — | Not touched |

## Changes and why (in commit order)

1. **Near-field GTAO on indirect light only**
   (`src/fx/post/ambientOcclusion.js`, `PostFX._buildAO`).
   - How it works:
     - A half-resolution depth prepass feeds three's `GTAONode`. Its sample
       radius grows with distance: 0.45 m at the eye, up to 8 m.
     - The result is packed with linear depth into one RG16F texture.
     - It is read back through a `builtinAOContext`-style `context({ getAO })`
       on the scene pass, so it scales only ambient, hemisphere and IBL
       light, never the sun.
     - A depth check rejects AO texels that belong to a different surface.
   - **Terrain is excluded as a receiver.** Its material already uses 15 of
     the 16 sampled textures per stage. The first attempt pushed it to 17,
     which invalidated the terrain pipeline and made the ground disappear.
     The terrain is still an occluder on high and ultra, so it darkens the
     undersides of aircraft and units near the ground.
   - Tiers:
     - high: 12 samples, 400 m;
     - ultra: 16 samples, 600 m;
     - medium (new): 8 samples, 160 m, layer-0 objects only;
     - low: none.
2. **Cockpit tub occlusion**: `aoNode = 0.42` on the cockpit interior
   material (above low). A canopy tub sees only a small cone of sky.
   - Measured at the cockpit pose with exposure locked: the panel region
     drops from 19.9 to 15.5 mean sRGB (−22%); the sky is identical.
3. **Scene-light AgX contrast (grade).**
   - The CDL slope and power for daylight are now (1.06, 1.05, 1.02) and
     (1.42, 1.42, 1.45), with `lookSat` 1.22. This deepens the AgX toe.
   - It blends back to the old softer look in mesopic light, driven by the
     adapted scene luminance, so dusk and moonlight are not crushed. A
     single grade took the night p50 from 0.20 to 0.13.
   - Variant B was chosen over a plain power of 1.30. At a2a-noon-high, p5
     went from 0.317 to 0.248 and chroma from 0.090 to 0.103.
4. **CAS-style adaptive sharpening.** The tier strength is now applied:
   medium 0.4, high and ultra 0.5.
   - Each texel's local min/max sets how much it is sharpened (AMD CAS
     style). Flat areas get the most, high-contrast edges get less, and the
     result is clamped to the neighbourhood, so there are no halos.
5. **Quieter lens flare.**
   - Ghosts ×0.35.
   - Starburst 1.5 → 0.9; fine rays 1.2 → 0.7.
   - Anamorphic core 0.5 → 0.2; sheath 0.12 → 0.05.
   - Halo ring 0.05 → 0.022.
6. **Aerosol starts at the valley floors.** `atmosphere.params.mieBase` is
   2.4 km. Mie density is flat to that height, then decays with its scale
   height. The change is in both the CPU LUT model and the GPU froxel
   integrate.
   - Over Ladakh this restores the thin valley haze band and a bright, tight
     sun aureole. The integrated optical depth stays thin, in line with the
     Hanle AOD of about 0.04.
7. **Low-sun crepuscular rays** (`src/fx/post/godRays.js`; high and ultra
   only).
   - Method: GPU Gems 3, ch. 13 style. A 4-tap emitter mask of bright sky
     texels feeds a 40–48 tap radial march at ¼–⅓ resolution.
   - Interleaved-gradient start jitter removes the ring banding.
   - Weighting: an air-path term means shafts appear over distant terrain
     and sky, not on a ridge 2 km away.
   - Strength fades from full below 6° of sun elevation to zero at 24°, and
     follows how much of the sun is on screen.
   - The froxel AP already handles shafts under a cloud deck; this pass adds
     what it cannot see (ridges and cloud-gap edges at low sun).

## Before / after (best 8 pairs)

| Pose | Before | After | What changed |
|---|---|---|---|
| Golden hour, sun in frame | `before-golden-hour.jpeg` | `after-golden-hour.jpeg` | Ghost discs gone. A tight bright aureole on the cloud edge, faint shafts past the clouds, deeper valley shadows. p5 0.148 → 0.087. |
| Air-to-air, golden hour | `before-a2a-golden.jpeg` | `after-a2a-golden.jpeg` | Deeper terrain shadows. The jet's recesses (pylons, intake, wing root) are darker. Warmer and more saturated. p5 0.153 → 0.095, chroma 0.107 → 0.123. |
| Air-to-air, noon | `before-a2a-noon.jpeg` | `after-a2a-noon.jpeg` | Milky veil removed. Panel-line and pylon AO. p5 0.278 → 0.211. |
| Air-to-air, noon, above | `before-a2a-noon-high.jpeg` | `after-a2a-noon-high.jpeg` | Same, seen against the terrain. p5 0.314 → 0.251. |
| Low level over a valley | `before-low-valley.jpeg` | `after-low-valley.jpeg` | Valley haze layer, deeper shadowed slopes, more saturated sky. p5 0.189 → 0.128, chroma 0.117 → 0.136. |
| M2 midday, high | `before-m2-midday.jpeg` | `after-m2-midday.jpeg` | More contrast and a deeper sky. p5 0.212 → 0.147. |
| Storm / overcast | `before-storm.jpeg` | `after-storm.jpeg` | Slightly more body under the deck; still low contrast, as in the references. p5 0.319 → 0.267. |
| Cockpit, noon | `before-cockpit.jpeg` | `after-cockpit.jpeg` | Panel and tub darker against the outside, gauge recesses occluded. p5 0.106 → 0.020. |

The remaining pairs:
- **M1 dawn valley, dusk, night-moon**: almost unchanged. This is intended;
  the grade blends back to the old look in low light.
- **WebGL2** (`after-webgl2-golden-hour.jpeg`, `?webgl&quality=high`):
  renders with no console errors. AO is off there (WebGPU only); rays,
  grade, flare and haze apply.
- **Low tier** (`after-low-tier-golden-hour.jpeg`): no AO, no rays, no
  sharpen. The grade, flare and haze changes are free and apply.

Luminance statistics (display sRGB) for every shot:
`python stats.py before-*.jpeg after-*.jpeg`. The script lives outside the
repository; it prints mean, p2, p5, p50, p95, p99.5 and mean chroma.

## GPU cost

**Setup**
- 2560×1440 canvas (DPR 1).
- The GPU was shared with several other agents' game instances during all
  measurements.
- three's per-pass timestamps come back empty under that contention, so
  costs are A/B differences of the whole-frame GPU timestamp
  (`renderer.info.render.timestamp`, with `?gputime`).
- Timestamps are quantised to about 0.065 ms and resolved every few frames.
  Each run alternates OFF/ON 4–5 times, 12–20 s each; the figure is the
  median of the medians.
- Tool: `gpucost.js`.

| Tier | Feature | Pose | Frame median OFF → ON (ms) | Added (median) | Per-round deltas (ms) |
|---|---|---|---|---|---|
| low | — | — | — | **0** (nothing new is built: `post.ao` null, no ray nodes, sharpen 0) | — |
| medium | AO (8 samples, half resolution, 160 m) | a2a-noon | — | **≤ 0.07** (within one quantum) | ±0.07 |
| high | AO | a2a-noon | — | ≈ 0 | 0.26, −0.07, 0.07, −0.07 |
| high | rays (forced on) | golden-hour | 1.507 → 1.573 | **+0.07** | 0.20, 0.13, −0.13 (one 4.3 spike) |
| high | **AO + rays** | golden-hour | 1.638 → 1.769 | **+0.13** | −0.07, 0.07, 0.20, 0.13, 0.07 |
| ultra | AO | low-valley | — | +0.13 to 0.20 | 0.13, 0.13, 0.26 |
| ultra | rays (forced on) | golden-hour | 1.901 → 2.032 | **+0.13** | 0.13, 0.07 (two contention spikes) |
| ultra | **AO + rays** | golden-hour | 1.769 → 1.966 | **+0.20** | 0.33, 0.26, 0.13, 0.20, 0.13 |

The other changes cost nothing measurable:
- The sharpen pass already existed; only its strength and adaptivity
  changed (a few ALU ops).
- The grade is constants.
- The flare got cheaper in effect, with the same work.
- `mieBase` is one `max()` in the froxel integrate.

**Result:**

| Budget | Measured | Status |
|---|---|---|
| high ≤ +1.0 ms | about +0.13 ms | within |
| ultra ≤ +1.5 ms | about +0.20 ms | within |
| low: no new cost | none | within |
| medium: cheap only | below one timer quantum | within |

These are noisy numbers on a busy GPU; treat them as upper-bound
estimates. A dedicated run on an idle GPU with working per-pass timestamps
would be more precise.

## What did not help, or helped less than hoped

- **AO is physically subtle in direct sun.** Indirect light is only about 8%
  of the total at noon, so GTAO on indirect light barely changes a sunlit
  surface. It shows in recesses, under wings, in the cockpit, and in shade
  and overcast. I kept it physically correct rather than also darkening
  direct light, which reads as dirty and is wrong.
- **The terrain gets no screen-space AO.** The texture limit rules it out
  (see above). Terrain would gain more from a heightfield horizon-AO term
  baked into its own material (recommendation below).
- **The cockpit tub term is weak while sun falls directly on the panel.**
  The −22% on the panel is mostly in shade and is visible but modest. The
  references show a near-black panel, which needs real shadowing from the
  coaming and canopy frame, not ambient tuning.
- **The sun:sky ratio and the IBL source were already right**, so I did not
  change them. Raising the sun or lowering the sky only moved exposure around.
- **The god rays are a small contributor.** The first version had visible
  ring banding. It needed start jitter, a separate low-resolution emitter
  mask, a span cap and an air-path weight before it looked clean. At the
  shipped 0.5 gain the shafts are subtle. Most of the golden-hour
  improvement comes from the grade, the haze and removing the ghosts, not
  from the rays.
- **First AO attempt:** a plain GTAO output plus a separate depth texture
  broke the terrain (17 textures). It was replaced by the packed RG target
  and the terrain exclusion.
- **Per-pass GPU timers** (`?perfhud` per-pass, `GpuProfiler`) were unusable
  on the shared GPU (all zeros). I switched to whole-frame A/B.

## Re-shooting

1. Open `/?mission=free&quality=high` on the dev server (add `&webgl` for the
   fallback, `&gputime` for timings).
2. In the console, load `bench.js` (and `gpucost.js` for costs) as classic
   scripts after the game reaches the `sortie` state.
3. Then run:
   ```js
   await __bench.pose('golden-hour')        // holds camera, clouds and frame state
   __bench.names                            // all poses
   await __gpucost.ab('golden-hour', { feature: 'all', seconds: 12, rounds: 5 })
   ```
   `feature` is `'ao'`, `'rays'` or `'all'`.
4. `__bench.release()` returns control to the game.
5. For debugging, `post.debugView = 'ao'` or `'rays'` shows each buffer.
6. `?noao` / `?norays` turn the new passes off.
