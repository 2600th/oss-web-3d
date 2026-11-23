"""Ground units and positions. Generic, unmarked, period-plausible kit for
high-altitude ridge positions. Ground at y = 0 (three), front toward -Z.

Moving parts are mesh nodes whose origin is the pivot:
  turret (yaw about +Y), barrels/barrel/launcher (pitch about +X; +rotation.x = up),
  dish (yaw), rotor / tail_rotor (spin).
"""
import math

import bmesh

import kit
from kit import Asset, Part, mat, emissive, M, V, rng

D2R = math.pi / 180


# ------------------------------------------------------------------ helpers
def wheel(p, r, w, loc, tyre='rubber', hub='olive', seg=14, axis='x'):
    rot = (0, 90, 0) if axis == 'x' else (90, 0, 0)
    p.cyl(r, w, mat(tyre), loc=loc, rot=rot, seg=seg, smooth=True)
    off = V((w / 2 + 0.005, 0, 0)) if axis == 'x' else V((0, w / 2 + 0.005, 0))
    for s in (1, -1):
        p.cyl(r * 0.55, 0.02, mat(hub), loc=tuple(V(loc) + off * s), rot=rot, seg=10)
        p.cyl(r * 0.18, 0.05, mat('steel'), loc=tuple(V(loc) + off * s * 1.2), rot=rot, seg=8)


def sandbag(p, loc, yaw=0.0, size=(0.58, 0.34, 0.15), mname='burlap'):
    p.sphere(1.0, mat(mname), loc=loc, scale=(size[0] / 2, size[1] / 2, size[2] / 2), rot=(0, 0, yaw), seg=8, rings=4)


def sandbag_ring(p, R, courses=2, start=0.0, end=360.0, seed=1, centre=(0, 0), z0=0.0):
    r_ = rng(seed)
    n = max(3, int((end - start) * D2R * R / 0.55))
    for c in range(courses):
        for i in range(n):
            a = (start + (end - start) * (i + 0.5 * (c % 2)) / n) * D2R
            if (c % 2) and i == n - 1 and end - start < 360:
                continue
            x, y = centre[0] + R * math.sin(a), centre[1] + R * math.cos(a)
            sandbag(p, (x, y, z0 + 0.075 + c * 0.14), yaw=-a / D2R + 90 + r_.uniform(-6, 6))


def stone_wall(p, path, height=1.1, thick=0.6, seed=3, mname='stone', course_h=0.22):
    """Dry-stone wall along a polyline [(x, y), ...] built from irregular blocks."""
    r_ = rng(seed)
    for (x0, y0), (x1, y1) in zip(path, path[1:]):
        L = math.hypot(x1 - x0, y1 - y0)
        ang = math.atan2(x1 - x0, y1 - y0)
        ncourse = max(1, int(height / course_h))
        for c in range(ncourse):
            t = 0.0
            taper = 1 - 0.35 * c / max(1, ncourse - 1)
            while t < L:
                sl = r_.uniform(0.28, 0.55)
                sl = min(sl, L - t + 0.05)
                sh = course_h * r_.uniform(0.85, 1.15)
                st = thick * taper * r_.uniform(0.8, 1.0)
                cx = x0 + (x1 - x0) * (t + sl / 2) / L
                cy = y0 + (y1 - y0) * (t + sl / 2) / L
                m = mname if r_.random() > 0.25 else 'stone_dark'
                p.box((st, sl * 0.96, sh), mat(m), loc=(cx, cy, c * course_h + sh / 2),
                      rot=(r_.uniform(-4, 4), r_.uniform(-4, 4), -ang / D2R + r_.uniform(-5, 5)), bevel=0.025)
                t += sl


def crate(p, size, loc, yaw=0.0, mname='crate'):
    p.box(size, mat(mname), loc=loc, rot=(0, 0, yaw), bevel=0.012)
    # rope/handles + battens
    sx, sy, sz = size
    c, s = math.cos(yaw * D2R), math.sin(yaw * D2R)
    for k in (-0.35, 0.35):
        off = V((-s * sy * k, c * sy * k, 0))
        p.box((sx + 0.02, 0.04, sz + 0.02), mat('timber'), loc=tuple(V(loc) + off), rot=(0, 0, yaw))


def drum(p, loc, lying=False, yaw=0.0, mname='drum_green'):
    rot = (90, 0, yaw) if lying else (0, 0, yaw)
    p.cyl(0.29, 0.88, mat(mname), loc=loc, rot=rot, seg=14)
    axis = M(rot=rot).to_3x3() @ V((0, 0, 1))  # the cylinder's own axis
    for k in (-0.29, 0.0, 0.29):  # rolling hoops
        p.cyl(0.298, 0.03, mat(mname), loc=tuple(V(loc) + axis * k), rot=rot, seg=14, cap=False)


def log(p, a, b, r, mname='timber', seg=7):
    a, b = V(a), V(b)
    d = b - a
    L = d.length
    q = d.normalized().to_track_quat('Z', 'Y').to_euler()
    p.cyl(r, L, mat(mname), loc=tuple((a + b) / 2), rot=tuple(x / D2R for x in q), seg=seg)


def rod(p, a, b, r, mname='steel', seg=5):
    log(p, a, b, r, mname, seg)


