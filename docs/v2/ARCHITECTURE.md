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

### UI + HUD (additive; nothing existing changed)

- `game.settings` — the shared `Settings` instance (`src/core/Settings.js`), plain keys:
  `tier` (null = auto), `controlMode` ('standard'|'expert'), `invertY`, `sensitivity`,
  `vibration`, `masterVolume`, `musicVolume`, `sfxVolume`, `radioVolume` (0..1),
  `hudColor`, `hudScale`, `hudOpacity`, `palette` ('standard'|'deutan'|'tritan'),
  `subtitles`, `subtitleSize`, `cameraShake` (0..1), `cameraFov` (deg added to base),
  `defaultCamera`, `reducedMotion` ('system'|'on'|'off'; resolved getter
  `settings.prefersReducedMotion`). Persisted in localStorage `safed-sagar.settings.v3`.
- New event `settings:change` `{key, value, settings}` — emitted by ui on every change.
  Audio should apply the four volumes; camera `cameraShake`, `cameraFov`, `defaultCamera`.
- New event `loading:progress` `{progress: 0..1, label?}` — gameplay may emit while a
  mission loads; the loading screen shows it.
- `ui:screen` payloads emitted by the ui itself carry `source: 'ui'` (menu navigation:
  title, missionSelect, briefing, settings, credits, memorial). Flow-driven screens
  (loading, sortie, pause, debrief) are expected from `game.flow`.
- `game.ui` — the UI orchestrator (dev/debug; `game.ui.hud`, `game.ui.flow`).
- Optional, read if present: `game.input.bindings` (array of `{action, label, keys[],
  pad, code}`; shown in Settings, used for touch fallback), `game.input.setAction(name,
  held)` (touch buttons call it; otherwise the bound key `code` is simulated),
  `game.flow.titleCamera` (true = gameplay owns the menu camera; otherwise the ui
  orbits the player jet behind menus), mission fields `markers: [{kind:
  'objective'|'sam'|'aaa'|'ace'|'fighter'|'start', label, x, z, radius?}]` and
  `location: {name, x, z}` for the briefing map, target `velocity` (for gun lead; else
  estimated), `lock.target` may be the target object or its id, results
  `{score, rank, kills, accuracy, time, best?, reason?}`.
- `src/engine/Quality.js` `pickTier` also honours the saved `tier` setting (after the
  `?quality=` URL override), so a quality change fully applies on reload.
- **Bound to the merged systems (update).** Settings also carry `brightness` (EV),
  `motionBlur`, `lensFlare`, `filmGrain`, `killCam`, `missileCam`. The ui applies them
  directly: volumes -> `game.systems.audio.setVolume(master|music|sfx|radio)` (ui bus
  follows sfx), post -> `game.post.options.{exposureCompensation, motionBlur, flare,
  grain, reducedMotion}`, camera -> `game.cameraRig.options.{shake, killCam, missileCam,
  reducedMotion}` and `baseFov`, `defaultCamera` -> `cameraRig.setMode` at sortie start,
  `controlMode` -> `input.setMode`, `invertY` -> `input.invertPitch` (and back from
  `controls:mode`). Menus play `cameraRig.playCinematic('title')` (ui orbit fallback).
  Nav emits `ui:sound {name: 'hover'|'back'}`; touch flight buttons carry
  `data-sound="none"`.
- **Flow.** The ui drives gameplay's flow (`openSelect`, `selectMission`, `setSpecial`,
  `startMission`, `pause`/`resume`, `retry`, `quitToMenu`, `toTitle`, `confirm` on
  remembrance) and sets `flow.fallbackKeys = false`. Flow states map to ui screens
  `select -> missionSelect`, `remembrance -> memorial`; settings/credits stay ui-only
  overlays. Flow owns the pause key / pad Menu; the ui does not also toggle it.
  Briefing map markers are derived read-only from `game.systems.missions.list`
  (group `near`/`at`/`from`, `start`). Bindings shown in Settings come from the live
  `input.bindings` object. The dev overlay (`src/game/dev/index.js`, small edit) shows
  with the ui present only behind `?debughud` (or `?debug`).

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

