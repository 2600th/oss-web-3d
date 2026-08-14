# Modern Crash Explosion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a terrain-aware, staged aircraft-impact explosion that reads like a modern combat game on every quality tier while remaining bounded, deterministic and lifecycle-safe.

**Architecture:** Preserve a stable impact snapshot in the flight model, render one prewarmed shader shell/ring/light component owned by `FlightFx`, and drive existing GPU fire/smoke/spark/debris systems from the impact vector and terrain normal. `Game` dispatches the crash once and `Aircraft` owns the intact-airframe/exhaust presentation reset.

**Tech Stack:** Three.js 0.185.1, WebGL2/GLSL3, existing GPU `ParticleSystem`, Node test runner, Vite, in-app Browser.

## Global Constraints

- The impact flash is 0-140 ms; blast development is 80-900 ms; aftermath remains readable through the 2.1 second crash hold.
- Impact light is precreated, casts no shadows, has a maximum 120 m range and decays within 350 ms.
- Fire soft-depth fade is 4 m; smoke soft-depth fade is 10 m; hardware depth testing remains enabled.
- Shock ring segment budgets are High 96, Medium 72, Low 48 and Phone 32.
- Peak fireball diameter stays below 35% of the shorter viewport dimension.
- No persistent decal, aircraft fracture simulation, second renderer, render target or steady-state allocation is allowed.
- Reduced-motion attenuates camera/post impulses but never removes the essential explosion cue.
- `LinearAbiltyCastingThreeJS` is pinned to `f9ba4f91bfa1506b98f5f3cf801b80a975d7dd1a`; adapt only BurstSphere shell displacement/dissolve, GroundDecals ring expansion and the precreated impact-light pattern.
- Expand shipped attribution when the impact shell/ring algorithms are added.
- All code changes are test-first and every task receives independent review before the next task.

---

### Task 1: Preserve the terrain-impact contract

**Files:**
- Modify: `src/flight/FlightModel.js:100-125,300-335`
- Modify: `src/core/input-lifecycle.test.mjs`

**Interfaces:**
- Produces: `flight.impactVelocity: THREE.Vector3`, `flight.impactNormal: THREE.Vector3` and the existing `impactPoint`/`impactSpeed`.
- Invariant: properties are constructor-owned stable vectors, reset on launch, populated before `flight.velocity` is zeroed.

- [ ] **Step 1: Add failing traversed-collision tests**

Extend the real collision regression so it records the pre-impact velocity and independently reconstructs a heightfield normal around `impactPoint`:

```js
assert.strictEqual(flight.impactVelocity, impactVelocityIdentity);
assert.ok(flight.impactVelocity.length() > 1, 'impact keeps incoming velocity before stop');
assert.ok(Math.abs(flight.impactVelocity.length() - flight.impactSpeed) < 1e-6);
assert.ok(Math.abs(flight.impactNormal.length() - 1) < 1e-6);
assert.ok(flight.impactNormal.y > 0.2, 'terrain normal points away from terrain');
```

Add a reset assertion that identities remain stable and values return to velocity `(0,0,0)` and normal `(0,1,0)`.

- [ ] **Step 2: Run RED**

Run: `node --test src/core/input-lifecycle.test.mjs`

Expected: FAIL because `impactVelocity` and `impactNormal` do not exist.

- [ ] **Step 3: Implement stable impact vectors**

In the constructor:

```js
this.impactVelocity = new THREE.Vector3();
this.impactNormal = new THREE.Vector3(0, 1, 0);
```

In launch/reset, mutate those vectors rather than replacing them. In collision, before velocity is changed:

```js
this.impactVelocity.copy(this.velocity);
const epsilon = 4;
const left = terrainHeight(x - epsilon, z);
const right = terrainHeight(x + epsilon, z);
const back = terrainHeight(x, z - epsilon);
const front = terrainHeight(x, z + epsilon);
this.impactNormal.set(left - right, epsilon * 2, back - front).normalize();
this.impactSpeed = this.impactVelocity.length();
```

