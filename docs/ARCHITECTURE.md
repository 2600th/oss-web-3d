# Safed Sagar — architecture

A guide for contributors. It describes the code as it is now. When the code
and this file disagree, the code wins: fix this file in the same change.

## Overview

Safed Sagar is a browser arcade air-combat game. You fly a MiG-21 Bison over
90 x 88 km of real SRTM terrain in the Kargil sector of Ladakh (Drass,
Tololing, Tiger Hill, Batalik). It runs on three.js r187 (`three/webgpu` + TSL),
WebGPU first, with WebGL2 as the fallback backend. Vite builds it.

Creative direction:

- **Fictional**, inspired by Operation Safed Sagar (1999). Enemies are unmarked "hostile forces"; no real people.
- **Respectful.** Remembrance (the memorial screen) is kept apart from score.
- **Original.** Console-style arcade combat, but no names, HUD art, music or levels copied from any game.
- **Look.** Hard high-altitude light, long visibility, volumetric cumulus you can fly through.

## Runtime layout

### Boot and loop

| Step | Where |
| --- | --- |
| Pick backend (WebGPU if an adapter and device are returned, else WebGL2; `?webgl` forces WebGL2), load the DEM in parallel | `src/main.js`, `src/core/BootLifecycle.js` |
| Build `PostFX`, `Game` (world, terrain, player, camera rig, flow) | `src/engine/PostFX.js`, `src/game/Game.js` |
| Load every `src/*/system.js` (via `import.meta.glob`), sorted by `order`, then `game.init()` | `src/main.js` |
| Install perf tools (GPU timing, adaptive resolution) and start `renderer.setAnimationLoop` | `src/engine/Perf.js` |

`Game.update(dt)` runs once per frame:

1. `input.update`, `flow.update` (these still run while paused).
2. Physics at a fixed **120 Hz** (`PHYSICS_STEP`, max 12 steps per frame):
   flight model step, terrain collision, then every system's `fixedUpdate`.
3. Every system's `update`.
4. Camera rig, `env.update` (sky, sun, clouds, weather, clock), `terrain.update`.
5. Every system's `lateUpdate` (HUD, screen-space work, projections).

Then `post.render()` draws the frame. `game.timeScale` scales game time (kill
cam slow motion, dev fast-forward).

### Systems

A system is a file `src/<area>/system.js` that exports `createSystem(game)`
(may be async) and optionally `export const order` (default 100, lower runs
first). Do not edit `main.js` or `Game.js` to plug one in. The returned object
may have `name`, `init`, `fixedUpdate`, `update`, `lateUpdate`, `onCrash`,
`dispose`. It is reachable as `game.systems.<name>`.

| order | name | file | responsibility |
| --- | --- | --- | --- |
| 10 | `atmosphere` | `src/world/system.js` | Aerial perspective and cloud stages in PostFX, exposure reference, cloud shadows on terrain, `weather:lightning` |
| 12 | `timeofday` | `src/timeofday/system.js` | Night sky stages, exposure and grade by time of day, nav lights, headlights and beams, village lights, cloud flashes |
| 15 | `assets` | `src/assets/system.js` | Material upgrades, control surfaces, pilot figure, seating ground units on terrain, turret aim |
| 50 | `combat` | `src/combat/system.js` | Player weapons, lock-on, threat warning, damage (via `CombatWorld`), writes `game.hud` |
| 52 | `missions` | `src/missions/system.js` | Mission scripts, radio, recon, conditions (time and weather), score, results |
| 55 | `ai` | `src/ai/system.js` | Hostile fighters and ground units, attack tokens (only a few shooters at once) |
| 70 | `vfx` | `src/vfx/system.js` | GPU particles, ribbons, tracers, explosions, afterburner, lightning, scorches |
| 80 | `audio` | `src/audio/system.js` | Web Audio graph, SFX, music director, radio voices, warnings |
| 85 | `camera` | `src/camera/system.js` | Camera modes, kill cam, cinematics, screen state and screen water fed to PostFX |
| 90 | `ui` | `src/ui/system.js` | HUD canvas, menus, briefing, debrief, settings, touch controls, rumble |

