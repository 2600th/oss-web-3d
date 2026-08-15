# Flight Control Feedback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the unsafe Ctrl flight binding with `X` and prevent sustained Assisted turns from entering the stall-warning state while retaining meaningful energy loss.

**Architecture:** Keep keyboard normalization in `Input` and update every consumer-visible binding label together. Keep aerodynamic forces unchanged; add speed-aware throttle and low-speed turn-envelope protection only inside `AssistController`, which Direct mode bypasses.

**Tech Stack:** JavaScript ES modules, Node test runner, Three.js, Vite.

## Global Constraints

- `X` replaces `Ctrl` for keyboard slow-down/throttle-down; touch and gamepad bindings do not change.
- Direct mode and manual-throttle Assisted mode keep their current behavior apart from the keyboard rebind.
- Sustained Assisted turns retain energy loss but do not enter `flight.stalling`.
- No option-menu changes, global aerodynamic retuning, deployment, push, or pull request.

---

### Task 1: Replace the Ctrl flight binding with X

**Files:**
- Modify: `src/core/input-lifecycle.test.mjs`
- Modify: `src/ui/ui.test.mjs`
- Modify: `src/core/Input.js`
- Modify: `src/ui/Screens.js`
- Modify: `README.md`

**Interfaces:**
- Consumes: browser `KeyboardEvent.code` values in `Input.update(dt, verticalMode)`.
- Produces: `KeyX` updates `input.intent.speed` to `-1` and decrements `input.throttle`; `ControlLeft` and `ControlRight` have no flight effect.

- [ ] **Step 1: Write failing input and UI behavior tests**

Change the Direct throttle characterization and semantic intent cases to use `KeyX`. Add a separate Ctrl case that holds `ControlLeft`, calls `update(0.1)`, and asserts both throttle and semantic speed remain unchanged. In `ui.test.mjs`, assert `controlRows('assisted', 'keyboard')` and `controlRows('direct', 'keyboard')` advertise `X` and do not advertise `Ctrl`.

```js
target.fire('keydown', keyEvent('KeyX'));
input.update(0.1);
assert.ok(input.throttle < 0.72, 'X must reach the Direct throttle-down binding');
assert.equal(input.intent.speed, -1);

target.fire('keyup', keyEvent('KeyX'));
target.fire('keydown', keyEvent('ControlLeft', { ctrlKey: true }));
input.update(0.1);
assert.equal(input.throttle, throttleAfterX);
assert.equal(input.intent.speed, 0);
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```powershell
node --test src/core/input-lifecycle.test.mjs src/ui/ui.test.mjs
```

Expected: failures show `KeyX` does not lower throttle or semantic speed, Ctrl still does, and the briefing still advertises Ctrl.

- [ ] **Step 3: Implement the minimal rebind**

In `Input.update`, replace both `ControlLeft`/`ControlRight` checks with `KeyX`. Remove the obsolete Ctrl-specific listener commentary and retain the general rule that modifier shortcuts are not suppressed. Update Assisted and Direct keyboard rows in `Screens.js` and the README control table to name `X`.

```js
intent.speed = k.has('KeyX') ? -1 : 0;

if (k.has('KeyX')) {
  this.throttle = Math.max(0, this.throttle - dt * 0.62);
}
```

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run:

```powershell
node --test src/core/input-lifecycle.test.mjs src/ui/ui.test.mjs
```

Expected: all input and UI tests pass with no warnings.

- [ ] **Step 5: Commit the keyboard binding change**

```powershell
git add -- src/core/Input.js src/core/input-lifecycle.test.mjs src/ui/Screens.js src/ui/ui.test.mjs README.md
git commit -m "fix: replace browser-conflicting Ctrl flight binding"
```

### Task 2: Protect Assisted turns from the stall-warning band

**Files:**
- Modify: `src/flight/assist-controller.test.mjs`
- Modify: `src/flight/AssistController.js`

**Interfaces:**
- Consumes: `flight.airspeed`, the selected sensitivity profile, and `options.autoThrottle`.
- Produces: the existing stable `{ pitch, roll, yaw, throttle, brake }` control object; no new public API.

- [ ] **Step 1: Write failing sustained-turn regressions**

Extend the existing `run` helper with an `everStalled` boolean set whenever `flight.stalling` is true. Strengthen the normal 40-second turn regression and the existing high-sensitivity bounded regression:

```js
assert.equal(result.everStalled, false, 'Assisted maximum turn must stay outside the stall warning');
assert.ok(result.flight.airspeed < 230, 'Assisted protection must retain meaningful energy loss');
```

Keep the existing finite-speed, G-limit, and sensitivity assertions.

- [ ] **Step 2: Run the controller test and verify RED**

Run:

```powershell
node --test src/flight/assist-controller.test.mjs
```

Expected: the sustained normal and high turns fail because `everStalled` becomes true; unrelated controller tests pass.

- [ ] **Step 3: Add speed-aware automatic throttle**

Import `AIRCRAFT` from `FlightModel.js`. Define protection bands as stall-speed multiples so they remain tied to the model:

```js
const AUTO_THROTTLE_FULL_SPEED = AIRCRAFT.stallSpeed * 1.25;
const AUTO_THROTTLE_ENTRY_SPEED = AIRCRAFT.stallSpeed * 2.0;
```

For automatic throttle only, calculate the existing scheduled throttle, then take the maximum of that schedule and a smooth recovery schedule that rises from `0.82` at entry speed to `1.0` at full-protection speed. Boost must still command exactly `1` and manual throttle must still pass through.

- [ ] **Step 4: Add minimal low-speed turn-envelope protection if high sensitivity remains RED**

If maximum automatic throttle alone does not keep the high-sensitivity regression outside `flight.stalling`, scale `requestedRate` smoothly below `AIRCRAFT.stallSpeed * 1.5`, reaching no less than `0.62` of the selected rate at `AIRCRAFT.stallSpeed * 1.2`:

```js
const turnProtection = 0.62 + 0.38 * smoothstep(
  AIRCRAFT.stallSpeed * 1.2,
  AIRCRAFT.stallSpeed * 1.5,
  speed,
);
const requestedRate = Math.abs(turn) * profile.turnRate * turnProtection;
```

Use a local scalar `smoothstep` helper if needed; do not change `FlightModel` constants or forces.

- [ ] **Step 5: Run the controller test and verify GREEN**

Run:

```powershell
node --test src/flight/assist-controller.test.mjs
```

Expected: all controller tests pass, including sustained-turn no-stall, meaningful energy loss, boost, manual throttle, sensitivity ordering, and frame-rate convergence.

- [ ] **Step 6: Commit the Assisted envelope change**

```powershell
git add -- src/flight/AssistController.js src/flight/assist-controller.test.mjs
git commit -m "fix: protect assisted turns from stall"
```

### Task 3: Full verification

**Files:**
- Verify only; no planned production edits.

**Interfaces:**
- Consumes: the complete repository after Tasks 1 and 2.
- Produces: fresh test, build, whitespace, diff, and status evidence.

- [ ] **Step 1: Run the full Node test suite**

```powershell
node --test
```

Expected: zero failures, cancellations, or skipped tests caused by this change.

- [ ] **Step 2: Run the production build**

```powershell
npm run build
```

Expected: GLSL validation and Vite production build exit successfully.

- [ ] **Step 3: Review formatting and scope**

```powershell
git diff --check HEAD~2
git status --short --branch
git log -3 --oneline
```

Expected: no whitespace errors; only the approved design, keyboard binding, controller, tests, and documentation are included; the branch is ahead only by the focused local commits.
