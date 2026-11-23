"""6x6 military cargo truck: open bed, canvas tilt, and the burnt-out wreck.

An original bonneted design in the class of the 1970s-90s 5-tonne 6x6
trucks (Ural-4320 size: 7.4 x 2.5 x 2.7 m, 14.00-20 tyres, 3.5 + 1.4 m
wheelbase). No maker's marks, plates or unit markings.

One mesh node `body` (the game does not turn the wheels), socket `exhaust`
at the top of the stack. Front = +Y while modelling (three: -Z).
"""
import math

import kit
from kit import Asset, Part, mat, M, V, rng
from ground_parts import wheel, axle, leaf_spring, rod, crate, drum, jerrycan, debris, D2R

R_TYRE, W_TYRE = 0.61, 0.37
AXLES = (2.55, -0.95, -2.35)     # front, rear bogie
TRACK = 1.0                      # wheel centre, +-x
BED_Y0, BED_Y1 = 0.35, -3.70
BED_Z = 1.45                     # top of the bed floor
BED_HW = 1.22


def _rrect(hw, y0, y1, z, c):
    """Chamfered rectangle (plan), counter-clockwise from the rear left."""
    return [(-hw + c, y0, z), (hw - c, y0, z), (hw, y0 + c, z), (hw, y1 - c, z), (hw - c, y1, z), (-hw + c, y1, z),
            (-hw, y1 - c, z), (-hw, y0 + c, z)]


def _rr(hw, y0, y1, z, r, n=3):
    """Rounded rectangle (plan), counter-clockwise from the rear left: the
    corners are arcs of n segments, so the cab reads as pressed steel with
    radiused corners that catch the light, not as a folded box."""
    out = []
    for cx, cy, a0 in ((hw - r, y0 + r, -90), (hw - r, y1 - r, 0), (-hw + r, y1 - r, 90), (-hw + r, y0 + r, 180)):
        for k in range(n + 1):
            a = math.radians(a0 + 90 * k / n)
            out.append((cx + r * math.cos(a), cy + r * math.sin(a), z))
    return out


def bolt(p, loc, rot=(0, 0, 0), r=0.013, m=None):
    """Hex bolt head / rivet (LOD0 only)."""
    d = p.detail
    p.detail = 1
    p.cyl(r, 0.010, m or mat('steel'), loc=loc, rot=rot, seg=6)
    p.detail = d


PAINT = dict(dirt=0.6, mud=0.8)      # body colour: dust from the sills up, mud thrown over the lower panels


