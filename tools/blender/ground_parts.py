"""Shared pieces for the ground builders (assets_ground.py, assets_truck.py):
wheels, sandbags, dry-stone walls, crates, drums, jerrycans, bars, debris.

Blender frame: FRONT = +Y, UP = +Z, RIGHT = +X, metres.
"""
import math

import bmesh

import kit
from kit import Part, mat, M, V, rng

D2R = math.pi / 180


# ------------------------------------------------------------------ wheels
# (radius / R, lateral / half-width): outer face (+) to inner face (-).
# hub cap, flange with the stud ring, dished disc with hand holes, rim lip,
# sidewall bulge, shoulder, tread; the inner side is plain (it faces the axle).
_WHEEL = [(0.0, 0.62), (0.15, 0.62), (0.20, 0.46), (0.37, 0.42), (0.52, 0.26), (0.57, 0.66), (0.61, 0.82),
          (0.70, 0.97), (0.84, 0.98), (0.95, 0.84), (1.0, 0.42), (1.0, -0.42), (0.95, -0.84), (0.72, -0.97),
          (0.56, -0.62), (0.0, -0.46)]


def wheel(p, r, w, loc, tyre='rubber', hub='olive', seg=18, axis='x', tread=True, outer=1, mud=0.5, state=None):
    """Road wheel: one lathe about the axle carrying wheel coordinates in the
    aux UVs, so kit.tyre() can bake tread blocks, sidewall ribs, the stud ring
    and the hand holes into the normal map and the colour.
    [models polish 2] replaces the lathed tyre + ~35 box lugs per wheel (about
    400 of a wheel's 1,100 triangles, and a third of a vehicle's UV atlas).
    `outer` = +1 / -1: which way the dished face points along the axle.
    `state`: 'burnt' (rubber gone, on the rim) or 'flat' (deflated)."""
    hw = w / 2
    prof = [(a * r, b * hw * outer) for a, b in _WHEEL]
    rot = (0, 0, -90) if axis == 'x' else (0, 0, 0)
    mk = p.mark()
    p.lathe(prof, kit.tyre(hub, mud), seg=seg, loc=loc, rot=rot, aux=(r, hw))
    vs = p.since(mk)
    c = V(loc)
    ax = V((1, 0, 0)) if axis == 'x' else V((0, 1, 0))
    if state == 'burnt':
        # the tyre burnt away: a crust of char and bead wire on the rim
        for v in vs:
            d = v.co - c
            lat = d.dot(ax)
            rad = d - ax * lat
            L = rad.length
            if L > 0.6 * r:
                v.co = c + ax * lat * 0.9 + rad * ((0.6 * r + (L - 0.6 * r) * 0.38) / L)
    elif state == 'flat':
        floor = c.z - 0.80 * r
        for v in vs:
            if v.co.z < floor + 0.10 * r:
                d = v.co - c
                lat = d.dot(ax)
                squash = min(1.0, (floor + 0.10 * r - v.co.z) / (0.3 * r))
                v.co += ax * lat * 0.22 * squash
                v.co.z = max(v.co.z, floor - 0.01 * squash)


def axle(p, y, z, half, m, diff_x=0.16, diff_r=0.2, tube=0.07):
    """Live axle: tube between the wheels with a differential housing."""
    p.cyl(tube, half * 2, m, loc=(0, y, z), rot=(0, 90, 0), seg=8, cap=False)
    p.sphere(diff_r, m, loc=(diff_x, y, z), scale=(0.9, 1.0, 1.0), seg=10, rings=6)
    p.cyl(diff_r * 0.45, 0.2, m, loc=(diff_x, y + diff_r * 0.9, z), rot=(-90, 0, 0), seg=8)  # pinion nose


def leaf_spring(p, x, y, z, length, m, leaves=4, width=0.08, up=1):
    """Stack of spring leaves along Y, the longest against the axle seat."""
    p.detail = 1
    for k in range(leaves):
        L = length * (1 - 0.2 * k)
        p.box((width, L, 0.022), m, loc=(x, y, z + up * k * 0.024))
    p.box((width + 0.03, 0.14, 0.024 * leaves + 0.04), m, loc=(x, y, z + up * 0.024 * (leaves - 1) / 2))  # U-bolt plate
    p.detail = 0


# ------------------------------------------------------------------ small parts
def log(p, a, b, r, mname='timber', seg=7):
    a, b = V(a), V(b)
    d = b - a
    L = d.length
    q = d.normalized().to_track_quat('Z', 'Y').to_euler()
    p.cyl(r, L, mat(mname) if isinstance(mname, str) else mname, loc=tuple((a + b) / 2), rot=tuple(x / D2R for x in q), seg=seg)


def rod(p, a, b, r, mname='steel', seg=5):
    log(p, a, b, r, mname, seg)