Core objects that are not systems: `game.env` (`src/world/Environment.js`),
`game.terrain` (`src/world/terrain/Terrain.js`), `game.flight`
(`src/flight/FlightModel.js`), `game.player` (`src/flight/Aircraft.js`),
`game.cameraRig` (`src/flight/CameraRig.js`), `game.flow` (`src/game/Flow.js`),
`game.input` (`src/core/Input.js`), `game.post`, `game.r` (renderer wrapper).

### Flow

`game.flow.state` is one of `boot`, `title`, `select`, `briefing`, `sortie`,
`pause`, `remembrance`, `debrief`. Every change emits `flow:state` and
`ui:screen`. The ui drives it (`openSelect`, `startMission`, `pause`, `retry`,
`quitToMenu`, ...). Flow pauses when the tab is hidden.

Missions (`src/missions/data.js`): `m1` First Light, `m2` River of Stone,
`night` Black Road, `m3` Long Lens, `storm` Thunderhead, `m4` Tiger's Teeth,
`free` Free Flight.

### Render pipeline

- **Renderer** (`src/engine/Renderer.js`): `WebGPURenderer`, reversed depth
  buffer, camera near 0.5 m, far 260 km. Exposes `r.tier`, `r.backend`
  (`'webgpu'` or `'webgl2'`), `r.setRenderScale`, `r.poll()`, `r.onLost`.
- **PostFX** (`src/engine/PostFX.js`, config in `src/fx/post/config.js`):
  scene pass (HDR colour + velocity MRT + depth) → scene stages → TRAA →
  motion blur → depth of field (cinematic views only) → exposure meters → final
  pass (screen water, bloom, lens flare, AgX tone map + grade, vignette, grain).
- **Scene stages** (`post.addSceneStage(fn, order)`, linear HDR): aerial
  perspective 20 (night layer 21), clouds 30 (night layer 31), VFX layer 55,
  heat haze 60.
- **Quality tiers** (`src/engine/Quality.js`): `low`, `medium`, `high`,
  `ultra`. Order of choice: `?quality=`, the saved `tier` setting, then auto
  (`low` on WebGL2 or a coarse pointer, else `high`). A tier change applies on
  reload. Low has no TAA, motion blur or AO and must run on WebGL2.
- **WebGL2 fallback.** Same code path, auto tier `low`. Some features are WebGPU
  only and switch off there (near-field AO; PCSS sun shadows become a fixed
  disc PCF).
- **Device loss.** The loop stops and an overlay offers Reload. A second loss
  on WebGPU offers the WebGL2 compatibility mode. Systems do not handle it.

## Conventions

- **Imports.** `three/webgpu`, TSL from `three/tsl`, addons from `three/addons/...`. No GLSL
  `ShaderMaterial`/`RawShaderMaterial`, no `postprocessing` package: they do not run on `WebGPURenderer`.
- **Units.** Metres, seconds, m/s. HUD headings are compass degrees. `player:hit.damage` is hit
  points (the jet has 100).
- **World frame.** +X east, +Y up, +Z south (north is −Z). Origin is the DEM centre (76.09 E, 34.50 N).
  DEM about ±44.95 x ±44.23 km, heights 2487–5949 m (`public/assets/terrain/dem.json`). Beyond it a
  coarser DEM and procedural mountains continue, so there is no edge.
- **Aircraft model space.** Nose −Z, up +Y, right +X, metres.
- **Light.** Scene colours are linear HDR. Tone mapping happens once, in PostFX.
- **Terrain queries.** Use `src/world/terrain/heightfield.js` (`terrainHeight`, `terrainNormal`,
  `raycastTerrain`, `lineOfSight`, `maxHeightAlong`, `riverEdge`, `isWater`).
- **Events vs direct calls.** Emit on `game.events` to announce what happened (a launch, a kill, a
  screen change). Call `game.systems.<name>`, `game.post` or `game.cameraRig` directly to change
  state. Payloads may hold live entities: copy positions you keep.
- **Quality.** Every expensive feature reads `r.tier` and scales with it.
- **Dev-only code** sits behind `import.meta.env.DEV` (`src/game/dev/`, `src/camera/dev.js`,
  `src/vfx/dev/harness.js`, `src/audio/harness.js`) and is not in the production bundle.
- **Tests.** `node:test` files named `*.test.mjs` next to the code in `src/`. Run `npm test`, and
  `npm run build` before you push.
