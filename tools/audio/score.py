"""Safed Sagar — original score, source of truth.

All melodies, harmonies and rhythms here are original to this project.
Home key D minor; Indian colour from the tanpura drone on Sa–Pa (D–A),
bansuri lines with meend (glides) and andolan (slow oscillation), tabla
teentaal / dhol chaal patterns, Kafi (Dorian) inflections in the calm cues
and a Phrygian-dominant edge (Bb over A) in combat.

MAIN THEME ("Safed Sagar", 8 bars, harmony Dm C Dm F | Gm C Am Dm):
    D4:1.5 E4:.5 F4 A4 | G4:3 F4:.5 E4:.5 | D4:1.5 E4:.5 F4 C5 | A4:4 |
    Bb4:1.5 A4:.5 G4 F4 | E4:1.5 F4:.5 G4:2 | A4:1.5 G4:.5 F4 E4 | D4:4

Cues: menu, briefing, cruise, combat_1/2/3 (three intensities of one 32-bar
piece, bit-identical shared parts), ace, victory, defeat, memorial,
sting_complete, sting_failed.
"""
from music import Cue, voicing, root_midi
from sampler import note

THEME = 'D4:1.5 E4:.5 F4 A4 | G4:3 F4:.5 E4:.5 | D4:1.5 E4:.5 F4 C5 | A4:4 | Bb4:1.5 A4:.5 G4 F4 | E4:1.5 F4:.5 G4:2 | A4:1.5 G4:.5 F4 E4 | D4:4'
THEME_HARM = ['Dm', 'C', 'Dm', 'F', 'Gm', 'C', 'Am', 'Dm']
THEME_MAJOR = 'D4:1.5 E4:.5 F#4 A4 | G4:3 F#4:.5 E4:.5 | D4:1.5 E4:.5 F#4 D5 | A4:4 | B4:1.5 A4:.5 G4 F#4 | E4:1.5 F#4:.5 G4:2 | A4:1.5 B4:.5 C#5 E5 | D5:4'
THEME_MAJOR_HARM = ['D', 'G', 'D', 'A', 'G', 'Em', 'A', 'D']


# ---------------------------------------------------------------- helpers
def pad(cue, track, chords, bar0, bars_each, lo, hi, vel=0.5, n=2, attack=0.25, release=0.8, top=True):
    """Sustained chord pad: `n` chord tones from the top (or bottom) of the range."""
    t = cue.tracks[track]
    for i, ch in enumerate(chords):
        v = voicing(ch.split('/')[0], note(lo), note(hi))
        pick = v[-n:] if top else v[:n]
        t.chord(cue.bar(bar0 + i * bars_each), cue.bpb * bars_each, pick, vel, attack=attack, release=release)


def bass_roots(cue, track, chords, bar0, bars_each, octave, vel=0.6, pedal=None, release=0.6):
    t = cue.tracks[track]
    for i, ch in enumerate(chords):
        root = pedal if pedal is not None else root_midi(ch, octave)
        t.note(cue.bar(bar0 + i * bars_each), cue.bpb * bars_each, root, vel, attack=0.08, release=release)


def ostinato(cue, track, chords, bar0, bars_each, octave, pattern, vel=0.7, accents=(), step=0.25):
    """pattern: scale-degree offsets in semitones from the chord root, one per step ('-' = rest)."""
    t = cue.tracks[track]
    b = cue.bar(bar0)
    for ch in chords:
        root = root_midi(ch, octave)
        steps = int(cue.bpb * bars_each / step)
        for s in range(steps):
            p = pattern[s % len(pattern)]
            if p is None:
                continue
            v = vel * (1.15 if (s % len(pattern)) in accents else 0.85)
            t.note(b + s * step, step * 0.9, root + p, min(1, v))
        b += cue.bpb * bars_each


def arp(cue, track, chords, bar0, bars_each, lo, hi, step=0.5, vel=0.45, up_down=True):
    t = cue.tracks[track]
    b = cue.bar(bar0)
    for ch in chords:
        v = voicing(ch.split('/')[0], note(lo), note(hi))
        seqv = v + v[-2:0:-1] if up_down else v
        steps = int(cue.bpb * bars_each / step)
        for s in range(steps):
            t.note(b + s * step, step * 3, seqv[s % len(seqv)], vel * (1.1 if s % 4 == 0 else 0.9), release=1.2)
        b += cue.bpb * bars_each


TEENTAAL = ['dha', 'dhin', 'dhin', 'dha', 'dha', 'dhin', 'dhin', 'dha', 'dha', 'tin', 'tin', 'na', 'na', 'dhin', 'dhin', 'dha']


def teentaal(cue, track, bar0, bars, step=1.0, vel=0.55, fill=False):
    """16-matra theka; `step` beats per matra. Optional 'te te' fills on the last matra."""
    t = cue.tracks[track]
    b = cue.bar(bar0)
    end = cue.bar(bar0 + bars)
    i = 0
    while b < end - 1e-6:
        st = TEENTAAL[i % 16]
        acc = 1.15 if i % 16 == 0 else (0.75 if st in ('tin', 'na') else 1.0)
        t.note(b, step, None, vel * acc, stroke=st)
        if fill and i % 16 == 15:
            t.note(b + step / 2, step / 4, None, vel * 0.6, stroke='te')
            t.note(b + step * 3 / 4, step / 4, None, vel * 0.7, stroke='te')
        b += step
        i += 1


def chaal(cue, track, bar0, bars, vel=0.8):
    """Dhol chaal (8ths): DA . na DA . na DA na — bass on the dotted pulse, cane on the off-beats."""
    t = cue.tracks[track]
    pat = [('dagga', 1.0), (None, 0), ('tilli', 0.6), ('dagga', 0.9), (None, 0), ('tilli', 0.6), ('dagga_m', 0.85), ('tilli', 0.7)]
    for bar in range(bar0, bar0 + bars):
        for k, (s, v) in enumerate(pat):
            if s:
                t.note(cue.bar(bar, k * 0.5), 0.5, None, vel * v, stroke=s)


