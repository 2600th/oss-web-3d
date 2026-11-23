"""Multi-sample instrument player for the CC0 VSCO 2 CE / VCSL libraries.

- Note names in the file names are used only as hints: every sample's pitch
  is measured (autocorrelation) and the octave offset of each instrument is
  derived from the measurements, because the libraries mix octave conventions.
- Notes pick the nearest sample in the requested dynamic layer, pitch-shift by
  resampling (cubic), support pitch curves (meend/portamento glides, vibrato),
  extend beyond the sample by crossfade-looping the sustain, and get a release.
"""
import glob
import os
import re

import numpy as np

from dsp import SR, read_wav, secs, mono

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, '.cache', 'samples')
NOTE = {'C': 0, 'D': 2, 'E': 4, 'F': 5, 'G': 7, 'A': 9, 'B': 11}
NOTE_RX = re.compile(r'(?:^|[_\s-])([A-G])(#|b)?(-?\d)(?=[_\s.-])')


def name_to_midi(name):
    m = NOTE_RX.search(name)
    if not m:
        return None
    n, acc, octv = m.groups()
    return 12 * (int(octv) + 1) + NOTE[n] + (1 if acc == '#' else -1 if acc == 'b' else 0)


def midi_hz(m):
    return 440.0 * 2 ** ((m - 69) / 12)


def note(s):
    """'D4' / 'F#3' / 'Bb2' -> midi; ints pass through."""
    if isinstance(s, (int, float)):
        return s
    m = re.fullmatch(r'([A-G])(#|b)?(-?\d)', s.strip())
    n, acc, octv = m.groups()
    return 12 * (int(octv) + 1) + NOTE[n] + (1 if acc == '#' else -1 if acc == 'b' else 0)


def detect_f0(x, fmin=30, fmax=2200):
    m = mono(x)
    n = len(m)
    if n < secs(0.15):
        return None
    start = min(int(n * 0.3), secs(0.6))
    seg = m[start:start + 8192]
    if len(seg) < 4096:
        seg = m[:8192]
    seg = seg - seg.mean()
    seg *= np.hanning(len(seg))
    # normalised square difference (YIN-like)
    N = len(seg)
    ac = np.fft.irfft(np.abs(np.fft.rfft(seg, 2 * N)) ** 2)[:N]
    energy = np.cumsum(seg[::-1] ** 2)[::-1]
    nsdf = 2 * ac / (energy[0] + energy + 1e-12)
    lo, hi = int(SR / fmax), min(N - 1, int(SR / fmin))
    seg_nsdf = nsdf[lo:hi]
    if not len(seg_nsdf):
        return None
    thr = 0.8 * seg_nsdf.max()
    idx = np.argmax(seg_nsdf > thr)
    # local max after first crossing
    while idx + 1 < len(seg_nsdf) and seg_nsdf[idx + 1] > seg_nsdf[idx]:
        idx += 1
    tau = idx + lo
    if 1 <= tau < N - 1:
        a, b, c = nsdf[tau - 1], nsdf[tau], nsdf[tau + 1]
        d = (a - c) / (2 * (a - 2 * b + c) + 1e-12)
        tau = tau + d
    return SR / tau if tau > 0 else None


def trim_onset(x, rel_db=-42):
    m = np.abs(mono(x))
    thr = m.max() * 10 ** (rel_db / 20)
    i = int(np.argmax(m > thr))
    i = max(0, i - secs(0.002))
    return x[i:]


def cubic_read(x, pos):
    """Catmull-Rom interpolation of x (n,) or (n,c) at fractional positions."""
    i = np.floor(pos).astype(np.int64)
    f = pos - i
    n = len(x)
    i0, i1, i2, i3 = np.clip(i - 1, 0, n - 1), np.clip(i, 0, n - 1), np.clip(i + 1, 0, n - 1), np.clip(i + 2, 0, n - 1)
    if x.ndim == 2:
        f = f[:, None]
    p0, p1, p2, p3 = x[i0], x[i1], x[i2], x[i3]
    return p1 + 0.5 * f * (p2 - p0 + f * (2 * p0 - 5 * p1 + 4 * p2 - p3 + f * (3 * (p1 - p2) + p3 - p0)))