# ------------------------------------------------------------------ AAA gun
def aaa_gun(destroyed=False):
    A = Asset('aaa_gun_destroyed' if destroyed else 'aaa_gun', 'aaa',
              'Twin 23 mm towed AA gun (ZU-23-2-like) in firing position. turret = yaw, barrels = pitch; '
              'muzzle_L/R on the barrels.')
    A.ground_plane()
    paint = 'olive'
    base = Part()
    # low cruciform carriage on three jacks, wheels raised to the sides
    base.box((1.55, 1.75, 0.16), mat(paint), loc=(0, 0, 0.38), bevel=0.02)
    base.box((0.5, 2.6, 0.12), mat(paint), loc=(0, 0.1, 0.33), bevel=0.02)
    for (x, y) in ((0, 1.35), (0.85, -0.85), (-0.85, -0.85)):
        base.cyl(0.05, 0.36, mat('steel'), loc=(x, y, 0.18), seg=8)
        base.cyl(0.16, 0.04, mat('steel'), loc=(x, y, 0.02), seg=10)
    for s in (1, -1):
        if destroyed and s < 0:
            wheel(base, 0.42, 0.22, (s * 1.25, 0.25, 0.42), axis='x')  # fallen
        else:
            wheel(base, 0.42, 0.22, (s * 1.02, -0.1, 0.62), axis='x')
            base.box((0.3, 0.12, 0.08), mat(paint), loc=(s * 0.85, -0.1, 0.55))
    base.box((0.22, 0.35, 0.06), mat(paint), loc=(0, 1.55, 0.36))  # towing eye
    A.mesh('carriage', base)

    tz = 0.48
    yaw = 35 if destroyed else 0
    tur = Part()
    tur.cyl(0.72, 0.08, mat(paint), loc=(0, 0, tz), seg=20, bevel=0.01)
    for s in (1, -1):
        tur.poly_prism([(-0.45, 0), (0.35, 0), (0.18, 0.55), (-0.25, 0.55)], 0.04, mat(paint),
                       loc=(s * 0.32 - 0.02, 0, tz + 0.04), rot=(90, 0, 90))
        if not (destroyed and s > 0):
            tur.box((0.24, 0.52, 0.36), mat('olive'), loc=(s * 0.6, 0.12, tz + 0.48), bevel=0.015)  # ammo box
            tur.box((0.25, 0.54, 0.04), mat('steel'), loc=(s * 0.6, 0.12, tz + 0.67))
        # gunner seats
        tur.box((0.30, 0.28, 0.05), mat('rubber'), loc=(s * 0.48, -0.62, tz + 0.40), bevel=0.01)
        tur.box((0.30, 0.05, 0.30), mat('rubber'), loc=(s * 0.48, -0.78, tz + 0.55), bevel=0.01)
        tur.box((0.04, 0.3, 0.35), mat('steel'), loc=(s * 0.48, -0.62, tz + 0.2))
        # hand wheels
        tur.torus(0.11, 0.012, mat('steel'), loc=(s * 0.22, -0.42, tz + 0.62), rot=(0, 90, 0), seg=12, rseg=4)
    # sight post
    tur.box((0.05, 0.05, 0.6), mat('steel'), loc=(-0.12, -0.3, tz + 0.35))
    tur.box((0.16, 0.22, 0.14), mat('gunmetal'), loc=(-0.12, -0.28, tz + 0.72), bevel=0.01)
    tur.cyl(0.035, 0.08, mat('glass'), loc=(-0.12, -0.40, tz + 0.74), rot=(-90, 0, 0), seg=8)
    turret = A.mesh('turret', tur, pivot=(0, 0, tz), moving=True)
    turret.rotation_euler.z = yaw * D2R

    pz, py = 0.98, 0.05
    elev = -3 if destroyed else 0
    bar = Part()
    bar.box((0.52, 0.85, 0.18), mat('olive'), loc=(0, 0.05, pz - 0.02), bevel=0.02)  # cradle
    for s in (1, -1):
        bx = s * 0.19
        bar.box((0.15, 1.25, 0.24), mat('gunmetal'), loc=(bx, 0.15, pz + 0.05), bevel=0.015)   # receiver
        if destroyed and s > 0:
            continue
        bar.cyl(0.052, 0.45, mat('gunmetal'), loc=(bx, 0.95, pz + 0.05), rot=(-90, 0, 0), seg=10)  # jacket
        bar.cyl(0.034, 1.75, mat('gunmetal'), loc=(bx, 1.95, pz + 0.05), rot=(-90, 0, 0), seg=8)
        bar.cyl(0.050, 0.24, mat('steel'), loc=(bx, 2.86, pz + 0.05), rot=(-90, 0, 0), seg=10)      # flash hider
        bar.cyl(0.030, 0.02, mat('black'), loc=(bx, 2.985, pz + 0.05), rot=(-90, 0, 0), seg=8)
    bar.box((0.06, 0.6, 0.06), mat('steel'), loc=(0, 0.9, pz + 0.05))  # barrel brace
    barrels = A.mesh('barrels', bar, pivot=(0, py, pz), parent='turret', moving=True)
    barrels.rotation_euler.x = elev * D2R
    A.socket('muzzle_L', (-0.19, 3.0, pz + 0.05), parent='barrels')
    A.socket('muzzle_R', (0.19, 3.0, pz + 0.05), parent='barrels')
    if destroyed:
        debris(A, seed=11, n=10, radius=2.2)
    return A


def debris(A, seed=1, n=10, radius=2.0, mname='olive'):
    r_ = rng(seed)
    d = Part()
    for i in range(n):
        a = r_.uniform(0, 2 * math.pi)
        rr = r_.uniform(0.6, radius)
        s = (r_.uniform(0.08, 0.4), r_.uniform(0.08, 0.5), r_.uniform(0.02, 0.12))
        d.box(s, mat(r_.choice([mname, 'steel', 'stone_dark'])), loc=(rr * math.cos(a), rr * math.sin(a), s[2] / 2),
              rot=(r_.uniform(-20, 20), r_.uniform(-20, 20), r_.uniform(0, 180)))
    A.mesh('debris', d)


