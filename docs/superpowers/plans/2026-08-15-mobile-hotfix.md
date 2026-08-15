# Mobile UI, Accessibility, and GPU Portability Hotfix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a verified mobile hotfix that prevents phone control/HUD collisions, restores browser zoom, and removes implicit-derivative sampling from the known divergent shader paths.

**Architecture:** Keep the current control implementation and add narrowly scoped coarse-pointer media-query overrides for compact portrait and short landscape. Treat accessibility and shader portability as boundary contracts: viewport policy is asserted from the served HTML, while generated GLSL is inspected at its exported production boundary and then compiled by the production build/browser smoke test.

**Tech Stack:** Vite, Three.js/WebGL2 GLSL, CSS media queries and safe-area environment variables, Node.js built-in test runner, Chrome/ANGLE.

## Global Constraints

- Preserve desktop and the working 390 x 844 portrait layout.
- Keep `touch-action: none` only on active joystick/button controls; non-control presentation surfaces must permit browser zoom.
- All coarse-pointer pause targets covered by this hotfix have a minimum 44 px hit area.
- Cloud shape/detail and terrain shadow-height sampling use explicit base LOD only where their textures are configured without mipmaps.
- Do not report Firefox, Safari/WebKit, or real-mobile-GPU validation as complete without direct evidence.
- Ship production changes as one focused hotfix commit after every verification gate passes.

---

### Task 1: Responsive phone control geometry

**Files:**
- Modify: `src/core/touch-controls.test.mjs:261-338`
- Modify: `src/ui/ui.test.mjs:285-340`
- Modify: `src/ui/styles.css:2241-2312`

**Interfaces:**
- Consumes: existing `#touch.assisted`, `#touch.recon-open`, `.stick-zone`, `.touch-btn`, `.tape`, `.recon-head`, `.quality`, and `.recon-frame-no` classes.
- Produces: compact portrait rules for heights up to 700 px and short-landscape rules for coarse pointers at heights up to 420 px and aspect ratios at least 4 / 3.

- [x] **Step 1: Write failing geometry and touch-target tests**

Add table-driven literal rectangles for 320 x 568, 360 x 640, 375 x 667, 568 x 320, 667 x 375, and 844 x 390. Assert every visible touch control is inside the viewport, every control/control and control/HUD pair has at least 8 px separation, and coarse pause selectors have `min-height: 44px`.

```js
for (const fixture of compactPhoneFixtures) {
  for (const control of fixture.controls) assertInside(control, fixture.viewport);
  for (const [a, b] of fixture.separations) assertSeparated(a, b, 8);
}
assert.match(coarseCss, /\.menu \.segmented button[^{]*\{[^}]*min-height:\s*44px/s);
assert.match(coarseCss, /\.menu button\.toggle[^{]*\{[^}]*min-height:\s*44px/s);
```

- [x] **Step 2: Run the focused tests and verify RED**

Run: `node --test src/core/touch-controls.test.mjs src/ui/ui.test.mjs`

Expected: FAIL because short-landscape zoom-in is above y=0, narrow layouts overlap the tapes, and coarse pause controls do not expose 44 px targets.

- [x] **Step 3: Implement the compact layout rules**

Add a compact portrait query that moves and shortens tapes above the stick, stacks assisted recon above boost, and reuses the boost slot when recon is open. Replace the existing generic short-height query with a landscape-specific right action rail and center-safe HUD lane.

```css
@media (pointer: coarse) and (max-height: 700px) and (max-aspect-ratio: 3 / 4) { /* compact portrait */ }
@media (pointer: coarse) and (max-height: 420px) and (min-aspect-ratio: 4 / 3) { /* short landscape */ }
```

Inside `@media (pointer: coarse)`, give `.menu .segmented button`, `.menu button.toggle`, `.menu .quality-row button`, and `.menu input[type='range']` a 44 px minimum hit area.

- [x] **Step 4: Run the focused tests and verify GREEN**

Run: `node --test src/core/touch-controls.test.mjs src/ui/ui.test.mjs`

Expected: PASS with all target viewport fixtures and the existing 390 x 844 contract green.

### Task 2: Accessible browser zoom

**Files:**
- Modify: `src/ui/ui.test.mjs:1-40`
- Modify: `index.html:5`
- Modify: `src/ui/styles.css:61-69,2095-2111`

**Interfaces:**
- Consumes: the document viewport meta tag and the existing `#viewport`, `#touch`, `.touch-zone`, and `.touch-btn` gesture boundaries.
- Produces: an unrestricted viewport declaration plus `touch-action: manipulation` on non-control surfaces and `touch-action: none` on controls.

- [x] **Step 1: Write the failing accessibility contract**

Read `index.html` in `src/ui/ui.test.mjs` and assert the viewport permits scaling while the CSS gesture boundary remains scoped.

```js
assert.match(indexHtml, /content="width=device-width, initial-scale=1, viewport-fit=cover"/);
assert.doesNotMatch(indexHtml, /maximum-scale|user-scalable/i);
assert.match(css, /#viewport\s*\{[^}]*touch-action:\s*manipulation/s);
assert.match(css, /#touch\s*\{[^}]*touch-action:\s*manipulation/s);
assert.match(css, /\.touch-(?:zone|btn)\s*\{[^}]*touch-action:\s*none/s);
```

- [x] **Step 2: Run the focused test and verify RED**

Run: `node --test src/ui/ui.test.mjs`

Expected: FAIL because the current meta tag disables scaling and the full-screen canvas/touch layer suppress browser gestures.

