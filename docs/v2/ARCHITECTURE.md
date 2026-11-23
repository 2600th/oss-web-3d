# Safed Sagar v2 — architecture and team contract

Goal: a browser air-combat game whose look, feel and sound stand next to a current
console flight-combat title. WebGPU first (three.js r187 `three/webgpu` + TSL), with
three's automatic WebGL2 backend as the fallback. This file is the contract every
feature area builds against. If you need to change a contract, keep the old surface
working and note the change at the bottom under **Contract changes**.

The old WebGL2 game lives in `legacy/` (read-only reference; it will be deleted). Its
docs' claims about "blockers" and "limitations" are **not trusted** — verify yourself.

## Creative direction

- Setting: the real Kargil sector of Ladakh (Drass, Tololing, Tiger Hill, Kargil,
  Batalik), 90 x 88 km of SRTM1 terrain, high-altitude, thin dry air, snow above
  ~5000 m, brown-grey scree and rock below, glacial rivers in the valleys (Drass, Suru,
  Shingo, Indus). Summer 1999 light: hard high-altitude sun, deep blue zenith, crisp
  far visibility with blue aerial perspective, cumulus building over the ridges.
- Tone: inspired by Operation Safed Sagar. **Fictional** — no real nations named as
  enemies, no real insignia on enemies, no real people. Enemies are "hostile forces",
  unmarked. The player flies a MiG-21 Bison in IAF markings (the existing model).
  Failure is respectful; remembrance stays separate from score (keep the existing
  memorial card idea from legacy/ui/Screens.js).
- Gameplay: arcade air combat in the genre of console flight-combat games — high
  missile counts, lock-on, gun, flares, named enemy aces, ground strikes on ridge
  positions, SAM/AAA threats, radio chatter, score and rank. Do **not** copy any
  specific game's names, characters, HUD art, music or levels. Original everything.
- Presentation bar: volumetric clouds you fly through, physically based sky and
  aerial perspective, sharp high-frequency terrain detail at 100 m AGL, cinematic
  post (bloom, lens flare, motion blur, heat haze, grade), dense VFX (smoke trails
  that hang in the air, layered explosions, debris, vapour, flares), punchy layered
  audio with doppler, an orchestral/rock score that reacts to combat.

## Runtime layout

```
src/main.js            boot: Renderer.init + DEM load, PostFX, Game, auto-registers systems
src/engine/            Renderer (WebGPURenderer, camera, resize), Quality tiers, PostFX
src/game/Game.js       orchestrator: world, player flight, fixed-step loop, system list
src/game/Events.js     event bus (game.events)
src/world/Environment.js  sky, sun, ambient (atmosphere area)
src/world/terrain/     heightfield.js (CPU authority) + Terrain.js (GPU clipmap)
src/flight/            FlightModel, AssistController, Aircraft (GLB + sockets), CameraRig
src/core/              Input, TouchControls, Settings
src/<area>/system.js   feature systems, auto-registered (see below)
```

### Systems

Any file `src/<area>/system.js` that exports `createSystem(game)` (optionally async)
and optionally `export const order = <number>` (default 100, lower runs first) is
loaded automatically by `main.js` before `game.init()`. **Never edit main.js or
Game.js just to plug in.** A system is an object with optional hooks:

```
name                     string; exposed as game.systems[name]
init(game)               async ok; after world + player model are ready
fixedUpdate(dt, game)    at 120 Hz after the player's flight step
update(dt, game)         per frame, before the camera rig moves
lateUpdate(dt, game)     per frame, after camera + world update (HUD, screen-space)
onCrash(game)
dispose()
```

Order convention: world/atmosphere 10, terrain extras 20, combat/gameplay 50, ai 55,
vfx 70, audio 80, camera/post extras 85, ui/hud 90.

### Conventions

- `import * as THREE from 'three/webgpu'`; TSL from `'three/tsl'`; addons from
  `'three/addons/...'`. **No GLSL `ShaderMaterial`/`RawShaderMaterial`, no
  `postprocessing` package** — they do not run on WebGPURenderer. Use node materials,
  `Fn`, compute (`instancedArray`, `renderer.compute`), `wgslFn` only if a WebGL2
  fallback (`?webgl` URL flag) still works or degrades gracefully.
- World space: metres, +X east, +Z south (north is -Z), +Y up, origin = DEM centre
  (lon 76.09 E, lat 34.50 N). DEM bounds ±44.9 km x ±44.2 km; heights 2479–5947 m.