# ------------------------------------------------------------------ MANPADS post
def manpads_team():
    A = Asset('manpads_team', 'sam_site', 'Sandbagged MANPADS firing post (no figures): launcher on a rest, spare rounds, '
              'radio. `launcher` = yaw/pitch pivot at the grip; socket `launch` at the tube mouth.')
    A.ground_plane()
    p = Part()
    sandbag_ring(p, 1.5, courses=3, start=-140, end=140, seed=4)
    # ground sheet + crates + radio
    p.box((1.2, 0.8, 0.01), mat('canvas_dark'), loc=(0.2, -0.3, 0.005))
    crate(p, (0.95, 0.32, 0.25), (-0.65, -0.55, 0.125), yaw=25)
    crate(p, (0.95, 0.32, 0.25), (-0.62, -0.62, 0.375), yaw=20)
    p.box((0.28, 0.16, 0.36), mat('olive'), loc=(0.75, -0.65, 0.18), bevel=0.02)   # radio
    p.cyl(0.004, 1.2, mat('black'), loc=(0.82, -0.68, 0.95), seg=5)
    for i in range(2):
        p.cyl(0.05, 1.7, mat('olive_missile'), loc=(-0.9 + i * 0.12, -0.15, 0.05), rot=(-90, 0, 12), seg=10)  # spare tubes
    # rest / bipod
    rod(p, (0.25, 0.65, 0), (0.0, 0.55, 0.78), 0.02)
    rod(p, (-0.25, 0.65, 0), (0.0, 0.55, 0.78), 0.02)
    A.mesh('post', p)
    piv = V((0.0, -0.35, 0.95))
    l = Part()
    elev = 22
    q = M(rot=(elev, 0, 0)).to_3x3()

    def at(v):
        return tuple(piv + q @ V(v))
    l.cyl(0.05, 1.70, mat('olive_missile'), loc=at((0, 0.45, 0)), rot=(-90 + elev, 0, 0), seg=12)
    l.cyl(0.058, 0.12, mat('olive'), loc=at((0, 1.28, 0)), rot=(-90 + elev, 0, 0), seg=12)
    l.cyl(0.058, 0.10, mat('olive'), loc=at((0, -0.38, 0)), rot=(-90 + elev, 0, 0), seg=12)
    l.box((0.05, 0.22, 0.14), mat('olive'), loc=at((0, -0.02, -0.12)), rot=(elev, 0, 0), bevel=0.01)   # grip stock
    l.box((0.12, 0.1, 0.12), mat('olive'), loc=at((0, -0.05, -0.08)), rot=(elev, 0, 0), bevel=0.01)    # battery unit
    l.box((0.03, 0.12, 0.07), mat('gunmetal'), loc=at((-0.07, 0.15, 0.07)), rot=(elev, 0, 0))          # sight
    l.box((0.22, 0.01, 0.12), mat('steel'), loc=at((0.04, 0.35, 0.12)), rot=(elev, 0, 0))              # IFF antenna
    A.mesh('launcher', l, pivot=tuple(piv), moving=True)
    A.socket('launch', at((0, 1.30, 0)), parent='launcher')
    return A


# ------------------------------------------------------------------ tracked SAM launcher
def tracks(p, L, x, z_axle, r_wheel=0.3, width=0.42, n=6):
    """Track run along Y at lateral x. Returns nothing."""
    top = z_axle + r_wheel + 0.04
    bot = 0.04
    p.box((width, L - 0.6, 0.06), mat('steel'), loc=(x, 0, top), bevel=0.01)
    p.box((width, L - 0.9, 0.06), mat('steel'), loc=(x, 0, bot))
    for s in (1, -1):
        p.cyl((top - bot) / 2 + 0.03, width, mat('steel'), loc=(x, s * (L / 2 - 0.42), (top + bot) / 2), rot=(0, 90, 0), seg=14)
    for i in range(n):
        y = -L / 2 + 0.9 + i * (L - 1.8) / (n - 1)
        wheel(p, r_wheel, width * 0.7, (x, y, z_axle), tyre='rubber', hub='olive', seg=12)


def sam_launcher(destroyed=False):
    A = Asset('sam_launcher_destroyed' if destroyed else 'sam_launcher', 'sam_site',
              'Tracked short-range SAM launcher (SA-13 class, generic): turret = yaw, launcher = pitch; '
              'rail_1..4 at the container mouths.')
    A.ground_plane()
    L, W = 6.4, 2.8
    hull = Part()
    paint = 'olive'
    hz = 0.42
    # hull: rectangular box with sloped glacis + raised cab
    hull.poly_prism([(-W / 2 + 0.45, -L / 2), (W / 2 - 0.45, -L / 2), (W / 2 - 0.45, L / 2 - 0.9), (W / 2 - 0.55, L / 2), (-W / 2 + 0.55, L / 2), (-W / 2 + 0.45, L / 2 - 0.9)],
                    0.85, mat(paint), loc=(0, 0, hz), bevel=0.03)
    hull.box((W - 0.9, 1.0, 0.5), mat(paint), loc=(0, L / 2 - 0.7, hz + 0.25), rot=(-35, 0, 0))  # glacis
    hull.box((W, L - 0.4, 0.06), mat(paint), loc=(0, -0.1, hz + 0.82), bevel=0.01)  # track guards
    hull.box((2.0, 1.6, 0.55), mat(paint), loc=(0, 1.75, hz + 1.12), bevel=0.04)  # cab
    for s in (-0.5, 0.5):
        hull.box((0.55, 0.02, 0.28), mat('glass'), loc=(s, 2.56, hz + 1.17), rot=(-12, 0, 0))
    hull.box((0.5, 0.5, 0.06), mat(paint), loc=(0.55, 1.4, hz + 1.42), bevel=0.01)  # hatch
    hull.cyl(0.25, 0.06, mat(paint), loc=(-0.55, 1.4, hz + 1.42), seg=12)
    for s in (1, -1):
        hull.box((0.10, 0.12, 0.12), mat('glass'), loc=(s * 0.95, L / 2 - 0.1, hz + 0.6))  # headlights
        tracks(hull, L, s * (W / 2 - 0.22), 0.34, r_wheel=0.30, width=0.40, n=6)
    hull.box((0.3, 0.12, 0.22), mat('steel'), loc=(1.1, -L / 2 + 0.1, hz + 0.9))  # exhaust box
    for i in range(3):
        hull.box((0.5, 0.35, 0.3), mat('canvas_dark'), loc=(-0.9 + i * 0.12, -2.6 + i * 0.4, hz + 0.98), rot=(0, 0, 8 * i), bevel=0.04)
    if destroyed:
        hull.transform(M(rot=(2.5, -3.0, 0)))
    A.mesh('hull', hull)

    tz = hz + 0.88
    ty = -0.9
    yaw = -50 if destroyed else 0
    t = Part()
    t.cyl(0.85, 0.20, mat(paint), loc=(0, ty, tz + 0.1), seg=20, bevel=0.02)
    t.box((0.9, 1.2, 0.75), mat(paint), loc=(0, ty - 0.05, tz + 0.55), bevel=0.04)
    t.box((0.3, 0.3, 0.28), mat('gunmetal'), loc=(0, ty + 0.45, tz + 1.05))   # sensor head
    t.cyl(0.09, 0.05, mat('glass'), loc=(0, ty + 0.61, tz + 1.05), rot=(-90, 0, 0), seg=10)
    for s in (1, -1):
        t.box((0.12, 0.5, 0.55), mat(paint), loc=(s * 0.55, ty, tz + 0.75), bevel=0.01)  # launcher arms
    turret = A.mesh('turret', t, pivot=(0, ty, tz), moving=True)
    turret.rotation_euler.z = yaw * D2R

    pz = tz + 1.0
    elev = -4 if destroyed else 12
    ln = Part()
    rails = []
    for s in (1, -1):
        for k, z in enumerate((0.0, 0.36)):
            if destroyed and s > 0 and k == 1:
                continue
            x = s * (0.86 + 0.0)
            ln.box((0.34, 2.3, 0.32), mat('olive_missile'), loc=(x, ty + 0.25, pz + z - 0.1), bevel=0.02)
            ln.box((0.30, 0.01, 0.28), mat('black'), loc=(x, ty + 1.405, pz + z - 0.1))
            ln.box((0.36, 0.05, 0.34), mat('steel'), loc=(x, ty - 0.4, pz + z - 0.1))
            ln.box((0.36, 0.05, 0.34), mat('steel'), loc=(x, ty + 0.9, pz + z - 0.1))
            rails.append((x, ty + 1.42, pz + z - 0.1))
        ln.box((0.12, 0.3, 0.75), mat('steel'), loc=(s * 0.66, ty + 0.25, pz + 0.05))
    launcher = A.mesh('launcher', ln, pivot=(0, ty, pz), parent='turret', moving=True)
    launcher.rotation_euler.x = elev * D2R
    for i, r in enumerate(rails):
        A.socket(f'rail_{i + 1}', r, parent='launcher')
    A.socket('exhaust', (1.1, -L / 2 + 0.05, hz + 0.9))
    if destroyed:
        debris(A, seed=21, n=14, radius=4.0)
    return A