- **localStorage keys.** `safed-sagar.settings.v3`, `safed-sagar.records.v1`, `safedSagar.audio.v1`,
  `safedsagar.v2.difficulty`, `safedsagar.v2.freeConditions`, `safedsagar.v2.onboarding`.

## Event catalogue (`game.events`)

`events.on(type, fn)` returns an unsubscribe function. `on('*', fn)` receives
`(type, payload)` for everything. Entities are live objects with at least
`{id, position, velocity, alive, team, kind}`. The player's combat entity is
`game.systems.combat.player` (`isPlayer: true`, `id: 'player'`).

| event | payload | emitted by |
| --- | --- | --- |
| `player:respawn` | `{}` | Game |
| `player:crash` | `{position, velocity}` | Game |
| `player:hit` | `{damage, health, source, position, weapon, fraction, severity}` | CombatWorld |
| `player:destroyed` | `{position, velocity, cause}` | CombatWorld |
| `player:resupply` | `{health, flares, msl, sp}` | missions |
| `weapon:gun` | `{firing, entity}` (start/stop) | combat, ai |
| `weapon:gunHit` | `{position, normal, targetKind}` | CombatWorld |
| `weapon:switch` | `{current, weapon}` | combat |
| `weapon:empty` | `{weapon}` | combat |
| `weapon:flak` | `{entity, position}` | ai (ground) |
| `missile:launch` | `{missile}` (live; `owner`, `kind`, `weapon`, `target`) | CombatWorld |
| `missile:end` | `{missile, reason: 'hit'\|'miss'\|'ground'\|'fuel'}` | CombatWorld |
| `flare:release` | `{flare}` | CombatWorld |
| `explosion` | `{position, size: 'small'\|'medium'\|'large'\|'huge', kind: 'air'\|'ground'\|'missile'\|'flak', velocity?}` | CombatWorld, Game |
| `target:hit` | `{target, damage, source, weapon}` | CombatWorld |
| `target:destroyed` | `{target, killer, position, score}` | CombatWorld |
| `target:select` | `{target}` | combat |
| `lock:acquiring` / `lock:locked` / `lock:lost` | `{target}` | combat |
| `threat:missile` | `{missile, level: 'warning'\|'alert', bearing}` | combat |
| `threat:cleared` | `{}` | combat |
| `aircraft:spawn` / `aircraft:despawn` | `{entity}` (hostile aircraft only) | ai |
| `ai:engage` / `ai:fire` | `{entity, fighter}` | ai |
| `ai:samLaunch` | `{entity, radarGuided, dist}` | ai |
| `radio` | `{speaker, callsign, text, priority, voice, duration}` | missions |
| `hint` | `{id, action, text, keys, urgent, duration, handled}` | missions (M1 onboarding) |
| `mission:start` | `{mission}` | missions |
| `mission:phase` | `{mission, phase: {id, name, objective}}` | missions |
| `mission:complete` / `mission:failed` | `{mission, result}` | missions |
| `recon:capture` | `{target, quality, captured, total}` | missions |
| `score:bonus` | `{label, score}` | missions |
| `conditions:change` | `{time, weather, label, night, ...}` | missions |
| `music:intensity` | `{level 0..1, state}` | missions, Flow |
| `flow:state` | `{state, ...data}` | Flow |
| `flow:missionEnd` | `{result}` | missions |
| `flow:difficulty` / `flow:conditions` / `flow:special` | new value | Flow |
| `ui:screen` | `{screen, source?, ...data}` | Flow, ui |
| `ui:sound` | `{name}` | ui |
| `settings:change` | `{key, value, settings}` | ui |
| `loading:progress` | `{progress 0..1, label}` | ui |
| `controls:mode` | `{mode: 'standard'\|'expert'}` | Game |
| `camera:mode` | `{mode, base}` | CameraRig |
| `camera:request` | `{mode: 'optic'\|'cinematic'\|'restore', ...}` | Flow, missions |
| `camera:cinematic` | `{name, state: 'start'\|'end'}` | CameraRig, camera |
| `camera:killcam` | `{phase: 'start'\|'impact'\|'return'\|'end', shot, ...}` | CameraRig, camera |
| `camera:sonic` | `{direction: ±1, mach}` | camera |
| `vfx:shake` | `{amount}` | combat, vfx |
| `weather:lightning` | `{position, distance}` | atmosphere |
| `timeofday:phase` | `{phase: 'day'\|'twilight'\|'night', hours, night, keyLight}` | timeofday |

