# Builds the music bed and the missile-alert tone for the trailer.
#   python tools/bed.py
# Bed: "Noir Now" (Drakensson, CC0) alone, from 10.2 s into the track
# (its build under the hook, its silence under the flak, its hit on the
# title at 9.0). The drum section is lengthened by six of its own 2.400 s
# cycles (a splice at track 40.0 back to 25.6, measured 0.91 correlation),
# and the music stops dead on the downbeat at trailer 49.89: the cliffhanger
# cut to black. Level is matched to draft 2's bed.
# Alert: the game's own missile warning (src/audio/Warnings.js: square wave
# alternating 1450 / 1080 Hz, gated, both rates rising as the missile closes,
# lowpassed at 4 kHz), rendered offline.
import subprocess, numpy as np, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SR = 48000
SRC = os.path.join(ROOT, 'assets', 'music-candidates', '91ce19e8.mp3')
OUT = os.path.join(ROOT, 'assets', 'music', 'bed.wav')
ALERT = os.path.join(ROOT, 'assets', 'sfx', 'missile_alert.wav')

OFFSET = 10.2      # track time at trailer 0
SPLICE = 40.0      # track time where the loop jumps back
LAG = 14.400       # six drum cycles
CUT = 49.89        # trailer time of the hard stop (a downbeat)
DUR = 57.0         # bed length (silence after the cut)
GAIN_DB = None     # None: match draft 2's bed over its first 30 s


def load(path):
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', path, '-ac', '2', '-ar', str(SR), '-f', 'f32le', '-'], capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.float32).reshape(-1, 2).copy()


def write(path, x):
    p = subprocess.run(['ffmpeg', '-y', '-v', 'error', '-f', 'f32le', '-ar', str(SR), '-ac', '2', '-i', '-', '-c:a', 'pcm_s24le', path], input=x.astype(np.float32).tobytes())
    assert p.returncode == 0


def ramp(n):
    return np.linspace(0, 1, n, dtype=np.float32)[:, None]


def bed():
    t = load(SRC)
    s = lambda sec: int(round(sec * SR))
    a = t[s(OFFSET):s(SPLICE)]
    b = t[s(SPLICE - LAG):]
    xf = s(0.015)
    head = a[:-xf]
    joint = a[-xf:] * (1 - ramp(xf)) + b[:xf] * ramp(xf)
    x = np.concatenate([head, joint, b[xf:]])
    n_cut = s(CUT)
    x = x[:n_cut]
    fade = s(0.006)
    x[-fade:] *= (1 - ramp(fade))
    x = np.concatenate([x, np.zeros((s(DUR) - len(x), 2), np.float32)])
    old = os.path.join(ROOT, 'assets', 'music', 'bed-draft2.wav')
    if GAIN_DB is None and os.path.exists(old):
        o = load(old)[:s(30)]
        g = np.sqrt(np.mean(o ** 2) / np.mean(x[:s(30)] ** 2))
    else:
        g = 10 ** ((GAIN_DB or 0) / 20)
    x *= g
    peak = np.abs(x).max()
    if peak > 0.89:
        x *= 0.89 / peak
    write(OUT, x)
    print(f'bed: {len(x) / SR:.2f} s, gain {20 * np.log10(g):+.1f} dB, cut at {CUT}')


def alert(dur=2.3):
    n = int(dur * SR)
    tt = np.arange(n) / SR
    u = tt / dur                                   # urgency 0 -> 1
    alt_hz = 4.5 + 4.0 * u
    gate_hz = 9 + 8 * u
    alt_phase = np.cumsum(alt_hz) / SR
    gate_phase = np.cumsum(gate_hz) / SR
    f = np.where((alt_phase % 1) < 0.5, 1450.0, 1080.0)
    ph = np.cumsum(f) / SR
    sq = np.sign(np.sin(2 * np.pi * ph))
    gate = ((gate_phase % 1) < 0.5).astype(np.float32)
    # soften the gate edges (the game lowpasses its gating LFO)
    k = int(0.003 * SR)
    gate = np.convolve(gate, np.ones(k) / k, mode='same')
    y = sq * gate * 0.35
    # one-pole lowpass at 4 kHz
    a = np.exp(-2 * np.pi * 4000 / SR)
    out = np.empty_like(y)
    acc = 0.0
    for i in range(n):
        acc = (1 - a) * y[i] + a * acc
        out[i] = acc
    st = np.stack([out, out], 1).astype(np.float32)
    write(ALERT, st)
    print(f'alert: {dur} s')


if __name__ == '__main__':
    bed()
    alert()
