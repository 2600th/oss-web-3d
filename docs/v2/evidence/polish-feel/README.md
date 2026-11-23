# Polish: combat feel and HUD label declutter

Branch `worktree-agent-a112fc4ac3d5074b7`, cut from `webgpu-aaa` at `e906590`.
Port 5203, Chrome through the chrome-devtools MCP, WebGPU `high` unless noted.
Every sortie (`m1`, `m2`, `night`, `m3`, `storm`, `m4`) was flown with the dev bot
(god mode, 3-4x time) on the final code, with a probe logging combat events, the
sounds and cockpit tones they triggered, the HUD callouts and the rumble calls.
`m1` also ran at `?quality=low` and once on `?webgl`.

## Audit (state before this branch)

Scores are 1 (broken) to 5 (good).

| Item | Before | What was there / what was wrong | Done |
| --- | --- | --- | --- |
| HUD target labels | 1 | **Bug.** Every priority target (`isTarget`, so a whole convoy) took a label even when no slot was clear, so a five-truck column printed five overlapping `TRUCK` names, with ranges under the radio plate and through the lock reticle (`before-labels-convoy-night`). Markers within 30 px folded into the most important one, including into the lock, so in a tight formation a fighter **firing on the player** disappeared into a `+4` under the lock diamond (`before-labels-formation-m1`). | Rewritten placement (below). |
| Damage taken | 1 | **Bug.** `player:hit.damage` is in hit points (the jet has 100; a hostile round does 3.5, a SAM about 30), but the HUD flash, the camera jolt, the screen-hit post effect, the cockpit hit sound and combat's own `vfx:shake` all read it as 0..1. A single stray round hit maximum flash, maximum shake, full red smear and full volume, the same as a SAM hit (`before-damage-hit-m1`: a 14-point hit). There was no hit direction. | Severity scaling everywhere, direction wedge, HUD flicker, audio concussion, rumble. |
| Gamepad rumble | 0 | The Settings toggle "Controller vibration" existed but only drove touch haptics. Nothing called `vibrationActuator`. | Implemented. |
| Hit confirmation | 3 | Hit tone (`ui_hit`, throttled), metal/dirt impacts, `STRUCK` callout. But every gun round pushed a new `STRUCK` line, which stacked three deep and pushed the kill confirmation off. Nothing showed on the target itself. | Hit tick on the struck marker; `STRUCK` only for missiles and rockets, and it refreshes in place. |
| Kill confirmation | 4 | `SPLASH` / `NEUTRALISED` / `LEAD DOWN` with the score, the `ui_kill` sting, and a kill cam with slow motion. The kill cam is skipped while in danger, and then nothing marked where the target died. | Kill mark at the kill position, kill rumble. |
| Missile lock and launch | 3 | The seeker growl was one constant tone from the start of acquisition to lock. Launch had a sound and 0.12 trauma. | The growl climbs in pitch (640 to 920 Hz) and pulse rate (5 to 13 Hz) with lock progress. Launch adds an FOV punch, slightly more jolt, and rumble. |
| Incoming missile | 3 | RWR and alert tones, pulsing threat arcs, the `MISSILE — BREAK` plate and a flare hint. The alert beep rate never changed with range. A radar lock showed a `RADAR LOCK` plate but had no tone. | The alert beep rate rises with time to impact (9 to 17 Hz gate). New `lockon` tone. The shooter's marker is never folded or hidden, and gets a pulsing warning ring and a filled red edge arrow. |
| Speed sensation | 4 | FOV ramp and afterburner kick, camera rumble when fast and low, speed streaks, a Mach-crossing thump with ripple, and wind tied to dynamic pressure. | Left alone (only a rumble on the Mach crossing). |
| Gun feel | 4 | Gun start, loop and tail sounds, 0.6 camera rumble while firing, VFX tracers. | Left alone. Added rumble buzz. |
| Score / callouts | 4 | Callouts with `+score` are capped at three. | Only the `STRUCK` stacking was fixed. |

## What changed and why

**Labels** (`src/ui/declutter.js`, `src/ui/Hud.js`):
- Every marker is still drawn. Only the text is rationed, in this rank order: the lock, then anything firing on the player, then the selected target, the flight lead, priority targets, and the rest by range.
- The lock, shooters and the selected target always get a label, and take the least-bad slot if no slot is clear. Other labels share a budget (3 on desktop, 2 on touch) and are dropped when no slot is clear.
- Slots are tried in order: last frame's slot (while it stays clear, so labels do not flip-flop), the stack, beside the marker, then out on a leader line in eight directions at two distances.
- The lock reticle (box, ticks and `LOCK` / `ACQ` plate) is a keep-out, so no other text lands on the target box.
- The lock, the selected target and shooters never fold into another marker and never take others in. A hit on a folded marker ticks the marker that stands in for it.
- A label that repeats a nearby neighbour's name shows only its range, and is dropped entirely if the range is also the same. A column reads as one `TRUCK 1.2km`.
- Labels fade up over about 0.12 s instead of popping in. Off-priority labels sit at 72% opacity. A label that was showing last frame counts as 15% nearer, so two equal targets do not trade labels.
- Edge arrows: shooters sort first and are drawn filled in the warning colour. The arrow text (`range +n`) is drawn once all arrows have folded, stepped inward or dropped if a better-ranked arrow's text is already there. Before, the `+n` count was drawn apart from its range and landed on the neighbour's text (seen in `after-sortie-m4`, fixed after that shot).

