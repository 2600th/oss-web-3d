"""Air weapons. Generic forms only (no real-world markings beyond the usual
warhead/motor colour bands). Origin = body centre, nose toward -Z (three),
socket `nozzle` at the motor exit (bombs: `tail`)."""
import math

from kit import Asset, Part, mat, emissive, V, M

SEG = 16


def body_profile(L, D, nose_len, nose='dome', tail_taper=0.03, nozzle_r=None):
    """(radius, y) profile from nose (+Y) to tail (-Y)."""
    R = D / 2
    y0, y1 = L / 2, -L / 2
    p = []
    if nose == 'dome':
        # short glass dome on a short cone
        for k in range(5):
            a = math.radians(90 - k * 18)
            p.append((R * 0.92 * math.cos(a), y0 - R * 0.92 * (1 - math.sin(a))))
        p.append((R, y0 - nose_len))
    elif nose == 'ogive':
        n = 7
        for k in range(n + 1):
            t = k / n
            # tangent ogive approx
            r = R * math.sqrt(max(0.0, 1 - (1 - t) ** 2)) ** 1.15
            p.append((max(r, 0.0) if k else 0.0, y0 - nose_len * t))
    elif nose == 'blunt':
        p += [(0.0, y0), (R * 0.55, y0 - 0.005), (R * 0.85, y0 - nose_len * 0.4), (R, y0 - nose_len)]
    p.append((R, y1 + tail_taper * 2))
    p.append((R * 0.88, y1 + 0.004))
    nr = nozzle_r if nozzle_r is not None else R * 0.62
    p.append((nr, y1))
    p.append((nr * 0.85, y1 + 0.06))  # nozzle cavity
    p.append((0.0, y1 + 0.06))
    return p


def segment_mats(profile, nose_mat, body_mat, nozzle_mat, nose_segments):
    n = len(profile) - 1
    mats = []
    for k in range(n):
        if k < nose_segments:
            mats.append(nose_mat)
        elif k >= n - 3:
            mats.append(nozzle_mat)
        else:
            mats.append(body_mat)
    return mats


def _radius_at(prof, y):
    for (r0, y0), (r1, y1) in zip(prof, prof[1:]):
        if min(y0, y1) <= y <= max(y0, y1) and y0 != y1:
            return r0 + (r1 - r0) * (y - y0) / (y1 - y0)
    return max(r for r, _ in prof)


def bands(part, prof, ys, colors, width=0.05, seg=SEG):
    """Colour bands as thin sleeves that follow the body profile (same
    segment count/phase as the lathe so they never saw-tooth through it)."""
    for y, c in zip(ys, colors):
        ra, rb = _radius_at(prof, y + width / 2), _radius_at(prof, y - width / 2)
        part.lathe([(ra * 1.006, y + width / 2), (rb * 1.006, y - width / 2)], mat(c), seg=seg)


def cruciform(part, n, y, root, tip, span, thick, R, m, sweep=0.0, phase=45.0):
    for k in range(n):
        a = phase + k * 360.0 / n
        part.fin(root, tip, span, thick, m, loc=(0, y, 0), rot=(0, a, 0), sweep=sweep, x0=R * 0.96)


def aam_ir():
    A = Asset('aam_ir', 'missile', 'Short-range IR air-to-air missile (R-60-like). Origin at body centre.')
    L, D = 2.09, 0.12
    R = D / 2
    p = Part()
    prof = body_profile(L, D, 0.12, 'dome')
    p.lathe(prof, mat('grey_missile'), seg=SEG, mats=segment_mats(prof, mat('seeker'), mat('white_missile'), mat('nozzle'), 5))
    bands(p, prof, [0.62, -0.25], ['band_yellow', 'band_red'], 0.04)
    # nose destabilisers + canards
    cruciform(p, 4, 0.86, 0.05, 0.03, 0.03, 0.004, R, mat('white_missile'), phase=45)
    cruciform(p, 4, 0.70, 0.16, 0.06, 0.07, 0.006, R, mat('white_missile'), sweep=0.04, phase=45)
    # tail fins
    cruciform(p, 4, -0.86, 0.30, 0.12, 0.135, 0.008, R, mat('white_missile'), sweep=0.10, phase=45)
    # launch shoe
    p.box((0.03, 0.5, 0.02), mat('steel'), loc=(0, 0.05, R + 0.008))
    A.mesh('body', p)
    A.socket('nozzle', (0, -L / 2, 0))
    A.socket('seeker', (0, L / 2, 0))
    return A


