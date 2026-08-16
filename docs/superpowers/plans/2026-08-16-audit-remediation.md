# Audit Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix every defect found in the 16 August 2026 audit and land the design, gameplay and visual changes it recommends, without regressing the 246-test suite or the `medium`-tier performance target.

**Architecture:** Work proceeds in dependency order on branch `audit-fixes`. Correctness defects land first (they are contract-shaped and each gets a `node:test` regression). Then lighting constants, which are subsumed into a new per-sortie parameter system so the sun is not tuned twice. Then scoring and HUD, then engine and post-chain, then documentation alignment, and finally a bounded structural extraction from `Game.js`.

**Tech Stack:** three.js 0.185, postprocessing 6.39, Vite 8 (rolldown), WebGL2, plain `node:test`, GLSL in `*.glsl.js` template literals.

**Spec:** `docs/superpowers/specs/2026-08-16-audit-remediation-design.md`

## Global Constraints

- Node 20.19+ / 22.12+. Vite 8. WebGL2 only.
- Runtime dependencies are frozen at `three@^0.185.1` and `postprocessing@^6.39.4`. Add none.
- `npm run check` (GLSL template lint) must pass. `npm run build` must succeed.
- `node --test "src/**/*.test.mjs"` must pass. Baseline is 246 tests passing.
- `src/world/terrain/material.glsl.js` contains a **JS mirror and the GLSL side by side, sharing formulas**. Every lighting change lands in both. `src/world/terrain/material.test.mjs` enforces agreement.
- `src/world/heightfield.js` mirrors `src/world/terrainNoise.glsl.js`. Same rule.
- Tests encode contracts. When a fix changes a contract, **update the test with its new rationale — never delete a test to make a change pass.**
- Quality tiers are `phone`, `low`, `medium`, `high`. **`medium` is the reference-hardware tier** (RTX 2060 Mobile) and must not regress.
- Accessibility is a shipped feature: focus trapping, `prefers-reduced-motion`, keyboard/gamepad/touch parity. Do not regress it.
- Commit per task using the repo's existing style (`fix:`, `feat:`, `docs:`). Never `git add .` — stage named paths.


## Status — 16 August 2026

Branch `audit-fixes`. 251 tests pass, `npm run check` and `npm run build` clean.

**Landed:** F1 (Enter/debrief), F2 (line of sight — plus a second defect the test
uncovered: fixed 30-sample spacing stepped over ridges at range), F3 (sortie clock on
simulated time), F4 (HUD halo), F5 (audio on tab hide), F7 (tape ticks), F8+F9 (composer
depth for scene consumers — soft particles restored on medium/low), F10 (adaptive scaler
saw a pre-clamped delta, so its occlusion guard was unreachable), V1+V3 (sun elevation,
shadow floors, elevation-scaled sky fill, ambient occlusion from the baked shadow term),
V2 (look transform after AGX) plus a snow-albedo correction, D1+D3 (seeded sortie: origin,
sun and weather), E1 (detail fade by apparent size), E5 (advancedChunks), G1+G2 (scoring
terms, energy term, grade bands), G3 (AGL readout), and most of Task 13.

**Retracted — the audit was wrong:** D5 and the `__sagar` item. The `window.__*` harness
does not ship; `main.js:205` wraps it in `import.meta.env.DEV`, verified against `dist/`.

Also landed after the first pass: D2 (sector and range band until a position is visually
acquired), G5 (plates cropped toward the objective), re-photography via the manual shutter,
E3 (capture no longer runs a full resize), and four of the 018 post-chain items — lens-flare
aspect correction, heat shimmer anchored to the exhaust, the motion-blur optical centre
(declared and read by the shader since day one but never written), and the tone look's toe
lift, which was an S-curve that darkened the very shadows it claimed to protect.

**Adversarial branch review.** Four dimension reviewers over `git diff main...audit-fixes`,
each followed by a verifier instructed to refute. 22 raw claims, 13 survived. All the
confirmed ones are fixed: the AGL readout was being clipped away entirely by the altitude
tape's `overflow: hidden` (my own live check used `getBoundingClientRect`, which cannot see
clipping); a throw inside the rAF callback froze the game silently once stray errors stopped
being fatal; context loss stopped the loop but left the audio beds running; the AGL change
guard stored a number where `set()` keeps a string, so it rewrote the node every frame; the
caution colour referenced an undefined `--warn`; `terrainDetailWeight`'s JS mirror never
gained the `uZoomScale` factor its GLSL twin did; and switching to phone left FX materials
holding a freed depth texture for one frame.

**Deferred, with reasons:** F6 (the unread cloud shadow target — removal is entangled with
two near-duplicate update paths in a 1,138-line file for a scissored 32x256 stripe per
frame; an A/B was inconclusive and the risk outweighs the gain). E6 (Game.js extraction).
The remaining 018 items: bloom-after-exposure ordering (needs a threshold retune and a
careful look at what should still bloom), the dither transfer-curve fix, SMAA's gamma-space
threshold on linear values, recon exposure compensation, and `fxCurl`'s normalisation.
V4/V6/V7/G4/D4 were roadmap items, not defects, and were never in this plan.

---

## File structure

| File | Responsibility after this plan |
| --- | --- |
| `src/game/sortieParams.js` | **New.** Derives a whole sortie — origin, sun elevation/azimuth, cloud coverage — from one seed. Pure, testable, no three.js scene access. |
| `src/game/sortie-params.test.mjs` | **New.** Contract tests for the above. |
| `src/game/Game.js` | Shrinks. Loses water-refraction batching and post-effect driving (Task 12); gains the sortie-parameter wiring. |
| `src/game/WaterRefraction.js` | **New (Task 12).** Extracted refraction target management and batching. |
| `src/game/PostEffectDriver.js` | **New (Task 12).** Extracted per-frame post-effect parameter driving. |
| `src/game/TerrainVisibility.js` | Fixed far margin. |
| `src/game/Mission.js` | Clock advances on simulated time; exposes `advance(simDt)`. |
| `src/game/ReconCamera.js` | Discriminating score bands, plus an energy term. |
| `src/core/Engine.js` | Scene-consumer depth requirement; dedicated capture target; pass reorder. |
| `src/world/Environment.js` | Sun becomes settable from sortie parameters. |
| `src/world/terrain/material.glsl.js` | Sun scale, shadow floors and ambient become elevation-aware — **JS mirror and GLSL together.** |
| `src/ui/Hud.js` | Viewport-sized tick pool; AGL tape. |
| `src/fx/Audio.js` | Visibility-aware bed ducking. |

---

## Task 1: `Enter` must not destroy a finished sortie (F1)

**Files:**
- Modify: `src/game/Game.js:622-626`
- Test: `src/game/mission.test.mjs` (append)

**Interfaces:**
- Produces: no signature change. Behavioural contract only.

- [ ] **Step 1: Write the failing test**

Append to `src/game/mission.test.mjs`:

```js
test('Enter never restarts a finished sortie, because Enter is the shutter key', () => {
  // Mirrors the dispatch in Game._handleGlobalKeys: briefing launches on Enter,
  // but a finished sortie must not, or the contact sheet and the unrecorded
  // leaderboard time are destroyed by the key the player has been pressing for
  // the whole flight.
  const restartable = (state) => state === 'briefing';
  assert.equal(restartable('briefing'), true);
  assert.equal(restartable('complete'), false);
  assert.equal(restartable('failed'), false);
});
```

- [ ] **Step 2: Run it and watch it pass trivially, then make it real**

Run: `node --test src/game/mission.test.mjs`
This test documents intent; the behavioural change is in Step 3. Keep it — it is the
rationale record.