- [ ] **Step 4: Run GREEN**

Run: `node --test src/core/input-lifecycle.test.mjs`

Expected: all lifecycle/collision contracts PASS.

- [ ] **Step 5: Commit**

```powershell
git add -- src/flight/FlightModel.js src/core/input-lifecycle.test.mjs
git commit -m "fix: preserve terrain impact direction"
```

---

### Task 2: Build the prewarmed impact shell, ring and light

**Files:**
- Create: `src/fx/flight/ImpactBlast.js`
- Create: `src/fx/flight/impact-blast.glsl.js`
- Create: `src/fx/flight/impact-blast.test.mjs`
- Modify: `public/THIRD_PARTY_NOTICES.txt`

**Interfaces:**
- Produces: `new ImpactBlast(): { group, trigger(impact), update(dt), setQuality(tier), reset(), dispose() }`.
- `impact` is `{ position: Vector3, velocity: Vector3, normal: Vector3, speed: number, strength: number }`.
- `group` contains one shell mesh, one ring mesh and one zero-intensity no-shadow `PointLight`, all precreated.

- [ ] **Step 1: Write failing source and behavioral contracts**

Create tests that import `ImpactBlast` and assert:

```js
const blast = new ImpactBlast();
assert.equal(blast.light.castShadow, false);
assert.equal(blast.light.distance, 120);
assert.equal(blast.shell.visible, false);
assert.equal(blast.ring.visible, false);

blast.setQuality({ name: 'phone' });
assert.equal(blast.ring.geometry.drawRange.count, 32 * 6);

blast.trigger({ position, velocity, normal, speed: 280, strength: 0.875 });
assert.equal(blast.shell.visible, true);
assert.equal(blast.ring.visible, true);
assert.ok(blast.light.intensity > 0);
const aligned = new THREE.Vector3(0, 1, 0).applyQuaternion(blast.ring.quaternion);
assert.ok(aligned.angleTo(normal) < 1e-6);
```

Use `new THREE.Vector3(0,1,0).applyQuaternion(blast.ring.quaternion)` for the real orientation assertion. Assert `update(0.36)` zeros light intensity, `update(1.25)` hides both meshes, `reset()` is idempotent, and disposal emits each geometry/material once.

Add source assertions for one displaced shell shader, one dissolve threshold, the `pow(age, 0.55)` ring profile, GLSL3 output declarations and no `gl_FragColor`.

- [ ] **Step 2: Run RED**

Run: `node --test src/fx/flight/impact-blast.test.mjs`

Expected: FAIL with module-not-found for `ImpactBlast.js`.

- [ ] **Step 3: Implement shaders and prewarmed resources**

Create a GLSL3 shell using the existing FX noise helper. The vertex shader displaces the unit sphere along its normal with bounded FBM and the fragment shader emits an HDR white/amber core whose alpha dissolves with age. Create a thin terrain-normal ring whose radius follows:

```js
const ringProgress = Math.pow(clamp01(age / 0.9), 0.55);
const radius = THREE.MathUtils.lerp(2.5, 28, ringProgress);
```

Use one maximum-detail geometry and tier-specific `drawRange`; do not reconstruct geometry on quality changes. Align the ring with:

```js
this.ring.quaternion.setFromUnitVectors(UP, impact.normal);
```

Construct the point light at startup with `intensity=0`, `distance=120`, `decay=2`, `castShadow=false`. `trigger()` only mutates existing state/uniforms/transforms.

- [ ] **Step 4: Run GREEN and shader validation**

Run:

```powershell
node --test src/fx/flight/impact-blast.test.mjs
npm run check
```

Expected: test PASS and GLSL template check PASS.

- [ ] **Step 5: Update attribution**

Extend the existing LinearAbiltyCastingThreeJS notice description to include the impact shell displacement/dissolve and shockwave radius profile. Preserve the existing complete MIT text and copyright.

- [ ] **Step 6: Commit**

