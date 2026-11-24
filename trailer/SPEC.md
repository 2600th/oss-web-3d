# SPEC — Safed Sagar trailer, "One sortie"

GOAL:    a stranger sees a MiG-21 fight its way through the Kargil heights, from dawn through storm and night to the climb above the cloud, and wants to fly it in their browser.
OUTPUT:  HyperFrames, 1920 x 1080, 30 fps, MP4 (H.264), stereo.
TIME:    57.0 s = 1710 frames. Built from one cut list: `node tools/build.mjs` writes index.html and compositions/*.html.

FEEL: a quiet hook, then fast all the way to a cliffhanger: the last shot is a missile about to hit, cut to black and silence on the downbeat.
- Shots average 1.4 s in the action (12.8–37.8 s) and 2–4 s in the hook and the payoff.
- Every cut sits on a beat of the bed (`npx hyperframes beats`). Noir Now runs at 127.5 bpm, so a beat is 0.47 s; its drum cycle is 2.400 s.

LOOK:
- **Ground:** real gameplay footage only, captured frame-exact (src/game/dev/capture.js) at 1920x1080, ultra quality.
- **Frame:** a 2.39:1 letterbox (two 138 px bars) throughout, dropped for the end card.
- **Grade:** the game's own (AgX, split tone, its film grain). No extra grade, glow or vignette.
- **Ink:** #F2F4F5. **Accent:** saffron #FF9933, used once only, as the rule under the end-card wordmark.
- **Type:**
  - Big Shoulders Display 800 (the game's title face): title 210 px, end card 190 px.
  - B612 Mono (the game's HUD face): radio lines at 30 px, centred in the lower bar, callsign at 60% ink; subtitle and call to action at 40 px.

SOUND:
- **Bed** (assets/music/bed.wav, 57.0 s, built by tools/bed.py): one score, no change of track.
  - "Noir Now" (Drakensson, CC0) from 10.2 s. Its build runs under the hook, its silence (6.8–9.0) under the flak, and its hit lands on the title at 9.0.
  - Its drums carry the action to the end. They are lengthened by six of their own 2.400 s cycles (a splice at track 40.0 back to 25.6) and stop dead on the downbeat at 49.89, the cut to black. Silence until the end-card title, which lands on a bass impact (51.08).
  - The bed ducks to 0.42 under every radio call.
- **Radio** (assets/voice/r*.wav): Kokoro TTS voices (Indian-accented English for the controllers), run through radio.sh. That gives a 380–3100 Hz band, compression, soft clipping, light bit-crush, band noise and the game's own squelch clicks.
  - The text is shortened from the game's mission radio (src/missions/data.js), with the words kept verbatim.
- **Effects:** the game's own original SFX (public/audio/sfx): jet flybys, AAA, SAM, flares, flak, gun, missile launch and pass, explosions, burner roar, cloud rush.
  - Plus a bundled riser and bass impacts, and one CC BY thunder clap (credited).

SHOTS (as built, draft 2: every combat shot is now real gameplay capture):
| Time | Shot | Radio / sound |
|---|---|---|
| 0.00–2.81 | dawn-track: low side-tracking pass along the ridge, burner lit | r1 KESAR TOWER "The valley is yours." |
| 2.81–4.75 | dawn-fpv: cockpit, sun over the canopy bow | |
| 4.75–6.68 | strike-aaa-chase: low down the valley, AAA tracers whipping past | r3 ANVIL SIX "Guns on both shoulders…" |
| 6.68–8.04 | strike-sam-chase: SAM inbound, the hard break, flare fan | SAM, flares, in the music's silence |
| 8.04–9.01 | strike-aaa-cockpit3: eight guns' streams cross the canopy from both shoulders | flak |
| 9.01–12.77 | gold-orbit + SAFED SAGAR (mask wipe, 10 frames), KARGIL HEIGHTS · 1999 | the hit |
| 12.77–14.71 | dawn-pass: the jet small down the river gorge, sun shafts | r4 SHIKHAR "…cleared hot." |
| 14.71–16.66 | strike-gun-chase: gun run, rounds walking into the trucks, vapour pull-out | gun |
| 16.66–18.07 | strike-supply-kill: the supply dump goes up (kill cam) | explosion |
| 18.07–19.52 | dog-cross5-cockpit: a flight of four crosses the windscreen at ~100 m, all four in frame together | r5 VAJRA TWO "Tally four. Split them, lead." |
| 19.52–22.16 | dog-pursuit: over the shoulder, past our own fin, the bandit 40 m ahead weaving in burner | r6 VAJRA ONE "Fox Two." |
| 22.16–23.41 | dog-msl-b: the launch | missile launch on 22.36 |
| 23.41–26.25 | dog-msl-b: whip onto the missile (23.71), the hit (24.65, 3 white frames), breakup | missile pass, fireball |
| 26.25–27.16 | dog-kill-fq: a second kill, front quarter | explosion |
| 27.16–31.07 | storm: chase into lightning, cockpit in rain, tracking with a strike | thunder |
| 31.07–37.50 | night: convoy road, a strike flash, a missile in the dark, a silhouette | r7 ANVIL SIX "Lights on the road…"; riser |
| 37.50–37.80 | black (a breath) | |
| 37.80–40.52 | ab-lightup: the afterburner lights from behind | burner roar + bass impact on 38.48 |
| 40.52–45.98 | climb through the deck, break out into the sun | cloud rush |
| 43.15 | | r8 SHIKHAR "Sky is clear… Come home." (the calm before the ambush) |
| 45.98–47.50 | ab-breakout-long: above the cloud sea | |
| 47.50–48.90 | cliff-mount: the jet big from a camera ahead of it; the missile's smoke closes on its tail; flares at 48.77 | r9 VAJRA TWO "Missile, missile! Break!" (verbatim, src/missions/cast.js); the game's missile alert; missile motor |
| 48.90–49.90 | cliff-msl2: the missile camera rides the shot in; the last frame is the plume on the jet | alert and motor continue; everything stops dead at 49.89 |
| 49.90–50.40 | black, silence | music cut dead |
| 50.40–57.00 | end card: SAFED SAGAR wipe (51.08), saffron rule, "Play free in your browser", credits | bass impact on the wipe, then silence |

COMBAT REELS (shot for draft 2; recipes in tools/strike-shots.js, evaluated in the dev game page):
- All at dawn (7.0 h) down the valley at x -20000, z 9000, heading 285 (clear for 6 km), hostiles switched on, kill and missile cams off unless the shot is a kill cam.
- AAA, SAM and flak: `__strike({ units })`. The free sortie spawns hostiles passive, so the helper sets `ai.hostile`.
- Gun run: `__gunRun()`. An aim autopilot holds the nose on the group; the rounds fall about 175 m short of the nose line, so the aim is 60 m long and the trucks sit on the rise that faces the attack. A truck is destroyed when a round lands within 25 m of it.
- Flak from the cockpit did not read (the bursts are too far off), so the 8.04 slot uses the cockpit AAA take.
- Clipping: checked frame by frame in the contact sheets. Smoke passes close to the camera in the SAM break; no mesh clipping.

BANNED:
- A dark void, glow or particles added in post, docked logos, text sliding up.
- Anything from Ace Combat or Call of Duty: names, HUD styling, music.
- Marked or named hostiles.
- Kill counts or score shown as triumph.
- An invented URL or price.

QA:
- Frame 0 is the ridge pass.
- The title is legible.
- The hit flash lasts 3 frames.
- The payoff shows the new afterburner.
- The last frame before black is the missile on the jet, never the impact.
- The end card holds at least 3 s.
- No HUD clutter under the titles.
- The music is measured at -16 to -14 LUFS with true peak ≤ -1 dBTP.