# ------------------------------------------------------------------ radar
def radar(destroyed=False):
    A = Asset('radar_destroyed' if destroyed else 'radar', 'radar',
              'Towed surveillance/fire-control radar trailer: `dish` yaws (spin it), socket `feed` at the horn.')
    A.ground_plane()
    p = Part()
    paint = 'olive'
    p.box((2.2, 4.6, 0.25), mat(paint), loc=(0, 0, 0.95), bevel=0.03)
    p.box((0.18, 1.6, 0.12), mat(paint), loc=(0, 3.0, 0.9))  # drawbar
    for y in (1.2, -1.2):
        for s in (1, -1):
            if destroyed and s > 0 and y > 0:
                wheel(p, 0.48, 0.3, (s * 1.25, y, 0.3), axis='x')
            else:
                wheel(p, 0.48, 0.3, (s * 1.25, y, 0.48), axis='x')
    for (x, y) in ((1.6, 2.0), (-1.6, 2.0), (1.6, -2.0), (-1.6, -2.0)):
        rod(p, (x * 0.68, y, 0.95), (x, y, 0.0), 0.05)
        p.box((0.3, 0.3, 0.04), mat('steel'), loc=(x, y, 0.02))
    # equipment cabin at the rear, pedestal at the front
    p.box((2.1, 1.7, 1.5), mat(paint), loc=(0, -1.35, 1.85), bevel=0.04)
    p.box((0.7, 0.04, 1.2), mat('steel'), loc=(0.5, -2.2, 1.75))
    p.box((0.6, 0.5, 0.35), mat('steel'), loc=(-0.6, -1.2, 2.78), bevel=0.02)  # AC unit
    p.cyl(0.35, 0.9, mat(paint), loc=(0, 0.9, 1.5), seg=14, bevel=0.01)
    p.cyl(0.45, 0.1, mat('steel'), loc=(0, 0.9, 1.98), seg=16)
    if destroyed:
        p.transform(M(rot=(0, 4, 0)))
    A.mesh('trailer', p)

    pz = 2.05
    d = Part()
    d.cyl(0.32, 0.5, mat(paint), loc=(0, 0.9, pz + 0.25), seg=14)
    d.box((0.5, 0.5, 0.35), mat(paint), loc=(0, 0.75, pz + 0.55), bevel=0.02)
    # parabolic reflector: an elliptical dish facing +Y, tilted up 12 deg
    tilt = 12
    rw, rh, depth = 2.4, 1.3, 0.45
    seg_u, seg_v = 16, 8
    verts = []
    bm = d.bm
    before = set(bm.faces)
    rows = []
    for j in range(seg_v + 1):
        row = []
        for i in range(seg_u + 1):
            u = (i / seg_u - 0.5) * 2
            v = (j / seg_v - 0.5) * 2
            x, z = u * rw / 2, v * rh / 2
            y = depth * (u * u * 0.85 + v * v * 0.6)
            row.append(V((x, y, z)))
        rows.append(row)
    front = [[bm.verts.new(c) for c in row] for row in rows]
    back = [[bm.verts.new(c + V((0, -0.04, 0))) for c in row] for row in rows]
    for j in range(seg_v):
        for i in range(seg_u):
            bm.faces.new((front[j][i], front[j][i + 1], front[j + 1][i + 1], front[j + 1][i]))
            bm.faces.new((back[j][i], back[j + 1][i], back[j + 1][i + 1], back[j][i + 1]))
    edge = [(0, i) for i in range(seg_u)] + [(j, seg_u) for j in range(seg_v)] + [(seg_v, i) for i in range(seg_u, 0, -1)] + [(j, 0) for j in range(seg_v, 0, -1)]
    for k in range(len(edge)):
        a, b = edge[k], edge[(k + 1) % len(edge)]
        try:
            bm.faces.new((front[a[0]][a[1]], back[a[0]][a[1]], back[b[0]][b[1]], front[b[0]][b[1]]))
        except ValueError:
            pass
    new = [f for f in bm.faces if f not in before]
    bmesh_ops = bmesh.ops
    bmesh_ops.recalc_face_normals(bm, faces=new)
    dm = d._mi(mat('dish'))
    for f in new:
        f.material_index = dm
        f.smooth = True
    dv = list({v for f in new for v in f.verts})
    bmesh_ops.transform(bm, matrix=M((0, 1.05, pz + 1.35), (-tilt, 0, 0)), verts=dv)
    # back frame + feed horn on struts
    d.box((0.12, 0.12, 1.2), mat('steel'), loc=(0, 0.95, pz + 1.0))
    feed = V((0, 1.05 + 1.25, pz + 1.35 + 0.27))
    for s in (1, -1):
        rod(d, (s * 0.9, 1.2, pz + 1.35), tuple(feed), 0.025)
    rod(d, (0, 1.25, pz + 1.92), tuple(feed), 0.025)
    d.box((0.18, 0.22, 0.14), mat('gunmetal'), loc=tuple(feed), rot=(-tilt, 0, 0))
    # small IFF bar on top
    d.box((1.6, 0.06, 0.12), mat('steel'), loc=(0, 0.95, pz + 2.1))
    if destroyed:
        d.transform(M(rot=(-28, 10, 0)), verts=None)
        d.transform(M((0.3, 0.6, -0.9)))
    dish = A.mesh('dish', d, pivot=(0, 0.9, pz), moving=True)
    A.socket('feed', tuple(feed), parent='dish')
    if destroyed:
        debris(A, seed=31, n=12, radius=3.5)
    return A


