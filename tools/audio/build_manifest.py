"""Write public/audio/manifest.json from the SFX and music render metadata.

The runtime reads it to know which files exist, their variants (round-robin),
exact loop points (seconds, measured on the source render so encoder padding
never shifts a loop) and music tempo/bar grid for quantised transitions.
"""
import json
import os

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
BUILD = os.path.join(ROOT, 'tools', 'audio', '.build')


def main():
    sfx_meta = json.load(open(os.path.join(BUILD, 'sfx', 'sfx_meta.json')))
    music_path = os.path.join(BUILD, 'music', 'music_meta.json')
    music_meta = json.load(open(music_path)) if os.path.exists(music_path) else {}
    out = {'version': 1, 'sampleRate': 48000, 'formats': ['webm', 'm4a'], 'sfx': {}, 'music': {}}
    for sid, m in sfx_meta.items():
        e = {'files': ['sfx/' + v['file'] for v in m['variants']]}
        if m['loop']:
            e['loop'] = True
            e['loopStart'] = m['variants'][0]['loopStart']
            e['loopEnd'] = m['variants'][0]['loopEnd']
        out['sfx'][sid] = e
    for cid, m in music_meta.items():
        e = {'file': 'music/' + m['file'], 'dur': m['dur'], 'bpm': m['bpm'], 'beatsPerBar': m['beatsPerBar'],
             'loop': m['loop'], 'group': m.get('group'), 'title': m.get('title'), 'gain': m.get('gain', 1)}
        if m['loop']:
            e['loopStart'] = m['loopStart']
            e['loopEnd'] = m['loopEnd']
        out['music'][cid] = e
    path = os.path.join(ROOT, 'public', 'audio', 'manifest.json')
    json.dump(out, open(path, 'w'), indent=1)
    print('wrote', path, len(out['sfx']), 'sfx', len(out['music']), 'music')


if __name__ == '__main__':
    main()