# ================================================================== MENU
def menu():
    c = Cue('menu', 80, 32, title='Safed Sagar (main theme)', lufs_target=-16, hall=3.0)
    c.track('tanpura', 'tanpura', gain=-13, reverb=0.3)
    c.track('vln', 'vln', gain=-8, pan=-0.35, reverb=0.4, hpf=180)
    c.track('vla', 'vla', gain=-9, pan=0.25, reverb=0.4, hpf=120)
    c.track('vc', 'vc', gain=-8, pan=0.4, reverb=0.35)
    c.track('cb', 'cb', gain=-9, pan=0.5, reverb=0.3, lpf=2500)
    c.track('bansuri', 'bansuri', gain=-3, pan=-0.05, reverb=0.4)
    c.track('harp', 'harp', gain=-12, pan=-0.5, reverb=0.4)
    c.track('horn', 'horn', gain=-7, pan=-0.3, reverb=0.4)
    c.track('tbn', 'tbn', gain=-9, pan=0.3, reverb=0.35)
    c.track('tpt', 'tpt', gain=-8, pan=-0.15, reverb=0.4)
    c.track('vln_lead', 'vln', gain=-5, pan=-0.3, reverb=0.4, hpf=200)
    c.track('timp', 'timp', gain=-6, pan=0.1, reverb=0.3, humanize=0.003)
    c.track('bdrum', 'bdrum', gain=-6, reverb=0.25, humanize=0.003)
    c.track('frame', 'frame', gain=-9, pan=0.2, reverb=0.25, humanize=0.004)
    c.track('tabla', 'tabla', gain=-10, pan=0.15, reverb=0.2, humanize=0.004)
    c.track('cym', 'cym_swell', gain=-12, reverb=0.3)
    c.track('crash', 'crash', gain=-11, reverb=0.4)
    c.track('bells', 'bells_nep', gain=-10, pan=0.35, reverb=0.5)
    c.track('tuba', 'tuba', gain=-11, reverb=0.3, lpf=2000)

    c.tracks['tanpura'].note(0, c.bars * 4, note('D3'), 0.8)
    c.tracks['bells'].note(c.bar(0), 4, None, 0.7)
    c.tracks['bells'].note(c.bar(12), 4, None, 0.5)
    # A: intro (0-3)
    intro = ['Dm', 'Dm', 'Bb', 'C']
    pad(c, 'vla', intro, 0, 1, 'D3', 'A4', 0.35, n=2)
    pad(c, 'vc', intro, 0, 1, 'D2', 'D3', 0.4, n=1, top=False)
    bass_roots(c, 'cb', intro, 0, 1, 1, 0.4)
    # B: bansuri theme (4-11)
    bs = c.tracks['bansuri']
    # theme with ornaments: meend into long notes, andolan at the cadence
    b = c.bar(4)
    for tok, extra in zip(THEME.replace('|', ' ').split(), [
            {}, {}, {}, {'meend_from': note('G4')}, {'meend_from': note('A4')}, {}, {}, {}, {}, {}, {'meend_from': note('A4')},
            {'meend_from': note('C5'), 'andolan': 0.15}, {}, {}, {}, {}, {}, {}, {'meend_from': note('A4')}, {}, {}, {}, {},
            {'meend_from': note('E4'), 'andolan': 0.2}]):
        p, _, d = tok.partition(':')
        d = float(d or 1)
        bs.note(b, d, note(p), 0.72, **extra)
        b += d
    pad(c, 'vla', THEME_HARM, 4, 1, 'D3', 'A4', 0.32, n=2)
    pad(c, 'vc', THEME_HARM, 4, 1, 'C2', 'D3', 0.38, n=1, top=False)
    bass_roots(c, 'cb', THEME_HARM, 4, 1, 1, 0.35)
    arp(c, 'harp', THEME_HARM, 4, 1, 'D3', 'D5', step=0.5, vel=0.4)
    for bar in range(4, 12):
        c.tracks['frame'].note(c.bar(bar), 1, None, 0.45)
        c.tracks['frame'].note(c.bar(bar, 2.5), 1, None, 0.3)
    # C: strings + horns take the theme (12-19)
    c.tracks['vln_lead'].seq(c.bar(12), THEME, 0.55, attack=0.05)
    c.tracks['horn'].seq(c.bar(12), THEME, 0.5, transpose=-12, attack=0.04)
    pad(c, 'vla', THEME_HARM, 12, 1, 'D3', 'A4', 0.45, n=2)
    pad(c, 'vc', THEME_HARM, 12, 1, 'C2', 'D3', 0.5, n=1, top=False)
    bass_roots(c, 'cb', THEME_HARM, 12, 1, 1, 0.45)
    arp(c, 'harp', THEME_HARM, 12, 1, 'D3', 'D5', step=0.5, vel=0.35)
    teentaal(c, 'tabla', 12, 8, step=1.0, vel=0.42)
    for bar in range(12, 20, 2):
        c.tracks['timp'].note(c.bar(bar), 1, None, 0.55)
    c.tracks['cym'].note(c.bar(18), 8, None, 0.7, delay=0.0)
    # D: climax (20-27), brass theme high, big drums
    harm2 = ['Bb', 'C', 'Dm', 'F', 'Gm', 'C', 'A', 'Dm']
    c.tracks['tpt'].seq(c.bar(20), THEME, 0.75, attack=0.02)
    c.tracks['vln_lead'].seq(c.bar(20), THEME, 0.8, transpose=12, attack=0.03)
    c.tracks['horn'].seq(c.bar(20), THEME, 0.75, transpose=-12, attack=0.03)
    pad(c, 'tbn', harm2, 20, 1, 'D2', 'D3', 0.7, n=2)
    pad(c, 'vla', harm2, 20, 1, 'D3', 'A4', 0.7, n=2)
    pad(c, 'vc', harm2, 20, 1, 'C2', 'D3', 0.75, n=1, top=False)
    bass_roots(c, 'cb', harm2, 20, 1, 1, 0.7)
    bass_roots(c, 'tuba', harm2, 20, 1, 1, 0.6)
    for bar in range(20, 28):
        c.tracks['bdrum'].note(c.bar(bar), 1, None, 0.9 if bar % 2 == 0 else 0.7)
        c.tracks['bdrum'].note(c.bar(bar, 2.5), 1, None, 0.6)
        c.tracks['timp'].note(c.bar(bar, 3.5), 0.5, None, 0.5)
    c.tracks['crash'].note(c.bar(20), 4, None, 0.9)
    c.tracks['crash'].note(c.bar(24), 4, None, 0.7)
    teentaal(c, 'tabla', 20, 8, step=0.5, vel=0.5, fill=True)
    # E: release (28-31)
    outro = ['Dm', 'Bb', 'C', 'Dm']
    pad(c, 'vla', outro, 28, 1, 'D3', 'A4', 0.35, n=2)
    pad(c, 'vc', outro, 28, 1, 'C2', 'D3', 0.35, n=1, top=False)
    bass_roots(c, 'cb', outro, 28, 1, 1, 0.3)
    c.tracks['bansuri'].seq(c.bar(29), 'D4:1.5 E4:.5 F4 A4 | G4:4 | r:2', 0.55)
    return c


