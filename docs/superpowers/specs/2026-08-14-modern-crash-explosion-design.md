# Modern Terrain-Impact Explosion Design

## Goal

Make an aircraft collision with terrain read immediately as a modern, grounded combat-flight impact: a short white-hot ignition, directional blast and ejecta, a terrain-following pressure front, then fuel fire and smoke. The effect must remain restrained enough for the fictional reconnaissance tone and must not become a full-screen arcade fireball.

## Current failure

The crash event is dispatched once, but the visual data reaching it is incomplete and much of the result is depth-faded away:

- `FlightModel` zeroes velocity before `FlightFx.crash()` receives the flight object, removing directional impact energy.
- Impact fire and smoke use the shared 40 m soft-depth fade while originating only a few metres above terrain.
- The fireball is one unstructured soft-particle burst with no coherent blast front.
- The intact aircraft and afterburner remain visible during the 2.1 second crash hold.
- Existing tests assert particle cursor writes, not visible explosion behavior.

## Chosen presentation

Use a staged, terrain-aware explosion built on the existing GPU particle foundation:

1. **Impact flash, 0-140 ms**
   - White-hot amber core, visible on the first rendered crash frame.
   - Small reusable non-shadow-casting point light with a 120 m maximum range and 350 ms exponential decay.
   - Restrained exposure/lens impulse; never a full-screen whiteout.
2. **Blast development, 80-900 ms**
   - Lobed orange fuel-fire expansion.
   - One reusable terrain-normal shockwave ring, maximum one additional draw call.
   - Directional sparks, metallic fragments and terrain dust based on reflected/tangential impact velocity.
3. **Aftermath, 500-8,000 ms**
   - Rising dark smoke with warmer internal fire during the crash hold.
   - Wind and turbulence continue through the existing shared frame uniforms.
   - Intact afterburner is extinguished immediately. The pristine aircraft is hidden or visually swallowed during the initial blast and is restored on sortie launch/reset.

No persistent scorch decal or simulated aircraft fracture is included in this scope. Both require additional terrain ownership, collision and lifecycle systems disproportionate to the 2.1 second crash presentation.

## Data and ownership

- `FlightModel` records stable `impactVelocity` and `impactNormal` before stopping the aircraft. The normal is derived deterministically from the shared terrain height function around `impactPoint`.
- `Game.onCrash()` dispatches one immutable impact snapshot/contract to `FlightFx`; repeated crash frames cannot re-emit the explosion.
- `FlightFx` owns all impact particles, the flash light and the reusable shockwave mesh. No steady-state object or GPU-resource allocations occur after construction.
- Fire uses a 4 m soft-fade distance; smoke uses 10 m. Hardware depth testing remains enabled so terrain still occludes the rear of the burst.
- `Aircraft` receives an explicit crashed presentation state that disables exhaust/reheat and is reset on launch.
- Existing heat distortion, camera shake and impact audio remain the post/audio owners. Reduced-motion settings attenuate shake and distortion, not the essential visual cue.

## Quality tiers

- High and Medium: full staged fire, light, smoke, sparks, terrain dust and debris; shock ring uses 96 and 72 segments respectively.
- Low: reduced particle counts and a 48-segment ring; no reliance on bloom or heat distortion for readability.
- Phone: bounded flash core, a 32-segment compact ring, smoke and a small spark/debris burst. The explosion remains recognizable with bloom and heat distortion disabled.
- Existing particle capacities remain hard ceilings; hitch overflow is dropped rather than replayed.

## Upstream VFX reuse

The previously shared `LinearAbiltyCastingThreeJS` source is pinned at commit `f9ba4f91bfa1506b98f5f3cf801b80a975d7dd1a` (MIT, copyright 2026 mohamedachrefelouafi). The project already adapts its particle system, rate emitter, frame uniforms, noise helpers and camera-facing ribbon construction.

Only these additional ideas are adapted:

- `BurstSphere`'s noise-displaced, dissolving expanding shell becomes one prewarmed GLSL3 impact shell.
- `GroundDecals` contributes only its age-to-radius shockwave profile; the flat plane implementation is not copied.
- `LightPool` contributes the precreated zero-intensity light pattern, reduced to one no-shadow impact light.
- `MeteorAbility` informs the staged sequencing, not its ability framework.

The upstream `VolumetricFireMaterial`, lightning/ribbons, generic object pools, particle engine, camera shake and screen-flash classes are not copied. Existing notices are expanded to identify the impact shell and shockwave adaptation; the full MIT text remains in the shipped distribution.

## Acceptance gates

- Collision emits exactly once and the fire core appears on the first rendered crash frame.
- Frontal and glancing impacts produce measurably different ejecta directions.
- No live afterburner or pristine aircraft remains readable through the initial blast.
- Rear fire, smoke and debris remain terrain-occluded without the entire terrain-contact effect fading out.
- Peak fireball diameter stays below 35% of the shorter viewport dimension.
- The transition from fire to smoke remains readable throughout the 2.1 second crash hold.
- Browser captures at the nearest rendered frame to 0, 100, 300, 800 and 1,800 ms (within one 60 Hz frame) pass at 1920x1080 High and 390x844 Phone.
- Console contains no shader, WebGL or lifecycle warnings.
- Focused tests cover impact velocity/normal preservation, one-shot dispatch, tier caps, soft-depth configuration, reset behavior, directional spread, shockwave/light disposal and bounded coverage.
- Complete test suite, GLSL check and production build pass.