def sandbag(p, loc, yaw=0.0, size=(0.58, 0.34, 0.16), mname='burlap', seed=0):
    """A filled bag: boxy in plan, slumped, with a flat belly where it beds on
    the course below and a pinched, tied end."""
    r_ = rng(int(seed * 7919 + loc[0] * 131 + loc[1] * 977 + loc[2] * 53) & 0xffff)
    mk = p.mark()
    p.sphere(1.0, mat(mname), seg=10, rings=6)
    sx, sy, sz = size[0] / 2, size[1] / 2, size[2] / 2
    lump = [r_.uniform(-0.07, 0.07) for _ in range(6)]
    mtx = M(loc, (r_.uniform(-3, 3), r_.uniform(-3, 3), yaw))
    for v in p.since(mk):
        x, y, z = v.co
        # superellipse: squarer in plan, fuller in section
        x = math.copysign(abs(x) ** 0.62, x)
        y = math.copysign(abs(y) ** 0.70, y)
        z = math.copysign(abs(z) ** 0.80, z)
        if z < 0:
            z *= 0.72            # flat belly
        pinch = max(0.0, x - 0.72) / 0.28   # tied neck at +X
        y *= 1 - 0.45 * pinch
        z *= 1 - 0.35 * pinch
        z -= 0.10 * (1 - min(1.0, abs(x) * 1.2)) * (1 if z > 0 else 0)  # slump in the middle
        k = 1 + lump[int((math.atan2(y, x) + math.pi) / (2 * math.pi) * 5.999)]
        v.co = mtx @ V((x * sx * k, y * sy * k, z * sz))


def sandbag_ring(p, R, courses=2, start=0.0, end=360.0, seed=1, centre=(0, 0), z0=0.0):
    r_ = rng(seed)
    n = max(3, int((end - start) * D2R * R / 0.55))
    for c in range(courses):
        for i in range(n):
            a = (start + (end - start) * (i + 0.5 * (c % 2)) / n) * D2R
            if (c % 2) and i == n - 1 and end - start < 360:
                continue
            x, y = centre[0] + R * math.sin(a), centre[1] + R * math.cos(a)
            sandbag(p, (x, y, z0 + 0.075 + c * 0.135), yaw=-a / D2R + 90 + r_.uniform(-7, 7), seed=seed + c * 31 + i)


def stone(p, size, loc, rot=(0, 0, 0), mname='stone', r_=None, jitter=0.16):
    """One quarried / field stone: a box with every corner pushed about, so no
    two are alike and no face is square. The rounded arrises and the surface
    come from the normal bake (a geometric bevel cost 30 triangles a stone)."""
    mk = p.mark()
    p.box((1, 1, 1), mat(mname))
    mtx = M(loc, rot, size)
    for v in p.since(mk):
        j = V((r_.uniform(-jitter, jitter), r_.uniform(-jitter, jitter), r_.uniform(-jitter, jitter)))
        v.co = mtx @ (v.co + j)


def stone_wall(p, path, height=1.1, thick=0.6, seed=3, mname='stone', course_h=0.22, cap=True):
    """Dry-stone wall along a polyline [(x, y), ...]: coursed, battered (wider
    at the foot), joints broken between courses, with through-stones and a
    row of flatter coping stones."""
    r_ = rng(seed)
    ncourse = max(1, int(height / course_h))
    for (x0, y0), (x1, y1) in zip(path, path[1:]):
        L = math.hypot(x1 - x0, y1 - y0)
        ang = math.atan2(x1 - x0, y1 - y0)
        for c in range(ncourse):
            top = cap and c == ncourse - 1
            t = -r_.uniform(0.0, 0.25)
            taper = 1 - 0.30 * c / max(1, ncourse - 1)
            while t < L:
                sl = r_.uniform(0.40, 0.75) if top else r_.uniform(0.26, 0.58)
                sl = min(sl, L - t + 0.06)
                if sl < 0.12:
                    break
                sh = course_h * (r_.uniform(0.55, 0.75) if top else r_.uniform(0.86, 1.14))
                st = thick * taper * r_.uniform(0.82, 1.04)
                f = (t + sl / 2) / L
                cx, cy = x0 + (x1 - x0) * f, y0 + (y1 - y0) * f
                m = mname if r_.random() > 0.28 else 'stone_dark'
                stone(p, (st, sl * 0.97, sh), (cx, cy, c * course_h + sh / 2),
                      (r_.uniform(-4, 4), r_.uniform(-4, 4), -ang / D2R + r_.uniform(-6, 6)), m, r_)
                t += sl


def rubble(p, n, radius, seed=1, centre=(0, 0), size=(0.12, 0.34), z=0.0, mname='stone', inner=0.0):
    """Loose stones scattered round a position."""
    r_ = rng(seed)
    for _ in range(n):
        a, rr = r_.uniform(0, 2 * math.pi), math.sqrt(r_.uniform(max(inner, 0.2 * radius) ** 2, radius ** 2))
        s = r_.uniform(*size)
        stone(p, (s, s * r_.uniform(0.7, 1.3), s * r_.uniform(0.45, 0.8)),
              (centre[0] + rr * math.cos(a), centre[1] + rr * math.sin(a), z + s * 0.22),
              (r_.uniform(-15, 15), r_.uniform(-15, 15), r_.uniform(0, 180)), mname if r_.random() > 0.3 else 'stone_dark', r_)


