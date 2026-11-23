# Audio evidence

Nobody listened to this audio while it was being built, so it was checked with measurements instead. Every number below comes from the **shipped, encoded files**: Opus in WebM, decoded by ffmpeg with `tools/audio/analyze.py`. Browser numbers come from Chrome AnalyserNodes on the live graph, recorded with `tools/audio/browser_tour.js` and plotted by `plot_browser.py`.

## Files

| file | what it shows |
| --- | --- |
| `analysis.json` | Measurements for each asset: BS.1770-4 integrated LUFS, sample and true peak, RMS, count of clipped samples, loop-seam ratio, spectral centroid, size |
| `sfx_sheet_1..4.png` | Waveform and spectrogram of all 79 SFX files, after decoding |
| `music_sheet.png` | Waveform and spectrogram of all 12 music cues, after decoding |
| `browser_capture.json`, `browser_meters.png` | An 80 s scripted tour in Chrome with the WebGPU build: RMS for each bus, combat stem weights, music duck |
| `audiotest_panel_webgl_low.jpg` | The `?audiotest=1` panel running on the WebGL2 fallback at `?quality=low` |

## Music (decoded Opus)

| cue | s | LUFS | dBTP | loop seam* | KB |
| --- | --- | --- | --- | --- | --- |
| menu | 96.4 | -16.0 | -1.3 | 1.25 | 1226 |
| briefing | 40.4 | -17.0 | -2.4 | 0.33 | 554 |
| cruise | 64.4 | -18.0 | -6.3 | 0.65 | 817 |
| combat_1 / 2 / 3 | 55.3 | -16.5 / -16.0 / -15.5 | -3.1 / -1.5 / -1.6 | 0.60 / 0.50 / 0.37 | 644 / 617 / 672 |
| ace | 38.8 | -15.6 | -1.4 | 4.83** | 492 |
| victory | 34.8 | -15.0 | -2.2 | one-shot | 464 |
| defeat | 31.7 | -17.0 | -5.2 | one-shot | 435 |
| memorial | 83.1 | -17.0 | -3.5 | one-shot | 1081 |
| sting_complete / sting_failed | 9.8 / 14.0 | -14.0 / -16.0 | -3.2 / -4.5 | one-shot | 126 / 170 |

\* The loop seam is the jump from the sample at `loopEnd` to the one at `loopStart`, divided by the 90th percentile of neighbouring-sample jumps nearby. A value of about 1 means the loop wraps as smoothly as any ordinary sample pair.
\*\* For the ace cue the measured value is the bar-0 downbeat (crash and impact) landing on the wrap point. At 0.039 the wrap jump is smaller than the same downbeat's transient at bars 8 and 16 (0.14 to 0.23).

- **Tuning:** a chroma check shows that every cue's two strongest pitch classes are D and A (Sa and Pa), and victory reads as D major. Timpani, toms and frame drums are automatically retuned to D or A. The pitch of every sample is measured, because the libraries do not use one octave convention.
- **Combat stems:** the three stems have identical lengths and loop points, and each one renders the shared parts with the same seed. In the browser, the 3 sources start at the same time on the AudioContext clock.

## SFX (decoded Opus)

- There are 79 files across 44 ids, totalling 1.97 MB.
- No file has a clipped sample, and the highest true peak is -0.1 dBTP. The encoder measures the decoded peak and lowers the gain until it is under -0.5 dBFS.
- The worst loop seam is 1.86 (`jet_rumble`). Lossy codecs ring at stream edges, so loops are encoded with 200 ms of wrapped padding on each side and played between the manifest's `loopStart` and `loopEnd`.
- Pass-bys are simulated with a variable propagation delay, which produces true doppler. They swell in from about -50 dB and do not cut in suddenly.

## Browser (Chrome, WebGPU, 48 kHz, Opus path)

| check | result |
| --- | --- |
| Context unlocked by a real key press; no autoplay warning | running |
| Cue switching (menu → cruise → combat → victory → memorial) | all reached |
| Combat weights at level 0.5 and at level 1 | [0, 1, 0] and [0, 0, 1] |
| Lowest music RMS during the stem crossfades | -34 dBFS (no dropout) |
| Music duck while radio plays | 0.45 |
| Near explosion, peak sfx RMS | -5.7 dBFS |
| Explosion 3.59 km away: time until sfx rises | 11.09 s (3590 / 325 = 11.05 s predicted) |
| Lock, then missile alert | `acquire`, then `missile` tones active |
| Cockpit view | blend 1, world lowpass 7.6 kHz |
| In cloud | world lowpass 4.6 kHz |
| Voices: started / culled / stolen | 27 / 0 / 0 |
| Console | no audio errors or warnings |

On the WebGL2 fallback at `quality=low`, the graph runs with equal-power panning and the stems crossfade correctly at level 0.7. In Chrome the AAC fallback decodes too: its durations differ from Opus by 20 ms or less, which the 200 ms loop padding absorbs.
