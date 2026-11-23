"""Offline DSP toolkit shared by the SFX designer and the music renderer.

Everything here is numpy/scipy; signals are float64 arrays at SR (48 kHz, the
Opus native rate). Mono = shape (n,), stereo = shape (n, 2).
"""
import json
import os
import subprocess

import numpy as np
from scipy import signal

SR = 48000


# --------------------------------------------------------------------- basics
def rng(seed):
    return np.random.default_rng(seed)


def secs(n):
    return int(round(n * SR))


def t_axis(n):
    return np.arange(n) / SR


def white(r, n):
    return r.standard_normal(n)


def colored(r, n, slope_db_per_oct):
    """Noise with a spectral slope (0 white, -3 pink, -6 brown) via FFT shaping."""
    x = r.standard_normal(n)
    X = np.fft.rfft(x)
    f = np.fft.rfftfreq(n, 1 / SR)
    f[0] = f[1]
    X *= (f / 1000.0) ** (slope_db_per_oct / 6.0206)
    y = np.fft.irfft(X, n)
    return y / (np.std(y) + 1e-12)


def pink(r, n):
    return colored(r, n, -3)


def brown(r, n):
    return colored(r, n, -6)


def stereo(l, r_=None):
    if r_ is None:
        r_ = l
    return np.stack([l, r_], axis=1)


def mono(x):
    return x if x.ndim == 1 else x.mean(axis=1)


def pad(x, n):
    if len(x) >= n:
        return x[:n]
    shape = (n - len(x),) + x.shape[1:]
    return np.concatenate([x, np.zeros(shape)])


def mix_at(dst, src, start, gain=1.0):
    """Add src into dst at sample offset start (clipped to dst)."""
    if start >= len(dst):
        return dst
    if start < 0:
        src = src[-start:]
        start = 0
    n = min(len(src), len(dst) - start)
    if dst.ndim == 2 and src.ndim == 1:
        src = np.stack([src, src], axis=1)
    dst[start:start + n] += src[:n] * gain
    return dst


# ------------------------------------------------------------------- filters
def _sos(kind, f, order=2, q=None):
    nyq = SR / 2
    if kind == 'bp' and q is not None:
        bw = f / q
        lo, hi = max(10, f - bw / 2), min(nyq * 0.99, f + bw / 2)
        return signal.butter(order, [lo / nyq, hi / nyq], 'bandpass', output='sos')
    if kind == 'bp':
        return signal.butter(order, [f[0] / nyq, min(f[1], nyq * 0.99) / nyq], 'bandpass', output='sos')
    return signal.butter(order, min(f, nyq * 0.99) / nyq, {'lp': 'lowpass', 'hp': 'highpass'}[kind], output='sos')


def lp(x, f, order=2):
    return signal.sosfilt(_sos('lp', f, order), x, axis=0)


def hp(x, f, order=2):
    return signal.sosfilt(_sos('hp', f, order), x, axis=0)


def bp(x, lo, hi, order=2):
    return signal.sosfilt(_sos('bp', (lo, hi), order), x, axis=0)


def peak_eq(x, f, gain_db, q=1.0):
    """RBJ peaking EQ."""
    A = 10 ** (gain_db / 40)
    w0 = 2 * np.pi * f / SR
    alpha = np.sin(w0) / (2 * q)
    b = [1 + alpha * A, -2 * np.cos(w0), 1 - alpha * A]
    a = [1 + alpha / A, -2 * np.cos(w0), 1 - alpha / A]
    return signal.lfilter(np.array(b) / a[0], np.array(a) / a[0], x, axis=0)