def retune(x, pitch_classes, fmin=40, fmax=400):
    """Resample a drum hit so its dominant low mode lands on the nearest allowed
    pitch class (e.g. timpani on D/A, the key's Sa/Pa)."""
    m = mono(x)[:secs(0.6)]
    X = np.abs(np.fft.rfft(m * np.hanning(len(m)), 8 * len(m)))
    f = np.fft.rfftfreq(8 * len(m), 1 / SR)
    sel = (f > fmin) & (f < fmax)
    fp = f[sel][np.argmax(X[sel])]
    mf = 69 + 12 * np.log2(fp / 440)
    cands = [k for k in range(int(mf) - 7, int(mf) + 8) if k % 12 in pitch_classes]
    target = min(cands, key=lambda k: abs(k - mf))
    ratio = 2 ** ((target - mf) / 12)
    pos = np.arange(0, len(x) - 3, ratio)
    return cubic_read(x, pos)


class Instrument:
    """
    folders: list of cache-relative folders; layers: list of regexes, soft→loud.
    pitched=False: samples are picked by layer/round-robin only (drums).
    """

    def __init__(self, name, folders, layers=None, pitched=True, exclude=None, include=None, gain=1.0,
                 onset_db=-42, octave_fix=None, fixed_midi=None, tune_to=None):
        self.name = name
        self.pitched = pitched
        self.gain = gain
        self.samples = []  # dicts: midi, layer, data
        layers = layers or ['.']
        files = []
        for f in folders:
            files += sorted(glob.glob(os.path.join(CACHE, f, '*.wav')))
        if not files:
            raise FileNotFoundError(f'{name}: no samples in {folders} (run fetch_samples.py)')
        offsets = []
        for path in files:
            base = os.path.basename(path)
            if exclude and re.search(exclude, base):
                continue
            if include and not re.search(include, base):
                continue
            li = None
            for k, rx in enumerate(layers):
                if re.search(rx, base):
                    li = k
            if li is None:
                continue
            x = read_wav(path)
            if x.ndim == 1:
                x = np.stack([x, x], axis=1)
            x = trim_onset(x, onset_db)
            if tune_to:
                x = retune(x, tune_to)
            entry = {'layer': li, 'data': x, 'file': base, 'rr': 0}
            if pitched:
                hint = name_to_midi(base) if fixed_midi is None else fixed_midi
                f0 = detect_f0(x)
                entry['hint'] = hint
                entry['f0'] = f0
                if hint is not None and f0 and np.isfinite(f0) and f0 > 0:
                    measured = 69 + 12 * np.log2(f0 / 440)
                    k = round((measured - hint) / 12)
                    if abs(measured - (hint + 12 * k)) < 0.7:
                        offsets.append(k)
            self.samples.append(entry)
        self.layers = len(layers)
        if pitched:
            if octave_fix is not None:
                off = octave_fix
            else:
                off = int(np.median(offsets)) if offsets else 0
            self.octave_offset = off
            for s in self.samples:
                s['midi'] = (s['hint'] if s['hint'] is not None else 60) + 12 * off
        self._rr = {}

    def pick(self, midi=None, layer=None, rng=None):
        layer = self.layers - 1 if layer is None else min(self.layers - 1, max(0, layer))
        cands = [s for s in self.samples if s['layer'] == layer] or self.samples
        if self.pitched:
            best = min(abs(s['midi'] - midi) for s in cands)
            cands = [s for s in cands if abs(s['midi'] - midi) == best]
        key = (midi, layer)
        i = self._rr.get(key, -1) + 1
        self._rr[key] = i
        return cands[i % len(cands)]

    def render(self, midi=None, dur=None, vel=0.8, layer=None, bend=None, vibrato=None, release=0.25,
               attack=0.0, rng=None, start_offset=0.0):
        """
        dur: seconds the note is held (None = full sample, for one-shots)
        bend: callable(t_seconds) -> semitones offset (meend / glide)
        vibrato: (rate_hz, depth_semitones, delay_s)
        Returns stereo array.
        """
        if layer is None:
            layer = int(round(vel * (self.layers - 1))) if self.layers > 1 else 0
        s = self.pick(midi, layer, rng)
        x = s['data']
        if start_offset:
            x = x[secs(start_offset):]
        base_ratio = 2 ** ((midi - s['midi']) / 12) if self.pitched and midi is not None else 1.0
        total = (dur + release) if dur is not None else len(x) / SR / base_ratio
        n = secs(total)
        t = np.arange(n) / SR
        semis = np.zeros(n)
        if bend is not None:
            semis += bend(t)
        if vibrato is not None:
            rate, depth, delay = vibrato
            ramp = np.clip((t - delay) / 0.4, 0, 1)
            semis += depth * ramp * np.sin(2 * np.pi * rate * t)
        ratio = base_ratio * 2 ** (semis / 12)
        pos = np.concatenate([[0], np.cumsum(ratio)[:-1]])
        need = pos[-1] + 4
        if need > len(x) - 4:
            x = self._extend(x, int(need) + secs(0.2))
        y = cubic_read(x, pos)
        env = np.ones(n)
        if attack > 0:
            a = min(n, secs(attack))
            env[:a] = np.linspace(0, 1, a) ** 1.5
        if dur is not None:
            r0 = secs(dur)
            rl = n - r0
            if rl > 0:
                env[r0:] *= np.exp(-np.linspace(0, 6, rl))
        return y * env[:, None] * self.gain * (0.25 + 0.75 * vel)

    @staticmethod
    def _extend(x, length):
        """Crossfade-loop the sustain region so a note can be held indefinitely."""
        L = len(x)
        a, b = int(L * 0.35), int(L * 0.85)
        seg = x[a:b]
        xf = min(secs(0.25), len(seg) // 3)
        out = [x[:b]]
        cur = len(x[:b])
        w = np.sin(np.linspace(0, np.pi / 2, xf))[:, None]
        while cur < length:
            prev = out[-1]
            nxt = seg.copy()
            # crossfade the end of prev with the start of nxt
            prev_tail = prev[-xf:] * w[::-1] + nxt[:xf] * w
            out[-1] = np.concatenate([prev[:-xf], prev_tail])
            out.append(nxt[xf:])
            cur += len(nxt) - xf
        return np.concatenate(out)[:length]


_LIB = {}


def lib(name):
    """Lazily constructed instrument table."""
    if name in _LIB:
        return _LIB[name]
    V, C = 'vsco/', 'vcsl/'
    defs = {
        'vln': lambda: Instrument('vln', [V + 'Strings/Violin Section/susVib'], ['_v1', '_v2']),
        'vln_spic': lambda: Instrument('vln_spic', [V + 'Strings/Violin Section/Spic'], ['_v1_', '_v2_']),
        'vln_trem': lambda: Instrument('vln_trem', [V + 'Strings/Violin Section/Trem']),
        'vla': lambda: Instrument('vla', [V + 'Strings/Viola Section/susvib']),
        'vla_spic': lambda: Instrument('vla_spic', [V + 'Strings/Viola Section/spic'], ['_v1_', '_v2_']),
        'vc': lambda: Instrument('vc', [V + 'Strings/Cello Section/susvib'], ['_v1_', '_v3_']),
        'vc_spic': lambda: Instrument('vc_spic', [V + 'Strings/Cello Section/spic'], ['_v1_', '_v2_']),
        'cb': lambda: Instrument('cb', [V + 'Strings/Solo Contrabass/SusVib']),
        'cb_spic': lambda: Instrument('cb_spic', [V + 'Strings/Solo Contrabass/Spic'], ['_v1_', '_v3_'], octave_fix=1),
        'solo_vln': lambda: Instrument('solo_vln', [V + 'Strings/Solo Violin/Arco Vib']),
        'harp': lambda: Instrument('harp', [V + 'Strings/Harp'], onset_db=-36),
        'horn': lambda: Instrument('horn', [V + 'Brass/F Horn/sus'], ['_v2_', '_v3_']),
        'horn_stac': lambda: Instrument('horn_stac', [V + 'Brass/F Horn/stac']),
        'tbn': lambda: Instrument('tbn', [V + 'Brass/Tenor Trombone/sus'], ['_v2_', '_v3_']),
        'tpt': lambda: Instrument('tpt', [V + 'Brass/Trumpet/sus']),
        'tuba': lambda: Instrument('tuba', [V + 'Brass/Tuba/sus']),
        'flute': lambda: Instrument('flute', [V + 'Woodwinds/Flute/susvib']),
        'flute_nv': lambda: Instrument('flute_nv', [V + 'Woodwinds/Flute/susNV'], ['_v1_', '_v[23]_']),
        'timp': lambda: Instrument('timp', [V + 'Percussion/Timpani'], ['_v1_', '_v3_', '_v4_'], pitched=False, tune_to={2, 9}),
        'timp_roll': lambda: Instrument('timp_roll', [V + 'Percussion/Timpani/Rolls'], pitched=False, tune_to={2, 9}),
        'bdrum': lambda: Instrument('bdrum', [V + 'VSCO 1 Percussion/drums/bass'], ['_f_', 'ff_', 'fff'], pitched=False, exclude='muted'),
        'bdrum_muted': lambda: Instrument('bdrum_muted', [V + 'VSCO 1 Percussion/drums/bass'], pitched=False, include='muted'),
        'bdrum2': lambda: Instrument('bdrum2', [C + 'Membranophones/Struck Membranophones/Bass Drum 1'], ['_v2_', '_v3_', '_v5_', '_v7_'], pitched=False),
        'crash': lambda: Instrument('crash', [V + 'VSCO 1 Percussion/varMetal/Cymbals/clash'], ['_mp_|_pp_', '_ff_', '_fff_'], pitched=False),
        'crash2': lambda: Instrument('crash2', [C + 'Idiophones/Struck Idiophones/Clash Cymbals 1'], ['_pp|_mp', '_mf', '_ff'], pitched=False, exclude='short'),
        'cym_roll': lambda: Instrument('cym_roll', [C + 'Idiophones/Struck Idiophones/Suspended Cymbal 1'], pitched=False, include='cresc'),
        'cym_swell': lambda: Instrument('cym_swell', [V + 'VSCO 1 Percussion/varMetal/Cymbals/susp'], pitched=False, include='roll2_cresc|roll4'),
        'frame': lambda: Instrument('frame', [C + 'Membranophones/Struck Membranophones/Frame Drum'], ['Muted', 'Hit_'], pitched=False, include='HDrumL', tune_to={2, 9}),
        'frame_hi': lambda: Instrument('frame_hi', [C + 'Membranophones/Struck Membranophones/Frame Drum'], ['Muted', 'Hit_'], pitched=False, include='HDrumS', tune_to={2, 9}),
        'darbuka': lambda: Instrument('darbuka', [C + 'Membranophones/Struck Membranophones/Darbuka'], ['vl1', 'vl2'], pitched=False),
        'tom': lambda: Instrument('tom', [C + 'Membranophones/Struck Membranophones/Tom 1/Mallet'], ['_v2_', '_v3_', '_v4_'], pitched=False, exclude='Roll', tune_to={2, 9}),
        'tom_stick': lambda: Instrument('tom_stick', [C + 'Membranophones/Struck Membranophones/Tom 1/Stick'], ['_v2_', '_v3_', '_v4_'], pitched=False, exclude='Roll', tune_to={2, 9}),
        'snare': lambda: Instrument('snare', [C + 'Membranophones/Struck Membranophones/Snare Drum, Modern 1'], ['_v4_', '_v5_'], pitched=False, include='HitSN|HitNS'),
        'snare_roll': lambda: Instrument('snare_roll', [C + 'Membranophones/Struck Membranophones/Snare Drum, Modern 1'], pitched=False, include='roll'),
        'hat': lambda: Instrument('hat', [C + 'Idiophones/Struck Idiophones/Hi-Hat Cymbal'], ['_v1_|_v2_', '_v3_|_v4_'], pitched=False, include='HitC'),
        'hat_open': lambda: Instrument('hat_open', [C + 'Idiophones/Struck Idiophones/Hi-Hat Cymbal'], pitched=False, include='HitO_|HitLoose'),
        'shaker': lambda: Instrument('shaker', [C + 'Idiophones/Struck Idiophones/Shaker, Small'], pitched=False, include='ShakerDouble|HighFaster'),
        'bells_nep': lambda: Instrument('bells_nep', [C + 'Idiophones/Struck Idiophones/Hand Bells, Nepalese'], pitched=False),
        'chimes': lambda: Instrument('chimes', [C + 'Idiophones/Struck Idiophones/Tubular Bells 1'], onset_db=-30),
        'gong': lambda: Instrument('gong', [C + 'Idiophones/Struck Idiophones/Gong 1'], ['_p|_mp', '_mf|_f', '_fff'], pitched=False, exclude='scrape'),
    }
    _LIB[name] = defs[name]()
    return _LIB[name]
