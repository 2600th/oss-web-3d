# Audit Remediation — Design

**Source:** deep audit of core systems and graphics pipeline, 16 August 2026, against
commit `902e1da`. Published report:
<https://claude.ai/code/artifact/5fc37ed6-e763-4193-9330-05f96724d3f6>

## Thesis

Two observations drive everything here.

**The engine is ahead of the art direction.** Terrain self-shadowing, a Hillaire atmosphere
with multiple-scattering LUTs, soft-particle depth fade and a budgeted incremental clipmap
generator are all implemented and correct. What flattens the image is a set of *constants*:
a 46° sun, shadow floors lifted to 0.30/0.42, a `0.22` direct-sun scale, fixed per-material
ambient additions, and base AGX with no look transform.

**The replayability engine is built and unused.** Terrain is deterministic from world
coordinates and effectively infinite; `findPostSites()` already takes an origin. `START` is
hardcoded, so every sortie is byte-identical.

## Measured baseline (RTX 5090, 1920×889, high tier)

| Quantity | Value |
| --- | --- |
| Tests | 246 pass |
| Raw frame | 0.49 ms at 1.71 MP |
| Fragment slope | 0.242 ms/MP |
| Fixed cost | ~0.67 ms (62% of frame at 1080p) |
| Triangles | 1,034k |

Consequence: **resolution is cheap, pass count and draw submission are expensive**, and
there is a large unused GPU budget relative to the RTX 2060 Mobile target.

---

## Defects to fix

### F1 — `Enter` on the record card destroys the sortie
`Game.js:622-626`. With `state` in `complete`/`failed`, `Enter` calls `restart()`. `Enter`
is also the manual shutter key. No confirmation. The player loses the contact sheet and the
chance to record a leaderboard time.

**Required:** `Enter` must not restart from a finished sortie. Restart stays available via an
explicit control.

### F2 — Line of sight stops 10% short of the target
`TerrainVisibility.js:8-24`. The march runs `t` from `first = 0.05` to `last = 0.9`. The far
margin is proportional, so at 3 km the last 300 m are untested. A post behind a ridge can
score a perfect plate, and the navigation cue reports a blocked target as clear.

**Required:** a fixed metric standoff at the far end (~25 m), independent of range.

### F3 — Sortie clock counts time the physics discarded
`Game.js:684-695`. Fixed-step accumulator at `PHYSICS_STEP = 1/120` with `MAX_STEPS = 6`
(50 ms simulated per frame max), then `if (steps === MAX_STEPS) this.accumulator = 0`.
`mission.update(dt, …)` advances the sortie timer by wall `dt`. Below 20 fps the simulation
runs in slow motion while the clock does not, so leaderboard times are not comparable
across hardware.

**Required:** the mission clock advances by *simulated* time (consumed physics steps), not
wall time.

### F4 — HUD text is unreadable against snow
`styles.css` — primary HUD text measures 1.07:1 against sunlit snow; the recon quality
legend 1.28:1. Only the tape readouts carry a local scrim.