def _chassis(p, burnt, missing=()):
    st = mat('steel', mud=0.85)
    # ladder frame: two channel rails and cross-members
    for s in (1, -1):
        p.box((0.09, 7.15, 0.24), st, loc=(s * 0.42, -0.04, 1.02))
    for y in (3.46, 1.95, 0.55, -1.65, -3.56):
        p.box((0.75, 0.10, 0.18), st, loc=(0, y, 1.0), skip=('+x', '-x'))
    # axles, differentials, hubs
    for i, y in enumerate(AXLES):
        axle(p, y, R_TYRE, TRACK - 0.1, st, diff_x=0.16 if i == 0 else -0.05)
        for s in (1, -1):
            if (i, s) in missing:
                p.cyl(0.16, 0.10, st, loc=(s * (TRACK - 0.12), y, R_TYRE), rot=(0, 90, 0), seg=10)  # bare brake drum
                continue
            state = None
            if burnt:
                state = 'flat' if (i, s) == (0, -1) else 'burnt'
            wheel(p, R_TYRE, W_TYRE, (s * TRACK, y, R_TYRE), hub='olive', axis='x', seg=20, outer=s, mud=0.6, state=state)
            hx = s * (TRACK + 0.105)
            p.cyl(0.105, 0.11, mat('olive', dirt=0.6, mud=0.5), loc=(hx, y, R_TYRE), rot=(0, 90, 0), seg=12, bevel=0.012)
            p.cyl(0.045, 0.05, st, loc=(hx + s * 0.06, y, R_TYRE), rot=(0, 90, 0), seg=8)
            for k in range(8):
                a = math.radians(22.5 + 45 * k)
                bolt(p, (hx + s * 0.058, y + 0.078 * math.cos(a), R_TYRE + 0.078 * math.sin(a)), rot=(0, 90, 0), r=0.012, m=st)
    # front suspension: leaf packs and dampers
    for s in (1, -1):
        leaf_spring(p, s * 0.42, AXLES[0], 0.74, 1.35, st, up=1)
        p.detail = 1
        rod(p, (s * 0.52, AXLES[0] + 0.25, 0.66), (s * 0.50, AXLES[0] + 0.32, 1.10), 0.028, st, 6)
        p.detail = 0
        # rear bogie: an inverted pack rocking on a trunnion between the axles
        leaf_spring(p, s * 0.50, -1.65, 0.80, 1.55, st, leaves=5, up=-1)
        p.box((0.16, 0.26, 0.30), st, loc=(s * 0.48, -1.65, 0.88))
        p.detail = 1
        for y in AXLES[1:]:
            rod(p, (s * 0.36, -1.65, 0.98), (s * 0.34, y, R_TYRE + 0.12), 0.025, st, 5)  # torque rods
        p.detail = 0
    # transfer case, prop shafts
    p.box((0.46, 0.52, 0.40), st, loc=(0.06, 1.02, 0.84))
    p.detail = 1
    rod(p, (0.16, 1.28, 0.80), (0.16, AXLES[0] - 0.28, R_TYRE + 0.02), 0.035, st, 6)
    rod(p, (-0.05, 0.76, 0.80), (-0.05, AXLES[1] + 0.26, R_TYRE + 0.03), 0.035, st, 6)
    rod(p, (-0.05, AXLES[1] - 0.2, R_TYRE + 0.03), (-0.05, AXLES[2] + 0.26, R_TYRE + 0.03), 0.035, st, 6)
    # gearbox + engine sump, seen between the front wheels
    p.detail = 0
    p.box((0.50, 1.25, 0.42), st, loc=(0, 2.35, 0.98), skip=('+z',))
    # front bumper on its horns, guards, tow hooks
    p.box((2.42, 0.035, 0.25), st, loc=(0, 3.795, 0.90), bevel=0.008)
    for z in (1.012, 0.788):
        p.box((2.42, 0.15, 0.03), st, loc=(0, 3.735, z), bevel=0.006)
    for s in (1, -1):
        p.box((0.03, 0.15, 0.25), st, loc=(s * 1.20, 3.735, 0.90))
        for x in (0.34, 0.50, 1.05):
            for z in (0.84, 0.96):
                bolt(p, (s * x, 3.815, z), rot=(-90, 0, 0), m=st)
    for s in (1, -1):
        p.box((0.10, 0.34, 0.14), st, loc=(s * 0.42, 3.60, 0.98), skip=('-y',))
        p.detail = 1
        p.box((0.07, 0.05, 0.40), st, loc=(s * 0.50, 3.815, 0.99))
        p.torus(0.055, 0.016, st, loc=(s * 0.80, 3.84, 0.90), rot=(0, 90, 0), seg=8, rseg=4)
        p.detail = 0
    # rear cross-member: pintle hook and bumperettes
    p.box((2.10, 0.10, 0.16), st, loc=(0, -3.66, 1.00))
    p.detail = 1
    p.box((0.12, 0.16, 0.12), st, loc=(0, -3.75, 0.98))
    p.torus(0.05, 0.018, st, loc=(0, -3.86, 0.98), seg=8, rseg=4)
    for s in (1, -1):
        p.box((0.16, 0.10, 0.16), mat('rubber'), loc=(s * 0.80, -3.74, 1.0))
    p.detail = 0
    # exhaust: silencer under the frame, pipe up behind the cab (socket at its mouth)
    p.cyl(0.115, 0.80, st, loc=(0.74, 1.45, 0.80), rot=(-90, 0, 0), seg=10)
    p.tube([(0.74, 1.05, 0.80), (0.95, 0.90, 0.82), (1.12, 0.85, 1.05), (1.12, 0.85, 2.62)], 0.05, st, seg=7)
    p.cyl(0.072, 0.50, mat('gunmetal'), loc=(1.12, 0.85, 2.30), seg=8, cap=False)  # perforated heat shield
    # left: fuel tank on two straps; right: battery box and air reservoirs
    p.cyl(0.29, 1.05, mat('olive', **PAINT), loc=(-0.90, 0.28, 0.93), rot=(-90, 0, 0), seg=14, bevel=0.03)
    p.detail = 1
    for y in (0.0, 0.56):
        p.cyl(0.298, 0.05, st, loc=(-0.90, y, 0.93), rot=(-90, 0, 0), seg=14, cap=False)
    p.cyl(0.05, 0.07, st, loc=(-1.02, 0.55, 1.20), rot=(0, -25, 0), seg=8)  # filler
    p.detail = 0
    p.box((0.42, 0.56, 0.36), mat('olive', **PAINT), loc=(0.92, 0.28, 0.96), bevel=0.015)
    p.detail = 1
    p.box((0.44, 0.58, 0.03), st, loc=(0.92, 0.28, 1.15))
    p.cyl(0.095, 0.62, st, loc=(0.90, 0.28, 0.68), rot=(-90, 0, 0), seg=8)   # air reservoir
    p.detail = 0


