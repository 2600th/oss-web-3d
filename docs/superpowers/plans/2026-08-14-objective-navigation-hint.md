# Objective Navigation Hint Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Guide the player to each selected enemy observation post with progressive cockpit-style visual cues without revealing precise targets through terrain or contaminating reconnaissance captures.

**Architecture:** `Mission` remains target authority. A pure tracker derives navigation state using a shared terrain-visibility oracle. `Game` supplies projection and flight data; a focused DOM component renders bearing, edge, search, and acquisition cues inside HUD safe areas.

**Tech Stack:** Three.js r185, vanilla DOM/CSS, Node test runner, Vite, in-app Browser.

## Global Constraints

- Transit is beyond 8 km, search is 3–8 km, and acquisition is inside 3 km.
- No precise acquisition marker appears through terrain.
- Cues are DOM-only and absent from captured plates.
- Information uses shape and text, not color alone.
- Reduced motion removes animation without removing information.
- Existing Mission target identity and `Tab` behavior remain authoritative.
- Cues clear real HUD and touch controls by at least 8 px at 1920×1080 and 390×844.

---

### Task 1: Pure Navigation State and Shared Visibility

**Files:**
- Create: `src/game/NavigationHint.js`
- Create: `src/game/TerrainVisibility.js`
- Create: `src/game/navigation-hint.test.mjs`
- Modify: `src/game/ReconCamera.js` line-of-sight function only

**Interfaces:**

```js
export const NAV_PHASE = Object.freeze({
  TRANSIT: 'transit', SEARCH: 'search',
  ACQUISITION: 'acquisition', COMPLETE: 'complete',
});
export function signedBearingDelta(headingDeg, targetBearingDeg) {}
export function navigationPhase(rangeMetres) {}
export function rangeTrend(closingSpeed, previousTrend, deadband = 2) {}
export function altitudeCue(deltaMetres) {}
export function terrainVisibility(from, to, heightAt = terrainHeight) {}
export class NavigationHintTracker { update(input) {} reset() {} }
```

- [ ] **Step 1: Add failing boundary, wrap, trend, and mask tests**

```js
assert.equal(signedBearingDelta(359, 1), 2);
assert.equal(signedBearingDelta(1, 359), -2);
assert.equal(navigationPhase(8000), NAV_PHASE.SEARCH);
assert.equal(navigationPhase(3000), NAV_PHASE.ACQUISITION);
assert.equal(masked.projected, null);
assert.equal(masked.label, 'RIDGE MASKED');
```

Also test deterministic 180-degree direction, deadband trend retention, target-ID reset, recon handoff, and complete state.

- [ ] **Step 2: Confirm RED**

Run: `node --test src/game/navigation-hint.test.mjs src/game/integration/recon-camera.test.mjs`

- [ ] **Step 3: Implement pure tracker and shared terrain oracle**

Masked acquisition returns only the last valid edge anchor. Recon hides transit/search immediately; acquisition dims for at most 0.65 seconds and hides once the target is framed. Delegate `ReconCamera.lineOfSight()` to the shared oracle.

- [ ] **Step 4: Verify and commit**

```powershell
node --test src/game/navigation-hint.test.mjs src/game/integration/recon-camera.test.mjs
git add src/game/NavigationHint.js src/game/TerrainVisibility.js src/game/navigation-hint.test.mjs src/game/ReconCamera.js src/game/integration/recon-camera.test.mjs
git commit -m "feat: model progressive objective navigation state"
```

### Task 2: Game Projection and Target Transitions

**Files:**
- Modify: `src/game/Game.js` constructor/reset and `_updateHud()` blocks only
- Test: `src/game/integration/aaa-integration.test.mjs`
- Test: `src/game/mission.test.mjs`

**Interfaces:**
- Consumes: `NavigationHintTracker.update(input)`.
- Produces: `navigation` snapshot in `hud.update(dt, snapshot)`.

- [ ] **Step 1: Add failing integration tests**

```js
assert.equal(afterCapture.navigation.targetId, postB.id);
assert.equal(masked.navigation.projected, null);
assert.equal(framed.navigation.reconPresentation, 'hidden');
assert.equal(restarted.navigation.trend, null);
```

Assert one `mission.target` read per update, direct A→B target transition, all-complete phase, `Tab` authority, and no navigation argument passed to recon capture.

- [ ] **Step 2: Confirm RED**

Run: `node --test src/game/navigation-hint.test.mjs src/game/mission.test.mjs src/game/integration/aaa-integration.test.mjs`

- [ ] **Step 3: Implement projection adapter**

Project `target.aimPoint` through the active camera, determine front/on-screen separately in camera space, compute closing speed from flight velocity, compute altitude delta, and run terrain visibility only inside 3 km. Reuse constructor-owned Three.js scratch objects.

- [ ] **Step 4: Verify and commit**