# ============================================================== BRIEFING
def briefing():
    c = Cue('briefing', 96, 16, title='Briefing', lufs_target=-17, hall=2.4)
    c.track('tanpura', 'tanpura', gain=-15, reverb=0.3)
    c.track('vc_spic', 'vc_spic', gain=-8, pan=0.35, reverb=0.25, humanize=0.004)
    c.track('cb', 'cb', gain=-11, pan=0.45, reverb=0.25, lpf=2000)
    c.track('vln', 'vln', gain=-14, pan=-0.4, reverb=0.5, hpf=300)
    c.track('vla', 'vla', gain=-10, pan=0.2, reverb=0.4)
    c.track('pulse', 'pulse', gain=-17, pan=-0.2, reverb=0.2)
    c.track('tabla', 'tabla', gain=-11, pan=0.1, reverb=0.2, humanize=0.004)
    c.track('harp', 'harp', gain=-14, pan=-0.5, reverb=0.45)
    c.track('timp', 'timp', gain=-9, reverb=0.3)
    grid = ['Dm', 'Dm', 'Bb', 'Bb', 'Gm', 'Gm', 'A', 'A'] * 2
    c.tracks['tanpura'].note(0, c.bars * 4, note('D3'), 0.8)
    ostinato(c, 'vc_spic', grid, 0, 1, 2, [0, None, 0, 12, 0, None, 7, 0], vel=0.45, accents=(0, 3, 6), step=0.5)
    bass_roots(c, 'cb', grid, 0, 1, 1, 0.35)
    for i, ch in enumerate(grid):
        c.tracks['vln'].chord(c.bar(i), 4, voicing(ch, note('A4'), note('A5'))[-1:], 0.3, attack=0.6, release=1.0)
    for bar in range(0, 16):
        for s in range(16):
            ch = grid[bar]
            if s % 4 in (0, 3):
                c.tracks['pulse'].note(c.bar(bar, s * 0.25), 0.2, root_midi(ch, 4) + (12 if s % 8 == 3 else 0), 0.35 + (0.1 if s == 0 else 0))
    teentaal(c, 'tabla', 0, 16, step=1.0, vel=0.45, fill=True)
    c.tracks['vla'].seq(c.bar(8), 'D4:1.5 E4:.5 F4 A4 | G4:4 | F4:1.5 E4:.5 D4 C4 | D4:4', 0.45, attack=0.15)
    c.tracks['vla'].seq(c.bar(12), 'Bb3:1.5 C4:.5 D4 F4 | E4:4 | C#4:2 E4:2 | A3:4', 0.45, attack=0.15)
    for bar in (0, 4, 8, 12):
        c.tracks['timp'].note(c.bar(bar), 1, None, 0.45)
    for bar in range(8, 16):
        c.tracks['harp'].note(c.bar(bar, 0), 1, note('D5'), 0.35)
        c.tracks['harp'].note(c.bar(bar, 1.5), 1, note('A4'), 0.3)
        c.tracks['harp'].note(c.bar(bar, 3), 1, note('F5') if bar % 2 else note('E5'), 0.3)
    return c