def _cab(p, doors, burnt):
    paint = mat('olive', **PAINT)
    glass = mat('black') if burnt else mat('glass')
    gasket = mat('rubber', dirt=0.1)
    st = mat('steel', mud=0.5)
    # shell: sill, floor to belt, a pressed belt crease, tumblehome, and a roof that rolls over in three steps
    secs = [
        _rr(1.01, 0.82, 2.28, 1.17, 0.09),
        _rr(1.03, 0.80, 2.30, 1.22, 0.10),
        _rr(1.03, 0.80, 2.30, 1.98, 0.10),
        _rr(1.045, 0.79, 2.31, 2.01, 0.10),
        _rr(1.02, 0.81, 2.29, 2.05, 0.10),
        _rr(0.95, 0.86, 2.10, 2.56, 0.12),
        _rr(0.93, 0.88, 2.075, 2.635, 0.14),
        _rr(0.885, 0.925, 2.03, 2.688, 0.17),
        _rr(0.79, 1.01, 1.945, 2.718, 0.21),
        _rr(0.60, 1.16, 1.80, 2.730, 0.24),
    ]
    p.loft(secs, paint, smooth=True)
    # roof drip rail
    p.detail = 1
    for s in (1, -1):
        p.box((0.022, 1.20, 0.022), paint, loc=(s * 0.955, 1.48, 2.60))
    p.detail = 0
    # windshield: two panes in rubber, raked 19 degrees, a wiper on each
    rake = math.degrees(math.atan2(0.19, 0.54))
    nrm = V((0, math.cos(rake * D2R), math.sin(rake * D2R)))
    c = V((0, 2.195, 2.31))
    for s in (1, -1):
        p.box((0.78, 0.012, 0.47), gasket, loc=tuple(c + V((s * 0.415, 0, 0)) + nrm * 0.004), rot=(rake, 0, 0), skip=('-y',))
        p.box((0.72, 0.012, 0.41), glass, loc=tuple(c + V((s * 0.415, 0, 0)) + nrm * 0.010), rot=(rake, 0, 0), skip=('-y',))
        if not burnt:
            p.detail = 1
            p.box((0.016, 0.012, 0.34), mat('black'), loc=tuple(c + V((s * 0.43 - 0.10, -0.045, -0.13)) + nrm * 0.022), rot=(rake, 62, 0))
            p.detail = 0
    # windscreen frame: a pressed surround standing proud of the glass, centre pillar, corner screws
    up = V((0, -math.sin(rake * D2R), math.cos(rake * D2R)))
    for sg in (1, -1):
        p.box((1.72, 0.05, 0.045), paint, loc=tuple(c + up * (sg * 0.262) + nrm * 0.018), rot=(rake, 0, 0), bevel=0.01)
        p.box((0.045, 0.05, 0.57), paint, loc=tuple(c + V((sg * 0.84, 0, 0)) + nrm * 0.018), rot=(rake, 0, 0), bevel=0.01)
        for sx in (1, -1):
            bolt(p, tuple(c + V((sx * 0.84, 0, 0)) + up * (sg * 0.262) + nrm * 0.046), rot=(rake - 90, 0, 0), r=0.010, m=st)
    p.box((0.055, 0.055, 0.50), paint, loc=tuple(c + nrm * 0.020), rot=(rake, 0, 0), bevel=0.01)
    # cowl vent under the screen
    p.detail = 1
    p.box((0.50, 0.03, 0.05), st, loc=tuple(c - up * 0.34 + nrm * 0.012), rot=(rake, 0, 0))
    p.detail = 0
    # side and rear glazing
    lean = math.degrees(math.atan2(0.07, 0.54))
    for s in (1, -1):
        for (y, w, h) in ((1.68, 0.78, 0.40), (1.06, 0.20, 0.36)):
            p.box((0.012, w + 0.06, h + 0.06), gasket, loc=(s * 0.989, y, 2.31), rot=(0, -s * lean, 0), skip=('-x' if s > 0 else '+x',))
            p.box((0.012, w, h), glass, loc=(s * 0.995, y, 2.31), rot=(0, -s * lean, 0), skip=('-x' if s > 0 else '+x',))
    back = math.degrees(math.atan2(0.05, 0.54))
    p.box((1.00, 0.012, 0.34), gasket, loc=(0, 0.829, 2.33), rot=(-back, 0, 0), skip=('+y',))
    p.box((0.94, 0.012, 0.28), glass, loc=(0, 0.823, 2.33), rot=(-back, 0, 0), skip=('+y',))
    # doors: a proud skin with handle and hinges (separate parts so the wreck can open one)
    for s in (1, -1):
        d = Part()
        inner = '-x' if s > 0 else '+x'
        # shut line: a dark gap all round, then the door skin standing proud with radiused edges
        d.box((0.010, 1.10, 0.84), mat('black'), loc=(s * 1.033, 1.66, 1.61), skip=(inner,))
        d.box((0.030, 1.05, 0.79), paint, loc=(s * 1.043, 1.66, 1.61), skip=(inner,), bevel=0.012)
        d.box((0.012, 0.99, 0.035), paint, loc=(s * 1.060, 1.66, 1.50), skip=(inner,), bevel=0.006)   # pressed swage
        # handle in a dished recess, and the lock
        d.box((0.006, 0.19, 0.075), mat('black'), loc=(s * 1.059, 1.27, 1.86), skip=(inner,))
        d.box((0.022, 0.15, 0.022), st, loc=(s * 1.072, 1.27, 1.865), bevel=0.005)
        d.detail = 1
        d.cyl(0.013, 0.01, st, loc=(s * 1.062, 1.27, 1.80), rot=(0, 90, 0), seg=6)
        d.detail = 0
        # two barrel hinges on the front edge
        for z in (1.36, 1.86):
            d.cyl(0.020, 0.11, st, loc=(s * 1.058, 2.195, z), seg=8)
            d.box((0.012, 0.09, 0.07), paint, loc=(s * 1.060, 2.14, z))
        doors.append((s, d))
    # steps under each door, hung from the cab
    for s in (1, -1):
        for z, w in ((0.74, 0.30), (1.03, 0.22)):
            p.box((w, 0.52, 0.04), st, loc=(s * (1.00 + w / 2 - 0.04), 1.55, z))
        p.detail = 1
        for y in (1.32, 1.78):
            p.box((0.03, 0.04, 0.50), st, loc=(s * 1.00, y, 0.97))
        p.detail = 0
    # mirrors on C-frames
    for s in (1, -1):
        p.detail = 1
        p.tube([(s * 1.02, 2.22, 2.16), (s * 1.31, 2.34, 2.20), (s * 1.31, 2.34, 1.84), (s * 1.03, 2.24, 1.80)], 0.011, st, seg=4)
        p.detail = 0
        p.box((0.03, 0.16, 0.30), mat('black') if burnt else st, loc=(s * 1.325, 2.335, 2.03))
    # roof: two pressed ribs, a hatch, a blackout marker lamp
    p.detail = 1
    for s in (1, -1):
        p.box((0.05, 0.62, 0.016), paint, loc=(s * 0.34, 1.48, 2.722))
    p.box((0.07, 0.10, 0.06), st, loc=(0, 1.92, 2.735))
    p.detail = 0
    p.cyl(0.25, 0.045, paint, loc=(0, 1.42, 2.738), seg=16)
    p.torus(0.255, 0.020, paint, loc=(0, 1.42, 2.742), seg=16, rseg=5)
    p.cyl(0.215, 0.012, paint, loc=(0, 1.42, 2.768), seg=16)
    p.box((0.16, 0.05, 0.03), st, loc=(0, 1.16, 2.752))
    p.detail = 1
    p.box((0.10, 0.02, 0.03), st, loc=(0, 1.60, 2.785))
    for k in range(6):
        a = math.radians(30 + 60 * k)
        bolt(p, (0.235 * math.cos(a), 1.42 + 0.235 * math.sin(a), 2.764), r=0.009, m=st)
    p.detail = 0
    # air intake stack with a mushroom cap, right front corner
    p.cyl(0.055, 0.86, paint, loc=(0.985, 2.38, 2.28), seg=8)
    p.cyl(0.10, 0.09, paint, loc=(0.985, 2.38, 2.74), seg=10, r2=0.05)