def shelf(x, f, gain_db, kind='low'):
    A = 10 ** (gain_db / 40)
    w0 = 2 * np.pi * f / SR
    alpha = np.sin(w0) / 2 * np.sqrt(2)
    c = np.cos(w0)
    sA = 2 * np.sqrt(A) * alpha
    if kind == 'low':
        b = [A * ((A + 1) - (A - 1) * c + sA), 2 * A * ((A - 1) - (A + 1) * c), A * ((A + 1) - (A - 1) * c - sA)]
        a = [(A + 1) + (A - 1) * c + sA, -2 * ((A - 1) + (A + 1) * c), (A + 1) + (A - 1) * c - sA]
    else:
        b = [A * ((A + 1) + (A - 1) * c + sA), -2 * A * ((A - 1) + (A + 1) * c), A * ((A + 1) + (A - 1) * c - sA)]
        a = [(A + 1) - (A - 1) * c + sA, 2 * ((A - 1) - (A + 1) * c), (A + 1) - (A - 1) * c - sA]
    return signal.lfilter(np.array(b) / a[0], np.array(a) / a[0], x, axis=0)


def resonator(x, f, q):
    """Two-pole resonant bandpass (RBJ constant 0 dB peak)."""
    w0 = 2 * np.pi * f / SR
    alpha = np.sin(w0) / (2 * q)
    b = [alpha, 0, -alpha]
    a = [1 + alpha, -2 * np.cos(w0), 1 - alpha]
    return signal.lfilter(np.array(b) / a[0], np.array(a) / a[0], x, axis=0)


def sweep_filter(x, kind, freqs, block=128, order=2):
    """Time-varying Butterworth filter; `freqs` is an array (per sample) or callable(t)."""
    n = len(x)
    if callable(freqs):
        freqs = freqs(t_axis(n))
    freqs = np.broadcast_to(np.asarray(freqs, dtype=float), (n,))
    out = np.zeros_like(x, dtype=float)
    zi = None
    for s in range(0, n, block):
        e = min(n, s + block)
        f = float(np.clip(freqs[s], 20, SR * 0.45))
        sos = _sos(kind, f if kind != 'bp' else (f / 1.5, f * 1.5), order)
        if zi is None:
            zi = np.zeros((sos.shape[0], 2) + x.shape[1:])
        seg, zi = signal.sosfilt(sos, x[s:e], axis=0, zi=zi)
        out[s:e] = seg
    return out


# ----------------------------------------------------------------- envelopes
def env_exp(n, decay_s, attack_s=0.0):
    t = t_axis(n)
    e = np.exp(-t / max(decay_s, 1e-4))
    if attack_s > 0:
        e *= np.clip(t / attack_s, 0, 1)
    return e


def env_ar(n, attack_s, release_s, hold_s=0.0, curve=1.0):
    t = t_axis(n)
    a = np.clip(t / max(attack_s, 1e-5), 0, 1)
    r = np.clip(1 - (t - attack_s - hold_s) / max(release_s, 1e-5), 0, 1)
    return (a * r) ** curve


def env_points(n, pts):
    """Piecewise-linear envelope from [(t_seconds, value), ...]."""
    ts, vs = zip(*pts)
    return np.interp(t_axis(n), ts, vs)


def fade(x, fin_s=0.002, fout_s=0.01):
    x = x.copy()
    a, b = secs(fin_s), secs(fout_s)
    if a:
        x[:a] *= (np.linspace(0, 1, a) if x.ndim == 1 else np.linspace(0, 1, a)[:, None])
    if b:
        x[-b:] *= (np.linspace(1, 0, b) if x.ndim == 1 else np.linspace(1, 0, b)[:, None])
    return x


def smooth_noise(r, n, rate_hz, smooth=None):
    """Band-limited random control signal in [-1, 1] approx, changes at ~rate_hz."""
    k = max(4, int(n / SR * rate_hz) + 4)
    pts = r.uniform(-1, 1, k)
    xs = np.linspace(0, n, k)
    y = np.interp(np.arange(n), xs, pts)
    return lp(y, rate_hz * 1.5, 2) if smooth is None else y


# ---------------------------------------------------------------- generators
def osc(freq, n, shape='sine', phase0=0.0):
    f = np.broadcast_to(np.asarray(freq, dtype=float), (n,))
    ph = phase0 + 2 * np.pi * np.cumsum(f) / SR
    if shape == 'sine':
        return np.sin(ph)
    if shape == 'saw':
        # PolyBLEP-free but band-limited via additive for low counts is overkill; use naive + LP
        return 2 * ((ph / (2 * np.pi)) % 1.0) - 1
    if shape == 'tri':
        return 2 * np.abs(2 * ((ph / (2 * np.pi)) % 1.0) - 1) - 1
    if shape == 'square':
        return np.sign(np.sin(ph))
    raise ValueError(shape)