def crate(p, size, loc, yaw=0.0, mname='crate', rope=True):
    """Ammunition crate: boarded box, two end battens, a lid lip, rope beckets."""
    sx, sy, sz = size
    R = M(loc, (0, 0, yaw))
    p.box(size, mat(mname), loc=loc, rot=(0, 0, yaw))
    tim = mat('timber')
    for k in (-0.36, 0.36):  # battens wrap the sides and the top
        p.box((0.045, sy + 0.03, sz + 0.03), tim, loc=tuple(R @ V((sx * k, 0, 0.0))), rot=(0, 0, yaw))
    p.detail = 1
    p.box((sx + 0.012, sy + 0.012, 0.022), mat(mname), loc=tuple(R @ V((0, 0, sz / 2 - 0.05))), rot=(0, 0, yaw))  # lid seam
    for s in (1, -1):
        p.box((0.03, 0.05, 0.035), mat('steel'), loc=tuple(R @ V((sx * 0.12 * s, -sy / 2 - 0.008, sz * 0.18))), rot=(0, 0, yaw))  # hasps
        if rope:
            p.torus(0.055, 0.009, mat('burlap'), loc=tuple(R @ V((s * (sx / 2 + 0.006), 0, 0.02))), rot=(0, 90, yaw), seg=6, rseg=4, arc=180)
    p.detail = 0


def drum(p, loc, lying=False, yaw=0.0, mname='drum_green'):
    """200 L drum: two rolling hoops, chime rims, bungs on the head."""
    h, r = 0.88, 0.29
    prof = [(0.0, h / 2 - 0.012), (r - 0.012, h / 2 - 0.012), (r - 0.004, h / 2), (r, h / 2 - 0.01), (r - 0.006, h / 2 - 0.03),
            (r - 0.006, 0.17), (r + 0.006, 0.145), (r - 0.006, 0.12), (r - 0.006, -0.12), (r + 0.006, -0.145), (r - 0.006, -0.17),
            (r - 0.006, -h / 2 + 0.03), (r, -h / 2 + 0.01), (r - 0.004, -h / 2), (0.0, -h / 2)]
    rot = (0, 0, yaw) if lying else (90, 0, yaw)   # lathe axis is +Y: stand it up unless lying
    p.lathe(prof, mat(mname), seg=14, loc=loc, rot=rot)
    axis = M(rot=rot).to_3x3() @ V((0, 1, 0))
    side = M(rot=rot).to_3x3() @ V((1, 0, 0))
    p.detail = 1
    p.cyl(0.03, 0.02, mat('steel'), loc=tuple(V(loc) + axis * (h / 2 - 0.006) + side * 0.17),
          rot=tuple(a / D2R for a in axis.to_track_quat('Z', 'Y').to_euler()), seg=6)
    p.detail = 0


def jerrycan(p, loc, yaw=0.0, mname='olive'):
    """20 L can: pressed body, three-bar handle, spout cap."""
    m = mat(mname)
    R = M(loc, (0, 0, yaw))
    p.box((0.165, 0.34, 0.40), m, loc=tuple(R @ V((0, 0, 0.20))), rot=(0, 0, yaw))
    p.box((0.165, 0.22, 0.07), m, loc=tuple(R @ V((0, -0.04, 0.42))), rot=(0, 0, yaw), taper=(0.85, 0.8))
    p.detail = 1
    for dx in (-0.05, 0.0, 0.05):
        p.box((0.014, 0.15, 0.014), m, loc=tuple(R @ V((dx, -0.03, 0.47))), rot=(0, 0, yaw))
    p.cyl(0.028, 0.05, mat('steel'), loc=tuple(R @ V((0, 0.12, 0.44))), rot=(-35, 0, yaw), seg=6)
    p.detail = 0


def debris(A, seed=1, n=10, radius=2.0, mname='olive'):
    """Torn plate and fragments thrown clear of a wreck."""
    r_ = rng(seed)
    d = Part()
    for i in range(n):
        a = r_.uniform(0, 2 * math.pi)
        rr = r_.uniform(0.6, radius)
        s = (r_.uniform(0.08, 0.45), r_.uniform(0.08, 0.55), r_.uniform(0.012, 0.09))
        mk = d.mark()
        d.box(s, mat(r_.choice([mname, 'steel', 'stone_dark'])), loc=(0, 0, 0))
        mtx = M((rr * math.cos(a), rr * math.sin(a), s[2] / 2 + 0.03), (r_.uniform(-22, 22), r_.uniform(-22, 22), r_.uniform(0, 180)))
        for v in d.since(mk):  # bent, not sawn
            v.co.z += 0.25 * v.co.x * v.co.y / max(s[0], s[1]) + r_.uniform(-0.01, 0.01)
            v.co = mtx @ v.co
    A.mesh('debris', d)
