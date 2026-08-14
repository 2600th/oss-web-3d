# Assisted Arcade Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make keyboard, gamepad, and touch flying immediately understandable while preserving the current simulator-style behavior as Direct mode.

**Architecture:** `Input` exposes stable semantic intent without changing characterized Direct outputs. A new allocation-free `AssistController` translates turn, climb, speed, and boost intent into the existing `FlightModel` contract. Settings and UI select the mode and explain the active modality.

**Tech Stack:** Three.js r185, vanilla JavaScript/DOM/CSS, Node test runner, Vite, in-app Browser.

## Global Constraints

- `FlightModel.js` remains unchanged.
- Default mode is `assisted`; Direct preserves existing control output.
- Maximum assisted bank is 48 degrees and effective roll command is at most 35% of current full roll.
- Neutral returns to within ±5 degrees bank in at most 1.5 seconds.
- Assisted climb/dive target is capped at ±18 degrees.
- Recon correction from a 100 ms input is at most 3 degrees at 17-degree FOV.
- Touch, keyboard, and gamepad share the same turn/climb semantics.
- No new dependencies.

---

### Task 1: Settings v2 and Migration

**Files:**
- Modify: `src/core/Settings.js`
- Create: `src/core/settings.test.mjs`
- Test: `src/game/integration/aaa-integration.test.mjs`

**Interfaces:**
- Produces persisted `controlMode`, `controlSensitivity`, `autoThrottle`, `verticalMode`, and `assistedNoticeSeen`.
- Reads legacy `safed-sagar.settings.v1`; writes `safed-sagar.settings.v2`.

- [ ] **Step 1: Add failing defaults and migration tests**

```js
assert.equal(fresh.controlMode, 'assisted');
assert.equal(fresh.controlSensitivity, 'normal');
assert.equal(fresh.autoThrottle, true);
assert.equal(fresh.verticalMode, 'upToClimb');
assert.equal(migrate({ invertPitch: true }).verticalMode, 'upToDive');
assert.equal('invertPitch' in savedV2, false);
```

- [ ] **Step 2: Confirm RED**

Run: `node --test src/core/settings.test.mjs src/game/integration/aaa-integration.test.mjs`

- [ ] **Step 3: Implement v2 schema and strict setters**

Preserve tier and volume exactly, let v2 win when both keys exist, serialize one authoritative vertical direction, reject invalid enum values, and persist one-time notice acknowledgement.

- [ ] **Step 4: Verify and commit**

```powershell
node --test src/core/settings.test.mjs src/game/integration/aaa-integration.test.mjs
git add src/core/Settings.js src/core/settings.test.mjs src/game/integration/aaa-integration.test.mjs
git commit -m "feat: add assisted-control settings migration"
```

### Task 2: Semantic Device Intent

**Files:**
- Modify: `src/core/Input.js`
- Test: `src/core/input-lifecycle.test.mjs`

**Interfaces:**
- Produces stable `input.intent = { turn, climb, speed, boost, brake, throttle }`.
- Produces `input.modality`, `input.setTouchBoost(held)`, and `input.releaseAll()`.
- Preserves existing direct fields.

- [ ] **Step 1: Characterize existing Direct output**

Add green characterization for W/S, A/D, Q/E, Shift/Ctrl, gamepad axes, and touch raw axes before refactoring.

- [ ] **Step 2: Add failing semantic and cleanup tests**

```js
assert.equal(press('KeyW').intent.climb, 1);
assert.equal(press('KeyS').intent.climb, -1);
assert.equal(press('KeyA').intent.turn, -1);
assert.equal(press('KeyD').intent.turn, 1);
assert.equal(samplePadAxis(0.13), 0);
input.releaseAll();
assert.deepEqual(input.intent, NEUTRAL_INTENT);
```

- [ ] **Step 3: Confirm RED**

Run: `node --test src/core/input-lifecycle.test.mjs`