def bl_wave(freq, n, shape='saw', phase0=0.0, rolloff=1.0):
    """Band-limited saw/square by additive synthesis (no aliasing), constant pitch.
    rolloff > 1 darkens (amplitudes 1/k^rolloff)."""
    t = t_axis(n)
    kmax = int(SR * 0.45 / max(freq, 1.0))
    y = np.zeros(n)
    w = 2 * np.pi * freq * t + phase0
    ks = range(1, kmax + 1) if shape == 'saw' else range(1, kmax + 1, 2)
    for k in ks:
        y += np.sin(k * w) / k ** rolloff
    return y * (2 / np.pi if shape == 'saw' else 4 / np.pi)


def additive(freq, n, partials, decays=None):
    """Band-limited harmonic stack: partials = [(ratio, amp), ...]."""
    f = np.broadcast_to(np.asarray(freq, dtype=float), (n,))
    ph = 2 * np.pi * np.cumsum(f) / SR
    y = np.zeros(n)
    for i, (ratio, amp) in enumerate(partials):
        if np.max(f) * ratio > SR * 0.45:
            continue
        e = 1.0 if decays is None else np.exp(-t_axis(n) / decays[i])
        y += amp * np.sin(ph * ratio) * e
    return y


def modal(n, modes, r=None, jitter=0.0):
    """Sum of exponentially decaying sines: modes = [(freq, decay_s, amp), ...]."""
    t = t_axis(n)
    y = np.zeros(n)
    for f, d, a in modes:
        if r is not None and jitter:
            f *= 1 + r.uniform(-jitter, jitter)
        if f >= SR * 0.45:
            continue
        ph = 0 if r is None else r.uniform(0, 2 * np.pi)
        y += a * np.sin(2 * np.pi * f * t + ph) * np.exp(-t / d)
    return y


def crackle(r, n, rate, sharp=0.00025, slow=0.0012, alpha=2.2):
    """Jet-noise crackle: sparse, positively skewed pressure spikes (Pareto amplitudes)."""
    out = np.zeros(n)
    count = int(n / SR * rate)
    pos = r.integers(0, n, count)
    amp = np.minimum(r.pareto(alpha, count) + 1, 5.0) * r.choice([1, 1, 1, -0.35], count)
    k = int(SR * (sharp + slow * 4))
    tt = t_axis(k)
    kern = (1 - np.exp(-tt / sharp)) * np.exp(-tt / slow)
    kern /= kern.max()
    np.add.at(out, pos, amp)
    return signal.fftconvolve(out, kern)[:n]


def saturate(x, drive=1.0):
    return np.tanh(x * drive) / np.tanh(drive)


def soft_clip(x, ceiling=0.98):
    return ceiling * np.tanh(x / ceiling)


# -------------------------------------------------------------- spatial/sim
def passby(src, speed, miss, t_closest, n, c=325.0, air=True, height=0.0):
    """
    Physically simulated pass-by of a mono source moving on a straight line at
    `speed` m/s with closest distance `miss` m at receive time ~t_closest.
    Variable propagation delay yields true doppler; 1/r gain; distance lowpass.
    `src` must be long enough (>= n + delay slack).
    """
    # Emission times start `pre` seconds before the output so sound emitted far
    # away is already arriving at t=0 (no silent gap and hard onset).
    assert speed < c, "passby() models subsonic sources (monotonic arrival times)"
    pre = max(0.0, len(src) / SR - n / SR)
    tau = np.arange(len(src)) / SR - pre
    x = (tau - t_closest) * speed
    r = np.sqrt(x * x + miss * miss + height * height)
    arrive = tau + r / c
    t = t_axis(n)
    tau_t = np.interp(t, arrive, tau)                  # emission time for each output sample
    y = np.interp((tau_t + pre) * SR, np.arange(len(src)), src)
    rt = np.interp(t, arrive, r)
    y = y * (miss / np.maximum(rt, miss))
    if air:
        cut = 20000 * (60 / (60 + rt)) ** 0.75
        y = sweep_filter(y, 'lp', np.maximum(cut, 300), block=256)
    return y, rt


