# Balance pass: Thunderhead and Black Road

Two sorties were off: **Thunderhead** (`storm`, eleven fighters in a storm) was
too hard, and **Black Road** (`night`, two convoys and night fighters) was a
walkover. This pass reworks both, mostly through mission data, with three small
AI rules and one new mission module.

## Method

- **Pilot.** The dev bot (`src/game/dev/Bot.js`) flies every sortie through the
  real input path (assisted-flight intent, real lock, missiles, flares, gun),
  damage on, no repositioning. `game.dev.run` steps the game headless at 1/30 s
  per step. Everything else is shipping code.
- **Batches.** `tools/perf/balance.js` (new) wraps `dev.run` with per-run
  telemetry (kills by time, health at each phase, lowest health, top-ups, first
  night contact, trucks that escaped). `tools/perf/balance-table.mjs` (new)
  prints the tables below. The runs happened in two of my own tabs on port 5204,
  in the background, sharing the GPU with three other agents.
- **Records.** `runs-0-before.json` (56 runs, the untouched branch),
  `runs-1-after.json` (58 runs, the committed data and code),
  `runs-2-iterations.json` (139 runs: the A/B runs and every Black Road
  iteration). Total 253 sorties.
- **Harness check.** Before trusting a difference I re-ran the untouched sources
  (`git checkout` of the six files, 5 runs, 1 win) and the original Thunderhead
  data on top of the new code with the new AI rules switched off at runtime
  (6 runs, 1 win). Both match the 4 in 12 baseline, so the harness did not drift.
  One trap worth knowing: Vite serves an edited module under a new `?t=` URL, so
  `import('/src/ai/brain.js')` from the console gets a *different copy* from the
  one the game runs. Early A/B runs that changed tuning that way silently changed
  nothing. Live tables now hang off `game.dev.tuning`, and mission data is
  patched through `game.systems.missions.list`.

**Read the numbers with care.** The bot is not a human. It locks and fires the
radar missile perfectly at 12 km, never hesitates on a defensive break, and does
not get lost. It is much better than a person at beyond-visual-range work and
somewhat worse at close guns defence. Its win rate overstates how easy a sortie
is for a person, so I aimed it higher than the human target: wins most of the
time, *with real damage and close calls*. Samples are 6 to 12 runs per cell. A
Black Road cell moved by ±25 points between identical batches (the hostile AI's
random numbers are seeded per sortie, but the flight and the missile rolls are
not), so treat a 10-point difference as noise.

## Before and after (Normal is the target; Easy and Hard checked)

| Sortie / level | Runs before → after | Wins before → after | Win time (median) | Damage per run (mean) | Lowest health (median) | Failures after |
| --- | --- | --- | --- | --- | --- | --- |
| Thunderhead / Easy | 8 → 8 | 5 (63%) → 8 (100%) | 184 → 239 s | 76 → 21 | 36 → 87 | none |
| **Thunderhead / Normal** | 12 → 12 | **4 (33%) → 12 (100%)** | 217 → 237 s | 101 → 58 | **0 → 53** | none |
| Thunderhead / Hard | 8 → 8 | 1 (13%) → 6 (75%) | 192 → 243 s | 105 → 90 | 0 → 26 | fighter missile x1, fighter gun x1 |
| Black Road / Easy | 8 → 8 | 8 (100%) → 8 (100%) | 190 → 257 s | 15 → 4 | 87 → 100 | none |
| **Black Road / Normal** | 12 → 12 | **12 (100%) → 10 (83%)** | 219 → 258 s | 32 → 60 | **78 → 47** | fighter gun x2 |
| Black Road / Hard | 8 → 10 | 6 (75%) → 9 (90%) | 256 → 286 s | 70 → 77 | 37 → 18 | AAA x1 |

Where the damage comes from, and how the sortie unfolds:

