# Polish: aircraft, ground units, HUD

Screenshots were taken in Chrome with WebGPU at 1920x889, unless the file name says
phone. For the posed shots, a scratch script holds the sim nearly still
(`timeScale` 0.0005) and fixes the camera. It also hides the `vfx-glow` particle mesh,
because with the sim frozen the glow piles up at the nozzle. Nothing in the game code
changes for these captures.

## Aircraft

| shot | what it shows |
| --- | --- |
| `before-player-34.jpeg` / `after-player-34.jpeg` | Player MiG. The paint is a physical material with a light clearcoat, metalness 0.18 and roughness that varies with the texture (dirt and panel lines are rougher). It has environment reflections, cloud shadows and sun self-shadowing. The canopy is clear glass (clearcoat, IOR 1.52, Fresnel opacity) with the cockpit visible through it. |
| `after-hostile-34.jpeg` | Hostile camo: darker two-tone grey (upper 0.165 / 0.30, underside 0.47 linear), no markings. |
| `after-surfaces-deflected.jpeg` | Stabilators, ailerons and flaps at full throw. |

Control surfaces (`tools/blender/build_mig_surfaces.py`, which can be re-run, then
`build-mig-player.mjs`, `build-mig-variants.mjs` and `build_mig_lod1.py`):

- **Stabilators** pivot at 40% of the root chord. Travel is 16.5° trailing edge up and
  7.5° down, at 40°/s.
- **Ailerons** pivot at the hinge line. Travel is ±20°, at 80°/s.
- **Flaps** travel 25°. They deploy below 125 m/s and are fully down at 95 m/s, at
  12°/s.
- **Smoothing:** each surface is rate-limited, then lagged (tau 0.06 s; 0.2 s for the
  flaps).

Where the demands come from:

- **Player:** `flight.rates` divided by `pitchAuthority` / `rollAuthority`.
- **Hostiles:** body rates taken from the quaternion change between frames. Only
  hostiles within 3 km animate. Both LODs carry the pivots.

## Ground units

| shot | what it shows |
| --- | --- |
| `after-sangar-berm-slope.jpeg` | A sangar is kept almost level on the slope. Its uphill side is dug in, and an earth berm with a snow cap sits under the downhill side. |
| `after-flak-seated-gravel-pad.jpeg` | Towed flak follows the slope (up to 10° of tilt) on a gravel pad. |
| `after-aaa-tracking-lead.jpeg` | AAA traverses with a lead solution. Measured barrel elevation is 18.0° against 18.5° to the target, with about 12° of horizontal lead at 1.6 km. |
| `after-sam-launcher-raised-tracking.jpeg` | The SAM launcher is stowed until the site tracks. It then rises to 24° or more, follows the jet, and stays up for 8 s after the last activity. |
| `after-sam-destroyed-wreck-fire.jpeg` | Kill: the `sam_launcher_destroyed` model swaps in, the wreck is re-seated on the terrain, and fire and smoke burn. |

The radar dish turns about 1.6 rad/s (it is driven by `src/ai`).

Seating:

- **Vehicles** follow the slope up to their tilt limit.
- **Emplacements** tilt 3–9°, with the base set at a "bury" fraction between their
  lowest and highest corners.
- **Berm:** any edge more than 0.15 m off the ground gets a jittered berm. It is gravel
  (triplanar), with snow above 4,700 m on flat tops.

`src/ai/sites.js` now rejects sites steeper than about 20°. Measured unit slopes in m1
went from a maximum of 1.08 to a maximum of 0.41.

## HUD

| before | after | fix |
| --- | --- | --- |
| `before-hud-markers-on-alt-tape.jpeg` | `after-hud-markers-clear-alt-tape.jpeg`, `after-hud-markers-on-tape-pips.jpeg` | **Desktop:** markers and labels stay off the tapes (note 1). |
| `before-hud-phone-portrait-radio.jpeg` | `after-hud-phone-portrait-radio-lifts.jpeg` | **Phone portrait:** the radio plate moves off the markers (note 2). |
| `before-hud-phone-landscape-banner.jpeg` | `after-hud-phone-landscape-banner.jpeg` | **Phone landscape:** the banner no longer sits on the pitch ladder (note 3). |
| `before-hud-snow-contrast.jpeg` | `after-hud-snow-contrast.jpeg` | **Contrast:** stronger ink and halos (note 4). |

1. **Markers and labels clear of the tapes.** The HUD builds a list of areas to keep
   clear (`src/ui/declutter.js`): the tapes with their readout boxes and G/R rows, the
   heading tape, the corner panels, the banner and the radio plate.
   - A marker that lands on a tape shrinks to a small pip with no text.
   - Each label tries three positions in turn: name above with range below, then
     beside the marker on the outer side, then on the other side. It takes the first
     position that is clear of those areas, the other markers and labels already
     placed.
   - The TGT tag is dropped before a label moves aside.
2. **Portrait radio plate.** While the plate would cover a marker, it slides up over
   the objective line and the objective line is hidden. It comes back once its normal
   spot has been clear for 1.5 s.
3. **Landscape banner.**
   - The banner now sits under the bottom of the tapes, and the ladder is clipped
     around it, as it already was for the kill callout.
   - If a long radio line needs the space, the banner moves up.
   - The banner plate is 0.86 opaque on touch screens.
4. **Contrast.**
   - Dim ink alpha goes from 0.62 to 0.74, and faint from 0.28 to 0.40.
   - Halo alpha goes from 0.72 to 0.80; the soft halo from 0.42 to 0.50; the text halo
     from 0.60 to 0.68.
   - Dim labels now hold up over sunlit snow without looking heavy over dark rock.

## Other checks

- `after-quality-low.jpeg` (`?quality=low`) and `after-webgl.jpeg` (`?webgl`): both
  render with no console errors.
- `npm test` passes (187 tests) and `npm run build` succeeds.

## Known gaps

- Hostile fighters load LOD0 only (`tryLoadModel` in `src/ai/models.js`), so the LOD1
  pivots are unused until the AI loads LOD1.
- The rudder and airbrakes are still fused into the airframe.
- Ladder rungs can still cross a target label (rungs are not treated as areas to keep
  clear).