# ------------------------------------------------------------------- reverb
def make_ir(seconds, r, decay_s=1.8, damp_hz=(9000, 1200), early=(), predelay=0.012, width=1.0):
    """
    Stereo reverb IR: decorrelated noise with exponential decay whose high
    frequencies die faster (damping sweep), plus optional discrete early
    reflections [(time_s, gain)] — used for the valley-echo character.
    """
    n = secs(seconds)
    out = np.zeros((n, 2))
    for ch in range(2):
        nz = r.standard_normal(n)
        cut = np.geomspace(damp_hz[0], damp_hz[1], n)
        nz = sweep_filter(nz, 'lp', cut, block=512)
        out[:, ch] = nz * np.exp(-t_axis(n) * 6.9 / decay_s)
    if width < 1:
        m = out.mean(axis=1, keepdims=True)
        out = m + (out - m) * width
    pd = secs(predelay)
    out = np.concatenate([np.zeros((pd, 2)), out])[:n]
    for t0, g in early:
        k = secs(t0)
        if k < n:
            burst = lp(r.standard_normal((secs(0.03), 2)), 3000) * env_exp(secs(0.03), 0.008)[:, None]
            mix_at(out, burst, k, g * 4)
    out[:secs(0.0015)] *= np.linspace(0, 1, secs(0.0015))[:, None]
    return out / np.sqrt(np.sum(out ** 2) / 2)


def convolve(x, ir, wet=0.3, dry=1.0):
    xs = x if x.ndim == 2 else np.stack([x, x], axis=1)
    y = np.stack([signal.fftconvolve(xs[:, c], ir[:, c]) for c in range(2)], axis=1)
    y = y[:len(xs) + len(ir) - 1]
    out = np.zeros_like(y)
    out[:len(xs)] += xs * dry
    out += y * wet
    return out


# ------------------------------------------------------------------- loops
def make_loop(x, loop_len, xfade):
    """Fold the material after loop_len back over the start with an equal-power
    crossfade so x[:loop_len] wraps seamlessly. Needs len(x) >= loop_len + xfade."""
    assert len(x) >= loop_len + xfade
    out = x[:loop_len].copy()
    k = np.linspace(0, np.pi / 2, xfade)
    fi, fo = np.sin(k), np.cos(k)
    if x.ndim == 2:
        fi, fo = fi[:, None], fo[:, None]
    out[:xfade] = x[:xfade] * fi + x[loop_len:loop_len + xfade] * fo
    return out


def fold_tail(x, loop_len):
    """Musical loop: add everything after loop_len (reverb/release tails) onto the start."""
    out = x[:loop_len].copy()
    tail = x[loop_len:]
    while len(tail):
        n = min(len(tail), loop_len)
        out[:n] += tail[:n]
        tail = tail[n:]
    return out


def seam_error(x):
    """How discontinuous the wrap point is relative to typical sample deltas."""
    m = mono(x)
    jump = abs(m[0] - m[-1])
    typ = np.median(np.abs(np.diff(m))) + 1e-9
    p95 = np.percentile(np.abs(np.diff(m)), 99.5) + 1e-9
    return float(jump / typ), float(jump / p95)


# ---------------------------------------------------------------- loudness
_K1 = ([1.53512485958697, -2.69169618940638, 1.19839281085285], [1.0, -1.69065929318241, 0.73248077421585])
_K2 = ([1.0, -2.0, 1.0], [1.0, -1.99004745483398, 0.99007225036621])


def lufs(x):
    """ITU-R BS.1770-4 integrated loudness (48 kHz)."""
    xs = x if x.ndim == 2 else x[:, None]
    y = signal.lfilter(*_K2, signal.lfilter(*_K1, xs, axis=0), axis=0)
    blk, hop = secs(0.4), secs(0.1)
    if len(y) < blk:
        y = pad(y, blk)
    zs = []
    for s in range(0, len(y) - blk + 1, hop):
        zs.append(np.sum(np.mean(y[s:s + blk] ** 2, axis=0)))
    zs = np.array(zs)
    L = -0.691 + 10 * np.log10(zs + 1e-20)
    g = zs[L > -70]
    if not len(g):
        return -120.0
    rel = -0.691 + 10 * np.log10(np.mean(g)) - 10
    g2 = zs[(L > -70) & (L > rel)]
    return float(-0.691 + 10 * np.log10(np.mean(g2) + 1e-20))


