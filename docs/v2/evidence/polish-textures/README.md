# Texture polish: terrain, aircraft, cockpit, ground units

Branch `worktree-agent-aa6e1fd7dcfec24d7`. It includes the glass/water and
shadows merges of `webgpu-aaa`.

**Scope:** every textured surface the player sees.

**Capture:** 1600x900, high tier, 11:30, `?noclouds`, HUD hidden, DOF off.
The before shots are `webgpu-aaa`'s versions of the files listed under
[Fixes](#fixes), with the same scripted camera.

## References

Colours and contrast were checked against photographs of the Kargil and Drass
area from Wikimedia Commons:

- https://commons.wikimedia.org/wiki/File:Drass_and_Tololing_Range.jpg
- https://commons.wikimedia.org/wiki/File:The_Tiger_Hill_(3976856895).jpg
- https://commons.wikimedia.org/wiki/File:Panorama_of_Kargil.jpg
- https://commons.wikimedia.org/wiki/File:Landscape_on_kargil_to_leh_road.jpg
- https://commons.wikimedia.org/wiki/File:Lower_Suru_Valley_landscape_near_Purtikchay_between_Sanku_and_Panikhar.JPG

New ground textures, all CC0, are recorded in `public/THIRD_PARTY_NOTICES.txt`:

- https://polyhaven.com/a/rock_ground_02 (new scree)
- https://polyhaven.com/a/gray_rocks (new talus layer)

The cockpit dial faces and screens are original procedural artwork.

## Findings

### Terrain

- **Flat and pale.** Sampled slope regions, in sRGB:

  | Source | Mean RGB | Luma CV |
  |---|---|---|
  | Drass photo | 128 / 107 / 77 | 0.27 |
  | Kargil-Leh road photo | 96 / 89 / 72 | 0.29 |
  | Kargil town photo | — | 0.16 to 0.32 |
  | Render before | 150 / 135 / 116 | 0.08 |

  The render was 3 to 4 times flatter than the photos. A checker test through
  the AgX and auto-exposure chain kept its contrast, so the flatness was in the
  albedo, not in the tone mapping.
- **Wrong material.** The scree layer (`dry_ground_rocks`) is cracked desert
  mud.
- **Wrong colour.** A `rockPurple` palette entry put lavender patches on every
  slope. No reference shows them.
- **Gravel beds** read as white beads from the air.
- **Snow** had no relief, and its texture has boot prints.
- **No scrub.** The sparse dark shrub dots on every lower slope in the photos
  were missing.
- **Anisotropy** was 8 on high, so grazing slopes blurred.
- **Low tier (reported after the shadows merge).** The ground showed a lattice
  of pale dots and diagonal stripes, which persisted with cloud shadows off.
  - Cause: the scree texture's own tile-scale blotches, two sand patches and a
    dark diagonal band per 3.6 m tile. Low samples one octave with no fine
    detail, so every tile repeats them exactly.
  - Confirmed by replacing only the scree albedo with its mean colour at run
    time: the lattice disappeared.
- **Shrub shade.** The shade of a clump was cut off square at its 5 m cell edge.
  A low sun made this obvious.

### Aircraft and cockpit

- **Model textures had anisotropy 1** (the GLTFLoader default), so the skin
  smeared at any oblique angle.
- **The 1024 px skin atlas** went soft when magnified. The source model has
  nothing higher.
- **The pitot tube** was the exporter's magenta.
- **Hostile skin.**
  - The removed roundels left smooth discs with no grime on weathered wings.
  - Anti-aliased green slivers of the fin flash survived.
- **Cockpit.**
  - Gauges were 30 to 50 px in a 1024 atlas.
  - The overlay screens were 256 px and aliased.
  - The turquoise panel colour is correct for the type and was kept.

### Ground units

- Flat baked atlases with no normal map: every truck, gun and tent read as
  plastic from 10 m.

## Fixes

### Terrain

Files: `tools/terrain/fetch-textures.mjs`, `public/assets/textures/terrain/`,
`src/world/terrain/{layers,material,Terrain}.js`. Edits are tagged
`[textures]`.

- **Layers.**
  - Scree is now `rock_ground_02` (grey-brown gravelly scree).
  - A new talus layer (`gray_rocks`, frost-shattered blocks) is height-blended
    onto steeper and higher scree.
- **Palette.** Re-fitted to the photos: rockPurple is replaced by slate, there
  are warmer and greyer scree tones, and grass is drier.
- **Contrast.**
  - Enlarged octaves keep more contrast (0.78, was 0.5).
  - Hundred-metre and ten-metre debris patches.
  - Stronger cavity and layer AO.
  - Scree normals at 1.6x.
- **Gravel.** Desaturated, and its contrast drops with distance.
- **Snow.** Wind-stretched sastrugi from the detail tile, as normal only.
- **Scrub.**
  - Lobed, ragged clumps with ground shade.
  - Density follows vegetation, altitude and slope.
  - The clumps fade to mean coverage when under about 2 px.
- **Anisotropy.** Medium 8, high and ultra 16.
- **Low-tier lattice fix.** This fixes every tier.
  - `fetch-textures.mjs` gained a `flatten` option. It is a seamless high-pass
    (wrapped Gaussian blur, divided out in linear space), applied to albedo, AO
    and height of the ground-cover layers.
  - Strengths: scree 0.9 (sigma 1/40 of the tile), grass 0.75, gravel 0.6,
    talus 0.7 (sigma 1/16).
  - The texture means in `layers.js` were re-measured to match.
  - The palette and macro patches supply the large-scale variation instead,
    with no period.
- **Shrub fix.** The shrub term now checks the 2x2 cells nearest the pixel, so a
  clump or its shade can reach over a cell edge. The shade offset is capped at
  1 m.

### Aircraft, cockpit and units

Files: `src/assets/materials.js` (not the glass branch), `loadModel.js`,
`system.js`, `public/models/`, `tools/blender/`.

- **Anisotropy.** Every model texture uses the device maximum (4 on the low
  tier).
- **Unsharp mask.** Applied in the shader to base colour, on medium and above:
  skin 0.55, hostile 0.4, cockpit 0.35.
- **Pitot.** Dark metal.
- **Cockpit** (`tools/blender/upgrade-cockpit-textures.mjs`).
  - The atlas is upscaled to 2048 with lanczos3 and an unsharp mask.
  - 23 dials are redrawn as crisp procedural faces.
  - The overlay screens are redrawn at 512 px, anti-aliased.
- **Hostile skin** (`tools/blender/fix-hostile-markings.mjs`).
  - Former marking areas take on the luminance-ratio grime of an adjacent clean
    patch.
  - Green slivers are replaced by the median of the surrounding grey.
  - The fix is limited to painted skin materials; the cockpit, seat and stores
    keep their colours.
- **Ground units.**
  - A 0.45 m object-space triplanar grain from the terrain's scree layer
    modulates bump and tint.
  - The grain is halved on metal.

## Before / after pairs

| Subject | Before | After |
|---|---|---|
| Slope, 90 m | `before-terrain-slope.jpeg` | `after-terrain-slope.jpeg` |
| Ground, 60 m | `before-terrain-ground-60m.jpeg` | `after-terrain-ground-60m.jpeg` |
| Valley, 600 m | `before-terrain-valley-600m.jpeg` | `after-terrain-valley-600m.jpeg` |
| Far, 2.5 km | `before-terrain-far-2500m.jpeg` | `after-terrain-far-2500m.jpeg` |
| Valley floor with scrub, 35 m | `before-terrain-valley-35m.jpeg` | `after-terrain-valley-35m.jpeg` |
| Snow | `before-terrain-snow.jpeg` | `after-terrain-snow.jpeg` |
| Low tier, valley floor, 30 m (lattice and stripes) | `before-low-tier-valley-30m.jpeg` | `after-low-tier-valley-30m.jpeg` |
| WebGL2 fallback (low tier) | — | `after-webgl2-valley-35m.jpeg` |
| MiG-21 chase | `before-mig-chase.jpeg` | `after-mig-chase.jpeg` |
| MiG-21 close | `before-mig-close.jpeg` | `after-mig-close.jpeg` |
| Hostile MiG-21 | `before-hostile.jpeg` | `after-hostile.jpeg` |
| Cockpit | `before-cockpit.jpeg` | `after-cockpit.jpeg` |
| Cockpit panel | `before-cockpit-panel.jpeg` | `after-cockpit-panel.jpeg` |
| Units lineup | `before-units-lineup.jpeg` | `after-units-lineup.jpeg` |
| Units close | `before-units-close.jpeg` | `after-units-close.jpeg` |

Notes on the pairs:

- The `valley-600m` pair differs by a few degrees of yaw, but from the same eye.
- In the low-tier pair the shrubs move, because the shrub placement changed
  with the 2x2 fix.

## Download size (against `webgpu-aaa`)

| Asset | Before (B) | After (B) | Delta (B) |
|---|---:|---:|---:|
| Terrain textures (`public/assets/textures/terrain/`) | 5,083,705 | 6,392,606 | +1,308,901 |
| `mig21.glb` (2048 px cockpit atlas) | 4,402,240 | 4,612,172 | +209,932 |
| `mig21_cockpit.glb` | 27,176 | 46,320 | +19,144 |
| `mig21_hostile.glb` | 4,349,028 | 4,352,956 | +3,928 |
| `mig21_hostile_lod1.glb` | 1,036,468 | 1,039,312 | +2,844 |
| **Total** | | | **+1,544,749 (1.47 MiB)** |

The terrain delta is almost all the new talus layer (1,009,860 B) and the
larger `rock_ground_02` scree maps (+282,655 B).

## GPU cost

All runs at 2560x1440, high tier, `?gputime&noclouds`, adaptive resolution off,
`timeScale = 0`. Values are the median of 3 runs, in ms.

### Before the shadows merge

These are the cleanest runs. Each cell is total / scene.

| Pose | Before | After | Delta (total) |
|---|---|---|---|
| slope-90m | 0.912 / 0.393 | 1.04–1.11 / 0.52–0.58 | +0.13–0.20 |
| valley-600m | 0.968 / 0.421 | 1.02–1.03 / 0.50 | +0.05–0.07 |
| chase-900m | 1.008 / 0.467 | 1.09 / 0.55 | +0.08 |
| cockpit-900m | 1.039 / 0.49 | 1.07 / 0.54 | +0.03 |
| strike-120m | 1.054 / 0.534 | 1.24–1.32 / 0.70 | +0.19–0.26 |

### After both merges

The terrain is no longer in the shadow pass, so these numbers are not
comparable to the table above. The browser is shared with other agents, so the
same build varies by up to about 0.5 ms between reloads.

- **Fixed chase pose, 5 x 120 frames.**
  - Baseline: total 1.13–1.16, scene 0.567.
  - This branch: total 1.20, scene 0.63 in one load; total 0.60–0.62, scene
    0.32 in another.
- **Five-pose script.** Baseline totals were 0.74–1.41; this branch's were
  0.63–1.64. The ranges overlap.

Every delta is within the +0.3 ms budget, and none measured after the merges
is distinguishable from noise. The only shader change since the pre-merge
measurement is the 2x2 shrub lookup: ALU on shrub-covered pixels, with no
texture fetches.

## Checks

- `npm test`: 242 of 242 pass. The catalog test checks the new model byte
  sizes.
- `npm run build`: succeeds.
- WebGL2 (`?webgl`, low tier): renders with no console errors.
- Low tier (WebGPU): no lattice, no stripes and no square shrub shade at 11:30
  or at a grazing sun.

## Left open

- The sangar model has floating disc pieces. This is geometry, not textures.
- Units in the manual lineup sit slightly above the ground. They are not seated.
- Foundation berm snow can disagree with terrain snow. A berm turns white at
  4930 m where the terrain around it is bare.
- The compass dial keeps its square bezel corners. Cockpit areas other than the
  dials are only upscaled.
- The `snow_02` albedo has boot prints, so it is used at low weight. A better
  CC0 snow texture would help.
- Shrubs are still fairly round up close.
- On the low tier, the flattened scree is quite uniform at 30–100 m; the
  variation there comes from the macro patches only. Enabling the fine-detail
  octave on low would add some back, at a cost.
- Water and river looks belong to the glass/water polish, and shadows to the
  shadows polish.
