# Trailer: "One sortie"

The 57-second Safed Sagar trailer as a [HyperFrames](https://hyperframes.heygen.com)
project. A HyperFrames project is HTML that the CLI renders to MP4.

| File | What it is |
| --- | --- |
| [`SPEC.md`](SPEC.md) | the shot list, the radio lines, the sound and the look |
| `tools/build.mjs` | one cut list that writes `index.html` and `compositions/*.html` |
| `tools/bed.py` | builds the music bed and the missile-alert tone |
| `tools/strike-shots.js` | in-game helpers for the combat takes |
| `assets/voice/`, `assets/sfx/`, `assets/fonts/` | the radio calls, sound effects and typefaces |

## Rebuild it

1. **Capture the footage.** Run the game with `npm run dev`, then open
   `?mission=free&quality=ultra&noadaptive` at 1920x1080. Record each take with
   `__capture.record` (see `src/game/dev/capture.js`).
2. **Encode the takes.** Run `node tools/capture/encode.mjs <clip> --out trailer/assets/footage/<clip>.mp4`
   from the repo root.
3. **Build the music bed.** Run `python tools/bed.py`. It needs
   `assets/music-candidates/91ce19e8.mp3`, which is "Noir Now" by Drakensson (CC0).
4. **Render.** Run these from this folder:
   ```bash
   node tools/build.mjs
   npx hyperframes check
   npx hyperframes render -o renders/trailer.mp4
   ```

The footage, music and renders are not committed (see the root `.gitignore`).
A web-size copy of the finished trailer is at [`docs/media/trailer.mp4`](../docs/media/trailer.mp4).