- **gameplay (combat, AI, missions, controls, flow).** All catalogue events are
  emitted with the documented payloads. Additions (all additive / optional):
  - **Player identity.** The player's combat entity is `game.systems.combat.player`
    (`isPlayer: true`, `id: 'player'`, `kind: 'player'`, `team: 'friendly'`; live
    `position/velocity/quaternion` from the flight model, `object3d = game.player.group`,
    `engine {throttle, reheat}`). It is the `owner` of the player's missiles, the
    `killer` in `target:destroyed`, the `entity` in the player's `weapon:gun` and the
    `target` of hostile missiles. `aircraft:spawn/despawn` are emitted for hostile
    aircraft only. Hostile entities: `team: 'hostile'`, `kind` one of
    `fighter|ace|aaa|flak|manpads|sam|radar|bunker|sangar|supply|tent|truck`,
    `class: 'air'|'ground'`; recon posts are `kind: 'post'`, `team: 'neutral'`.
  - **Missiles** carry `weapon` (the table entry, `weapon.id`), `motor` (bool, burning),
    `target`, `age`, `speed`, `object3d`. `missile.kind` follows the catalogue;
    `explosion.kind` is `'flak'` for AA shell bursts. Flares: `{position, velocity, owner, age, life}`.
  - **Extra events:** `target:select {target}`, `weapon:switch {current, weapon}`,
    `weapon:empty {weapon}`, `weapon:flak {entity, position}` (a shell is on its way),
    `recon:capture {target, quality, captured, total}`, `score:bonus {label, score}`,
    `controls:mode {mode}`, `camera:request {mode: 'optic'|'cinematic'|'restore', fov?, subject?}`,
    `flow:state {state}`, `ai:engage|ai:fire {entity}`, `ai:samLaunch {entity, radarGuided}`.
    `radio` payloads also carry `duration` (s). `music:intensity.state` may be
    `briefing`, `memorial`, `ace` (audio's extended set).
  - **`game.hud` additions:** `highG`, `speedLimits {stall, corner, max}`, `controlMode`,
    `weapon {id, short, type, rails[], ccip (Vector3|null), lockRange, lockCone}`,
    `weapons {msl, sp}`, `gun {maxAmmo, range, lead (Vector3|null: aim point)}`,
    `flares.max`, `lockWarning` (a hostile is locking you), `target` (the selected
    entry of `targets`), `targets[].{entity, class, selected}`, `targets[].screen` is
    0..1 from the top-left, `threats[].{level, missile}`, `timeRemaining`,
    `objective.marker {x, z}`, `mission.phaseName`, `radio {callsign, text, age}|null`,
    `recon {active, captured, total, progress, focus, quality, axis, fov}|null`.
  - **Input** (`src/core/Input.js`): one table `DEFAULT_BINDINGS`; `input.actions.<name>`
    (held), `input.pressed.<name>` (true for one frame, shared), `input.consume(name)`,
    `input.rebind(action, {keys, pad, mouse})`, `input.mode` (`standard|expert`,
    `setMode`), `input.invertPitch`, `input.look` (right stick). Touch/UI:
    `setAction(name, held)`, `pressAction(name)`, `setTouchAxes(pitch, roll)`,
    `setTouchThrottle(0..1|null)`. Actions include `camera`, `lookTarget` (G / R3),
    `missileCam` (B), `optic` (V) — these exist as actions, so the camera system's
    fallback keys (V for look-at-target) are not used; V is the recon optic.
  - **Flow** (`game.flow`, `src/game/Flow.js`): `state` is
    `title|select|briefing|sortie|pause|remembrance|debrief`; every change emits
    `ui:screen {screen: state, ...data}`. Methods: `openSelect()`, `selectMission(id)`,
    `setSpecial(id)`, `startMission(id?, {special})`, `pause()`, `resume()`, `retry()`,
    `quitToMenu()`, `toTitle()`, `confirm()`, `back()`; data: `missions`, `mission`,
    `selected`, `special`, `result`, `cinematic {active, subject}`. Flow owns the pause
    key and auto-pauses when the tab is hidden. Until a system named `ui`/`hud`/`screens`
    exists a keyboard fallback drives it (Enter / Backspace / 1-5 / R); set
    `flow.fallbackKeys = false` to take over. `?mission=m1[&special=rkt]` starts a sortie.
    Note for audio: the in-flight screen is `sortie` and the memorial is `remembrance`
    (not `game`/`memorial`); the matching `music:intensity` states are emitted alongside.
  - **Game.js:** `game.playerControl`, `game.autopilot`, `game.spawnAt({x, z, alt|agl,
    heading (compass deg), speed})`; a crash no longer respawns by itself (the mission
    fails and flow moves on); the game still ticks `input` and `flow` while `paused`.
  - **Flight:** `flight.damage` (0..1), `flight.destroyed`, `flight.highG`; airbrake +
    pull is a high-G turn. Standard mode uses AssistController profile `combat`
    (lift-vector law); Expert is direct.
  - The recon optic borrows `cameraRig` view `hud` and narrows `baseFov`/`cockpitFov`
    while V is held (restored on release) — camera owner: replace with a real optic
    view on `camera:request {mode: 'optic'}` when convenient.

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

### Visual polish: weather, cloud occlusion, tracers (additive unless noted)

- `game.env.weather` (`src/world/weather/Weather.js`) — weather state; owns no rendering.
  Gameplay picks per-mission weather with `env.setPreset(name)` (presets now carry
  `rain`, `snow`, `lightning`, `wind: [east, south] m/s`, `humidity`) or directly with
  `env.weather.set({ rain, snow, lightning, wind, humidity })` (0..1 each; `lightning`
  is a strike rate; `wind` an array or Vector3). Live read-only fields, updated each
  frame at the camera: `rain`, `snow` (frozen above ~4.7-5.5 km, plus ice crystals in
  cloud), `precipitation`, `wetness` (rain or inside cloud: for lens/canopy water),
  `humidity` (1 inside cloud), `wind` (Vector3, shared with clouds, smoke and trails),
  `visibilityKm`, `lightning { intensity 0..1, position, distance }`, `flashFill`.
  `env.weather.strike(camera, position?)` forces a strike. Shortcuts on the
  environment: `env.rain`, `env.snow`, `env.wind`, `env.lightning`, `env.onLightning(fn)`.
- New event `weather:lightning` `{position, distance}` — once per strike (audio:
  thunder after `distance / 340` s).
- `game.env.cloudVisibility` — TSL `Fn(screenUv, viewDistanceMetres) -> 0..1`: how much
  of something at that distance shows through the resolved cloud layer in front of it.
  The VFX layer uses it per fragment; anything else drawn after the clouds can too.
- Inside cloud (`env.inCloud`) the environment now dims `env.sun` and raises
  `env.ambient` (and adds the lightning flash to it); `env.inCloud` falls faster than it
  rises so leaving a cloud is a clean break.
- Tracers: one set. `src/vfx/core/Tracers.js` draws every live round in
  `game.systems.combat.world.bullets`; the box tracers in `src/combat/visuals.js` only
  appear when there is no VFX system (placeholder mode). `vfx.tracer(position,
  velocity, hostile)` adds a visual-only round.
- `explosion` event sizes now follow combat blast radii: fireball radius small 6.5 m,
  medium 14 m, large 25 m, huge 50 m (`EXPLOSION_SIZES` in `src/vfx/core/ring.js`).
- **Changed:** `aircraft.sockets.nozzle` (`src/flight/Aircraft.js`) moved to the measured
  jet-pipe exit `(0, -0.61, 6.42)`; it was `(0, 0.05, bbox.max.z - 0.3)`, level with the
  fin. VFX places aircraft effects from its own measured table (`MIG21` in
  `src/vfx/effects/AircraftFx.js`; override per entity with `entity.vfxSockets`). The
  `socketPositions` for the MiG family in `src/assets/catalog.js` and the wingtip
  sockets in `Aircraft.js` are still the old bounding-box guesses (true wingtip trailing
  edge: `(±3.6, -0.76, 3.3)`).
- Glow particles streak with perspective (screen motion at their depth), so anything
  passing the camera at speed draws as a radial streak.

### Gameplay polish: difficulty, weather, new sorties, onboarding (additive unless marked)

- **Difficulty.** `src/game/difficulty.js` (`DIFFICULTY` table: `damage`, `accuracy`,
  `aggression`, `missile`, `flare`, `attackers`, `score`). API: `game.flow.difficulty`
  ('easy'|'normal'|'hard'), `game.flow.difficulties` (menu rows), `game.flow.setDifficulty(level)`.
  Setting key `difficulty` in `src/core/Settings.js` (flow follows `settings:change`);
  URL `?difficulty=`. New event `flow:difficulty {level, difficulty}`. Results and
  `scoring.computeScore` carry `difficulty` / `breakdown.difficulty` (the score scale;
  rank thresholds are the same on every level).
- **Time of day and weather.** Every mission has `conditions: {time (hours), weather,
  advance? (hours per sortie minute), choose?}`; `src/missions/conditions.js` owns the
  weather table (`clear`, `scattered`, `cumulus`, `overcast`, `snow`, `storm`), the
  labels and the numbers gameplay reads. Live object `game.conditions` `{time, weather,
  label, light, night, visibility, turbulence, cloud: {base, top}|null, irLoss, wind,
  rain, snow, lightning, coverage, applied}`; event `conditions:change` (same payload)
  at sortie start and every 2 s while the clock advances; `hud.conditions`; mission
  metadata `flow.missions[i].conditions {time, weather, label, night, choose}` (label
  e.g. "0540 · Dawn · Scattered cloud", shown in the briefing).
  Environment binding (`applyToEnvironment`): calls `env.setTimeOfDay(hours)` and
  `env.setWeather(state)` / `env.weather.set(state)` / plain `env.weather.{rain, snow,
  lightning, wind}` when they exist, with `state = {type, rain, snow, lightning, wind,
  coverage, turbulence}`; otherwise `env.setPreset(name, {coverage})` (morning, noon,
  default, golden, overcast, storm). Optional read: `env.inCloud` (0..1) for the player.
  What it does to play: `flight.turbulence` (0..1 buffet, `FlightModel.gust`);
  optically-laid guns and shoulder-launched missiles reach `range x visibility`
  (radar SAMs do not care); pilots detect at `detect x visibility` and go for the cloud
  layer when defensive; an IR missile loses an aircraft inside the layer (`irLoss`
  per second, both sides) and IR lock takes 2.5x as long through it; the player's
  ground lock range is `lockRange x sqrt(visibility)` (min 0.5); trucks carry headlight
  meshes (`name: 'headlights'`) at night.
- **Free flight picker.** `game.flow.conditionOptions {times: [{id, label, time}],
  weather: [{id, label}]}`, `game.flow.setConditions({time, weather})` (persisted,
  localStorage `safedsagar.v2.freeConditions`), `game.flow.freeConditions`, event
  `flow:conditions`. The briefing screen shows two chip rows for `conditions.choose`.
- **Campaign (changed).** Six sorties and free flight: `m1`, `m2`, `night` (Black Road,
  night convoy interdiction), `m3`, `storm` (Thunderhead, intercept in a storm), `m4`,
  `free`. `order` renumbered. A save from the four-mission chain keeps everything it
  had open (`scoring.isUnlocked`). New fail reason `escaped`.
- **Events.** `player:hit` gains `weapon` (weapon id). New `hint {id, action, text,
  keys, urgent, duration, handled}` (M1 onboarding; a listener that shows it sets
  `handled = true`, otherwise the line is spoken on the radio by the wingman).
  Progress in localStorage `safedsagar.v2.onboarding`; anything the player already did
  unprompted is never taught, and nothing is taught once M1 is complete.
- **Aces (changed).** `fighter.pilot` is the named pilot data for all four; `fighter.ace`
  / target `isAce` is true only for the flight lead (`cast.js` `lead: true`), so the
  HUD's "Flight lead" / "LEAD DOWN" matches the radio. The other three have `elite`.
  Objective `track: {destroyed: tag, total}` pins the displayed total (M4 shows 0/4
  from the start, not 0/2 until the second pair spawns).
- **Air defence (changed).** `src/ai/ground.js` `AA` table and `aaaBurstError(n, d)`:
  guns track with lag and open with ranging bursts; shoulder-launch teams carry
  `rounds: 3`. `src/combat/los.js` `clearLine(a, b)` is the one line-of-sight test
  (lock, AI, SAM command guidance, recon). Rocket pipper is a real ballistic solution
  (`guidance.rocketImpact`). Tower callsign is `KESAR TOWER`.
- **Flight (changed).** Terrain collision clearance is `TERRAIN_CLEARANCE = 6` m (was
  12). Standard assist: a gentle turn with a push levels the wings and bunts; a real
  turn (latched above 2.6 g of turn demand) rolls past ninety and pulls.
- **Dev.** `game.dev.run(id, {special, bot, difficulty})`, `dev.batch(id, n, opts)`,
  `dev.table()`, `dev.runs`: the flying bot (`src/game/dev/Bot.js`), real intents,
  damage on, about 20x real time. Evidence in `docs/v2/evidence/polish-gameplay/`.

- **assets polish: aircraft, ground units, HUD (additive).**
  - `public/models/mig21.glb` is now *baked* (root `mig21`, `extras.baked = 1`: nose -Z,
    unit scale) and carries named, pivoted control surfaces `stab_L/R`, `aileron_L/R`,
    `flap_L/R` (+`rotation.x` = trailing edge down). `Aircraft.js` skips its own
    normalisation for baked roots; `aircraft.surfaces` (`SurfaceRig`,
    `src/assets/controlSurfaces.js`) animates them from `flight.rates` /
    `pitchAuthority` / `rollAuthority` / airspeed. `mig21_hostile` (LOD0 and LOD1) has the
    same pivots; catalog entries list them under `pivots`.
  - New system `game.systems.assets` (`src/assets/system.js`, order 15): drives hostile
    fighter surfaces from their quaternion delta (within 3 km), seats ground units on
    the terrain (slope-aligned vehicles, near-level emplacements, an earth/gravel berm
    child named `foundation` under hanging edges), lays AAA/flak/SAM turrets and
    barrels on their target and sets `unit.aimRig = true` (then `src/ai/ground.js`
    stops turning the whole unit). Base kits (`kind === 'base'`) are left alone.
  - `configureAssets({tier, env})` (`src/assets/loadModel.js`): models loaded after it
    get node materials (aircraft paint/clearcoat/canopy, ground bump + breakup) and cloud
    shadows; on `?quality=low` the canopy stays standard and the paint-roughness,
    clearcoat and ground bump/breakup nodes are skipped.
  - `src/ai/sites.js` `scatterSites` rejects sites steeper than about 20° (relaxing as
    tries run out).
  - HUD: target markers and labels are placed around a keep-out list
    (`src/ui/declutter.js`: tapes, heading, corner panels, banner, radio plate); a marker
    on a tape shrinks to a pip. On a portrait phone the radio plate moves up over the
    objective line while it would cover a marker; on a landscape phone the orders
    banner sits under the tapes (`layout.bannerY`) and the ladder is cut around it.

- **engine perf + robustness (additive).** Details and numbers:
  `docs/v2/evidence/polish-perf/README.md`, tooling: `tools/perf/README.md`.
  - Boot: `src/core/BootLifecycle.js` `createRenderer(canvas, params)` picks
    WebGPU when an adapter and device are actually returned (the probed device is
    passed to `WebGPURenderer({ device })`), else WebGL2 with one `console.info`;
    the `#boot-status` overlay is shown only when neither backend works.
    `window.__boot` holds stage marks (ms since navigation start).
  - Renderer: `r.renderScale` / `r.setRenderScale(s)` (adaptive resolution
    multiplies the tier pixel ratio), `r.poll()` once per frame (DPR and size
    changes; resizes coalesced to one per frame), `r.onLost(info)` and `r.lost`,
    exported `POWER_PREFERENCE` (undefined on Windows). Timestamp queries are on
    by default on WebGPU.
  - Device / context loss: the loop stops and an overlay offers Reload; a second
    loss in the same tab on WebGPU offers "Restart in compatibility mode"
    (`?webgl`). Systems do not need to handle it.
  - Perf: `src/engine/Perf.js` (`installPerf`), `GpuProfiler.js` (three
    `InspectorBase`; per-pass GPU ms by render target / quad material name, so
    **name your RTT/quad materials** if you want them labelled), `AdaptiveResolution.js`,
    `PerfHud.js` (lazy chunk). Flags: `?perfhud`, `?gputime`, `?noadaptive`,
    `?adaptive`, `?gpubudget=ms`, `?scale=`, `?notimestamps`. `window.__perf`
    exists in dev or with `?perfhud`/`?gputime`.
  - PostFX: the auto-exposure / sun-visibility meters render and read back every
    4th frame (`METER_EVERY`), not every frame.
  - Terrain: `VIEW_LAYER = 1`, `SHADOW_LAYER = 2` (exported from Terrain.js).
    Blocks are culled per frame against both the view and the sun shadow frustum
    and carry only the layer they are needed on; the main camera enables layer 1
    and the sun shadow camera layers 0 and 2. Other objects stay on layer 0 and
    are unaffected. CPU copies of terrain textures are released after upload
    (`tex.onUpdate`): do not read `tex.image.data` of terrain textures at runtime
    (use `terrainHeight` etc.).
  - AI: the hostile fighter GLB is preloaded 4 s after the first `flow:state`,
    not during boot.
  - Analytics are not injected on localhost / 127.0.0.1.

### Time of day and night (additive unless marked)

Owner paths: `src/world/timeofday/**`, `src/world/atmosphere/night/**`,
`src/timeofday/system.js`, `tools/sky/**`, `public/assets/sky/**`.
Evidence: `docs/v2/evidence/timeofday/`.

- **API on `game.env`** (installed by `src/world/timeofday/TimeOfDay.js`):
  - `env.setTimeOfDay(hours, { date, transition, weather })`. `hours` is a float
    0..24 of local time (IST, UTC+5:30), or `'HH:MM'`, or a preset name.
    `date` is `{ year, month, day }` (default 1999-06-21; it stays until changed,
    including across missions). `transition` is seconds of smooth blend (takes
    the short way round midnight). A change of under 10 game minutes with no
    other option is a clock tick: no cloud-history reset, so callers may tick it
    every few seconds.
  - `env.timeScale`: game minutes per real second (0 = frozen). Setting it
    leaves manual-sun mode.
  - `env.timePresets`: `dawn` 05:15, `morning` 08:00, `noon` 12:27, `afternoon`
    15:45, `golden` 18:45, `dusk` 19:54, `night` (01:00, 1999-06-14, moonless),
    `moonlit-night` (23:00, 1999-06-28, full moon). `env.setPreset(name)` accepts
    these too; the weather presets are unchanged.
  - Read-only: `env.solarDirection` (true sun, may be below the horizon),
    `env.moonDirection`, `env.moonPhase { fraction, waxing, age }`,
    `env.keyLight` (`'sun' | 'moon'`), `env.night` (0..1), `env.exposureHint`
    (`{ ev, minEV, maxEV, speedDown, night, grade }`).
  - `env.setSun(azimuth, elevation)` still works and switches to manual sun
    (the clock stops driving it) until the next `setTimeOfDay` / `timeScale`.
- **Changed meaning (read this if you light things):** `env.sun` and
  `env.sunDirection` are the *key light*: the sun by day, the moon once the sun
  is about 3.4 degrees below the horizon (cross-faded over 4.5 degrees). The
  direction never goes below 0.6 degrees of elevation. The atmosphere is always
  lit from `env.solarDirection`. Anything that draws a sun disc, glare or flare
  must gate on `env.keyLight === 'sun'`.
- **Ephemeris** (`src/world/timeofday/astro.js`, pure, node-tested): low-precision
  sun and moon series from the Astronomical Almanac / Meeus, topocentric moon,
  site 34.5 N 76.09 E. No refraction. Kargil 1999-06-21: sunrise 05:13, solar
  noon 12:27, sunset 19:41.
- **Night sky** (`src/world/atmosphere/night/`): 8874-star catalogue to V 6.5
  (one instanced additive draw; 2200 on low, 5000 on medium), procedural Milky
  Way and airglow added to the sky dome's colour node, moon disc with phase and
  earthshine. Photometry is compressed, not physical: moonlight and airglow are
  far brighter relative to the sun than in reality so that exposure only has to
  rise by one to two stops at night. `?nonight` removes the sky layer.
- **Exposure and grade:** the `timeofday` system writes
  `post.options.exposure.{baseEV,minEV,maxEV,speedDown}` and scales
  `post.uniforms.{lookSat,shadowTint,highlightTint,vignette}` from their boot
  values each frame, from `env.exposureHint`. It never touches
  `exposureCompensation`. It also writes `post.uniforms.sunRefLum`.
  Moonlight throws no sun flare or glare: the camera system passes
  `keyLight: env.keyLight` in `post.setFrameState` and PostFX gates the flare
  on it (the earlier `setFrameState` wrapper here is gone).
- **Twilight:** below 1.5 degrees of sun elevation `atmosphere.u.sunIrradiance`
  is multiplied by `twilightGain(elevation)` (up to 60x) so civil twilight
  stays a lit sky; the unscaled value is `env.timeOfDay.sunIrradiance`.
- **System `timeofday`** (`src/timeofday/system.js`, order 12):
  `lights` (LightSprites: `add`, `remove`, `removeGroup`),
  `attachNavLights(object3d, opts)`, `attachHeadlights(object3d, opts)`,
  `detachLights(object3d)`,
  `cloudFlash(position, { color, intensity, range, duration })`.
  Nav lights are attached to the player and on `aircraft:spawn`; headlights go
  on the object of the new optional event `vehicle:spawn { entity }` and on
  gameplay's truck `headlights` lamp groups; about 200 village lights sit in
  the valleys (Kargil, Drass, Batalik and others). Explosions flash the clouds
  (two flash slots on low, four otherwise). The cockpit panel emissive is
  dimmed at night.
- **New event:** `timeofday:phase { phase, hours, night, keyLight }` when the
  phase changes (`day`, `twilight`, `night`).
- **URL flags:** `?tod=HH:MM | <preset> | cycle[:minutesPerSecond]`,
  `?from=HH:MM` (cycle start), `?date=YYYY-MM-DD`, `?nonight`. `?preset=` also
  accepts the time presets.
- **Edit outside the owner paths:** `src/world/Environment.js` only, each block
  tagged `[timeofday]`: constructs `env.timeOfDay`, `setSun` records the solar
  direction, `invalidate(environment = true)` gained an argument (false = relight
  without rebuilding the PMREM), `setPreset` accepts time presets and presets
  without a `sun`, `_updateLights` passes sun and ambient through
  `timeOfDay.shade()`, `update()` advances the clock.
- **Requests to other owners:** VFX emissives are absolute and day-calibrated,
  so they read hot at night; scaling them by `env.exposureHint` would let night
  exposure go higher. The cloud shadow map shows horizontal bands with the sun
  under about 2 degrees.

### Camera + post polish: motion blur, screen water, feel, camera direction (additive unless marked)

Owner paths: `src/engine/PostFX.js`, `src/fx/**`, `src/flight/CameraRig.js`,
`src/camera/**`. Evidence: `docs/v2/evidence/polish-camera-post/` (`before-*` and
`after-*`, same scenarios).

- **Motion blur (changed).** The single-pass velocity blur is replaced by a
  tile-max / neighbour-max reconstruction (McGuire 2012 with Jimenez's
  alternating taps; `src/fx/post/motionBlur.js`): prep (full res) -> 4x4 max ->
  tile max (tier `mbTile` px) -> 3x3 neighbour max -> jittered, depth-aware
  gather (`mbSamples` taps: 0/10/14/18 by tier; off on low). Fixed shutter time
  (1/90 s, so the streak per second does not depend on frame rate), radial speed
  zoom fast and low and a little at Mach 1, camera rotation blur in rolls.
  Parameters are pure and tested: `src/fx/post/motionParams.js`.
  - `post.usePlayerVelocity(material)` tags a material as the player airframe
    (velocity MRT `.z = 1`); it gets its own short shutter
    (`MOTION_DEFAULTS.playerShutter`). The camera system tags the player jet
    and cockpit; glass keeps `useTransparentVelocity`.
- **Screen water (new).** `src/fx/post/screenWater.js`: a small GPU simulation
  (tier `water` size, 320x180 to 640x360) of beads, runs and wet trails, a fog
  film wiped by speed, drying; refraction, meniscus, glints in the final pass.
  Lens in chase-like views, canopy in the cockpit (masked to the glass by
  depth), none in cinematic / kill / death cams. Frost rime at the frame edge in
  cold cloud. Drivers are pure and tested: `src/fx/waterModel.js`
  (`waterDrivers`, `rainFrom`). Rain comes from `env.weather.rain`, else
  `env.rain`, else a heuristic: the storm preset under the cloud base.
- **post.options (new keys):** `screenWater` (bool), `speedStreaks` (bool),
  `dof` (bool). `grain` now actually toggles the grain (it was unused).
  URL: `?nowater`, `?nodof`.
- **post.setFrameState (new optional fields):** `agl`, `mach`, `view`,
  `flightDir` (unit vector), `nearShell` (m, player shell for the blur),
  `reheat`, `keyLight` (`'sun' | 'moon'`, flare/glare only for the sun),
  `water` (drivers + `gravity` [x, y] in screen uv + `surface`
  `'lens' | 'canopy'`, or null), `waterSurface`, `streaks` (0..1), `shock`
  (ripple phase 0..1) and `shockAmp`,
  `dof` (`{amount, focus, focal}` or null). All default off.
- **Grade / lens (changed values).** Film grain fades with metered scene
  luminance (dusk and night ~0.35x). Starburst and halo toned down; anamorphic
  streak is a thin core plus sheath; lens dirt lights only above a bloom floor;
  sharpen after TRAA is luminance-only and clamped. Depth of field
  (three's `DepthOfFieldNode`) runs only while a cinematic, kill or death cam
  asks for it (pass skipped otherwise; not on low).
- **cameraRig.options (new keys):** `fovEffects` 0..1, `actionCam` (bool,
  cinematic dogfight angles in the chase view; `?actioncam`), `slowMo` (bool),
  `sortieIntro` (bool), `headBob` 0..1, `cameraLag` 0.4..1.5, `dof` (bool).
  Existing: `shake`, `reducedMotion`, `killCam`, `missileCam`.
  `game.systems.camera.setOption(key, value)` sets a rig option and mirrors
  `dof` / `screenWater` / `speedStreaks` / `reducedMotion` to `post.options`.
- **cameraRig API (new):** `fovPulse(amount)`, `sonicThump(dir)`,
  `missileEnded(missile, reason)` (impact slow-mo when `reason === 'hit'`),
  `playCinematic(name, { blend, blendOut })`, `stopCinematic(name?)`,
  `cinematicName`, `warp` (`TimeWarp`, writes `game.timeScale` relative to
  its base and restores it), `dofOut`. Views: `lock` (spring framing of
  jet + bandit), `missile`, `kill` (orbit, slow-mo, auto-return, aborts in
  danger), `death`, `action`. Blends back to a riding view keep the jet in frame.
  `cameraRig.view` can now also be `'action'`.
- **Cinematics (changed):** `title` is a looping trailer of four shots composed
  right of centre (clear of the menu; `opts.shift`), `sortie` (new) is the
  briefing -> sortie shot (skippable with fire or camera; never in danger).
  Cinematic `out` gained `shift`, `cut`, `dof`.
- **Events:** new `camera:sonic { direction: +1 | -1, mach }` on a Mach 1
  crossing; listens to `missile:end` (to the rig) and `flow:state`.
- **Dev:** `window.__camTest(name)` scenarios (`lowpass`, `roll`, `cloud`,
  `rain`, `cockpitRain`, `kill`, `lock`, `sun`, `title`, `sortie`) and
  `__camTest.reset()` (dev builds only, `src/camera/dev.js`);
  `game.systems.camera.weatherOverride = { rain }`; `post.debugView` gains
  `'player'`, `'mbTiles'`, `'water'` (call `post.rebuild()` after setting).
- **Removed:** `velocityMotionBlur` from `src/fx/post/nodes.js` (replaced).

### Glass and water polish (additive unless marked)

Owner paths: the glass branch of `src/assets/materials.js` (tagged `[glass]`),
`src/assets/glass.js` (new), `src/world/water/**`, the water terms of
`src/world/terrain/material.js` (tagged `[water]`). Evidence:
`docs/v2/evidence/polish-glass-water/`.

- **Aircraft glass (changed).** Canopy and `glass_misc` materials are now
  premultiplied-alpha node materials (`premultipliedGlassClass(Base)` in
  `src/assets/glass.js` skips three's premultiply; rgb is reflected light, alpha
  is Fresnel coverage). They set their own `mrtNode` (velocity `vec4(0)`), so
  `post.useTransparentVelocity` leaves them alone; anything that rebuilds a
  glass material's `mrtNode` must keep velocity at zero in all channels.
  `userData.glass` and `lightsNode = lights([env.sun])` are unchanged.
- **glass.js API (new):** `premultipliedGlassClass(Base)`,
  `setupGlass(material, { canopy, low, box })` (box = mesh-local bounds; the eye
  inside them = cockpit view), `setupLensGlass(material, { low })`,
  `bindGlassEnv(env)` (key light for the dust scatter; called by
  `upgradeAircraftMaterials` when `env` is passed).
- **River (changed look, same mesh and terrain API).** `src/world/water/river.js`
  `riverSurface(...)` now also returns `rapids`; new exports
  `riverReflection({ n, viewDir, skyVis, foam })` -> `{ ao, wall, sky }`
  (horizon specular occlusion via the AO input, valley-wall radiance to add to
  emissive) and `wallRadiance` (uniform, read from the scene's
  `HemisphereLight`). The terrain material adds a wet bank margin (albedo and
  roughness) outside the water.

### Shadows polish: sun / moon, terrain and cloud shadows (changed where marked)

Owner paths: `src/world/shadows/**` (new) and the blocks tagged `[shadows]` in
`src/world/Environment.js`, `src/world/terrain/{Terrain,shadowSweep,material}.js`
and `src/world/clouds/Clouds.js`. Evidence: `docs/v2/evidence/polish-shadows/`.

- **Sun shadow (changed).** The 120 m box that followed the player is replaced
  by cascades fitted to the game camera: `env.sunShadows`, from
  `installSunShadows` in `src/world/shadows/SunShadows.js`.
  - Tiers in `shadowMath.js` `SUN_SHADOW_TIERS`: 2 to 4 cascades, 260 m to 1200 m.
  - Filter: PCSS on WebGPU at medium and above. On low and on WebGL2, a disc
    PCF with a fixed radius.
  - `env.sun.shadow.shadowNode` is a `CSMShadowNode`. Read cascade cameras from
    `env.sunShadows.node.lights[i].shadow`, not from `env.sun.shadow.camera`.
  - Casters are on layers 0 and `SHADOW_LAYER`, as before.
  - `env.sunShadows.update(camera, keyLight)` runs inside `env.update`. With
    the moon as key light, it switches to the moon's angular size.
- **Terrain no longer casts into the sun shadow map (changed)**
  (`SHADOW_CAST_CELL = 0`). The terrain's self-shadow is only the heightfield
  sweep, so the old caster culling in `Terrain.update` now culls nothing.
- **`env.terrainShadow` (new):** a TSL `Fn(positionWorld) -> float` built from
  the heightfield sweep (`ShadowSweep.makeShadowFn`), set by `Terrain`.
  - It is 0 inside terrain shadow.
  - It fades to no effect between 36 m and 46 m above the DEM ground, because
    the 8-bit sweep saturates at 47.75 m.
  - It is null without a terrain.
- **`env.applyCloudShadow(material, { terrain = true })` (changed):**
  - It also multiplies `env.terrainShadow` into the received shadow, so units
    and props in a ridge's shadow are no longer sunlit. To skip this, pass
    `{ terrain: false }` or set `material.terrainLit`.
  - It adds the hook to the material's program cache key. three's
    `customProgramCacheKey` ignores `receivedShadowNode`, so otherwise two
    materials that differ only by the hook share one shader.
  - It is still idempotent. `Terrain`'s constructor sets `terrainShadow`
    right after `Environment` is built, so it exists before any model loads.
  - Call it again after `material.clone()`.
- **Terrain `applyShadowHooks` (changed):** the cloud and sweep shadows apply at
  every distance. The old "inside the shadow box" gate is gone.
- **Cloud shadow map (changed look, same API):** the march integrates at most
  `CLOUD_SHADOW_PATH` (8 km) of the sun ray, with a per-texel jitter.
  - At a low sun it no longer draws bands. This answers the time-of-day
    section's request about bands with the sun under about 2 degrees.

### Texture polish: terrain, aircraft, cockpit, ground units (additive unless marked)

Owner paths: the terrain texture layers and the albedo / normal / detail terms of
`src/world/terrain/material.js` (tagged `[textures]`), `src/world/terrain/layers.js`,
`src/assets/materials.js` (not the glass branch), `public/models/**`,
`tools/terrain/fetch-textures.mjs` and `tools/blender/`. Evidence:
`docs/v2/evidence/polish-textures/`.

- **Terrain layers (changed).** The layer arrays now have 7 layers: `talus`
  (Poly Haven `gray_rocks`) is appended as index 6, and the indices of the other
  layers are unchanged. `scree` is now `rock_ground_02`. Code that sizes
  anything from the layer count should read `LAYERS.length`, not assume 6.
- **Terrain anisotropy (changed):** the medium tier is now 8 (it was 4), and
  high and ultra are 16 (they were 8). The value is clamped to the device
  maximum, and low stays at 2.
- **`configureAssets({ ..., anisotropy })` (new option):** this is the device's
  maximum texture anisotropy. `src/assets/system.js` passes
  `renderer.getMaxAnisotropy()`. Model textures (base colour, normal, ORM,
  emissive) are set to it at upgrade time, or to 4 on the low tier. GLTFLoader
  leaves them at 1.
- **`materials.js` exports (new):**
  - `setTextureAnisotropy(n)`.
  - `setGroundDetail({ albedo, layer, meanLum })`. This hands the terrain's
    layer array to `upgradeGroundMaterials`, which adds a 0.45 m triplanar
    grain to ground units. It is called once by `src/assets/system.js` after
    the terrain is built. Without it, ground units render as before.
- **Model textures (changed look, same API):**
  - Aircraft and cockpit base colour gets an in-shader unsharp mask on medium
    and above.
  - The `/pitot/` mesh is dark metal instead of the exporter's magenta.
  - The cockpit atlas in `mig21.glb` is 2048 px. Byte sizes are in
    `catalog.js`.

### Models polish: pilot, nav lights, ground units and weapons (additive unless marked)

Owner paths: `tools/blender/build_pilot.py`, `tools/blender/assets_ground.py` and
`assets_weapons.py` (tagged `[models polish]`), `src/assets/pilot.js`,
`src/world/timeofday/lights/**`. Evidence: `docs/v2/evidence/polish-models/`.

- **Pilot asset (new):** `pilot` / `pilot_lod1` in `catalog.js` (kind `pilot`,
  pivot `pilot_head`, socket `pilot_eye`), in aircraft-model space (nose -Z,
  +Y up, metres). It is not part of `mig21.glb`; it is parented at runtime.
  - `src/assets/system.js` adds LOD0 to `game.player.model` and exposes
    `game.systems.assets.pilot`, a `PilotRig`. Its head is hidden in the
    `cockpit` and `hud` views.
  - `src/assets/pilot.js` (new, no three import): `HEAD_LIMITS`,
    `headAim(dir)`, `turnLook(bank, g)`, and `PilotRig.update(dt, { target,
    bank, g, firstPerson })`.
- **Hostile jets (changed):** `hostileFighterModel()` in `src/ai/models.js` now
  returns a `THREE.LOD` named `hostile-lod`. LOD0 is `mig21_hostile` plus the
  pilot LOD1, and `mig21_hostile_lod1` takes over at 600 m
  (`HOSTILE_LOD1_DISTANCE`). Code that searched the returned object's direct
  children for meshes should traverse instead.
- **Nav lights (changed):**
  - `attachNavLights(sprites, obj, opts)` takes `wing`, `tail`, `spine` and
    `belly` positions. The old `halfSpan` / `wingZ` / `wingY` options are gone.
  - The defaults are `MIG21_LAMPS` (new export of `fixtures.js`), measured on
    the mesh's lamp lenses.
- **`LightSprites.add(..., opts)` (new options):**
  - `daySize` scales the sprite by day; it is mixed to 1 at night.
  - `dir` / `cone` set an emission lobe: the model-space direction and the
    cosine cut-off. The lobe is omnidirectional when `dir` is omitted.
  - Internally, `lightRange` is now a vec2 `(range, daySize)` and there is a new
    `lightDir` vec4 attribute.
- **MiG wingtip sockets (changed):** `wingtipL/R` are now `(∓3.64, -0.777,
  2.74)`, on the real tips. They were a bounding-box guess 0.7 m off.
  `Aircraft.js` and `write-catalog.mjs` agree.
- **Ground units and weapons (changed geometry, same nodes and sockets):**
  - The Blender `wheel()` helper is now a lathe tyre with tread lugs. Pass
    `tread=False` for track road wheels.
  - The truck is resized to Ural-4320 dimensions.
  - The radar dish is a true paraboloid cut, aimed up.
  - The sangar sandbags now sit on the wall.
  - `bomb` is now FAB-250 sized (1.92 x 0.30 m). Socket names are unchanged,
    and the `tail` / `fuze` / `exhaust` / `feed` positions moved with the
    geometry.
- **Foundation berm snow (changed look):** each berm geometry carries a
  `siteSnow` attribute (0..1) from `siteSnow(heightAt, x, z)` (new export of
  `src/assets/system.js`).
  - It replaces the fixed 4700-4950 m band.
  - It mirrors the terrain material's snow-line terms: altitude, aspect, DEM
    curvature, detail height and slope shedding.
  - If `material.js` changes its `snowLine` / `snowRaw` formula, update
    `siteSnow` to match.
- **Models polish 2 (pilot, truck, ground units, weapons; same nodes, pivots and sockets):**
  - Every non-MiG GLB now ships base colour + tangent-space normal + ORM
    (WebP, meshopt) and exports tangents. The normal map carries rounded
    edges (Cycles bevel bake) and surface relief; LOD1 shares the LOD0 UVs.
  - `src/assets/materials.js` `upgradeGroundMaterials` no longer discards a
    GLB's normal map: when `material.normalMap` exists the detail bump is
    layered on it (`bumpMap(height, scale, normalMap(...))`); models without
    one behave as before.
  - `pilot.glb` uses a baked material flagged `noDetail` and renders its own
    normal map. `pilot` > `pilot_body` / `pilot_head` (pivot at the neck top)
    and socket `pilot_eye` are unchanged.
  - Truck family is rebuilt in `tools/blender/assets_truck.py`; shared props
    (wheels, sandbags, stones, crates, drums) live in
    `tools/blender/ground_parts.py`. Single mesh node `body`, socket
    `exhaust` as before.
  - Catalogue bounds are regenerated. Scattered rubble, guy lines and debris
    are excluded from the bounds (`Asset.footprint`) so `seatUnit` foundations
    keep the size of the structure.
  - Pipeline options: `tools/blender/gltf-pipeline.mjs` `optimize()` takes
    `normalTexture` / `ormTexture` sizes; `optimize-glb.mjs` takes `--ntex` /
    `--otex`. `tools/blender/montage.mjs` tiles evidence screenshots.
  - Evidence: `docs/v2/evidence/polish-models-2/README.md`.
