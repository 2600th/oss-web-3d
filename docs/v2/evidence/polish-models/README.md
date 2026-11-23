# Models polish: pilot, nav lights, model audit

This covers three things on branch `worktree-agent-affbb2480b9686f56`:

- a pilot in the cockpit;
- the green nav light floating above the fuselage;
- an audit of the ground units, the weapons, and their destroyed and LOD1
  variants.

Everything below is built by scripts in `tools/blender/`, run with Blender 5.2
from the command line:

```
blender -b --factory-startup --python tools/blender/build_pilot.py
blender -b --factory-startup --python tools/blender/build_assets.py -- <ids>
node tools/blender/write-catalog.mjs
```

The thumbnails come from `tools/blender/render_thumbs.py`. The in-game shots
were taken in Chrome with WebGPU, quality `high`, at 2560 x 949.

## 1. Pilot

| | |
|---|---|
| Asset | `public/models/pilot.glb`: 11,562 triangles, 281.7 KB. `pilot_lod1.glb`: 1,845 triangles, 62.2 KB. Texture atlas 512 px (128 px at LOD1). |
| Source | `tools/blender/build_pilot.py`, which uses the same kit as the ground units. |
| Gear | Helmet with the visor down and tinted, oxygen mask and hose, sage flight suit with seams, harness and lap belt, gloves, boots, kneeboard. There are no insignia, names or patches. |
| Fit | Measured against `mig21.glb` by `tools/blender/probe_cockpit.py`: seat cushion, seat back, canopy clearance, stick grip and throttle. The eye is at (0, 0.22, -2.95) in aircraft space. The right hand is on the stick grip and the left on the throttle. The helmet stays below the canopy glass, which the probe found 0.40-0.43 m above the head line. |
| Runtime | `src/assets/system.js` parents LOD0 to the player's aircraft model. `PilotRig` (`src/assets/pilot.js`) turns the head toward the locked target or the nearest bandit within 2.5 km, otherwise into the turn. The head yaw limit is 75°, it looks up 24° and down 13°, and the turn rate is capped at 2.6 rad/s. The head node is hidden in the `cockpit` and `hud` views, so the camera never sees the inside of the head. |
| Hostiles | The pilot LOD1 rides in `mig21_hostile`, and `hostileFighterModel()` now uses a `THREE.LOD`. `mig21_hostile_lod1` takes over at 600 m. Before this change that file existed but was never used. A hostile beyond 600 m now draws about 207k fewer triangles. |
| GPU | A/B test toggling the pilot's visibility in a close chase view at high quality, 2560 x 949: **+0.016 ms**, against a scene pass of about 0.4 ms. The budget is +0.3 ms. |

Screenshots:

- `before-cockpit-close.jpeg`: the empty seat.
- `after-pilot-close-side.jpeg`.
- `after-pilot-head-tracks-lock.jpeg`: the head turned toward a locked bandit.
- `after-cockpit-look-down.jpeg`: the cockpit view. The body is visible and
  there is no head.
- `after-hostile-pilot-lod1.jpeg`.

## 2. Green nav light floating above the fuselage

**Cause.** The light positions were a bounding-box guess, not the mesh's lamps.
`attachNavLights` placed:

- the wing lights at (±3.52, -0.05, 1.6), 0.7 m above and ahead of the real
  lenses;
- the spine beacon 0.55 m above the skin;
- the belly strobe inside the fuselage;
- the tail light above the fin.

The sprites are additive and depth-tested only at their centre. So the
starboard (green) light, hanging in the air above the spine, showed through
from behind in the chase view. At night the far-side halo also spilled over the
fuselage outline even when its centre was hidden.

**Fix.**

- `tools/blender/probe_lamps.py` measures the lens islands on the decoded MiG.
  They are at (±2.81, -0.746, 1.42) in the wing leading edge, with the tail
  lens at (0, 1.70, 7.64). These values are now `MIG21_LAMPS` in
  `src/world/timeofday/lights/fixtures.js`.
- Each lamp gets an emission lobe (new `dir` / `cone` options in
  `LightSprites`):
  - the wing lights shine outward and forward;
  - the tail light shines aft;
  - the beacon shines up and the belly strobe down.

  The far-side lamp can no longer bleed across the airframe.
- By day the nav lights are a small dim point (`daySize 0.25`, `day 0.12`).
  The strobes and beacon still flash visibly (`day 0.6`).
- The MiG wingtip sockets, used by the wingtip vortices, had the same error.
  They now sit on the real tips at (±3.64, -0.777, 2.74).
- Hostile jets use the same `attachNavLights` defaults, so they are fixed too.

Screenshots:

- `before-navlights-day-close.jpeg`.
- `after-navlights-day-close.jpeg` and `after-navlights-day-right.jpeg`.
- `after-navlights-night.jpeg`.

## 3. Model audit

Each model was checked against references for:

- real dimensions;
- silhouette, bevels and smoothing;
- missing parts;
- destroyed variants;
- pivot and ground contact;
- LOD.

