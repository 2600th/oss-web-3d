# Shadows polish: line and streak shadows on the terrain

The report: some objects cast thin line shadows on the terrain that do not look right.
I found five sources of line or streak shadows, plus one engine bug that hid one of the fixes.
Each was checked at dawn (05:15 to 06:00), golden hour (18:30), dusk (19:20) and with the moon as key light (22:00).
Tiers checked: high and medium (WebGPU, PCSS), low (WebGPU, disc PCF) and WebGL2 (`?webgl`, disc PCF).

Code: `src/world/shadows/` (new), plus the `[shadows]` parts of `src/world/Environment.js`, `src/world/terrain/Terrain.js`, `src/world/terrain/shadowSweep.js`, `src/world/terrain/material.js` and `src/world/clouds/Clouds.js`.
Tests: `src/world/shadows/shadowMath.test.mjs`.

## Findings

### 1. Thin casters drew razor lines across the ground (the reported bug)

- **Before:** `before-mast-line-0630.jpeg` and `before-mast-line-close-0630.jpeg`.
  At 06:30 (sun 13.5°), a 16 m antenna mast and its guy wires cast hard black lines about 65 m long.
  The jet, 250 m up, cast a crisp silhouette joined to the base by the mast line.
- **Cause:** the sun shadow used three's 1-texel PCF.
  The penumbra width was the same everywhere, whatever the distance between caster and receiver.
  Real sun shadows soften with distance, because the sun is a 0.533° disc and not a point.
  The penumbra is `w = 2 d tan(θ/2)`, which is about 9 cm per 10 m of separation.
  An object stops casting an umbra about 107 times its own width away from the ground: about 21 m for a 0.2 m mast, 3 m for a 3 cm wire.
  So long thin shadows should fade to a faint penumbra, and an aircraft high above should cast only a soft smudge.
- **Fix:** PCSS (Fernando 2005), as a `LightShadow.filterNode` (`makePCSSFilter` in `SunShadows.js`). It works in three steps:
  1. A 10-tap blocker search reads raw depth (`textureLoad`) to find the mean blocker distance.
  2. The penumbra radius is that distance × tan(angular radius), using 0.533° for the sun and 0.518° for the moon.
  3. A rotated Vogel-disc PCF of that radius (16 taps of hardware 2×2 compares) is clamped to 1.25–28 texels.

  Contact shadows stay sharp, and thin or distant casters fade on their own.
  No `castShadow` flags had to change.
- **After:**
  - `after-mast-line-0630.jpeg` and `after-mast-line-close-0630.jpeg`: the mast line is a faint penumbra, the jet is a soft smudge, and the house, sandbags and crates have sharp contact shadows.
  - `after-moon-2200-kit.jpeg`: the moon as key light.

### 2. The 120 m sun shadow box made a strip and pop-in, and its bias detached shadows

- **Before:** a single orthographic box, 120 m wide, followed the player aircraft. This had three effects:
  - At a low sun, its footprint on the ground is a strip 120 m wide and kilometres long, so casters were cut at the strip edge.
  - Ground units cast shadows only while the player was over them.
  - Its fixed 2 m depth bias pulled every small shadow away from its caster (peter-panning).
- **Fix:** three's `CSMShadowNode` fitted to the game camera (`SunCascades`). Details:
  - Practical PSSM splits: Zhang 2006; Dimitrov, NVIDIA 2007.
  - Sphere-sized cascades snapped to whole texels, so they do not shimmer as the camera moves: Valient, ShaderX6.
  - Fade over the last part of `far`.
  - Per-cascade bias from the texel size: a normal offset of 1.5 texels and a depth bias of 0.5 texel (Holbert, GDC 2011; MJP, "A Sampling of Shadow Techniques").

  Per-tier settings are in `shadowMath.js` `SUN_SHADOW_TIERS`:

  | Tier | Cascades | Map size | Range | Filter |
  |---|---|---|---|---|
  | low | 2 | 1024 | 260 m | disc PCF |
  | medium | 3 | 2048 | 520 m | PCSS |
  | high | 4 | 2048 | 900 m | PCSS |
  | ultra | 4 | 4096 | 1200 m | PCSS |

  The fit is refreshed when FOV, aspect or near changes.