- [ ] **Step 4: Implement semantic intent and centralized cleanup**

Invert only analogue vertical intent through `verticalMode`; W/S meanings never reverse. Detect one rising edge for Assisted recon while retaining held Direct recon. Clear all held state on blur, visibility loss, release, and disposal.

- [ ] **Step 5: Verify Direct characterization and commit**

```powershell
node --test src/core/input-lifecycle.test.mjs
git add src/core/Input.js src/core/input-lifecycle.test.mjs
git commit -m "feat: normalize semantic flight intent"
```

### Task 3: Assist Controller

**Files:**
- Create: `src/flight/AssistController.js`
- Create: `src/flight/assist-controller.test.mjs`

**Interfaces:**

```js
const assist = new AssistController();
const control = assist.update(dt, intent, flight, {
  sensitivity: 'normal', autoThrottle: true, reconActive: false,
});
assist.reset();
```

Output is one stable allocation-free `{ pitch, roll, yaw, throttle, brake }` object.

- [ ] **Step 1: Add failing controller tests using real FlightModel**

```js
assert.ok(maxBank(runTurn(assist, 5)) <= THREE.MathUtils.degToRad(48));
assert.ok(timeToLevelAfterRelease(assist) <= 1.5);
assert.ok(Math.abs(runClimb(assist).flightPathAngle) <= THREE.MathUtils.degToRad(18));
assert.equal(runNeutral(assist, 30).stalling, false);
assert.ok(runTap(assist, 0.1).headingDelta <= THREE.MathUtils.degToRad(5));
assert.ok(runReconTap(assist, 0.1).opticalDelta <= THREE.MathUtils.degToRad(3));
```

Also assert finite safe output for invalid flight state, boost/reheat release, manual throttle pass-through, sensitivity ordering, reset, and 30/60/120 Hz convergence.

- [ ] **Step 2: Confirm RED**

Run: `node --test src/flight/assist-controller.test.mjs`

- [ ] **Step 3: Implement bounded coordinated flight assistance**

Translate turn intent into capped bank, coordinated yaw, and level recovery. Translate climb intent into a flight-path target. Use auto-cruise throttle with momentary reheat boost. Reduce correction authority in recon.

- [ ] **Step 4: Verify and commit**

```powershell
node --test src/flight/assist-controller.test.mjs
git add src/flight/AssistController.js src/flight/assist-controller.test.mjs
git commit -m "feat: add assisted arcade flight controller"
```

### Task 4: Game and Recon Lifecycle Integration

**Files:**
- Modify: `src/game/Game.js` controller construction, physics selection, and lifecycle blocks only
- Modify: `src/main.js` narrow touch/game wiring only
- Test: `src/game/integration/aaa-integration.test.mjs`
- Test: `src/core/input-lifecycle.test.mjs`

**Interfaces:**
- Direct calls `flight.update(step, input)`.
- Assisted calls `flight.update(step, assist.update(step, input.intent, flight, options))`.

- [ ] **Step 1: Add failing integration tests**

Assert Direct passthrough, Assisted selection, one toggle per Space press, held Direct recon, mode-switch cleanup, fixed-step reuse, invalid-output fallback, and pause/restart/disposal cleanup.

- [ ] **Step 2: Confirm RED**

Run: `node --test src/game/integration/aaa-integration.test.mjs src/core/input-lifecycle.test.mjs`

- [ ] **Step 3: Integrate controller and lifecycle**

Construct one controller. Reset controller and held intent on launch, pause, blur, restart, mode switch, and disposal. If assist output is non-finite, use bounded neutral control rather than propagating invalid values.

- [ ] **Step 4: Verify and commit**

```powershell
node --test src/game/integration/aaa-integration.test.mjs src/core/input-lifecycle.test.mjs
git add src/game/Game.js src/main.js src/game/integration/aaa-integration.test.mjs src/core/input-lifecycle.test.mjs
git commit -m "feat: integrate assisted and direct flight modes"
```

