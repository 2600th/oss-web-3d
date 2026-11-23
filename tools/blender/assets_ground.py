"""Ground units and positions. Generic, unmarked, period-plausible kit for
high-altitude ridge positions. Ground at y = 0 (three), front toward -Z.

Moving parts are mesh nodes whose origin is the pivot:
  turret (yaw about +Y), barrels/barrel/launcher (pitch about +X; +rotation.x = up),
  dish (yaw), rotor / tail_rotor (spin).

[models polish 2] every unit was rebuilt for the baked normal / wear pipeline
in kit.py: more of the real thing's parts, no geometric bevels (the normal
bake rounds the edges), small fittings tagged `detail = 1` so LOD1 sheds them.
Node names, pivots, sockets and the forward axis are unchanged.
"""
import math

import bmesh

import kit
from kit import Asset, Part, mat, emissive, M, V, rng
from ground_parts import (D2R, wheel, axle, leaf_spring, log, rod, sandbag, sandbag_ring, stone, stone_wall, rubble, crate,
                          drum, jerrycan, debris)
from assets_truck import truck


def tilt_about(p, verts, pivot, rot):
    p.transform(M(pivot) @ M(rot=rot) @ M(tuple(-V(pivot))), verts=verts)


def screw_jack(p, x, y, top, m, pad=0.17):
    """Levelling jack: pad, screw, handle bar."""
    p.cyl(pad, 0.035, m, loc=(x, y, 0.018), seg=10)
    p.cyl(0.035, top - 0.03, m, loc=(x, y, top / 2 + 0.015), seg=7)
    p.detail = 1
    p.cyl(0.06, 0.07, m, loc=(x, y, top * 0.72), seg=7)
    rod(p, (x - 0.16, y, top + 0.03), (x + 0.16, y, top + 0.03), 0.012, m, 4)
    p.detail = 0


# ------------------------------------------------------------------ AAA gun
def aaa_gun(destroyed=False):
    A = Asset('aaa_gun_destroyed' if destroyed else 'aaa_gun', 'aaa',
              'Twin 23 mm towed AA gun (ZU-23-2-like) in firing position: wheels folded out, on three jacks. '
              'turret = yaw, barrels = pitch; muzzle_L/R on the barrels.')
    A.ground_plane()
    paint = mat('olive', mud=0.25)
    st = mat('steel', mud=0.3)
    gm = mat('gunmetal')
    base = Part()
    # lower carriage: plate, towing trail with lunette, three screw jacks on outriggers
    base.poly_prism([(-0.60, -0.72), (0.60, -0.72), (0.80, -0.15), (0.40, 0.88), (-0.40, 0.88), (-0.80, -0.15)], 0.11, paint, loc=(0, 0, 0.345))
    base.cyl(0.62, 0.035, st, loc=(0, 0, 0.462), seg=20)             # traverse race
    base.box((0.13, 1.50, 0.11), paint, loc=(0, 1.55, 0.375))
    base.torus(0.07, 0.022, st, loc=(0, 2.37, 0.375), seg=10, rseg=5)
    for (x, y) in ((0, 1.30), (0.86, -0.86), (-0.86, -0.86)):
        if x:
            base.box((0.10, 0.62, 0.09), paint, loc=(x * 0.80, -0.66, 0.36), rot=(0, 0, -math.copysign(38, x)))
        screw_jack(base, x, y, 0.36, st)
    for s in (1, -1):
        # wheel folded out on its swing arm (lying over at 65 deg, clear of the ground)
        fallen = destroyed and s < 0
        c = (s * 1.10, -0.05, 0.50) if not fallen else (s * 1.30, 0.30, 0.20)
        mk = base.mark()
        wheel(base, 0.42, 0.20, c, hub='olive', axis='x', seg=16, outer=s, mud=0.4, state='burnt' if destroyed else None)
        tilt_about(base, base.since(mk), c, (0, -s * (86 if fallen else 65), 0))
        if not fallen:
            base.box((0.34, 0.10, 0.08), paint, loc=(s * 0.86, -0.05, 0.42), rot=(0, -s * 22, 0))
    A.mesh('carriage', base)

    tz = 0.48
    yaw = 35 if destroyed else 0
    tur = Part()
    tur.cyl(0.66, 0.07, paint, loc=(0, 0, tz + 0.035), seg=20)
    for s in (1, -1):
        # cheek plates carrying the trunnions
        tur.poly_prism([(-0.50, 0), (0.42, 0), (0.32, 0.34), (0.14, 0.58), (-0.08, 0.58), (-0.36, 0.30)], 0.035, paint,
                       loc=(s * 0.30 - 0.0175, 0, tz + 0.07), rot=(90, 0, 90))
        tur.cyl(0.075, 0.07, st, loc=(s * 0.335, 0.05, tz + 0.50), rot=(0, 90, 0), seg=10)
        rod(tur, (s * 0.20, -0.42, tz + 0.10), (s * 0.20, -0.06, tz + 0.40), 0.045, paint, 7)   # equilibrators
        if not (destroyed and s > 0):
            # ammunition box outboard at right angles to the guns, belt chute to the feed
            tur.box((0.26, 0.56, 0.38), paint, loc=(s * 0.62, 0.10, tz + 0.50))
            tur.box((0.20, 0.30, 0.10), paint, loc=(s * 0.52, 0.10, tz + 0.27))
            tur.box((0.24, 0.12, 0.045), st, loc=(s * 0.40, 0.14, tz + 0.66), rot=(0, -s * 14, 0))
            tur.detail = 1
            tur.box((0.275, 0.575, 0.03), st, loc=(s * 0.62, 0.10, tz + 0.70))
            tur.box((0.02, 0.16, 0.04), st, loc=(s * 0.76, 0.10, tz + 0.58))
            tur.detail = 0
        # gunner's seat on a tube frame, foot plate
        tur.box((0.32, 0.30, 0.05), mat('rubber', dirt=0.5), loc=(s * 0.50, -0.66, tz + 0.38))
        tur.box((0.32, 0.05, 0.28), mat('rubber', dirt=0.5), loc=(s * 0.50, -0.83, tz + 0.56), rot=(-8, 0, 0))
        rod(tur, (s * 0.42, -0.45, tz + 0.06), (s * 0.50, -0.68, tz + 0.36), 0.022, st, 5)
        tur.detail = 1
        tur.box((0.22, 0.16, 0.02), st, loc=(s * 0.50, -0.34, tz + 0.10), rot=(20, 0, 0))
        tur.detail = 0
    # layer's handwheels, sight on its stalk (left)
    tur.detail = 1
    for (y, z, ax) in ((-0.40, 0.66, (0, 90, 0)), (-0.30, 0.50, (90, 0, 0))):
        tur.torus(0.11, 0.012, st, loc=(-0.24, y, tz + z), rot=ax, seg=10, rseg=4)
        tur.cyl(0.02, 0.10, st, loc=(-0.24, y, tz + z), rot=ax, seg=5)
    tur.detail = 0
    tur.box((0.05, 0.05, 0.62), st, loc=(-0.14, -0.30, tz + 0.40))
    tur.box((0.15, 0.24, 0.13), gm, loc=(-0.14, -0.26, tz + 0.76))
    tur.cyl(0.036, 0.08, mat('glass'), loc=(-0.14, -0.40, tz + 0.78), rot=(-90, 0, 0), seg=8)
    tur.detail = 1
    tur.torus(0.06, 0.007, st, loc=(-0.14, -0.10, tz + 0.90), rot=(90, 0, 0), seg=10, rseg=3)   # ring foresight
    tur.detail = 0
    turret = A.mesh('turret', tur, pivot=(0, 0, tz), moving=True)
    turret.rotation_euler.z = yaw * D2R

    pz, py = 0.98, 0.05
    elev = -3 if destroyed else 0
    bar = Part()
    bar.box((0.50, 0.90, 0.15), paint, loc=(0, 0.05, pz - 0.03))  # cradle
    for s in (1, -1):
        bx = s * 0.19
        gz = pz + 0.05
        bar.cyl(0.30, 0.02, paint, loc=(s * 0.265, py, pz), rot=(0, 90, 0), seg=14)   # elevating arc
        bar.box((0.14, 1.12, 0.20), gm, loc=(bx, 0.10, gz))                            # receiver
        bar.box((0.15, 0.32, 0.07), gm, loc=(bx, 0.28, gz + 0.12))                     # feed cover
        bar.cyl(0.05, 0.18, gm, loc=(bx, -0.54, gz), rot=(-90, 0, 0), seg=8)           # buffer
        if destroyed and s > 0:
            continue
        # barrel: jacket, tube, conical flash hider with an open mouth
        prof = [(0.056, 0.64), (0.056, 1.08), (0.040, 1.12), (0.036, 2.68), (0.046, 2.72), (0.080, 2.985), (0.062, 2.99), (0.030, 2.86), (0.0, 2.86)]
        blk = mat('black')
        bar.lathe(prof, gm, seg=10, loc=(bx, 0, gz), mats=[gm, gm, gm, gm, gm, gm, blk, blk])
        bar.detail = 1
        bar.cyl(0.020, 0.80, gm, loc=(bx, 1.52, gz - 0.058), rot=(-90, 0, 0), seg=5)   # gas cylinder
        bar.tube([(bx, 1.48, gz + 0.03), (bx, 1.50, gz + 0.11), (bx, 1.70, gz + 0.11), (bx, 1.72, gz + 0.03)], 0.010, st, seg=4)  # barrel-change handle
        bar.detail = 0
    bar.box((0.44, 0.05, 0.06), st, loc=(0, 1.02, pz + 0.05))  # barrel clamp
    barrels = A.mesh('barrels', bar, pivot=(0, py, pz), parent='turret', moving=True)
    barrels.rotation_euler.x = elev * D2R
    A.socket('muzzle_L', (-0.19, 3.0, pz + 0.05), parent='barrels')
    A.socket('muzzle_R', (0.19, 3.0, pz + 0.05), parent='barrels')
    if destroyed:
        debris(A, seed=11, n=10, radius=2.2)
    return A


