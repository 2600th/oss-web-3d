# Speed Presence and Assisted Controls Design

## Objective

Make the opening sortie immediately communicate altitude, weather, and speed while making the aircraft easy to steer on keyboard, gamepad, and touch. Preserve the existing physical flight simulation and expose its current direct-axis behavior as an optional advanced mode.

## Diagnosed Problems

- The authored launch corridor removes cloud density from most of the opening camera frustum for 12–16.5 km. The cloud renderer is active, but recognizable banks may not enter the view for roughly the first minute.
- Speed streaks are spawned in a large sphere, mostly outside the useful view volume. Their projected width is subpixel at normal resolutions and their opacity is too low to survive postprocessing.
- Opening-speed FOV is only about 62 degrees from a 58-degree base. Moving the chase camera farther away at speed partially cancels the visual change.
- The directional motion-blur effect derives direction only from camera rotation. Straight-line speed raises blur amount without producing a sampling offset, so it creates no visible blur.
- The default controls expose raw pitch, roll, yaw, and throttle. A basic turn requires banking, pulling, and counter-rolling. Digital roll is much faster than pitch, input and body-rate smoothing compound into overshoot, touch semantics contradict their documentation, and recon magnification amplifies every correction.

## Experience Design

### Cloud Composition

Retain a readable central terrain route, but replace the long widening empty corridor with a shorter, narrower opening window. Author coherent lateral cloud banks inside the first 3–8 km of the visible route. At least one bank must have a readable crown, shaded base, and silhouette against the sky. Do not solve visibility by globally raising density or extinction.

Targets at the opening high-quality view:

- 15–35% of the composed frame has cloud alpha above 0.15.
- The central 8–10 degrees remain readable for terrain navigation.
- No continuous bank spans more than 35% of the horizontal view.
- Low and phone retain recognizable bank silhouettes with reduced detail, not merely pale haze.

### Speed Streaks

Spawn particles inside a camera-oriented frustum or annular view volume rather than an isotropic world-space sphere. Generate geometry with guaranteed projected coverage before tuning alpha.

Targets at 720p:

- Major axis: 6–18 px.
- Core width: 0.75–1.5 px.
- Peak alpha: 0.12–0.25.
- High tier after 0.5 seconds at opening speed: at least 12 visible streaks.
- Phone tier under the same conditions: at least 4 visible streaks.
- No persistent canopy-scratch lines or streaks crossing most of the frame.

Existing tier capacity limits remain strict.

### Dynamic FOV

Keep the 58-degree base FOV and move the useful response into the normal sortie speed range. Use a bounded, smoothed speed curve over approximately 120–420 m/s with a maximum boost near 16 degrees.

Expected settled values:

- 200 m/s: 63–64 degrees.
- 235 m/s: 65–66 degrees.
- 260 m/s opening: 66–68 degrees.
- 380 m/s: 71–73 degrees.
- Absolute cap including reheat: 75 degrees.

FOV should settle over roughly 0.3–0.5 seconds, change no faster than 18 degrees per second, and cut explicitly when entering or leaving recon to prevent pumping.

### Peripheral Motion Blur

Add a distinct radial speed component to the existing angular motion blur. Straight flight samples outward from the optical center through an edge mask; camera angular velocity provides a separate directional component normalized by `dt`.

- Central 40–50% radius remains effectively sharp.
- At 720p, opening-speed edge displacement is 1.5–2.5 px.
- At 380 m/s, edge displacement is 2.5–4 px.
- Combined radial and angular displacement is capped at 6 px.
- Recon view and captured plates receive no speed or angular blur.
- `prefers-reduced-motion` disables blur and limits FOV boost to 4–6 degrees.
- DOM HUD and recon symbology remain outside the postprocessed canvas and therefore sharp.

## Assisted Arcade Controls

`assisted` becomes the default control mode. `direct` preserves the existing raw-axis behavior.

Assisted semantic inputs:

- W / Up: climb.
- S / Down: descend.
- A / Left: coordinated turn left.
- D / Right: coordinated turn right.
- Neutral directional input: stabilize flight path and return toward wings-level flight.
- Shift: momentary boost/reheat.
- Ctrl: optional slowdown command.
- Z: airbrake.
- Space: toggle recon.
- Enter: shutter.
- F / V: recon zoom.
- Tab: cycle objective.
- Escape: pause.