# ------------------------------------------------------------------ trucks
def truck(covered=False, destroyed=False):
    name = 'truck_covered' if covered else 'truck'
    if destroyed:
        name += '_destroyed'
    A = Asset(name, 'vehicle', '6x6 military cargo truck (Ural-class, generic)' + (' with canvas tilt' if covered else ', open bed') +
              '. Socket `exhaust`.')
    A.ground_plane()
    paint = 'olive'
    p = Part()
    r = 0.54
    wz = r
    # chassis rails
    for s in (1, -1):
        p.box((0.16, 6.6, 0.22), mat('steel'), loc=(s * 0.45, -0.1, 0.95))
    # wheels
    for y in (2.55, -0.95, -2.35):
        for s in (1, -1):
            if destroyed and y < 0 and s > 0 and y > -2:
                continue
            wheel(p, r, 0.38, (s * 1.0, y, wz), axis='x', seg=16)
        p.box((1.8, 0.14, 0.14), mat('steel'), loc=(0, y, wz))
    # front: bumper, hood, grille, fenders
    p.box((2.35, 0.18, 0.25), mat('steel'), loc=(0, 3.75, 0.85), bevel=0.02)
    p.box((1.3, 1.4, 0.75), mat(paint), loc=(0, 3.0, 1.45), bevel=0.06, taper=(0.92, 0.95))
    p.box((1.1, 0.04, 0.6), mat('black'), loc=(0, 3.71, 1.42))
    for s in (1, -1):
        p.box((0.55, 1.4, 0.06), mat(paint), loc=(s * 0.98, 2.75, 1.22), rot=(0, s * -8, 0), bevel=0.02)
        p.box((0.05, 0.9, 0.45), mat(paint), loc=(s * 1.24, 2.95, 1.0))
        p.cyl(0.11, 0.06, mat('glass'), loc=(s * 0.82, 3.72, 1.25), rot=(-90, 0, 0), seg=10)  # headlights
    # cab
    p.box((2.3, 1.55, 1.25), mat(paint), loc=(0, 1.55, 1.85), bevel=0.06, taper=(0.98, 0.9))
    p.box((1.95, 0.05, 0.55), mat('glass'), loc=(0, 2.31, 2.12), rot=(-8, 0, 0))
    for s in (1, -1):
        p.box((0.05, 0.8, 0.45), mat('glass'), loc=(s * 1.15, 1.7, 2.1))
        p.box((0.05, 0.25, 0.2), mat('steel'), loc=(s * 1.32, 2.2, 2.05))   # mirror
        p.box((0.5, 0.6, 0.12), mat('steel'), loc=(s * 1.3, 1.5, 0.75))     # step
    p.cyl(0.29, 1.1, mat('drum_green'), loc=(-0.95, 0.4, 1.0), rot=(90, 0, 0), seg=12)  # fuel tank
    p.cyl(0.06, 1.2, mat('steel'), loc=(1.15, 0.85, 2.5), seg=8)  # exhaust stack
    wheel(p, r, 0.38, (0.0, 0.62, 1.55), axis='y', seg=16)  # spare wheel behind the cab
    # cargo bed
    by0, by1 = 0.35, -3.7
    bl = by0 - by1
    bz = 1.4
    p.box((2.4, bl, 0.1), mat('timber'), loc=(0, (by0 + by1) / 2, bz))
    for s in (1, -1):
        p.box((0.06, bl, 0.6), mat(paint), loc=(s * 1.2, (by0 + by1) / 2, bz + 0.35))
    p.box((2.4, 0.06, 0.6), mat(paint), loc=(0, by0, bz + 0.35))
    p.box((2.4, 0.06, 0.6), mat(paint), loc=(0, by1, bz + 0.35))
    if covered:
        # tilt: bows + canvas as a closed rounded hood
        # canvas tilt: straight sides rising 1.05 m from the bed, arched roof
        arch = [(1.22 * math.cos(math.pi * k / 8), 1.05 + 0.55 * math.sin(math.pi * k / 8)) for k in range(9)]
        poly = [(1.22, 0.0)] + arch + [(-1.22, 0.0)]
        p.poly_prism(poly, bl - 0.02, mat('canvas'), loc=(0, by0 - 0.01, bz + 0.05), rot=(90, 0, 0))
        for k in range(4):  # bows showing through as ribs
            y = by0 - 0.3 - k * (bl - 0.6) / 3
            p.box((2.48, 0.06, 0.04), mat('canvas_dark'), loc=(0, y, bz + 1.66))
    else:
        # some cargo
        crate(p, (0.95, 0.5, 0.4), (-0.5, -1.2, bz + 0.25), yaw=0)
        crate(p, (0.95, 0.5, 0.4), (0.55, -1.1, bz + 0.25), yaw=5)
        drum(p, (0.6, -2.8, bz + 0.49))
        drum(p, (-0.3, -2.9, bz + 0.49))
    if destroyed:
        p.transform(M(rot=(-3.5, 4.0, 0)), verts=None)
        p.transform(M((0, 0, -0.12)))
    A.mesh('body', p)
    A.socket('exhaust', (1.15, 0.85, 3.1))
    if destroyed:
        debris(A, seed=41, n=12, radius=4.5)
    return A


# ------------------------------------------------------------------ positions
def sangar():
    A = Asset('sangar', 'position', 'Dry-stone sangar (C-shaped fighting position, open to the rear) with sandbag topping.')
    A.ground_plane()
    p = Part()
    pts = []
    R = 2.1
    for k in range(11):
        a = (-130 + 26 * k) * D2R
        pts.append((R * math.sin(a), R * math.cos(a)))
    stone_wall(p, pts, height=1.05, thick=0.7, seed=5)
    for k in range(9):
        a = (-100 + 25 * k) * D2R
        sandbag(p, ((R - 0.05) * math.sin(a), (R - 0.05) * math.cos(a), 1.12), yaw=-a / D2R + 90)
    p.box((1.4, 0.9, 0.01), mat('canvas_dark'), loc=(0.2, 0.2, 0.005))
    crate(p, (0.6, 0.35, 0.3), (-1.0, -0.2, 0.15), yaw=40)
    A.mesh('walls', p)
    A.socket('gunner', (0, 1.2, 0.9))
    return A


