"""Fetch the CC0 orchestral/percussion samples the score is rendered from.

Sources (both CC0-1.0, public domain dedication, by Sam Gossner and contributors):
  * VSCO 2 Community Edition  https://github.com/sgossner/VSCO-2-CE
  * Versilian Community Sample Library (VCSL)  https://github.com/sgossner/VCSL

Only the folders the score uses are downloaded, into tools/audio/.cache/ (git-ignored).
The raw samples are never shipped; only the rendered, mixed music is.

    python tools/audio/fetch_samples.py           # download what is missing
    python tools/audio/fetch_samples.py --dry     # list what would be fetched
"""
import json
import os
import re
import sys
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, '.cache', 'samples')

REPOS = {
    'vsco': ('sgossner/VSCO-2-CE', 'master'),
    'vcsl': ('sgossner/VCSL', 'master'),
}

# (repo, folder, optional regex on filename). Folder match is exact (no recursion).
WANT = [
    ('vsco', 'Strings/Violin Section/susVib', None),
    ('vsco', 'Strings/Violin Section/Spic', r'_rr1'),
    ('vsco', 'Strings/Violin Section/Trem', r'_v2'),
    ('vsco', 'Strings/Viola Section/susvib', r'_v2'),
    ('vsco', 'Strings/Viola Section/spic', None),
    ('vsco', 'Strings/Cello Section/susvib', None),
    ('vsco', 'Strings/Cello Section/spic', r'_RR1'),
    ('vsco', 'Strings/Solo Contrabass/SusVib', r'_v3'),
    ('vsco', 'Strings/Solo Contrabass/Spic', None),
    ('vsco', 'Strings/Solo Violin/Arco Vib', r'_f\.wav$'),
    ('vsco', 'Strings/Harp', None),
    ('vsco', 'Brass/F Horn/sus', r'_v[23]_'),
    ('vsco', 'Brass/F Horn/stac', r'_v3_rr1'),
    ('vsco', 'Brass/Tenor Trombone/sus', r'_v[23]_'),
    ('vsco', 'Brass/Trumpet/sus', r'_v3_'),
    ('vsco', 'Brass/Tuba/sus', r'_v3_'),
    ('vsco', 'Woodwinds/Flute/susvib', None),
    ('vsco', 'Woodwinds/Flute/susNV', None),
    ('vsco', 'Percussion/Timpani', None),
    ('vsco', 'Percussion/Timpani/Rolls', r'_v5_'),
    ('vsco', 'VSCO 1 Percussion/drums/bass', r'(fff|_f_|ff)'),
    ('vsco', 'VSCO 1 Percussion/varMetal/Cymbals/susp', r'(roll|hit_hardmall_f|hit_softmall)'),
    ('vsco', 'VSCO 1 Percussion/varMetal/Cymbals/clash', None),
    ('vcsl', 'Membranophones/Struck Membranophones/Frame Drum', None),
    ('vcsl', 'Membranophones/Struck Membranophones/Darbuka', None),
    ('vcsl', 'Membranophones/Struck Membranophones/Bass Drum 1', None),
    ('vcsl', 'Membranophones/Struck Membranophones/Tom 1/Mallet', None),
    ('vcsl', 'Membranophones/Struck Membranophones/Tom 1/Stick', None),
    ('vcsl', 'Membranophones/Struck Membranophones/Snare Drum, Modern 1', r'_v[45]_'),
    ('vcsl', 'Idiophones/Struck Idiophones/Hi-Hat Cymbal', None),
    ('vcsl', 'Idiophones/Struck Idiophones/Clash Cymbals 1', None),
    ('vcsl', 'Idiophones/Struck Idiophones/Hand Bells, Nepalese', None),
    ('vcsl', 'Idiophones/Struck Idiophones/Tubular Bells 1', r'_ff_|_f_'),
    ('vcsl', 'Idiophones/Struck Idiophones/Gong 1', None),
    ('vcsl', 'Idiophones/Struck Idiophones/Shaker, Small', None),
    ('vcsl', 'Idiophones/Struck Idiophones/Suspended Cymbal 1', r'(cresc|roll)'),
]


def tree(repo, branch):
    cache = os.path.join(HERE, '.cache', f'{repo.replace("/", "_")}_tree.json')
    if os.path.exists(cache):
        return json.load(open(cache, encoding='utf8'))
    url = f'https://api.github.com/repos/{repo}/git/trees/{branch}?recursive=1'
    req = urllib.request.Request(url, headers={'User-Agent': 'audio-tools'})
    data = json.load(urllib.request.urlopen(req, timeout=60))
    os.makedirs(os.path.dirname(cache), exist_ok=True)
    json.dump(data, open(cache, 'w', encoding='utf8'))
    return data


def plan():
    jobs = []
    trees = {k: tree(*v) for k, v in REPOS.items()}
    for key, folder, rx in WANT:
        repo, branch = REPOS[key]
        for item in trees[key]['tree']:
            if item['type'] != 'blob' or not item['path'].lower().endswith('.wav'):
                continue
            d, _, f = item['path'].rpartition('/')
            if d != folder or (rx and not re.search(rx, f)):
                continue
            url = f'https://raw.githubusercontent.com/{repo}/{branch}/' + urllib.parse.quote(item['path'])
            dest = os.path.join(CACHE, key, item['path'])
            jobs.append((url, dest, item['size']))
    return jobs


def fetch(job):
    url, dest, size = job
    if os.path.exists(dest) and os.path.getsize(dest) == size:
        return 0
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    tmp = dest + '.part'
    for attempt in range(4):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'audio-tools'}), timeout=120) as r, open(tmp, 'wb') as fh:
                fh.write(r.read())
            os.replace(tmp, dest)
            return size
        except Exception as e:  # noqa: BLE001
            if attempt == 3:
                print('FAILED', url, e, file=sys.stderr)
    return 0


if __name__ == '__main__':
    jobs = plan()
    total = sum(s for _, _, s in jobs)
    print(f'{len(jobs)} files, {total / 1e6:.0f} MB')
    if '--dry' in sys.argv:
        sys.exit(0)
    done = 0
    with ThreadPoolExecutor(12) as ex:
        for n in ex.map(fetch, jobs):
            done += n
    print(f'fetched {done / 1e6:.0f} MB')