# ================================================================ CRUISE
def cruise():
    c = Cue('cruise', 90, 24, title='Over the Ridges (cruise)', lufs_target=-18, hall=3.2)
    c.track('tanpura', 'tanpura', gain=-12, reverb=0.35)
    c.track('vln', 'vln', gain=-12, pan=-0.4, reverb=0.5, hpf=200)
    c.track('vla', 'vla', gain=-11, pan=0.2, reverb=0.45)
    c.track('vc', 'vc', gain=-11, pan=0.4, reverb=0.4)
    c.track('cb', 'cb', gain=-12, pan=0.45, reverb=0.3, lpf=1800)
    c.track('harp', 'harp', gain=-13, pan=-0.45, reverb=0.5)
    c.track('bansuri', 'bansuri', gain=-5, reverb=0.5)
    c.track('frame', 'frame', gain=-13, pan=0.2, reverb=0.3, humanize=0.004)
    c.track('shaker', 'shaker', gain=-19, pan=-0.3, reverb=0.2, humanize=0.006)
    c.track('bells', 'bells_nep', gain=-12, pan=0.4, reverb=0.55)
    grid = ['Dm', 'Dm', 'G', 'G', 'Dm', 'Dm', 'C', 'C', 'Bb', 'Bb', 'G', 'G',
            'Dm', 'Dm', 'F', 'F', 'G', 'G', 'C', 'C', 'Dm', 'Dm', 'Dm', 'Dm']
    c.tracks['tanpura'].note(0, c.bars * 3, note('D3'), 0.8, cycle=5.4)
    pad(c, 'vln', grid[::2], 0, 2, 'A4', 'E5', 0.3, n=1, attack=0.9, release=1.5)
    pad(c, 'vla', grid[::2], 0, 2, 'D3', 'A4', 0.32, n=2, attack=0.8, release=1.5)
    pad(c, 'vc', grid[::2], 0, 2, 'D2', 'D3', 0.32, n=1, top=False, attack=0.6, release=1.5)
    bass_roots(c, 'cb', grid[::2], 0, 2, 1, 0.3, pedal=note('D2'), release=1.2)
    arp(c, 'harp', grid[::2], 0, 2, 'D3', 'E5', step=0.5, vel=0.32)
    bs = c.tracks['bansuri']
    # Kafi/Dorian phrases (B natural), free and spacious
    bs.note(c.bar(4), 2, note('A4'), 0.6, meend_from=note('G4'))
    bs.seq(c.bar(4, 2), 'B4:1 C5:1 | D5:3 C5:1 | B4:1 A4:1 G4:2 | A4:6 r:2', 0.6)
    bs.note(c.bar(10), 3, note('F4'), 0.55, meend_from=note('G4'))
    bs.seq(c.bar(10, 3), 'E4:1 | D4:4 | r:4', 0.55)
    bs.note(c.bar(16), 1.5, note('D5'), 0.6, meend_from=note('C5'))
    bs.seq(c.bar(16, 1.5), 'C5:.5 B4:1 A4:1 | G4:2 A4:2 | F4:1.5 G4:.5 A4:2 | D4:4', 0.6)
    bs.note(c.bar(20), 6, note('A4'), 0.5, meend_from=note('B4'), andolan=0.15)
    for bar in range(0, 24):
        c.tracks['frame'].note(c.bar(bar), 1, None, 0.38)
        if bar % 2:
            c.tracks['frame'].note(c.bar(bar, 2.5), 1, None, 0.25)
        if 4 <= bar < 22:
            for k in range(4):
                c.tracks['shaker'].note(c.bar(bar, k + 0.5), 0.5, None, 0.3)
    c.tracks['bells'].note(c.bar(0), 4, None, 0.55)
    c.tracks['bells'].note(c.bar(12), 4, None, 0.45)
    return c


# ================================================================ COMBAT
COMBAT_GRID = (['Dm', 'Dm', 'Bb', 'Bb', 'C', 'C', 'A', 'A'] * 2
               + ['Dm', 'Dm', 'C', 'C', 'Dm', 'Dm', 'F', 'F'] + ['Gm', 'Gm', 'C', 'C', 'A', 'A', 'Dm', 'Dm'])
THEME_AUG = 'D4:3 E4:1 F4:2 A4:2 | G4:6 F4:1 E4:1 | D4:3 E4:1 F4:2 C5:2 | A4:8 | Bb4:3 A4:1 G4:2 F4:2 | E4:3 F4:1 G4:4 | A4:3 G4:1 F4:2 E4:2 | D4:8'
OST16 = [0, 0, 12, 0, 7, 0, 12, 7, 0, 0, 12, 0, 7, 12, 3, 7]  # 16ths, 3+3+2 feel via accents
OST_ACC = (0, 3, 6, 8, 11, 14)