- Two problems came up in three r187 and are fixed here:
  - `CSMShadowNode` applies the material's `receivedShadowNode` inside each cascade. Outside the cascades, which is most of the terrain, the cloud and terrain shadows were therefore dropped, and in the fade band they were applied twice. `CascadeShadowNode` leaves the hook out and `SunCascades.setup` applies it once.
  - CSM takes the camera of whatever builds the first lit material. It is now always the game camera.

### 3. The terrain cast into the sun shadow map at grazing sun

- **Cause:** the finest terrain level cast into the 120 m box. At a low sun, each DEM facet edge cast a long, thin shadow stripe across the next facet. It is the same aliasing as finding 1, but from the ground itself.
- **Fix:** the terrain no longer casts into the map (`Terrain.js` `SHADOW_CAST_CELL = 0`).
  Terrain self-shadow comes entirely from the heightfield sweep (`terrain/shadowSweep.js`), which was already soft and covers the whole map.

### 4. Units and props were sunlit inside ridge shadows

- **Before:** `before-kit-lit-in-ridge-shadow-1906.jpg`. At 19:06, the valley floor is in the shadow of the ridge, but the base kit and tent are fully sunlit.
- **Cause:** the heightfield sweep shaded only the terrain material. Everything else saw only the 120 m box, and the terrain did not cast into the box beyond it.
- **Fix:** `ShadowSweep.makeShadowFn` turns the sweep into a TSL function, `env.terrainShadow`.
  `env.applyCloudShadow(material)` now multiplies it into every unit's and prop's received shadow. The terrain material itself is excluded, because it already applies the sweep.
  The sweep is 8-bit, measured in metres below the shadow boundary, and saturates at 47.75 m. So its weight fades from 36 m to 46 m above ground (`sweepReach`), and an aircraft higher up is not shaded by it.
  A soft 3.5 m transition matches the sweep's own penumbra.
- **After:**
  - `after-kit-in-ridge-shadow-1906.jpg`: the kit is in shade like the ground around it. The measured wall pixel is 78 with the sweep and 198 without.
  - `after-dusk-1920-kit-in-valley-shade.jpeg`: dusk at 19:20.
- **Engine bug found on the way:** three's `customProgramCacheKey` ignores `receivedShadowNode`, because it is a function and not a node.
  As a result, materials with and without the hook shared one compiled program, and the hook silently did nothing.
  `keyShadowHook` in `Environment.js` adds the hook's tag to the cache key.

### 5. Cloud shadows made bands at a low sun

- **Before:**
  - `before-cloud-bands-0540.jpeg` (05:40, sun 4°, HUD off): regular dark horizontal bands on every sunlit ridge.
  - `before-m1-dawn-chase.jpeg`: the same bands at the M1 sortie start.
- **Cause:** the cloud shadow map marched 12 fixed steps from the cloud base to the top along the sun ray.
  At a 4° sun, that path is about 45 km, so each step was about 4 km long.
  The steps alias into stripes across the sun azimuth, and they are the same on every texel.
- **Fix** in `Clouds.js` `_shadowPass`. Two changes:
  - The integrated path is capped at `CLOUD_SHADOW_PATH = 8 km` of the sun ray, using 16 steps (10 on low). This follows Hillaire, SIGGRAPH 2016, and the Unreal VolumetricCloud "Shadow Tracing Distance". The far end of a grazing ray does not shade the ground anyway.
  - The start of the march is jittered per shadow texel with interleaved gradient noise, so any leftover step pattern turns into fine noise that the shadow lookup filters out.
- **After:**
  - `after-cloud-bands-0540.jpeg`: same pose, no bands.
  - `after-cloud-0518.jpeg`: 05:18.
  - `after-m1-dawn-chase.jpeg`: sortie start. The cloud field there has evolved, so it is not the same frame.

  At a grazing sun, real cloud shadows are long and soft along the sun azimuth, and they still look that way.

### Not changed: the low tier and WebGL2 have no blocker search

- WebGL2 cannot load raw depth from a compare-sampled depth texture.
  On the low tier, the blocker search is too expensive.
  Both paths use a rotated Vogel-disc PCF with a fixed world radius instead (`makeDiscPCFFilter`). The radius is `fallbackRadius()`, the sun penumbra half-width at 30 m, about 0.14 m. It uses 12 taps, or 8 on low.
