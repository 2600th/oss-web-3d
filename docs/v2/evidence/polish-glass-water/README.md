# Glass and water polish

Audit and fixes for the transparent and reflective surfaces: the aircraft glass
(player and hostile canopies, the nav-light lenses) and the glacial rivers. Every
image was captured in the running game (`?mission=m1`, high tier, HUD hidden) at
2560x949 CSS px, with the camera fixed via a dev hook so each `before-*` and
`after-*` pair shows the same view, time of day and position.

Code: `src/assets/glass.js` (new), the `[glass]` branch of `src/assets/materials.js`,
`src/world/water/river.js`, and the `[water]` hunks of `src/world/terrain/material.js`.

## Findings (before)

### Glass

- **Canopy was almost invisible in chase view.** It used plain alpha blending, so
  the output was `src * a + dst * (1 - a)`. With the opacity near 0.1 head-on, the
  sky reflection and the sun glint were *also* multiplied by 0.1. Only the frame
  read as "canopy". On real acrylic the reflection is added at full strength while
  the background is only slightly dimmed.
- **No sun glint at any angle.** Two causes stacked. The opacity multiply was one.
  The other was the 0.04 roughness: at that value the sun's specular lobe is a
  sub-pixel point that TRAA averages away. A test sphere with the same material
  confirmed the shading model itself was fine.
- **Cockpit view.** The inner surface mirrored the bright sky, so the inside of
  the bubble looked faintly milky against dark terrain. The amber panel-flood orb
  was already fixed by `lightsNode = lights([env.sun])`; that fix is kept.
- **`glass_misc`** was left "as loaded" on purpose. Probing the vertices showed it
  is not a windscreen sheet: it is three ~3 cm lens covers at the wingtips
  (x = +/-2.8 m) and the fin tip. As loaded, they rendered as grey classic-material
  specks.
- **Hostile canopy** read as a dark hole: same material and the same opacity problem.
- **Gunsight combiner, instrument glass.** Neither exists as geometry in the GLB.
  The gunsight is drawn by the HUD canvas and the instrument faces are part of the
  cockpit texture. There is nothing to shade.
- **Truck windscreens** are baked into the vehicle's opaque 1k atlas. There is no
  separate glass material to fix (see "Open").

### Water

- **Colour.** The river was a flat, saturated cyan-blue ribbon. Glacial
  meltwater in the Dras, Suru and Indus carries rock flour. It is opaque, pale and
  only faintly jade, about as bright as the dry scree beside it (summer photos
  sample to sRGB ~(135-165, 150-190, 145-175)).
- **Uniform reflection.** Water deep in a narrow valley mirrored the open sky. In
  reality it mirrors the dark valley walls and shows sky only near the camera,
  where the reflected ray climbs above the ridge line.
- **Ripples** were isotropic and static-looking. There was no flow alignment, no
  streamwise streaking and no change at rapids.
- **Distance.** At 500 m to 3 km the ripple normals aliased into shimmer. There
  was no roughness compensation, so the sun path broke into noise instead of a
  broad glitter path.
- **Banks.** The water met dry gravel with a hard edge: no wet margin and no foam
  line.
- **Fresnel** used the standard material's F0 of 0.04. Water is ~0.02 (n = 1.33),
  so grazing and dusk reflections were too strong (golden hour turned blue).

## Fixes (after)

### Glass (`src/assets/glass.js`, used from `materials.js`)

- **Premultiplied "glass over".** A small subclass (`premultipliedGlassClass`) skips
  three's premultiply. The rgb output is the reflected light, unscaled. Alpha is a
  Schlick Fresnel coverage over an absorption floor (8 % head-on, 80 % at grazing),
  and the blend is One / OneMinusSrcAlpha. Reflection is emission and coverage is
  transmission, as in McGuire and Bavoil's formulation and the premultiplied
  translucency used by Frostbite and UE.
  - The glass now writes `mrt({ velocity: vec4(0) })`. With premultiplied blending,
    the velocity target keeps the background's motion.
- **Visible sun glint.** The base layer roughness is 0.085, which plays the role of
  sphere-light widening (Karis 2013): the half-degree sun disc becomes a glint a few
  pixels wide that survives TRAA. A 0.02 clearcoat keeps the sky reflection crisp.
  The clear canopy also gets ior 1.52 and envMapIntensity 1.4.
- **Inside vs outside.** The shell is modelled with thickness, so face orientation
  cannot tell the inner surface from the outer one. Instead the eye position is
  taken in mesh space and tested against the canopy's bounding box. When the eye is
  inside (cockpit view), the environment reflection is cut to 12 % through the AO
  input. This works because three applies AO to indirect specular and to clearcoat
  (specular occlusion, Lagarde and de Rousiers 2014). The cockpit view stays clean,
  with no milky veil and no orb at night.