### Task 5: Touch Assisted Mode

**Files:**
- Modify: `src/core/TouchControls.js`
- Modify touch selectors only: `src/ui/styles.css`
- Test: `src/core/touch-controls.test.mjs`

**Interfaces:**
- Produces `touchControls.setMode('assisted' | 'direct')`.

- [ ] **Step 1: Add failing radial-input and mode tests**

```js
assert.ok(Math.abs(cardinal.magnitude - diagonal.magnitude) <= 0.05);
assert.equal(insideDeadzone.magnitude, 0);
assert.equal(upDrag.intent.climb, 1);
assert.equal(assisted.throttleEnabled, false);
assert.equal(assisted.boostEnabled, true);
```

Test Boost down/up/cancel, mode switch cleanup, Direct throttle preservation, and disposal cleanup.

- [ ] **Step 2: Confirm RED**

Run: `node --test src/core/touch-controls.test.mjs`

- [ ] **Step 3: Implement radial semantic stick and Boost**

Shape vector magnitude once and restore direction. Assisted hides/disables throttle and shows momentary Boost. Direct retains raw stick, throttle strip, and touch recon behavior.

- [ ] **Step 4: Verify and commit**

```powershell
node --test src/core/touch-controls.test.mjs
git add src/core/TouchControls.js src/ui/styles.css src/core/touch-controls.test.mjs
git commit -m "feat: simplify assisted touch flight controls"
```

### Task 6: Options and Modality-Specific Guidance

**Files:**
- Modify: `src/ui/Screens.js`
- Modify control/options/notice selectors only: `src/ui/styles.css`
- Test: `src/ui/ui.test.mjs`
- Modify narrow option callbacks: `src/game/Game.js`

**Interfaces:**
- Produces `controlRows(mode, modality)`.
- Produces `screens.setControlContext({ controlMode, modality })`.
- Extends `screens.setOptions(...)` with control settings.

- [ ] **Step 1: Add failing UI contracts**

```js
assert.deepEqual(controlRows('assisted', 'keyboard')[0], ['W / Up', 'Climb']);
assert.equal(controlRows('assisted', 'touch').some(([key]) => /W|Shift/.test(key)), false);
assert.match(controlRows('direct', 'keyboard').join(' '), /hold/i);
```

Assert ARIA state, callback wiring, option round-trip, one-time notice, and removal of ambiguous invert-pitch copy.

- [ ] **Step 2: Confirm RED**

Run: `node --test src/ui/ui.test.mjs`

- [ ] **Step 3: Implement options, copy, and notice**

Add Assisted/Direct, sensitivity, auto-throttle, and analogue vertical direction controls. Render only the active modality’s briefing rows.

- [ ] **Step 4: Verify and commit**

```powershell
node --test src/ui/ui.test.mjs
git add src/ui/Screens.js src/ui/styles.css src/ui/ui.test.mjs src/game/Game.js
git commit -m "feat: expose assisted flight options and guidance"
```

### Task 7: Controls Acceptance

- [ ] **Step 1: Run complete automated verification**

```powershell
$tests = @(rg --files src -g '*.test.mjs' -g '*.test.js' | Sort-Object)
node --test $tests
npm run check
npm run build
git diff --check
```

- [ ] **Step 2: Run desktop Assisted and Direct Browser tests**

Verify W/S climb/descend, A/D coordinated turns, level recovery, boost release, recon toggle/precision, Direct legacy behavior, and cleanup after pause/restart/blur.

- [ ] **Step 3: Run 390×844 touch tests**

Verify Assisted Boost replaces throttle, radial drag matches labels, release stabilizes, Direct restores throttle, and no controls overlap HUD or recon buttons.

- [ ] **Step 4: Run gamepad and migration tests when hardware is available**

If no gamepad is connected, report the executable simulated-pad evidence separately and do not claim live hardware acceptance.