def bunker(destroyed=False):
    A = Asset('bunker_destroyed' if destroyed else 'bunker', 'position',
              'Stone-and-timber ridge bunker with log roof, earth/stone cover and a firing slit facing -Z.')
    A.ground_plane()
    p = Part()
    W, Lb, H = 4.2, 3.4, 1.15
    rect = [(-W / 2, -Lb / 2), (-W / 2, Lb / 2), (W / 2, Lb / 2), (W / 2, -Lb / 2)]
    # front wall in two parts with a slit between
    stone_wall(p, [(-W / 2, Lb / 2), (-0.55, Lb / 2)], H, 0.7, seed=7)
    stone_wall(p, [(0.55, Lb / 2), (W / 2, Lb / 2)], H, 0.7, seed=8)
    p.box((1.1, 0.7, 0.35), mat('stone'), loc=(0, Lb / 2, 0.17), bevel=0.03)  # slit sill
    stone_wall(p, [(W / 2, Lb / 2), (W / 2, -Lb / 2)], H, 0.7, seed=9)
    stone_wall(p, [(-W / 2, -Lb / 2), (-W / 2, Lb / 2)], H, 0.7, seed=10)
    stone_wall(p, [(W / 2, -Lb / 2), (-0.5, -Lb / 2)], H, 0.7, seed=12)
    p.box((W - 0.5, Lb - 0.5, 0.02), mat('stone_dark'), loc=(0, 0, 0.01))  # interior floor (dark)
    p.box((1.1, 0.5, 0.9), mat('black'), loc=(0, Lb / 2 - 0.25, 0.75))  # dark interior behind slit
    if not destroyed:
        # log roof + earth cover
        for i in range(9):
            y = -Lb / 2 - 0.2 + i * (Lb + 0.4) / 8
            log(p, (-W / 2 - 0.3, y, H + 0.12), (W / 2 + 0.3, y, H + 0.12), 0.12)
        p.box((W + 0.7, Lb + 0.7, 0.35), mat('stone'), loc=(0, 0, H + 0.42), bevel=0.25, seg=2, taper=(0.85, 0.85))
        r_ = rng(13)
        for i in range(24):
            sz = r_.uniform(0.18, 0.4)
            p.box((sz, sz * 1.2, sz * 0.6), mat(r_.choice(['stone', 'stone_dark'])), loc=(r_.uniform(-W / 2, W / 2), r_.uniform(-Lb / 2, Lb / 2), H + 0.62),
                  rot=(r_.uniform(-10, 10), r_.uniform(-10, 10), r_.uniform(0, 180)), bevel=0.03)
        for k in range(6):
            sandbag(p, (-1.0 + k * 0.4, Lb / 2 + 0.2, H + 0.65), yaw=90)
    else:
        r_ = rng(14)
        for i in range(5):
            y = r_.uniform(-Lb / 2, Lb / 2)
            log(p, (-W / 2 + r_.uniform(0, 1), y, H * r_.uniform(0.2, 0.9)), (W / 2 - r_.uniform(0, 1), y + r_.uniform(-0.8, 0.8), r_.uniform(0.1, 0.5)), 0.12)
        for i in range(30):
            sz = r_.uniform(0.18, 0.45)
            p.box((sz, sz * 1.2, sz * 0.6), mat(r_.choice(['stone', 'stone_dark'])), loc=(r_.uniform(-W / 2, W / 2), r_.uniform(-Lb / 2, Lb / 2), r_.uniform(0.1, 0.5)),
                  rot=(r_.uniform(-30, 30), r_.uniform(-30, 30), r_.uniform(0, 180)), bevel=0.03)
    A.mesh('structure', p)
    A.socket('slit', (0, Lb / 2 + 0.35, 0.75))
    if destroyed:
        debris(A, seed=15, n=8, radius=3.5, mname='stone')
    return A


