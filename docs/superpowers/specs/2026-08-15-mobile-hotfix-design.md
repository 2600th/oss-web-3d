# Mobile UI, Accessibility, and GPU Portability Hotfix Design

Date: 2026-08-15
Status: Approved for implementation
Target: `main`

## Goal

Ship a focused hotfix that makes the flight and recon controls usable on narrow portrait and short landscape phones, restores browser zoom for accessibility, and removes the known undefined-derivative shader sampling paths. Preserve the existing desktop presentation and the current mobile layout at 390 x 844 where it already works.

## Confirmed findings

1. On short landscape viewports, the recon zoom-in control is placed above the viewport. The recon header and quality controls also compete for the limited vertical space.
2. On narrow portrait and short landscape viewports, the virtual stick and assisted recon or boost controls overlap the HUD tapes.
3. Mobile pause-menu segmented and toggle controls are below the 44 px touch-target baseline.
4. The viewport meta tag disables user scaling with `maximum-scale=1, user-scalable=no`, preventing low-vision users from zooming.
5. Cloud and terrain shaders use implicit-derivative texture sampling from divergent or variable loop paths. ANGLE can warn that the derivatives are undefined, so the current result is not portable evidence even when it renders correctly on one machine.
6. Firefox, Safari/WebKit, and real mobile GPU validation is not available in the current Windows environment. That matrix cannot be honestly marked complete by a source change alone.

## Design

### Responsive controls and HUD

- Keep the current layout unchanged for established desktop and 390 x 844 portrait use.
- Add a narrow-portrait layout for phone heights up to 700 px. Shorten and move the HUD tapes above the stick, and stack the assisted recon action above boost. When recon mode is open and boost is hidden, recon reuses the lower action slot.
- Add a short-landscape layout for coarse pointers at heights up to 420 px. Use a right-side action rail for recon, shutter, zoom-out, and zoom-in so every control remains inside the safe viewport. Move the right HUD tape inward and compact both tapes vertically to keep them clear of the stick and action rail.
- Constrain the recon header, frame number, and quality selector to the free center lane in short landscape.
- Give pause-menu segmented, toggle, and slider controls a minimum 44 px coarse-pointer hit area.
- Protect existing safe-area inset handling and the current pointer capture, cancel, blur, pause, and modal reset behavior.

Regression geometry will cover at least 320 x 568, 360 x 640, 375 x 667, 390 x 844, 568 x 320, 667 x 375, and 844 x 390.

### Browser zoom accessibility

- Change the viewport declaration to `width=device-width, initial-scale=1, viewport-fit=cover` and remove both scale restrictions.
- Permit browser gestures on non-control presentation surfaces. Keep `touch-action: none` scoped only to active joystick and button controls so flight input does not accidentally pan or zoom the page.
- Verify that browser zoom reaches 200% without hiding the pause path or breaking touch-control containment at the target phone layouts.

### Shader portability

- Replace implicit cloud shape/detail reads that can execute within divergent ray-march paths with explicit base-level `textureLod(..., 0.0)` sampling.
- Replace the terrain height lookup used by the variable shadow march with explicit base-level `textureLod(..., 0.0)` sampling.
- Keep the change restricted to textures whose current configuration is base-level/no-mipmap sampling, preserving the intended visual input while removing dependence on undefined implicit derivatives.
- Add source-contract regressions so the affected functions cannot silently return to implicit sampling.

Static loop unrolling is not the chosen fix because divergent branches can still make implicit derivatives undefined. Explicit LOD addresses the cause directly.

### Portability release gate

Create a checked-in validation matrix that records exact browser/GPU coverage and results. This hotfix will run the locally available Chrome/ANGLE production smoke test and capture console/audit evidence. Firefox, Safari/WebKit, and at least one real mobile GPU remain required release checks and must be reported as not run until measured on those targets; no proxy result will be presented as equivalent.

## Verification

- Focused tests first, demonstrating each new regression fails before implementation and passes afterward.
- Full Node test suite.
- Production build from refreshed locked dependencies.
- Chrome/ANGLE production boot and flight/recon smoke checks at representative portrait and landscape viewports.
- Browser zoom check at 200%, including pause access and recon controls.
- Console review for shader compiler warnings and runtime errors.
- `git diff --check` and final repository status review before commit and push.

## Scope boundaries

- No visual restyling, rendering overhaul, gameplay tuning, or unrelated dependency work.
- No claim of Firefox, Safari/WebKit, or real-device GPU portability without direct evidence.
- If explicit LOD produces an observable cloud or terrain regression, stop the release, capture the evidence, and revisit the sampling path rather than masking the difference.

## Rollback

The hotfix will be committed as a focused change on `main`. It can be reverted as one commit if browser zoom gestures interfere with controls or if any shader sampling regression appears in downstream device testing.
