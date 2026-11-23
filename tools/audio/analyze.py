"""Objective checks on the *shipped* (encoded) audio: decode every file in
public/audio, measure integrated loudness (BS.1770-4), sample/true peak, RMS,
clipping, loop-seam continuity and spectral centroid, then draw waveform +
spectrogram contact sheets into docs/v2/evidence/audio/.

    python tools/audio/analyze.py
"""
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from dsp import SR, decode, lufs, true_peak_db, peak_db, rms_db, mono  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
PUB = os.path.join(ROOT, 'public', 'audio')
EVID = os.path.join(ROOT, 'docs', 'v2', 'evidence', 'audio')


def seam(x, loop_start, loop_end):
    """Compare the sample just before loopEnd with the one at loopStart, relative
    to the local slope distribution: ~1 means the wrap is as smooth as any
    neighbouring sample pair; >>10 would be an audible click."""
    m = mono(x)
    a, b = int(round(loop_start * SR)), int(round(loop_end * SR))
    b = min(b, len(m))
    jump = abs(m[b - 1] - m[a]) if b > a else 0
    d = np.abs(np.diff(m[max(a, b - SR // 2):b]))
    d2 = np.abs(np.diff(m[a:a + SR // 2]))
    typ = np.percentile(np.concatenate([d, d2]), 90) + 1e-9
    return float(jump / typ)


def centroid(x):
    m = mono(x)
    X = np.abs(np.fft.rfft(m * np.hanning(len(m))))
    f = np.fft.rfftfreq(len(m), 1 / SR)
    return float(np.sum(f * X) / (np.sum(X) + 1e-12))


def sheet(items, path, title, cols=4):
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    rows = int(np.ceil(len(items) / cols))
    fig, axes = plt.subplots(rows * 2, cols, figsize=(cols * 4.2, rows * 3.2),
                             gridspec_kw={'height_ratios': [1, 2] * rows})
    axes = np.atleast_2d(axes)
    for i in range(rows * cols):
        r, c = divmod(i, cols)
        aw, asp = axes[2 * r, c], axes[2 * r + 1, c]
        if i >= len(items):
            aw.axis('off'); asp.axis('off')
            continue
        name, x = items[i]
        m = mono(x)
        t = np.arange(len(m)) / SR
        step = max(1, len(m) // 4000)
        aw.plot(t[::step], m[::step], lw=0.4, color='#2a6')
        aw.set_xlim(0, t[-1] if len(t) else 1)
        aw.set_ylim(-1, 1)
        aw.set_title(name, fontsize=8)
        aw.tick_params(labelsize=6)
        asp.specgram(m + 1e-9, NFFT=1024, Fs=SR, noverlap=768, cmap='magma', vmin=-130, vmax=-20)
        asp.set_ylim(0, 16000)
        asp.tick_params(labelsize=6)
    fig.suptitle(title)
    fig.tight_layout()
    fig.savefig(path, dpi=80)
    plt.close(fig)


def main():
    os.makedirs(EVID, exist_ok=True)
    manifest = json.load(open(os.path.join(PUB, 'manifest.json')))
    report = {'sfx': {}, 'music': {}}
    sfx_items = []
    for sid, e in manifest['sfx'].items():
        for f in e['files']:
            x = decode(os.path.join(PUB, f + '.webm'))
            row = {'lufs': round(lufs(x), 1), 'peak': round(peak_db(x), 2), 'tp': round(true_peak_db(x), 2),
                   'rms': round(rms_db(x), 1), 'clip': int(np.sum(np.abs(x) >= 0.999)),
                   'centroid': round(centroid(x)), 'dur': round(len(x) / SR, 3),
                   'kb': round(os.path.getsize(os.path.join(PUB, f + '.webm')) / 1024, 1)}
            if e.get('loop'):
                row['seam'] = round(seam(x, e['loopStart'], e['loopEnd']), 2)
            report['sfx'][f] = row
            sfx_items.append((f.split('/')[-1], x))
    music_items = []
    for cid, e in manifest['music'].items():
        f = e['file']
        x = decode(os.path.join(PUB, f + '.webm'))
        row = {'lufs': round(lufs(x), 1), 'peak': round(peak_db(x), 2), 'tp': round(true_peak_db(x), 2),
               'rms': round(rms_db(x), 1), 'clip': int(np.sum(np.abs(x) >= 0.999)),
               'dur': round(len(x) / SR, 3), 'kb': round(os.path.getsize(os.path.join(PUB, f + '.webm')) / 1024, 1)}
        if e.get('loop'):
            row['seam'] = round(seam(x, e.get('loopStart', 0), e.get('loopEnd', len(x) / SR)), 2)
            # loop boundary loudness continuity: last vs first 2 s
            a = x[:2 * SR]
            b = x[-2 * SR:]
            row['edgeRmsDelta'] = round(rms_db(a) - rms_db(b), 2)
        report['music'][cid] = row
        music_items.append((cid, x))
    # contact sheets
    for k in range(0, len(sfx_items), 24):
        sheet(sfx_items[k:k + 24], os.path.join(EVID, f'sfx_sheet_{k // 24 + 1}.png'), 'SFX (decoded Opus)')
    if music_items:
        sheet(music_items, os.path.join(EVID, 'music_sheet.png'), 'Music cues (decoded Opus)', cols=3)
    sizes = {'webm': 0, 'm4a': 0}
    for dp, _, fs in os.walk(PUB):
        for fn in fs:
            ext = fn.rsplit('.', 1)[-1]
            if ext in sizes:
                sizes[ext] += os.path.getsize(os.path.join(dp, fn))
    report['bytes'] = sizes
    json.dump(report, open(os.path.join(EVID, 'analysis.json'), 'w'), indent=1)
    print(json.dumps(report['music'], indent=1))
    worst = sorted(((v.get('seam', 0), k) for k, v in report['sfx'].items()), reverse=True)[:5]
    print('worst sfx seams', worst)
    print('clipping files', [k for k, v in {**report['sfx'], **report['music']}.items() if v['clip']])
    print('bytes', sizes)


if __name__ == '__main__':
    main()