def _nose(p, hood, burnt):
    paint = mat('olive', **PAINT)
    wing = mat('olive', dirt=0.7, mud=1.0)
    st = mat('steel', mud=0.6)
    blk = mat('black')

    def sec(y, w, zt, c=0.13, zb=1.18, peak=0.035):
        """Bonnet section: rolled shoulders and a raised centre crease."""
        pts = [(-w, y, zb), (w, y, zb), (w, y, zt - c)]
        for a in (30, 60):
            pts.append((w - c + c * math.cos(a * D2R), y, zt - c + c * math.sin(a * D2R)))
        pts += [(w - c, y, zt), (0.045, y, zt + peak * 0.8), (0.0, y, zt + peak), (-0.045, y, zt + peak * 0.8), (-w + c, y, zt)]
        for a in (60, 30):
            pts.append((-w + c - c * math.cos(a * D2R), y, zt - c + c * math.sin(a * D2R)))
        pts.append((-w, y, zt - c))
        return pts
    # bonnet: tapers and drops toward the radiator
    hood.loft([sec(2.30, 0.80, 1.96), sec(2.65, 0.78, 1.945), sec(3.00, 0.75, 1.91), sec(3.36, 0.71, 1.86), sec(3.52, 0.685, 1.82, 0.14),
               sec(3.585, 0.65, 1.76, 0.15, peak=0.02)], paint, smooth=True)
    hood.detail = 1
    hood.box((0.035, 1.24, 0.012), paint, loc=(0, 2.93, 1.925), rot=(-5.5, 0, 0))   # centre hinge
    for s in (1, -1):
        for k in range(7):  # side louvres: pressed slats standing out of the panel, raked back
            hood.box((0.030, 0.045, 0.26), paint, loc=(s * (0.792 - k * 0.0095), 2.50 + k * 0.095, 1.55), rot=(0, 0, s * -28), bevel=0.006)
        for k in range(6):  # panel rivets along the bonnet side
            bolt(hood, (s * (0.795 - k * 0.019), 2.42 + k * 0.20, 1.30), rot=(0, 90, 0), r=0.010, m=st)
        hood.box((0.03, 0.07, 0.05), st, loc=(s * 0.74, 3.25, 1.40))             # bonnet catch
    hood.detail = 0
    if burnt:
        p.box((1.10, 1.10, 0.55), blk, loc=(0, 2.95, 1.42))  # the engine, when the bonnet has lifted
    # radiator shell: dark core, surround, seven bars and a mid rail
    p.box((1.22, 0.05, 0.62), blk, loc=(0, 3.60, 1.49), skip=('-y',))
    p.box((1.36, 0.11, 0.07), paint, loc=(0, 3.625, 1.825))
    p.box((1.36, 0.11, 0.07), paint, loc=(0, 3.625, 1.165))
    for s in (1, -1):
        p.box((0.07, 0.11, 0.66), paint, loc=(s * 0.645, 3.625, 1.495))
    p.detail = 1
    for k in range(7):
        p.box((0.045, 0.05, 0.59), paint, loc=(-0.48 + k * 0.16, 3.655, 1.495))
    p.box((1.22, 0.04, 0.035), paint, loc=(0, 3.66, 1.50))
    p.detail = 0
    for s in (1, -1):
        # apron between bonnet and wing carries the lamps
        p.box((0.36, 0.07, 0.58), paint, loc=(s * 0.875, 3.52, 1.46))
        p.cyl(0.11, 0.13, st, loc=(s * 0.875, 3.585, 1.50), rot=(-90, 0, 0), seg=12)
        p.cyl(0.092, 0.02, blk if burnt else mat('lens', dirt=0.25), loc=(s * 0.875, 3.652, 1.50), rot=(-90, 0, 0), seg=12)
        p.detail = 1
        p.box((0.12, 0.05, 0.065), blk if burnt else mat('lens_amber', dirt=0.25), loc=(s * 0.875, 3.565, 1.685))
        p.torus(0.10, 0.012, st, loc=(s * 0.875, 3.67, 1.50), rot=(90, 0, 0), seg=10, rseg=4)  # lamp guard
        p.detail = 0
        # wing: flat-topped, angular, turned-down outer edge
        # wing: a pressed arch over the wheel with a crowned top, a rolled outer lip and a front valance
        prof = []
        for k in range(11):
            a = math.radians(20 + 126 * k / 10)
            prof.append((2.60 + 0.93 * math.cos(a), 0.60 + 0.87 * math.sin(a) ** 0.8))

        def inward(y, z, d):
            dy, dz = y - 2.60, z - 0.60
            n = math.hypot(dy, dz)
            return (y - dy / n * d, z - dz / n * d)
        grid = [[(s * 0.63, y, z - 0.012) for (y, z) in prof],
                [(s * 0.92, y, z + 0.012) for (y, z) in prof],
                [(s * 1.185, y, z - 0.008) for (y, z) in prof],
                [(s * 1.232, *inward(y, z, 0.030)) for (y, z) in prof],
                [(s * 1.240, *inward(y, z, 0.085)) for (y, z) in prof]]
        p.sheet(grid, wing, thick=0.03, smooth=True, rim=True)
        p.detail = 1
        p.box((0.05, 0.06, 0.30), st, loc=(s * 0.66, 2.10, 1.28))   # wing stay
        p.detail = 0