# ------------------------------------------------------------------ MANPADS post
def manpads_team():
    A = Asset('manpads_team', 'sam_site', 'Sandbagged MANPADS firing post (no figures): launcher on a rest, spare rounds, '
              'radio. `launcher` = yaw/pitch pivot at the grip; socket `launch` at the tube mouth.')
    A.ground_plane()
    p = Part()
    sandbag_ring(p, 1.5, courses=3, start=-140, end=140, seed=4)
    # ground sheet, an opened transit case with two spare tubes, radio, cans
    p.sheet([[(-0.45, -0.75, 0.012), (0.85, -0.70, 0.012)], [(-0.40, 0.15, 0.012), (0.80, 0.12, 0.012)]], mat('canvas_dark'), thick=0.008, smooth=False)
    case = mat('olive', mud=0.2)
    p.box((1.78, 0.42, 0.20), case, loc=(-0.78, -0.30, 0.10), rot=(0, 0, 78))
    p.box((1.78, 0.42, 0.03), case, loc=(-1.02, -0.36, 0.26), rot=(0, 62, 78))   # lid thrown back
    for i in range(2):
        p.cyl(0.05, 1.66, mat('olive_missile'), loc=(-0.82 + i * 0.13, -0.29 + i * 0.03, 0.22), rot=(-90, 0, -12), seg=8)
    crate(p, (0.62, 0.34, 0.26), (0.20, -0.95, 0.13), yaw=12)
    p.box((0.28, 0.16, 0.36), mat('olive', mud=0.2), loc=(0.78, -0.62, 0.18))   # manpack radio
    p.detail = 1
    p.box((0.30, 0.18, 0.03), mat('steel'), loc=(0.78, -0.62, 0.37))
    p.cyl(0.004, 1.3, mat('black'), loc=(0.86, -0.66, 1.0), seg=4)
    p.box((0.05, 0.16, 0.05), mat('black'), loc=(0.66, -0.50, 0.03), rot=(0, 0, 30))  # handset
    p.detail = 0
    jerrycan(p, (0.55, 0.45, 0.0), yaw=-20)
    # launcher rest: a bipod of stakes
    rod(p, (0.25, 0.65, 0), (0.0, 0.55, 0.80), 0.022, 'timber')
    rod(p, (-0.25, 0.65, 0), (0.0, 0.55, 0.80), 0.022, 'timber')
    A.mesh('post', p)
    piv = V((0.0, -0.35, 0.95))
    l = Part()
    elev = 22
    q = M(rot=(elev, 0, 0)).to_3x3()

    def at(v):
        return tuple(piv + q @ V(v))
    tube = mat('olive_missile')
    ol = mat('olive')
    l.cyl(0.05, 1.70, tube, loc=at((0, 0.45, 0)), rot=(-90 + elev, 0, 0), seg=12)
    l.cyl(0.060, 0.13, ol, loc=at((0, 1.275, 0)), rot=(-90 + elev, 0, 0), seg=12)       # muzzle band + front cover seat
    l.cyl(0.060, 0.10, ol, loc=at((0, -0.38, 0)), rot=(-90 + elev, 0, 0), seg=12)       # rear band
    l.cyl(0.066, 0.02, mat('black'), loc=at((0, 1.345, 0)), rot=(-90 + elev, 0, 0), seg=12)
    l.box((0.055, 0.30, 0.10), ol, loc=at((0, 0.02, -0.095)), rot=(elev, 0, 0))            # gripstock body
    l.box((0.04, 0.05, 0.13), ol, loc=at((0, -0.06, -0.19)), rot=(elev - 12, 0, 0))        # pistol grip
    l.cyl(0.045, 0.11, mat('steel'), loc=at((0, 0.22, -0.125)), rot=(elev, 0, 0), seg=8)   # battery-coolant unit
    l.box((0.035, 0.16, 0.085), mat('gunmetal'), loc=at((-0.075, 0.18, 0.06)), rot=(elev, 0, 0))   # sight
    l.detail = 1
    l.box((0.004, 0.02, 0.09), mat('steel'), loc=at((-0.075, 0.30, 0.10)), rot=(elev, 0, 0))
    l.box((0.24, 0.012, 0.13), mat('steel'), loc=at((0.05, 0.42, 0.12)), rot=(elev, 0, 0))         # IFF antenna
    l.tube([at((0.03, 1.1, -0.05)), at((0.05, 0.5, -0.20)), at((0.03, -0.30, -0.05))], 0.012, mat('canvas_dark'), seg=4, caps=False)  # sling
    l.detail = 0
    A.mesh('launcher', l, pivot=tuple(piv), moving=True)
    A.socket('launch', at((0, 1.30, 0)), parent='launcher')
    return A


# ------------------------------------------------------------------ tracked SAM launcher
def tracks(p, L, x, z_axle, r_wheel=0.3, width=0.42, n=6, burnt=False):
    """One side's running gear: six big road wheels, drive sprocket at the
    front, idler at the rear, and the track run sagging onto the wheel tops."""
    tr = kit.track()
    rub = mat('rubber', mud=0.8)
    hubm = mat('olive', mud=0.7)
    y_f, y_r = L / 2 - 0.42, -L / 2 + 0.42
    z_s = z_axle + 0.16          # sprocket / idler centres sit higher
    r_s = 0.27
    th = 0.045
    ys = [y_r + 0.48 + i * (y_f - y_r - 0.96) / (n - 1) for i in range(n)]
    # centre line of the track loop (y, z), clockwise seen from +x
    path = []
    for k in range(7):   # round the idler (rear)
        a = math.radians(90 + k * 30)
        path.append((y_r + (r_s + th / 2) * math.cos(a), z_s + (r_s + th / 2) * math.sin(a)))
    zb = th / 2
    path += [(ys[0] - 0.05, zb), (ys[-1] + 0.05, zb)]
    for k in range(7):   # round the sprocket (front)
        a = math.radians(-90 + k * 30)
        path.append((y_f + (r_s + th / 2) * math.cos(a), z_s + (r_s + th / 2) * math.sin(a)))
    top = z_axle + r_wheel + th / 2
    for i in range(n - 1, -1, -1):  # top run: on each wheel, hanging a little between
        path.append((ys[i] + 0.16, top))
        path.append((ys[i] - 0.16, top))
        if i > 0:
            path.append(((ys[i] + ys[i - 1]) / 2, top - 0.035))
    secs = []
    for i, (y, z) in enumerate(path):
        y0, z0 = path[i - 1]
        y1, z1 = path[(i + 1) % len(path)]
        ty, tz = y1 - y0, z1 - z0
        ln = math.hypot(ty, tz) or 1
        ny, nz = -tz / ln * th / 2, ty / ln * th / 2
        secs.append([(x - width / 2, y + ny, z + nz), (x + width / 2, y + ny, z + nz), (x + width / 2, y - ny, z - nz), (x - width / 2, y - ny, z - nz)])
    p.loft(secs + [secs[0]], tr, smooth=False, caps=False)
    outer = 1 if x > 0 else -1
    for y in ys:
        prof = [(0.0, 0.5), (0.20, 0.5), (0.30, 0.30), (0.78, 0.34), (0.86, 0.9), (1.0, 0.9), (1.0, -0.9), (0.80, -0.9), (0.0, -0.6)]
        prof = [(a * r_wheel, b * width * 0.34 * outer) for a, b in prof]
        p.lathe(prof, hubm, seg=14, loc=(x, y, z_axle), rot=(0, 0, -90), mats=[hubm, hubm, hubm, hubm, rub, rub, rub, hubm])
    for y, teeth in ((y_f, True), (y_r, False)):
        p.cyl(r_s, width * 0.5, hubm, loc=(x, y, z_s), rot=(0, 90, 0), seg=12)
        p.cyl(r_s * 0.4, width * 0.62, mat('steel'), loc=(x, y, z_s), rot=(0, 90, 0), seg=8)


