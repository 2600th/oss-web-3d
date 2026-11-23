"""Tiny sequencing DSL + offline renderer/mixer for the score (see score.py).

A Cue has tempo, bars and named Tracks. A Track holds note/hit events in
beats and a mix strip (gain dB, pan, reverb send, EQ). Rendering:

  events -> instrument audio (samples or synthesis) -> track strip
        -> dry sum + hall-reverb send -> (loops) fold the reverb/release tail
        onto the loop start -> glue compression (circular for loops)
        -> loudness normalise -> true-peak-safe limiter.
"""
import hashlib
import re

import numpy as np

from dsp import (SR, secs, rng, hp, lp, peak_eq, shelf, make_ir, fold_tail, compressor, limiter,
                 normalize_lufs, lufs, true_peak_db, mix_at)
from sampler import lib, note
import instruments as I

NOTE_TOKEN = re.compile(r'^([A-Gr][#b]?\d?(?:\+[A-G][#b]?\d)*)(?::([\d.]+))?$')

CHORDS = {
    'Dm': 'D F A', 'D': 'D F# A', 'C': 'C E G', 'Bb': 'Bb D F', 'F': 'F A C', 'Gm': 'G Bb D', 'G': 'G B D',
    'A': 'A C# E', 'Am': 'A C E', 'Eb': 'Eb G Bb', 'Cm': 'C Eb G', 'Bm': 'B D F#', 'Em': 'E G B',
    'F#m': 'F# A C#', 'Asus': 'A D E', 'Dsus2': 'D E A', 'Db': 'Db F Ab', 'Ab': 'Ab C Eb', 'Fm': 'F Ab C',
    'Bbm': 'Bb Db F', 'E': 'E G# B',
}
PC = {'C': 0, 'C#': 1, 'Db': 1, 'D': 2, 'D#': 3, 'Eb': 3, 'E': 4, 'F': 5, 'F#': 6, 'Gb': 6, 'G': 7, 'G#': 8,
      'Ab': 8, 'A': 9, 'A#': 10, 'Bb': 10, 'B': 11}


def chord_root(name):
    return PC[name.split('/')[0].rstrip('msu2dim7aj9')[:2] if name[1:2] in '#b' else name[0]]


def voicing(name, lo, hi):
    """All tones of chord `name` between midi lo and hi (inclusive)."""
    pcs = [PC[x] for x in CHORDS[name].split()]
    return [m for m in range(int(lo), int(hi) + 1) if m % 12 in pcs]


def root_midi(name, octave):
    base = name[:2] if name[1:2] in ('#', 'b') else name[:1]
    return 12 * (octave + 1) + PC[base]


class Track:
    def __init__(self, cue, name, inst, gain=0.0, pan=0.0, reverb=0.25, hpf=None, lpf=None, eq=(), humanize=0.006,
                 legato=0.04, kw=None):
        self.cue, self.name, self.inst = cue, name, inst
        self.gain, self.pan, self.reverb, self.hpf, self.lpf, self.eq = gain, pan, reverb, hpf, lpf, eq
        self.humanize, self.legato = humanize, legato
        self.kw = kw or {}
        self.events = []

    def note(self, beat, dur, pitch, vel=0.8, **kw):
        self.events.append({'beat': beat, 'dur': dur, 'pitch': pitch, 'vel': vel, **kw})
        return self

    def chord(self, beat, dur, pitches, vel=0.8, **kw):
        for p in pitches:
            self.note(beat, dur, p, vel, **kw)
        return self

    def seq(self, beat, text, vel=0.8, scale=1.0, transpose=0, **kw):
        """'D4:1.5 E4:.5 F4 A4 | r:2 D4+F4:2' — durations in beats (default 1), bars '|' ignored."""
        b = beat
        for tok in text.replace('|', ' ').split():
            m = NOTE_TOKEN.match(tok)
            if not m:
                raise ValueError(f'bad token {tok!r} in {self.name}')
            p, d = m.group(1), float(m.group(2) or 1) * scale
            if p != 'r':
                for q in p.split('+'):
                    self.note(b, d, note(q) + transpose, vel, **kw)
            b += d
        return b

    def hits(self, beat, pattern, step=0.25, vel=None, **kw):
        """Drum grid: 'X' accent, 'x' normal, 'o' ghost, '.' rest; spaces ignored."""
        vmap = vel or {'X': 1.0, 'x': 0.72, 'o': 0.4}
        b = beat
        for ch in pattern.replace(' ', '').replace('|', ''):
            if ch in vmap:
                self.note(b, step, None, vmap[ch], **kw)
            b += step
        return b


class Cue:
    def __init__(self, name, bpm, bars, beats_per_bar=4, loop=True, tail=6.0, lufs_target=-16.0, title='',
                 seed_group=None, group=None, hall=2.6, master_gain=0.0):
        self.name, self.bpm, self.bars, self.bpb = name, bpm, bars, beats_per_bar
        self.loop, self.tail, self.lufs_target, self.title = loop, tail, lufs_target, title
        self.seed_group = seed_group or name
        self.group = group
        self.hall = hall
        self.tracks = {}
        self.master_gain = master_gain

    @property
    def spb(self):
        return 60.0 / self.bpm

    @property
    def length(self):
        return self.bars * self.bpb * self.spb

    def bar(self, b, beat=0.0):
        return b * self.bpb + beat

    def track(self, name, inst, **kw):
        if name not in self.tracks:
            self.tracks[name] = Track(self, name, inst, **kw)
        return self.tracks[name]