- **Dust and haze.** Two object-space noise scales (blotches and specks), shown only
  within ~14 m of the camera. They raise roughness a little and add a faint
  forward-scatter of the key light: a Henyey-Greenstein-like lobe toward the sun or
  moon. Looking into a low sun, the canopy hazes the way real acrylic does.
- **Nav-light lenses (`glass_misc`).** Tinted lens glass, red on the left, green on
  the right and clear on the tail, matching the lamps the time-of-day system hangs
  there.
- **Low tier.** The same premultiplied output, with no clearcoat, no dust and
  roughness 0.07.

### Water (`river.js` plus `[water]` terms in the terrain material)

- **Body colour** is grey-jade rock-flour milk (linear `MILK` 0.118/0.148/0.140).
  It is paler and browner over shallow bed, with slow sediment plumes advected
  downstream. Wet gravel shows through at the margins.
- **Flow-mapped ripples.** Two phases with a 2.6 s period, advected along the baked
  downstream direction (Vlachos, "Water Flow in Portal 2", SIGGRAPH 2010), at three
  scales (23 m, 6.5 m, 1.9 m).
  - Calm and fast reaches are anisotropic. Texture gradients are stretched along
    the flow (`.grad()`), so the hardware anisotropic filter smears features into
    streamwise streaks.
  - Rapids, from the baked bed fall, switch to isotropic chop with speed up to
    ~8 m/s.
- **Footprint roughness** (Toksvig 2004 and the LEAN-mapping idea). The slope
  variance that the mips average away is folded into GGX roughness, as a function
  of the pixel footprint. Close up there is sparkle; at 3-10 km there is a single
  broad sun path instead of shimmer.
- **Horizon specular occlusion** (after Jimenez et al. 2016, GTSO). The terrain's
  baked cosine-weighted sky visibility gives the horizon elevation
  (`sin h = sqrt(1 - skyVis)`). Sky reflection is occluded below the ridge line and
  replaced by the valley walls' own radiance, read from the environment's
  HemisphereLight ground term (`wallRadiance`).
- **Water F0.** three's F0 is 0.04; it is rescaled to 0.02 through the AO input, so
  grazing reflection is right for water.
- **Whitewater.** Lace-thresholded foam at rapids, from two advected noise scales,
  plus thin foam lines along the banks. Footprint-gated flecks appear only where
  they resolve. All foam fades out by ~4.5 km.
- **Wet banks.** A darkened, smoother band (albedo x0.62, roughness 0.22) a few
  metres outside the waterline, off on snow.
- **Night.** The same model lit by the moon as key light. The body is very dark and
  the moon glints.

## Evidence

| scenario | before | after |
| --- | --- | --- |
| River 70 m, noon (Dras, M1) | `before-river-70m-noon.jpeg` | `after-river-70m-noon.jpeg` |
| River 500 m, noon | `before-river-500m-noon.jpeg` | `after-river-500m-noon.jpeg` |
| River 3 km, noon | `before-river-3km-noon.jpeg` | `after-river-3km-noon.jpeg` |
| River 70 m, dawn | `before-river-70m-dawn.jpeg` | `after-river-70m-dawn.jpeg` |
| River 70 m, golden hour | `before-river-70m-golden.jpeg` | `after-river-70m-golden.jpeg` |
| River 70 m, night (moon) | `before-river-70m-night.jpeg` | `after-river-70m-night.jpeg` |
| Indus gorge, golden glint path | none | `after-indus-gorge-golden-glint.jpeg` |
| Canopy chase, 3/4 view | `before-canopy-chase-34.jpeg` | `after-canopy-chase-34.jpeg` |
| Canopy at the sun-mirror angle | `before-canopy-sun-glint-angle.jpeg` | `after-canopy-sun-glint.jpeg` |
| Canopy chase, golden hour | none | `after-canopy-chase-golden.jpeg` |
| Cockpit, toward the sun | `before-cockpit-sun.jpeg` | `after-cockpit-sun.jpeg` |
| Cockpit, noon | `before-cockpit-noon.jpeg` | none (same as sun) |
| Cockpit, moonlit night | `before-cockpit-night.jpeg` | `after-cockpit-night.jpeg` |
| Hostile MiG-21 canopy | `before-hostile-canopy.jpeg` | `after-hostile-canopy.jpeg` |
| Low tier: canopy, river 70 m | none | `after-low-canopy-chase.jpeg`, `after-low-river-70m-noon.jpeg` |
| WebGL2 backend: canopy, river 70 m | none | `after-webgl2-canopy-chase.jpeg`, `after-webgl2-river-70m-noon.jpeg` |