def sam_launcher(destroyed=False):
    A = Asset('sam_launcher_destroyed' if destroyed else 'sam_launcher', 'sam_site',
              'Tracked short-range SAM launcher (SA-13 class on a light tracked carrier, generic): turret = yaw, launcher = pitch; '
              'rail_1..4 at the container mouths.')
    A.ground_plane()
    L, W = 6.4, 2.8
    hull = Part()
    paint = mat('olive', mud=0.5)
    st = mat('steel', mud=0.6)
    glass = mat('black') if destroyed else mat('glass')
    hz = 0.42
    top = hz + 0.85
    hw = W / 2 - 0.42
    # hull tub between the tracks: long shallow glacis, flat roof, vertical tail
    side = [(-L / 2 + 0.05, hz), (L / 2 - 0.55, hz), (L / 2 - 0.02, hz + 0.40), (L / 2 - 0.02, hz + 0.52), (L / 2 - 1.15, top), (-L / 2 + 0.05, top)]
    hull.poly_prism(side, hw * 2, paint, loc=(-hw, 0, 0), rot=(90, 0, 90))
    # track guards with a turned edge, front mud flaps
    for s in (1, -1):
        hull.box((0.50, L - 0.25, 0.035), paint, loc=(s * (W / 2 - 0.20), -0.05, top - 0.02))
        hull.box((0.03, L - 0.25, 0.10), paint, loc=(s * (W / 2 + 0.035), -0.05, top - 0.06))
        hull.box((0.50, 0.03, 0.30), mat('rubber', mud=0.9), loc=(s * (W / 2 - 0.20), L / 2 - 0.16, top - 0.17), rot=(-25, 0, 0))
        tracks(hull, L, s * (W / 2 - 0.22), 0.34, r_wheel=0.31, width=0.38, n=6, burnt=destroyed)
    # crew cab at the front: two windscreens with armoured flaps, two hatches
    cab_y = L / 2 - 1.75
    hull.box((2.00, 1.30, 0.34), paint, loc=(0, cab_y, top + 0.17), taper=(0.94, 0.86))
    for s in (-0.5, 0.5):
        hull.box((0.56, 0.03, 0.22), glass, loc=(s, cab_y + 0.60, top + 0.18), rot=(14, 0, 0))
        hull.detail = 1
        hull.box((0.60, 0.03, 0.24), paint, loc=(s, cab_y + 0.66, top + 0.36), rot=(70, 0, 0))  # flap, open
        hull.detail = 0
    hull.cyl(0.27, 0.05, paint, loc=(0.52, cab_y - 0.10, top + 0.36), seg=12)
    hull.box((0.52, 0.52, 0.05), paint, loc=(-0.52, cab_y - 0.10, top + 0.36))
    hull.detail = 1
    for s in (1, -1):
        hull.box((0.10, 0.05, 0.03), st, loc=(s * 0.52, cab_y - 0.34, top + 0.395))   # hatch hinges
    hull.detail = 0
    # glacis: headlights in guards, tow hooks, a trim vane folded flat
    gl_n = V((0, 0.60, 0.80)).normalized()
    for s in (1, -1):
        c = V((s * 0.72, L / 2 - 0.42, hz + 0.72))
        hull.cyl(0.085, 0.10, st, loc=tuple(c), rot=(-70, 0, 0), seg=10)
        hull.cyl(0.07, 0.02, glass if destroyed else mat('lens', dirt=0.3), loc=tuple(c + V((0, 0.055, 0.02))), rot=(-70, 0, 0), seg=10)
        hull.detail = 1
        hull.tube([tuple(c + V((-0.11, 0.02, -0.06))), tuple(c + V((-0.11, 0.10, 0.10))), tuple(c + V((0.11, 0.10, 0.10))), tuple(c + V((0.11, 0.02, -0.06)))], 0.010, st, seg=4)
        hull.torus(0.05, 0.016, st, loc=(s * 0.55, L / 2 + 0.0, hz + 0.30), rot=(0, 90, 0), seg=8, rseg=4)
        hull.detail = 0
    hull.box((1.60, 0.62, 0.03), paint, loc=(0, L / 2 - 0.62, hz + 0.76), rot=(-37.5, 0, 0))
    # engine deck: louvred grilles, exhaust box on the right guard, stowage, tow cable, pioneer tools
    hull.detail = 1
    for k in range(5):
        hull.box((0.70, 0.05, 0.03), st, loc=(-0.45, 0.45 - k * 0.09, top + 0.015), rot=(25, 0, 0))
    hull.detail = 0
    hull.box((0.74, 0.50, 0.03), paint, loc=(-0.45, 0.27, top + 0.006))
    hull.box((0.30, 0.55, 0.20), st, loc=(1.12, -L / 2 + 0.55, top + 0.11))
    hull.box((0.36, 0.90, 0.24), paint, loc=(-1.12, -1.2, top + 0.12))       # stowage bin
    hull.box((0.36, 0.60, 0.24), paint, loc=(1.12, 1.0, top + 0.12))
    hull.cyl(0.11, 2.2, mat('timber'), loc=(-1.14, 0.95, top + 0.12), rot=(-90, 0, 0), seg=8)   # unditching beam
    hull.detail = 1
    hull.box((0.05, 0.9, 0.04), mat('timber'), loc=(1.12, -0.6, top + 0.03))                    # shovel
    hull.box((0.20, 0.24, 0.02), st, loc=(1.12, -0.05, top + 0.03))
    hull.tube([(0.9, -L / 2 + 0.08, top - 0.25), (0.4, -L / 2 + 0.03, top - 0.45), (-0.4, -L / 2 + 0.03, top - 0.45), (-0.9, -L / 2 + 0.08, top - 0.25)], 0.018, st, seg=4)  # tow cable
    for s in (1, -1):
        hull.box((0.50, 0.03, 0.62), paint, loc=(s * 0.42, -L / 2 + 0.04, hz + 0.47))  # rear doors
        hull.box((0.06, 0.05, 0.04), st, loc=(s * 0.20, -L / 2 + 0.02, hz + 0.50))
    hull.detail = 0
    for i in range(3):
        hull.box((0.50, 0.36, 0.26), mat('canvas_dark'), loc=(-0.25 + i * 0.5, -2.75, top + 0.13), rot=(0, 0, 6 * i - 5))  # bedrolls / tarps
    if destroyed:
        hull.transform(M(rot=(2.5, -3.0, 0)))
    A.mesh('hull', hull)

    tz = hz + 0.88
    ty = -0.9
    yaw = -50 if destroyed else 0
    t = Part()
    t.cyl(0.85, 0.16, paint, loc=(0, ty, tz + 0.08), seg=20)
    # operator's pod: sloped glazed front, roof hatch
    pod = [(-0.62, 0.16), (0.50, 0.16), (0.62, 0.50), (0.36, 0.92), (-0.62, 0.92)]
    t.poly_prism(pod, 0.86, paint, loc=(-0.43, ty, tz), rot=(90, 0, 90))
    t.box((0.60, 0.03, 0.34), glass, loc=(0, ty + 0.515, tz + 0.72), rot=(31.5, 0, 0))
    t.detail = 1
    t.box((0.70, 0.04, 0.44), paint, loc=(0, ty + 0.50, tz + 0.72), rot=(31.5, 0, 0))
    t.cyl(0.24, 0.04, paint, loc=(0, ty - 0.15, tz + 0.93), seg=10)
    t.detail = 0
    # trunnion arms either side of the pod
    for s in (1, -1):
        t.box((0.10, 0.46, 0.62), paint, loc=(s * 0.50, ty, tz + 0.72))
        t.cyl(0.10, 0.14, st, loc=(s * 0.56, ty, tz + 1.0), rot=(0, 90, 0), seg=10)
    turret = A.mesh('turret', t, pivot=(0, ty, tz), moving=True)
    turret.rotation_euler.z = yaw * D2R

    pz = tz + 1.0
    elev = -4 if destroyed else 12
    ln = Part()
    rails = []
    box = mat('olive_missile')
    ln.box((1.90, 0.14, 0.14), st, loc=(0, ty, pz))            # cross-beam through the trunnions
    for s in (1, -1):
        for k, z in enumerate((0.0, 0.36)):
            if destroyed and s > 0 and k == 1:
                continue
            x = s * 0.86
            c = (x, ty + 0.25, pz + z - 0.1)
            ln.box((0.33, 2.30, 0.31), box, loc=c)
            ln.box((0.29, 0.02, 0.27), mat('black'), loc=(x, ty + 1.405, pz + z - 0.1))
            for y in (-0.62, 0.0, 0.62, 1.10):   # ribs and carrying bands
                ln.box((0.35, 0.05, 0.33), box if abs(y) < 0.1 else st, loc=(x, c[1] + y, c[2]))
            ln.detail = 1
            ln.box((0.05, 0.30, 0.03), st, loc=(x, c[1] - 0.2, c[2] + 0.17))
            ln.cyl(0.03, 0.06, st, loc=(x + s * 0.17, c[1] - 0.95, c[2]), rot=(0, 90, 0), seg=6)   # umbilical socket
            ln.detail = 0
            rails.append((x, ty + 1.42, pz + z - 0.1))
        ln.box((0.10, 0.34, 0.74), st, loc=(s * 0.66, ty + 0.20, pz + 0.07))    # container frame
    # between the pairs: ranging radar dish and the optical sight head
    dish = [(0.0, 0.0), (0.10, 0.012), (0.20, 0.05), (0.27, 0.10), (0.275, 0.085), (0.20, 0.035), (0.0, -0.02)]
    ln.lathe(dish, mat('dish'), seg=14, loc=(0.0, ty + 0.62, pz + 0.30))
    ln.detail = 1
    ln.cyl(0.02, 0.16, st, loc=(0.0, ty + 0.72, pz + 0.30), rot=(-90, 0, 0), seg=5)
    ln.detail = 0
    ln.box((0.22, 0.60, 0.12), paint, loc=(0.0, ty + 0.30, pz + 0.24))
    ln.box((0.24, 0.30, 0.22), mat('gunmetal'), loc=(0.0, ty + 0.52, pz + 0.02))
    ln.cyl(0.08, 0.04, glass, loc=(0.0, ty + 0.685, pz + 0.02), rot=(-90, 0, 0), seg=10)
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
              'Towed surveillance radar trailer on four jacks: `dish` yaws (spin it), socket `feed` at the horn.')
    A.ground_plane()
    p = Part()
    paint = mat('olive', mud=0.4)
    st = mat('steel', mud=0.5)
    # trailer: frame, deck, A-frame drawbar with lunette and jockey leg, mudguards
    p.box((2.2, 4.6, 0.10), paint, loc=(0, 0, 1.03))
    for s in (1, -1):
        p.box((0.10, 4.5, 0.20), st, loc=(s * 0.55, 0, 0.88))
        rod(p, (s * 0.55, 2.25, 0.90), (0, 3.75, 0.86), 0.05, st, 6)
    p.torus(0.075, 0.022, st, loc=(0, 3.84, 0.86), seg=10, rseg=5)
    rod(p, (0, 3.45, 0.86), (0, 3.45, 0.0), 0.035, st, 6)
    p.cyl(0.12, 0.03, st, loc=(0, 3.45, 0.015), seg=8)
    for y in (1.2, -1.2):
        p.cyl(0.06, 2.3, st, loc=(0, y, 0.48), rot=(0, 90, 0), seg=6, cap=False)
        for s in (1, -1):
            down = destroyed and s > 0 and y > 0
            wheel(p, 0.48, 0.28, (s * 1.25, y, 0.30 if down else 0.48), hub='olive', axis='x', seg=16, outer=s, mud=0.5,
                  state=('burnt' if destroyed else None))
            guard = [(y - 0.62, 0.86), (y - 0.45, 1.06), (y + 0.45, 1.06), (y + 0.62, 0.86)]
            p.sheet([[(s * 1.08, yy, zz) for yy, zz in guard], [(s * 1.42, yy, zz) for yy, zz in guard]], paint, thick=0.025, smooth=False,
                    away=(None, y, 0.48))
    for (x, y) in ((1.6, 2.0), (-1.6, 2.0), (1.6, -2.0), (-1.6, -2.0)):
        p.box((0.10, 0.10, 0.10), st, loc=(x * 0.70, y, 0.98))
        rod(p, (x * 0.70, y, 0.98), (x, y, 0.42), 0.05, st, 6)      # swing-out brace
        screw_jack(p, x, y, 0.46, st, pad=0.19)
    # equipment cabin at the rear: door, louvres, roof conditioner, ladder, cable reel
    p.box((2.1, 1.7, 1.5), paint, loc=(0, -1.35, 1.83))
    p.box((2.16, 1.76, 0.05), paint, loc=(0, -1.35, 2.60))                 # roof with a drip edge
    p.box((0.72, 0.03, 1.22), paint, loc=(0.5, -2.215, 1.76))             # door
    p.detail = 1
    p.box((0.03, 0.03, 0.14), st, loc=(0.20, -2.24, 1.76))
    for z in (1.30, 2.22):
        p.box((0.05, 0.03, 0.10), st, loc=(0.84, -2.235, z))
    for k in range(6):
        p.box((0.03, 0.50, 0.03), paint, loc=(-1.06, -1.30, 2.10 + k * 0.06), rot=(0, 30, 0))   # side louvres
        p.box((0.03, 0.50, 0.03), paint, loc=(1.06, -1.30, 2.10 + k * 0.06), rot=(0, -30, 0))
    for k in range(5):
        p.box((0.42, 0.03, 0.025), st, loc=(-0.55, -2.26, 1.25 + k * 0.28))   # ladder rungs
    for s in (1, -1):
        p.box((0.03, 0.03, 1.50), st, loc=(-0.55 + s * 0.21, -2.26, 1.80))
    p.detail = 0
    p.box((0.62, 0.52, 0.34), st, loc=(-0.6, -1.2, 2.79))                 # air conditioner
    p.cyl(0.26, 0.30, st, loc=(1.12, -0.25, 1.38), rot=(0, 90, 0), seg=12)  # cable reel
    p.cyl(0.33, 0.03, st, loc=(1.27, -0.25, 1.38), rot=(0, 90, 0), seg=12)
    p.box((0.7, 0.5, 0.45), paint, loc=(-0.6, -0.2, 1.30))                # generator / junction box
    # antenna pedestal at the front
    p.cyl(0.36, 0.92, paint, loc=(0, 0.9, 1.52), seg=14)
    p.cyl(0.46, 0.10, st, loc=(0, 0.9, 1.99), seg=16)
    p.detail = 1
    for k in range(4):
        a = math.radians(45 + k * 90)
        p.box((0.05, 0.16, 0.5), paint, loc=(0.38 * math.cos(a), 0.9 + 0.38 * math.sin(a), 1.34), rot=(0, 0, math.degrees(a) + 90))  # gussets
    p.detail = 0
    if destroyed:
        p.transform(M(rot=(0, 4, 0)))
    A.mesh('trailer', p)

    pz = 2.05
    d = Part()
    d.cyl(0.32, 0.5, paint, loc=(0, 0.9, pz + 0.25), seg=14)
    d.box((0.5, 0.5, 0.35), paint, loc=(0, 0.75, pz + 0.55))
    # reflector: elliptical cut of a paraboloid of revolution, y = (x^2 + z^2) / 4f, f = 1.1 m:
    # rim 2.4 x 1.3 m, 4 cm shell, aimed 12 deg up with the horn at the focus.
    tilt = 12
    rw, rh, foc, th = 2.4, 1.3, 1.1, 0.04
    seg_u, seg_v = 28, 6
    bm = d.bm
    before = set(bm.faces)

    def ring(r, off):
        out = []
        for i in range(seg_u):
            a = 2 * math.pi * i / seg_u
            x, z = math.cos(a) * r * rw / 2, math.sin(a) * r * rh / 2
            out.append(bm.verts.new((x, (x * x + z * z) / (4 * foc) + off, z)))
        return out
    radii = [(k / seg_v) ** 0.8 for k in range(1, seg_v + 1)]
    front = [ring(r, 0.0) for r in radii]
    back = [ring(r, -th) for r in radii]
    cf, cb = bm.verts.new((0, 0, 0)), bm.verts.new((0, -th, 0))
    for i in range(seg_u):
        j = (i + 1) % seg_u
        bm.faces.new((cf, front[0][i], front[0][j]))
        bm.faces.new((cb, back[0][j], back[0][i]))
        for k in range(seg_v - 1):
            bm.faces.new((front[k][i], front[k + 1][i], front[k + 1][j], front[k][j]))
            bm.faces.new((back[k][i], back[k][j], back[k + 1][j], back[k + 1][i]))
        bm.faces.new((front[-1][i], back[-1][i], back[-1][j], front[-1][j]))  # rim
    new = [f for f in bm.faces if f not in before]
    bmesh.ops.recalc_face_normals(bm, faces=new)
    dm = d._mi(mat('dish'))
    for f in new:
        f.material_index = dm
        f.smooth = True
    # back structure: three bent ribs hugging the shell, two verticals, a hub
    before_r = set(bm.faces)

    def shell(x, z, off=0.035):
        return (x, (x * x + z * z) / (4 * foc) - th - off, z)
    for zr in (-0.38, 0.0, 0.38):
        half = rw / 2 * math.sqrt(max(0.0, 1 - (zr / (rh / 2)) ** 2)) * 0.9
        n = 6
        d.tube([shell(-half + 2 * half * k / n, zr) for k in range(n + 1)], 0.03, st, seg=4)
    for xr in (-0.55, 0.55):
        d.tube([shell(xr, -0.50), shell(xr, 0.0), shell(xr, 0.50)], 0.025, st, seg=4)
    d.box((0.34, 0.16, 0.34), paint, loc=shell(0, 0, 0.10))
    ribs = [f for f in bm.faces if f not in before_r]
    dv = list({v for f in new + ribs for v in f.verts})
    dish_m = M((0, 1.05, pz + 1.35), (tilt, 0, 0))
    bmesh.ops.transform(bm, matrix=dish_m, verts=dv)
    d.box((0.14, 0.14, 1.2), paint, loc=(0, 0.95, pz + 1.0))  # mast to the pedestal
    # feed horn at the focus on a boom from below, waveguide up the boom
    feed = V((0, 1.05 + foc * math.cos(math.radians(tilt)), pz + 1.35 + foc * math.sin(math.radians(tilt))))

    def on_shell(x, z):
        return tuple(dish_m @ V((x, (x * x + z * z) / (4 * foc), z)))
    for s in (1, -1):
        rod(d, on_shell(s * 0.9, 0.0), tuple(feed), 0.022, st, 4)
    rod(d, on_shell(0.0, -0.58), tuple(feed), 0.03, st, 5)
    d.detail = 1
    d.tube([(0.06, 0.98, pz + 0.75), on_shell(0.06, -0.60), tuple(feed + V((0.06, -0.05, -0.04)))], 0.016, mat('brass'), seg=4)
    d.detail = 0
    horn = [(0.05, -0.12), (0.05, -0.02), (0.10, 0.07), (0.092, 0.07), (0.045, -0.01), (0.0, -0.01)]
    d.lathe(horn, mat('gunmetal'), seg=8, loc=tuple(feed), rot=(180 + tilt, 0, 0))
    # IFF array on the top rim: bar with four dipoles
    d.box((1.6, 0.06, 0.08), st, loc=on_shell(0.0, 0.70), rot=(tilt, 0, 0))
    d.detail = 1
    for k in range(4):
        c = V(on_shell(-0.6 + k * 0.4, 0.70))
        d.box((0.02, 0.30, 0.02), st, loc=tuple(c + V((0, 0.12, 0.04))), rot=(tilt, 0, 0))
    d.detail = 0
    if destroyed:
        d.transform(M(rot=(-28, 10, 0)), verts=None)
        d.transform(M((0.3, 0.6, -0.9)))
    A.mesh('dish', d, pivot=(0, 0.9, pz), moving=True)
    A.socket('feed', tuple(feed), parent='dish')
    if destroyed:
        debris(A, seed=31, n=12, radius=3.5)
    return A


