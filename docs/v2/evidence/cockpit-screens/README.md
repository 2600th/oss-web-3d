# Cockpit screens: before / after

The five emissive display faces of the first-person overlay
(`public/models/mig21_cockpit.glb`), rebuilt so each lies on its painted glass
and the amber readouts read as lines of text.

## What was wrong

None of the five was rotated 90 degrees or mirrored in its UVs. Seen from the
design eye every texture was already the right way up and the right way round.
The text looked rotated for two other reasons, and three of the faces were not
on their panel.

| Face | Before | After |
| --- | --- | --- |
| `aux_screen_l`, `aux_screen_r` (beside the gunsight) | On the right panel face, UVs correct. A parallelogram leaning 10 degrees (top edge 5 mm off), so the white painted glass showed along two edges. The readout had 1 unit between lines and 27 between characters, stretched 1.55x tall on a 19 x 30 mm face: at about 45 px wide the digits fused into four columns and read top to bottom. | Upright 21 x 34 mm rectangle covering the painted glass with 1 mm to spare. Six lines of four characters, drawn for this shape: characters closer together than lines, a faint rule between lines. |
| `aux_screen_c` (left of the stick) | One of its three corner picks hit the stick grip, not the panel. The face ran from the panel across to the grip, facing left, with its digit rows running up and back. | Upright 73.5 mm square on its painted glass, showing the top four lines. The grip still hides its right half from the design eye, as it hides that part of the panel. |
| `mfd_screen` (radar) | One corner pick hit the stick grip. The face lay 72 degrees off the panel like a shelf, lower edge 9.8 cm towards the pilot. Upright and unmirrored, but it floated in front of its bezel and swam against it as the head moved. | 130 x 126 mm rectangle on the painted glass, inside the button rows. |
| `aux_screen_tr` (right of the gunsight) | On its panel, upright, unmirrored. A parallelogram leaning 11 degrees, and 18 x 11 mm smaller than its painted glass. | 62.5 x 61 mm rectangle on the painted glass. The gunsight box hides its left edge from the design eye. |

All five now stand 2 mm in front of their panel face. Nothing in the cockpit
model comes within 1 cm in front of any of them (the build stops if it does),
so nothing pokes through and nothing fights for depth.

## Cause and fix

`tools/blender/build_cockpit.py` built each face from three pixels picked on a
reference render and ray-cast from the eye. The stick stands between the eye
and the panel, and a rectangle in the view is not a rectangle on the panel.

The displays are painted in the cockpit atlas on flat panel faces, so the build
now takes each face from the art itself:

- `tools/blender/probe-cockpit-screens.mjs` maps the rectangle of each painted
  glass through the panel's UVs to model space and prints the `SCREENS` table.
- `build_cockpit.py` finds the panel face behind each rectangle (rays along the
  nose axis, through whatever stands in front) and lays the quad 2 mm proud.
- `tools/blender/upgrade-cockpit-textures.mjs` (`textSVG`) draws the readout
  for the upright gunsight displays.
- `src/assets/cockpitScreens.test.mjs` checks the shipped GLB: upright
  rectangles, texture upright and unmirrored, 1-3 mm off the panel face in
  `mig21.glb`. It fails on the old file.

The GLB was rebuilt with the full pipeline (Blender 5.2, `optimize-glb.mjs`,
`upgrade-cockpit-textures.mjs`): same extensions (meshopt, mesh quantization,
WebP), 132 triangles, 45,644 bytes (was 46,320).

## Sheets

Each sheet is the same pose before (left) and after (right), 1920 x 1080,
`?mission=free&quality=ultra&noadaptive`, HUD canvas hidden, cropped.

| File | Pose |
| --- | --- |
| `01-head-on-fov74.jpg` | Head-on, game FOV 74. |
| `02-look-down-fov74.jpg` | Looking down at the panel. |
| `03-head-left-fov74.jpg`, `04-head-right-fov74.jpg` | Head turned 28 degrees left and right, both gunsight displays still in frame. |
| `05-look-down-limit-fov74.jpg` | Free-look pitch limit, 69 degrees down. |
| `06-gunsight-displays-zoom.jpg`, `07-panel-zoom.jpg` | The same faces with the camera FOV narrowed (26 and 30) to see detail. Not a view the game offers. |
| `08` to `11` | Zoomed, with the eye at two opposite corners of its G and thrust travel (`CameraRig._firstPerson`: 3 cm up and 2 cm forward, 6 cm down and 4 cm back). |
| `12-after-aux-screen-l-closeup.jpg`, `13-after-aux-screen-tr-closeup.jpg` | After only, FOV 10 and 14. |

Head rotation does not move the eye, so it cannot change how a face sits
against its bezel. Only that travel can, which is why sheets 08 to 11 exist.
At the free-look yaw limits (220 degrees either way) and looking up, no display
is in frame.

## Seen while checking, not changed

- `periscope` (same GLB): looking straight up it is a flat grey lozenge 22 cm
  above the eye with no canopy frame around it. It does not clip or fight for
  depth, so it was left alone.
- `pilot.glb`: looking over either shoulder at the yaw limit shows the jagged
  open collar where the pilot's head is hidden in the cockpit view.

## Not verified

- Only the ultra tier on desktop was captured. Other tiers and the phone
  layout use the same GLB.
- Depth fighting was judged from still frames at the poses above and from the
  2 mm clearance, not from footage.