Before/after thumbnails are in `models-before-after-1.jpg` and
`models-before-after-2.jpg`. Each pair is shown at the same framing, so a change
in size shows up as a change in framing.

### Findings and fixes

| Model | Finding | Fix |
|---|---|---|
| All wheeled units | Wheels were flat-sided cylinders with a painted disc: "hockey pucks" in a strafing pass. | `wheel()` is now a lathed tyre: rounded shoulders, dished rim, steel hub caps both sides, and staggered cross-country lugs. Track road wheels pass `tread=False`. Affects truck x3, radar x2, AAA gun x2, artillery x2, SAM launcher x2 and helicopter. |
| `truck`, `truck_covered`, `truck_destroyed` | Overall width 3.10 m against the Ural-4320's 2.50 m. The cab steps stuck out to x ±1.55. Tyres were 1.08 m against 1.22 m for 14.00-20. The exhaust stack rose to 3.1 m, above the cab roof. There was no grille. | Tyres r 0.61. Steps moved inboard (two treads, x ±1.06). Mirrors are thin heads on arms. The exhaust stack is 0.9 m with a heat shield (top 2.65 m, socket `exhaust` moved with it). Nine radiator grille slats and tow hooks added. Width is now **2.57 m** (mirrors included), length 7.69 m, height 2.73 m (3.08 m with the tilt). |
| `radar`, `radar_destroyed` | The reflector was a square grid, so its outline had corners 0.65 m deep: a scoop, not a dish. It was also tilted 12° **down** while the feed sat 12° **up**, so the feed was off the reflector's axis. The IFF bar floated above the rim. | The reflector is now an elliptical cut (2.4 x 1.3 m) of a paraboloid of revolution with f = 1.1 m. It is aimed 12° up, with the feed horn at the focus on its axis. Feed struts start on the shell. Three bent back ribs follow the shell, and the IFF bar sits on the rim. |
| `sangar` | Sandbags floated 15 cm above the stone wall. The wall is 4 courses of 0.22 m (top 0.88 m), but the bags sat at 1.12 m. This was flagged by the texture agent. | The bags are bedded 2 cm into the top course. |
| `bomb` | The game fires a **FAB-250**, but the model was FAB-500 sized (2.47 x 0.40 m) with an M-54-style ring tail. | The model is now FAB-250 M-62 sized: **1.92 x 0.30 m**, a low-drag ogive and four swept fins with no ring. It has suspension lugs and nose and tail fuzes. Socket names are unchanged. |
| Foundation berms (runtime) | A fixed 4700-4950 m snow band painted berms white on bare ground and left them brown on snowfields. This was flagged by the texture agent. Before: `before-berm-snow-bare-site.jpeg`. | `siteSnow()` in `src/assets/system.js` mirrors the terrain material's snow terms per site: altitude, a line moved by aspect and DEM curvature, detail height, and slope shedding. Each berm carries the result as an attribute. See `after-berm-snow-bare-site.jpeg` (bare ground, no white pad) and `after-berm-snow-snowy-site-sangar.jpeg` (snowfield, snowy berm). |

### Checked, no change needed

| Model | Result |
|---|---|
| `aam_ir` (R-60-class) | 2.09 m long, 0.385 m fin span in an X pattern. Fine. |
| `aam_hobs` (R-73-class) | Span 0.54 m, with canards and rollerons. Fine. |
| `aam_long` (R-77-class) | Lattice tail fins present. Fine. |
| `rocket_pod` / `rocket` | B-8-class pod: 2.75 m, 20 tubes. S-8-class rocket: 1.57 m. Fine. |
| `aaa_gun` (ZU-23-2-like) | Barrels are about 2.0 m, matching the reference 2.008 m. Width in firing position is 2.37 m against 2.88 m. **Minor; left as is.** It reads correctly at game distances, and widening the outriggers would change the foundation footprint. |
| Ground contact | Every unit's baked minimum Y is between -2 cm and +1 cm (`sam_launcher` +1 cm), or further below 0 where wreck debris sinks in. No baked geometry floats. The "units slightly above ground in a lineup" report is a runtime seating effect, not geometry: `seatUnit` (`src/assets/unitRig.js`) seats vehicles at 65% of the corner relief, so on uneven ground the low corners hang by up to 0.65 x relief. I left this alone because that file is outside this task's ownership. A berm is added only above 0.15 m of overhang. |
| Destroyed variants | The radar and truck wrecks tilt, scatter debris and are burnt. The new wheels carry through to them. |
| Pivots and sockets | Every `turret` / `barrels` / `dish` / `launcher` pivot sits on its bearing. The sockets moved with the geometry: truck `exhaust`, radar `feed`, bomb `tail` / `fuze`. |

### LOD

