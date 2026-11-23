"""Synthesised instruments for the score (no samples exist under CC0 for these):

  tanpura   drone pluck with a jawari-style moving formant over the harmonics
  tabla     modal dayan (tuned to Sa) + bayan with its pitch-bending bass
  dhol      two-headed barrel drum: booming dagga side, cracking tilli side
  bansuri   VSCO flute samples + breath noise + meend glides + andolan
  sarangi   solo-violin samples with glides and a nasal, sympathetic resonance
  synth     analog-style bass / pulse / braam, cinematic impact, riser
"""
import numpy as np

from dsp import (SR, secs, t_axis, rng, white, pink, brown, lp, hp, bp, peak_eq, resonator, sweep_filter,
                 env_exp, env_points, osc, saturate, modal, bl_wave)
from sampler import lib, midi_hz


def stereo_pan(x, pan):
    """Constant-power pan, pan in [-1, 1]; x mono or stereo."""
    a = (pan + 1) * np.pi / 4
    if x.ndim == 1:
        return np.stack([x * np.cos(a), x * np.sin(a)], axis=1)
    return np.stack([x[:, 0] * np.cos(a) * 1.41, x[:, 1] * np.sin(a) * 1.41], axis=1) * 0.71


# ------------------------------------------------------------------ tanpura
def tanpura(midi, dur, r, vel=0.7):
    f0 = midi_hz(midi)
    n = secs(dur)
    t = t_axis(n)
    y = np.zeros(n)
    K = int(min(48, 9000 / f0))
    # jawari: a spectral hump that sweeps up the harmonic series then settles
    peak = 3 + 16 * (1 - np.exp(-t / 1.6))
    for k in range(1, K + 1):
        base = 1 / k ** 1.1
        hump = 0.9 * np.exp(-((k - peak) ** 2) / (2 * (2.2 + 0.08 * k) ** 2))
        dec = np.exp(-t / (3.5 / (1 + 0.04 * k)))
        det = 1 + r.uniform(-0.0006, 0.0006)
        y += (base + hump / k ** 0.3) * dec * np.sin(2 * np.pi * f0 * k * det * t + r.uniform(0, 6.28))
    y *= np.clip(t / 0.006, 0, 1) * 0.12 * vel
    # bridge buzz
    y += hp(white(r, n), 2000) * env_exp(n, 0.4) * 0.01 * vel
    return y


def tanpura_cycle(root_midi, seconds, r, cycle=4.8, gain=1.0, start=0.0):
    """Pa – Sa' – Sa' – Sa, continuously, for `seconds` (mono)."""
    n = secs(seconds)
    out = np.zeros(n + secs(6))
    pattern = [root_midi - 5, root_midi + 12 - 12, root_midi, root_midi - 12]  # Pa(low), Sa, Sa, Sa(low)
    pattern = [root_midi - 5, root_midi, root_midi, root_midi - 12]
    t = start
    i = 0
    while t < seconds:
        m = pattern[i % 4]
        y = tanpura(m, 5.5, r, vel=0.8 if i % 4 == 0 else 0.7)
        k = secs(t)
        out[k:k + len(y)] += y[:len(out) - k]
        t += cycle / 4 * (1 + r.uniform(-0.03, 0.03))
        i += 1
    return out * gain


# -------------------------------------------------------------------- tabla
SA = 62  # D4


