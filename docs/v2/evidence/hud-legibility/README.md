# HUD legibility over bright terrain

Every HUD stroke and label has to stay readable over white cloud, sunlit snow and
rock, the burner glow and the night sky. Terrain never hid the HUD. The problem was
contrast: pale `dim` numerals, a thin 68 % glyph halo, unbacked bars, and target
labels that landed on the player's own jet in chase view.

## What changed

- **Daylight halo** (`src/ui/theme.js` `DAY`, `adaptTheme`, `daylight`). The HUD reads
  the post chain's metered luminance (`post.stats.adaptedLog2 + ev`; PostFX already
  reads its 1x1 meter back, so the HUD adds no readback). That gives a daylight
  factor `k`, eased over about a second.
  - At `k = 1` the tight halo goes near-opaque (strokes 0.8 to 0.92, glyphs 0.68 to
    0.90) and slightly wider. A soft wide halo (alpha 0.3) darkens the surround
    without a hard black edge.
  - `dim` and `faint` ink gain alpha (0.74 to 0.90, 0.40 to 0.62), so secondary
    numerals stop reading as grey.
  - Hairline widths, font sizes and the hierarchy do not change.
  - At night (`k = 0`) the theme is exactly the previous one.
- **Tape end fade.** In daylight the fade toward the tape ends stops at 0.6, because
  it was fading the outer numerals' halo as well.
- **Dark plates under the bars.** In daylight, the THR column, the AIRFRAME segments
  and the objective progress get a dark plate, the same treatment the boxed
  readouts already use.
- **Labels avoid the jet.** In the outside views, target labels treat the player's
  jet as an obstacle (`src/ui/ownJet.js`).
  - The jet is six model-space boxes (fuselage and nozzle glow, fin, inner wing with
    stores, stabilators, outer panels). They are projected to screen rects, which
    follows the jet's cross shape rather than its bounding rect.
  - Leader lines get one longer reach while the jet is on screen.
  - The flight path marker is also a label obstacle now, so a label pushed off the
    jet does not land on it.
  - Markers still draw where their targets are. First person (cockpit, HUD view) is
    unchanged.

## Contrast (measured)

`tools/hud/hud-contrast.mjs` compares the composited screenshot with the HUD canvas
captured on the same paused frame.
- **Ink** is the pixels the HUD paints opaque in a light or coloured ink. Its core
  luminance is the 75th percentile.
- **Surround** is every other pixel within 2 px of ink, so it includes the halo. Its
  luminance is the median.
- The ratio is (ink + 0.05) / (surround + 0.05), in WCAG relative luminance.

"Before" is the same frame redrawn with `haloBoost = 0`, the pre-change halos, with
the own-jet obstacle off. 1920x1080, DPR 1, ultra quality, WebGPU.

| region | level (sunlit rock, cumulus) | cloud (6.3 km, bright overcast) | valley (golden light, snow, burner) | night (23:00) |
|---|---|---|---|---|
| speed tape numerals + ticks | 3.8 -> 6.6 | 3.2 -> 5.0 | **1.6 -> 3.7** | 6.2 -> 6.3 |
| altitude tape | 4.8 -> 5.7 | 3.0 -> 7.0 | 3.5 -> 8.7 | 7.7 -> 7.7 |
| KT / FT tags | 5.2 -> 12.4 | 5.2 -> 12.4 | **2.6 -> 11.7** | 6.4 -> 6.4 |
| heading tape | 5.4 -> 12.3 | 4.6 -> 12.3 | 4.3 -> 12.2 | 6.9 -> 6.9 |
| pitch ladder / waterline | 12.1 -> 13.3 | 10.1 -> 10.5 | 8.5 -> 11.8 | 8.0 -> 7.9 |
| THR column | 7.1 -> 13.5 | 7.1 -> 13.4 | 8.0 -> 13.2 | 8.8 -> 8.8 |
| AIRFRAME bar | 6.6 -> 11.9 | 4.3 -> 9.2 | 16.8 -> 17.4 | 17.8 -> 17.8 |
| objective line | 11.9 -> 15.1 | 9.7 -> 14.9 | 8.0 -> 7.0 * | 13.2 -> 13.2 |
| red air-target label + edge arrow | **2.0 -> 4.3** | — | — | 2.8 -> 2.8 |
| orange ground-target labels | 5.8 -> 12.6 | **2.8 -> 3.9** | 9.2 -> 11.7 | 9.4 -> 9.4 |