Listened for but not emitted anywhere yet: `vehicle:spawn {entity}` (timeofday
gives that entity headlights).

## HUD snapshot (`game.hud`)

Combat and missions write it in `update`. The ui reads it in `lateUpdate`
(combat projects `targets[].screen` in its own `lateUpdate`, after the camera
moved). Readers must tolerate missing fields.

| field | written by | content |
| --- | --- | --- |
| `speed`, `altitude`, `agl`, `heading`, `pitch`, `roll`, `gLoad`, `aoa` | combat | flight state (m/s, m, degrees) |
| `throttle`, `reheat`, `stall`, `highG` | combat | engine and flight flags |
| `speedLimits` | combat | `{stall, corner, max}` |
| `health` | combat | 0..1 |
| `controlMode` | combat | `'standard'` or `'expert'` |
| `weapon` | combat | `{current, id, name, short, type, ammo, maxAmmo, ready, reload, rails[], ccip, lockRange, lockCone}` |
| `weapons` | combat | `{msl, sp}`, each `{name, short, ammo, maxAmmo}` |
| `gun` | combat | `{ammo, maxAmmo, firing, range, lead}` |
| `flares` | combat | `{count, max, ready}` |
| `lock` | combat | `{state: 'none'\|'acquiring'\|'locked', target, progress}` |
| `lockWarning` | combat | true while a hostile is locking you |
| `targets[]` | combat | `{entity, id, kind, team, class, position, name, isTarget, isAce, distance, selected, lockable, locked, health, onScreen, screen}` |
| `target` | combat | the selected entry of `targets`, or null |
| `threats[]` | combat | `{position, distance, bearing, kind, level, missile}` |
| `warning` | combat | `'none'\|'pullup'\|'missile'\|'stall'\|'terrain'\|'damage'` |
| `radar` | combat | `{range}` |
| `score`, `time`, `timeLimit`, `timeRemaining` | missions | sortie state |
| `objective` | missions | `{text, progress, total, marker}` |
| `mission` | missions | `{id, name, phase, phaseName, state}` |
| `conditions` | missions | `{time, weather, label, night, light, turbulence}` |
| `radio` | missions | current line plus `age`, or null |
| `recon` | missions | `{active, captured, total, progress, focus, quality, axis, fov}` or null |

## Assets

| What | Runtime location | Built by |
| --- | --- | --- |
| Aircraft, weapons, ground units, pilot (GLB) | `public/models/` | `tools/blender/` (Blender Python builders, then `optimize-glb.mjs`: meshopt, quantisation, WebP textures) |
| Airbase kit | `public/assets/bases/` (`catalog.json`) | Blender sources in `assets/authoring/` |
| Model catalogue | `src/assets/catalog.js` | generated by `node tools/blender/write-catalog.mjs` |
| Terrain packs (STP1) | `public/assets/terrain/` (`dem.json`, `kargil-hi.stp`, `kargil-lo.stp`) | `npm run dem` (`tools/terrain/build-dem.mjs`) |
| Terrain textures | `public/assets/textures/terrain/` | `tools/terrain/fetch-textures.mjs` (Poly Haven) |
| Star catalogue | `public/assets/sky/stars.bin` | `tools/sky/build-stars.mjs` |
| VFX textures | `public/assets/vfx/` | `tools/vfx/gen-textures.mjs` |
| Audio (`.webm` + `.m4a`) | `public/audio/` (`manifest.json`, `sfx/`, `music/`) | `tools/audio/` (Python render scripts, `build_manifest.py`) |
| Fonts | `public/fonts/` | — |

Gameplay loads models with `loadModel(id)` from `src/assets/loadModel.js`.
Tests in `src/assets/*.test.mjs` check the catalogue, triangle budgets, the
MiG skin and the cockpit screens against the shipped files.

Licences: see "Credits and licences" in `README.md` and
`public/THIRD_PARTY_NOTICES.txt`.

## Dev tools

All of these exist only in `npm run dev` builds unless noted.

