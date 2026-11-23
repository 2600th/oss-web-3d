# VFX polish: audit bugs, ranked fixes, prewarm, screen hit

This work follows `docs/v2/evidence/vfx-audit/README.md`.

## Evidence

Every `before-*.jpeg` / `after-*.jpeg` pair in this folder shows the same pose.

**How the pairs were made**
- The capture rig is `tools/vfx/capture.js` and `tools/vfx/scenes.js`, listed in `SHOTS`.
- Both sets use a fixed 26° lens, Math.random seeded per shot, and the high tier on WebGPU.
- The full post chain is rendered to a target and read back.
- The *before* set was re-shot with the original `src/vfx` at the same poses, after the lens fix: the old rig grabbed whatever FOV the start-of-mission cinematic happened to be at.
- Images are downscaled to 1600×593.

**Extra frames**

| File | What it shows |
|---|---|
| `scorch-terrain-off-on-90s.jpeg` | 90 s after a large ground blast, with the VFX layer hidden. Left: terrain without the scorch uniform. Right: with the mark fed from `vfx.scorches`. |
| `webgl-low-sheet.jpeg` | `?webgl&quality=low` on the WebGL2 backend: fireball, burner from dead six, gun, ground blast, burning trail, lightning. No console errors. |

**Poses**
- `air-med-{0.1,0.6,1.5,5}s`, `air-large-0.6s-dusk`
- `ground-large-{0.6,2,8}s`, `fire-column-45s`
- `flak-{0.3,4}s`, `debris-0.9s`, `burning-2.4s`, `kill-4.7s`
- `burner-{dead6-day,dead6-night,zoom-day,side-day,quarter-night}`
- `gun-{side-day,side-night,chase}`
- `salvo-{chase-day,chase-night,low-day,side-day,side-dusk}`
- `flares-1.2s`, `lightning-night`, `rain-cockpit`, `cloud-cockpit`, `contrail`, `contrail-chase`

## Audit bugs

### Muzzle flash inside the fuselage; tracers from the nose cone reading as a laser
Poses: `gun-*`.

**Cause**
- Combat spawned rounds 7 m ahead of the aircraft centre, which is the radome tip.
- The VFX muzzle flash used its own guessed socket, which sat inside the skin.
- With a 1/42 s shutter at 30 rds/s, the tracer streaks overlapped into one continuous beam.

**Fix**
- There is now one gun socket: `GUN_MUZZLE` in `src/vfx/core/sockets.js`.
- It was measured on the shipped `public/models/mig21.glb` with `tools/vfx/probe-gun.mjs`, at the ventral GSh-23 fairing's barrel exit (0, -1.31, -2.64).
- `src/combat/system.js` (`_updateGun`), `src/flight/Aircraft.js` (`sockets.gun`), `AircraftFx.muzzleFlash` and the dev harness all read it.
- I re-ran the probe on the MiG GLB rebuilt in webgpu-aaa. The mesh bounds and gondola slices are byte-identical to the old GLB, so the socket is unchanged.
- Tracers (`Tracers.js`) use a 1/90 s shutter, so each round is a short dash with a hot head. The dash is clamped to `dist - 3` m from the camera, so a round never smears across the lens.
- The muzzle flash is three parts:
  - a short star flash (`G.flash`);
  - a forward cone (`G.muzzle`, shape 4, stretched along velocity + 320 m/s along the barrel);
  - a puff of gun gas (`L.gunSmoke`) and a light.

### Ribbon near-plane wedges
**Cause:** a trail segment that crosses the camera plane projected its far corners through infinity.

**Fix**
- Segments are clipped against the near plane in the vertex stage (`clipSegmentNear`, with a test).
- The fragment stage also bounds its ray to `[0, sceneT]`.

### Ribbon joint "slinky" seams
**Cause:** each segment was a cylinder with flat end caps, and its radius jumped at every joint. End-on, you saw a stack of discs.

**Fix**
- Each segment is now the exact intersection of the ray with a **cone** (radius v0.w → v1.w), clipped by the two joint planes.
- Radius and density are evaluated at the chord midpoint in two passes, not at entry.
- The normal is built from a tangent smoothed across the joint.
- The cap normal blends in only for near end-on rays (`capEntry`).

### Afterburner invisible from dead six
Poses: `burner-*`.

**Cause:** emission was weighted by `facing`, which is about 0 end-on.

**Fix:** a new volumetric plume, `Shells` mode `'plume'`.
- A bounding cylinder is drawn by its back faces. Each pixel integrates the emission along its own chord through the jet. The jet is made of:
  - a supersonic core;
  - a train of Mach disks, each one weaker;
  - a turbulent outer flame.