| Sortie / level | Damage by source, before | Damage by source, after | Phase starts (median s), after |
| --- | --- | --- | --- |
| Thunderhead / Normal | fighter gun 56, fighter missile 45 | fighter gun 38, fighter missile 20 | second 54, regroup 128, last group 164 |
| Thunderhead / Hard | fighter missile 61, fighter gun 45 | fighter missile 51, fighter gun 39 | second 55, regroup 129, last group 167 |
| Black Road / Normal | shoulder-launched 28, AAA 3, flak 2; **fighters 0** | fighter missile 28, fighter gun 21, shoulder-launched 7, flak 4 | second column 80 → **122**, night fighters 219 → 190 |
| Black Road / Hard | shoulder-launched 63, flak 4, AAA 3 | fighter missile 41, shoulder-launched 15, flak 15, AAA 4, gun 3 | second column 80 → 96 |

Ranks of the winning runs, before → after: Thunderhead Normal A x4 → A x10, S x2;
Black Road Normal A x10, S x2 → A x8, B x2; Black Road Easy B x7, A x1 → B x8.

### Thunderhead: what the bot says

- Before, 11 of 12 Normal runs were shot down or finished under 10 health, all
  but one of them in the last group: four veterans in one formation, with the
  attack cap raised to three, launched the moment the seventh fighter fell. The
  pilot reached it with 11 to 62 health left and no gap or top-up.
  The killers were split evenly between guns and heat-seekers. Easy did not save
  you either (3 of 8 died, all to guns): the gun was the problem.
- After: Normal is won every time, but not cheaply. The median lowest health is
  53 and the worst run went down to 25. Every run took the Kesar top-up (the bot
  flies to the marker when nothing hostile is up); 8 of 12 reached it damaged
  (51 to 93 health), and most runs hit their lowest point in the last group,
  after the top-up. Hard loses a quarter of its runs and leaves the winners at
  about a quarter of their health.
- A/B with the final data and the three AI rules switched off at runtime: 3 of 6
  (50%), lowest health 30. So about half of the change is the structure (gap,
  top-up, no raised attack cap) and half is the cloud and rough-air rules.
- A/B with a bot that climbs into the cloud when a heat-seeker is fired at it:
  6 of 6, lowest health 55. No measurable gain over the default bot, because the
  default bot already spends most of the fight inside the layer chasing bandits
  that hold there. For a person, who can see the grey and choose it, the cloud is
  the escape the briefing promises; the bot cannot tell us how much that helps.

### Black Road: what the bot says

- Before: 12 of 12, lowest health 78, and the three night fighters did **no
  damage at all** in any of 28 runs on any level. Every truck was boxed on the HUD
  and the radar from the moment it spawned, so "find the headlights" meant "fly
  to the box". The R-60 reaches 3.4 km on a truck at night, outside the 1.3 km a
  gunner can see you at, so the whole column died in one pass from out of reach.
- After: the first truck still dies at about 36 s (a lit column is easy to find,
  as it should be), but the first column now takes 122 s instead of 80 because
  the rest of it goes dark and runs. The night fighters are now the main threat
  (49 damage per run on Normal) and the two losses on Normal are to them.
- Iterations (`runs-2-iterations.json`): the first version (three dark veterans,
  shoulder-launch teams on the road, dark trucks visible at 1.8 km) won 3 of 12
  on Normal and 0 of 8 on Hard. The two levers that mattered were the number of
  shoulder-launch teams the search forces you over, and the third night fighter.
  A version with two teams per picket won 11 of 20 on Normal and 5 of 16 on Hard;
  halving the teams gave the committed numbers above.

## What changed, and why

### Thunderhead (`src/missions/data.js`, `storm`)