- Every region is at or above 3:1 after the change. The weakest is the speed tape in
  the valley shot, 3.7, where it crosses sunlit cloud.
- \* The valley objective value dips because the empty progress segments now cross
  the measurement's 50 % ink-alpha threshold and count as ink. They are `faint` ink
  at 0.62 on a dark plate, so the median moves. The objective text itself is not
  weaker.
- Night is unchanged by design (`k = 0` there): the halos do not turn into grey
  smudges over a dark sky. The red air-target label at night (2.8) is limited by the
  luminance of the red hue on a black surround, as it was before.
- Per-frame cost: HUD redraw on the CPU, 24 targets, valley scene, 300 redraws each.
  Night style averaged 0.21–0.23 ms; day style with the own-jet obstacle averaged
  0.25–0.28 ms. That is about +0.04 ms. The wide halo is one extra stroke per element,
  and the jet is 48 projected points. No GPU readback, and no allocation in the steady
  state: the theme is rebuilt only when `k` moves by a 0.05 step.

## Files

Before/after pairs are on the same paused frame. Only the HUD is redrawn between
them.

- `level-*.jpg`, `level-zoom-pair.png`: sunlit rock and white cumulus. The zoom shows
  the tapes and an edge arrow, before above after.
- `cloud-*.jpg`, `cloud-zoom-pair.png`, `cloud-chrome-zoom-pair.png`: inside bright
  overcast at 6.3 km. The second pair shows the objective line, heading tape and
  AIRFRAME bar.
- `valley-*.jpg`, `valley-zoom-pair.png`, `valley-labels-pair.png`: m1 ridge
  positions under the nose in golden light, with snow and the burner.
  - Before: SANGAR / TGT / range text sits on the wing and nozzle.
  - After: the labels sit on leader lines clear of the airframe and the flight path
    marker.
- `valley-own-jet-obstacles.jpg`: the same frame with the six own-jet obstacle rects
  outlined (debug overlay from the capture helper, not drawn in game).
- `night-*.jpg`, `night-zoom-pair.png`: 23:00 under the moon. Before and after are
  identical apart from label placement.
- `phone-landscape-*.jpg`: 844x390, touch layout (mobile + touch emulation), bright
  overcast.
- `webgl2-after.jpg`, `webgl2-cockpit-after.jpg`: `?webgl` fallback. Metering works
  there too (`k = 1`). The cockpit view has the halo change only; no own-jet
  obstacle in first person.

## Reproducing

1. Start the dev server and open
   `/?mission=free&quality=ultra&noadaptive` at 1920x1080x1.
2. Load `tools/hud/hud-capture.js` into the page, for example through chrome-devtools
   `evaluate_script` with `sourcePath` and format `script`.
3. Spawn the scene, let exposure settle, then call `__hudLeg.freeze()`.
4. Capture the before state: call `__hudLeg.redraw(0, false)`, take a screenshot, and
   save `JSON.stringify(__hudLeg.capture())`.
5. Capture the after state: call `__hudLeg.redraw(null, true)`, take a screenshot, and
   save the capture again.
6. For each screenshot and its capture, run
   `node tools/hud/hud-contrast.mjs shot.png capture.json`.

Scenes:
- level: `spawnAt({x:-14000,z:4000,agl:1500,speed:240,heading:270})`
- cloud: `{x:2000,z:43000,alt:6300,speed:200,heading:0}`
- valley: `T.sortie('m1')`, then `{x:-29300,z:150,alt:5450,speed:180,heading:270}`
- night: `game.env.setTimeOfDay(23)`