def tent():
    A = Asset('tent', 'camp', 'Ridge tent (4 x 3 m) with guy lines and stone-weighted skirt.')
    A.ground_plane()
    p = Part()
    W, L, H = 3.0, 4.0, 2.0
    # canvas: closed prism (gable) - two-sided by construction
    tri = [(-W / 2, 0.0), (W / 2, 0.0), (0.0, H)]
    p.poly_prism(tri, L, mat('canvas'), loc=(0, L / 2, 0), rot=(90, 0, 0))
    p.box((0.9, 0.02, 1.4), mat('canvas_dark'), loc=(0, L / 2 + 0.01, 0.7), taper=(0.3, 1))  # door flap
    log(p, (0, L / 2 + 0.1, 0), (0, L / 2 + 0.1, H + 0.15), 0.035)
    log(p, (0, -L / 2 - 0.1, 0), (0, -L / 2 - 0.1, H + 0.15), 0.035)
    log(p, (0, -L / 2 - 0.1, H + 0.02), (0, L / 2 + 0.1, H + 0.02), 0.03)
    for y in (-1.6, 0.0, 1.6):
        for s in (1, -1):
            rod(p, (s * W * 0.3, y, H * 0.6), (s * (W / 2 + 1.0), y, 0.02), 0.008, 'canvas_dark', 4)
            p.cyl(0.02, 0.2, mat('timber'), loc=(s * (W / 2 + 1.0), y, 0.08), rot=(0, s * -20, 0), seg=5)
    r_ = rng(17)
    for i in range(16):
        s = 1 if i % 2 else -1
        y = -L / 2 + 0.2 + (i // 2) * (L - 0.4) / 7
        sz = r_.uniform(0.15, 0.3)
        p.box((sz, sz * 1.3, sz * 0.7), mat('stone'), loc=(s * (W / 2 + 0.05), y, sz * 0.3), rot=(0, 0, r_.uniform(0, 90)), bevel=0.03)
    A.mesh('tent', p)
    return A


def supply_dump():
    A = Asset('supply_dump', 'camp', 'Supply dump: ammunition crates, 200 L fuel drums, jerrycans, tarp stack and a camouflage net on poles.')
    A.ground_plane()
    p = Part()
    r_ = rng(19)
    # crate stacks
    for row in range(2):
        for col in range(3):
            for lvl in range(3 - (col + row) % 2):
                crate(p, (1.0, 0.45, 0.32), (-2.6 + col * 1.05, 1.4 - row * 0.5, 0.16 + lvl * 0.32), yaw=r_.uniform(-3, 3))
    # drums
    for i in range(7):
        x, y = 1.2 + (i % 4) * 0.62, 1.2 - (i // 4) * 0.62
        drum(p, (x, y, 0.44), mname='drum_green' if i % 3 else 'drum_blue')
    drum(p, (2.0, -1.0, 0.29), lying=True, yaw=70)
    drum(p, (2.6, -0.6, 0.29), lying=True, yaw=95)
    # jerrycans
    for i in range(5):
        p.box((0.17, 0.35, 0.47), mat('olive'), loc=(-0.6 + i * 0.2, -1.3, 0.235), rot=(0, 0, r_.uniform(-6, 6)), bevel=0.02)
    # tarp-covered stack
    p.box((1.6, 1.2, 1.0), mat('canvas_dark'), loc=(-1.9, -1.4, 0.5), bevel=0.15, seg=2, taper=(0.9, 0.9))
    # camouflage net on 4 poles (two-sided sheet, sagging)
    poles = [(-3.4, 2.4), (3.4, 2.4), (3.4, -2.3), (-3.4, -2.3)]
    for (x, y) in poles:
        log(p, (x, y, 0), (x, y, 2.3), 0.04)
    nb = p.bm
    before = set(nb.faces)
    nx, ny = 10, 7
    grid = []
    for j in range(ny + 1):
        row = []
        for i in range(nx + 1):
            u, v = i / nx, j / ny
            x, y = -3.4 + 6.8 * u, -2.3 + 4.7 * v
            sag = 0.55 * math.sin(math.pi * u) * math.sin(math.pi * v)
            z = 2.3 - sag + r_.uniform(-0.06, 0.06)
            row.append(nb.verts.new((x, y, z)))
        grid.append(row)
    for j in range(ny):
        for i in range(nx):
            nb.faces.new((grid[j][i], grid[j][i + 1], grid[j + 1][i + 1], grid[j + 1][i]))
    top = [f for f in nb.faces if f not in before]
    # duplicate as the underside (two-sided)
    dup = bmesh.ops.duplicate(nb, geom=top)
    under = [g for g in dup['geom'] if isinstance(g, type(top[0]))]
    bmesh.ops.reverse_faces(nb, faces=under)
    for v in {v for f in under for v in f.verts}:
        v.co.z -= 0.01
    mi = p._mi(mat('net'))
    for f in top + under:
        f.material_index = mi
    A.mesh('dump', p)
    return A


def artillery(destroyed=False):
    A = Asset('artillery_destroyed' if destroyed else 'artillery', 'artillery',
              'Towed 122 mm howitzer (D-30 class, generic) emplaced on three trails. turret = yaw, barrel = pitch, socket `muzzle`.')
    A.ground_plane()
    paint = 'olive'
    p = Part()
    p.cyl(0.35, 0.45, mat(paint), loc=(0, 0, 0.22), seg=14, bevel=0.02)  # firing pedestal
    for k, a in enumerate((180, 60, -60)):
        ra = a * D2R
        end = V((3.2 * math.sin(ra), 3.2 * math.cos(ra), 0.12))
        if destroyed and k == 1:
            end = V((2.4 * math.sin(ra + 0.4), 2.4 * math.cos(ra + 0.4), 0.3))
        log(p, (0, 0, 0.35), tuple(end), 0.09, paint, 8)
        p.box((0.35, 0.35, 0.08), mat('steel'), loc=tuple(end - V((0, 0, 0.08))), rot=(0, 0, -a))
    A.mesh('trails', p)
    tz = 0.5
    yaw = 25 if destroyed else 0
    t = Part()
    t.cyl(0.5, 0.12, mat(paint), loc=(0, 0, tz), seg=16)
    for s in (1, -1):
        t.poly_prism([(-0.5, 0), (0.6, 0), (0.25, 0.75), (-0.3, 0.75)], 0.05, mat(paint), loc=(s * 0.32, 0, tz + 0.06), rot=(90, 0, 90))
        if not (destroyed and s > 0):
            wheel(t, 0.55, 0.28, (s * 1.0, -0.2, 0.75), axis='x', seg=16)   # wheels raised in action
        t.box((0.6, 0.12, 0.1), mat('steel'), loc=(s * 0.65, -0.2, 0.75))
    t.box((2.0, 0.05, 0.9), mat(paint), loc=(0, 0.55, tz + 0.75), rot=(-8, 0, 0), bevel=0.01)  # shield
    turret = A.mesh('turret', t, pivot=(0, 0, tz), moving=True)
    turret.rotation_euler.z = yaw * D2R
    pz = tz + 0.85
    elev = -3 if destroyed else 8
    b = Part()
    b.box((0.42, 1.5, 0.42), mat(paint), loc=(0, -0.15, pz), bevel=0.03)            # cradle/breech
    b.box((0.36, 0.5, 0.36), mat('gunmetal'), loc=(0, -1.0, pz), bevel=0.02)        # breech block
    for s in (1, -1):
        b.cyl(0.07, 1.6, mat(paint), loc=(s * 0.14, 0.6, pz + 0.27), rot=(-90, 0, 0), seg=10)  # recuperators
    b.lathe([(0.0, 4.4), (0.075, 4.4), (0.075, 4.38), (0.09, 4.3), (0.085, 3.0), (0.11, 1.0), (0.14, 0.4), (0.14, 0.2), (0.0, 0.2)],
            mat('gunmetal'), seg=12, loc=(0, 0, pz))
    b.box((0.36, 0.42, 0.26), mat('gunmetal'), loc=(0, 4.55, pz), bevel=0.03)        # muzzle brake
    b.box((0.30, 0.02, 0.18), mat('black'), loc=(0, 4.765, pz))
    barrel = A.mesh('barrel', b, pivot=(0, 0.1, pz), parent='turret', moving=True)
    barrel.rotation_euler.x = elev * D2R
    A.socket('muzzle', (0, 4.75, pz), parent='barrel')
    if destroyed:
        debris(A, seed=51, n=10, radius=3.0)
    return A


def helipad():
    A = Asset('helipad', 'base', 'Forward helipad: 20 m gravel disc with painted stone circle and H, windsock.')
    p = Part()
    p.cyl(10.0, 0.06, mat('concrete'), loc=(0, 0, 0.03), seg=40)
    r_ = rng(23)
    for k in range(48):
        a = 2 * math.pi * k / 48
        sz = r_.uniform(0.25, 0.35)
        p.box((sz, sz * 0.8, sz * 0.5), mat('paint_white'), loc=(9.4 * math.cos(a), 9.4 * math.sin(a), 0.1), rot=(0, 0, a / D2R), bevel=0.03)
    for s in (1, -1):
        p.box((0.9, 6.0, 0.02), mat('paint_white'), loc=(s * 1.8, 0, 0.065))
    p.box((2.7, 0.9, 0.02), mat('paint_white'), loc=(0, 0, 0.065))
    # windsock
    p.cyl(0.04, 4.5, mat('steel'), loc=(11.5, 0, 2.25), seg=6)
    p.cyl(0.25, 1.3, mat('paint_yellow'), loc=(11.5, -0.7, 4.35), rot=(-90 + 8, 0, 0), r2=0.12, seg=10)
    A.mesh('pad', p)
    A.socket('touchdown', (0, 0, 0.07))
    return A


def helicopter():
    A = Asset('helicopter', 'helicopter', 'Medium transport helicopter (Mi-8 class, generic). `rotor` spins about +Y, `tail_rotor` about +X.')
    A.ground_plane()
    paint = 'olive'
    p = Part()
    # fuselage lathe along Y (nose +Y)
    prof = [(0.0, 5.6), (0.45, 5.55), (0.9, 5.2), (1.15, 4.6), (1.25, 3.5), (1.25, -0.8), (1.1, -1.6), (0.7, -2.3), (0.4, -2.7)]
    p.lathe(prof, mat(paint), seg=16)
    p.transform(M(scale=(1.0, 1.0, 1.15)))
    p.transform(M((0, 0, 1.75)))
    # cockpit glazing
    p.sphere(1.0, mat('glass'), loc=(0, 4.75, 2.05), scale=(0.95, 0.85, 0.75), seg=12, rings=6)
    # engine/gearbox hump
    p.box((1.3, 4.2, 0.7), mat(paint), loc=(0, 1.4, 3.25), bevel=0.25, seg=2)
    for s in (1, -1):
        p.cyl(0.32, 0.6, mat('black'), loc=(s * 0.42, 3.35, 3.2), rot=(-90, 0, 0), seg=10)   # intakes
        p.cyl(0.25, 0.5, mat('steel'), loc=(s * 0.75, -0.75, 3.15), rot=(-90 + 25, 0, s * 30), seg=10)  # exhausts
        p.box((0.06, 0.9, 0.7), mat('glass'), loc=(s * 1.25, 2.0, 2.2))   # cabin windows strip
        p.cyl(0.4, 1.8, mat('drum_green'), loc=(s * 1.45, 0.6, 1.2), rot=(-90, 0, 0), seg=10)  # external tanks
        # gear
        rod(p, (s * 0.6, -0.4, 1.0), (s * 1.4, -0.6, 0.45), 0.05)
        wheel(p, 0.36, 0.25, (s * 1.45, -0.6, 0.36), axis='x')
    wheel(p, 0.28, 0.18, (0, 4.3, 0.28), axis='x')
    rod(p, (0, 4.3, 0.28), (0, 4.0, 1.0), 0.05)
    # tail boom + fin
    log(p, (0, -2.2, 2.4), (0, -9.5, 2.9), 0.32, paint, 12)
    p.fin(1.3, 0.7, 1.7, 0.12, mat(paint), loc=(0, -9.6, 3.0), rot=(0, -90, 0), sweep=0.6)
    p.fin(0.7, 0.45, 1.3, 0.06, mat(paint), loc=(0, -8.4, 2.85), rot=(0, 0, 0))
    p.fin(0.7, 0.45, 1.3, 0.06, mat(paint), loc=(0, -8.4, 2.85), rot=(0, 180, 0))
    A.mesh('fuselage', p)
    # main rotor: 5 blades + hub
    r = Part()
    r.cyl(0.35, 0.45, mat('steel'), loc=(0, 1.0, 3.9), seg=10)
    for k in range(5):
        a = k * 72
        r.box((10.5, 0.52, 0.05), mat('black'), loc=(5.4, 0, 0), bevel=0.0)
        bl = list(r.bm.verts)[-8:]
        r.transform(M((0, 1.0, 4.08), (0, 0, a)), verts=bl)
    A.mesh('rotor', r, pivot=(0, 1.0, 4.05), moving=True)
    tr = Part()
    tr.cyl(0.12, 0.2, mat('steel'), loc=(0.25, -9.8, 3.9), rot=(0, 90, 0), seg=8)
    for k in range(3):
        tr.box((0.05, 1.55, 0.2), mat('black'), loc=(0.32, -9.8, 3.9), rot=(k * 60, 0, 0))
    A.mesh('tail_rotor', tr, pivot=(0.3, -9.8, 3.9), moving=True)
    A.socket('exhaust_L', (-0.85, -1.0, 3.1))
    A.socket('exhaust_R', (0.85, -1.0, 3.1))
    return A


BUILDERS = {
    # id: (builder, texture size, opts)
    'aaa_gun': (aaa_gun, 1024),
    'aaa_gun_destroyed': (lambda: aaa_gun(True), 512, {'burn': True}),
    'manpads_team': (manpads_team, 1024),
    'sam_launcher': (sam_launcher, 1024),
    'sam_launcher_destroyed': (lambda: sam_launcher(True), 512, {'burn': True}),
    'radar': (radar, 1024),
    'radar_destroyed': (lambda: radar(True), 512, {'burn': True}),
    'truck': (lambda: truck(False), 1024),
    'truck_covered': (lambda: truck(True), 1024),
    'truck_destroyed': (lambda: truck(False, True), 512, {'burn': True}),
    'sangar': (sangar, 1024),
    'bunker': (bunker, 1024),
    'bunker_destroyed': (lambda: bunker(True), 1024, {'burn': False}),
    'tent': (tent, 512),
    'supply_dump': (supply_dump, 1024),
    'artillery': (artillery, 1024),
    'artillery_destroyed': (lambda: artillery(True), 512, {'burn': True}),
    'helipad': (helipad, 1024, {'lod1': False}),
    'helicopter': (helicopter, 1024),
}