The assist controller translates semantic turn and vertical intent into bounded commands for the existing `FlightModel`; it does not replace flight physics.

Initial bounds:

- Maximum commanded bank: 48 degrees.
- Effective roll authority: no more than 35% of current full digital roll rate.
- Maximum climb/dive flight-path target: ±18 degrees.
- From maximum assisted bank, neutral input returns to within ±5 degrees in no more than 1.5 seconds without sustained oscillation.
- Auto-cruise maintains a safe opening-speed regime. Boost temporarily commands reheat and returns to cruise on release.
- Recon applies a lower correction rate so a 100 ms input moves the optical axis by no more than 3 degrees at the default 17-degree recon FOV.

Touch uses the same semantic controller. Horizontal drag means turn, vertical drag means climb or descend, and release means stabilize. Use a radial dead zone and directionally uniform shaping. In assisted mode, replace the mandatory throttle strip with a large momentary Boost control. Direct mode retains the throttle strip.

Gamepad left stick uses turn and climb intent. Triggers modify speed around auto-cruise. Center noise inside the dead zone produces no command.

## Settings and Migration

Persist these additions alongside existing quality, audio, and pitch settings:

- `controlMode`: `assisted` or `direct`.
- `controlSensitivity`: `low`, `normal`, or `high`.
- `autoThrottle`: boolean.
- `verticalMode`: `upToClimb` or `upToDive` for analogue input.

`verticalMode` is the user-facing successor to the existing `invertPitch` boolean; migration derives it from that value and serialization keeps only one authoritative vertical-direction state. Existing saved settings migrate without losing quality, volume, or inversion. Sessions without a control mode default to `assisted`. A one-time notice explains that Assisted Controls are active and Direct remains available under Pause → Flying.

The briefing renders controls for the selected mode and current input modality. It must not show desktop keyboard instructions on touch devices. Existing incorrect pitch/touch descriptions are corrected.

## Architecture

- `Input` continues to normalize device state and exposes semantic intent plus direct axes.
- A dedicated assist controller converts semantic turn/climb/speed intent and current flight state into the existing `FlightModel` control contract.
- `FlightModel` remains the authoritative physics implementation.
- `ChaseCamera` owns the bounded speed-FOV response.
- The post stack owns radial and angular blur; `Game` supplies speed, angular velocity, recon state, and reduced-motion state.
- `FlightFx` owns frustum-aware streak spawning and projected-size parameters.
- The cloud weather model owns the revised opening composition; cloud rendering architecture and tier budgets remain unchanged.
- `Settings`, `Screens`, and `TouchControls` expose and explain the selected control mode.

## Failure and Comfort Behavior

- If reduced-motion is requested, blur is disabled and FOV expansion is limited.
- If the assist controller lacks valid flight state, it emits neutral bounded controls rather than NaN or full deflection.
- Pause, focus loss, visibility loss, restart, and disposal clear held boost, recon, and directional intent.
- Direct mode remains an immediate fallback if assisted behavior is unavailable.
- Quality changes never disable the core control scheme or remove all cloud/streak speed cues.

## Verification

Automated tests will establish red cases before implementation and cover:

- Rendered/projected streak dimensions, visible count, tier budgets, and frustum placement.
- Opening cloud coverage and central-route gap using the production weather functions, plus composited browser captures at high, low, and phone tiers.
- FOV values, smoothing, caps, and frame-rate invariance at 30/60/120 fps.
- Straight-flight radial blur, frame-rate-invariant angular blur, sharp center, recon disablement, and reduced-motion behavior.
- W/S climb/descend semantics and matching UI labels.
- A/D heading change without a simultaneous pitch input.
- Assisted bank cap, release-to-level time, tap precision, safe 30-second neutral flight, and recon correction precision.
- Radial touch dead zone, directionally uniform shaping, release stabilization, and modality-specific instructions.
- Settings migration and exact preservation of Direct mode output.
- Held-input cleanup on pause, blur, restart, and disposal.

Final acceptance requires focused tests, the complete repository suite, GLSL checks, production build, clean console logs, and fresh live captures at desktop high/low plus 390×844 phone. Numeric or source-only checks cannot substitute for visual approval of clouds, streaks, FOV, or peripheral blur.