def true_peak_db(x):
    xs = x if x.ndim == 2 else x[:, None]
    up = signal.resample_poly(xs, 4, 1, axis=0)
    return float(20 * np.log10(np.max(np.abs(up)) + 1e-12))


def peak_db(x):
    return float(20 * np.log10(np.max(np.abs(x)) + 1e-12))


def rms_db(x):
    return float(20 * np.log10(np.sqrt(np.mean(x ** 2)) + 1e-12))


def normalize_peak(x, db=-1.0):
    p = np.max(np.abs(x)) + 1e-12
    return x * (10 ** (db / 20) / p)


def normalize_lufs(x, target):
    return x * 10 ** ((target - lufs(x)) / 20)


def limiter(x, ceiling_db=-1.0, release_s=0.08, lookahead_s=0.003, circular=False):
    """Look-ahead peak limiter (gain computed on 4x-oversampled-ish peaks via abs max window).
    With circular=True the envelope is warmed on the wrapped end so loops stay seamless."""
    xs = x if x.ndim == 2 else x[:, None]
    n = len(xs)
    la = secs(lookahead_s)
    if circular:
        warm = min(n, secs(2.0))
        work = np.concatenate([xs[-warm:], xs])
    else:
        warm = 0
        work = xs
    ceil = 10 ** (ceiling_db / 20) * 0.94  # margin for inter-sample peaks
    from scipy.ndimage import minimum_filter1d, uniform_filter1d
    pk = np.max(np.abs(work), axis=1)
    target = np.minimum(1.0, ceil / np.maximum(pk, 1e-9))
    gmin = minimum_filter1d(target, size=2 * la + 1)
    # release: recover toward 1 exponentially, never above gmin
    a = 1 - np.exp(-1 / (release_s * SR))
    g = np.empty_like(gmin)
    prev = 1.0
    for i, m in enumerate(gmin.tolist()):
        prev = prev + (1.0 - prev) * a
        if m < prev:
            prev = m
        g[i] = prev
    # attack smoothing: a moving average of width la stays <= target (see notes)
    g = uniform_filter1d(g, size=max(1, la))
    y = work * g[:, None]
    y = y[warm:]
    return y if x.ndim == 2 else y[:, 0]


def compressor(x, thresh_db=-18, ratio=3.0, attack_s=0.01, release_s=0.15, makeup_db=0.0, circular=False):
    """Feed-forward RMS-ish bus compressor."""
    xs = x if x.ndim == 2 else x[:, None]
    warm = 0
    work = xs
    if circular:
        warm = min(len(xs), secs(2.0))
        work = np.concatenate([xs[-warm:], xs])
    lvl = np.sqrt(signal.lfilter([1 - np.exp(-1 / (0.005 * SR))], [1, -np.exp(-1 / (0.005 * SR))], np.mean(work ** 2, axis=1)) + 1e-12)
    ldb = 20 * np.log10(lvl)
    over = np.maximum(0, ldb - thresh_db)
    gr = -over * (1 - 1 / ratio)
    # attack/release on gain reduction
    out = np.empty_like(gr)
    aa, ar = np.exp(-1 / (attack_s * SR)), np.exp(-1 / (release_s * SR))
    # vectorised approximation: two-pass filtering
    g_att = signal.lfilter([1 - aa], [1, -aa], gr)
    g_rel = signal.lfilter([1 - ar], [1, -ar], gr)
    out = np.minimum(g_att, g_rel)
    y = work * (10 ** ((out + makeup_db) / 20))[:, None]
    y = y[warm:]
    return y if x.ndim == 2 else y[:, 0]