**Required:** ≥ 4.5:1 effective contrast for HUD text over the brightest terrain, achieved
without a heavy opaque panel (the HUD's restraint is deliberate).

### F5 — Audio beds run on indefinitely when the tab is hidden
`Audio.js` — backgrounding mid-flight leaves the engine and wind beds at their last gain.

**Required:** beds duck to silence on `visibilitychange` to hidden and restore on return.

### F6 — The live cloud shadow target renders for nobody
`CloudVolume.js:713-734` allocates a 256×256 "Live cloud transmittance" target, renders it,
and exposes it via `getShadowContract()`, which has **zero callers**. Terrain cloud shadows
come from the analytic `cloudShadowAt()` march in `clouds.glsl.js:474`.

**Required:** stop producing the unread target.

### F7 — HUD tape tick pool runs out on tall viewports
`Hud.js:158` — the pool is a fixed count, so tapes truncate above ~1000 px of viewport
height.

**Required:** size the pool from viewport height, rebuilt on resize.

### F8 — The depth texture is allocated from post-pass needs only
`Engine.syncDepthTexture()` (`Engine.js:219-234`) polls `pass.needsDepthTexture` across
composer passes. The cloud billboards (`CloudField`) and the GPU FX materials are **scene**
consumers, invisible to that poll, so they ride on whatever the post chain happens to want.

Measured live by cycling the quality menu:

| tier | `stableDepthTexture` | `uSoftEnabled` |
| --- | --- | --- |
| high | present | 1 |
| medium | NULL | 0 |
| low | NULL | 0 |
| phone | NULL | 0 |

Soft particles are therefore dead on three of four tiers, **including `medium`, which is the
tier the RTX 2060 Mobile design target auto-selects** (`Settings.js` puts the 20-series on
medium). Cloud billboards cut a hard straight line into terrain there.

**Required:** scene-level consumers declare a depth requirement that `syncDepthTexture`
honours. Phone tier is decided empirically — the soft-depth define costs a texture fetch on
the most fill-bound geometry in the frame, so it may stay off there deliberately.

### F9 — FX soft-particle depth never compiles in
`setSceneDepth()` has one production caller, `Game.js:157`, in the constructor.
`registerFxMaterial` sets the `FX_SOFT_DEPTH` define only if the texture already exists at
registration time, and the composer allocates it in `applySettings`, *after* `Game` is
constructed. The per-frame rebind at `Game.js:658-663` repairs `cloudField` and `clouds` but
not `setSceneDepth`. Measured on high tier: **0 of 8 FX materials** carry the define.

**Required:** `setSceneDepth` participates in the same per-frame rebind.

### Post-chain defects (018)
- **Bloom is thresholded before auto-exposure** (`Engine.js:110-111` orders `bloomPass`
  before `tonePass`), so bloom depends on scene radiance rather than delivered brightness and
  drifts across the meter's 2.25 EV range.
- **Dither amplitude is linear-light** (`DitherEffect.js`, `1.4/255`) while banding occurs
  after the sRGB transfer — several times too strong in the darks.
- **SMAA edge detection runs on linear values with a gamma-space threshold.**
- **Motion blur's optical-centre uniform is declared, read, never driven**
  (`MotionBlurEffect.js:44`) — radial blur always streaks from screen centre.
- **Heat distortion is anchored to a hard-coded screen point** (`HeatDistortionEffect.js:10`)
  that never tracks the exhaust.
- **Lens flare ghosts have no aspect correction** (`LensArtifactsEffect.js:16`) — 1.78×
  horizontal stretch on 16:9.
- **The recon optic gets no exposure compensation**; the full-frame meter lags the zoom by
  2–3 s, exactly while framing and auto-capture are judged.
- **`fxCurl` normalises its output** (`noise.glsl.js:153`), destroying the divergence-free
  property its documentation claims.

### Other confirmed defects
- **`window.__sagar` referenced but never defined** (`Screens.js:512`).
- **An uncaught error raises a permanent fatal overlay over a running game** (`main.js:58`);
  **context loss shows the overlay but never stops the frame loop or mission clock**
  (`main.js:181`).
- **The CPU height-field fallback produces zero terrain shadows** (`Terrain.js:569`).
- **A 512-step CPU ray march recomputes a constant every frame** (`atmosphere/lut.js:398`).
- **The lake batch re-uploads ~3.2 MB** whenever lake ordering changes (`Water.js:243`).
- **A secured post can never be re-photographed** (`Game.js:852`), so imagery quality is
  decided by one auto-fired frame.
- **`renderToTarget` reallocates the whole composer twice per photograph**
  (`Engine.js:519,531`).
- **Documented behaviour that does not exist:** terrain-bounce ambient
  (`atmosphere/constants.js:64`), `AIRCRAFT.rateDamping` (`FlightModel.js:80`), a
  crack-prevention fragment discard whose absence is test-enforced (`Terrain.js:74`), and a
  clipmap triangle budget documented 4× below what ships (`Terrain.js:18`).
- **Vendor chunk split does not happen** (`vite.config.js:14`) — the chunk named `three`
  holds GLTFLoader and meshoptimizer; three core ships inside the chunk named
  `postprocessing`. Hypothesis: Vite 8 is rolldown-based and `manualChunks` is not honoured
  the way Rollup's was; rolldown's native mechanism is `output.advancedChunks`.
- **`__audit()` reads `renderer.info` at the wrong point** — reports `calls: 1,
  triangles: 1` while the debug panel shows `tris 1034k`.
- **README claims 250 tests; 246 pass.**

---

## Design changes

### D1 — Seed the sortie
`START` (`Game.js:70`) is constant and `findPostSites(origin, count)` is a pure deterministic
search. Vary the origin from a seed so each sortie is a different neighbourhood of the same
infinite deterministic world. A **daily seed** gives every player the same world on a given
day, which is what makes a shared leaderboard meaningful.

### D2 — Give a search area, not a waypoint
The briefing says positions are *unconfirmed* and asks the player to *locate* each post, but
`NavigationHint.js` and `Mission.js:107-123` supply exact bearing and range from frame one.
Replace with a probable-area cue until the post has been visually acquired once; then the
precise solution unlocks. This is what makes the posts' long-range legibility design matter.

### D3 — Per-sortie time of day and weather
Architecturally almost free: all systems share the same uniform objects (`Environment.js:6-8`);
transmittance and multiple-scattering LUTs are parameterised by *sun zenith* so they never
need rebuilding when the sun moves; skyView and aerial LUTs already re-render dynamically;
and terrain regeneration is already a budgeted incremental job. Pick sun elevation/azimuth and
cloud coverage per sortie from the same seed as D1.

### D5 — Harness versus leaderboard
`main.js` ships ~450 lines of `window.__*` ungated in production. `__fly()`/`__toPost()`
teleport. The game keeps a fastest-sortie leaderboard. Mark harness-assisted sorties so the
board stays honest.

### G1 / G2 — Scoring
Measured: a scripted approach returns `framing 0.944, coverage 1.0, rangeQuality 1.0,
angleQuality 1.0 → score 0.983`. Three of four sub-scores pin at 1.0, so EXCELLENT is the
default outcome. And no term depends on aircraft state, so optimal play is slow, high and
stable — the opposite of the premise.

Tighten the bands so grades discriminate, and add a term that rewards the flying the game is
about.

### G3 — Radar altimeter
The HUD altitude tape is MSL. AGL appears only in the `?debug` panel, despite the premise
("terrain is the only thing out here that can end the sortie") and an existing
terrain-proximity warning.

### G5 — Readable plates
On the record card each captured plate is a dark smudge in a field of white. Crop toward the
target so the five images the game exists to produce are legible.

### E1 — FOV-aware clipmap
`terrain.update(position, budget)` has no `fov` input while the optic narrows to 4×, so the
payoff shot is the lowest-fidelity view in the game. Scale level-transition radii and the
detail fade by `tan(defaultVFov/2) / tan(currentVFov/2)`.

---

## Global constraints

- **Node 20.19+ / 22.12+**, Vite 8, WebGL2 only. Two runtime deps: `three@^0.185.1`,
  `postprocessing@^6.39.4`. Do not add runtime dependencies.
- **Shaders live in `*.glsl.js` template literals.** `npm run check` lints them; it must pass.
- **`material.glsl.js` holds both a JS mirror and the GLSL and they share formulas.** Any
  lighting change lands in both; `material.test.mjs` enforces agreement.
- **`heightfield.js` mirrors `terrainNoise.glsl.js`.** Same rule.
- **Tests are plain `node:test` beside the code.** `node --test "src/**/*.test.mjs"` must pass.
  Tests encode contracts — when a fix changes a contract, update the test with its new
  rationale; never delete a test to make a change pass.
- **Quality tiers are `phone`, `low`, `medium`, `high`.** `medium` is the reference-hardware
  tier and must not regress.
- **Design target: ≥ 30 fps at 1080p on RTX 2060 Mobile class.**
- **Accessibility is a shipped feature**: focus trapping, `prefers-reduced-motion`, keyboard/
  gamepad/touch parity. Do not regress it.
- **Tone:** the subject is treated with restraint. Remembrance stays separate from score.