- [x] **Step 3: Apply the minimal viewport and gesture policy**

Set the viewport meta content exactly to `width=device-width, initial-scale=1, viewport-fit=cover`. Change `#viewport` and `#touch` to `touch-action: manipulation`; retain `touch-action: none` on `.touch-zone` and `.touch-btn`.

- [x] **Step 4: Run the focused test and verify GREEN**

Run: `node --test src/ui/ui.test.mjs`

Expected: PASS.

### Task 3: Explicit shader LOD in divergent marches

**Files:**
- Modify: `src/world/cloud/cloud.test.mjs`
- Modify: `src/world/terrain/material.test.mjs:20-40`
- Modify: `src/world/clouds.glsl.js:349-365,409-445`
- Modify: `src/world/Terrain.js:353-359`

**Interfaces:**
- Consumes: production shader strings exported by `clouds.glsl.js` and constructed inside `Terrain._generateLevel()`.
- Produces: `textureLod(uCloudDetail, q, 0.0)`, `textureLod(uCloudShape, shapeUvw, 0.0)`, and `textureLod(uHeights, ..., 0.0)` in `localHeight()`.

- [x] **Step 1: Write failing shader boundary tests**

Assert the production cloud GLSL uses explicit LOD for its 3D shape/detail volumes, and isolate the terrain `localHeight` function to assert its scratch height fetch is explicit LOD.

```js
assert.match(cloudGlsl, /textureLod\(uCloudDetail,\s*q,\s*0\.0\)/);
assert.match(cloudGlsl, /textureLod\(uCloudShape,\s*shapeUvw,\s*0\.0\)/);
assert.doesNotMatch(cloudGlsl, /texture\(uCloud(?:Detail|Shape),/);

const localHeightSource = terrainSource.slice(
  terrainSource.indexOf('float localHeight(vec2 xz)'),
  terrainSource.indexOf('float sunVisibility(', terrainSource.indexOf('float localHeight(vec2 xz)')),
);
assert.match(localHeightSource, /textureLod\(uHeights,[\s\S]*?,\s*0\.0\)/);
```

- [x] **Step 2: Run the shader tests and verify RED**

Run: `node --test src/world/cloud/cloud.test.mjs src/world/terrain/material.test.mjs`

Expected: FAIL on the three current implicit `texture(...)` calls.

- [x] **Step 3: Apply explicit base-level sampling**

Replace only the three affected implicit calls with `textureLod(..., 0.0)`. Do not change the terrain normal fetches outside the shadow march or the separate cloud composite history inputs.

- [x] **Step 4: Run the shader tests and verify GREEN**

Run: `node --test src/world/cloud/cloud.test.mjs src/world/terrain/material.test.mjs`

Expected: PASS without changing numeric weather or terrain material fixtures.

### Task 4: Portability evidence, full verification, and release

**Files:**
- Create: `docs/release-portability.md`
- Modify: `docs/superpowers/plans/2026-08-15-mobile-hotfix.md` (check completed steps)

**Interfaces:**
- Consumes: the completed code/test changes and browser evidence.
- Produces: an honest browser/GPU matrix, one verified hotfix commit, and updated `origin/main`.

- [x] **Step 1: Refresh locked dependencies and run static verification**

Run:

```powershell
npm ci
node --test (Get-ChildItem -Recurse -Filter *.test.mjs src | ForEach-Object FullName)
npm run build
git diff --check
```

Expected: dependency install, all Node tests, production build, and whitespace check pass.

- [ ] **Step 2: Run Chrome/ANGLE production browser checks**

Serve `dist`, open the production app in Chrome, and exercise 320 x 568, 390 x 844, 568 x 320, and 844 x 390 states. At 200% browser zoom, confirm the pause path remains reachable and recon controls remain inside the viewport. Capture `window.__stats()`, `window.__audit()`, runtime errors, and shader compiler warnings.

Status: PARTIAL. Chrome 151 completed the production title, briefing, flight, viewport-policy, and console checks without shader/compiler warnings. Production strips `window.__stats()` and `window.__audit()`, and the controlled browser surface cannot change its viewport or native zoom. Exact phone geometry is covered by the automated regression fixtures; native 200% touch-device zoom remains recorded as `NOT RUN` in `docs/release-portability.md`.

- [x] **Step 3: Record the portability matrix**

Create `docs/release-portability.md` with a dated matrix. Mark Chrome/ANGLE with its measured result; mark Firefox, Safari/WebKit, Android GPU, and iOS GPU as `NOT RUN` unless directly exercised. Include the exact remaining release requirement.

- [x] **Step 4: Re-run final verification after documentation**

Run:

```powershell
node --test (Get-ChildItem -Recurse -Filter *.test.mjs src | ForEach-Object FullName)
npm run build
git diff --check
git status --short --branch
```

Expected: all tests/build pass, no whitespace errors, and only the intended hotfix files are changed.

- [x] **Step 5: Commit and push the hotfix**

Run:

```powershell
git add -- index.html src/ui/styles.css src/ui/ui.test.mjs src/core/touch-controls.test.mjs src/world/clouds.glsl.js src/world/CloudVolume.js src/world/Terrain.js src/world/cloud/cloud.test.mjs src/world/terrain/material.test.mjs docs/release-portability.md docs/superpowers/plans/2026-08-15-mobile-hotfix.md
git commit -m "fix: harden mobile controls and shader portability"
git fetch origin
git rebase origin/main
git push origin main
```

Expected: push succeeds and local `main` matches `origin/main` with no uncommitted changes.