- **WebGL2** (`after-webgl2-mast-0630.jpeg`): the mast line is only slightly lighter than before.
  Without a blocker distance, the filter cannot fade a shadow along its length.
  Contact shadows, cascades, bias, the terrain sweep and the cloud fix all work the same as on WebGPU. There are no console errors.
- **Low tier** (`after-low-tier-mast-0630.jpeg`): the coarser map and disc filter already wash the mast line out.
  The diagonal stripes on the ground in that shot come from the low-tier terrain albedo. They are still there with the cloud shadow strength at 0 and no sun shadow on that ground, so they are outside this area: `textures.js` and `layers.js`.
- **Golden hour after the glass and water merge** (`after-merge-golden-1830-kit.jpeg`): checked against the sun, with no line artifacts.

## GPU cost

Measured on an RTX 5090 at 2560×1440, `?quality=high&gputime&noadaptive`, using `window.__perf.profiler.summary()`.
Each value is the median of 3 runs of 90 frames, with the scene frozen (`timeScale = 0`).
The baseline is the previous commit's files, swapped back in and measured on the same poses.

| Pose | Total before | Total after | Δ total | Shadow-map pass | Scene (PCSS + sweep) | Clouds.shadow |
|---|---|---|---|---|---|---|
| Strafe, M1 crest, 05:40, about 150 m AGL | 1.480 ms | 1.586 ms | **+0.106** | 0.017 → 0.052 | 0.551 → 0.602 | 0.056 → 0.063 |
| Golden hour, 18:30, same place | 1.356 ms | 1.426 ms | **+0.070** | 0.025 → 0.047 | 0.423 → 0.459 | 0.056 → 0.076 |
| Cruise, 1500 m AGL, 09:30 | 1.398 ms | 1.525 ms | **+0.127** | 0.015 → 0.049 | 0.536 → 0.578 | 0.056 → 0.078 |

The cost is +0.07 to +0.13 ms, within the 0.3 ms budget.
Other projects' tabs were open on the same GPU, so treat about ±0.02 ms as noise.
The terrain sweep CPU work is unchanged; it still sweeps once per second.

## References

- Zhang, Sun, Xu, Lun. "Parallel-Split Shadow Maps for Large-scale Virtual Environments." VRCIA 2006.
- Dimitrov. "Cascaded Shadow Maps." NVIDIA, 2007.
- Valient. "Stable Rendering of Cascaded Shadow Maps." ShaderX6, 2008.
- Fernando. "Percentage-Closer Soft Shadows." NVIDIA / SIGGRAPH sketch, 2005.
- Holbert. "Normal Offset Shadows." GDC 2011.
- Pettineo (MJP). "A Sampling of Shadow Techniques." 2013.
- Hillaire. "Physically Based Sky, Atmosphere and Cloud Rendering in Frostbite." SIGGRAPH 2016 course.
- Unreal Engine docs: Volumetric Cloud component, "Shadow Tracing Distance" (default 15 km).
- Jimenez. "Next Generation Post Processing in Call of Duty: Advanced Warfare" (interleaved gradient noise). SIGGRAPH 2014.

## Open items

- **WebGL2 thin casters:** they still draw a lighter but visible line, because the fallback has no blocker search.
  Possible fixes:
  - a second, non-compare depth copy for the blocker search;
  - not casting from sub-10 cm parts such as guy wires (`loadModel.js`).
- **Sweep height limit:** `env.terrainShadow` reaches only about 46 m above ground, because the 8-bit sweep saturates there.
  An aircraft flying low through a shadowed valley above that height stays sunlit.
- **Sub-DEM terrain self-shadow:** fine detail smaller than a DEM cell no longer comes from the shadow map. Normal-mapped shading still carries the small-scale relief.
- **Cloned materials:** `material.clone()` keeps `receivedShadowNode` but not the cache-key override. Call `env.applyCloudShadow` again on clones.
- **Receiver-plane depth bias** (Isidoro, GDC 2006): considered and not implemented. Normal offset plus per-texel bias showed no acne in the shots checked, with the sun from 3° to 37° and the moon at 37°. It is worth revisiting if acne appears on steep receivers.