1. **A breather and a top-up.** A new **Regroup** phase after the second group:
   Shikhar reports the scope clear, Kesar Tower offers a hot turn, and the
   objective marker sits on the field by Kargil. Fly through it under the cloud
   (zone 3.2 km, below 5600 m) and you get 35 health, a full set of flares, 12
   R-60s and two R-27s. Ignore it and the last group launches after 75 s anyway.
   This is an arcade compression (nobody rearms a MiG in a low pass) and the radio
   says "hot turn" rather than pretending otherwise.
2. **Waves come one at a time.** The last group no longer raises the attack cap to
   three; it stays at two (three on Hard, from the difficulty table). The
   transitions now say what is coming and from where ("the next four are a minute
   or two out, from the east"). Eleven fighters in all, as before.
3. **The cloud is usable.** The briefing says what the cloud does to both sides,
   and the wingman reminds you twenty seconds into the second group. See the AI
   rules below.
4. Time limit 780 → 900 s and par 330 → 420 s, to pay for the gap (median win is
   now 237 s, so neither limit binds).

Measured and rejected: the second and third groups as **pairs** from two sides
(15 to 50 s apart, with and without the AI rules). With the R-27 the bot picked
each pair apart before the merge. Over roughly 60 runs of pair variants it lost
twice (both to one gun engagement) and most runs ended without a scratch; with
the original AI and pairs it was still 6 of 6, lowest health 60 to 100. Pairs
make it a shooting gallery for anyone who can work the radar missile, so the
four-ships stayed. (Those runs were watched as they finished but their raw
records were not kept: each source edit reloads the tab. The A/B and Black Road
iteration records are kept.)

### Black Road (`src/missions/data.js`, `night`, and `src/missions/spotting.js`)

1. **You only see what you have seen** (`spotting.js`, new). Trucks and night
   fighters are off the HUD, the radar and the lock until the pilot has actually
   seen them: a truck on headlights from 5.2 km, a fighter in afterburner from
   5 km, with a clear line of sight. A contact stays marked out to 3.8 km (or 1.4x
   its sight range), and is lost after 8 s beyond that. This uses the combat
   contract's existing flags (`hidden`, `selectable`, `lockable`), so the HUD,
   radar, target cycling and seeker all agree without touching them.
2. **The column goes dark and runs.** When a truck dies, the rest of its column
   kill their lights, open out to 2.2x their spacing (the trucks behind back off;
   nothing jumps) and drive 45% faster for 20 s, then light up again to stay on
   the road. Anything you were not already within 2.2 km of drops off your sight
   at once. A dark truck shows from 2.2 km, just outside a shoulder-launch team's
   night reach (3800 m x 0.52 = 1960 m), so finding it again is a matter of
   patience rather than a forced trip into the missiles. Anvil Six says so the
   first time: "They have killed their lights and they are running."
3. **The marker follows what you saw.** The objective marker moves to where the
   column was last seen, not where it was briefed.
4. **Night fighters during the search.** A pair of bandits comes up from the west
   30 s into the sortie, whichever column you are on. They and the two veterans
   that come later fly **dark** (`skillOverrides: { dark: true }`): no
   afterburner while hunting, so they show at 2.6 km instead of 5 km. A launch or
   a gun burst gives a fighter away at once. Shikhar calls an unseen fighter
   every 22 s as a clock position, range and height ("bandit, your four o'clock,
   six kilometres, low. No lights on him."), so a person always has something to
   look for.
5. **Guns on the road.** Three gun positions beside the traced road itself (two
   AA guns each, flak at the second), so a run down the column is a run over them.
   The two pickets have one shoulder-launch team each instead of two (see the
   iterations above).
6. Roads shortened (9000 → 7200 m, 8500 → 6800 m) so a column left alone does
   reach the pass inside the sortie. Par 330 → 360 s; rank thresholds raised a
   little for the extra targets (S 11200 → 12400, A 9600 → 10400).

### AI rules (`src/ai/brain.js`, `src/ai/Fighter.js`), kept small

- **Cloud hides the player** (`CLOUD` in brain.js). When the *player* is inside a
  solid cloud layer, a hostile heat-seeker lock takes 2.5x as long (the player's
  own lock already paid 2.5x; the hostiles did not) and a hostile gunner cannot
  lay a burst beyond 420 m. Only the target's cloud counts: hostile pilots hold
  in the layer on purpose; in a first trial that let their own cover blind them
  too, no hostile fired a single missile in four sorties. This applies wherever a mission has a solid layer.
- **Rough air and the gun** (`ROUGH_AIR` in Fighter.js). Above moderate
  turbulence a hostile pilot needs time to settle the pipper between bursts:
  `(turbulence - 0.5) x 2` s, which is 1 s in a storm and nothing anywhere else.
  Before, a fighter in solution could hold the trigger down and take the player
  from 100 to 0 in about two seconds, which read as unfair rather than hard.
- **Dark night fighters** (`skillOverrides.dark`): no afterburner in the hunting
  and attacking states. Nothing else about them changed.

### Dev and tooling

- The bot now ignores contacts the HUD does not show (a person cannot attack
  what they cannot see), drops a hidden target, and has an optional `cloud`
  behaviour (`dev.run(id, {bot: {cloud: true}})`, off by default).
- `game.dev.tuning` exposes the live `CLOUD` and `ROUGH_AIR` tables for A/B runs.
- `tools/perf/balance.js` and `balance-table.mjs` (see `tools/perf/README.md`).

## Contract additions (for the lead to fold into ARCHITECTURE.md)

All additive; nothing existing changed shape.

- Mission data: `spotting: { tags, truck: {lit, dark}, fighter: {lit, dark}, keep, hold, lose, scatter: {seconds, speed, spread}, darkLine, picture: {every, first, range} }`.
- Runner: action `{resupply: {health?, flares?, msl?, sp?}}`; condition `{zone: {x, z, r, below?}}`.
- Event `player:resupply {health (0..1), flares, msl, sp}`.
- Missions write `hidden` / `selectable` / `lockable` on watched trucks and fighters (existing combat flags).
- Missions change `speed` and `spacing` of an ai `Convoy` while it scatters, and the `visible` flag of a truck's `headlights` group.
- AI: `CLOUD` (brain.js), `ROUGH_AIR` and `gunSettle` (Fighter.js), skill override `dark`.
- Dev: `game.dev.tuning`, bot option `cloud`.

## Screenshots

- `black-road-column-gone-dark.png`: 37 s in, one truck of the first column
  destroyed. The other four have killed their lights and are off the HUD and the
  radar; only the AA guns on the road are boxed. Shikhar is announcing the night
  pair.
- `thunderhead-regroup.png`: the regroup gap, under the cloud base, objective
  "Gap in the raid: top up over Kesar, under the cloud", Kesar marked on the
  radar. (The caption is a queued line from the second group: the run was
  fast-forwarded and the radio panel plays its queue in real time.)

Both were taken in my own tab, briefly brought to the front, with the game paused.

## Not verified

- **No human played either sortie.** All judgements of feel (the picture calls,
  whether 2.2 km is the right distance to re-find a dark truck by eye, whether the
  regroup reads as a breather) are reasoning, not playtests.
- The dark/lit sight ranges are gameplay numbers. I did not check that a dark
  truck is visibly findable on screen at 2.2 km in the night renderer.
- The cloud rule applies to every sortie with a solid layer (M3 Long Lens is
  overcast; free flight with overcast, snow or storm). I did not re-measure M3.
- Black Road Hard won 9 of 10 in the final batch against 6 of 8 before, with a
  much lower lowest-health (18 against 37). By win rate it is about as hard as
  before, not harder; the iteration runs show it swings to 25 to 40% with one more
  shoulder-launch team per picket.
- Trucks never escaped in any run (the bot always hunts them); the escape failure
  is reachable but unmeasured.
- Easy on Black Road may now be too gentle (lowest health 100 in the median).