# ------------------------------------------------------------------ positions
def hmg(p, loc, yaw=0.0):
    """Heavy machine gun on a low tripod (generic 12.7 mm class), ammo can."""
    gm, st = mat('gunmetal'), mat('steel')
    R = M(loc, (0, 0, yaw))

    def at(v):
        return tuple(R @ V(v))
    for a in (0, 130, -130):
        ra = math.radians(a)
        rod(p, at((0, 0, 0.42)), at((0.62 * math.sin(ra), 0.62 * math.cos(ra), 0.02)), 0.022, st, 5)
    p.cyl(0.05, 0.14, st, loc=at((0, 0, 0.45)), seg=6)
    p.box((0.11, 0.62, 0.13), gm, loc=at((0, -0.10, 0.60)), rot=(4, 0, yaw))
    p.cyl(0.03, 1.0, gm, loc=at((0, 0.70, 0.635)), rot=(-86, 0, yaw), seg=7)
    p.cyl(0.04, 0.10, gm, loc=at((0, 1.22, 0.672)), rot=(-86, 0, yaw), seg=7)
    p.detail = 1
    p.box((0.20, 0.30, 0.20), mat('olive'), loc=at((-0.18, -0.02, 0.50)), rot=(0, 0, yaw))
    for s in (1, -1):
        p.box((0.03, 0.14, 0.03), st, loc=at((s * 0.06, -0.47, 0.60)), rot=(0, 0, yaw))   # spade grips
    p.detail = 0