def _bed(p, tail, burnt, r_):
    wood = mat('olive', dirt=0.6, mud=0.7, kind='paintwood')
    floor = mat('timber', dirt=0.6)
    st = mat('steel', mud=0.6)
    paint = mat('olive', **PAINT)
    L = BED_Y0 - BED_Y1
    yc = (BED_Y0 + BED_Y1) / 2
    p.box((BED_HW * 2, L, 0.07), floor, loc=(0, yc, BED_Z - 0.035))
    for s in (1, -1):  # longitudinal bearers on the frame
        p.box((0.11, L - 0.1, 0.17), st, loc=(s * 0.42, yc, 1.255), skip=('+z',))
    p.detail = 1
    for k in range(7):  # cross bearers
        p.box((BED_HW * 2 - 0.04, 0.07, 0.075), st, loc=(0, BED_Y0 - 0.2 - k * (L - 0.4) / 6, 1.342), skip=('+z',))
    p.detail = 0
    # dropsides: three boards a side between steel stakes, a capping rail
    for s in (1, -1):
        for k in range(3):
            if burnt and r_.random() < 0.3:
                continue
            p.box((0.035, L - 0.06, 0.185), wood, loc=(s * (BED_HW - 0.02), yc, BED_Z + 0.0975 + k * 0.197))
        for k in range(5):
            y = BED_Y0 - 0.12 - k * (L - 0.24) / 4
            p.box((0.045, 0.07, 0.66), paint, loc=(s * (BED_HW + 0.02), y, BED_Z + 0.29), skip=('-z',))
        p.box((0.05, L, 0.03), paint, loc=(s * (BED_HW - 0.015), yc, BED_Z + 0.61))
    # headboard, taller than the sides
    for k in range(4):
        p.box((BED_HW * 2 - 0.04, 0.035, 0.185), wood, loc=(0, BED_Y0 - 0.02, BED_Z + 0.0975 + k * 0.197))
    for x in (-0.75, 0.0, 0.75):
        p.box((0.07, 0.045, 0.86), paint, loc=(x, BED_Y0 + 0.02, BED_Z + 0.39), skip=('-z',))
    # tailgate (own part: the wreck's has dropped)
    for k in range(3):
        tail.box((BED_HW * 2 - 0.04, 0.035, 0.185), wood, loc=(0, BED_Y1 + 0.02, BED_Z + 0.0975 + k * 0.197))
    tail.detail = 1
    for x in (-0.80, 0.80):
        tail.box((0.07, 0.02, 0.60), st, loc=(x, BED_Y1 - 0.005, BED_Z + 0.30))     # strap hinges
    for s in (1, -1):
        tail.box((0.05, 0.08, 0.10), st, loc=(s * (BED_HW - 0.03), BED_Y1 + 0.0, BED_Z + 0.50))  # latch
    tail.detail = 0
    # tail lamps, mud flaps
    for s in (1, -1):
        p.box((0.16, 0.05, 0.10), mat('black') if burnt else mat('lens_red', dirt=0.4), loc=(s * 1.02, BED_Y1 + 0.03, 1.30))
        if not burnt:
            p.sheet([[(s * 0.78, -3.12, 1.38), (s * 1.24, -3.12, 1.38)], [(s * 0.78, -3.16, 0.86), (s * 1.24, -3.16, 0.86)]],
                    mat('rubber', mud=0.9), thick=0.02, smooth=False, rim=True)


