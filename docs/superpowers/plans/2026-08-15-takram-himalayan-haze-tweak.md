# Takram Himalayan Haze Tweak Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Disable Takram's approximate haze only for the Himalayan comparison profile so the grey full-width veil is reduced without changing the exact reference profile or cloud density/weather authoring.

**Architecture:** Add an immutable `haze` decision to each selected Takram cloud profile and apply it when constructing `CloudsEffect`. Surface the value in the existing profile report so diagnostics can prove which path rendered.

**Tech Stack:** JavaScript ES modules, Node test runner, Three.js 0.185.1, `@takram/three-clouds` 0.7.6, Vite, Chrome comparison harness.

## Global Constraints

- `takram-reference` must retain `haze: true` and all existing layer, coverage, weather, asset, atmosphere, depth, temporal, and quality values.
- `takram-himalayan` must change only `haze` to `false`; density, coverage, weather repeat, weather velocity, and translated layer geometry remain unchanged.
- Do not modify production game cloud selection or shaders.
- A passing numeric test is not visual acceptance; inspect the final composited Chrome frame.

---

### Task 1: Profile-specific Takram haze

**Files:**
- Modify: `src/world/cloud/TakramCloudProfiles.js`
- Modify: `src/world/cloud/TakramCloudRendererAdapter.js`
- Test: `src/world/cloud/takram-cloud-profiles.test.mjs`
- Test: `src/world/cloud/takram-cloud-renderer.test.mjs`

**Interfaces:**
- Consumes: `getTakramCloudProfile(name, context)` and `TakramCloudRendererAdapter` constructor options already used by the comparison harness.
- Produces: immutable `cloudProfile.haze: boolean`; `getProfileReport().haze: boolean`; constructed `CloudsEffect.haze` matching the selected profile.

- [ ] **Step 1: Write the failing profile and adapter tests**

Add literal assertions that catch the wrong-profile branch:

```js
assert.equal(getTakramCloudProfile('takram-reference').haze, true);
assert.equal(deriveHimalayanCloudProfile(context).haze, false);
assert.equal(reference.effect.haze, true);
assert.equal(himalayan.effect.haze, false);
assert.equal(himalayan.getProfileReport().haze, false);
```

Keep the existing deep comparisons for layers, coverage, weather repeat, and weather velocity so changing those values cannot satisfy this task.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```powershell
node --test src/world/cloud/takram-cloud-profiles.test.mjs src/world/cloud/takram-cloud-renderer.test.mjs
```

Expected: FAIL because both profiles lack an authored `haze` value and the adapter still uses Takram's default haze.

- [ ] **Step 3: Implement the minimal profile decision**

In `TakramCloudProfiles.js`, add `haze: true` to `REFERENCE_PROFILE` and override it only in the object passed to `cloneProfile()` by `deriveHimalayanCloudProfile()`:

```js
return cloneProfile({
  ...REFERENCE_PROFILE,
  name: 'takram-himalayan',
  haze: false,
  altitudeTranslation: { cumulus: cumulusOffset, cirrus: cirrusOffset },
  layers,
});
```

In `TakramCloudRendererAdapter._constructEffect()`, apply the profile immediately after the quality preset:

```js
effect.qualityPreset = this.profile.takram;
effect.haze = this.cloudProfile.haze;
```

Add `haze: this.cloudProfile.haze` to both branches of `getProfileReport()`.

- [ ] **Step 4: Verify GREEN and regression scope**

Run:

```powershell
node --test src/world/cloud/takram-cloud-profiles.test.mjs src/world/cloud/takram-cloud-renderer.test.mjs src/world/cloud/cloud-comparison.test.mjs
npm run check
npm run build:cloud-comparison
```

Expected: all tests and builds pass with no warnings/errors attributable to the change.

- [ ] **Step 5: Run the visual A/B gate**

Refresh the existing Chrome Himalayan comparison URL:

```text
http://127.0.0.1:5174/src/world/cloud/comparison.html?backend=takram&quality=high&profile=takram-himalayan&view=composite&scenario=himalayan-opening
```

Save a fresh screenshot and result JSON. Confirm `eligibility.eligible=true`, `consoleIssues=[]`, and the full-width grey veil is visibly reduced relative to `.agent/cloud-comparison/takram-final/final-himalayan-composite.png`. Do not claim the remaining cloud bodies are fixed if they are still grainy.

- [ ] **Step 6: Commit the implementation**

```powershell
git add -- src/world/cloud/TakramCloudProfiles.js src/world/cloud/TakramCloudRendererAdapter.js src/world/cloud/takram-cloud-profiles.test.mjs src/world/cloud/takram-cloud-renderer.test.mjs
git commit -m "fix: disable Himalayan Takram haze"
```

