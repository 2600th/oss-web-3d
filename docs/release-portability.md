# Browser and GPU Portability Matrix

Last updated: 2026-08-15

This matrix records measured evidence for the mobile accessibility and shader-portability hotfix. `NOT RUN` is intentional: it must not be interpreted as a pass or replaced by evidence from another browser or GPU.

## Hotfix evidence

| Check | Environment | Result | Evidence |
| --- | --- | --- | --- |
| Production boot and flight | Chrome 151.0.7922.138, Windows, ANGLE/WebGL2 | PASS | Built application completed title, briefing, and flight; the HUD rendered and remained active. |
| Shader compiler/runtime console | Chrome 151.0.7922.138, Windows, ANGLE/WebGL2 | PASS WITH LOCAL NOTE | No GLSL compiler or application runtime warning was captured. Vercel Analytics reported its expected missing `/_vercel/insights/script.js` endpoint under local preview. |
| WebGL error audit | Production build | NOT RUN | Production strips the development-only `window.__audit()` hook, and the controlled browser surface does not expose the live WebGL context. |
| Responsive control geometry | Node regression contracts | PASS | 320 x 568, 360 x 640, 375 x 667, 390 x 844, 568 x 320, 667 x 375, and 844 x 390 keep audited controls inside the viewport with at least 8 px separation from relevant HUD lanes. |
| Browser zoom policy | Production HTML/CSS and interaction contracts | PASS | The viewport no longer restricts scaling; non-control surfaces use `touch-action: manipulation`; active controls retain `touch-action: none`; iOS gesture cancellation is scoped to control descendants. |
| Native browser zoom at 200% | Chrome on Windows | NOT RUN | The connected page-control surface cannot change browser chrome zoom, and the Windows fallback stopped because it could not identify the active Chrome URL with sufficient confidence. |

## Required external coverage

| Target | Status | Required exercise |
| --- | --- | --- |
| Firefox desktop/WebGL2 | NOT RUN | Boot production, fly through cloud and terrain views, enter recon, inspect console and rendered artifacts. |
| Safari/WebKit on macOS | NOT RUN | Repeat production flight/recon coverage and inspect shader compilation/rendering. |
| iOS Safari on a real device | NOT RUN | Verify pinch zoom to at least 200%, control capture/cancel behavior, safe areas, portrait/landscape layouts, clouds, and terrain shadows. |
| Android Chrome on a real mobile GPU | NOT RUN | Verify pinch zoom to at least 200%, portrait/landscape controls, clouds, terrain shadows, and sustained flight. |

## Shader change under test

The hotfix replaces implicit-derivative sampling with explicit base-level sampling in the known divergent paths:

- cloud detail: `textureLod(uCloudDetail, q, 0.0)`
- cloud shape: `textureLod(uCloudShape, shapeUvw, 0.0)`
- terrain shadow height: `textureLod(uHeights, ..., 0.0)`

These textures are configured for base-level/no-mipmap sampling, so the change removes dependence on undefined implicit derivatives without selecting a different mip level. Static source contracts prevent these three paths from reverting to implicit `texture(...)` calls.

## Release gate

The code-level ANGLE warning cause is addressed and the local Chrome production smoke test is clean. A full cross-browser/GPU portability claim remains blocked until Firefox, Safari/WebKit, and at least one real mobile GPU have direct passing evidence. Native 200% zoom on a touch device is part of that device gate.