- **Ground units only ever load LOD0**, because `tryLoadModel` in
  `src/combat/visuals.js` and the unit loaders pass no `lod`. The `*_lod1.glb`
  files ship but are never used.
  - There is no LOD pop, because there is no LOD switch.
  - The files are about 2.9 MB of dead weight (all ground-unit LOD1 files).
  - Using them would need turret, barrel and launcher pose sync between levels.
    This is a recommendation only.
- **Hostile MiG:** LOD1 is now used, switching at 600 m with 10% hysteresis. At
  600 m the 7 m wingspan covers about 1% of the screen width at a 60° field
  of view. LOD1 shares the LOD0 silhouette and atlas. The switch was not
  checked frame by frame for pop.

### Triangle and byte deltas

| Asset | Triangles LOD0 / LOD1 | Bytes LOD0 / LOD1 |
|---|---|---|
| pilot (new) | 11,562 / 1,845 | 281,700 / 62,224 |
| truck | 2,328 / 1,164 → 7,836 / 3,918 | 228,644 / 117,032 → 501,140 / 249,244 |
| truck_covered | 2,008 / 1,004 → 7,516 / 3,758 | 203,268 / 103,404 → 480,540 / 238,748 |
| truck_destroyed | 2,284 / 1,142 → 7,100 / 3,550 | 142,152 / 72,508 → 210,508 / 121,100 |
| radar | 1,944 / 972 → 4,600 / 2,300 | 177,360 / 84,780 → 351,036 / 176,072 |
| radar_destroyed | 2,088 / 1,044 → 4,744 / 2,372 | 136,220 / 67,660 → 213,108 / 111,412 |
| aaa_gun | 1,844 / 922 → 2,900 / 1,450 | 203,152 / 100,088 → 266,740 / 133,664 |
| aaa_gun_destroyed | 1,768 / 884 → 2,824 / 1,412 | 145,892 / 74,072 → 185,056 / 91,560 |
| artillery | 1,140 / 570 → 2,372 / 1,186 | 157,804 / 76,852 → 254,776 / 124,876 |
| artillery_destroyed | 1,072 / 536 → 1,688 / 844 | 115,768 / 58,904 → 146,300 / 71,764 |
| sam_launcher | 3,504 / 1,752 → 6,624 / 3,312 | 271,592 / 139,276 → 309,124 / 167,352 |
| sam_launcher_destroyed | 3,592 / 1,796 → 6,712 / 3,356 | 187,852 / 96,532 → 230,812 / 121,656 |
| helicopter (unused in game) | 1,550 / 782 → 2,966 / 1,490 | 180,700 / 83,028 → 244,756 / 118,824 |
| sangar | 5,660 / 2,830 (same) | 412,220 / 223,096 → 411,172 / 223,412 |
| bomb | 708 → 764 | 49,536 → 54,080 |

The added triangles come almost entirely from the tread lugs. The largest unit
is still under 8k triangles, and a mission shows a few dozen units at most.

### GPU cost

| Change | Cost |
|---|---|
| Pilot | +0.016 ms, measured. |
| Hostile LOD | A saving beyond 600 m. |
| Ground-unit triangles | About +5k triangles per vehicle. Not measured separately; a six-truck convoy adds about 30k triangles, small next to the 207k of one near hostile jet. |
| Berm snow | One extra vertex attribute; no shader cost change. |

Total: well inside the +0.3 ms budget at high 1440p.

## References

- Ural-4320: 7,366 x 2,500 x 2,715 mm (3,005 mm with tilt), 14.00-20 tyres.
  https://en.wikipedia.org/wiki/Ural-4320
- ZU-23-2: 4.57 x 2.88 x 1.22 m in firing position, barrel 2.008 m.
  https://en.wikipedia.org/wiki/ZU-23-2
- FAB-250 family (M-54 / M-62): FAB-250 M-62 is 1.92 m long with a 0.30 m
  body. https://en.wikipedia.org/wiki/FAB-250
- Paraboloid reflector geometry (focus at r² / 4f):
  https://en.wikipedia.org/wiki/Parabolic_reflector
- MiG-21 navigation light layout (red port, green starboard and white tail) is
  read from the shipped mesh's lens islands, not from an external drawing.

No asset was copied from, or modelled after, any specific game.

## Open items

- The ground-unit `*_lod1.glb` files are unused at runtime (see LOD).
- `seatUnit` hangs vehicle corners on uneven ground (see Ground contact). It is
  in `src/assets/unitRig.js`, outside this task.
- The `aaa_gun` firing-position width is 2.37 m against the real 2.88 m.
- The `helicopter` fuselage is small for its rotor. It is unused in game, so it
  is reported only.
- I saw a `Clouds.js:913` "reading 'boundingSphere'" error flood once, after a
  hostile close-up in an old tab. That tab then hung. The same steps in a fresh
  tab were clean, so I could not reproduce it.
- `siteSnow` mirrors the terrain's snow formula. If `material.js` changes it,
  update `siteSnow` to match. The macro mask and fall-line streak terms are not
  reproduced, so a berm right on the line can still disagree slightly.