def tabla(stroke, r, vel=0.8, sa=SA):
    f = midi_hz(sa)
    n = secs(1.6)
    t = t_axis(n)
    y = np.zeros(n)

    def dayan(kind):
        if kind == 'na':      # rim stroke: bright, ringing 2nd/3rd modes
            modes = [(f, 0.35, 0.5), (2 * f, 0.3, 1.0), (3 * f, 0.22, 0.7), (4 * f, 0.15, 0.4), (5.03 * f, 0.1, 0.25)]
            click = 0.35
        elif kind == 'tin':   # open centre-ring: fundamental-heavy, long
            modes = [(f, 0.7, 1.0), (2 * f, 0.45, 0.45), (3 * f, 0.3, 0.2), (4 * f, 0.2, 0.1)]
            click = 0.15
        elif kind == 'te':    # closed, dry
            modes = [(f * 1.02, 0.04, 0.6), (2.1 * f, 0.03, 0.5), (3.3 * f, 0.02, 0.3)]
            click = 0.6
        else:                 # 'ti' light
            modes = [(f, 0.08, 0.5), (2 * f, 0.06, 0.6), (3 * f, 0.04, 0.3)]
            click = 0.4
        s = modal(n, modes, r, jitter=0.004)
        s += hp(white(r, n), 2500) * env_exp(n, 0.004) * click
        return s

    def bayan(open_=True):
        if open_:
            f0 = 110 * (1 + r.uniform(-0.01, 0.01))  # A2 (Pa) so the bayan sits in the raga
            glide = f0 * (1 + 0.35 * np.exp(-t / 0.08)) * (1 + 0.06 * np.exp(-t / 0.5))
            s = osc(glide, n) * env_exp(n, 0.55, 0.003)
            s += 0.3 * osc(glide * 2.02, n) * env_exp(n, 0.25)
            s += lp(white(r, n), 900) * env_exp(n, 0.01) * 0.4
            return s
        s = lp(white(r, n), 1200) * env_exp(n, 0.02) * 0.9 + osc(140, n) * env_exp(n, 0.03) * 0.6
        return s

    if stroke in ('na', 'tin', 'te', 'ti'):
        y += dayan(stroke)
    elif stroke == 'ge':
        y += bayan(True)
    elif stroke == 'ke':
        y += bayan(False)
    elif stroke == 'dha':
        y += dayan('na') + bayan(True) * 0.9
    elif stroke == 'dhin':
        y += dayan('tin') + bayan(True) * 0.9
    elif stroke == 'tun':
        y += dayan('tin') * 0.8
    return y * vel * 0.5


# --------------------------------------------------------------------- dhol
def dhol(stroke, r, vel=0.8):
    n = secs(1.0)
    t = t_axis(n)
    if stroke == 'dagga':  # bass side with stick: big boom
        f = 73.4 * (1 + 0.5 * np.exp(-t / 0.03))  # D2
        y = osc(f, n) * env_exp(n, 0.3, 0.002) * 1.2 + 0.4 * osc(f * 1.6, n) * env_exp(n, 0.1)
        y += lp(white(r, n), 1500) * env_exp(n, 0.015) * 0.7
    elif stroke == 'dagga_m':  # muted bass
        f = 82.4 * (1 + 0.4 * np.exp(-t / 0.02))  # E2
        y = osc(f, n) * env_exp(n, 0.08, 0.002) * 1.1 + lp(white(r, n), 1200) * env_exp(n, 0.012) * 0.6
    else:  # tilli: thin cane on the treble head
        modes = [(420, 0.06, 1), (690, 0.04, 0.7), (1130, 0.03, 0.5), (1720, 0.02, 0.3)]
        y = modal(n, modes, r, jitter=0.01) * 0.8 + hp(white(r, n), 1800) * env_exp(n, 0.008) * 1.0
    return saturate(y * vel, 1.3) * 0.6


# ------------------------------------------------------------------ bansuri
def bansuri(midi, dur, r, vel=0.75, meend_from=None, meend_time=0.12, andolan=0.0, vibrato=True):
    """Flute samples darkened and breathed into a bansuri-like voice."""
    fl = lib('flute' if vibrato else 'flute_nv')

    def bend(tt):
        b = np.zeros_like(tt)
        if meend_from is not None:
            d = meend_from - midi
            b += d * np.clip(1 - tt / meend_time, 0, 1) ** 2
        if andolan:
            b += andolan * np.sin(2 * np.pi * 0.9 * tt) * np.clip((tt - 0.3) / 0.6, 0, 1)
        return b

    y = fl.render(midi, dur, vel, bend=bend, release=0.35, attack=0.07)
    y = lp(y, 5200, 2)
    y = peak_eq(y, 900, 2.5, 0.9)
    n = len(y)
    breath = bp(pink(r, n), 1200, 6000, 2)
    benv = env_points(n, [(0, 0), (0.04, 0.9), (0.25, 0.35), (dur, 0.3), (dur + 0.1, 0.0), (n / SR, 0)])
    y = y + np.stack([breath, breath], axis=1) * benv[:, None] * 0.05 * vel
    return y


def sarangi(midi, dur, r, vel=0.7, glide_from=None, glide_time=0.18):
    sv = lib('solo_vln')

    def bend(tt):
        if glide_from is None:
            return np.zeros_like(tt)
        return (glide_from - midi) * np.clip(1 - tt / glide_time, 0, 1) ** 1.5

    y = sv.render(midi, dur, vel, bend=bend, release=0.4, attack=0.06)
    y = peak_eq(y, 1500, 4, 1.4)
    y = peak_eq(y, 300, -3, 0.8)
    y = lp(y, 6000, 2)
    return y