| Hook | File | What it does |
| --- | --- | --- |
| `window.__game`, `window.__renderer` | `src/main.js` | the live game and renderer wrapper |
| `game.dev` | `src/game/dev/index.js` | `status()`, `sim(s)`, `run(id, opts)`, `batch(id, n)`, `table()`, `tuning`, event log |
| `window.__bot(true\|false\|'god')` | `src/game/dev/index.js` | the flying test bot (`Bot.js`) |
| `window.__camTest(name, opts)` | `src/camera/dev.js` | camera scenarios: `lowpass`, `roll`, `cloud`, `rain`, `cockpitRain`, `kill`, `killMissile`, `killGround`, `lock`, `sun`, `title`, `sortie`; `__camTest.reset()`; `{defer: true}` returns `go()` for frame-exact capture |
| `window.__capture` | `src/game/dev/capture.js` | frame-exact capture: `step(s)`, `record({clip, seconds, fps})` |
| `window.__trailer` | `src/game/dev/trailer.js` | `sortie`, `sim`, `until`, `nearest`, `view`, `cine`, `missileCam`, `killCam`, `rec`, `god` |
| `window.__vfx`, `window.__vfxTest` | `src/vfx/dev/harness.js` | VFX scenarios, `cam()`, `freeze()`, `step()`, `bench()` |
| `window.__audio`, `__audioTest`, `__audioProbe` | `src/audio/harness.js` | synthetic events, bus meters |
| `window.__verifyTerrain()` | `src/world/terrain/heightfield.js` | GPU vs CPU terrain height check |
| `window.__perf` | `src/engine/Perf.js` | GPU profiler and adaptive resolution (also with `?perfhud` / `?gputime` in production) |
| `window.__boot` | `src/main.js` | boot stage timings (always present) |

**Capture workflow.** Size the viewport to the output, keep the tab visible,
then `await __capture.record({clip: 'name', seconds: 4})`. Frames are POSTed to
the dev-server plugin `tools/capture/vite-capture.mjs` and land in
`captures/<clip>/` (gitignored). Encode with
`node tools/capture/encode.mjs <clip>` (needs ffmpeg). While capturing,
`post.fixedDt` replaces wall-clock time so motion blur matches the footage.

**URL flags.**

| Flag | Effect |
| --- | --- |
| `?quality=low\|medium\|high\|ultra`, `?webgl` | tier, force WebGL2 |
| `?mission=<id>&special=<id>`, `?difficulty=` | start a sortie directly |
| `?tod=HH:MM\|<preset>\|cycle[:min/s]`, `?from=`, `?date=YYYY-MM-DD`, `?preset=` | time of day and weather |
| `?noclouds`, `?nonight`, `?nowater`, `?nodof`, `?noao`, `?norays` | switch features off |
| `?aa=traa\|fxaa\|smaa\|none` | anti-aliasing |
| `?perfhud`, `?gputime`, `?notimestamps`, `?noadaptive`, `?adaptive`, `?gpubudget=ms`, `?scale=` | perf |
| `?nokillcam`, `?actioncam`, `?cinematic=<name>`, `?reducedMotion` | camera |
| `?touch=1`; dev only: `?hudmock`, `?ui=<screen>` | ui |
| `?bot`, `?bot=god`, `?speed=`, `?debug`, `?debughud` (dev) | dev bot and overlay |

Perf tooling and measuring rules: `tools/perf/README.md`.

## Design notes

Non-obvious decisions that are still true in the code. Check here before "fixing" one.

### Flight and camera

- Terrain collision clearance is `TERRAIN_CLEARANCE = 6` m (`FlightModel.js`).
- Standard controls fly through `AssistController` (lift-vector law); expert is direct.
  `game.autopilot` flies instead when set (title flyby, dev bot).
- G greyout (`src/fx/ScreenState.js`) is a stress reservoir that builds from 6.5 G, so a held 7 G
  turn stays clear. Purely visual.
- Kill cam rules are in `KILL` (`src/camera/killCam.js`): never in danger (`cameraMath.inDanger`),
  5 s cooldown, any weapon or camera key skips it, reduced motion gets a short held shot.
- The kill cam borrows the dead fighter's model and flies it down the wreck path
  (`src/camera/wreckProxy.js`). The HUD canvas hides during kill cams and the director cinematic.