def sangar():
    A = Asset('sangar', 'position', 'Dry-stone sangar (C-shaped fighting position, open to the rear) with sandbag topping, '
              'a tin-and-tarpaulin shelter over the back and a machine gun at the wall.')
    A.ground_plane()
    p = Part()
    pts = []
    R = 2.1
    for k in range(11):
        a = (-130 + 26 * k) * D2R
        pts.append((R * math.sin(a), R * math.cos(a)))
    stone_wall(p, pts, height=1.05, thick=0.72, seed=5)
    top = int(1.05 / 0.22) * 0.22 - 0.06
    for k in range(9):
        if k == 4:
            continue   # firing gap
        a = (-100 + 25 * k) * D2R
        sandbag(p, ((R - 0.05) * math.sin(a), (R - 0.05) * math.cos(a), top + 0.07), yaw=-a / D2R + 90, seed=k)
    for k in (3, 5):  # a second course either side of the gap
        a = (-100 + 25 * k + 6) * D2R
        sandbag(p, ((R - 0.05) * math.sin(a), (R - 0.05) * math.cos(a), top + 0.20), yaw=-a / D2R + 90, seed=k + 20)
    A.footprint(p)   # the wall is the footprint; rubble and guys must not widen it
    rubble(p, 26, 3.4, seed=6, size=(0.12, 0.30), inner=2.5)
    # lean-to at the back wall of the C: corrugated iron on poles, a tarpaulin lapped over, stones to hold it
    cgi = kit.corrugated('grey_paint')
    for (x, y) in ((-1.25, -0.9), (1.25, -0.9)):
        log(p, (x, y, 0), (x, y, 1.72), 0.045)
    log(p, (-1.45, -0.9, 1.70), (1.45, -0.9, 1.70), 0.04)
    roof = [[(-1.5, -1.05, 1.76), (0.0, -1.05, 1.76), (1.5, -1.05, 1.76)], [(-1.5, 0.75, 1.22), (0.0, 0.75, 1.24), (1.5, 0.75, 1.22)]]
    p.sheet(roof, cgi, thick=0.015, smooth=False, rim=True)
    tarp = [[(-1.1, -1.12, 1.80), (-0.2, -1.12, 1.80), (0.75, -1.12, 1.80)], [(-1.15, -0.4, 1.60), (-0.2, -0.45, 1.585), (0.8, -0.4, 1.60)],
            [(-1.2, 0.35, 1.37), (-0.2, 0.30, 1.36), (0.85, 0.36, 1.37)]]
    p.sheet(tarp, mat('canvas_dark'), thick=0.02, rim=True)
    r_ = rng(77)
    for k in range(6):
        x, y = r_.uniform(-1.3, 1.3), r_.uniform(-0.9, 0.6)
        z = 1.76 + (y + 1.05) / 1.8 * (1.22 - 1.76)
        stone(p, (0.22, 0.26, 0.13), (x, y, z + 0.07), (r_.uniform(-17, -15), 0, r_.uniform(0, 180)), 'stone', r_)
    # inside: ground sheet, ammunition, cans, the gun
    p.sheet([[(-0.6, -0.5, 0.012), (0.9, -0.5, 0.012)], [(-0.6, 0.5, 0.012), (0.9, 0.5, 0.012)]], mat('canvas_dark'), thick=0.008, smooth=False)
    crate(p, (0.6, 0.35, 0.3), (-1.0, -0.2, 0.15), yaw=40)
    crate(p, (0.6, 0.35, 0.3), (-0.95, -0.25, 0.45), yaw=52)
    jerrycan(p, (0.95, -0.35, 0.0), yaw=15)
    jerrycan(p, (1.12, -0.28, 0.0), yaw=-10)
    hmg(p, (0.0, 1.05, 0.38))
    for (x, y) in ((-0.35, 1.0), (0.35, 1.0), (0.0, 1.45)):   # stone firing step under the tripod
        stone(p, (0.5, 0.5, 0.40), (x, y - 0.1, 0.19), (0, 0, 20 * x), 'stone_dark', r_)
    A.mesh('walls', p)
    A.socket('gunner', (0, 1.2, 0.9))
    return A


def bunker(destroyed=False):
    A = Asset('bunker_destroyed' if destroyed else 'bunker', 'position',
              'Stone-and-timber ridge bunker: log roof under earth and rock, a firing slit facing -Z, door at the rear, stove pipe.')
    A.ground_plane()
    p = Part()
    W, Lb, H = 4.2, 3.4, 1.15
    r_ = rng(13)
    # walls; the front in two parts with a slit between, a gap for the door at the rear left
    stone_wall(p, [(-W / 2, Lb / 2), (-0.55, Lb / 2)], H, 0.7, seed=7)
    stone_wall(p, [(0.55, Lb / 2), (W / 2, Lb / 2)], H, 0.7, seed=8)
    stone_wall(p, [(-0.6, Lb / 2), (0.6, Lb / 2)], 0.44, 0.7, seed=18, cap=False)   # under the slit
    stone_wall(p, [(W / 2, Lb / 2), (W / 2, -Lb / 2)], H, 0.7, seed=9)
    stone_wall(p, [(-W / 2, -Lb / 2), (-W / 2, Lb / 2)], H, 0.7, seed=10)
    stone_wall(p, [(W / 2, -Lb / 2), (-0.5, -Lb / 2)], H, 0.7, seed=12)
    A.footprint(p)   # the walls are the footprint
    p.box((W - 0.5, Lb - 0.5, 0.02), mat('stone_dark'), loc=(0, 0, 0.01))            # floor
    p.box((1.1, 0.5, 0.72), mat('black'), loc=(0, Lb / 2 - 0.25, 0.80))             # darkness behind the slit
    rubble(p, 30, 4.0, seed=16, size=(0.12, 0.34), inner=2.9)
    if not destroyed:
        # timber lintel over the slit, door frame and blanket at the rear
        log(p, (-0.95, Lb / 2 + 0.05, H - 0.02), (0.95, Lb / 2 + 0.05, H - 0.02), 0.10)
        for x in (-0.55, -1.75):
            log(p, (x, -Lb / 2, 0), (x, -Lb / 2, H + 0.05), 0.07)
        p.box((1.1, 0.4, 1.0), mat('black'), loc=(-1.15, -Lb / 2 + 0.25, 0.52))
        flap = [[(-1.72, -Lb / 2 - 0.06, H), (-1.15, -Lb / 2 - 0.08, H), (-0.75, -Lb / 2 - 0.06, H)],
                [(-1.70, -Lb / 2 - 0.10, 0.55), (-1.20, -Lb / 2 - 0.16, 0.55), (-0.95, -Lb / 2 - 0.10, 0.62)],
                [(-1.68, -Lb / 2 - 0.12, 0.06), (-1.25, -Lb / 2 - 0.20, 0.06), (-1.12, -Lb / 2 - 0.14, 0.20)]]
        p.sheet(flap, mat('canvas_dark'), thick=0.02, rim=True)
        # roof: logs, a tin layer showing at the eaves, earth mound, rocks, sandbags at the front edge
        for i in range(11):
            y = -Lb / 2 - 0.25 + i * (Lb + 0.5) / 10
            log(p, (-W / 2 - 0.32 + r_.uniform(-0.06, 0.06), y, H + 0.11), (W / 2 + 0.32 + r_.uniform(-0.06, 0.06), y, H + 0.11 + r_.uniform(-0.02, 0.02)), 0.115, seg=8)
        p.box((W + 0.5, Lb + 0.5, 0.02), kit.corrugated('grey_paint', axis='Y'), loc=(0, 0, H + 0.24))
        # earth cover: a low mound (lofted rings), not a slab
        earth = mat('stone', dirt=0.9)
        secs = []
        for (k, inset, z) in ((0, 0.0, H + 0.25), (1, 0.10, H + 0.40), (2, 0.50, H + 0.54), (3, 1.20, H + 0.60)):
            hw_, hl_ = W / 2 + 0.28 - inset, Lb / 2 + 0.28 - inset
            ring = []
            for i in range(16):
                a = 2 * math.pi * i / 16
                sx = math.copysign(abs(math.cos(a)) ** 0.5, math.cos(a))
                sy = math.copysign(abs(math.sin(a)) ** 0.5, math.sin(a))
                ring.append((hw_ * sx * r_.uniform(0.96, 1.04), hl_ * sy * r_.uniform(0.96, 1.04), z + r_.uniform(-0.03, 0.03)))
            secs.append(ring)
        p.loft(secs, earth, smooth=True)
        for i in range(34):
            sz = r_.uniform(0.16, 0.42)
            x, y = r_.uniform(-W / 2, W / 2), r_.uniform(-Lb / 2, Lb / 2)
            edge = max(abs(x) / (W / 2), abs(y) / (Lb / 2))
            stone(p, (sz, sz * 1.2, sz * 0.6), (x, y, H + 0.60 - 0.16 * edge ** 3 + sz * 0.1),
                  (r_.uniform(-10, 10), r_.uniform(-10, 10), r_.uniform(0, 180)), r_.choice(['stone', 'stone_dark']), r_)
        for k in range(7):
            sandbag(p, (-1.2 + k * 0.4, Lb / 2 + 0.22, H + 0.36), yaw=90, seed=k)
        for k in range(6):
            sandbag(p, (-1.0 + k * 0.4, Lb / 2 + 0.20, H + 0.50), yaw=90, seed=k + 40)
        # stove pipe with a cowl, guyed; a whip aerial
        p.cyl(0.055, 1.25, mat('steel'), loc=(1.25, -0.9, H + 1.05), seg=8)
        p.cyl(0.10, 0.06, mat('steel'), loc=(1.25, -0.9, H + 1.70), seg=8, r2=0.03)
        p.detail = 1
        p.cyl(0.006, 2.6, mat('black'), loc=(-1.6, 1.1, H + 1.7), seg=4)
        p.detail = 0
    else:
        # roof blown in: logs thrown about, the walls breached, the cover spilled inside and out
        r2 = rng(14)
        for i in range(7):
            y = r2.uniform(-Lb / 2, Lb / 2)
            log(p, (-W / 2 + r2.uniform(-0.6, 1), y, H * r2.uniform(0.2, 1.0)), (W / 2 - r2.uniform(0, 1.4), y + r2.uniform(-0.9, 0.9), r2.uniform(0.1, 0.6)), 0.115, 'timber', 8)
        for i in range(44):
            sz = r2.uniform(0.18, 0.45)
            stone(p, (sz, sz * 1.2, sz * 0.6), (r2.uniform(-W / 2 - 0.6, W / 2 + 0.6), r2.uniform(-Lb / 2 - 0.6, Lb / 2 + 0.6), r2.uniform(0.08, 0.5)),
                  (r2.uniform(-30, 30), r2.uniform(-30, 30), r2.uniform(0, 180)), r2.choice(['stone', 'stone_dark']), r2)
        p.sheet([[(-1.0, -0.6, 0.55), (0.2, -0.8, 0.30), (1.2, -0.5, 0.12)], [(-1.2, 0.5, 0.40), (0.1, 0.4, 0.22), (1.3, 0.7, 0.10)]],
                kit.corrugated('grey_paint', axis='Y'), thick=0.015, smooth=False)
    A.mesh('structure', p)
    A.socket('slit', (0, Lb / 2 + 0.35, 0.75))
    if destroyed:
        debris(A, seed=15, n=8, radius=3.5, mname='stone')
    return A