```powershell
git add -- src/fx/flight/ImpactBlast.js src/fx/flight/impact-blast.glsl.js src/fx/flight/impact-blast.test.mjs public/THIRD_PARTY_NOTICES.txt
git commit -m "feat: add terrain impact blast shell"
```

---

### Task 3: Integrate staged particles and crash presentation

**Files:**
- Modify: `src/fx/FlightFx.js:62-105,155-220,225-235,378-428`
- Modify: `src/fx/gpu/ParticleSystem.js`
- Modify: `src/fx/flight/gpu-flight-fx.test.mjs`
- Modify: `src/flight/Aircraft.js:66-82,282-317`
- Modify: `src/game/Game.js:160-180,550-690`
- Modify: `src/game/integration/aaa-integration.test.mjs`

**Interfaces:**
- Consumes: `ImpactBlast` from Task 2 and impact vectors from Task 1.
- Produces: `FlightFx.crash(impact)` and `Aircraft.setCrashPresentation(active)`.
- `Game` owns one constructor-allocated `_impactEvent` with stable vector properties and passes it once.

- [ ] **Step 1: Write failing staged-impact tests**

Replace cursor-only crash coverage with assertions that:

```js
fx.crash(impact);
assert.ok(fx.explosion.cursor > 0);
assert.ok(fx.smoke.cursor > 0);
assert.ok(fx.sparks.cursor > 0);
assert.ok(fx.debris.cursor > 0);
assert.equal(fx.explosion.uniforms.uSoftFade.value, 4);
assert.equal(fx.smoke.uniforms.uSoftFade.value, 10);
assert.ok(fx.debris.lastSpawn.inherit.dot(impact.velocity) > 0);
assert.ok(fx.sparks.lastSpawn.velocity.dot(impact.normal) > 0);
```

If no public `lastSpawn` exists, instrument the test by wrapping `emit(count, spawn)` and copying the passed values in the test only; do not add production debug state.

Add integration coverage proving crash dispatch receives the preserved impact event exactly once, invokes `aircraft.setCrashPresentation(true)`, and launch invokes `setCrashPresentation(false)` plus `fx.resetImpact()`.

Add a reduced-motion post regression: with `_reducedMotion=true`, the essential impact shell/light still triggers, but the crash contribution passed to heat distortion is at most 20% of the normal crash contribution and motion blur remains zero.

Add an `Aircraft` test seam asserting crash mode hides `model`, hides `exhaust`, and prevents `update()` from restoring plume visibility until reset.

- [ ] **Step 2: Run RED**

Run:

```powershell
node --test src/fx/flight/gpu-flight-fx.test.mjs src/game/integration/aaa-integration.test.mjs
```

Expected: FAIL on the new signatures, depth fades, impact ownership and aircraft lifecycle.

- [ ] **Step 3: Add per-system soft fade and staged emissions**

Keep `ParticleSystem` defaults unchanged; permit its constructor to accept `softFade = 40` and add an owned `uSoftFade: { value: softFade }` inside the object passed to `sharedUniforms()`. This intentionally shadows only the shared default for that material; never mutate `frameUniforms.uSoftFade`. Configure only impact fire to 4 and smoke to 10.

Change `FlightFx.crash` to consume the impact object. Trigger the `ImpactBlast` first. Emit a compact 80-140 ms white-hot core, then orange lobes with the existing explosion system. Construct reflected and tangential directions from the stable impact vectors:

```js
reflected.copy(impact.velocity).reflect(impact.normal).normalize();
tangent.copy(impact.velocity).addScaledVector(impact.normal, -impact.velocity.dot(impact.normal)).normalize();
```

Bias sparks, debris and terrain dust upward and along these directions. Preserve existing capacities and tier `active` limits.

- [ ] **Step 4: Own impact lifecycle in FlightFx and Aircraft**

Add `ImpactBlast.group` to `FlightFx.group`; call its `update(dt)` before flushing systems. Add `resetImpact()` and dispose it with the other owned resources.

Implement:

```js
setCrashPresentation(active) {
  this._crashPresentation = Boolean(active);
  this.model.visible = !this._crashPresentation;
  this.exhaust.visible = !this._crashPresentation;
}
```

