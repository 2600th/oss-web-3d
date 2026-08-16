# Browser and GPU Portability Matrix

Last updated: 2026-08-16

This matrix records measured evidence for the mobile accessibility and shader-portability hotfix. `NOT RUN` is intentional: it must not be interpreted as a pass or replaced by evidence from another browser or GPU.

Provenance is part of every row. `MEASURED` means this machine ran the check and read the result; `USER REPORT` means a person running the deployed build said so, which is evidence about the target but is not a measurement and does not close a device gate on its own.

## Hotfix evidence

| Check | Environment | Result | Evidence |
| --- | --- | --- | --- |
| Production boot and flight | Chrome 151.0.7922.138, Windows, ANGLE/WebGL2 | PASS | Built application completed title, briefing, and flight; the HUD rendered and remained active. |
| Shader compiler/runtime console | Chrome 151.0.7922.138, Windows, ANGLE/WebGL2 | PASS WITH LOCAL NOTE | No GLSL compiler or application runtime warning was captured. Vercel Analytics reported its expected missing `/_vercel/insights/script.js` endpoint under local preview. |
| WebGL error audit | Production build | NOT RUN | Production strips the development-only `window.__audit()` hook, and the controlled browser surface does not expose the live WebGL context. |
| Responsive control geometry | Node regression contracts | PASS | 320 x 568, 360 x 640, 375 x 667, 390 x 664, 393 x 852, 402 x 691, 430 x 745, 568 x 320, 667 x 375, and 844 x 390 keep audited controls inside the viewport with at least 8 px separation, in Assisted *and* Direct mode. As of 2026-08-16 the contracts also assert alignment — one column width, one right edge, one slot pitch — and gate/reticle concentricity, because separation alone passed a layout in which no two controls lined up. |
| Coarse-pointer cascade | Chrome DevTools Protocol, `emulate` with `mobile,touch` | MEASURED 2026-08-16 | `matchMedia('(pointer: coarse)').matches` returns true under CDP touch emulation, so `@media (pointer: coarse)` rules apply and were measured live at 402 x 691, 844 x 390 and 568 x 320 in both control modes. This supersedes an earlier working assumption that the emulator could not reach that media query; two rounds of phone fixes shipped on a CSSOM simulation of the cascade, which cannot expose specificity or source-order faults and did not. |
| Browser zoom policy | Production HTML/CSS and interaction contracts | PASS | The viewport no longer restricts scaling; non-control surfaces use `touch-action: manipulation`; active controls retain `touch-action: none`; iOS gesture cancellation is scoped to control descendants. |
| Native browser zoom at 200% | Chrome on Windows | NOT RUN | The connected page-control surface cannot change browser chrome zoom, and the Windows fallback stopped because it could not identify the active Chrome URL with sufficient confidence. |

## Required external coverage

| Target | Status | Required exercise |
| --- | --- | --- |
| Firefox desktop/WebGL2 | NOT RUN | Boot production, fly through cloud and terrain views, enter recon, inspect console and rendered artifacts. |
| Safari/WebKit on macOS | NOT RUN | Repeat production flight/recon coverage and inspect shader compilation/rendering. |
| iOS Safari on a real device | PARTIAL — USER REPORT | Boot, flight and the recon optic are confirmed working on iOS Safari by the user running the deployed build (2026-08-16), with screenshots. That closes the loading failure the leaked WebGL2 probe context was suspected of causing — see the note below — and nothing else. Layout faults reported from the same device across three rounds were fixed against emulation, not re-verified on the device. Still required: pinch zoom to at least 200%, control capture/cancel behaviour, safe areas under a notch, landscape, clouds, and terrain shadows. |
| Android Chrome on a real mobile GPU | NOT RUN | Verify pinch zoom to at least 200%, portrait/landscape controls, clouds, terrain shadows, and sustained flight. |

## Shader change under test

The hotfix replaces implicit-derivative sampling with explicit base-level sampling in the known divergent paths:

- cloud detail: `textureLod(uCloudDetail, q, 0.0)`
- cloud shape: `textureLod(uCloudShape, shapeUvw, 0.0)`
- terrain shadow height: `textureLod(uHeights, ..., 0.0)`

These textures are configured for base-level/no-mipmap sampling, so the change removes dependence on undefined implicit derivatives without selecting a different mip level. Static source contracts prevent these three paths from reverting to implicit `texture(...)` calls.

## The iOS loading failure

The experience did not load on Chrome for iOS, and `supportsWebGL2()` was found creating a throwaway probe context and releasing it through `WEBGL_lose_context`, an extension that need not exist — so the probe leaked a context on any device where it is absent. One context is now acquired on the real canvas and handed to the renderer.

The leak was proven by reading the code and is definitely a defect. That it was *the* cause of the iOS failure was never reproduced from this machine. The user has since confirmed the deployed build loads on iOS, which is consistent with the fix and is the strongest evidence available, but a fix and a recovery observed together are not the same as a reproduction: this row should be read as "the failure is gone", not "the cause is established".

## Release gate

The code-level ANGLE warning cause is addressed and the local Chrome production smoke test is clean. A full cross-browser/GPU portability claim remains blocked until Firefox, Safari/WebKit, and at least one real mobile GPU have direct passing evidence. Native 200% zoom on a touch device is part of that device gate, and iOS Safari remains PARTIAL — a user report of successful boot does not discharge the device checks listed against it.
