# VFX audit (before state)

This was a read-only audit of every effect against modern AAA arcade-flight quality. The screenshots in this folder show the state before any fixes.

**Verdict:** the architecture is good: GPU compute pools, six-way-lit smoke, ray-marched trail tubes, and lights and heat haze wired through. The tuning and a few shading choices keep most effects below the bar. Only the aircraft-kill sequence about 4 s after the blast (`32_aircraft_kill_4.7s_wrecks.jpeg`), gun impacts on the ground and canopy water come close.

## Bugs

- **Muzzle flash is never visible.** It spawns inside the fuselage at gun socket (0, -0.6, -2.5), so only its point light shows, which lights the pylons white (`28`).
- **Tracers start at the nose-cone tip.** Combat spawns bullets 7 m forward (`_updateGun` in `src/combat/system.js`). At 30 rounds/s with a 1/42 s shutter they read as a continuous laser beam.
- **Ribbon segments that cross or sit behind the camera** render as huge translucent wedges with banded rings (`41`).
- **Ribbon joint caps** show stacked-disc ("slinky") seams when seen end-on (`23`).
- **The afterburner plume vanishes from dead six.** Its emission is weighted by `facing`, which is about 0 end-on. In daylight it is a faint ghost (`21`).
- **Missile trails have glowing "measles" dots and a peach tint.** `L.shed` spawns with heat 1.6–2.5 and a slow heat decay (`34`, `42`).
- **Burning-aircraft soot is beaded and clumped** because emission is per second, not per metre travelled (`30`).
- **Low-tier bloom bands** in concentric rings around bright flashes.

## Ranked fixes

Ranked by visual impact per effort.

1. **Fire turns pink and peach.**
   - Cause: fire is added on top of bright lit smoke.
   - Fix: multiply the lit term by `(1 - 0.85*saturate(heat))`. Use a blackbody temperature ramp in `fireRamp` (`src/vfx/core/shared.js`). Lower the smoke albedo to about 0.04–0.06 in `Explosions.explode`.
2. **Missile-trail dots and tint.** Set the shed-puff heat to 0, or raise `L.shed.heatDecay` to about 25 (`Emitters.missile`, `_updateMissiles`).
3. **Ribbon near-plane clip.** In the `Ribbons.js` vertex stage, clip segment endpoints to z = -near and cull segments behind the camera. Fade by camera-to-segment distance over the radius.
4. **Ribbon joint seams.** Light at the chord midpoint, not with the wall normal, when the ray enters through a joint plane (`Ribbons._material`).
5. **Afterburner plume** (`Shells._plume`).
   - Use analytic ray–cone chord emission, so the plume is brightest end-on.
   - Add 4–5 chord-integrated Mach-disk ellipsoids.
   - Raise the HDR core to 30–80, blue-white grading to orange.
   - Colour the nozzle interior as an orange flameholder.
6. **Fireball structure.**
   - Hot puffs go central and slow; a delayed smoke shell goes outside.
   - Use more, smaller core puffs; scale size by 1/sqrt(rate) on low.
   - Flash 0.06 s, growing 1.5R → 3R.
   - Longer term: a baked flipbook with motion vectors and an emissive channel.
7. **Gun origin, muzzle flash and tracers.**
   - Measure the gun muzzle on `mig21.glb` and use one socket for both combat and VFX.
   - Tracer shutter about 1/90 s with a brighter head.
8. **Burning trails.** Emit per metre travelled (spacing about 0.35 × size). Velocity-stretch the soot and lower its heat (`Emitters._burn`, `_updateDamage`).
9. **Ground blast and fire columns.**
   - Dark dust albedo 0.12–0.18, dirt spikes and falling clumps.
   - Columns: wind coupling ramps with age, stronger initial rise.
   - A scorch-decal ring buffer sampled by the terrain material.
10. **Flak and lightning.**
    - Flak: overlapping crisp puffs, 6–10 dark fragment streaks, life 15–25 s.
    - Lightning: a branching bolt mesh (midpoint displacement, additive capsules, 80–200 ms, restrikes) driven by `weather:lightning`.

## Further items

- **Explosion smoke** is too light and too short-lived for large blasts; life should scale with size, 30–60 s for large.
- **Shock ring** reads as a lens halo. Drop it or make it faint, strengthen the refraction pulse, and add a condensation shell only in humid air.
- **Debris trails** are uniform beige tubes. Make them dark and tapered with wobble, and give the burning heads more size.
- **Missile motor** needs a stretched core flame sprite (3–5 m) when seen close up.
- **Contrails** form a periodic corkscrew; they should be a clean line that spreads.
- **Flare smoke** should be about 1.2 m radius with growth.
- **Rain** reads as warp-speed lines. Shorten the shutter, keep a minimum width with conserved energy, use non-additive grey, and add rain curtains.
- **Canopy water:** advect the drops by airspeed so they stream into rivulets.
- **Cloud fly-through** is featureless grey: raise wisp alpha to about 0.2 and drive it from the cloud density.
- **Particle atlas** is static with 192 px cells: use a larger or animated flipbook.
- **Suspected, not proven:** the VFX layer is composited before TAA and motion blur and has no velocity, which may explain the dotted rain and cloud streaks. Try a reactive mask, or give particles their own velocity.

## References

- Six-way lighting:
  - <https://unity.com/blog/engine-platform/realistic-smoke-with-6-way-lighting-in-vfx-graph>
  - <https://docs.unity3d.com/Packages/com.unity.visualeffectgraph@17.6/manual/six-way-lighting.html>
- Layered and flipbook explosions:
  - <https://realtimevfx.com/t/star-citizen-explosion-vfx-breakdown/632/5>
  - <https://80.lv/articles/vfx-of-star-citizen-working-on-explosions/>
  - <https://simonschreibt.de/gat/battlefront-ii-layered-explosion/>
  - <https://loronsodev.github.io/posts/explosion-fx>
- Shock diamonds:
  - <https://www.nasa.gov/image-detail/nasas-x-59-displays-mach-diamonds-at-maximum-afterburner>
  - <https://theaviationist.com/2020/03/30/watch-shock-diamonds-and-mach-disks-form-in-the-exhaust-plume-of-an-f-15es-engine/>