- `TimeWarp` (`src/camera/timeWarp.js`) owns `game.timeScale` during slow motion and restores it.
- Materials displaced by a `positionNode` (terrain) need `post.useStaticVelocity`, or TRAA and
  motion blur smear: three reprojects the undisplaced geometry. Glass keeps velocity at zero.

### Combat and AI

- One muzzle constant, `GUN_MUZZLE` (`src/vfx/core/sockets.js`), feeds the bullet origin,
  `Aircraft.sockets.gun` and the muzzle flash. Missiles leave from `AAM_RAIL`, alternating sides.
- A guided missile from a fast launcher keeps the launcher's velocity and flies unguided for
  `RAIL_CLEAR` (0.15 s), so it does not climb off the rail. Rockets keep the simple rule because
  `guidance.rocketImpact` (CCIP) assumes it.
- `clearLine` (`src/combat/los.js`) is the one line-of-sight test (lock, AI, SAM guidance, recon).
- Cloud and visibility matter: IR lock takes 2.5x as long through cloud and IR seekers can lose a
  target inside it; visibility scales optical gun and MANPADS range; radar SAMs ignore it.
- Hit feedback (shake, flash, rumble, audio) scales by `player:hit.severity`, not `damage`.
- `DIFFICULTY` (`src/game/difficulty.js`) scales damage, accuracy and score; rank thresholds per
  mission stay the same.
- AAA opens with ranging bursts and tracks with lag (`AA`, `aaaBurstError` in `src/ai/ground.js`).
- The hostile fighter GLB preloads 4 s after the first `flow:state`, not at boot.

### VFX

- One tracer system: `src/vfx/core/Tracers.js` draws combat's bullets. The box tracers in
  `src/combat/visuals.js` appear only when there is no VFX system.
- Explosion sizes match combat blast radii (`EXPLOSION_SIZES` in `src/vfx/core/ring.js`).
- The player's own muzzle flash requests no point light in cockpit view (camera within 12 m). The
  light casts no shadow and sat 1.7 m from the eye, so it lit the whole cockpit through the hull.
- Every VFX pipeline is prewarmed over the first 3 frames, so the first shot does not hitch.
- Fire colour is a blackbody ramp (`fireColor` in `fxmath.js`, TSL twin in `shared.js`).
- The afterburner plume is a premultiplied-alpha shell (`Shells.js`, mode `'plume'`) with shock
  cells from `plumeState` (`ring.js`).
- VFX camera uniforms are written in `VfxSystem.lateUpdate`. To pose the camera while paused, use
  `__vfxTest.cam()`.
- Large ground blasts leave scorches; VFX passes them to `terrain.setScorches`.

### Clouds, sky and time of day

- `env.sun` / `env.sunDirection` are the **key light**: sun by day, moon at night (`env.keyLight`).
  The atmosphere is always lit from `env.solarDirection`. Gate sun discs and flare on
  `keyLight === 'sun'`.
- Sun and moon come from an ephemeris (`src/world/timeofday/astro.js`, IST, 34.5 N 76.09 E).
  Default date 1999-06-21.
- Night photometry is compressed on purpose (moonlight and airglow brighter than real), so
  exposure rises only one to two stops at night. Below 1.5° sun elevation `twilightGain` keeps
  twilight a lit sky.