def tent():
    A = Asset('tent', 'camp', 'Ridge tent (4 x 3 m): sagging canvas on two poles, low walls, door tied back, guy lines, stove pipe.')
    A.ground_plane()
    p = Part()
    W, L, H, wall = 3.0, 4.0, 2.0, 0.45
    canvas = mat('canvas', dirt=0.5)
    dark = mat('canvas_dark')
    r_ = rng(17)
    # roof and walls as one skin: ridge hangs between the poles, panels belly between the guys
    ny = 8
    cross = [(-W / 2 - 0.02, 0.0), (-W / 2, wall), (-W * 0.34, wall + (H - wall) * 0.34), (-W * 0.17, wall + (H - wall) * 0.67), (0.0, H),
             (W * 0.17, wall + (H - wall) * 0.67), (W * 0.34, wall + (H - wall) * 0.34), (W / 2, wall), (W / 2 + 0.02, 0.0)]
    grid = []
    for j in range(ny + 1):
        t = j / ny
        y = -L / 2 + L * t
        sag = 0.09 * math.sin(math.pi * t)
        belly = math.sin(math.pi * ((t * 2) % 1.0)) ** 2   # 0 at the three guy points
        row = []
        for i, (x, z) in enumerate(cross):
            roof = 1 < i < 7
            zz = z - sag * (z / H) - (0.05 * belly if roof and i != 4 else 0)
            xx = x * (1 - 0.02 * belly) if roof else x
            row.append((xx + r_.uniform(-0.008, 0.008), y, max(0.0, zz + r_.uniform(-0.008, 0.008))))
        grid.append(row)
    p.sheet(grid, canvas, thick=0.025, smooth=True, rim=True)
    # gable ends: back closed, front with two flaps tied back to show the dark inside
    for j, sgn in ((0, -1), (ny, 1)):
        ring = grid[j]
        y = ring[0][1]
        if sgn < 0:
            p.fan(ring, (0.0, y - 0.03, 0.75), canvas, away=(0.0, y + 1, 0.8))
        else:
            p.box((1.0, 0.02, 1.5), mat('black'), loc=(0, y - 0.03, 0.75))
            for s in (1, -1):
                tri = [ring[4], ring[4 + s * 2], ring[4 + s * 3], ring[4 + s * 4], (s * 0.50, y + 0.02, 0.0), (s * 0.42, y + 0.03, 0.9)]
                p.fan(tri[1:], tri[0], canvas, away=(0.0, y - 1, 0.8), close=False)
                p.sheet([[(s * 0.42, y + 0.04, 1.45), (s * 0.62, y + 0.10, 1.40)], [(s * 0.44, y + 0.06, 0.75), (s * 0.70, y + 0.14, 0.70)],
                         [(s * 0.46, y + 0.05, 0.05), (s * 0.66, y + 0.12, 0.03)]], dark, thick=0.03, rim=True)   # rolled flap
    log(p, (0, L / 2 + 0.06, 0), (0, L / 2 + 0.06, H + 0.16), 0.035)
    log(p, (0, -L / 2 - 0.06, 0), (0, -L / 2 - 0.06, H + 0.16), 0.035)
    A.footprint(p)
    # guys to pegs, stones on the sod cloth
    for y in (-L / 2, 0.0, L / 2):
        for s in (1, -1):
            rod(p, (s * W / 2, y, wall), (s * (W / 2 + 0.95), y, 0.03), 0.008, 'canvas_dark', 4)
            p.cyl(0.02, 0.24, mat('timber'), loc=(s * (W / 2 + 0.95), y, 0.09), rot=(0, s * -22, 0), seg=5)
    for s in (1, -1):
        rod(p, (0, s * (L / 2 + 0.06), H + 0.1), (0, s * (L / 2 + 1.5), 0.03), 0.008, 'canvas_dark', 4)
    for i in range(18):
        s = 1 if i % 2 else -1
        y = -L / 2 + 0.2 + (i // 2) * (L - 0.4) / 8
        sz = r_.uniform(0.15, 0.30)
        stone(p, (sz, sz * 1.3, sz * 0.7), (s * (W / 2 + 0.06), y, sz * 0.28), (0, 0, r_.uniform(0, 90)), 'stone', r_)
    # stove pipe through the roof panel
    p.cyl(0.05, 1.1, mat('steel'), loc=(0.62, -0.9, 1.75), seg=7)
    p.cyl(0.09, 0.05, mat('steel'), loc=(0.62, -0.9, 2.32), seg=7, r2=0.03)
    A.mesh('tent', p)
    return A


def supply_dump():
    A = Asset('supply_dump', 'camp', 'Supply dump: ammunition crates on dunnage, 200 L drums, jerrycans, a roped tarpaulin stack, '
              'under a garnished camouflage net on poles.')
    A.ground_plane()
    p = Part()
    r_ = rng(19)
    tim = mat('timber')
    # crate stacks on dunnage
    for x in (-3.0, -2.2, -1.4, -0.6):
        p.box((0.10, 1.2, 0.08), tim, loc=(x, 1.15, 0.04))
    for row in range(2):
        for col in range(3):
            for lvl in range(3 - (col + row) % 2):
                crate(p, (1.0, 0.45, 0.32), (-2.6 + col * 1.05, 1.4 - row * 0.5, 0.24 + lvl * 0.325), yaw=r_.uniform(-3, 3))
    crate(p, (0.62, 0.40, 0.30), (-0.2, 0.25, 0.15), yaw=24)
    crate(p, (0.62, 0.40, 0.30), (-0.9, -0.1, 0.15), yaw=-12)
    # shell boxes: long narrow cases stacked crosswise
    for k in range(4):
        crate(p, (1.25, 0.28, 0.24), (0.2, -1.55 + (k % 2) * 0.32, 0.12 + (k // 2) * 0.245), yaw=90 + r_.uniform(-3, 3), rope=False)
    # drums on a pallet, two lying
    p.box((2.6, 1.4, 0.10), tim, loc=(2.12, 0.92, 0.05))
    for i in range(7):
        x, y = 1.2 + (i % 4) * 0.62, 1.2 - (i // 4) * 0.62
        drum(p, (x, y, 0.54), mname='drum_green' if i % 3 else 'drum_blue')
    drum(p, (2.0, -1.0, 0.29), lying=True, yaw=70)
    drum(p, (2.6, -0.6, 0.29), lying=True, yaw=95)
    for i in range(6):
        jerrycan(p, (-0.6 + i * 0.2, -1.0 - (i % 2) * 0.02, 0.0), yaw=r_.uniform(-6, 6))
    # tarpaulin over a stack: draped, corners weighted, roped
    cx, cy, hw, hl, ht = -1.9, -1.4, 0.80, 0.60, 1.0
    n = 6
    grid = []
    for j in range(n + 1):
        row = []
        for i in range(n + 1):
            u, v = i / n * 2 - 1, j / n * 2 - 1
            e = max(abs(u), abs(v))
            if e <= 0.5:
                x, y, z = u * 2 * hw, v * 2 * hl, ht + 0.03 * math.sin(u * 5 + v * 3)
            else:
                k = (e - 0.5) / 0.5            # down the side, flaring out, folds at the corners
                fx, fy = (u / e) * hw, (v / e) * hl
                corner = (min(abs(u), abs(v)) / e) ** 3
                out = 1 + 0.16 * k + 0.20 * corner * k
                x, y, z = fx * out, fy * out, ht * (1 - k) + 0.02 + 0.05 * math.sin((u + v) * 9) * k
            row.append((cx + x, cy + y, max(0.015, z)))
        grid.append(row)
    p.sheet(grid, mat('canvas_dark', dirt=0.6), smooth=True, away=(cx, cy, 0.3))
    p.detail = 1
    for t in (-0.3, 0.3):
        p.tube([(cx + t * 2 * hw, cy - hl * 1.22, 0.03), (cx + t * 2 * hw, cy - hl * 1.02, ht * 0.6), (cx + t * 2 * hw, cy - hl * 0.5, ht + 0.03),
                (cx + t * 2 * hw, cy + hl * 0.5, ht + 0.03), (cx + t * 2 * hw, cy + hl * 1.02, ht * 0.6), (cx + t * 2 * hw, cy + hl * 1.22, 0.03)],
               0.012, mat('burlap'), seg=4)
    p.detail = 0
    # camouflage net: slung from six poles, hanging between them, skirts to pegs
    net = kit.camo_net()
    poles = [(-3.4, 2.4), (0.0, 2.55), (3.4, 2.4), (3.4, -2.3), (0.0, -2.45), (-3.4, -2.3)]
    for (x, y) in poles:
        log(p, (x, y, 0), (x * 0.985, y * 0.985, 2.36), 0.04)
    nx, ny = 12, 8
    grid = []
    for j in range(ny + 1):
        row = []
        for i in range(nx + 1):
            u, v = i / nx, j / ny
            x, y = -3.55 + 7.1 * u, -2.45 + 4.9 * v
            sag = 0.34 * (math.sin(math.pi * ((u * 2) % 1.0)) ** 2) * math.sin(math.pi * v) + 0.22 * math.sin(math.pi * v) ** 2
            scallop = 0.20 * math.sin(math.pi * ((u * 2) % 1.0)) ** 2 if v in (0, 1) else 0.0   # edge droops between the poles
            z = 2.34 - sag - scallop + r_.uniform(-0.03, 0.03)
            row.append((x, y, z))
        grid.append(row)
    p.sheet(grid, net, thick=0.035, smooth=True, rim=True)
    A.footprint(p)
    for (x, y) in poles:   # guys
        rod(p, (x, y, 2.34), (x * 1.22, y * 1.30, 0.03), 0.008, 'canvas_dark', 4)
    A.mesh('dump', p)
    return A


def artillery(destroyed=False):
    A = Asset('artillery_destroyed' if destroyed else 'artillery', 'artillery',
              'Towed 122 mm howitzer (D-30 class, generic) emplaced on three trails. turret = yaw, barrel = pitch, socket `muzzle`.')
    A.ground_plane()
    paint = mat('olive', mud=0.35)
    st = mat('steel', mud=0.4)
    gm = mat('gunmetal')
    p = Part()
    # central jack on a base plate, three box-section trails staked down
    p.cyl(0.44, 0.04, st, loc=(0, 0, 0.02), seg=14)
    p.cyl(0.20, 0.34, paint, loc=(0, 0, 0.19), seg=12)
    p.cyl(0.36, 0.14, paint, loc=(0, 0, 0.40), seg=14)
    for k, a in enumerate((180, 60, -60)):
        ra = a * D2R
        ln, zt = 3.2, 0.14
        if destroyed and k == 1:
            ra += 0.4
            ln, zt = 2.4, 0.3
        d = V((math.sin(ra), math.cos(ra), 0))
        end = d * ln + V((0, 0, zt))
        mid = (V((0, 0, 0.38)) + end) / 2
        yawd = -math.degrees(ra)
        pitch = math.degrees(math.atan2(0.38 - zt, ln))
        p.box((0.16, ln, 0.15), paint, loc=tuple(mid), rot=(-pitch, 0, yawd))
        p.box((0.40, 0.34, 0.05), st, loc=tuple(end - V((0, 0, zt - 0.03))), rot=(0, 0, yawd))
        p.cyl(0.03, 0.42, st, loc=tuple(end + d * 0.02 + V((0, 0, 0.08))), rot=(8, 0, yawd), seg=5)   # stake
        p.detail = 1
        p.box((0.20, 0.10, 0.19), st, loc=tuple(mid + d * 0.5), rot=(-pitch, 0, yawd))
        p.tube([tuple(mid - d * 0.4 + V((0, 0, 0.09))), tuple(mid - d * 0.25 + V((0, 0, 0.17))), tuple(mid - d * 0.05 + V((0, 0, 0.17))),
                tuple(mid + d * 0.10 + V((0, 0, 0.09)))], 0.012, st, seg=4)   # lifting handle
        p.detail = 0
    # ready rounds and cases beside the gun
    if not destroyed:
        crate(p, (1.0, 0.36, 0.28), (1.9, -1.3, 0.14), yaw=28, rope=False)
        crate(p, (1.0, 0.36, 0.28), (1.85, -1.35, 0.425), yaw=34, rope=False)
        p.detail = 1
        for k in range(4):
            p.cyl(0.062, 0.30, mat('brass'), loc=(1.25 + k * 0.15, -1.9, 0.15 if k < 3 else 0.062), rot=(0, 0, 0) if k < 3 else (90, 0, 40), seg=8)
        p.detail = 0
    A.mesh('trails', p)
    tz = 0.5
    yaw = 25 if destroyed else 0
    t = Part()
    t.cyl(0.48, 0.12, paint, loc=(0, 0, tz), seg=16)
    for s in (1, -1):
        t.poly_prism([(-0.5, 0), (0.6, 0), (0.30, 0.78), (0.0, 0.92), (-0.30, 0.78)], 0.05, paint, loc=(s * 0.30 - 0.025, 0, tz + 0.06), rot=(90, 0, 90))
        t.cyl(0.09, 0.08, st, loc=(s * 0.345, 0.1, tz + 0.85), rot=(0, 90, 0), seg=10)
        if not (destroyed and s > 0):
            mk = t.mark()
            wheel(t, 0.55, 0.26, (s * 1.02, -0.2, 0.78), hub='olive', axis='x', seg=16, outer=s, mud=0.5, state='burnt' if destroyed else None)
            tilt_about(t, t.since(mk), (s * 1.02, -0.2, 0.78), (0, 0, -s * 6))
        t.box((0.60, 0.11, 0.10), st, loc=(s * 0.66, -0.2, 0.78))       # stub axle on its suspension arm
        t.box((0.10, 0.36, 0.10), st, loc=(s * 0.40, -0.05, 0.70), rot=(-20, 0, 0))
    # shield: two plates with a gun port, the upper flap canted back
    for s in (1, -1):
        t.box((0.82, 0.03, 0.80), paint, loc=(s * 0.60, 0.55, tz + 0.72), rot=(-8, 0, 0))
        t.box((0.82, 0.03, 0.26), paint, loc=(s * 0.60, 0.455, tz + 1.235), rot=(-30, 0, 0))
        t.detail = 1
        t.box((0.05, 0.05, 0.60), st, loc=(s * 0.30, 0.50, tz + 0.75), rot=(-8, 0, 0))
        t.detail = 0
    # layer's side (left): sight, two handwheels
    t.box((0.10, 0.14, 0.20), gm, loc=(-0.46, 0.20, tz + 1.12))
    t.cyl(0.025, 0.14, mat('glass'), loc=(-0.46, 0.30, tz + 1.26), rot=(-60, 0, 0), seg=6)
    t.detail = 1
    for (y, z, ax) in ((0.05, 0.70, (0, 90, 0)), (-0.18, 0.55, (90, 0, 0))):
        t.torus(0.12, 0.013, st, loc=(-0.44, y, tz + z), rot=ax, seg=10, rseg=4)
        t.cyl(0.02, 0.10, st, loc=(-0.44, y, tz + z), rot=ax, seg=5)
    t.detail = 0
    turret = A.mesh('turret', t, pivot=(0, 0, tz), moving=True)
    turret.rotation_euler.z = yaw * D2R
    pz = tz + 0.85
    elev = -3 if destroyed else 8
    b = Part()
    b.box((0.40, 1.50, 0.34), paint, loc=(0, -0.15, pz - 0.02))           # cradle
    b.box((0.36, 0.44, 0.40), gm, loc=(0, -1.02, pz))                     # breech ring
    b.box((0.10, 0.30, 0.30), gm, loc=(0.21, -1.02, pz))                  # wedge block housing
    b.detail = 1
    b.tube([(0.26, -1.10, pz + 0.05), (0.38, -1.10, pz + 0.05), (0.38, -1.10, pz - 0.18)], 0.016, st, seg=4)   # breech lever
    b.detail = 0
    # recoil system above the barrel: buffer and recuperator in one housing
    b.box((0.30, 1.75, 0.20), paint, loc=(0, 0.55, pz + 0.28))
    for s in (1, -1):
        b.cyl(0.075, 0.50, paint, loc=(s * 0.08, 1.55, pz + 0.29), rot=(-90, 0, 0), seg=8)
    # tube: reinforce, taper, multi-baffle muzzle brake, towing lunette under it
    blk = mat('black')
    prof = [(0.14, 0.20), (0.14, 0.42), (0.115, 0.95), (0.092, 2.9), (0.086, 4.02), (0.10, 4.04), (0.13, 4.08), (0.13, 4.20), (0.105, 4.22),
            (0.105, 4.30), (0.13, 4.32), (0.13, 4.44), (0.105, 4.46), (0.105, 4.54), (0.13, 4.56), (0.13, 4.74), (0.075, 4.75), (0.062, 4.60), (0.0, 4.60)]
    b.lathe(prof, gm, seg=12, loc=(0, 0, pz), mats=[gm] * 16 + [blk, blk])
    b.torus(0.07, 0.022, st, loc=(0, 4.42, pz - 0.19), seg=8, rseg=4)
    b.box((0.06, 0.20, 0.08), st, loc=(0, 4.42, pz - 0.12))
    barrel = A.mesh('barrel', b, pivot=(0, 0.1, pz), parent='turret', moving=True)
    barrel.rotation_euler.x = elev * D2R
    A.socket('muzzle', (0, 4.75, pz), parent='barrel')
    if destroyed:
        debris(A, seed=51, n=10, radius=3.0)
    return A


def helipad():
    A = Asset('helipad', 'base', 'Forward helipad: 20 m gravel disc with painted stone circle and H, windsock, drums.')
    p = Part()
    p.cyl(10.0, 0.06, mat('concrete', dirt=0.6), loc=(0, 0, 0.03), seg=40)
    r_ = rng(23)
    for k in range(48):
        a = 2 * math.pi * k / 48
        sz = r_.uniform(0.25, 0.36)
        stone(p, (sz, sz * 0.85, sz * 0.5), (9.4 * math.cos(a), 9.4 * math.sin(a), 0.12), (0, 0, a / D2R + r_.uniform(-20, 20)), 'paint_white', r_)
    white = mat('paint_white', dirt=0.5)
    for s in (1, -1):
        p.box((0.9, 6.0, 0.012), white, loc=(s * 1.8, 0, 0.066), skip=('-z',))
    p.box((2.7, 0.9, 0.012), white, loc=(0, 0, 0.066), skip=('-z',))
    # windsock on a guyed mast
    p.cyl(0.04, 4.5, mat('steel'), loc=(11.5, 0, 2.25), seg=6)
    p.cyl(0.25, 1.3, mat('paint_yellow'), loc=(11.5, -0.7, 4.35), rot=(-90 + 8, 0, 0), r2=0.12, seg=10)
    p.torus(0.25, 0.012, mat('steel'), loc=(11.5, -0.06, 4.44), rot=(98, 0, 0), seg=10, rseg=3)
    for a in (30, 150, 270):
        rod(p, (11.5, 0, 3.0), (11.5 + 1.6 * math.cos(a * D2R), 1.6 * math.sin(a * D2R), 0.02), 0.008, 'black', 4)
    drum(p, (10.9, 2.4, 0.44))
    drum(p, (11.5, 2.7, 0.44), mname='drum_blue')
    A.mesh('pad', p)
    A.socket('touchdown', (0, 0, 0.07))
    return A


def helicopter():
    A = Asset('helicopter', 'helicopter', 'Medium transport helicopter (Mi-8 class, generic). `rotor` spins about +Y, `tail_rotor` about +X.')
    A.ground_plane()
    paint = mat('olive', dirt=0.25)
    st = mat('steel')
    glass = mat('glass')
    p = Part()
    # fuselage lathe along Y (nose +Y)
    prof = [(0.0, 5.6), (0.45, 5.55), (0.9, 5.2), (1.15, 4.6), (1.25, 3.5), (1.25, -0.8), (1.1, -1.6), (0.7, -2.3), (0.4, -2.7)]
    mk = p.mark()
    p.lathe(prof, paint, seg=18)
    for v in p.since(mk):
        v.co.z = v.co.z * 1.15 + 1.75
    # glazed nose: framed panes over the lower half too
    for (az, el) in ((0, 12), (-38, 10), (38, 10), (-20, -18), (20, -18), (-66, 6), (66, 6)):
        a, e = math.radians(az), math.radians(el)
        d = V((math.sin(a) * math.cos(e), math.cos(a) * math.cos(e), math.sin(e)))
        c = V((0, 4.35, 1.95)) + V((d.x * 1.02, d.y * 1.08, d.z * 0.95))
        q = d.to_track_quat('Z', 'Y').to_euler()
        p.box((0.52, 0.52, 0.03), glass, loc=tuple(c), rot=tuple(x / D2R for x in q))
    # cabin portholes and the sliding door
    for s in (1, -1):
        for k in range(4):
            p.cyl(0.21, 0.04, glass, loc=(s * 1.245, 2.6 - k * 0.85, 2.15), rot=(0, 90, 0), seg=10)
        p.box((0.03, 0.80, 1.35), paint, loc=(s * 1.26, 3.45, 1.75))
    # engines and gearbox fairing on the roof, intakes with dust domes, exhausts
    hump = [[(-0.60, y, 3.02), (-0.50, y, 3.42 + dz), (0.0, y, 3.56 + dz), (0.50, y, 3.42 + dz), (0.60, y, 3.02)]
            for (y, dz) in ((3.5, -0.20), (3.0, 0.0), (1.2, 0.04), (-0.3, 0.0), (-1.0, -0.22))]
    p.sheet(hump, paint, smooth=True, away=(0.0, None, 2.5))
    for s in (1, -1):
        p.cyl(0.30, 0.6, paint, loc=(s * 0.36, 3.45, 3.28), rot=(-90, 0, 0), seg=10)
        p.sphere(0.24, st, loc=(s * 0.36, 3.80, 3.28), scale=(1, 0.8, 1), seg=10, rings=6)
        p.cyl(0.22, 0.45, st, loc=(s * 0.72, -0.2, 3.20), rot=(-90 + 20, 0, s * 35), seg=10)
        p.cyl(0.40, 1.9, paint, loc=(s * 1.50, 0.6, 1.20), rot=(-90, 0, 0), seg=12, bevel=0.06)  # external tanks
        # main gear: oleo, drag strut, wheel
        rod(p, (s * 1.0, -0.5, 1.2), (s * 1.75, -0.6, 0.42), 0.055, st)
        rod(p, (s * 1.15, 0.5, 0.9), (s * 1.75, -0.55, 0.42), 0.035, st)
        rod(p, (s * 1.2, -0.6, 2.2), (s * 1.75, -0.6, 0.48), 0.045, st)
        wheel(p, 0.40, 0.26, (s * 1.80, -0.6, 0.40), hub='olive', axis='x', seg=14, outer=s, mud=0.3)
    wheel(p, 0.29, 0.14, (0.10, 4.3, 0.29), hub='olive', axis='x', seg=12, outer=1, mud=0.3)
    wheel(p, 0.29, 0.14, (-0.10, 4.3, 0.29), hub='olive', axis='x', seg=12, outer=-1, mud=0.3)
    rod(p, (0, 4.3, 0.29), (0, 4.1, 1.0), 0.05, st)
    # tail boom, pylon, stabilisers, bumper
    boom = []
    for (y, r, z) in ((-2.2, 0.55, 2.35), (-4.5, 0.36, 2.62), (-8.2, 0.24, 2.85), (-9.3, 0.20, 2.95)):
        boom.append([(r * math.cos(2 * math.pi * i / 10), y, z + r * math.sin(2 * math.pi * i / 10)) for i in range(10)])
    p.loft(boom, paint, smooth=True)
    p.fin(1.5, 0.75, 1.9, 0.14, paint, loc=(0, -9.5, 2.95), rot=(0, -90, 0), sweep=0.75)
    p.fin(0.7, 0.45, 1.3, 0.06, paint, loc=(0, -8.2, 2.85), rot=(0, 0, 0))
    p.fin(0.7, 0.45, 1.3, 0.06, paint, loc=(0, -8.2, 2.85), rot=(0, 180, 0))
    rod(p, (0, -8.9, 2.75), (0, -9.3, 2.0), 0.03, st)
    A.mesh('fuselage', p)
    # main rotor: hub, five drooping blades
    r = Part()
    r.cyl(0.30, 0.50, st, loc=(0, 1.0, 3.85), seg=10)
    r.cyl(0.42, 0.10, st, loc=(0, 1.0, 4.08), seg=10)
    for k in range(5):
        mk = r.mark()
        nseg = 5
        grid = [[(0.5 + 10.1 * i / nseg, c, -0.02 * (0.5 + 10.1 * i / nseg) ** 2 / 10.6) for i in range(nseg + 1)] for c in (-0.26, 0.26)]
        r.sheet(grid, mat('black'), thick=0.05, smooth=False)
        r.transform(M((0, 1.0, 4.10), (0, 0, k * 72)), verts=r.since(mk))
    A.mesh('rotor', r, pivot=(0, 1.0, 4.05), moving=True)
    tr = Part()
    tr.cyl(0.12, 0.2, st, loc=(0.25, -9.8, 3.9), rot=(0, 90, 0), seg=8)
    for k in range(3):
        tr.box((0.05, 1.55, 0.2), mat('black'), loc=(0.32, -9.8, 3.9), rot=(k * 60, 0, 0))
    A.mesh('tail_rotor', tr, pivot=(0.3, -9.8, 3.9), moving=True)
    A.socket('exhaust_L', (-0.85, -1.0, 3.1))
    A.socket('exhaust_R', (0.85, -1.0, 3.1))
    return A


# stone and sandbags are all high-frequency: their normal maps do not compress, so they ship at half size
STONE = {'ntex': 512, 'otex': 512}

BUILDERS = {
    # id: (builder, texture size, opts)
    'aaa_gun': (aaa_gun, 1024),
    'aaa_gun_destroyed': (lambda: aaa_gun(True), 512, {'burn': True}),
    'manpads_team': (manpads_team, 1024, {'otex': 512}),
    'sam_launcher': (sam_launcher, 1024),
    'sam_launcher_destroyed': (lambda: sam_launcher(True), 512, {'burn': True}),
    'radar': (radar, 1024),
    'radar_destroyed': (lambda: radar(True), 512, {'burn': True}),
    'truck': (lambda: truck(False), 1024),
    'truck_covered': (lambda: truck(True), 1024),
    'truck_destroyed': (lambda: truck(False, True), 1024, {'burn': True, 'otex': 512}),
    'sangar': (sangar, 1024, STONE),
    'bunker': (bunker, 1024, STONE),
    'bunker_destroyed': (lambda: bunker(True), 1024, STONE),
    'tent': (tent, 512),
    'supply_dump': (supply_dump, 1024, {'otex': 512}),
    'artillery': (artillery, 1024),
    'artillery_destroyed': (lambda: artillery(True), 512, {'burn': True}),
    'helipad': (helipad, 1024, {'lod1': False, 'ntex': 512, 'otex': 512}),
    'helicopter': (helicopter, 1024),
}
