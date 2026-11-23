"""Render the score (score.py) to mastered, loop-ready Opus/AAC files.

    python tools/audio/fetch_samples.py      # once: CC0 samples into .cache/
    python tools/audio/render_music.py       # all cues
    python tools/audio/render_music.py menu combat_2
"""
import json
import os
import sys
import time
from concurrent.futures import ProcessPoolExecutor

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np  # noqa: E402

from dsp import SR, write_wav, encode, lufs, true_peak_db, peak_db  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
BUILD = os.path.join(ROOT, 'tools', 'audio', '.build', 'music')
OUT = os.path.join(ROOT, 'public', 'audio', 'music')


def job(name):
    from score import CUES
    from music import render_cue
    t0 = time.time()
    cue = CUES[name]()
    x = render_cue(cue, verbose=False)
    write_wav(os.path.join(BUILD, name + '.wav'), x)
    kb = 96 if not name.startswith('combat') else 88
    sw, sa, info = encode(x, os.path.join(OUT, name), 2, kb, 128, loop=cue.loop, tmp_dir=BUILD, max_peak_db=-0.6)
    x = x * info['gain']
    meta = {
        'file': name, 'title': cue.title, 'bpm': cue.bpm, 'beatsPerBar': cue.bpb, 'bars': cue.bars,
        'loop': cue.loop, 'group': cue.group, 'dur': round(len(x) / SR, 4),
        'lufs': round(lufs(x), 2), 'tp': round(true_peak_db(x), 2), 'peak': round(peak_db(x), 2),
        'webm': sw, 'm4a': sa, 'renderSeconds': round(time.time() - t0, 1),
    }
    if cue.loop:
        meta['loopStart'] = info['loopStart']
        meta['loopEnd'] = info['loopEnd']
    return name, meta


def main(names):
    from score import CUES
    names = names or list(CUES)
    os.makedirs(BUILD, exist_ok=True)
    path = os.path.join(BUILD, 'music_meta.json')
    meta = json.load(open(path)) if os.path.exists(path) else {}
    workers = int(os.environ.get('AUDIO_JOBS', '4'))
    with ProcessPoolExecutor(workers) as ex:
        for name, m in ex.map(job, names):
            meta[name] = m
            print(f"{name:15s} {m['dur']:6.1f}s  LUFS {m['lufs']:6.1f}  TP {m['tp']:5.1f}  {m['webm'] / 1024:6.0f} KB  ({m['renderSeconds']}s)")
            json.dump(meta, open(path, 'w'), indent=1)
    total = sum(m['webm'] for m in meta.values())
    print(f'music webm total {total / 1e6:.2f} MB')


if __name__ == '__main__':
    main(sys.argv[1:])