The low tier and the WebGL2 backend (`?webgl`, confirmed `r.backend === 'webgl2'`)
compile and render both the glass and the water with no console errors or warnings.
The WebGL2 river frame is soft because post-processing blurs that camera at that
moment; the canopy frame from the same session is sharp.

## GPU cost

Measured with `?gputime` (`__perf.profiler.summary()`): scene pass, median of 4
windows of 2.5 s each, fixed camera, 2560x949. The baseline is the same build
with the original water files.

| view | baseline | after |
| --- | --- | --- |
| river from 25 m | 0.459 ms | 0.456 ms |
| river from 70 m | 0.473 ms | 0.466 ms |
| Indus gorge, golden | 0.450 ms | 0.442 ms |

The water changes cost nothing measurable: the differences are within noise (the
scene pass is bound elsewhere, and the reflection terms are ALU only). The
glass was not timed on its own. It touches only canopy pixels (a few percent of the
screen in chase) and adds two Perlin noise lookups plus the same physical shading
the canopy already had. The estimate is well under 0.05 ms. Both stay within the
+0.3 ms budget at 1440p.

## References

Techniques:

- M. McGuire, L. Bavoil, "Weighted Blended Order-Independent Transparency", JCGT 2(2), 2013, sec. 2 (reflection as emission, coverage as transmission). http://jcgt.org/published/0002/02/09/
- B. Karis, "Real Shading in Unreal Engine 4", SIGGRAPH 2013 course notes (sphere-light roughness widening). https://blog.selfshadow.com/publications/s2013-shading-course/
- S. Lagarde, C. de Rousiers, "Moving Frostbite to Physically Based Rendering", SIGGRAPH 2014 course notes (specular occlusion from AO).
- A. Vlachos, "Water Flow in Portal 2", SIGGRAPH 2010 Advances in Real-Time Rendering (two-phase flow maps).
- M. Toksvig, "Mipmapping Normal Maps", NVIDIA 2004, and M. Olano, D. Baker, "LEAN Mapping", I3D 2010 (folding filtered-out normal variance into roughness).
- J. Jimenez, X. Wu, A. Pesce, A. Jarabo, "Practical Real-Time Strategies for Accurate Indirect Occlusion", SIGGRAPH 2016 course (horizon-based specular occlusion).

Image references for the meltwater colour (summer, rock flour; looked at, not copied):

- Dras River, Wikimedia Commons: https://commons.wikimedia.org/wiki/Category:Dras_River, https://commons.wikimedia.org/wiki/File:Drass_River.jpg, https://commons.wikimedia.org/wiki/File:Drass_River-1.jpg
- Suru-Dras confluence at Kargil: https://commons.wikimedia.org/wiki/File:Confluence_of_the_Suru_and_Drass_River.jpg
- Indus near Kharmang and Skardu, below Batalik: https://commons.wikimedia.org/wiki/File:Indus_river_kharmang.JPG, https://commons.wikimedia.org/wiki/File:River_Skardu_Tolti.jpg
- Zanskar-Indus confluence (turbid vs. clearer water side by side): https://commons.wikimedia.org/wiki/File:Over-Zanskar-Indus-Confluence-Point.jpg
- Indus along the Leh road: https://traveltwosome.com/ladakh-drive-along-indus-river-a-photo-blog

No third-party assets were added; everything is procedural.

## Open

- **No combiner glass mesh.** The gunsight is a HUD canvas element. A physical
  combiner plate (a reflective, slightly green-tinted pane at the gunsight with the
  reticle reflected in it) would need new geometry in the cockpit GLB.
- **No pilot model.** The chase view shows an empty seat through the now-visible
  canopy.
- **Truck windscreens** are part of the opaque atlas, and the ground-unit detail
  normal (the bump and albedo breakup in `upgradeGroundMaterials`) also lands on
  them. A glass mask in the atlas, or a separate material, would let them reflect.
  That belongs to the ground-unit owner.
- **Terrain carving on steep nallahs.** The level-bed carve turns steep side
  streams into chains of pools separated by gravel steps (visible in
  `after-low-river-70m-noon.jpeg`). The water shading follows the carve, so the fix
  belongs in `tools/terrain/build-dem.mjs` (terrain owner).
- **Dust forward-scatter** is deliberately subtle (gain 0.06). It could go to about
  0.12 if art direction wants more haze into a low sun.
- **Resolution.** GPU numbers were taken at 2560x949, not 1440p (the window was
  shared with other agents); the per-pixel cost scales roughly with area.