def combat(level):
    """level 1..3 — the shared parts are seeded identically across the three stems."""
    names = {1: 'combat_1', 2: 'combat_2', 3: 'combat_3'}
    c = Cue(names[level], 140, 32, title=f'Bandits (combat, intensity {level})', seed_group='combat',
            lufs_target={1: -16.5, 2: -16.0, 3: -15.5}[level], group='combat', hall=2.2)
    g = COMBAT_GRID
    # --- shared bed (all levels)
    c.track('tanpura', 'tanpura', gain=-16, reverb=0.25)
    c.track('vln_spic', 'vln_spic', gain=-9, pan=-0.35, reverb=0.25, hpf=200, humanize=0.003)
    c.track('vla_spic', 'vla_spic', gain=-10, pan=0.25, reverb=0.25, humanize=0.003)
    c.track('sbass', 'synth_bass', gain=-11, reverb=0.05, humanize=0.002)
    c.track('hat', 'hat', gain=-17, pan=0.3, reverb=0.1, humanize=0.003)
    c.track('darbuka', 'darbuka', gain=-15, pan=-0.25, reverb=0.15, humanize=0.003)
    c.track('vc', 'vc', gain=-12, pan=0.4, reverb=0.3)
    c.tracks['tanpura'].note(0, c.bars * 4, note('D3'), 0.8, cycle=3.43)
    ostinato(c, 'vln_spic', g, 0, 1, 4, OST16, vel=0.55, accents=OST_ACC)
    ostinato(c, 'vla_spic', g, 0, 1, 3, [7, 0, 7, 12, 7, 0, 7, 3], vel=0.5, accents=(0, 3, 6), step=0.5)
    ostinato(c, 'sbass', g, 0, 1, 1, [0, None, 0, 0, None, 0, 12, 0], vel=0.6, accents=(0, 3, 6), step=0.5)
    pad(c, 'vc', g[::2], 0, 2, 'D2', 'D3', 0.35, n=1, top=False, attack=0.3)
    for bar in range(32):
        c.tracks['hat'].hits(c.bar(bar), 'x.o.x.o.x.o.x.oo' if bar % 4 != 3 else 'x.o.x.o.x.o.xxxx', 0.25)
        c.tracks['darbuka'].hits(c.bar(bar), 'X..x..x.X..x.oxo', 0.25)
    if level >= 2:
        c.track('vc_spic', 'vc_spic', gain=-8, pan=0.4, reverb=0.2, humanize=0.003)
        c.track('cb_spic', 'cb_spic', gain=-9, pan=0.5, reverb=0.15, humanize=0.003)
        c.track('bdrum', 'bdrum', gain=-4, reverb=0.2, humanize=0.002)
        c.track('tom', 'tom', gain=-8, pan=-0.2, reverb=0.25, humanize=0.003)
        c.track('dhol', 'dhol', gain=-10, pan=0.15, reverb=0.15, humanize=0.003)
        c.track('snare', 'snare', gain=-11, pan=0.1, reverb=0.25, humanize=0.003)
        c.track('timp', 'timp', gain=-7, reverb=0.3)
        c.track('horn', 'horn', gain=-7, pan=-0.3, reverb=0.35)
        c.track('horn_stab', 'horn_stac', gain=-9, pan=-0.25, reverb=0.3)
        ostinato(c, 'vc_spic', g, 0, 1, 2, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], vel=0.55, accents=OST_ACC)
        ostinato(c, 'cb_spic', g, 0, 1, 1, [0, None, None, 0, None, None, 0, None], vel=0.65, accents=(0, 3, 6), step=0.5)
        for bar in range(32):
            c.tracks['bdrum'].hits(c.bar(bar), 'X..x..X.x.......' if bar % 2 == 0 else 'X..x..X.X..x..x.', 0.25)
            c.tracks['snare'].hits(c.bar(bar), '....X.......X...', 0.25)
            if bar % 4 == 3:
                c.tracks['tom'].hits(c.bar(bar, 2), 'XxxXxxXX', 0.25)
            if bar % 2 == 0:
                c.tracks['timp'].note(c.bar(bar), 1, None, 0.65 if bar % 8 == 0 else 0.5)
        chaal(c, 'dhol', 0, 32, vel=0.7)
        # horn stabs on the 3+3+2 accents, phrases 1-2
        for i, ch in enumerate(g[:16]):
            for beat in (0, 1.5):
                c.tracks['horn_stab'].chord(c.bar(i, beat), 0.5, voicing(ch, note('D3'), note('C4'))[-2:], 0.7)
        # countermelody, phrase 2 (bars 8-15), horns in their epic low register
        c.tracks['horn'].seq(c.bar(8), 'D3:3 E3:1 F3:2 A3:2 | G3:4 F3:2 E3:2 | Bb3:3 A3:1 G3:2 F3:2 | D3:8 |'
                                       ' C4:3 Bb3:1 A3:2 G3:2 | E3:8 | A3:3 Bb3:1 A3:2 G3:2 | A3:8', 0.6, attack=0.03)
        # theme (augmented) phrases 3-4 in horns
        c.tracks['horn'].seq(c.bar(16), THEME_AUG, 0.7 if level == 2 else 0.85, transpose=-12, attack=0.03)
    if level >= 3:
        c.track('tpt', 'tpt', gain=-6, pan=-0.1, reverb=0.35)
        c.track('tbn', 'tbn', gain=-7, pan=0.3, reverb=0.3)
        c.track('tuba', 'tuba', gain=-10, reverb=0.25, lpf=1800)
        c.track('vln_trem', 'vln_trem', gain=-11, pan=-0.45, reverb=0.35, hpf=300)
        c.track('vln_hi', 'vln', gain=-8, pan=-0.4, reverb=0.35, hpf=300)
        c.track('crash', 'crash', gain=-9, reverb=0.35)
        c.track('cymr', 'cym_roll', gain=-14, reverb=0.3)
        c.track('snare_roll', 'snare_roll', gain=-14, reverb=0.25)
        c.track('braam', 'braam', gain=-12, reverb=0.25)
        c.tracks['sbass'].kw['drive'] = 3.2
        c.tracks['tpt'].seq(c.bar(16), THEME_AUG, 0.85, attack=0.02)
        c.tracks['vln_hi'].seq(c.bar(16), THEME_AUG, 0.8, transpose=12, attack=0.04)
        pad(c, 'tbn', g[::2], 0, 2, 'D2', 'F3', 0.75, n=3, attack=0.05)
        bass_roots(c, 'tuba', g[::2], 0, 2, 1, 0.65)
        pad(c, 'vln_trem', g[::2][:4], 0, 2, 'D5', 'A6', 0.6, n=2, attack=0.2)
        for bar in (0, 8, 16, 24):
            c.tracks['crash'].note(c.bar(bar), 4, None, 0.9)
            c.tracks['cymr'].note(c.bar(bar - 1 if bar else 31, 0), 4, None, 0.7)
            c.tracks['snare_roll'].note(c.bar((bar - 1) % 32, 2), 2, None, 0.6)
        for bar in (0, 16):
            c.tracks['braam'].note(c.bar(bar), 3, None, 0.9, chord=[note('D2'), note('A2'), note('D3')])
        c.tracks['braam'].note(c.bar(28), 3, None, 0.9, chord=[note('A1'), note('E2'), note('A2')])
    return c


