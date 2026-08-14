# Visual Speed Presence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make clouds, speed streaks, FOV expansion, and peripheral blur visibly communicate weather and velocity from the opening seconds of the sortie.

**Architecture:** Keep the existing cloud volume, GPU particle foundation, chase camera, and post stack. Correct authored cloud placement, spawn streaks in camera space, centralize numeric FOV and blur profiles in pure functions, and feed those profiles through existing render ownership.

**Tech Stack:** Three.js r185, postprocessing 6.39, GLSL3, vanilla JavaScript, Node test runner, Vite, in-app Browser.

## Global Constraints

- Do not add dependencies or replace the current render architecture.
- Opening clouds occupy 15–35% of the composed frame while the central 8–10 degrees remain readable.
- Streaks target 6–18 px length, 0.75–1.5 px width, and 0.12–0.25 peak alpha at 720p.
- Opening speed settles at 66–68 degrees FOV; hard cap is 75 degrees.
- Peripheral blur keeps the central 40–50% sharp and caps total edge displacement at 6 px.
- Recon and reduced-motion modes disable blur; reduced motion limits FOV boost to 4–6 degrees.
- Preserve tier capacity limits and compile-time quality paths.

---

### Task 1: Opening Cloud Composition

**Files:**
- Modify: `src/world/clouds.glsl.js`
- Test: `src/world/cloud/cloud.test.mjs`

**Interfaces:**
- Consumes: `evaluateCloudColumn(x, z, time, windX, windZ)` and `OPENING_CLOUD_CORRIDOR`.
- Produces: the same public API with revised deterministic route composition.

- [ ] **Step 1: Write failing opening-frustum tests**

Add production-proxy sampling which asserts clear centerline and visible lateral banks:

```js
const start = { x: 21000, z: 6000 };
const samples = sampleOpeningFrustum(start, Math.PI * 0.62, 31, 3000, 8000);
assert.ok(samples.center.every((c) => c.shaped < 0.05));
assert.ok(samples.left.some((c) => c.shaped > 0.20));
assert.ok(samples.right.some((c) => c.shaped > 0.20));
assert.ok(samples.coverage >= 0.15 && samples.coverage <= 0.35);
assert.ok(samples.longestRun <= 0.35);
```

- [ ] **Step 2: Run the cloud test and confirm RED**

Run: `node --test src/world/cloud/cloud.test.mjs`

Expected: FAIL because the current corridor removes lateral banks from the opening frustum.

- [ ] **Step 3: Implement the minimum authored composition change**

Shorten and narrow `OPENING_CLOUD_CORRIDOR`, keeping the CPU and GLSL factors identical. Add deterministic lateral shaping only if corridor changes alone cannot satisfy both-bank coverage. Do not change global extinction, density, or lighting in this task.

- [ ] **Step 4: Run focused verification**

Run: `node --test src/world/cloud/cloud.test.mjs`

Expected: PASS with centerline, left/right bank, coverage, and contiguous-run contracts green.

- [ ] **Step 5: Commit**

```powershell
git add src/world/clouds.glsl.js src/world/cloud/cloud.test.mjs
git commit -m "fix: frame the opening route with visible cloud banks"
```

### Task 2: Camera-Frustum Speed Streaks

**Files:**
- Modify: `src/fx/FlightFx.js`
- Modify only if required: `src/fx/gpu/ParticleSystem.js`
- Test: `src/fx/flight/gpu-flight-fx.test.mjs`

**Interfaces:**
- Consumes: `FlightFx.update(dt, flight, cameraPos, camera)`.
- Produces: `export function speedStreakMetrics({ worldWidth, worldLength, distance, fov, viewportHeight })` for numeric tests; runtime API remains unchanged.

- [ ] **Step 1: Add failing projection and live-count contracts**

```js
const metrics = speedStreakMetrics({
  worldWidth: 0.16, worldLength: 2.2, distance: 105,
  fov: 67, viewportHeight: 720,
});
assert.ok(metrics.widthPx >= 0.75 && metrics.widthPx <= 1.5);
assert.ok(metrics.lengthPx >= 6 && metrics.lengthPx <= 18);
assert.ok(simulateVisibleStreaks('high', 260, 0.5) >= 12);
assert.ok(simulateVisibleStreaks('phone', 260, 0.5) >= 4);
```

Retain current tier-capacity and below-threshold visibility assertions.

- [ ] **Step 2: Confirm RED**

Run: `node --test src/fx/flight/gpu-flight-fx.test.mjs`

Expected: FAIL because current streaks project below one pixel and births are wasted outside the frustum.

- [ ] **Step 3: Implement frustum-aware spawning**

Use the supplied `camera` basis to choose a depth inside a bounded annulus and horizontal/vertical offsets inside the visible frustum. Derive world width/length from target pixel ranges, set opacity between 0.12 and 0.25, and preserve `ParticleSystem` capacities and ring-buffer behavior.

- [ ] **Step 4: Verify focused tests**

Run: `node --test src/fx/flight/gpu-flight-fx.test.mjs`

Expected: PASS with no tier-budget regressions.

- [ ] **Step 5: Commit**

```powershell
git add src/fx/FlightFx.js src/fx/gpu/ParticleSystem.js src/fx/flight/gpu-flight-fx.test.mjs
git commit -m "fix: make speed streaks visible in the chase frustum"
```

