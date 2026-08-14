# Takram Himalayan Haze Tweak Design

## Goal

Remove the noisy grey full-screen veil from the `takram-himalayan` comparison profile without changing the exact `takram-reference` profile, cloud assets, layer density, coverage, quality tier, atmosphere LUTs, temporal renderer, or production game renderer.

## Design

Cloud profiles will explicitly author whether Takram's inexpensive approximate haze pass is enabled. `takram-reference` will retain the upstream-guided default (`haze: true`). `takram-himalayan` will inherit the same cloud layers and weather parameters but override only `haze: false`.

`TakramCloudRendererAdapter` will apply the selected profile's haze value when constructing the effect and when reporting the active profile. No shader fork or post-grade will be added.

## Failure behavior

Unknown or missing profile data continues to fail through the existing profile-selection contract. Quality changes and context restoration reconstruct the effect from the same immutable selected profile, so the Himalayan haze choice remains deterministic.

## Verification

- RED/GREEN profile and adapter tests prove reference haze stays enabled and Himalayan haze is disabled.
- Existing exact-reference layer, asset, WGS84, depth, disposal, and eligibility tests remain green.
- A fresh Chrome capture of `scenario=himalayan-opening` must have no console issues and must visibly reduce the grey full-width veil compared with the saved baseline.
- If the remaining cloud bodies are still grainy, density and coverage are left unchanged and handled as a separate follow-up rather than bundled into this tweak.