# =================================================================== ACE
def ace():
    c = Cue('ace', 150, 24, title='The Ace (named-enemy duel)', lufs_target=-15.5, hall=2.2)
    g = ['Dm', 'Dm', 'Eb', 'Eb', 'Dm', 'Dm', 'Bb', 'A'] * 3
    c.track('vln_spic', 'vln_spic', gain=-9, pan=-0.35, reverb=0.25, hpf=200, humanize=0.003)
    c.track('vc_spic', 'vc_spic', gain=-7, pan=0.4, reverb=0.2, humanize=0.003)
    c.track('cb_spic', 'cb_spic', gain=-8, pan=0.5, reverb=0.15, humanize=0.003)
    c.track('sbass', 'synth_bass', gain=-10, reverb=0.05, kw={'drive': 3.5, 'cutoff': 700})
    c.track('tbn', 'tbn', gain=-5, pan=0.3, reverb=0.3)
    c.track('tuba', 'tuba', gain=-8, reverb=0.25, lpf=1800)
    c.track('horn', 'horn', gain=-6, pan=-0.3, reverb=0.35)
    c.track('tpt', 'tpt', gain=-7, pan=-0.1, reverb=0.35)
    c.track('bdrum', 'bdrum', gain=-4, reverb=0.2, humanize=0.002)
    c.track('tom', 'tom', gain=-7, pan=-0.2, reverb=0.25, humanize=0.003)
    c.track('dhol', 'dhol', gain=-9, pan=0.15, reverb=0.15, humanize=0.003)
    c.track('tabla', 'tabla', gain=-12, pan=-0.15, reverb=0.15, humanize=0.003)
    c.track('snare', 'snare', gain=-10, reverb=0.25, humanize=0.003)
    c.track('timp', 'timp', gain=-6, reverb=0.3)
    c.track('crash', 'crash', gain=-9, reverb=0.35)
    c.track('hat', 'hat', gain=-16, pan=0.3, reverb=0.1, humanize=0.003)
    c.track('impact', 'impact', gain=-8, reverb=0.3)
    c.track('vln_trem', 'vln_trem', gain=-10, pan=-0.45, reverb=0.35, hpf=300)
    # 3+3+2 driving 8ths
    ostinato(c, 'vln_spic', g, 0, 1, 4, [0, 1, 0, 0, 1, 0, 3, 1, 0, 1, 0, 0, 1, 0, 7, 3], vel=0.6, accents=(0, 3, 6, 8, 11, 14))
    ostinato(c, 'vc_spic', g, 0, 1, 2, [0, None, 0, 0, None, 0, 0, None], vel=0.65, accents=(0, 3, 6), step=0.5)
    ostinato(c, 'cb_spic', g, 0, 1, 1, [0, None, None, 0, None, None, 0, None], vel=0.7, accents=(0, 3, 6), step=0.5)
    ostinato(c, 'sbass', g, 0, 1, 1, [0, None, None, 0, None, None, 0, 0], vel=0.7, accents=(0, 3, 6), step=0.5)
    # villain motif: low brass unison (Phrygian), phrase 2; screaming trumpets phrase 3
    motif = 'D3:1.5 Eb3:1.5 D3:1 | A2:3 Bb2:1 | D3:1.5 Eb3:1.5 F3:1 | Eb3:2 D3:2 |'
    c.tracks['tbn'].seq(c.bar(8), motif * 2, 0.85, attack=0.02)
    c.tracks['tuba'].seq(c.bar(8), motif * 2, 0.75, transpose=-12, attack=0.02)
    c.tracks['horn'].seq(c.bar(8), motif * 2, 0.75, attack=0.02)
    c.tracks['tbn'].seq(c.bar(16), motif * 2, 0.9, attack=0.02)
    c.tracks['horn'].seq(c.bar(16), motif * 2, 0.8, attack=0.02)
    c.tracks['tpt'].seq(c.bar(16), 'D5:3 Eb5:1 | D5:2 C5:1 Bb4:1 | A4:4 | r:4 | F5:3 Eb5:1 | D5:2 C5:2 | Bb4:2 A4:2 | A4:4', 0.85, attack=0.02)
    pad(c, 'vln_trem', g[16:], 16, 1, 'D5', 'A6', 0.6, n=2, attack=0.15)
    for bar in range(24):
        c.tracks['bdrum'].hits(c.bar(bar), 'X..X..X.X..X..X.' if bar >= 8 else 'X.....X.X.......', 0.25)
        c.tracks['snare'].hits(c.bar(bar), '....X.......X..x' if bar >= 8 else '........X.......', 0.25)
        c.tracks['hat'].hits(c.bar(bar), 'xoxoxoxoxoxoxoxo', 0.25)
        if bar % 2 == 1:
            c.tracks['tom'].hits(c.bar(bar, 2), 'X.x.XxXX', 0.25)
        if bar % 4 == 0:
            c.tracks['timp'].note(c.bar(bar), 1, None, 0.75)
        for k, st in enumerate(['te', 'te', 'na', 'te', 'te', 'na', 'ge', 'te']):
            c.tracks['tabla'].note(c.bar(bar, k * 0.5), 0.5, None, 0.45, stroke=st)
    chaal(c, 'dhol', 8, 16, vel=0.8)
    for bar in (0, 8, 16):
        c.tracks['crash'].note(c.bar(bar), 4, None, 0.95)
        c.tracks['impact'].note(c.bar(bar), 2, None, 0.8)
    return c


