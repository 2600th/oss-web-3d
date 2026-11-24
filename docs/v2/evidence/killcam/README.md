# Kill cam

The kill cam after the redo. It has two kinds of shot:

- **Projectile cam.** This is the rare one, for special kills. The camera rides the
  killing missile or rocket in slow motion. Close to the target it lets the
  projectile go and nearly freezes the last metres. At detonation it cuts under
  the flash, runs time through the flash, swings round the target as it breaks
  up, and flies away back to the player.
- **Fast shot.** Most kills get this one. An air kill cuts to a close angle on the
  stricken jet; the angle varies from kill to kill. A ground kill gets a short
  orbit of the wreck.

Code: `src/camera/killCam.js` (pure maths, tested in `killcam.test.mjs`),
`src/camera/killSequence.js` (camera work), `src/camera/wreckProxy.js` (the
stricken airframe), `src/camera/system.js` (when the shots trigger) and
`src/flight/CameraRig.js` (API, hand-back).

## How the footage was made

Every clip is frame-exact (`window.__capture.record`, 30 fps, 1920 x 1080 at
DPR 1, `high` tier, WebGPU). The scenarios are in `src/camera/dev.js`:

- `__camTest('kill', {angle})`
- `__camTest('killMissile', {weapon, range, off, turn})`
- `__camTest('killGround', {type, weapon, shot})`

All of them take `defer: true`, which returns `go()` so the shot can fire on a
chosen frame. The projectile cam is forced in these scenarios (`forceProjectile`
skips the chance roll). The target's health is set so that one hit kills.

The contact sheets label each frame with its index and its real time; the
footage runs at 30 fps of real time. The HUD is a separate canvas, so it is not
in the captures. The live screenshots show it.

## Sheets

| file | what |
| --- | --- |
| `sheet-air-lowSide.jpg` | Fast air shot, low-side angle: under the wing line, looking up at the belly. |
| `sheet-air-frontQuarter.jpg` | Fast air shot, front three-quarter: the burning jet rolls toward the lens. |
| `sheet-air-topDown.jpg` | Fast air shot, top-down: the lens climbs and the wreck rolls away below. |
| `sheet-air-debris.jpg` | Fast air shot, fly-through-debris: from behind the burst, up past the wing. |
| `sheet-air-projectile.jpg` | Projectile cam on an R-60 in a tail chase. |
| `sheet-air-projectile-offboresight.jpg` | Projectile cam on an R-73 off the beam, a high-off-boresight shot. |
| `sheet-ground-projectile-missile.jpg` | Projectile cam on a missile into a truck. |
| `sheet-ground-projectile-rockets.jpg` | Projectile cam on an S-8 rocket into a sangar. Rockets are unguided; the camera predicts the impact from the straight line. |
| `sheet-ground-orbit-sangar.jpg`, `sheet-ground-orbit-truck.jpg` | Fast ground shot: an orbit of the wreck. |
| `sheet-reduced-air.jpg`, `sheet-reduced-missile.jpg`, `sheet-reduced-ground.jpg` | `reducedMotion` on: a held, real-time look from the player's side, then a plain cut back. There is no slow motion, no swing and no shake, and no projectile cam even when one is forced. |

Stills (1600 px):

- `still-projectile-ride.jpg`
- `still-impact-breakup.jpg`
- `still-impact-swing.jpg`
- `still-ground-release.jpg`
- `still-ground-swing.jpg`
- `still-air-debris.jpg`
- `still-air-frontQuarter.jpg`
- `still-air-lowSide-live.jpg`, a live screenshot with the HUD hidden.
- `before-hud-over-killcam.jpg`, a live screenshot taken before the HUD change. It shows the pilot's instruments and the `SPLASH +400` points drawn over the kill cam.

## Measured (logged per frame during the captures)

| clip | real time on the kill cam | min time scale | closest lens to target | closest lens to player jet | lowest lens AGL |
| --- | --- | --- | --- | --- | --- |
| air, four fast angles | 1.87 s (56 frames) | 0.45 | 17.6 m (debris), 26.6-29.8 m (others) | 639 m | 1861 m |
| air projectile (R-60) | 2.70 s (81 frames) | 0.10 | 38 m | 1092 m | 1926 m |
| air projectile (R-73, off-boresight) | 2.70 s | 0.10 | 38 m | 587 m | 1819 m |
| ground projectile (missile, truck) | 2.87 s (86 frames) | 0.08 | 40 m | 1564 m | 21 m |
| ground projectile (rocket, sangar) | 2.93 s (88 frames) | 0.07 | 38 m | 1406 m | 24 m |
| ground orbit | 2.10 s (63 frames) | 0.35 | 71 m | 2218 m | 45 m |
| reduced motion | 1.30 s (39 frames) | 1.00 | 71-78 m | 631 m | 61 m |

After each shot the chase view springs in for about 0.5 s more. With a
blend instead (the player within 260 m of the lens) it is 0.55 s. The keep-out
spheres are: the airframe 13 m, a ground target 1.6 x its radius, the player's
jet 13 m, and the fireball 22-45 m by blast size. I checked every sheet frame
by eye. None shows the lens inside the terrain, an airframe or a vehicle.

Checked in the live game as well:

- Pressing the gun key during the projectile cam ends it at once (`end:skip`),
  and time comes back over 0.2 s.
- A hostile missile launched at the player mid-shot ends it the same frame
  (`end:danger`).
- With the kill-cam setting off, nothing runs.
- A second kill during a shot, and a third 1.2 s after it ended, are both
  refused (cooldown 5 s).

## Tone

- The stricken airframe is the hostile's own model. It is unmarked, and its
  pilot figure is hidden.
- No crew is shown at any point.
- No text, names or points are added. The HUD canvas, which carries the score and
  the `SPLASH +points` callout, is hidden while the kill cam is on screen.

## Not verified / weaker than wanted

- Every air kill here was filmed at about 1.9 km AGL. The terrain and
  line-of-sight clamps were exercised only by the ground kills. The low-side
  angle is never picked within 90 m of the ground.
- The projectile cam on a steep ground attack looks down at the ground most of
  the way. There is no horizon in frame until the swing lowers the lens.
- Seen from behind, the R-60's motor plume is very bright and fills the lower
  third of the frame for the first ~0.3 s of the ride.
- Ground orbits of `large` blasts (sangars) spend a lot of the shot in smoke.
- The sequences were tuned on the `high` tier and WebGPU only. The low tier
  and WebGL2 were not filmed.
- No audio was built. The `camera:killcam` events, including the `impact`
  phase with its `thump` low-pass parameters, are not consumed by the audio
  system yet.
