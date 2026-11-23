"""Plot the in-browser AnalyserNode capture saved by the verification run.

    python tools/audio/plot_browser.py <capture.json> <out.png>

capture.json: { "timeline": [ {t, master, music, sfx, ui, radio, ambience, cue, level, w:[..], duck}, ...],
                "events": [ {t, label}, ... ] }
"""
import json
import sys

import matplotlib

matplotlib.use('Agg')
import matplotlib.pyplot as plt  # noqa: E402


def main(src, out):
    data = json.load(open(src))
    if isinstance(data, str):
        data = json.loads(data)
    tl = data['timeline']
    t = [r['t'] for r in tl]
    fig, axes = plt.subplots(3, 1, figsize=(12, 8), sharex=True, gridspec_kw={'height_ratios': [3, 1.3, 1]})
    for bus, col in [('master', '#222'), ('music', '#2a6'), ('sfx', '#c52'), ('radio', '#36c'), ('ui', '#a3a'), ('ambience', '#888')]:
        axes[0].plot(t, [max(-90, r[bus] if r[bus] is not None else -90) for r in tl], label=bus, color=col, lw=1)
    axes[0].set_ylabel('RMS dBFS (AnalyserNode)')
    axes[0].set_ylim(-80, 0)
    axes[0].legend(ncol=6, fontsize=8, loc='lower left')
    for i, col in enumerate(['#4a8', '#da4', '#d44']):
        axes[1].plot(t, [r['w'][i] if r.get('w') and len(r['w']) > i else 0 for r in tl], color=col, label=f'combat_{i + 1} weight')
    axes[1].plot(t, [r.get('level', 0) for r in tl], color='#000', ls='--', lw=0.8, label='intensity level')
    axes[1].legend(fontsize=8, loc='upper left')
    axes[1].set_ylim(-0.05, 1.05)
    axes[2].plot(t, [r.get('duck', 1) for r in tl], color='#36c', label='music duck gain')
    axes[2].set_ylim(0, 1.1)
    axes[2].legend(fontsize=8, loc='lower left')
    axes[2].set_xlabel('seconds')
    for e in data.get('events', []):
        for ax in axes:
            ax.axvline(e['t'], color='#999', lw=0.6, ls=':')
        axes[0].text(e['t'], -5, e['label'], rotation=90, fontsize=7, va='top')
    fig.suptitle('In-browser bus meters during the scripted audio tour (Chrome, WebGPU build)')
    fig.tight_layout()
    fig.savefig(out, dpi=90)


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