# =============================================================== VICTORY
def victory():
    c = Cue('victory', 100, 12, loop=False, tail=6, title='Victory', lufs_target=-15, hall=2.8)
    for name, inst, gain, pan in [('tpt', 'tpt', -5, -0.1), ('horn', 'horn', -6, -0.3), ('tbn', 'tbn', -7, 0.3),
                                  ('tuba', 'tuba', -10, 0.1), ('vln', 'vln', -6, -0.4), ('vla', 'vla', -8, 0.2),
                                  ('vc', 'vc', -7, 0.4), ('cb', 'cb', -8, 0.5), ('timp', 'timp', -5, 0),
                                  ('timp_roll', 'timp_roll', -7, 0), ('crash', 'crash', -8, 0), ('bdrum', 'bdrum', -5, 0),
                                  ('harp', 'harp', -12, -0.5), ('bansuri', 'bansuri', -6, 0.0), ('dhol', 'dhol', -11, 0.15),
                                  ('chimes', 'chimes', -12, 0.35)]:
        c.track(name, inst, gain=gain, pan=pan, reverb=0.35)
    harm = THEME_MAJOR_HARM + ['Bb', 'C', 'D', 'D']
    c.tracks['tpt'].seq(c.bar(0), THEME_MAJOR, 0.85, attack=0.02)
    c.tracks['vln'].seq(c.bar(0), THEME_MAJOR, 0.75, transpose=12, attack=0.03)
    c.tracks['horn'].seq(c.bar(0), THEME_MAJOR, 0.8, transpose=-12, attack=0.03)
    pad(c, 'tbn', harm[:10], 0, 1, 'D2', 'F#3', 0.75, n=3)
    pad(c, 'vla', harm[:10], 0, 1, 'D3', 'A4', 0.7, n=2)
    bass_roots(c, 'vc', harm[:10], 0, 1, 2, 0.75)
    bass_roots(c, 'cb', harm[:10], 0, 1, 1, 0.7)
    bass_roots(c, 'tuba', harm[:10], 0, 1, 1, 0.6)
    arp(c, 'harp', harm[:8], 0, 1, 'D4', 'D6', step=0.25, vel=0.35, up_down=False)
    # final cadence bVI - bVII - I
    c.tracks['tpt'].seq(c.bar(8), 'D5:2 F5:2 | E5:2 C5:2 | D5:8', 0.9, attack=0.02)
    c.tracks['vln'].seq(c.bar(8), 'F5:4 | G5:4 | A5:8', 0.8, attack=0.04)
    c.tracks['horn'].seq(c.bar(8), 'Bb3:4 | C4:4 | A3:8', 0.85)
    c.tracks['tbn'].chord(c.bar(10), 8, [note('D3'), note('F#3'), note('A3')], 0.85, release=1.5)
    c.tracks['vla'].chord(c.bar(10), 8, [note('D4'), note('F#4')], 0.75, release=1.5)
    c.tracks['vc'].note(c.bar(10), 8, note('D2'), 0.8, release=1.5)
    c.tracks['cb'].note(c.bar(10), 8, note('D1'), 0.8, release=1.5)
    c.tracks['bansuri'].note(c.bar(10), 7, note('A5'), 0.7, meend_from=note('F#5'))
    for bar in range(0, 10):
        c.tracks['bdrum'].note(c.bar(bar), 1, None, 0.8)
        c.tracks['timp'].note(c.bar(bar, 3.5), 0.5, None, 0.55)
    chaal(c, 'dhol', 4, 6, vel=0.65)
    c.tracks['timp_roll'].note(c.bar(10), 6, None, 0.8)
    for bar in (0, 4, 10):
        c.tracks['crash'].note(c.bar(bar), 4, None, 0.95)
    c.tracks['chimes'].note(c.bar(10), 6, note('D4'), 0.6)
    return c


# ================================================================ DEFEAT
def defeat():
    c = Cue('defeat', 66, 8, loop=False, tail=7, title='Mission Failed', lufs_target=-17, hall=3.4)
    c.track('vc', 'vc', gain=-8, pan=0.35, reverb=0.45)
    c.track('vla', 'vla', gain=-10, pan=0.15, reverb=0.45)
    c.track('vln', 'vln', gain=-13, pan=-0.4, reverb=0.55, hpf=250)
    c.track('cb', 'cb', gain=-10, pan=0.45, reverb=0.35, lpf=1600)
    c.track('sarangi', 'sarangi', gain=-6, pan=-0.1, reverb=0.5)
    c.track('gong', 'gong', gain=-12, reverb=0.4)
    c.track('horn', 'horn', gain=-12, pan=-0.3, reverb=0.5)
    harm = ['Dm', 'Bb', 'Gm', 'A', 'Dm', 'Bb', 'Gm', 'A']
    pad(c, 'vla', harm, 0, 1, 'D3', 'A4', 0.4, n=2, attack=0.5, release=1.5)
    pad(c, 'vln', harm, 0, 1, 'D4', 'D5', 0.3, n=1, attack=0.8, release=1.5)
    bass_roots(c, 'vc', harm, 0, 1, 2, 0.45, release=1.5)
    bass_roots(c, 'cb', harm, 0, 1, 1, 0.4, release=1.5)
    c.tracks['gong'].note(0, 4, None, 0.35, layer=0)
    sg = c.tracks['sarangi']
    sg.note(c.bar(1), 1.5, note('D5'), 0.55, glide_from=note('C5'))
    sg.seq(c.bar(1, 1.5), 'E5:.5 F5:1 A5:1 | G5:3 F5:.5 E5:.5 | r:1', 0.5)
    sg.note(c.bar(4, 1), 1.5, note('D5'), 0.45, glide_from=note('E5'))
    sg.seq(c.bar(4, 2.5), 'C5:.5 Bb4:1 | A4:6', 0.45)
    c.tracks['horn'].seq(c.bar(6), 'A2:8', 0.4, attack=0.6)
    return c