**Feel:**
- **Damage.** Combat adds `fraction` and `severity` (0..1, square-root curve: a stray round is about 0.37, a 25%+ hit is 1) to `player:hit`. Every consumer scales by severity:
  - HUD edge flash: about 0.46 for a round, 0.97 for a SAM. Before, it was 1.0 for both.
  - Camera jolt: 0.43 vs 0.9 trauma, including combat's `vfx:shake`. Before, it was 1.0 for both.
  - Screen hit: the floor value for a round, full for a SAM.
  - Cockpit hit sound: gain 0.35 + 0.65 × severity.
  - Above severity 0.55: a 0.7 s world-audio lowpass "concussion", and the HUD flickers for 0.1 to 0.3 s.
  - A filled warning-coloured wedge on the threat ring points at the shooter (its live position) for 1.4 s. The missile arcs stay outlined and pulsing, so the two read differently.
- **Hits and kills.** Diagonal hit ticks on the struck marker (0.22 s). A kill mark (opening ring or diamond with an X, 0.75 s) at the kill position.
- **Tones.** `Warnings.setLevel(name, x)` sweeps the seeker growl with lock progress and the missile alert with `missileUrgency(threats)`. There is a new `lockon` tone.
- **Launch.** Trauma 0.14 (rockets 0.06) plus `fovPulse(-9)` (rockets -3).
- **Rumble** (`src/ui/rumble.js`, `Input.rumble`):
  - A gun buzz, re-armed every 90 ms.
  - Hit ticks, kill thumps (heavier for the flight lead), launches, rocket ripples, flares, nearby blasts by distance and size, damage by severity, near misses, the Mach crossing, and the jet being destroyed.
  - A weaker effect never cuts a stronger one short. Equal pulses within 40 ms fold into one.
  - Only in flight. It stops on pause and in menus, and when Settings > Controls > Controller vibration is turned off. That toggle now notes that it covers the gamepad.

**Cost.** All of this is Canvas 2D, Web Audio and events: no GPU work at any tier.
- HUD `draw()` on the final code, desktop WebGPU high, with 3 to 24 targets in the list: p50 0.5 to 0.7 ms, p95 0.8 to 1.1 ms. The same at `?quality=low`.
- The HUD draw time before this change was not measured, so there is no before/after number.

## Verified (in the browser, final code unless noted)

- **Label scenarios**, same setup before and after:
  - `?mission=night`: the convoy from 1.1 km, nose on.
  - `?mission=m1`: a scripted five-ship at 1.5 km, lead locked, the fourth ship firing (a `weapon:gun` event).
- **Every sortie** with the bot. The probe saw:
  - lock tones and launch rumble;
  - `STRUCK` only on missile hits, and `NEUTRALISED` / `SPLASH` with kill rumble;
  - the `lockon` tone and shooters flagged in `m4`, `m3` and `storm` (up to 3 at once);
  - blast rumble in `m3`;
  - no console errors on any page, including `?webgl` and `?quality=low`.
- **Damage by severity.** Measured with real `CombatWorld.damage` calls: a 3.5-point round against a 30-point SAM (numbers above). Both rumble patterns were seen at the `Input.rumble` boundary.
- **Seeker growl.** Sampled from the live Web Audio nodes during a lock: 640 Hz / 5 Hz at progress 0, 881 Hz / 11.9 Hz at 0.91.
- **Missile alert.** Gate rose from 9 Hz at 3.5 km to 17 Hz at 0.5 km on a scripted inbound missile.
- **`lockon` tone.** On while `lockWarning` held, off when it cleared.
- **Gun.** A real burst into a static three-ship gave 44 hits, 45 metal impacts and 11 throttled hit tones, no `STRUCK` callouts, one `SPLASH`, camera gun rumble 0.6, and the gun buzz plus hit pulses at the rumble boundary.
- **Tests.** `npm test`: 265 pass, including the new `src/ui/feel.test.mjs`. `npm run build` passes.

## Not verified

- **Real controller rumble.** No gamepad was attached. Rumble was verified at the `Input.rumble` boundary in the browser, and `Input.rumble` against a fake `vibrationActuator` in node. Whether the strengths feel right on a real pad has not been checked.
- **Audio by ear.** Nothing was heard. Tones and sounds were checked as node parameters and as the sound ids played.
- **Touch layout.** The two-label budget on touch is in the code but was not checked with phone emulation this round.

## Seen but out of scope

- **First-burst stall.** The first gun burst of a page stalls the frame loop for 1 to 2 s, on both backends. Rumble timestamps showed gaps of 1.4 s and 1.8 s; there were no console errors. It looks like first-use pipeline compiles for tracer or impact VFX (`src/vfx`). It was not investigated here.
- **Damage floor in post.** `ScreenState.hit()` (`src/fx`) has a floor of 0.35, so even the lightest hit desaturates and reddens a little. The camera system now feeds it only the part of severity above that floor.

## Files

- `before-labels-convoy-night.jpeg`, `after-labels-convoy-night.jpeg`
- `before-labels-formation-m1.jpeg`, `after-labels-formation-m1.jpeg`
- `before-damage-hit-m1.jpeg`, `after-damage-hit-m1.jpeg` (same 14-point hit, 90 ms after. In the after shot: the edges tinted with the centre clear, the HUD caught mid-flicker, and the direction wedge to the left of the centre)
- `after-hit-tick-and-kill-mark.png` (crop: the kill mark on the left truck, the hit tick on the fourth)
- `after-incoming-missile-shooter-marked.jpeg`
- `after-sortie-{m2,m3,m4,storm}.jpeg` (bot runs)