def _tilt(p, r_):
    """Canvas tilt over five bows: it hangs between them, the sides suck in,
    the hem laps the dropsides and is roped down."""
    canvas = mat('canvas', mud=0.25)
    dark = mat('canvas_dark')
    L = BED_Y0 - BED_Y1
    spans, sub = 4, 4
    hw, z_hem, z_eave, rise = BED_HW + 0.045, BED_Z + 0.36, BED_Z + 1.08, 0.50
    # cross-section parameter: (x, z, outward normal) from the left hem over the top to the right hem
    sec = []
    for k in range(5):
        z = z_hem + (z_eave - z_hem) * k / 4
        sec.append((-hw, z, (-1.0, 0.0)))
    for k in range(1, 12):
        a = math.pi * (1 - k / 12)
        cx, sz = math.cos(a), math.sin(a) ** 0.8
        sec.append((hw * cx, z_eave + rise * sz, (cx, sz)))
    for k in range(5):
        z = z_eave - (z_eave - z_hem) * k / 4
        sec.append((hw, z, (1.0, 0.0)))
    nrings = spans * sub + 1
    grid = []
    for j in range(nrings):
        t = (j % sub) / sub
        y = BED_Y0 + 0.02 - j * (L + 0.04) / (nrings - 1)
        hang = math.sin(math.pi * t) ** 2          # 0 on a bow, 1 mid-span
        row = []
        for i, (x, z, (nx, nz)) in enumerate(sec):
            side = abs(nx) > 0.92 and nz < 0.3
            lowness = max(0.0, 1 - (z - z_hem) / 0.5) if side else 0.0
            d = (0.032 if side else 0.050) * hang * (1 - 0.8 * lowness)
            d += r_.uniform(-0.006, 0.006)
            flare = 0.02 * lowness                # the hem stands off the boards
            row.append((x - nx * d + (1 if x > 0 else -1) * flare, y, z - nz * d))
        grid.append(row)
    p.sheet(grid, canvas, thick=0.028, smooth=True, rim=True)   # a real hem: the canvas has thickness seen edge-on
    for j, sgn in ((0, 1), (nrings - 1, -1)):   # end walls, billowed a little
        y = grid[j][0][1]
        p.fan(grid[j], (0.0, y + sgn * 0.05, (z_hem + z_eave + rise) / 2), canvas, away=(0.0, y - sgn, BED_Z + 0.9))
    # rear flap: lapped centre seam and three ties; front: nothing (it faces the cab)
    p.detail = 1
    yb = BED_Y1 - 0.045
    p.box((0.10, 0.012, 0.98), dark, loc=(0.0, yb, z_hem + 0.52))
    for z in (0.20, 0.52, 0.84):
        p.box((0.22, 0.016, 0.03), dark, loc=(0.0, yb - 0.004, z_hem + z))
    # lashing: rope from each hem eyelet down to a cleat on the dropside
    for s in (1, -1):
        for k in range(8):
            y = BED_Y0 - 0.25 - k * (L - 0.5) / 7
            p.tube([(s * (hw + 0.02), y - 0.12, z_hem + 0.03), (s * (BED_HW + 0.05), y, z_hem - 0.20), (s * (hw + 0.02), y + 0.12, z_hem + 0.03)],
                   0.008, dark, seg=3, caps=False)
    p.detail = 0