# ============================================================== MEMORIAL
def memorial():
    c = Cue('memorial', 60, 20, loop=False, tail=9, title='Remembrance', lufs_target=-17, hall=3.6)
    c.track('tanpura', 'tanpura', gain=-12, reverb=0.35)
    c.track('bansuri', 'bansuri', gain=-3, reverb=0.5)
    c.track('vln', 'vln', gain=-9, pan=-0.35, reverb=0.5, hpf=200)
    c.track('vla', 'vla', gain=-11, pan=0.2, reverb=0.5)
    c.track('vc', 'vc', gain=-10, pan=0.4, reverb=0.45)
    c.track('cb', 'cb', gain=-12, pan=0.45, reverb=0.35, lpf=1500)
    c.track('harp', 'harp', gain=-14, pan=-0.45, reverb=0.55)
    c.track('bells', 'bells_nep', gain=-9, pan=0.3, reverb=0.6)
    c.track('chimes', 'chimes', gain=-16, pan=-0.3, reverb=0.6)
    c.tracks['tanpura'].note(0, 26, note('D3'), 0.8, cycle=6.0)
    c.tracks['bells'].note(c.bar(0), 4, None, 0.6)
    # bansuri: theme, slow and ornamented (bars 2-9)
    bs = c.tracks['bansuri']
    b = c.bar(2)
    orn = [{}, {}, {}, {'meend_from': note('G4')}, {'meend_from': note('A4'), 'andolan': 0.12}, {}, {},
           {}, {}, {}, {'meend_from': note('A4')}, {'meend_from': note('C5'), 'andolan': 0.18},
           {}, {}, {}, {}, {}, {}, {'meend_from': note('A4')}, {}, {}, {}, {}, {'meend_from': note('E4'), 'andolan': 0.22}]
    for tok, extra in zip(THEME.replace('|', ' ').split(), orn):
        p, _, d = tok.partition(':')
        d = float(d or 1)
        bs.note(b, d, note(p), 0.62, **extra)
        b += d
    pad(c, 'vla', THEME_HARM, 2, 1, 'D3', 'A4', 0.3, n=2, attack=0.8, release=1.6)
    pad(c, 'vc', THEME_HARM, 2, 1, 'C2', 'D3', 0.3, n=1, top=False, attack=0.6, release=1.6)
    bass_roots(c, 'cb', THEME_HARM, 2, 1, 1, 0.25, release=1.6)
    # strings take the theme; resolution to D major (bars 10-17)
    harm2 = ['Dm', 'C', 'Dm', 'F', 'Gm', 'C', 'A', 'D']
    c.tracks['vln'].seq(c.bar(10), THEME[:-5] + 'F#4:4', 0.5, attack=0.12)
    pad(c, 'vla', harm2, 10, 1, 'D3', 'A4', 0.4, n=2, attack=0.6, release=1.6)
    pad(c, 'vc', harm2, 10, 1, 'C2', 'D3', 0.4, n=1, top=False, attack=0.5, release=1.6)
    bass_roots(c, 'cb', harm2, 10, 1, 1, 0.3, release=1.6)
    arp(c, 'harp', harm2, 10, 1, 'D3', 'D5', step=1.0, vel=0.3)
    bs.seq(c.bar(14), 'r:2 D5:2 | C5:4 | C#5:2 E5:2 | F#5:4', 0.45)
    # coda (18-19): D major, bell, final bansuri A→D
    c.tracks['vla'].chord(c.bar(18), 8, [note('F#3'), note('A3')], 0.35, attack=1.0, release=3)
    c.tracks['vc'].note(c.bar(18), 8, note('D2'), 0.35, attack=1.0, release=3)
    c.tracks['vln'].note(c.bar(18), 8, note('D5'), 0.3, attack=1.5, release=3)
    bs.note(c.bar(18), 7, note('D5'), 0.5, meend_from=note('A4'), andolan=0.1)
    c.tracks['bells'].note(c.bar(18), 4, None, 0.5)
    c.tracks['chimes'].note(c.bar(19), 6, note('D4'), 0.35)
    return c


# =============================================================== STINGERS
def sting_complete():
    c = Cue('sting_complete', 100, 2, loop=False, tail=5, title='Mission complete (stinger)', lufs_target=-14, hall=2.8)
    for name, inst, gain, pan in [('tpt', 'tpt', -5, -0.1), ('horn', 'horn', -6, -0.3), ('tbn', 'tbn', -7, 0.3),
                                  ('vln', 'vln', -7, -0.4), ('vc', 'vc', -7, 0.4), ('cb', 'cb', -9, 0.5),
                                  ('timp', 'timp', -4, 0), ('crash', 'crash', -7, 0), ('impact', 'impact', -9, 0)]:
        c.track(name, inst, gain=gain, pan=pan, reverb=0.4)
    c.tracks['tpt'].seq(0, 'A4:.5 D5:.5 F#5:.5 A5:6.5', 0.9, attack=0.02)
    c.tracks['horn'].chord(1.5, 6.5, [note('D3'), note('F#3'), note('A3')], 0.85)
    c.tracks['tbn'].chord(1.5, 6.5, [note('D2'), note('A2'), note('F#3')], 0.85)
    c.tracks['vln'].chord(1.5, 6.5, [note('D5'), note('F#5'), note('A5')], 0.8)
    c.tracks['vc'].note(1.5, 6.5, note('D2'), 0.85)
    c.tracks['cb'].note(1.5, 6.5, note('D1'), 0.8)
    c.tracks['timp'].note(1.5, 1, None, 0.9)
    c.tracks['crash'].note(1.5, 4, None, 0.9)
    c.tracks['impact'].note(1.5, 2, None, 0.7)
    return c


def sting_failed():
    c = Cue('sting_failed', 60, 2, loop=False, tail=6, title='Mission failed (stinger)', lufs_target=-16, hall=3.4)
    c.track('horn', 'horn', gain=-7, pan=-0.3, reverb=0.45)
    c.track('tbn', 'tbn', gain=-8, pan=0.3, reverb=0.4)
    c.track('vc', 'vc', gain=-7, pan=0.4, reverb=0.45)
    c.track('cb', 'cb', gain=-9, pan=0.5, reverb=0.4)
    c.track('gong', 'gong', gain=-8, reverb=0.5)
    c.track('timp', 'timp', gain=-6, reverb=0.4)
    c.tracks['horn'].chord(0, 6, [note('D3'), note('F3'), note('A3')], 0.65, attack=0.1, release=2)
    c.tracks['tbn'].chord(0, 6, [note('D2'), note('A2'), note('Eb3')], 0.6, attack=0.1, release=2)
    c.tracks['vc'].note(0, 6, note('D2'), 0.6, attack=0.2, release=2)
    c.tracks['cb'].note(0, 6, note('D1'), 0.6, attack=0.2, release=2)
    c.tracks['gong'].note(0, 4, None, 0.7, layer=1)
    c.tracks['timp'].note(0, 1, None, 0.8)
    return c


CUES = {
    'menu': menu, 'briefing': briefing, 'cruise': cruise,
    'combat_1': lambda: combat(1), 'combat_2': lambda: combat(2), 'combat_3': lambda: combat(3),
    'ace': ace, 'victory': victory, 'defeat': defeat, 'memorial': memorial,
    'sting_complete': sting_complete, 'sting_failed': sting_failed,
}