# ---------------------------------------------------------------------- io
def write_wav(path, x):
    import soundfile as sf
    os.makedirs(os.path.dirname(path), exist_ok=True)
    sf.write(path, np.asarray(x, dtype=np.float32), SR, subtype='FLOAT')


def read_wav(path, sr=SR):
    import soundfile as sf
    x, r = sf.read(path, always_2d=False, dtype='float64')
    if r != sr:
        from math import gcd
        g = gcd(int(r), sr)
        x = signal.resample_poly(x, sr // g, int(r) // g, axis=0)
    return x


LOOP_PAD = 9600  # 200 ms of wrapped context either side of an encoded loop


_AAC = None


def _aac_encoder():
    """Prefer the MediaFoundation AAC encoder (Windows): ffmpeg's native `aac`
    overshoots sharp transients by up to ~7 dB; aac_mf stays within ~0.5 dB."""
    global _AAC
    if _AAC is None:
        enc = subprocess.run(['ffmpeg', '-hide_banner', '-encoders'], capture_output=True, text=True).stdout
        _AAC = 'aac_mf' if ' aac_mf ' in enc else 'aac'
    return _AAC


def _ffmpeg_encode(wav, out_base, channels, kbps_opus, kbps_aac):
    common = ['ffmpeg', '-v', 'error', '-y', '-i', wav, '-ac', str(channels)]
    subprocess.run(common + ['-c:a', 'libopus', '-b:a', f'{kbps_opus}k', '-vbr', 'on',
                             '-application', 'audio', '-frame_duration', '20', out_base + '.webm'], check=True)
    subprocess.run(common + ['-c:a', _aac_encoder(), '-b:a', f'{kbps_aac}k', '-movflags', '+faststart', out_base + '.m4a'], check=True)


def encode(x, out_base, channels, kbps_opus, kbps_aac, loop=False, max_peak_db=-0.5, tmp_dir=None):
    """
    Encode x to <out_base>.webm (Opus) and <out_base>.m4a (AAC).

    Lossy codecs ring at stream edges, so a loop encoded as-is clicks at its
    wrap point. For loops the encoded stream is [last 100 ms | loop | first
    100 ms] and the runtime plays loopStart..loopEnd inside it, so both edges of
    the loop sit in the middle of the stream. Codecs also overshoot on sharp
    transients; the decoded peak is measured and the gain trimmed until it
    stays under max_peak_db.

    Returns (webm_bytes, m4a_bytes, info) with info = {loopStart, loopEnd, gain}.
    """
    os.makedirs(os.path.dirname(out_base), exist_ok=True)
    x = np.asarray(x, dtype=float)
    if loop:
        body = np.concatenate([x[-LOOP_PAD:], x, x[:LOOP_PAD]])
        info = {'loopStart': LOOP_PAD / SR, 'loopEnd': (LOOP_PAD + len(x)) / SR}
    else:
        body = x
        info = {}
    # unique per output: render workers run in parallel
    tmp = os.path.join(tmp_dir or os.path.dirname(out_base), f'_enc_{os.path.basename(out_base)}.wav')
    gain = 1.0
    for _ in range(4):
        write_wav(tmp, body * gain)
        _ffmpeg_encode(tmp, out_base, channels, kbps_opus, kbps_aac)
        pk = max(peak_db(decode(out_base + '.webm')), peak_db(decode(out_base + '.m4a')))
        if pk <= max_peak_db:
            break
        gain *= 10 ** ((max_peak_db - 0.3 - pk) / 20)
    os.remove(tmp)
    info['gain'] = gain
    return os.path.getsize(out_base + '.webm'), os.path.getsize(out_base + '.m4a'), info


def decode(path):
    """Decode any ffmpeg-readable file to float (n, ch) at SR."""
    p = subprocess.run(['ffmpeg', '-v', 'error', '-i', path, '-f', 'f32le', '-ar', str(SR), '-'],
                       capture_output=True, check=True)
    probe = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=channels',
                            '-of', 'json', path], capture_output=True, check=True)
    ch = json.loads(probe.stdout)['streams'][0]['channels']
    return np.frombuffer(p.stdout, dtype=np.float32).reshape(-1, ch).astype(np.float64)