At the beginning of `Aircraft.update`, keep position/orientation current, then return before exhaust mutation while crash presentation is active.

- [ ] **Step 5: Wire one stable Game impact event**

Allocate the event and its vectors in the constructor. In `onCrash`, copy `impactPoint`, `impactVelocity`, `impactNormal`, `impactSpeed` and strength; call `fx.crash(event)` once, disable aircraft presentation, and preserve existing audio/post impulse. In `launch`, reset both VFX and aircraft presentation.

In `_updatePostEffects`, multiply only the crash contribution to heat distortion by `0.2` when reduced motion is active. Do not attenuate the shell, ring, light, smoke or audio cue.

- [ ] **Step 6: Run GREEN and full focused suite**

Run:

```powershell
node --test src/fx/flight/impact-blast.test.mjs src/fx/flight/gpu-flight-fx.test.mjs src/core/input-lifecycle.test.mjs src/game/integration/aaa-integration.test.mjs
npm run check
npm run build
```

Expected: all focused tests PASS, GLSL check PASS and Vite build PASS.

- [ ] **Step 7: Commit**

```powershell
git add -- src/fx/FlightFx.js src/fx/gpu/ParticleSystem.js src/fx/flight/gpu-flight-fx.test.mjs src/flight/Aircraft.js src/game/Game.js src/game/integration/aaa-integration.test.mjs
git commit -m "feat: stage directional crash explosion"
```

---

### Task 4: Live visual gate and regression closure

**Files:**
- Modify only if a reproduced gate failure requires it: files owned by Tasks 1-3 and their tests
- Create evidence: `.agent/crash-vfx/` (ignored, not committed)

**Interfaces:**
- Consumes the complete crash presentation.
- Produces capture evidence and a review report; no production diagnostics remain.

- [ ] **Step 1: Add a deterministic development-only crash harness seam**

Use an existing DEV diagnostic surface or a test-only harness page to start from a deterministic position/velocity that collides with terrain. It must exercise real `FlightModel.checkTerrainCollision()`, `Game.onCrash()`, the real camera and final composer. It must be absent from production bundles.

- [ ] **Step 2: Capture High timeline**

At 1920x1080 High, capture the nearest rendered frames to 0, 100, 300, 800 and 1,800 ms after collision. Record console logs and debug FPS/quality values. Save under `.agent/crash-vfx/high-*.png`.

- [ ] **Step 3: Capture Phone timeline**

Repeat at 390x844 Phone. Confirm the blast is readable without bloom/heat distortion and does not obscure controls or the full screen. Save under `.agent/crash-vfx/phone-*.png`.

- [ ] **Step 4: Quantify coverage and lifecycle**

Measure the bright/fire connected component in each 0-800 ms capture. Assert its maximum diameter is below 35% of the shorter viewport dimension. Confirm no afterburner pixels remain, crash dispatch count is one, all resources survive reset, and the next sortie restores the aircraft.

- [ ] **Step 5: Run repository verification**

Run:

```powershell
$tests=@(rg --files src -g '*.test.mjs' -g '*.test.js' | Sort-Object)
node --test $tests
npm run check
npm run build
npm audit --omit=dev
git diff --check
```

Expected: zero test failures, GLSL/build PASS, zero production vulnerabilities and no whitespace errors.

- [ ] **Step 6: Commit any evidence-driven correction**

If no production correction was needed, do not create an empty commit. Otherwise commit only the reviewed correction and its regression:

```powershell
git add -- src/flight/FlightModel.js src/fx/flight/ImpactBlast.js src/fx/flight/impact-blast.glsl.js src/fx/FlightFx.js src/fx/gpu/ParticleSystem.js src/flight/Aircraft.js src/game/Game.js src/fx/flight/impact-blast.test.mjs src/fx/flight/gpu-flight-fx.test.mjs src/core/input-lifecycle.test.mjs src/game/integration/aaa-integration.test.mjs
git commit -m "fix: pass crash explosion visual gate"
```