```powershell
node --test src/game/navigation-hint.test.mjs src/game/mission.test.mjs src/game/integration/aaa-integration.test.mjs
git add src/game/Game.js src/game/integration/aaa-integration.test.mjs src/game/mission.test.mjs
git commit -m "feat: integrate objective navigation snapshots"
```

### Task 3: DOM Navigation Cue and Safe-Area Placement

**Files:**
- Create: `src/ui/NavigationCue.js`
- Create: `src/ui/navigation-cue.test.mjs`
- Modify: `src/ui/Hud.js`
- Modify navigation selectors only: `src/ui/styles.css`
- Test: `src/ui/ui.test.mjs`

**Interfaces:**

```js
export function placeNavigationCue({
  viewport, safeInsets, cueSize, edgeNdc, avoidRects, gap = 8,
}) {} // returns { left, top, edge, rect }
export class NavigationCue {
  constructor(hudRoot, headingStrip, options = {}) {}
  update(snapshot) {}
  dispose() {}
}
```

- [ ] **Step 1: Add failing geometry and accessibility tests**

```js
const placed = placeNavigationCue(layoutFixture('phone'));
assert.ok(placed.left >= safe.left && placed.top >= safe.top);
assert.equal(overlap(placed.rect, tapeRect), false);
assert.ok(gapBetween(placed.rect, touchRect) >= 8);
assert.match(masked.className, /dashed/);
assert.equal(cue.status.getAttribute('aria-live'), 'polite');
```

Cover 1920×1080 and 390×844, heading wrap, distinct left/right shape and words, unfilled search/acquisition geometry, reduced-motion CSS, and announcer update deduplication.

- [ ] **Step 2: Confirm RED**

Run: `node --test src/ui/navigation-cue.test.mjs src/ui/ui.test.mjs`

- [ ] **Step 3: Implement DOM cue**

Add target-bearing caret, edge chevrons, transit text, broad search bracket, acquisition corners, dashed ridge-masked state, and a single polite live announcer. Query live avoid rectangles for tapes, objectives, touch stick, Boost/throttle, recon, shutter, and zoom controls.

- [ ] **Step 4: Verify and commit**

```powershell
node --test src/ui/navigation-cue.test.mjs src/ui/ui.test.mjs
git add src/ui/NavigationCue.js src/ui/navigation-cue.test.mjs src/ui/Hud.js src/ui/styles.css src/ui/ui.test.mjs
git commit -m "feat: add cockpit objective navigation cues"
```

### Task 4: Lifecycle and Capture Exclusion

**Files:**
- Test: `src/game/integration/aaa-integration.test.mjs`
- Test: `src/ui/navigation-cue.test.mjs`
- Modify only if required by failing lifecycle tests: `src/ui/Hud.js`, `src/game/Game.js`

- [ ] **Step 1: Add failing lifecycle tests**

Assert deterministic transit→search→acquisition boundaries, mask/unmask without precise coordinate leakage, recon close without stale timers, exactly-once target advance, restart/disposal cleanup, HUD-only DOM ownership, and no cue data in recon capture.

- [ ] **Step 2: Confirm RED**

Run: `node --test src/game/navigation-hint.test.mjs src/ui/navigation-cue.test.mjs src/game/integration/aaa-integration.test.mjs src/game/integration/recon-camera.test.mjs`

- [ ] **Step 3: Implement minimal lifecycle corrections**

Ensure `Hud.dispose()` removes the cue and announcer, tracker reset clears cached state, and complete state renders only the existing return-to-base message.

- [ ] **Step 4: Verify and commit**

```powershell
node --test src/game/navigation-hint.test.mjs src/ui/navigation-cue.test.mjs src/game/integration/aaa-integration.test.mjs src/game/integration/recon-camera.test.mjs
git add src/ui/Hud.js src/game/Game.js src/ui/navigation-cue.test.mjs src/game/integration/aaa-integration.test.mjs
git commit -m "fix: close objective cue lifecycle and capture boundaries"
```

### Task 5: Navigation Acceptance

- [ ] **Step 1: Run complete automated verification**

```powershell
$tests = @(rg --files src -g '*.test.mjs' -g '*.test.js' | Sort-Object)
node --test $tests
npm run check
npm run build
git diff --check
```

- [ ] **Step 2: Run desktop Browser states**

At 1920×1080 high, inspect transit beyond 8 km, search at 5 km, visible and ridge-masked acquisition below 3 km, wraparound caret, shortest-turn chevron, trend, altitude relation, recon fade, and one-step target advancement.

- [ ] **Step 3: Confirm capture exclusion**

Take a photograph and inspect the developed plate/contact sheet. No navigation cue may appear.

- [ ] **Step 4: Run phone and reduced-motion gates**

At 390×844, require at least 8 px clearance from all visible HUD/touch controls. Under reduced motion, require no pulse/sweep/fade animation and unchanged information.
