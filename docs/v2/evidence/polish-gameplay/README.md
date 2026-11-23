# Gameplay polish: bot runs and verification

All runs are flown by `src/game/dev/Bot.js` through the real input path
(`game.autopilot` intent -> Standard assist -> flight model; weapons through
`input.pressAction`), damage on, no teleporting, at about 20x real time
(`game.dev.batch(id, n, {difficulty})`). Raw records: `runs-0-baseline.json`,
`runs-1-after.json`, `runs-2-final-storm.json`.

Read the comparison with care: the bot itself was improved between "before" and
"after" (terrain look-ahead, initial points, a recon set-up, missile defence), so
the change in win rate is tuning **and** a better pilot. The baseline deaths are
still what drove the tuning: every one of them was to ground fire inside the first
three minutes.

## Before (untuned, Normal did not exist yet; 3 runs each)

| Sortie | Wins | Died to |
| --- | --- | --- |
| M1 First Light | 0/3 | AAA x2, shoulder-launched missile x1 |
| M2 River of Stone | 0/3 | position overrun x2, shot down x1 |
| M3 Long Lens | 0/3 | radar SAM x2 (at about 61 s), AAA x1 |
| M4 Tiger's Teeth | 0/3 | flak / AAA x3 (at 160 to 200 s) |

## After (Normal)

| Sortie | Wins | Avg time (wins) | Ranks | Losses |
| --- | --- | --- | --- | --- |
| M1 First Light (dawn) | 9/9 | 367 s | S x3, A x6 | none |
| M2 River of Stone (midday, cumulus) | 5/5 | 300 s | A x5 | none |
| Black Road (night convoys) | 7/7 | 223 s | S x2, A x5 | none |
| M3 Long Lens (golden hour, overcast) | 4/5 | 554 s | S/A | shoulder-launched missiles x1 (after a SAM hit) |
| Thunderhead (storm intercept) | 3/5 | 245 s | A x3 | fighter guns x2 |
| M4 Tiger's Teeth (dusk into night) | 3/5 | 603 s | S x1, A x2 | ace guns x1, time limit x1 |

Thunderhead was run in three configurations; the table is the shipped one. With
three fighters allowed to attack from the second group it was 5 wins in 16.

## Easy and Hard

| Sortie | Easy | Hard |
| --- | --- | --- |
| M1 | 2/2 | 2/2 (S both: the 1.2x score scale) |
| M2 | 2/2 | 2/2 |
| M3 | 2/2 | 0/1 (radar SAM, three hits of three) |
| Thunderhead | 2/2 | 0/2 (run with the earlier, harder attacker caps) |
| M4 | 5/6 (fighter guns x1) | 1/3 (fighter and ace missiles) |

Hostile missiles against the bot on Normal (all "after" runs): shoulder-launched
about 1 hit in 7 fired when flares and a break are used; radar SAM about 1 in 4
(flares do nothing, terrain masking and the beam do); fighter missiles about 1 in
4, the ace's about 1 in 3.

## Flight feel (measured in the flight model, 250 m/s, 9000 m)

| Case | Result |
| --- | --- |
| Standard, full turn, 10 s | 19.8 deg/s sustained, 60 deg of bank in 0.42 s, altitude held within 2 m |
| Standard, half turn | 15.3 deg/s |
| Standard, turn + airbrake (high-G) | 30.7 deg/s, 250 -> 216 m/s in 6 s |
| Standard, full climb, 6 s | +752 m |
| Expert, full roll | 90 deg in 0.45 s |
| Expert, full pull, 3 s | 57 deg of pitch |
| Stall (0.9 x stall speed), Standard, full power | flying again in 7 s, 151 m lost |
| Stall, Expert, hands off | does not recover by itself (the nose falls through and stays there); needs the pilot to pull |

Terrain: `terrainHeight` equals the rendered surface to under 0.1 m
(`__verifyTerrain()`), so the collision margin was cut from 12 m to 6 m
(`TERRAIN_CLEARANCE`), enough to cover the airframe.

## Verified by hand in the browser (own tab, dev server on 5192)

- **Shot down through the flow**: sortie -> remembrance card -> debrief
  ("Vajra One was shot down over the ridges.", no rank, score 0).
- **Time limit through the flow**: sortie -> debrief directly ("The window closed
  before the task was done."), no remembrance card.
- **M4 objective**: "Survive Irbis flight — shoot down all four" reads 0/4 from the
  moment the phase starts (it used to read 0/2 until the second pair arrived).
- **M4 clock**: 1854 at take-off, 1906 a minute into the fight, 1951 and `night`
  five minutes in.
- **Touch EYE button** (`touch-eye-held.png`, 844x390 touch emulation,
  `pointer: coarse` matches): the button is shown on the recon sortie, is the top
  element at its own centre, and holding it opens the optic (camera `hud`, FOV 15,
  `hud.recon.active`); releasing restores chase and FOV 62. The press was a
  dispatched `PointerEvent` of type touch, not an OS-level touch: the buttons are
  not in the accessibility tree, so the DevTools click tool cannot reach them.
- **Onboarding in M1** with a clean save: prompts arrived in context (high-G turn,
  camera, lock, special weapon, flares on the first missile, gun, target cycling),
  each once, with the bound key. "Take the shot" was never said because the bot
  had already fired. A second sortie says nothing.
- **Briefing** (`briefing-free-flight-conditions.png`): every sortie shows its
  hour and weather; free flight has the two chip rows and remembers the choice.
- **Night sortie** (`night-convoy-headlights.png`): all five trucks carry lamps,
  ground lock range 4800 -> 3448 m, AAA reach 2500 -> 1290 m. On this branch the
  environment has no time-of-day API yet, so the picture is the `golden` fallback
  preset: it is not dark until the atmosphere branch is merged.
- Console: no errors or warnings from the game during any batch.