def aam_hobs():
    A = Asset('aam_hobs', 'missile', 'High-off-boresight IR missile (R-73-like) with thrust-vector vanes.')
    L, D = 2.90, 0.17
    R = D / 2
    p = Part()
    prof = body_profile(L, D, 0.16, 'dome')
    p.lathe(prof, mat('grey_missile'), seg=SEG, mats=segment_mats(prof, mat('seeker'), mat('white_missile'), mat('nozzle'), 5))
    bands(p, prof, [0.85, -0.40], ['band_yellow', 'band_red'], 0.05)
    cruciform(p, 4, 1.24, 0.05, 0.03, 0.05, 0.005, R, mat('white_missile'), phase=0)       # destabilisers
    cruciform(p, 4, 1.05, 0.26, 0.10, 0.13, 0.008, R, mat('white_missile'), sweep=0.06, phase=0)  # canards
    cruciform(p, 4, -1.12, 0.42, 0.22, 0.19, 0.010, R, mat('white_missile'), sweep=0.12, phase=0)  # tail + ailerons
    # 4 thrust-vector vanes in the jet
    for k in range(4):
        p.box((0.010, 0.10, 0.05), mat('nozzle'), loc=(0, -L / 2 - 0.035, 0), rot=(0, k * 90 + 45, 0))
    p.box((0.035, 0.6, 0.025), mat('steel'), loc=(0, 0.0, R + 0.01))
    A.mesh('body', p)
    A.socket('nozzle', (0, -L / 2 - 0.04, 0))
    A.socket('seeker', (0, L / 2, 0))
    return A


def aam_long():
    A = Asset('aam_long', 'missile', 'Medium-range radar missile (R-77-like) with lattice tail fins.')
    L, D = 3.60, 0.20
    R = D / 2
    p = Part()
    prof = body_profile(L, D, 0.55, 'ogive')
    p.lathe(prof, mat('grey_missile'), seg=SEG, mats=segment_mats(prof, mat('white_missile'), mat('white_missile'), mat('nozzle'), 7))
    bands(p, prof, [0.95, -0.35], ['band_yellow', 'band_red'], 0.05)
    # long low strakes
    cruciform(p, 4, 0.10, 0.95, 0.70, 0.065, 0.008, R, mat('white_missile'), sweep=0.05, phase=45)
    # lattice fins at the tail: frame + grid
    for k in range(4):
        a = 45 + k * 90
        g = Part()
        w, h, d = 0.16, 0.13, 0.05  # span (x), along-axis (y) depth, chord thickness
        x0 = R + 0.005
        t = 0.006
        g.box((w, d, t), mat('white_missile'), loc=(x0 + w / 2, 0, h / 2))
        g.box((w, d, t), mat('white_missile'), loc=(x0 + w / 2, 0, -h / 2))
        g.box((t, d, h), mat('white_missile'), loc=(x0, 0, 0))
        g.box((t, d, h), mat('white_missile'), loc=(x0 + w, 0, 0))
        for i in range(1, 4):
            g.box((0.003, d, h * 1.35), mat('white_missile'), loc=(x0 + w * i / 4, 0, 0), rot=(0, 45, 0))
            g.box((0.003, d, h * 1.35), mat('white_missile'), loc=(x0 + w * i / 4, 0, 0), rot=(0, -45, 0))
        # clip diagonals visually inside the frame by scaling down (cheap): fine at game distances
        g.transform(M((0, -L / 2 + 0.17, 0), (0, a, 0)))
        p.merge(g)
    p.box((0.04, 0.8, 0.025), mat('steel'), loc=(0, 0.0, R + 0.01))
    A.mesh('body', p)
    A.socket('nozzle', (0, -L / 2, 0))
    A.socket('seeker', (0, L / 2, 0))
    return A