- Aircraft model space: nose −Z, up +Y, right +X.
- Depth buffer is **reversed** (`reversedDepthBuffer: true`). Anything that projects
  to the far plane must not rely on standard depth (see Environment.js sky).
- Camera near 0.5 m, far 260 km. Tone mapping (AgX) happens once, in PostFX; scene
  colours are linear HDR. Sun illuminance is in "renderer units" — keep sun
  `DirectionalLight.intensity` ≈ 3–5 and calibrate exposure in PostFX.
- Quality: read `game.r.tier` (`src/engine/Quality.js`: low/medium/high/ultra; URL
  `?quality=ultra`). Every expensive feature must scale with it. Budget on `high`:
  60 fps at 1440p on a desktop discrete GPU; `low` must run on integrated GPUs and
  on the WebGL2 backend.
- Gameplay queries use `src/world/terrain/heightfield.js` (`terrainHeight`,
  `terrainNormal`, `raycastTerrain`, `lineOfSight`, `maxHeightAlong`). If the GPU
  terrain adds displacement, mirror it there (CPU and GPU must agree within ~1 m).
- Dev hooks: in dev builds `window.__game` and `window.__renderer` exist.

## Cross-area hooks

- `game.post.addSceneStage(fn, order)` — composite in linear HDR before bloom/tone
  mapping; `fn(colorNode, {scenePass, depth, velocity, camera, renderer})`.
  Atmosphere/aerial perspective ~20, clouds ~30, VFX distortion/heat ~60.
- `game.env.cloudShadow` — TSL `Fn(worldPos) -> float`; apply with
  `material.receivedShadowNode = Fn(([s]) => s.mul(env.cloudShadow(positionWorld)))`.
- `game.env.inCloud` (0..1), `game.env.sunDirection`, `game.env.sun`.
- `scene.fogNode` (three WebGPU) is the per-material place for aerial perspective if
  the atmosphere owner prefers it over a depth-based post stage.

## Event catalogue (`game.events`)

Positions are `THREE.Vector3` (copies unless stated "live"). Entities are live objects
with at least `{ id, position, velocity, quaternion?, alive, team, kind }`.

| event | payload | emitted by |
| --- | --- | --- |
| `player:crash` | `{position, velocity}` | Game |
| `player:hit` | `{damage, health, source, position}` | combat |
| `player:destroyed` | `{position, velocity, cause}` | combat |
| `player:respawn` | `{}` | game flow |
| `weapon:gun` | `{firing: bool, entity}` (start/stop) | combat |
| `weapon:gunHit` | `{position, normal, targetKind}` | combat |
| `missile:launch` | `{missile}` (live entity; `missile.owner`, `missile.kind` = 'aam'/'sam'/'agm'/'rocket'/'bomb') | combat |
| `missile:end` | `{missile, reason: 'hit'/'miss'/'ground'/'fuel'}` | combat |
| `flare:release` | `{flare}` (live entity) | combat |
| `explosion` | `{position, size: 'small'/'medium'/'large'/'huge', kind: 'air'/'ground'/'missile', velocity?}` | combat |
| `target:destroyed` | `{target, killer, position, score}` | combat |
| `target:hit` | `{target, damage}` | combat |
| `lock:acquiring` / `lock:locked` / `lock:lost` | `{target}` | combat |
| `threat:missile` | `{missile, level: 'warning'/'alert', bearing}` | combat |
| `threat:cleared` | `{}` | combat |
| `aircraft:spawn` / `aircraft:despawn` | `{entity}` (live; `entity.object3d`, `entity.engine` {throttle, reheat}) | combat/ai |
| `radio` | `{speaker, callsign, text, priority, voice?}` | missions |
| `mission:start` / `mission:phase` / `mission:complete` / `mission:failed` | `{mission, phase?, result?}` | missions |
| `music:intensity` | `{level: 0..1, state: 'menu'/'cruise'/'combat'/'danger'/'victory'/'defeat'}` | missions |
| `camera:mode` | `{mode}` | camera |
| `ui:screen` | `{screen}` | ui |
| `vfx:shake` | `{amount}` | anyone; camera listens |

## HUD snapshot (`game.hud`)

Written by the gameplay/combat system every frame in `update()`, read by the HUD in
`lateUpdate()`. Shape (all optional; HUD must tolerate missing fields):