def _bows(p, r_, burnt):
    """Bare tilt bows (the wreck): some sprung, one down, scraps of canvas."""
    st = mat('steel')
    L = BED_Y0 - BED_Y1
    for k in range(5):
        y = BED_Y0 - 0.08 - k * (L - 0.16) / 4
        hw, z0, ze, rise = BED_HW - 0.02, BED_Z + 0.05, BED_Z + 1.06, 0.48
        pts = [(-hw, y, z0), (-hw, y, ze)]
        for i in range(1, 8):
            a = math.pi * (1 - i / 8)
            pts.append((hw * math.cos(a), y, ze + rise * math.sin(a) ** 0.8))
        pts += [(hw, y, ze), (hw, y, z0)]
        mk = p.mark()
        p.tube(pts, 0.022, st, seg=5)
        vs = p.since(mk)
        if k == 2:      # fallen into the bed
            p.transform(M((0.25, 0.3, BED_Z + 0.1)) @ M(rot=(78, 0, 12)) @ M((0, -y, -z0)), verts=vs)
        elif k in (1, 4):  # sprung outward / twisted by the heat
            for v in vs:
                h = max(0.0, v.co.z - ze) / rise
                v.co.x += 0.22 * h * (1 if k == 1 else -1)
                v.co.y += 0.30 * h * (1 if k == 1 else -0.6)
                v.co.z -= 0.16 * h
        if k in (0, 3):  # a charred scrap of the tilt still hanging
            w = 0.55
            grid = [[(-hw - 0.01, y + (j - 1) * w / 2 + r_.uniform(-0.05, 0.05), ze - i * 0.26 + r_.uniform(-0.04, 0.04) + (0.2 if i == 0 else 0))
                     for j in range(3)] for i in range(4)]
            if k == 3:
                grid = [[(-x, yy, zz) for (x, yy, zz) in row][::-1] for row in grid]
            p.sheet(grid, mat('canvas_dark'), thick=0.02, smooth=True, rim=True)