- [ ] **Step 3: Change the dispatch**

In `src/game/Game.js`, replace:

```js
    if ((this.state === 'briefing' || this.state === 'complete' || this.state === 'failed') &&
        input.consumePress('Enter')) {
      if (this.state === 'briefing') this.launch();
      else this.restart();
    }
```

with:

```js
    // Enter launches from the briefing only. It is also the manual shutter, so
    // accepting it on the debrief let the key the player has been pressing all
    // sortie wipe the contact sheet and an unrecorded leaderboard time. Restart
    // is an explicit button on the debrief screen.
    if (this.state === 'briefing' && input.consumePress('Enter')) {
      this.launch();
    }
```

- [ ] **Step 4: Verify the debrief still offers restart**

Run: `grep -n "FLY AGAIN\|onRestart\|restart" src/ui/Screens.js | head`
Expected: the debrief's "FLY AGAIN" button already calls back into restart. If it does not,
wire `screens.onRestart = () => this.restart()` in `Game.js` where the other screen callbacks
are registered (near `onQuality`).

- [ ] **Step 5: Run the suite**

Run: `node --test "src/**/*.test.mjs"`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/game/Game.js src/game/mission.test.mjs
git commit -m "fix: stop Enter destroying a finished sortie"
```

---

## Task 2: Line of sight must not stop short of the target (F2)

**Files:**
- Modify: `src/game/TerrainVisibility.js`
- Test: `src/game/integration/recon-camera.test.mjs` (append)

**Interfaces:**
- Produces: `terrainVisibility(from, to, heightAt)` — unchanged signature, corrected far margin.

- [ ] **Step 1: Write the failing test**

Append to `src/game/integration/recon-camera.test.mjs`:

```js
test('a ridge close to the target still blocks the shot at long range', () => {
  // The far margin used to be 10% of the range, so at 3 km the last 300 m went
  // untested and a post directly behind a ridge scored a clear plate.
  const from = { x: 0, y: 1000, z: 0 };
  const to = { x: 3000, y: 1000, z: 0 };
  // Ground is flat and low everywhere except a wall 200 m short of the target.
  const heightAt = (x) => (x > 2780 && x < 2860 ? 2000 : 0);
  assert.equal(terrainVisibility(from, to, heightAt), 0);
});
```

Add the import at the top of that file if absent:
```js
import { terrainVisibility } from '../TerrainVisibility.js';
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test src/game/integration/recon-camera.test.mjs`
Expected: FAIL — returns 1 (clear), because the sample range stops at t = 0.9.

- [ ] **Step 3: Replace the proportional far margin with a metric standoff**

In `src/game/TerrainVisibility.js`, replace the body up to the loop:

```js
export function terrainVisibility(from, to, heightAt = terrainHeight) {
  const steps = 30;
  const first = 0.05;
  const last = 0.9;
```

with:

```js
/** Metres of standoff at each end, so neither endpoint occludes itself. */
const NEAR_STANDOFF = 60;
const FAR_STANDOFF = 25;

export function terrainVisibility(from, to, heightAt = terrainHeight) {
  const steps = 30;
  const span = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z);
  if (span < NEAR_STANDOFF + FAR_STANDOFF) return 1;
  // Fixed metric standoffs, not fractions of the range. A proportional far
  // margin left the last 10% of every sight line untested — 300 m at 3 km —
  // so a post directly behind a ridge returned a perfect plate.
  const first = NEAR_STANDOFF / span;
  const last = 1 - FAR_STANDOFF / span;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test src/game/integration/recon-camera.test.mjs`
Expected: PASS.

- [ ] **Step 5: Run the full suite and check nothing regressed**

Run: `node --test "src/**/*.test.mjs"`
Expected: all pass. If an existing visibility test now fails, read it — a shot that used to
score may now be legitimately blocked. Update the test's expectation *and* its comment to
record why.

- [ ] **Step 6: Commit**

```bash
git add src/game/TerrainVisibility.js src/game/integration/recon-camera.test.mjs
git commit -m "fix: test the full sight line to the objective"
```

---

## Task 3: The sortie clock counts simulated time (F3)

**Files:**
- Modify: `src/game/Mission.js:103`, `src/game/Game.js:684-697`
- Test: `src/game/mission.test.mjs` (append)

**Interfaces:**
- Produces: `Mission.update(dt, aircraftPosition, simDt = dt)` — third parameter is simulated
  seconds actually integrated this frame. Callers that omit it keep the old behaviour.

- [ ] **Step 1: Write the failing test**

```js
test('the sortie clock counts simulated time, not wall time', () => {
  // Below 20 fps the fixed-step loop caps at MAX_STEPS and discards the rest,
  // so the aircraft flies less far than the wall clock says. Ranking sorties by
  // wall time made leaderboard entries incomparable across hardware.
  const mission = new Mission(new THREE.Scene(), new THREE.Vector3(0, 0, 0), 1);
  mission.update(0.5, new THREE.Vector3(0, 0, 0), 0.05);
  assert.ok(Math.abs(mission.elapsed - 0.05) < 1e-9,
    `expected 0.05 simulated seconds, got ${mission.elapsed}`);
  mission.dispose();
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test src/game/mission.test.mjs`
Expected: FAIL — `elapsed` is 0.5.

- [ ] **Step 3: Accept simulated time in Mission**

In `src/game/Mission.js`, change the signature and the accumulate line:

```js
  update(dt, aircraftPosition, simDt = dt) {
    // The clock advances on time the physics actually integrated. The fixed-step
    // loop discards leftover time once it hits MAX_STEPS, so on a slow machine
    // wall time and simulated time diverge — and the leaderboard ranks this.
    this.elapsed += simDt;
```

- [ ] **Step 4: Feed it from the physics loop**

In `src/game/Game.js`, the accumulator block becomes:

```js
    this.accumulator += dt;
    let steps = 0;
    while (this.accumulator >= PHYSICS_STEP && steps < MAX_STEPS) {
      flight.update(PHYSICS_STEP, this._flightControlForStep(PHYSICS_STEP));
      if (!flight.crashed && flight.checkTerrainCollision(PHYSICS_STEP)) {
        this.onCrash();
      }
      this.accumulator -= PHYSICS_STEP;
      steps++;
    }
    if (steps === MAX_STEPS) this.accumulator = 0;
    const simDt = steps * PHYSICS_STEP;
```

and the mission call at `Game.js:697` becomes:

```js
    this.mission.update(dt, flight.position, simDt);
```

- [ ] **Step 5: Run tests**

Run: `node --test "src/**/*.test.mjs"`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/game/Mission.js src/game/Game.js src/game/mission.test.mjs
git commit -m "fix: rank sorties on simulated time, not wall time"
```

---

## Task 4: Scene consumers get the depth texture they need (F8, F9)

This is the highest-value fix in the plan: it restores soft particles on `medium`, the
reference-hardware tier.

**Files:**
- Modify: `src/core/Engine.js:219-234`
- Modify: `src/game/Game.js:157-164`, `src/game/Game.js:658-663`
- Test: `src/fx/post/postEffects.test.mjs` (append)

**Interfaces:**
- Produces: `Engine.setSceneDepthRequired(required: boolean)` — declares that something in the
  *scene* (not the post chain) reads the composer depth texture. `syncDepthTexture()` honours
  it alongside `pass.needsDepthTexture`.

- [ ] **Step 1: Write the failing test**

```js
test('a scene consumer keeps the depth texture alive when no pass wants one', () => {
  // CloudField and the GPU FX materials read composer depth but are scene
  // objects, not passes, so polling pass.needsDepthTexture alone left them
  // without a texture on every tier that disables the depth-reading passes —
  // medium, low and phone, i.e. the reference hardware.
  const composer = fakeComposer({ passesNeedDepth: false });
  const engine = fakeEngine(composer);
  engine.setSceneDepthRequired(true);
  engine.syncDepthTexture();
  assert.notEqual(composer.stableDepthTexture, null);
});
```

Use the existing fake/stub helpers in `postEffects.test.mjs`; if none fit, build the minimal
object literal that `syncDepthTexture` touches: `{ passes: [], stableDepthTexture, createDepthTexture(), deleteDepthTexture() }`.

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test src/fx/post/postEffects.test.mjs`
Expected: FAIL — `setSceneDepthRequired` is not a function.

- [ ] **Step 3: Implement in Engine**

In the constructor, near the other flags:

```js
    this._sceneWantsDepth = false;
```

Add the setter:

```js
  /**
   * Declare that something in the *scene* reads the composer depth texture.
   *
   * The cloud billboards and every GPU FX material sample it for their soft
   * edge, but they are scene objects, not passes, so `pass.needsDepthTexture`
   * cannot see them. They used to ride on whatever the post chain happened to
   * want, which on medium, low and phone is nothing — so soft particles were
   * dead on three tiers including the one the reference GPU selects.
   */
  setSceneDepthRequired(required) {
    const next = Boolean(required);
    if (this._sceneWantsDepth === next) return;
    this._sceneWantsDepth = next;
    this.syncDepthTexture();
  }
```

and change the first line of `syncDepthTexture()`:

```js
    const wantsDepth = this._sceneWantsDepth
      || this.composer.passes.some((pass) => pass.needsDepthTexture);
```

- [ ] **Step 4: Declare the requirement from Game, per tier**

In `src/game/Game.js`, replace the one-shot binding block at `:157-164` with a call that both
declares the need and does the first bind, and extend the per-frame rebind at `:658-663` to
include `setSceneDepth`:

```js
    // Soft particles read composer depth. Declaring the need here is what makes
    // the composer allocate the texture on tiers whose post chain wants none.
    // Phone stays off: the define costs a texture fetch on the most fill-bound
    // geometry in the frame, which is the wrong trade on that hardware.
    this._sceneDepthTier = settings.tier.name !== 'phone';
    engine.setSceneDepthRequired(this._sceneDepthTier);
    engine.renderer.getDrawingBufferSize(this._waterDrawingSize);
    this.clouds.initialize(engine.renderer);
    this._syncSceneDepth();
```

Add the helper, and call it from the per-frame block that already exists:

```js
  /**
   * Re-read the composer's depth texture and push it to every scene consumer.
   *
   * The composer swaps this texture whenever a depth-reading pass is added or
   * removed, and it allocates it in applySettings — after Game's constructor.
   * setSceneDepth() in particular compiles a define into every FX material, and
   * binding it once at construction meant it compiled against a null texture and
   * every particle system spent the session with hard edges.
   */
  _syncSceneDepth() {
    const depth = this.engine.composer.stableDepthTexture;
    if (depth === this._cloudDepthTexture) return;
    this._cloudDepthTexture = depth;
    this.cloudField.setDepthTexture(depth);
    this.clouds.setDepthTexture(depth);
    setSceneDepth(depth, this._waterDrawingSize.x, this._waterDrawingSize.y);
  }
```

Replace the old inline block at `:658-663` with `this._syncSceneDepth();`.

In `setQuality()`, after `this.settings.setTier(tier)`, add:

```js
    this._sceneDepthTier = this.settings.tier.name !== 'phone';
    this.engine.setSceneDepthRequired(this._sceneDepthTier);
```

- [ ] **Step 5: Run tests, check and build**

Run: `node --test "src/**/*.test.mjs" && npm run check && npm run build`
Expected: all pass.

- [ ] **Step 6: Verify live — this is the whole point of the task**

Start `npm run dev`, open the app, and in the console:

```js
const g = window.game, e = g.engine;
for (const tier of ['high','medium','low','phone']) {
  g.setQuality(tier); await new Promise(r => setTimeout(r, 2500));
  let total = 0, soft = 0;
  e.scene.traverse(o => { const m = o.material;
    if (m?.defines && m.userData?.fxSoftDepth !== undefined) { total++; if ('FX_SOFT_DEPTH' in m.defines) soft++; } });
  console.log(tier, e.composer.stableDepthTexture ? 'depth' : 'NULL',
    g.cloudField.material.uniforms.uSoftEnabled.value, `${soft}/${total} fx`);
}
```

Expected: `high`, `medium` and `low` report `depth`, `uSoftEnabled 1`, and every FX material
carrying the define. `phone` reports `NULL / 0` deliberately.

- [ ] **Step 7: Commit**

```bash
git add src/core/Engine.js src/game/Game.js src/fx/post/postEffects.test.mjs
git commit -m "fix: allocate composer depth for scene consumers, not just passes"
```

---

## Task 5: HUD legibility, tick pool, audio lifecycle, dead cloud target (F4, F5, F6, F7)

Four small independent fixes; one commit each.

**Files:**
- Modify: `src/ui/styles.css`, `src/ui/Hud.js:155-160`, `src/fx/Audio.js`, `src/world/CloudVolume.js:713-734`
- Test: `src/ui/ui.test.mjs`, `src/fx/audio-lifecycle.test.mjs`

- [ ] **Step 1: F7 — size the tick pool from the viewport**

In `src/ui/Hud.js`, replace the fixed pool:

```js
      const ticks = [];
      for (let i = 0; i < 26; i++) {
```

with a pool sized to the tallest tape the viewport can produce:

```js
      // One tick per step across the tape, plus two for the partial ones that
      // scroll in at each end. A fixed pool of 26 truncated the tape on any
      // viewport taller than about 1000 px.
      const tapeHeight = Math.max(320, Math.round(window.innerHeight * 0.62));
      const count = Math.ceil(tapeHeight / (step * pixelsPerUnit)) + 2;
      const ticks = [];
      for (let i = 0; i < count; i++) {
```

Rebuild on resize: in the Hud's existing resize handler (or add one that mirrors
`Engine._onResize`), call `this._rebuildTapes()` when `window.innerHeight` changes by more
than 10%. Cache `this._tapeViewportHeight` to avoid rebuilding on every resize event.

Test in `src/ui/ui.test.mjs`:

```js
test('the tape tick pool covers a tall viewport', () => {
  // A fixed 26-tick pool truncated the altitude tape above ~1000 px, because
  // ALT steps 250 m at 0.062 px/m — 15.5 px per tick.
  const step = 250, pixelsPerUnit = 0.062;
  const tapeHeight = Math.round(1440 * 0.62);
  const count = Math.ceil(tapeHeight / (step * pixelsPerUnit)) + 2;
  assert.ok(count * step * pixelsPerUnit >= tapeHeight,
    'pool must span the full tape height');
});
```

Commit: `git commit -m "fix: size HUD tape ticks from the viewport"`

- [ ] **Step 2: F4 — make HUD text readable over snow**

In `src/ui/styles.css`, give the HUD text layer a paint-order scrim rather than a panel, so
the restraint of the design survives. Add to the rule that styles `.hud-plate` text
(objective label, range, bearing, throttle, and the tape readouts that lack one):

```css
  /* Sunlit snow measures ~1.07:1 against the HUD's light grey. A text shadow
     rather than a filled panel keeps the instrument reading transparent while
     lifting contrast over the brightest terrain the game can render. */
  text-shadow:
    0 1px 2px rgba(6, 10, 16, 0.92),
    0 0 6px rgba(6, 10, 16, 0.72);
```

For the recon quality legend (`.recon-legend` or equivalent at `styles.css:1262`), add the
same shadow plus `background: rgba(6, 10, 16, 0.42); padding: 0.15em 0.5em; border-radius: 2px;`.

Verify by eye against `docs/screenshots/05-lowlevel.jpg`'s brightest region: run the app,
`__fly({x:20547, z:13500, agl:260, speed:240})`, and confirm the objective label reads
cleanly over snow.

Commit: `git commit -m "fix: lift HUD text contrast over sunlit snow"`

- [ ] **Step 3: F5 — duck the audio beds when the tab hides**

In `src/fx/Audio.js`, add to the class:

```js
  /**
   * Silence the continuous beds while the tab is hidden.
   *
   * requestAnimationFrame stops, so update() stops, so the engine and wind beds
   * hold their last gain forever — a jet at cruise power in a background tab.
   */
  _installVisibility(target = globalThis.document) {
    if (!target?.addEventListener) return;
    this._onVisibility = () => {
      const hidden = target.visibilityState === 'hidden';
      const now = this.ctx?.currentTime ?? 0;
      for (const gain of this._bedGains) {
        gain.gain.cancelScheduledValues(now);
        gain.gain.setTargetAtTime(hidden ? 0 : gain.userData.target ?? 1, now, 0.08);
      }
    };
    target.addEventListener('visibilitychange', this._onVisibility);
  }
```

Collect the continuous bed gain nodes into `this._bedGains` where they are created, and stash
their intended level on `gain.userData.target` when `update()` sets it. Remove the listener in
`dispose()`.

Test in `src/fx/audio-lifecycle.test.mjs`:

```js
test('hiding the tab silences the continuous beds', () => {
  const doc = fakeDocument();          // existing helper in this file
  const audio = new Audio();
  audio._installVisibility(doc);
  doc.visibilityState = 'hidden';
  doc.fire('visibilitychange');
  for (const gain of audio._bedGains) assert.equal(gain.gain.lastTarget, 0);
});
```

Commit: `git commit -m "fix: silence the audio beds while the tab is hidden"`

- [ ] **Step 4: F10 — make the adaptive scaler's occlusion guard reachable**

`Engine._adapt` opens with `if (dt > 0.25) return;` and fourteen lines explaining that this
rejects the ~1 Hz frames Chrome delivers to an occluded-but-not-hidden window. But the only
production caller already clamps: `main.js:157` does
`const dt = Math.min(engine.timer.getDelta(), 0.1)` before `engine.render(dt)` at `:159`.
`_adapt` can never see a value above 0.1, so **the guard is dead code and the regression it
documents is live**. `adaptive-scale.test.mjs` misses it because it calls `engine._adapt()`
directly, bypassing the clamp.

Pass the unclamped delta alongside the simulation delta so the scaler can see what the
browser really did:

```js
// main.js
const rawDt = engine.timer.getDelta();
const dt = Math.min(rawDt, 0.1);   // simulation must not teleport through a mountain
game.update(dt);
engine.render(dt, rawDt);
```

```js
// Engine.render / _adapt
  render(dt, rawDt = dt) {
    this._adapt(rawDt);
```

Add a test that feeds `_adapt` the *unclamped* 1 s samples an occluded window produces and
asserts `renderScale` stays at 1 — the case the current suite cannot express:

```js
// A covered window gets ~1 Hz frames. Those say nothing about our cost, and
// dropping resolution cannot buy back time we never spent.
const h = harness();
h.run(1.0, 40);
assert.equal(h.engine.renderScale, 1, 'an occluded window must not move render scale');
```

Commit: `git commit -m "fix: let the adaptive scaler see the unclamped frame time"`

- [ ] **Step 5: F6 — stop rendering the unread cloud shadow target**

`getShadowContract()` has zero callers; terrain cloud shadows come from the analytic
`cloudShadowAt()` in `clouds.glsl.js:474`. In `src/world/CloudVolume.js`, delete
`_shadowTarget`, `_shadowMaterial`, `shadowContract`, `getShadowContract()`, the shadow
render call in `update()`, and the shadow entry in the memory report near `:766`. Keep
`_shadowStripe`/`_shadowCenterStep` only if the terrain stripe refresh still uses them —
check `Game.js:654` (`this.clouds.update(renderer, null, dt)`) before removing.

Run `node --test "src/**/*.test.mjs"`; the cloud tests assert a "cloud shadow orientation
contract" — if that test covers the deleted target rather than the analytic path, update it
to assert the analytic function instead, with a comment saying the rendered target was
removed as unread.

Commit: `git commit -m "perf: drop the cloud shadow target nothing sampled"`

---

## Task 6: Lighting that lets the shadow bake show (V1, V3, and the 0.22 sun scale)

**Files:**
- Modify: `src/world/terrain/material.glsl.js` — **JS mirror at ~:291-460 and GLSL at ~:670-820, together**
- Modify: `src/world/Environment.js`
- Test: `src/world/terrain/material.test.mjs`

**Interfaces:**
- Produces: `terrainLighting({ ..., sunElevation })` — the JS mirror gains the same
  elevation input the shader reads from `uSunDir.y`, so both sides stay verifiable.

- [ ] **Step 1: Write the failing test**

In `src/world/terrain/material.test.mjs`:

```js
test('direct sun outweighs sky ambient on a sunlit snow face', () => {
  // The shipped scale was min(uSunIntensity * 0.22, 1.25) = 0.33 against a flat
  // snow ambient of (0.185, 0.245, 0.365) plus sky irradiance, so the blue term
  // equalled or beat the sun on every fragment. That is why frame means came
  // back blue and nothing reached white.
  const lit = terrainLighting({ ndl: 0.9, snow: 1, storedShadow: 1, cloudShadow: 1 });
  assert.ok(lit.direct > lit.ambientLuma * 1.8,
    `direct ${lit.direct} should dominate ambient ${lit.ambientLuma}`);
});

test('a shadowed snow face is far darker than a lit one', () => {
  // Floors of 0.30 and 0.42 capped snow shadow contrast at about 0.6 EV; a real
  // Himalayan snowfield shows three to four stops.
  const lit = terrainLighting({ ndl: 0.9, snow: 1, storedShadow: 1, cloudShadow: 1 });
  const shadowed = terrainLighting({ ndl: 0.9, snow: 1, storedShadow: 0, cloudShadow: 1 });
  const stops = Math.log2(lit.lightingProxy / shadowed.lightingProxy);
  assert.ok(stops > 1.8, `expected > 1.8 stops of shadow contrast, got ${stops.toFixed(2)}`);
});
```

Expose `ambientLuma` from the JS mirror's return alongside `lightingProxy` if it is not
already there.

- [ ] **Step 2: Run to verify it fails**

Run: `node --test src/world/terrain/material.test.mjs`
Expected: FAIL on both.

- [ ] **Step 3: Raise the sun's authority and deepen the floors — in both mirrors**

GLSL side (`~:804` and `~:814`):

```glsl
        float visibility = mix(0.06, 1.0, stored.a) * mix(0.34, 1.0, cloudShadowAt(vWorld, uSunDir));
        ...
        vec3 color = albedo * (ambient + uSunColor * min(uSunIntensity * 0.62, 2.4) * direct);
```

and at `~:677` (the low-tier path):

```glsl
        float direct = wrapped * mix(0.12, 1.0, stored.a) * mix(0.64, 1.0, snow);
```

JS mirror — the matching lines at `~:346` and `~:416`:

```js
    const direct = wrapped * mix(0.12, 1, clamp01(storedShadow)) * (0.64 + 0.36 * snow);
    ...
  const visibility = mix(0.06, 1, clamp01(storedShadow)) * mix(0.34, 1, clamp01(cloudShadow));
```

and the same `0.62 / 2.4` sun scale wherever the mirror computes `lit`.

- [ ] **Step 4: Make the fixed ambient scale with sun elevation, both mirrors**

Replace the four constant ambient additions (`~:809-813` GLSL, `~:425-433` JS) with terms that
fall as the sun drops, so a low sun no longer leaves the scene lit by pure blue:

```glsl
        // Sky fill tracks the sun. These were fixed constants, which meant a low
        // sun produced a scene lit almost entirely by blue sky — the cyan cast
        // the audit measured at meanRGB 105/133/160.
        float skyFill = 0.35 + 0.65 * clamp(uSunDir.y * 1.6, 0.0, 1.0);
        vec3 ambient = atm_skyIrradiance(N) * (rockWeight * 0.25 + scree * 0.29 + ice * 0.39 + snow * 0.43);
        ambient += vec3(0.105, 0.115, 0.135) * rockWeight * skyFill;
        ambient += vec3(0.135, 0.115, 0.095) * scree * skyFill;
        ambient += vec3(0.075, 0.165, 0.275) * ice * skyFill;
        ambient += vec3(0.185, 0.245, 0.365) * snow * skyFill;
```

Mirror it in JS with the same `skyFill` expression driven by the `sunElevation` input.

- [ ] **Step 5: Lower the sun**

In `src/world/Environment.js`, the constructor default becomes a mid-low sun. Leave the fields
writable — Task 7 drives them from the sortie seed.

```js
    // A low sun is what gives the ray-marched shadow bake something to do. At 46
    // degrees the shadows were short and the terrain read as smooth clay.
    this.sunAzimuth = THREE.MathUtils.degToRad(122);
    this.sunElevation = THREE.MathUtils.degToRad(24);
```

and warm the light with elevation-appropriate colour:

```js
      uSunColor: { value: new THREE.Color(1.0, 0.88, 0.74) },
```

with `hemiLight` intensity dropped from `1.05` to `0.62`.

- [ ] **Step 6: Run tests, check, build**

Run: `node --test "src/**/*.test.mjs" && npm run check && npm run build`
Expected: pass. `material.test.mjs` verifies GPU/CPU agreement — if it fails, the two mirrors
have diverged. Fix the mirror, do not relax the test.

- [ ] **Step 7: Verify live against the audit's own metric**

`__fly({x:20547, z:13500, agl:300, speed:235})`, then `__stats(9)`.
Expected: `max` climbs toward 255 (was 204.3), `meanRGB` red/blue gap narrows substantially
(was 105.6/133.1/160.1), and `histogram16`'s top buckets stop being empty.

- [ ] **Step 8: Commit**

```bash
git add src/world/terrain/material.glsl.js src/world/Environment.js src/world/terrain/material.test.mjs
git commit -m "feat: let the terrain shadow bake and the sun actually show"
```

---

## Task 7: Sortie parameters from a seed (D1, D3, E4)

**Files:**
- Create: `src/game/sortieParams.js`
- Create: `src/game/sortie-params.test.mjs`
- Modify: `src/game/Game.js` (`START`, `_startPosition`, `load`, `restart`), `src/world/Environment.js`

**Interfaces:**
- Produces:
  - `dailySeed(now = Date.now()): number` — UTC-day-stable seed.
  - `sortieParams(seed: number): { seed, origin: {x, z}, sunElevationDeg, sunAzimuthDeg, cloudCoverage, label }`
  - `Environment.setSun(elevationDeg, azimuthDeg)` — updates `sunDir`, the light, and marks
    the atmosphere LUTs dirty.

- [ ] **Step 1: Write the failing test**

`src/game/sortie-params.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { dailySeed, sortieParams } from './sortieParams.js';

test('the same seed always describes the same sortie', () => {
  const a = sortieParams(12345);
  const b = sortieParams(12345);
  assert.deepEqual(a, b);
});

test('different seeds move the sortie somewhere else entirely', () => {
  const a = sortieParams(1);
  const b = sortieParams(2);
  const moved = Math.hypot(a.origin.x - b.origin.x, a.origin.z - b.origin.z);
  assert.ok(moved > 20000, `expected a different neighbourhood, moved ${moved} m`);
});

test('the sun stays in a flyable, photogenic band', () => {
  for (let s = 0; s < 200; s++) {
    const p = sortieParams(s);
    assert.ok(p.sunElevationDeg >= 12 && p.sunElevationDeg <= 38,
      `elevation ${p.sunElevationDeg} outside the band at seed ${s}`);
    assert.ok(p.cloudCoverage > 0 && p.cloudCoverage < 0.0012);
  }
});

test('a daily seed is stable across a UTC day and changes across the boundary', () => {
  const morning = Date.UTC(2026, 7, 16, 6, 0, 0);
  const evening = Date.UTC(2026, 7, 16, 23, 0, 0);
  const nextDay = Date.UTC(2026, 7, 17, 6, 0, 0);
  assert.equal(dailySeed(morning), dailySeed(evening));
  assert.notEqual(dailySeed(morning), dailySeed(nextDay));
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test src/game/sortie-params.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/game/sortieParams.js`:

```js
/**
 * One seed describes one whole sortie.
 *
 * The terrain is a pure function of world coordinates and is effectively
 * infinite, and findPostSites() already takes an origin — so the only thing
 * that ever made every sortie identical was a hardcoded START. Moving the
 * origin is all it takes to make the world new, and moving the sun with it is
 * nearly free because the atmosphere LUTs are parameterised by sun zenith
 * rather than baked against a fixed sun.
 */

/** Deterministic 32-bit hash. Same seed, same sortie, on every machine. */
function hash(seed, salt) {
  let h = (seed ^ salt) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/** Unit float in [0, 1) from a seed and a salt. */
function unit(seed, salt) {
  return hash(seed, salt) / 4294967296;
}

/** The seed everyone flying today shares. Stable across a UTC day. */
export function dailySeed(now = Date.now()) {
  return Math.floor(now / 86400000);
}

/**
 * The sortie origin walks a wide annulus around the world's centre rather than
 * a disc, so no seed lands on ground the previous one already covered.
 */
export function sortieParams(seed) {
  const angle = unit(seed, 0x9e3779b9) * Math.PI * 2;
  const radius = 60000 + unit(seed, 0x85ebca6b) * 340000;
  return {
    seed,
    origin: {
      x: Math.round(Math.cos(angle) * radius),
      z: Math.round(Math.sin(angle) * radius),
    },
    // 12-38 degrees: low enough that the shadow bake reads, high enough that
    // valleys are not solid black and the objectives stay findable.
    sunElevationDeg: 12 + unit(seed, 0xc2b2ae35) * 26,
    sunAzimuthDeg: unit(seed, 0x27d4eb2f) * 360,
    // Matches the shipped uCloudCoverage scale (0.00055 default).
    cloudCoverage: 0.00028 + unit(seed, 0x165667b1) * 0.00062,
    label: `SEED ${String(seed).padStart(6, '0')}`,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test src/game/sortie-params.test.mjs`
Expected: PASS.

- [ ] **Step 5: Give Environment a settable sun**

In `src/world/Environment.js`:

```js
  /**
   * Move the sun. Everything shares these uniform objects, so terrain, sky,
   * clouds and aircraft all follow with no per-frame plumbing. The transmittance
   * and multiple-scattering LUTs are parameterised by sun zenith, so they never
   * need rebuilding — only the sky-view and aerial LUTs, which already
   * regenerate on their own cadence.
   */
  setSun(elevationDeg, azimuthDeg) {
    this.sunElevation = THREE.MathUtils.degToRad(elevationDeg);
    this.sunAzimuth = THREE.MathUtils.degToRad(azimuthDeg);
    this._updateSunDir();
    this.sunLight.position.copy(this.sunDir).multiplyScalar(1000);
    // Warmer and dimmer as it drops, the way a real low sun reddens.
    const t = Math.min(1, Math.max(0, (elevationDeg - 8) / 34));
    this.uniforms.uSunColor.value.setRGB(1.0, 0.76 + 0.16 * t, 0.56 + 0.26 * t);
    this.uniforms.uSunIntensity.value = 1.15 + 0.5 * t;
    this.sunDirty = true;
  }
```

- [ ] **Step 6: Wire it into Game**

Replace the `START` constant with seed-derived state. In `Game.js`:

```js
import { dailySeed, sortieParams } from './sortieParams.js';
```

In the constructor, alongside the other state:

```js
    // `?seed=N` pins a sortie for sharing or debugging; otherwise everyone
    // flying today gets the same world, which is what makes the board mean
    // something.
    const requested = Number(new URLSearchParams(location.search).get('seed'));
    this.sortie = sortieParams(Number.isFinite(requested) && requested !== 0
      ? requested >>> 0
      : dailySeed());
```

`_startPosition()` becomes:

```js
  _startPosition() {
    const { x, z } = this.sortie.origin;
    return new THREE.Vector3(x, terrainHeight(x, z) + 1500, z);
  }
```

In `load()` and `restart()`, before priming terrain, apply the sortie's light and weather:

```js
    this.environment.setSun(this.sortie.sunElevationDeg, this.sortie.sunAzimuthDeg);
    this.environment.uniforms.uCloudCoverage.value = this.sortie.cloudCoverage;
```

`restart()` re-rolls only when the daily seed has rolled over — otherwise the same day is the
same world:

```js
    this.sortie = sortieParams(dailySeed());
```

Delete the now-unused `const START = ...` at `Game.js:70` and the `_setupCinematic` hardcoded
centre — derive it from `this.sortie.origin` the same way.

- [ ] **Step 7: Move siting off the boot critical path (E4)**

`findPostSites` runs ~30,000 heightfield evaluations synchronously. That was tolerable once;
it is now per-sortie. Change `Mission`'s constructor to accept a prepared site list and add:

```js
/**
 * Yield between rings so a 1,040-candidate search does not block the frame.
 * Terrain generation already uses this shape (Terrain.js:528-576).
 */
export async function findPostSitesAsync(origin, count, onProgress) { /* ... */ }
```

Await it in `Game.load()` between the existing `setProgress(0.75, 'Preparing reconnaissance
sites')` and `setProgress(1)` calls, feeding `onProgress` into `setProgress`.

- [ ] **Step 8: Run everything**

Run: `node --test "src/**/*.test.mjs" && npm run check && npm run build`

- [ ] **Step 9: Verify live**

Load `?seed=1` and `?seed=2` and confirm `__mission()` returns different positions, and that
the sky and shadows differ. Confirm `?seed=1` twice returns identical positions.

- [ ] **Step 10: Commit**

```bash
git add src/game/sortieParams.js src/game/sortie-params.test.mjs src/game/Game.js src/game/Mission.js src/world/Environment.js
git commit -m "feat: derive the whole sortie from a daily seed"
```

---

## Task 8: Scoring that discriminates and rewards the flying (G1, G2)

**Files:**
- Modify: `src/game/ReconCamera.js:200-230`, `:450-458`
- Test: `src/game/integration/recon-camera.test.mjs`

**Interfaces:**
- Produces: `evaluate(post, flightState)` gains an optional second argument
  `{ speed, agl }`; omitting it scores exactly as before minus the energy term.

- [ ] **Step 1: Write the failing test**

```js
test('a lazy high slow pass no longer scores EXCELLENT', () => {
  // Measured on the shipped build: framing 0.944, coverage 1.0, rangeQuality
  // 1.0, angleQuality 1.0 -> 0.983. Three of four terms pinned, so EXCELLENT
  // was the default outcome and the grade taught the player nothing.
  const lazy = evaluateFixture({ offset: 0.06, range: 1200, depression: 0.4, speed: 120, agl: 2200 });
  assert.notEqual(gradeFor(lazy), 'EXCELLENT');
});

test('a fast low oblique pass is what earns the top grade', () => {
  const committed = evaluateFixture({ offset: 0.02, range: 900, depression: 0.5, speed: 250, agl: 500 });
  assert.equal(gradeFor(committed), 'EXCELLENT');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test src/game/integration/recon-camera.test.mjs`

- [ ] **Step 3: Tighten the bands**

The `band()` plateaus are wide enough that a scripted approach pins them. Narrow each so the
plateau is the genuinely good shot rather than the acceptable one:

```js
  result.coverage = band(fraction, 0.14, 0.30, 0.62, 1.10);
  result.rangeQuality = band(range, 260, IDEAL_RANGE_MIN, IDEAL_RANGE_MAX * 0.78, HARD_RANGE_MAX);
  result.angleQuality = band(depression, 0.02, 0.22, 0.58, 1.00);
  result.framing = clamp01(1 - offset / 0.62);
```

- [ ] **Step 4: Add the energy term**

```js
  // The premise is a 250 m/s run through valleys, but nothing in the score
  // depended on how the aircraft was flown, so the optimal play was to loiter
  // high and slow. This is the term that makes the fantasy and the scoring
  // agree.
  const speedTerm = flightState ? band(flightState.speed, 90, 170, 320, 420) : 0.7;
  const aglTerm = flightState ? band(flightState.agl, 60, 150, 900, 2600) : 0.7;
  result.energy = 0.5 * speedTerm + 0.5 * aglTerm;

  result.score =
    result.visibility *
    (0.24 * result.framing +
      0.20 * result.coverage +
      0.18 * result.rangeQuality +
      0.20 * result.angleQuality +
      0.18 * result.energy);
```

Add `energy: 0` to the cached result object built at `:166-176` and reset it at `:186`.

- [ ] **Step 5: Pass flight state from the caller**

In `Game.js`, wherever `recon.evaluate(post)` is called (`_evaluateBest`, `_updateAutoCapture`),
pass `{ speed: flight.velocity.length(), agl: flight.position.y - terrainHeight(flight.position.x, flight.position.z) }`.

- [ ] **Step 6: Show the new term in the recon HUD**

The overlay already explains *why* a shot is weak from the breakdown. Add `energy` to that
readout so the player can learn what changed.

- [ ] **Step 7: Run tests, verify live**

`node --test "src/**/*.test.mjs"`, then `__recon(4, 1200, 4)` and confirm the sub-scores no
longer all read 1.0.

- [ ] **Step 8: Commit**

```bash
git add src/game/ReconCamera.js src/game/Game.js src/game/integration/recon-camera.test.mjs
git commit -m "feat: score the flying, not just the framing"
```

---

## Task 9: Instruments and the record card (G3, G5, plus re-photography)

**Files:**
- Modify: `src/ui/Hud.js`, `src/ui/styles.css`, `src/ui/Screens.js`, `src/game/Game.js:852`
- Test: `src/ui/ui.test.mjs`

- [ ] **Step 1: G3 — radar altimeter**

Add an AGL readout beneath the altitude tape, styled as a secondary instrument, that switches
to a warning colour below 300 m. The terrain-proximity system already computes ground
clearance — feed the same value rather than recomputing.

```js
  // AGL is the number that matters in a game where terrain is the only threat,
  // and it was visible only in the ?debug panel.
  this.aglReadout = el('div', 'agl-readout', this.plate, '—');
```

Test: `assert.ok(hud.aglReadout.classList.contains('warn'))` below 300 m.

Commit: `git commit -m "feat: put AGL on the HUD"`

- [ ] **Step 2: G5 — legible plates**

In `Screens.js`, where the record card builds each thumbnail, crop toward the target rather
than showing the whole plate. `ReconCamera` already knows the target's NDC position at
capture — store it on the photo record and use it as a CSS `object-position` with a zoom:

```js
    // Each plate is a dark camp in a field of white; at thumbnail size the
    // whole frame reads as an empty snowfield. Crop to what the sortie was for.
    img.style.objectFit = 'cover';
    img.style.transform = `scale(2.2)`;
    img.style.objectPosition = `${50 + photo.targetNdc.x * 50}% ${50 - photo.targetNdc.y * 50}%`;
```

Commit: `git commit -m "feat: crop record-card plates to the objective"`

- [ ] **Step 3: Allow re-photography of a secured post**

`Game.js:852` prevents re-capture, so quality is decided by one auto-fired frame. Allow a
later capture to *replace* the stored plate when it scores higher, and say so in the notice
bar ("MARBLE — IMAGERY IMPROVED"). Keep the objective counted as secured throughout.

Commit: `git commit -m "feat: let a better plate replace a secured one"`

---

## Task 10: The search, and an honest board (D2, D5)

**Files:**
- Modify: `src/game/Mission.js`, `src/game/NavigationHint.js`, `src/ui/NavigationCue.js`, `src/ui/Screens.js`, `src/game/Leaderboard.js`, `src/main.js`

- [ ] **Step 1: D2 — probable area instead of a waypoint**

Give each post an `acquired` flag, set the first time it evaluates above a low visual
threshold (reuse `MIN_CAPTURE_SCORE * 0.4`). Until then:

- `Mission.bearingTo()` returns a bearing quantised to 15° and a range bucketed to the nearest
  5 km, presented as `RAVEN · NORTH-EAST · 15-20 KM`.
- `NavigationCue` draws a probable-area arc rather than a point marker.

After acquisition the existing precise readout returns unchanged. Add a notice on first
acquisition: `RAVEN ACQUIRED — POSITION CONFIRMED`.

Test in `src/game/navigation-hint.test.mjs`: an unacquired post reports a bucketed range; an
acquired one reports metres.

Commit: `git commit -m "feat: make the player find the posts"`

- [ ] **Step 2: D5 — RETRACTED, do not implement**

The audit's premise was false. The whole `window.__*` harness sits inside
`if (import.meta.env.DEV)` (`main.js:205`), which also encloses the
`Object.assign(window, { THREE, engine, game, settings, input })` at its end. Verified
against the built bundle — every hook greps to zero in `dist/assets/`:

```bash
for s in __fly __toPost __recon __gpuBench __probeGLSL __audit __stats __mission __crashVfx; do
  grep -c "$s" dist/assets/*.js; done   # all zero
```

The leaderboard was never reachable from the harness in a shipped build. Skip this step.

---

## Task 11: Engine and post chain (E1, E3, E5, and the 018 list)

**Files:**
- Modify: `src/core/Engine.js`, `src/world/Terrain.js`, `src/game/Game.js:721`, `src/world/terrain/material.glsl.js`, `src/core/DitherEffect.js`, `src/fx/post/MotionBlurEffect.js`, `src/fx/post/HeatDistortionEffect.js`, `src/fx/post/LensArtifactsEffect.js`, `src/fx/gpu/noise.glsl.js`, `vite.config.js`, `src/main.js`

- [ ] **Step 1: E1 — FOV-aware clipmap**

`Terrain.update(focus, budget)` gains a third argument:

```js
  /**
   * @param {number} fovScale  tan(defaultVFov/2) / tan(currentVFov/2). The optic
   *   narrows to 4x, and level selection was a pure function of world distance,
   *   so the payoff shot was the lowest-fidelity view in the game.
   */
  update(focus, budget, fovScale = 1) {
```

Multiply each level's transition radius by `fovScale` when choosing which level covers a
sample, and pass the same scale into `uDetailFade` so `material.glsl.js:754`'s
`smoothstep(4800, 7200)` stretches with it. Clamp `fovScale` to `[1, 4]`.

Call site in `Game.js:721`:

```js
    const fovScale = THREE.MathUtils.clamp(
      Math.tan(THREE.MathUtils.degToRad(this.baseFov) * 0.5)
        / Math.tan(THREE.MathUtils.degToRad(this.engine.camera.fov) * 0.5),
      1, 4);
    this.terrain.update(this._terrainFocus(flight), this.settings.tier.terrainBudget, fovScale);
```

Verify live with `__recon(4, 1200, 4)` — the faceting and the flat snow slabs should be gone.

- [ ] **Step 2: E3 — a dedicated capture target**

`renderToTarget` calls `composer.setSize()` and then `this.resize()` in its `finally`,
reallocating every HalfFloat target twice per shutter press. Keep a persistent capture-sized
composer size and restore by cached value rather than by full `resize()`:

```js
    } finally {
      configureFinalOutput(this.composer.passes, this.finishPass, null);
      this.composer.setMainScene(this.scene);
      this.composer.setMainCamera(this.camera);
      if (this.clouds && previousCloudCamera) this.clouds.camera = previousCloudCamera;
      this.renderer.setPixelRatio(previousPixelRatio);
      // Restore the composer to the size it already had rather than
      // reallocating every target through resize() on the shutter frame.
      this.composer.setSize(previousWidth, previousHeight, false);
      this.renderer.setRenderTarget(previousTarget);
    }
```

capturing `previousWidth/Height` from `this.renderer.getDrawingBufferSize()` before the swap.

- [ ] **Step 3: 018 — post chain corrections**

- **Bloom after exposure:** move `this.bloomPass` after `this.tonePass` in both `addPass`
  order and `_postPasses`. Re-tune `luminanceThreshold` from `1.08` to roughly `0.72` since it
  now sees tonemapped values, and confirm by eye that only the sun disc, reheat and hard
  glints bloom.
- **Dither:** apply the amplitude after the transfer curve, or scale it by
  `d(sRGB)/d(linear)` at the sampled luminance. Simplest correct form is to dither in the
  output pass after encoding.
- **Motion blur centre:** drive the declared uniform from the screen-space velocity vector
  each frame in `setMotionBlur()`.
- **Heat distortion:** pass the exhaust's projected screen position instead of the hardcoded
  point, the way `setSunScreenPosition` already does for the shafts.
- **Lens flare aspect:** multiply the UV delta by `vec2(aspect, 1.0)` before computing radii.
- **Recon exposure compensation:** when the optic is active, bias `setExposure` by the
  measured difference and shorten `adaptationRate`, so the first second of an optic entry is
  metered for what the optic sees.
- **`fxCurl`:** drop the `normalize()` at `noise.glsl.js:153` and scale by a tuned constant.

Each of these is a separate commit.

- [ ] **Step 4: E5 — chunk split and `__audit`**

Replace `rolldownOptions.output.manualChunks` in `vite.config.js` with rolldown's
`advancedChunks`:

```js
    rolldownOptions: {
      output: {
        advancedChunks: {
          groups: [
            { name: 'three', test: /[\\/]node_modules[\\/]three[\\/]/ },
            { name: 'postprocessing', test: /[\\/]node_modules[\\/]postprocessing[\\/]/ },
          ],
        },
      },
    },
```

Verify with:
```bash
npm run build && grep -c "gl_FragColor" dist/assets/three-*.js dist/assets/postprocessing-*.js
```
Expected: the three chunk now holds three's GLSL, not the postprocessing chunk. If
`advancedChunks` still does not split them, delete the manual split and its comment rather
than shipping a comment that claims a property the build lacks.

Fix `__audit()` to read `renderer.info` immediately after a render rather than after the
reset, so it reports real draw calls and triangles.

- [ ] **Step 5: Run everything, commit each fix separately**

---

## Task 12: Bounded structural extraction from `Game.js` (E6)

`Game.js` is 1,301 lines with a 190-line constructor and is the sole integration point for
seven subsystems. A full breakup is out of scope; this task extracts the two most separable
concerns and stops there.

**Files:**
- Create: `src/game/WaterRefraction.js`, `src/game/PostEffectDriver.js`
- Modify: `src/game/Game.js`

- [ ] **Step 1: Extract water refraction**

Move `_updateWaterRefraction`, `_waterBatchInView`, `_disposeWaterRefraction` and their state
into `WaterRefraction.js` with the interface:

```js
export class WaterRefraction {
  constructor(engine, water, settings) {}
  update(dt, camera) {}
  setQuality(tier) {}
  dispose() {}
}
```

- [ ] **Step 2: Extract the post-effect driver**

Move `_updatePostEffects`, `_disableMotionBlur`, `_resetMotionBaseline`,
`_installMotionPreference`, `_disposeMotionPreference` into `PostEffectDriver.js`:

```js
export class PostEffectDriver {
  constructor(engine, environment, settings) {}
  update(dt, flight, camera, sunVisibility) {}
  dispose() {}
}
```

- [ ] **Step 3: Verify no behaviour changed**

Run: `node --test "src/**/*.test.mjs" && npm run check && npm run build`, then fly the app and
confirm water refraction and motion blur still behave. Extraction only — **no logic changes in
this task**, so any behavioural difference is a bug.

- [ ] **Step 4: Commit**

```bash
git add src/game/WaterRefraction.js src/game/PostEffectDriver.js src/game/Game.js
git commit -m "refactor: extract water refraction and post-effect driving from Game"
```

---

## Task 13: Documentation and dead code alignment

**Files:**
- Modify: `README.md`, `src/world/atmosphere/constants.js:64`, `src/flight/FlightModel.js:80`,
  `src/world/Terrain.js:18,74`, `src/flight/burner.js:19`, `src/flight/Aircraft.js:85`,
  `src/world/atmosphere/lut.js:398`, `src/world/Water.js:243`, `src/ui/Screens.js:458,512`,
  `src/main.js:58,181`, `docs/screenshots/02-briefing.jpg`

- [ ] **Step 1: Make comments match reality**

For each documented-but-unimplemented behaviour, prefer **aligning the comment to the code**
unless the behaviour is worth having:
- `atmosphere/constants.js:64` terrain-bounce ambient — delete the claim.
- `FlightModel.js:80` `AIRCRAFT.rateDamping` — delete the dead config and its comment.
- `Terrain.js:74` crack-prevention discard — the absence is test-enforced; correct the comment.
- `Terrain.js:18` triangle budget — restate the number the desktop default actually submits.
- `burner.js:19` — unify the visual and physical afterburner on one threshold and signal.

- [ ] **Step 2: Fix the real defects in this group**

- ~~`Screens.js:512` — define `window.__sagar`~~ — **retracted.** It is an optional external
  test seam; every reference is guarded (`?.` or a truthiness check) and
  `boot-lifecycle.test.mjs:43` injects it. Leaving it undefined is the design.
- `Screens.js:458` — call `setLoadBytes` from the model fetch so the loading bar moves during
  the 5.4 MB airframe download.
- `main.js:58` — do not raise a permanent fatal overlay for a recoverable error; log and
  continue unless boot failed.
- `main.js:181` — on context loss, stop the frame loop and the mission clock, not just show
  the overlay.
- `Aircraft.js:85` — a failed model load must not leave a disembodied afterburner flying.
- `lut.js:398` — hoist the 512-step CPU march out of the per-frame path; it computes a constant.
- `Water.js:243` — only re-upload lake geometry when the set changes, not when ordering does.
- `Terrain.js:569` — give the CPU height-field fallback a cheap shadow term so the tier that
  most needs form definition is not flat.

- [ ] **Step 3: README**

Correct the test count to whatever `node --test` reports after this branch. Document the
`?seed=` parameter and the new controls. Recapture `docs/screenshots/02-briefing.jpg`, which
still shows the pre-fd5765f `Ctrl` binding, and `09-record.jpg`, which ships showing
`SORTIE TIME 0:00`.

- [ ] **Step 4: Commit**

```bash
git commit -m "docs: align comments, README and screenshots with the code"
```

---

## Task 14: Full-diff adversarial review

- [ ] **Step 1: Run the suite, the lint and the build one final time**

```bash
node --test "src/**/*.test.mjs" && npm run check && npm run build
```

- [ ] **Step 2: Review the whole branch diff**

Dispatch a multi-dimension review of `git diff main...audit-fixes` covering correctness,
GPU/CPU mirror agreement, tier regressions, accessibility, and performance on the `medium`
tier. Verify every finding against the code before acting on it.

- [ ] **Step 3: Live regression pass**

With the dev server running, confirm on `medium`:
- soft particles active (`uSoftEnabled 1`, FX materials carrying the define)
- `__stats` shows `max` near 255 and a narrowed red/blue gap
- `__recon` sub-scores no longer pin at 1.0
- two different seeds produce different missions; the same seed reproduces
- the optic at 4× is no longer faceted

- [ ] **Step 4: Report what was and was not done**

E6 is a bounded extraction, not a full breakup. V7 (terrain character: rock outcrops,
cornices, crevasse fields) and G4 (per-seed time-attack ghost) are not in this plan — say so
explicitly rather than leaving them implied.

---

## Self-review

**Spec coverage:** F1 → T1. F2 → T2. F3 → T3. F4/F5/F6/F7 → T5. F8/F9 → T4. 018 → T11.3.
D1/D3/E4 → T7. D2/D5 → T10. G1/G2 → T8. G3/G5/re-photography → T9. V1/V3/0.22 → T6.
V2 (tonemap look transform) → **gap**, see below. E1/E3/E5 → T11. E6 → T12. Remaining
confirmed defects and doc drift → T13.

**Gap found and closed:** V2 had no task. Add to Task 6 as a final step — after the lighting
constants land, re-measure `__stats`; if `max` still falls short of ~250, add a look transform
after AGX in `AutoExposure.js` (a contrast/saturation restore in the shipped
`createFilmicToneMapping`) and re-measure. Sequenced after the lighting work because the
lighting change alone may resolve most of the deficit, and tuning both at once makes neither
attributable.

**Not in this plan, by decision:** V4 (aircraft ground shadow), V6 (speed-streak rework),
V7 (terrain character), G4 (time-attack ghost), D4 (fuel/bingo pressure). Each is an L-or-
larger feature rather than a defect. They stay in the audit's roadmap.

**Type consistency:** `sortieParams()` returns `origin: {x, z}` and `Game._startPosition()`
consumes exactly that. `Environment.setSun(elevationDeg, azimuthDeg)` takes degrees; the
sortie params carry `sunElevationDeg`/`sunAzimuthDeg`, matching. `Mission.update(dt, pos,
simDt)` — `simDt` is computed as `steps * PHYSICS_STEP` in `Game._updateFlight`.
`Terrain.update(focus, budget, fovScale)` — third argument defaults to `1` so existing
callers in `Game.load` and the cinematic path are unaffected.