# -------------------------------------------------------------------- synth
def synth_bass(midi, dur, r, vel=0.8, drive=2.0, cutoff=900):
    f = midi_hz(midi)
    n = secs(dur + 0.08)
    sub = osc(f, n)
    saw = bl_wave(f * 1.003, n, 'saw') + bl_wave(f * 0.997, n, 'saw', 1.3)
    env = env_points(n, [(0, 0), (0.004, 1), (dur * 0.6, 0.85), (dur, 0.75), (dur + 0.08, 0)])
    fenv = cutoff * (0.6 + 2.5 * np.exp(-t_axis(n) / 0.06))
    y = sweep_filter(saw * 0.5, 'lp', fenv, block=64) + sub * 0.8
    return saturate(y * env * vel, drive) * 0.5


def pulse(midi, dur, r, vel=0.6, cutoff=2200):
    f = midi_hz(midi)
    n = secs(dur + 0.15)
    y = bl_wave(f, n, 'saw') + 0.5 * bl_wave(f * 2.004, n, 'square')
    y = sweep_filter(y, 'lp', cutoff * (0.4 + 1.6 * np.exp(-t_axis(n) / 0.05)), block=64)
    return y * env_exp(n, max(0.05, dur * 0.6), 0.002) * vel * 0.25


def braam(midis, dur, r, vel=1.0):
    """Hybrid low brass blast: trombones + tuba + detuned saw stack + sub."""
    n = secs(dur + 1.5)
    out = np.zeros((n, 2))
    for m in midis:
        for inst in ('tbn', 'tuba' if m < 50 else 'horn'):
            try:
                y = lib(inst).render(m, dur, vel, release=1.0, attack=0.02)
                out[:len(y)] += y[:n] * 0.6
            except Exception:  # noqa: BLE001
                pass
        f = midi_hz(m)
        saws = sum(bl_wave(f * (1 + d), n, 'saw', ph) for d, ph in ((-0.008, 0), (0, 2.1), (0.007, 4.2)))
        e = env_points(n, [(0, 0), (0.05, 1), (dur, 0.7), (dur + 1.2, 0), (n / SR, 0)])
        s = sweep_filter(saws, 'lp', 300 + 1800 * np.exp(-t_axis(n) / 0.6), block=128) * e * 0.12
        out += np.stack([s, np.roll(s, 37)], axis=1)
    sub = osc(midi_hz(min(midis)) / 2, n) * env_points(n, [(0, 0), (0.03, 1), (dur, 0.6), (dur + 0.8, 0), (n / SR, 0)]) * 0.35
    out += np.stack([sub, sub], axis=1)
    return saturate(out, 1.5)


def impact(r, size=1.0):
    n = secs(3.5)
    t = t_axis(n)
    sub = osc(55 * np.exp(-t / 0.25) + 28, n) * env_exp(n, 0.9, 0.002)
    body = lp(brown(r, n), 500, 2) * env_exp(n, 0.35, 0.002)
    crack = hp(white(r, n), 1500) * env_exp(n, 0.02)
    y = saturate((sub * 1.2 + body * 0.8 + crack * 0.4) * size, 1.6)
    return np.stack([y, np.roll(y, 23)], axis=1) * 0.7


def riser(seconds, r):
    n = secs(seconds)
    t = t_axis(n)
    nz = white(r, n)
    y = sweep_filter(nz, 'bp', 300 * (30 ** (t / seconds)), block=128) * (t / seconds) ** 2
    tone = osc(110 * 2 ** (2 * t / seconds), n, 'saw')
    tone = lp(tone, 3000) * (t / seconds) ** 3 * 0.15
    y = y + tone
    return np.stack([y, np.roll(y, 211)], axis=1) * 0.5


def reverse_swell(midis, seconds, r):
    """Reversed string chord swell into a downbeat."""
    n = secs(seconds + 2)
    out = np.zeros((n, 2))
    for m in midis:
        y = lib('vln' if m >= 55 else 'vc').render(m, seconds + 1.5, 0.9, release=0.2)
        out[:len(y)] += y[:n]
    out = out[::-1][-secs(seconds):]
    return out * np.linspace(0, 1, len(out))[:, None] ** 2