### Task 3: Bounded Speed FOV

**Files:**
- Modify: `src/flight/ChaseCamera.js`
- Create: `src/flight/chase-camera.test.mjs`

**Interfaces:**
- Produces: `speedFovTarget(speed, reheat = false, reducedMotion = false): number`.
- Produces: `ChaseCamera.setReducedMotion(enabled): void`.
- Preserves: `ChaseCamera.update(dt, flight, extraShake)`.

- [ ] **Step 1: Add failing numeric and convergence tests**

```js
assert.ok(inBand(speedFovTarget(260), 66, 68));
assert.ok(inBand(speedFovTarget(380), 71, 73));
assert.ok(speedFovTarget(500, true) <= 75);
assert.ok(speedFovTarget(500, true, true) <= 64);
assert.ok(maxConvergenceDelta([30, 60, 120], 260, 1) < 0.2);
assert.ok(maxFovRate(260) <= 18);
```

- [ ] **Step 2: Confirm RED**

Run: `node --test src/flight/chase-camera.test.mjs`

Expected: FAIL because the pure profile does not exist and current opening FOV is about 62 degrees.

- [ ] **Step 3: Implement the pure curve and bounded smoothing**

Use a normalized 120–420 m/s curve with exponent near 0.8, 58-degree base, 16-degree normal boost, reheat hard cap 75, and reduced-motion cap 64. Rate-limit update to 18 degrees/second and preserve explicit recon-to-chase cuts.

- [ ] **Step 4: Verify and commit**

Run: `node --test src/flight/chase-camera.test.mjs`

```powershell
git add src/flight/ChaseCamera.js src/flight/chase-camera.test.mjs
git commit -m "feat: strengthen bounded speed FOV response"
```

### Task 4: Frame-Rate-Independent Peripheral Blur

**Files:**
- Create: `src/fx/post/motionProfile.js`
- Create: `src/fx/post/motion-profile.test.mjs`
- Modify: `src/fx/post/MotionBlurEffect.js`
- Modify: `src/fx/post/postEffects.test.mjs`
- Modify: `src/core/Engine.js` motion setter only
- Modify: `src/game/Game.js` post-effect update block only

**Interfaces:**
- Produces: `computeMotionProfile({ airspeed, angularX, angularY, dt, flying, reconActive, reducedMotion })`.
- Produces: `MotionBlurEffect.setMotion({ angularX, angularY, radialPixels, amount, edgeStart })`.

- [ ] **Step 1: Add failing profile tests**

```js
const baseInput = {
  airspeed: 260, angularX: 0, angularY: 0, dt: 1 / 60,
  flying: true, reconActive: false, reducedMotion: false,
};
const p = computeMotionProfile(baseInput);
assert.ok(p.radialPixels >= 1.5 && p.radialPixels <= 2.5);
assert.equal(computeMotionProfile({ ...baseInput, reconActive: true }).amount, 0);
assert.equal(computeMotionProfile({ ...baseInput, reducedMotion: true }).amount, 0);
assert.ok(maxAngularVarianceAcrossFps(90) < 0.10);
assert.ok(p.combinedPixels <= 6);
```

- [ ] **Step 2: Add failing shader contracts**

Assert that exported `MOTION_BLUR_FRAGMENT` derives radial direction from `uv - opticalCenter`, applies an edge mask beginning between 0.40 and 0.50 normalized radius, and clamps combined offsets before sampling.

- [ ] **Step 3: Confirm RED**

Run: `node --test src/fx/post/motion-profile.test.mjs src/fx/post/postEffects.test.mjs`

- [ ] **Step 4: Implement profile, shader, and integration**

Convert camera rotation delta to angular velocity by dividing by `dt`. Feed speed and angular components separately. Force zero for recon, non-flight states, and reduced motion. Keep the optical center sharp and cap 720p displacement at 6 px.

- [ ] **Step 5: Verify and commit**

Run: `node --test src/fx/post/motion-profile.test.mjs src/fx/post/postEffects.test.mjs`

```powershell
git add src/fx/post/motionProfile.js src/fx/post/motion-profile.test.mjs src/fx/post/MotionBlurEffect.js src/fx/post/postEffects.test.mjs src/core/Engine.js src/game/Game.js
git commit -m "feat: add bounded peripheral speed blur"
```

### Task 5: Visual Acceptance

**Files:** No production edits unless a measured acceptance failure returns the task to its owning component.

- [ ] **Step 1: Run automated verification**

```powershell
$tests = @(rg --files src -g '*.test.mjs' -g '*.test.js' | Sort-Object)
node --test $tests
npm run check
npm run build
git diff --check
```

- [ ] **Step 2: Run in-app Browser gates**

At 1920×1080 high and low plus 390×844 phone, capture opening frames around 2 and 10 seconds. Verify visible lateral cloud banks, readable center route, streak length/width/count, 66–68-degree opening FOV, sharp center, visible edge blur, recon blur disablement, and clean console logs.

- [ ] **Step 3: Verify comfort mode**

With `prefers-reduced-motion: reduce`, confirm no radial/angular blur and a maximum 4–6 degree FOV boost.

- [ ] **Step 4: Commit any evidence-only test refinements**

Do not tune production values without a reproduced acceptance failure and a red test.
