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