def _cargo(p, r_):
    # folded troop benches along the sides, crates, drums, cans, a tarp roll
    wood = mat('timber', dirt=0.5)
    for s in (1, -1):
        p.box((0.04, 3.4, 0.30), wood, loc=(s * (BED_HW - 0.07), -1.75, BED_Z + 0.36))
    crate(p, (0.95, 0.5, 0.36), (-0.52, -0.55, BED_Z + 0.18), yaw=0)
    crate(p, (0.95, 0.5, 0.36), (0.55, -0.50, BED_Z + 0.18), yaw=4)
    crate(p, (0.95, 0.5, 0.36), (-0.45, -0.58, BED_Z + 0.54), yaw=-6)
    crate(p, (0.8, 0.45, 0.32), (0.50, -1.25, BED_Z + 0.16), yaw=92)
    drum(p, (0.62, -2.95, BED_Z + 0.44))
    drum(p, (-0.02, -3.10, BED_Z + 0.44), mname='drum_blue')
    drum(p, (-0.66, -2.92, BED_Z + 0.44))
    for k in range(4):
        jerrycan(p, (-0.85 + k * 0.19, -2.05, BED_Z), yaw=r_.uniform(-5, 5))
    # rolled tarpaulin against the headboard
    p.cyl(0.17, 2.0, mat('canvas'), loc=(0, 0.08, BED_Z + 0.17), rot=(0, 90, 0), seg=10)
    p.detail = 1
    for x in (-0.6, 0.6):
        p.cyl(0.176, 0.05, mat('canvas_dark'), loc=(x, 0.08, BED_Z + 0.17), rot=(0, 90, 0), seg=10, cap=False)
    p.detail = 0


def truck(covered=False, destroyed=False):
    name = 'truck_destroyed' if destroyed else ('truck_covered' if covered else 'truck')
    A = Asset(name, 'vehicle', '6x6 military cargo truck (5-tonne class, generic, unmarked)' +
              (', burnt out: tyres gone, bare tilt bows' if destroyed else (' with canvas tilt' if covered else ', open bed with cargo')) +
              '. One mesh node `body`; socket `exhaust` at the stack.')
    A.ground_plane()
    bleach = kit.KINDS['paint']['bleach']
    kit.KINDS['paint']['bleach'] = 0.20
    r_ = rng(41 if destroyed else 7)
    p, hood, tail = Part(), Part(), Part()
    doors = []
    _chassis(p, destroyed, missing=((1, 1),) if destroyed else ())
    _cab(p, doors, destroyed)
    _nose(p, hood, destroyed)
    _bed(p, tail, destroyed, r_)
    # spare wheel upright between cab and bed, in a cradle
    if not destroyed:
        wheel(p, R_TYRE, W_TYRE, (0.0, 0.585, 1.62), hub='olive', axis='y', seg=18, outer=-1, mud=0.3)
    st = mat('steel', mud=0.4)
    p.box((1.30, 0.06, 0.08), st, loc=(0, 0.585, 1.04))
    p.detail = 1
    for s in (1, -1):
        p.box((0.05, 0.05, 0.75), st, loc=(s * 0.55, 0.585, 1.40))
    p.detail = 0
    if destroyed:
        _bows(p, r_, True)
        # bonnet thrown up on its hinge, near door hanging open, tailgate dropped
        hood.transform(M((0, 2.30, 1.90)) @ M(rot=(34, 0, 5)) @ M((0, -2.30, -1.90)))
        for s, d in doors:
            if s < 0:
                d.transform(M((s * 1.03, 2.22, 0)) @ M(rot=(0, 0, 58)) @ M((-s * 1.03, -2.22, 0)))
        tail.transform(M((0, BED_Y1, BED_Z)) @ M(rot=(-168, 0, 0)) @ M((0, -BED_Y1, -BED_Z)))
        p.box((0.02, 0.96, 0.70), mat('black'), loc=(-1.022, 1.70, 1.62))  # the gutted cab through the open door
    elif covered:
        _tilt(p, r_)
    else:
        _cargo(p, r_)
    p.merge(hood)
    p.merge(tail)
    for s, d in doors:
        p.merge(d)
    if destroyed:
        # down on its rims, slewed, nose in the dirt on the side with the wheel gone
        p.transform(M((0, 0, -0.165)) @ M(rot=(1.6, 3.2, 0)))
    A.mesh('body', p)
    kit.KINDS['paint']['bleach'] = bleach
    A.socket('exhaust', (1.12, 0.85, 2.65))
    if destroyed:
        debris(A, seed=41, n=14, radius=4.5)
    return A