def _seed(*parts):
    return int(hashlib.md5('/'.join(map(str, parts)).encode()).hexdigest()[:8], 16)


def render_event(tr, ev, r, spb):
    inst = tr.inst
    dur_s = ev['dur'] * spb
    vel = float(np.clip(ev['vel'] + r.uniform(-0.04, 0.04), 0.05, 1.0))
    kw = {**tr.kw, **{k: v for k, v in ev.items() if k not in ('beat', 'dur', 'pitch', 'vel')}}
    p = ev['pitch']
    if inst == 'bansuri':
        return I.bansuri(p, dur_s + tr.legato, r, vel, **kw)
    if inst == 'sarangi':
        return I.sarangi(p, dur_s + tr.legato, r, vel, **kw)
    if inst == 'tabla':
        return np.stack([I.tabla(kw.get('stroke', 'na'), r, vel)] * 2, axis=1)
    if inst == 'dhol':
        return np.stack([I.dhol(kw.get('stroke', 'dagga'), r, vel)] * 2, axis=1)
    if inst == 'synth_bass':
        y = I.synth_bass(p, dur_s, r, vel, **kw)
        return np.stack([y, y], axis=1)
    if inst == 'pulse':
        y = I.pulse(p, dur_s, r, vel, **kw)
        return np.stack([y, np.roll(y, 13)], axis=1)
    if inst == 'tanpura':
        y = I.tanpura_cycle(p, dur_s, r, cycle=kw.get('cycle', 4.8))
        return np.stack([y, np.roll(y, 29)], axis=1)
    if inst == 'braam':
        return I.braam(kw['chord'], dur_s, r, vel)
    if inst == 'impact':
        return I.impact(r, vel)
    if inst == 'riser':
        return I.riser(dur_s, r)
    if inst == 'swell':
        return I.reverse_swell(kw['chord'], dur_s, r)
    lb = lib(inst)
    if not lb.pitched:
        return lb.render(None, None, vel, layer=kw.get('layer'))
    return lb.render(p, dur_s + tr.legato, vel, release=kw.get('release', 0.3), attack=kw.get('attack', 0.0),
                     layer=kw.get('layer'), vibrato=kw.get('vibrato'))


def render_track(cue, tr, total_n):
    out = np.zeros((total_n, 2))
    r = rng(_seed(cue.seed_group, tr.name))
    for ev in sorted(tr.events, key=lambda e: e['beat']):
        y = render_event(tr, ev, r, cue.spb)
        if y is None or not len(y):
            continue
        t = ev['beat'] * cue.spb + r.normal(0, tr.humanize) + ev.get('delay', 0.0)
        mix_at(out, y, max(0, secs(t)))
    if tr.hpf:
        out = hp(out, tr.hpf, 2)
    if tr.lpf:
        out = lp(out, tr.lpf, 2)
    for f, g, q in tr.eq:
        out = peak_eq(out, f, g, q)
    if tr.pan:
        a = (tr.pan + 1) * np.pi / 4
        out = out * np.array([np.cos(a), np.sin(a)]) * 1.4142
    return out * 10 ** (tr.gain / 20)


def render_cue(cue, verbose=True):
    loop_n = secs(cue.length)
    total_n = loop_n + secs(cue.tail)
    dry = np.zeros((total_n, 2))
    send = np.zeros((total_n, 2))
    for tr in cue.tracks.values():
        if not tr.events:
            continue
        y = render_track(cue, tr, total_n)
        dry += y
        send += y * tr.reverb
        if verbose:
            print(f'   {tr.name:14s} {len(tr.events):4d} ev')
    ir = make_ir(cue.hall + 1.0, rng(_seed('hall', cue.hall)), decay_s=cue.hall, damp_hz=(9000, 1400),
                 early=[(0.019, 0.35), (0.031, 0.3), (0.047, 0.22)], predelay=0.02)
    from scipy.signal import fftconvolve
    wet = np.stack([fftconvolve(send[:, c], ir[:, c])[:total_n] for c in range(2)], axis=1)
    mix = dry + wet * 0.6
    mix = hp(mix, 28, 2)
    mix = shelf(mix, 9000, 1.0, 'high')
    if cue.loop:
        mix = fold_tail(mix, loop_n)
    else:
        # trim trailing silence, short fade
        m = np.max(np.abs(mix), axis=1)
        idx = np.nonzero(m > 10 ** (-70 / 20))[0]
        end = min(len(mix), (idx[-1] if len(idx) else len(mix)) + secs(0.2))
        mix = mix[:end]
        f = secs(0.5)
        mix[-f:] *= np.linspace(1, 0, f)[:, None]
    mix = compressor(mix, thresh_db=-20, ratio=2.2, attack_s=0.02, release_s=0.25, circular=cue.loop)
    target = cue.lufs_target + cue.master_gain
    trim = 0.0
    for _ in range(3):  # the limiter costs a little loudness; converge on the target
        out = limiter(normalize_lufs(mix, target + trim), ceiling_db=-1.2, release_s=0.1, circular=cue.loop)
        err = target - lufs(out)
        if abs(err) < 0.15:
            break
        trim += err
    return out