```
{
  speed, altitude, agl, heading, pitch, roll, gLoad, throttle, reheat, stall, aoa,
  health (0..1), score, time, timeLimit,
  weapon: { current: 'gun'|'msl'|'sp', name, ammo, maxAmmo, ready, reload (0..1) },
  gun: { ammo, firing },
  flares: { count, ready },
  lock: { state: 'none'|'acquiring'|'locked', target, progress (0..1) },
  targets: [ { id, kind, team, position (live), name, isTarget, isAce, distance,
               lockable, locked, health, onScreen?, screen? } ],
  threats: [ { position, distance, bearing, kind } ],   // incoming missiles
  warning: 'none'|'pullup'|'terrain'|'missile'|'stall'|'damage',
  objective: { text, progress, total, marker? },
  mission: { id, name, phase, state },
  radar: { range }
}
```

## Asset catalogue

`src/assets/catalog.js` (assets area) maps ids to GLB urls + metadata (scale already
baked to metres, orientation per conventions, `sockets` names). Gameplay loads with
`loadModel(id)` returning a cloned `THREE.Object3D`. Until an id exists, gameplay uses
a primitive placeholder. Planned ids: `mig21` (player), `mig21_hostile` (enemy livery),
`aam_ir`, `sam`, `rocket`, `bomb`, `flare`, `sam_launcher`, `aaa_gun`, `radar`,
`truck`, `bunker`, `tent`, `supply_dump`, `helipad`, plus the base kit in
`public/assets/bases/` (catalog.json there).

## Ownership (one owner per path; others read only)

| area | owns |
| --- | --- |
| atmosphere + clouds | `src/world/Environment.js`, `src/world/atmosphere/**`, `src/world/clouds/**`, `src/world/system.js` |
| terrain + water | `src/world/terrain/**` (keep heightfield API), `src/world/water/**`, `tools/terrain/**`, `public/assets/terrain/**`, `public/assets/textures/terrain/**` |
| post + camera | `src/engine/PostFX.js`, `src/fx/**`, `src/flight/CameraRig.js`, `src/camera/**` |
| vfx | `src/vfx/**`, `public/assets/vfx/**` |
| gameplay (combat, AI, missions, controls, flow) | `src/combat/**`, `src/ai/**`, `src/missions/**`, `src/game/**` (Game.js: keep the system contract), `src/core/Input.js`, `src/flight/FlightModel.js`, `src/flight/AssistController.js` |
| ui + hud | `src/ui/**`, `src/core/TouchControls.js`, `src/core/Settings.js`, `index.html` |
| audio | `src/audio/**`, `public/audio/**`, `tools/audio/**` |
| art assets | `src/assets/**`, `public/models/**`, `tools/blender/**`, `assets/authoring/**` |

`src/engine/Renderer.js`, `src/engine/Quality.js`, `src/main.js`, `src/flight/Aircraft.js`
are integration-owned (the lead). Small, clearly commented edits there are allowed
when unavoidable; say so in your report.

## Verification (everyone)

- `npm run build` must pass. Add `node:test` tests (`*.test.mjs`) for pure logic.
- Look at it: run `npx vite --port <your port> --strictPort` and drive Chrome via the
  chrome-devtools MCP (`new_page`, `evaluate_script` with `window.__game`,
  `take_screenshot`). Check the console for WebGPU validation errors. Also try
  `?webgl` once (fallback backend) and `?quality=low`.
- Report: what you built, how you verified it (screenshots saved under
  `docs/v2/evidence/<area>/`), measured frame time, known gaps.

## Contract changes

(append here)

- **post + camera (additive).** `game.post.useStaticVelocity(material)` gives a
  material whose vertices are placed by a `positionNode` (terrain clipmap, water)
  correct camera-only velocity: three's VelocityNode reprojects the undisplaced
  `positionGeometry`, which breaks TRAA and motion blur. The camera system applies
  it to `game.terrain` materials. `useTransparentVelocity(material)`: blended
  surfaces keep the velocity behind them (the scene MRT velocity target now uses
  material blending). `post.setFrameState({sunDirection, sunIntensity, airspeed,
  reheat, screen})`, `post.notifyCut()`, `post.options` (`autoExposure`,
  `exposureCompensation`, `motionBlur`, `reducedMotion`, `flare`), `post.stats`.
  `uniforms.exposure` is now written every frame by auto-exposure.
  Camera: `cameraRig.view` (effective view), `setMode/cycleMode`, `lockHeld`,
  `look`, `followMissile(m)`, `killCam(target, pos)`, `deathCam(pos, vel)`,
  `playCinematic(name, opts) -> Promise`, `stopCinematic()`, `options`
  (`shake`, `killCam`, `missileCam`, `reducedMotion`, `fovEffects`), `rumble`.
  New event `camera:cinematic` `{name, state: 'start'|'end'}`; `camera:mode`
  also carries `base`. Input actions read if present: `camera`, `lookTarget`,
  `missileCam` (fallback keys C / V / B). URL flags: `?gputime`,
  `?reducedMotion`, `?nokillcam`, `?cinematic=<name>`, `?aa=traa|fxaa|smaa|none`.