- End-on the chord is longest, so the plume is brightest from dead six, as in real footage.
- Integrated luminance is soft-saturated, `I·S·(1-exp(-lum/S))/lum` with S = 1.5. This is luminance self-absorption, and it stops an end-on plume flooding bloom and exposure. A first cut at S = 4 washed the whole frame orange; the committed after shots use 1.5.
- References: [theaviationist: shock diamonds and Mach disks, F-15E](https://theaviationist.com/2020/03/30/watch-shock-diamonds-and-mach-disks-form-in-the-exhaust-plume-of-an-f-15es-engine/), [NASA X-59 Mach diamonds at max afterburner](https://www.nasa.gov/image-detail/nasas-x-59-displays-mach-diamonds-at-maximum-afterburner).

### Missile-trail glowing dots and peach tint
Poses: `salvo-*`.

**Cause:** shed smoke (`L.shed`) spawned with heat 1.6–2.5 and decayed slowly, so every puff carried an ember. Hot puffs also added fire on top of bright lit smoke, which read as peach.

**Fix**
- Shed heat is 0, and heat decay is 25/s for the few puffs that ignite.
- Ignition puffs have heat 0.4.
- A small `G.motorFlame` (stretched) sits at the nozzle within 700 m. The beacon scales with missile size.
- The lit term is multiplied by `litKeep(heat) = 1 - 0.85·heat` (see fire ramp).

### Beaded burning-aircraft soot
Poses: `burning-2.4s`, `kill-4.7s`.

**Cause:** emission was per second, so spacing grew with speed (beads at 250 m/s). Short-lived fire tongues sat at the per-frame positions.

**Fix**
- Soot comes from `emitAlong` (per metre, carried remainder; tests cover different speeds and frame rates).
- Spacing is `1.5·s·k/√rate`. Below 60 m/s there is a per-second floor.
- One puff in four is hot.
- Fire tongues are spread along the frame's path segment (`_prevP → p`), with a back-dated age, and live 0.07–0.16 s.
- Lit soot is slightly velocity-stretched (`stretch 0.035`).

### Low-tier bloom banding
I diagnosed this by reading the code; I did not edit it.

`src/engine/PostFX.js` and `src/fx/post/**` are outside my area. I could not get a capture that clearly shows the rings, so this diagnosis is **not verified in game**.

**Likely causes, in order**
1. **No effective dither in dark regions on low.**
   - The chain quantises to 8-bit sRGB after `renderOutput`. The only noise is `filmGrain`.
   - On low its amplitude is `0.014 × cfg.grain 0.6 × u.grain`, and `u.grain` falls to 0.35 at dusk and night.
   - It is then multiplied by `w`, which is 0.2 at luminance below about 0.05.
   - The result is about 0.0004, roughly 0.1 LSB, on a dark sky. That is where bloom halos around flashes sit, so their smooth falloff quantises into visible rings.
   - High tier hides this with TRAA jitter and motion blur. Low has neither.
2. **Equal weights on the coarse mips.**
   - `BloomNode` mixes 5 mips with `mix(factor, 1.2 - factor, radius)`. On low `bloomRadius` is 0.5, so every mip gets 0.6.
   - The 1/32-resolution mip is then added at full weight, upsampled with a single bilinear tap.
   - Bilinear interpolation has a derivative jump at every texel, which shows as concentric steps (Mach bands) around a small bright source.

**Suggested fix (for the engine/post owner)**
- After `renderOutput` and before grain, add a luminance-independent triangular-PDF dither of ±1 LSB, roughly:
  ```js
  out.rgb += (hash(p) + hash(p + k) - 1) / 255
  ```
  This is about 2 ALU per pixel.
- Optionally, on low, use `bloomRadius ≈ 0.3` (coarse mips weighted down), or a 3×3 tent upsample as in Jimenez, *Next Generation Post Processing in Call of Duty: Advanced Warfare* (SIGGRAPH 2014, [slides](https://www.iryoku.com/next-generation-post-processing-in-call-of-duty-advanced-warfare/); [LearnOpenGL write-up](https://learnopengl.com/Guest-Articles/2022/Phys.-Based-Bloom)).

## Ranked fixes

### 1. Blackbody fire ramp
**Cause:** fire was added on top of lit smoke, and the old ramp passed through pink.

**Fix**
- `fireColor(heat)` (pure, tested) maps heat to temperature T = 650 + 1050·heat K, so heat 0.4 is dull red at about 1070 K and heat 1.7 is yellow at about 2430 K.
- Colour is Planck's law in the Wien limit at 610, 550 and 465 nm, normalised to red. Brightness uses a softened Wien term.
- This gives b ≤ g ≤ r everywhere, so there is no magenta at any heat.
- `shared.js` `fireRamp` is the TSL twin.
- Lit colour is scaled by `litKeep(heat)`, so a hot puff is soot glowing from inside.
- Smoke albedo is 0.03–0.06.
- Reference: [Mitchell Charity, What colour is a blackbody](http://www.vendian.org/mncharity/dir3/blackbody/).

### 2. Afterburner
See the audit bug above.
- Also: the nozzle core glow and halo are scaled by reheat (×1.1 core, halo 0.05·reheat). The existing heat haze is unchanged.
- Poses: `burner-*`.

### 3. Fireball
Poses: `air-*`, `kill-4.7s`.
- A 0.06 s flash (R·1.5 → R·3), then a 0.16 s flare and a 0.5 s halo.
- (14 + 0.6R)·q core puffs, launched at R·(0.15–0.8)/s, growing to R·(1.2–1.6), with heat 1.35–1.7.
- (8 + 0.3R)·q outer puffs.
- A soot shell born 0.12–0.4 s late (negative `age0`) with colour 0.045. It lives `blastSmokeLife(R) = clamp(8 + 1.6R, 12, 55)` s.
- A faint shock ring (Shells `'ring'`) and a condensation shell in humid air.
- References: [Star Citizen explosion breakdown](https://realtimevfx.com/t/star-citizen-explosion-vfx-breakdown/632/5), [80.lv Star Citizen explosions](https://80.lv/articles/vfx-of-star-citizen-working-on-explosions/), [Battlefront II layered explosion](https://simonschreibt.de/gat/battlefront-ii-layered-explosion/).

### 4. Per-metre burning trails
See the beaded soot bug above. Lit types also gained:
- `stretch`: velocity-streaked sprites;
- `windTau`: wind ramps in with age, so new smoke follows the emitter and old smoke drifts;
- `minPixels`.

### 5. Ground blast
Poses: `ground-large-*`.
- Soil-coloured (0.11 / 0.095 / 0.075) dirt.
- 8–12 jets of `L.spike` (4 puffs each, stretched): the radial ejecta spikes.
- 28 `L.clump` ballistic clods.
- A rolling dust skirt.
- A scorch written into `vfx.scorches`. The terrain draws it (see "Terrain scorch hook-up").

### 6. Fire columns
Pose: `fire-column-45s`.
- `L.column`: buoyancy 4.6, windTau 9.
- `L.columnTop`: windTau 5.
- Vertical speed is `rnd(6, 10) + 0.5·size`, so the column stands and then leans with height.

### 7. Flak
Poses: `flak-*`.
- A 0.05 s flash.
- 8–12 dark `L.flak` puffs (colour 0.032), living 15–25 s.
- 6–10 fragment streamers of 10 `L.frag` puffs each, with drag 2.2 and slight sink, so the burst has the ragged shape seen in WWII and Korea footage.
- References: [NMUSAF: Flak 36 88 mm](https://www.nationalmuseum.af.mil/Visit/Museum-Exhibits/Fact-Sheets/Display/Article/196233) ("a characteristic black cloud hanging in the sky").

### 8. Lightning bolt on `weather:lightning`
Pose: `lightning-night`.
- `Bolts.js` draws instanced capsules along a channel from `makeBolt`: midpoint displacement with roughness 0.2, branch probability 0.25 and thinner branches. It is pure, deterministic and tested.
- The channel runs from cloud base + 150 m to the jittered ground.
- Brightness follows `env.weather.lightning.intensity`, so restrikes relight it (`strokeEnvelope` is tested).
- The core is at least 0.6 px wide, with a 5× glow quad.
- Only `src/vfx/system.js` listens to the event; `src/world/weather/**` was not changed.
- Reference: [NWS, lightning in slow motion](https://www.weather.gov/safety/lightning-science-slow-motion-flashes) (branched stepped leader, return stroke).

### 9. The rest
| Effect | Change | Pose |
|---|---|---|
| Debris trails | Darker (0.04), tapered, `glow` 0, wobble. Head glow 1.4× with fire tongues at 30/s. | `debris-0.9s` |
| Smoke | Albedo 0.03–0.06; life from `blastSmokeLife` | |
| Shock ring | Intensity 0.1 | |
| Flare smoke | Trail style `flare`: radius 1.2, growth 2.2, opacity 2.2. Camera reframed so the shot actually contains the flares. | `flares-1.2s` |
| Contrail | wobble 3, lump 0, taper 25 | `contrail*` |
| Rain | `L.rain` grey streaks (thin, stretched), 0.03–0.055 m, within 14 m. Far curtains above 0.25 rain. | `rain-cockpit` |
| Cloud wisps | Alpha 0.2 × inCloud | `cloud-cockpit` (rig pins `inCloud` to 0.9) |

Particle visibility for stretched sprites now uses `pow(size/len, 0.25)`, not 0.5. Before, rain and spikes faded to nothing when stretched.

### 10. Terrain decal
I skipped the terrain decal, as agreed. The API exists, and webgpu-aaa's terrain now consumes it (see "Terrain scorch hook-up").

## Prewarm: no first-use hitch
I counted pipelines created on first use with `renderer._pipelines` before and after each event.

**Before**

| Event | Pipelines created on first use |
|---|---|
| First gun burst | 10 (about 293 ms wall) |
| First missile | 3 |
| First explosion | 3–4 |

**After:** 0 for gun, missile, explosion, flare, flak and lightning.

**How**
- `vfx.prewarm()` runs for the first 3 frames. It draws a zero-size instance of every pool, tracers, bolts, shells and aircraft effect.
- `CombatVisuals._prewarm()` hangs one 1/1000-scale clone of every store model in front of the camera for 4 frames. The missile body's colour and shadow pipelines used to build on first launch and stalled for 0.5–0.9 s.

I did not measure frame-gap timing in ms: the page runs as a background tab with throttled rAF, so wall-clock gaps there are meaningless. The pipeline counts are the evidence.

## Screen hit
- `ScreenState.hitSeverity(s)` sets `damage = s^1.25` and `smear = s²`. There is no floor; the old 0.35 floor made every graze flash a third of the full edge.
- `ScreenState.hit(fraction)` maps onto the same curve.
- `src/camera/system.js` now calls `screen.hitSeverity(sev)` with the existing `cameraMath.hitSeverity(p)`. This is a two-line change outside my listed paths, made because that is where `player:hit` reaches the screen.
- `src/fx/post/**` is untouched.
- Test: "screen hit scales from zero with severity (no floor)".

## Terrain scorch hook-up
After merging webgpu-aaa:
- `VfxSystem._feedScorches` calls `game.terrain.setScorches(scorches.list(now))` whenever the ring's `version` changes, and every 4 s after that, so the terrain's age fade (600 s) follows.
- `ScorchRing.list` returns oldest-first `{x, y, z, radius, age}` and is tested.
- Verified in game: a large ground blast gives `scorchCount 1` and a radius of 32.5 m. After 90 s the strength is 0.85 and the mark is visible (`scorch-terrain-off-on-90s.jpeg`).
- The mark is subtle: the terrain owner's shader darkens albedo by up to 80% inside 0.3R and fades out at R.

## GPU cost
Setup:
- Busy combat scene: `combat` at 2.4 s, seed 7, camera `rel [30, 12, 70]`.
- High tier, WebGPU, canvas 2560×949.
- `?gputime` GpuProfiler.
- Fresh page per run; 7 readings of 40 frames each; medians shown.

| ms (median) | before run 1 | before run 2 | after run 1 | after run 2 |
|---|---|---|---|---|
| Frame total | 1.174 | 1.077 | 1.044 | 1.112 |
| VFX layer pass | 0.050 | 0.057 | 0.061 | 0.067 |
| Compute (all systems) | 0.306 | 0.215 | 0.323 | 0.363 |

- The VFX layer is about +0.01 ms, and the total is within run-to-run noise. This is well inside the +0.3 ms budget.
- The compute bucket includes non-VFX compute and swings by ±0.1 ms between runs of the same build.
- This measurement was taken before the final plume-saturation change (a constant change, no cost) and before the merge.
- Low tier: particle sizes use `sizeForRate`, which multiplies size by 1/√rate, so fewer, bigger puffs keep the same coverage. There are no new passes.

## Residuals
- **Flare trail segments:** some periodic structure along the flare trail remains. It was present before as well; the cone segments soften it but do not remove it.
- **Burner side view:** the side view is softer and wider than the old thin wisp. The Mach disks read, but the outer flame could be tighter.
- **Low-tier fireballs:** with 1/√rate sizing, low-tier fireballs are a few large lumps (see `webgl-low-sheet.jpeg`).
- **Mission resets:** the scorch ring is not cleared on mission reset; marks fade out over 600 s. A `mission:start` → `scorches.clear()` hook would fix this if wanted.
- **Flipbook:** the stretch goal (procedural flipbook in `tools/vfx`) was not done.