def sam():
    A = Asset('sam', 'missile', 'Shoulder-launched SAM round (MANPADS-size). Nose spike, fold-out tail fins.')
    L, D = 1.57, 0.072
    R = D / 2
    p = Part()
    prof = body_profile(L, D, 0.09, 'blunt')
    p.lathe(prof, mat('olive_missile'), seg=12, mats=segment_mats(prof, mat('seeker'), mat('olive_missile'), mat('nozzle'), 3))
    # aerospike tripod (generic needle)
    p.cyl(0.004, 0.11, mat('steel'), loc=(0, L / 2 + 0.05, 0), rot=(-90, 0, 0), seg=6, r2=0.0015)
    bands(p, prof, [0.45, -0.20], ['band_yellow', 'band_red'], 0.03, seg=12)
    cruciform(p, 2, 0.60, 0.06, 0.03, 0.035, 0.004, R, mat('olive_missile'), phase=0)
    cruciform(p, 4, -0.72, 0.10, 0.08, 0.055, 0.003, R, mat('olive_missile'), sweep=0.01, phase=45)
    A.mesh('body', p)
    A.socket('nozzle', (0, -L / 2, 0))
    A.socket('seeker', (0, L / 2, 0))
    return A


def sam_large():
    A = Asset('sam_large', 'missile', 'Vehicle-launched short-range SAM round (SA-8 / SA-13 class, generic).')
    L, D = 3.15, 0.21
    R = D / 2
    p = Part()
    prof = body_profile(L, D, 0.42, 'ogive')
    p.lathe(prof, mat('grey_missile'), seg=SEG, mats=segment_mats(prof, mat('white_missile'), mat('olive_missile'), mat('nozzle'), 7))
    bands(p, prof, [0.80, -0.30], ['band_yellow', 'band_red'], 0.06)
    cruciform(p, 4, 0.95, 0.30, 0.12, 0.16, 0.010, R, mat('olive_missile'), sweep=0.08, phase=45)
    cruciform(p, 4, -1.30, 0.40, 0.18, 0.26, 0.012, R, mat('olive_missile'), sweep=0.14, phase=45)
    A.mesh('body', p)
    A.socket('nozzle', (0, -L / 2, 0))
    A.socket('seeker', (0, L / 2, 0))
    return A


def rocket():
    A = Asset('rocket', 'rocket', 'Unguided 80 mm rocket (S-8-like) with fold-out tail blades (deployed).')
    L, D = 1.57, 0.08
    R = D / 2
    p = Part()
    prof = body_profile(L, D, 0.22, 'ogive')
    p.lathe(prof, mat('olive_missile'), seg=12, mats=segment_mats(prof, mat('olive_missile'), mat('olive_missile'), mat('nozzle'), 7))
    p.cyl(0.008, 0.04, mat('steel'), loc=(0, L / 2 + 0.01, 0), rot=(-90, 0, 0), seg=6)  # fuze tip
    bands(p, prof, [0.45], ['band_red'], 0.03, seg=12)
    for k in range(6):
        a = k * 60
        p.fin(0.035, 0.03, 0.10, 0.003, mat('steel'), loc=(0, -L / 2 + 0.06, 0), rot=(0, a, 0), sweep=0.06, x0=R * 0.9)
    A.mesh('body', p)
    A.socket('nozzle', (0, -L / 2, 0))
    return A


def rocket_pod():
    A = Asset('rocket_pod', 'pod', '20-tube 80 mm rocket pod (B-8-like). Sockets tube_00..19 at the tube mouths, `muzzle` at the face centre.')
    L, D = 2.75, 0.52
    R = D / 2
    p = Part()
    body = mat('olive')
    prof = [(0.0, L / 2), (R * 0.70, L / 2), (R * 0.80, L / 2 - 0.04), (R * 0.97, L / 2 - 0.35), (R, L / 2 - 0.50),
            (R, -L / 2 + 0.40), (R * 0.90, -L / 2 + 0.05), (R * 0.82, -L / 2), (0.0, -L / 2)]
    p.lathe(prof, body, seg=20)
    tubes = []
    for ring, (n, rr) in enumerate(((6, 0.07), (14, 0.155))):
        for k in range(n):
            a = 2 * math.pi * (k + 0.5 * ring) / n
            tubes.append((rr * math.cos(a), rr * math.sin(a)))
    for (x, z) in tubes:
        p.cyl(0.042, 0.012, mat('black'), loc=(x, L / 2 + 0.001, z), rot=(-90, 0, 0), seg=8)
        p.cyl(0.042, 0.012, mat('black'), loc=(x, -L / 2 - 0.001, z), rot=(-90, 0, 0), seg=8)
    p.cyl(0.03, 0.012, mat('black'), loc=(0, L / 2 + 0.001, 0), rot=(-90, 0, 0), seg=8)
    # suspension lugs + strengthening band
    for y in (0.35, -0.35):
        p.box((0.05, 0.08, 0.05), mat('steel'), loc=(0, y, R + 0.02), bevel=0.005)
    p.cyl(R * 1.01, 0.06, mat('steel'), loc=(0, 0.6, 0), rot=(-90, 0, 0), seg=20, cap=False)
    A.mesh('body', p)
    A.socket('muzzle', (0, L / 2, 0))
    for i, (x, z) in enumerate(tubes):
        A.socket(f'tube_{i:02d}', (x, L / 2, z))
    return A