- The `timeofday` system writes exposure limits and grade from `env.exposureHint`. It never
  touches `exposureCompensation` (the user's brightness).
- Cloud temporal resolve keeps guesses and history on the pixel's own surface (`sameSurface`)
  and resets history on a camera cut (`cameraCut`). This stops horizon flicker at low sun.
- God rays accumulate their emitter mask over time (`EmitterHistory`) so shafts do not pulse.
- Above a cloud deck the lower half of the environment light is sunlit cloud top, not ground:
  the cloud probe measures `clouds.deckCover` under the camera and `Environment._deckFactor`
  blends it in (hemisphere fill and the PMREM, rebuilt at most every 1.5 s).
- At a low sun the directionless sun fill inside clouds (`deep`, `diffuse`) scales down to
  `clouds.u.lowSunFill` (0.2), so shaded flanks take the sky's colour; 1 switches it off.
- A failing cloud pass is reported once by `PassGuard` and backs off; it does not throw per frame.
- FRAME-type nodes (cloud passes, TRAA, god-ray history) only advance when three's animation loop
  ticks. Rendering by hand outside it freezes them; `__capture` runs on the loop for this reason.
- A pass texture's `.sample(uv).level(lod)` drops the uv; set `levelNode` instead (`godRays.js`).
- Weather state is `env.weather` (`src/world/weather/Weather.js`); it owns no rendering.
  `env.cloudVisibility(screenUv, dist)` says how much of a later-drawn thing shows through cloud.

### Terrain

- The CPU heightfield equals the rendered surface. Keep `heightfield.js` and `Terrain.js` in step;
  `__verifyTerrain()` checks it.
- The terrain has its own tier table in `Terrain.js` (finest cell 6/4/3/2 m, 11 clipmap levels).
  `Quality.js` `terrainGrid` / `terrainLevels` are passed but ignored.
- `VIEW_LAYER = 1`, `SHADOW_LAYER = 2`: terrain blocks are culled against the view and the shadow
  frustums separately. Other objects stay on layer 0.
- CPU copies of terrain textures are freed after upload. Never read `tex.image.data` of a terrain
  texture; use the heightfield functions.
- The terrain does not cast into the sun shadow map. Its self-shadow is a heightfield sweep
  (R16F), exposed as `env.terrainShadow`.
- `env.applyCloudShadow(material)` adds cloud and terrain shadow and a program cache key (three
  ignores `receivedShadowNode` there). Call it again after `material.clone()`.
- The terrain material is near WebGPU's 16 textures per stage. It samples near-field AO itself
  (`terrain.bindNearAO`); set `userData.noAO` on other texture-heavy materials.
- The snow line (`src/world/terrain/snow.js`) is shared by the shader and `siteSnow` (unit
  foundations). Change both together.
- Rivers are shaded in the terrain material (`src/world/water/river.js`). There is no water mesh.

### HUD and UI

- Target labels avoid a keep-out list (`src/ui/declutter.js`): instruments, banner, radio plate,
  lock reticle and, in outside views, the own jet (`src/ui/ownJet.js`). Lock, firing and selected
  labels always place; the rest share a budget of 3 (2 on touch).
- A hostile firing on you is never folded or hidden (`hud.markFiring`).
- The HUD reads PostFX's metered luminance (`post.stats`, no extra readback) and thickens halos
  and plates by day. Night is the base theme.
- Rumble runs only on the `sortie` screen and only with the `vibration` setting on.
- The ui applies settings (`src/core/Settings.js`) directly to audio, `post.options` and
  `cameraRig.options`.

### Audio

- `game.systems.audio`: `setVolume(bus, v)`, `getVolume`, `setMuted`, `ui(name)`, `play(id)`,
  `setMusic`, `stinger`, `say`, `unlock`. Buses: master, music, sfx, radio, ui, ambience.
- The player is recognised in payloads by `isPlayer === true` (or kind/team `'player'`).
- Warning tones sweep with lock progress and missile time-to-impact (`missileUrgency`).
- Nothing plays thunder yet. `weather:lightning.distance` allows a `distance / 340` s delay.

### Performance

- Adaptive resolution (`src/engine/AdaptiveResolution.js`) scales the tier's pixel ratio to hold
  a GPU budget.
- PostFX meters (auto-exposure, sun visibility) render and read back every 4th frame.
- Frame-time work that is skipped when it cannot change the picture, each with a runtime switch
  (table in `tools/perf/README.md`): timestamp queries run on about 20 frames a second (enough for
  the adaptive resolution's median), the profiler keeps per-pass detail only with `?gputime` /
  `?perfhud`, the cloud shadow map and deck probe redraw about 30 times a second, the sky-view LUT
  redraws when its inputs move, the AO depth prepass draws only terrain within the AO range, and a
  sun cascade is not redrawn while no shadow receiver lies in its depth slice
  (`SunCascades._markReceivers`; `tools/perf/cullcheck.js` asserts the two culling tests in flight).
- Measure frame time with `tools/perf/frame.js` and compare with `tools/perf/abx.js` (interleaved A/B).
- The GPU profiler labels passes by render-target or quad material name. Name yours.
- Ground units and hostile jets use LODs (`UnitLOD`, `src/ai/models.js`); hostile MiG LOD1 at 600 m.
- Analytics are not injected on localhost.