- **audio (additive, optional):** `game.systems.audio` exposes `setVolume(bus, v)` /
  `getVolume(bus)` (bus `master|music|sfx|radio|ui|ambience`, 0..1, persisted in
  localStorage `safedSagar.audio.v1`), `setMuted`, `ui(name)`, `setMusic(state, level)`,
  `stinger('complete'|'failed')`, `say(radioMsg)`, `play(id, opts)`, `unlock()`.
  Extra accepted inputs: `music:intensity.state` may also be `briefing`, `ace`,
  `memorial`, `silence`; `explosion.kind` may be `flak`; `weapon:gun` from an entity
  with `kind: 'aaa'|'flak'` plays AAA bursts; new optional event `ui:sound {name}`
  (`click|hover|confirm|back|error|kill|hit`). Any DOM `button`/`[role=button]` click
  plays `ui_click` unless it has `data-sound="none"` (or `data-sound="confirm"` etc.).
  `ui:screen` values `title|menu|main|hangar` → menu theme, `briefing`, `memorial`,
  `game|hud|flight` → in-flight score. The player is recognised in payload entities by
  `isPlayer === true`, `kind/team === 'player'`, `=== game.player`, the string
  `'player'`, or (for `weapon:gun` only) a missing entity.

- **atmosphere + clouds (additive).** `game.env` keeps `sunDirection`, `sun`,
  `ambient`, `cloudShadow`, `inCloud`, `setSun(elevationDeg, azimuthDeg)`,
  `update(dt, camera, focus)`. New: `setPreset(name, overrides?)` with
  `'default' | 'morning' | 'noon' | 'golden' | 'overcast' | 'storm'` (`env.preset`,
  `env.presets`), `setCoverage(0..1)`, `applyCloudShadow(material)` (idempotent;
  multiplies cloud shadow into `material.receivedShadowNode`; the atmosphere
  system applies it to `game.terrain` materials, other owners call it for their
  own lit materials), `sunVisibility` (0..1, sun reaching the camera through
  cloud, async readback), `exposureScale` (preset hint), `sunIrradiance` /
  `skyAmbient` (uniform nodes), `atmosphere`, `clouds` (null with `?noclouds`).
  Scene stages: aerial perspective at order 20, clouds at order 30. The system
  `game.systems.atmosphere` sets `post.options.exposure.baseEV/refLog` and
  `post.uniforms.sunRefLum` (about 399 = sun irradiance 4.6 x disc gain 260 / 3)
  for this sky. `sun.intensity` is now about 4.4 at late morning, 2.9 at golden
  hour. URL flags: `?noclouds`, `?preset=<name>`.

- **terrain + water (additive).** `new Terrain(r, { env, tier })` (the old
  `grid`/`levels` options are accepted and ignored: the terrain has its own
  table keyed by `r.tier.name`, low 6 m / medium 4 m / high 3 m / ultra 2 m
  finest cell, 11 clipmap levels). Game.js passes `env` so the terrain can fold
  cloud shadow, its own long-range heightfield shadow and the range-gated
  shadow map into one `receivedShadowNode`; `env.applyCloudShadow(material)`
  may still be called on terrain materials at any time, the terrain re-wraps it
  on the next `update`. Data: `public/assets/terrain/dem.json` now lists
  `packs` (`kargil-hi.stp` 3073^2, `kargil-lo.stp` 2049^2; STP1 container,
  see `src/world/terrain/pack.js`); `dem.u16` is gone. `loadDEM(base, { set })`
  picks the pack. Heightfield additions: `initTerrain`, `detailHeight`,
  `riverEdge(x,z)` (metres to the bank, negative in water), `isWater`,
  `waterHeight`, `demInset`; `terrainHeight` now includes the sub-DEM detail,
  carved river beds and the procedural surround beyond the DEM, and equals the
  rendered surface (`window.__verifyTerrain()`, under 0.1 m everywhere).
  Terrain additions: `ready`, `material(s)`, `stats`, `height`, `verify()`,
  `crackTest()`, `gpuTime()` (dev; use `?gputime`). Rivers are shaded in the
  terrain material (`src/world/water/river.js`), there is no separate water mesh.