def bomb():
    # [models polish] the game fires a FAB-250; the model was FAB-500 sized
    # (2.47 x 0.40 m, ring tail). FAB-250 M-62: 1.92 m long, 0.30 m body,
    # low-drag ogive and four swept fins with no ring.
    A = Asset('bomb', 'bomb', '250 kg low-drag general-purpose bomb (FAB-250 M-62-like). Socket `tail` at the fin root.')
    L, D = 1.92, 0.30
    R = D / 2
    p = Part()
    prof = [(0.0, L / 2), (R * 0.22, L / 2 - 0.008), (R * 0.52, L / 2 - 0.09), (R * 0.80, L / 2 - 0.26), (R * 0.96, L / 2 - 0.46),
            (R, L / 2 - 0.62), (R, -0.18), (R * 0.88, -0.45), (R * 0.62, -L / 2 + 0.20), (R * 0.42, -L / 2 + 0.04),
            (R * 0.30, -L / 2), (0.0, -L / 2)]
    p.lathe(prof, mat('olive'), seg=20)
    p.cyl(0.028, 0.05, mat('steel'), loc=(0, L / 2 + 0.018, 0), rot=(-90, 0, 0), seg=8)  # nose fuze
    p.cyl(0.03, 0.03, mat('steel'), loc=(0, -L / 2 - 0.012, 0), rot=(-90, 0, 0), seg=8)  # tail fuze
    bands(p, prof, [0.35], ['band_yellow'], 0.05, seg=20)
    # four swept fins on the boat-tail, X pattern; root 0.42 m, tip chord 0.16 m
    for k in range(4):
        p.fin(0.42, 0.16, 0.15, 0.007, mat('olive'), loc=(0, -L / 2 + 0.24, 0), rot=(0, 45 + k * 90, 0), x0=R * 0.55)
    for y in (0.2, -0.2):  # suspension lugs (250 mm spacing)
        p.box((0.03, 0.05, 0.03), mat('steel'), loc=(0, y * 0.625, R + 0.012))
        p.torus(0.022, 0.006, mat('steel'), loc=(0, y * 0.625, R + 0.035), rot=(0, 90, 0), seg=10, rseg=4)
    A.mesh('body', p)
    A.socket('tail', (0, -L / 2, 0))
    A.socket('fuze', (0, L / 2, 0))
    return A


def flare():
    A = Asset('flare', 'flare', '26 mm IR decoy cartridge. `nozzle` is the burning end (aft).')
    p = Part()
    p.cyl(0.013, 0.10, mat('aluminium'), loc=(0, 0, 0), rot=(-90, 0, 0), seg=10)
    p.cyl(0.0135, 0.012, mat('band_red'), loc=(0, 0.05, 0), rot=(-90, 0, 0), seg=10)
    p.cyl(0.011, 0.004, emissive('flare_burn', (1.0, 0.75, 0.4), 6.0), loc=(0, -0.051, 0), rot=(-90, 0, 0), seg=10)
    A.mesh('body', p)
    A.socket('nozzle', (0, -0.05, 0))
    return A


BUILDERS = {
    'aam_ir': (aam_ir, 512), 'aam_hobs': (aam_hobs, 512), 'aam_long': (aam_long, 512), 'sam': (sam, 256),
    'sam_large': (sam_large, 512), 'rocket': (rocket, 256), 'rocket_pod': (rocket_pod, 512), 'bomb': (bomb, 512),
    'flare': (flare, 128),
}
