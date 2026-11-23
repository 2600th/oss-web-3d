"""Seated jet pilot for the MiG-21 cockpit (player and hostile jets).

blender -b --factory-startup --python tools/blender/build_pilot.py
node tools/blender/write-catalog.mjs

Writes public/models/pilot.glb (LOD0, player, ~10k tris) and pilot_lod1.glb
(hostile jets, ~1.5k tris) plus assets/authoring/build/manifest/pilot.json.

Everything is placed in *aircraft model space* (three: x right, y up, nose -Z,
metres; origin = the baked mig21.glb origin), measured on the cockpit with
tools/blender/probe_cockpit.py:
  pilot eye            (0, 0.22, -2.95)
  seat cushion top     y -0.49 (aft) .. -0.59 (front), z -2.73 .. -3.15
  seat back            z -2.70 at y -0.45, z -2.55 at y 0
  canopy inside        y 0.40 .. 0.43 above the head
  stick grip           axis x 0, y -0.27 .. -0.15, z -3.30 .. -3.33, r ~0.022
  throttle grip        (-0.288, -0.257, -3.16), left console
  floor / pedals       y -0.75 at z -3.8
So the GLB is parented to the aircraft model with an identity transform.

Nodes: `pilot` (root) > `pilot_body` (torso, limbs, harness, gloves, boots)
and `pilot_head` (helmet, visor, mask, upper hose) whose origin is the top of
the neck, so the runtime can turn the head (rotation.y = yaw, +x = nod down).
In the cockpit view the runtime hides `pilot_head` only: the camera sits
inside it, the body below the eye stays (hands on the stick and throttle).

Look: plain sage-green flight suit, dark olive harness webbing, grey helmet
with the dark visor down, olive rubber oxygen mask and ribbed hose, dark
leather gloves, black boots. No insignia, name tags, unit patches or flags.
Reference for proportions: seated anthropometry of a 50th-percentile male
(sitting eye height ~0.79 m, shoulder breadth ~0.46 m, buttock-knee ~0.60 m;
ANSUR II summary tables) scaled to the measured eye point and seat.
"""
import math
import os
import sys

import bmesh
import bpy
from mathutils import Matrix, Vector

sys.path.insert(0, os.path.dirname(__file__))
import common as C  # noqa: E402
import kit  # noqa: E402

V = Vector

kit.PALETTE.update({
    'suit_sage': ((0.112, 0.128, 0.082), 0.90, 0.0),
    'suit_seam': ((0.105, 0.118, 0.076), 0.92, 0.0),
    'webbing': ((0.040, 0.042, 0.028), 0.85, 0.0),
    'helmet': ((0.40, 0.41, 0.40), 0.32, 0.0),
    'helmet_trim': ((0.060, 0.062, 0.060), 0.45, 0.0),
    'liner': ((0.030, 0.032, 0.026), 0.95, 0.0),
    'visor': ((0.010, 0.010, 0.013), 0.05, 0.55),
    'mask': ((0.040, 0.044, 0.034), 0.60, 0.0),
    'hose': ((0.075, 0.082, 0.058), 0.70, 0.0),
    'glove': ((0.032, 0.024, 0.018), 0.55, 0.0),
    'boot': ((0.014, 0.014, 0.014), 0.42, 0.0),
    'kneeboard': ((0.52, 0.52, 0.48), 0.75, 0.0),
})


def T(p):
    """three.js model space -> Blender (x, -z, y)."""
    return V((p[0], -p[2], p[1]))


def mat(name):
    return kit.mat(name, dirt=0.0, var=0.06, scale=14.0)


# ---------------------------------------------------------------- geometry
def catmull(points, sub):
    """Catmull-Rom through `points` (list of (Vector, extra...)), `sub` steps per span."""
    out = []
    n = len(points)
    for i in range(n - 1):
        p0 = points[max(i - 1, 0)]
        p1, p2 = points[i], points[i + 1]
        p3 = points[min(i + 2, n - 1)]
        for k in range(sub):
            t = k / sub
            t2, t3 = t * t, t * t * t
            out.append(tuple(
                0.5 * ((2 * b) + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3)
                for a, b, c, d in zip(p0, p1, p2, p3)))
    out.append(tuple(points[-1]))
    return out


def loft(part, pts, m, side=V((1, 0, 0)), seg=16, sub=4, caps=True, ribs=None):
    """Tube through three-space points [(x, y, z, ra, rb), ...]; ra along `side`
    (Blender axis), rb across. Ends closed with a slightly domed cap.
    `ribs` = (period_rings, depth) gives a corrugated hose."""
    raw = [(*T(p[:3]), p[3], p[4]) for p in pts]
    path = catmull(raw, sub) if len(raw) > 2 else raw

    def f():
        bm = part.bm
        rings = []
        for i, q in enumerate(path):
            c = V(q[:3])
            a_prev = V(path[max(i - 1, 0)][:3])
            a_next = V(path[min(i + 1, len(path) - 1)][:3])
            t = (a_next - a_prev).normalized()
            a = (side - t * side.dot(t))
            if a.length < 1e-4:
                a = t.orthogonal()
            a.normalize()
            b = t.cross(a).normalized()
            ra, rb = q[3], q[4]
            if ribs and 0 < i < len(path) - 1 and (i // ribs[0]) % 2:
                ra, rb = ra + ribs[1], rb + ribs[1]
            rings.append([bm.verts.new(c + a * (ra * math.cos(2 * math.pi * j / seg)) + b * (rb * math.sin(2 * math.pi * j / seg)))
                          for j in range(seg)])
        faces = []
        for r0, r1 in zip(rings, rings[1:]):
            for j in range(seg):
                k = (j + 1) % seg
                faces.append(bm.faces.new((r0[j], r0[k], r1[k], r1[j])))
        if caps:
            for idx, sgn in ((0, -1), (-1, 1)):
                q = path[idx]
                c = V(q[:3])
                nb = V(path[1 if idx == 0 else -2][:3])
                t = (c - nb).normalized()
                pole = bm.verts.new(c + t * min(q[3], q[4]) * 0.45)
                r = rings[idx]
                for j in range(seg):
                    k = (j + 1) % seg
                    faces.append(bm.faces.new((r[j], r[k], pole) if idx == -1 else (r[k], r[j], pole)))
        bmesh.ops.recalc_face_normals(bm, faces=faces)
    return part._run(f, m, True)


def ellipsoid_patch(part, centre, axes, m, az=(-180, 180), el=(-90, 90), naz=24, nel=12, thick=0.0, cut=None,
                    frame=None):
    """Patch of an ellipsoid (three-space centre and semi-axes x, y, z) between
    azimuth `az` (degrees, 0 = forward/-Z, +90 = right/+X) and elevation `el`.
    thick > 0 makes a closed shell (inner surface scaled down by `thick`).
    cut(az, el) -> bool drops cells. frame: optional 3x3 rotation (three space)."""
    cx, cy, cz = centre
    ax, ay, az_ = axes

    def pt(a, e, s):
        a, e = math.radians(a), math.radians(e)
        x = math.sin(a) * math.cos(e) * ax * s
        y = math.sin(e) * ay * s
        z = -math.cos(a) * math.cos(e) * az_ * s
        v = V((x, y, z))
        if frame is not None:
            v = frame @ v
        return T((cx + v.x, cy + v.y, cz + v.z))

    def f():
        bm = part.bm
        A = [az[0] + (az[1] - az[0]) * i / naz for i in range(naz + 1)]
        E = [el[0] + (el[1] - el[0]) * j / nel for j in range(nel + 1)]
        full = az[1] - az[0] >= 360
        layers = [1.0] + ([1.0 - thick] if thick > 0 else [])
        grids = []
        for s in layers:
            g = [[bm.verts.new(pt(a, e, s)) for e in E] for a in (A[:-1] if full else A)]
            grids.append(g)
        na = len(grids[0])
        faces = []
        keep = {}
        for gi, g in enumerate(grids):
            for i in range(na if full else na - 1):
                i2 = (i + 1) % na
                for j in range(nel):
                    am, em = (A[i] + A[i + 1]) / 2, (E[j] + E[j + 1]) / 2
                    if cut and cut(am, em):
                        continue
                    keep[(i, j)] = True
                    q = (g[i][j], g[i2][j], g[i2][j + 1], g[i][j + 1])
                    if gi == 1:
                        q = q[::-1]
                    faces.append(bm.faces.new(q))
        if thick > 0:
            # rims where a kept cell borders a dropped / outside cell
            o, n = grids
            for (i, j) in list(keep):
                i2 = (i + 1) % na
                nbrs = [((i, j - 1), (i, j), (i2, j)), ((i, j + 1), (i2, j + 1), (i, j + 1)),
                        (((i - 1) % na if full else i - 1, j), (i, j + 1), (i, j)), (((i + 1) % na if full else i + 1, j), (i2, j), (i2, j + 1))]
                for nb, (a1, b1), (a2, b2) in nbrs:
                    if nb in keep:
                        continue
                    try:
                        faces.append(bm.faces.new((o[a1][b1], o[a2][b2], n[a2][b2], n[a1][b1])))
                    except ValueError:
                        pass
        allv = [v for g in grids for col in g for v in col]
        loose = [v for v in allv if not v.link_faces]
        bmesh.ops.delete(bm, geom=loose, context='VERTS')
        # poles: merge the coincident ring vertices
        bmesh.ops.remove_doubles(bm, verts=[v for v in allv if v.is_valid], dist=1e-5)
        bmesh.ops.recalc_face_normals(bm, faces=[f_ for f_ in faces if f_.is_valid])
    return part._run(f, m, True)


def ribbon(part, pts3, normals3, width, thick, m):
    """Flat strap through three-space points with outward normals (three space)."""
    P = [T(p) for p in pts3]
    N = [T(n).normalized() for n in normals3]

    def f():
        bm = part.bm
        rings = []
        for i, (p, n) in enumerate(zip(P, N)):
            t = (P[min(i + 1, len(P) - 1)] - P[max(i - 1, 0)]).normalized()
            b = t.cross(n).normalized()
            n2 = b.cross(t).normalized()
            rings.append([bm.verts.new(p + b * sx * width / 2 + n2 * sy * thick / 2)
                          for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1))])
        faces = []
        for r0, r1 in zip(rings, rings[1:]):
            for j in range(4):
                k = (j + 1) % 4
                faces.append(bm.faces.new((r0[j], r0[k], r1[k], r1[j])))
        faces.append(bm.faces.new(rings[0][::-1]))
        faces.append(bm.faces.new(rings[-1]))
        bmesh.ops.recalc_face_normals(bm, faces=faces)
    return part._run(f, m, False)


def rot_to(direction):
    """Matrix (Blender space) turning local +Y onto `direction` (three space)."""
    d = T(direction).normalized()
    return V((0, 1, 0)).rotation_difference(d).to_matrix().to_4x4()


# ---------------------------------------------------------------- the figure
EYE = (0.0, 0.22, -2.95)
NECK_TOP = (0.0, 0.165, -2.845)   # head pivot (top of the cervical spine)
HEAD_C = (0.0, 0.243, -2.866)     # helmet centre
HELMET = (0.128, 0.142, 0.152)    # semi-axes x, y, z -> top at y 0.385 (canopy 0.42)

STICK_AXIS = ((0.0, -0.272, -3.296), (0.0, -0.158, -3.33))
STICK_R = 0.022
THROTTLE_AXIS = ((-0.288, -0.292, -3.155), (-0.288, -0.212, -3.165))
THROTTLE_R = 0.026

SAGE = SEAM = WEB = HELM = TRIM = LINER = VISOR = MASK = HOSE = GLOVE = BOOT = METAL = BOARD = None


def make_materials():
    """After kit.Asset() (which resets the file)."""
    global SAGE, SEAM, WEB, HELM, TRIM, LINER, VISOR, MASK, HOSE, GLOVE, BOOT, METAL, BOARD
    SAGE, SEAM, WEB = mat('suit_sage'), mat('suit_seam'), mat('webbing')
    TRIM = mat('helmet_trim')
    HELM, LINER, VISOR, MASK, HOSE = mat('helmet'), mat('liner'), mat('visor'), mat('mask'), mat('hose')
    GLOVE, BOOT, METAL, BOARD = mat('glove'), mat('boot'), mat('aluminium'), mat('kneeboard')


def build_body():
    P = kit.Part()
    # torso: pelvis -> chest -> collar; ra = half width (x), rb = half depth (front-back)
    loft(P, [
        (0, -0.515, -2.835, 0.135, 0.100),
        (0, -0.455, -2.815, 0.170, 0.125),
        (0, -0.330, -2.775, 0.158, 0.110),
        (0, -0.180, -2.745, 0.160, 0.112),
        (0, -0.040, -2.725, 0.178, 0.118),
        (0, 0.045, -2.735, 0.165, 0.105),
        (0, 0.095, -2.765, 0.105, 0.080),
        (0, 0.125, -2.790, 0.062, 0.058),
    ], SAGE, side=V((1, 0, 0)), seg=24, sub=4)
    # neck (suit collar / comforter) up into the helmet
    loft(P, [(0, 0.10, -2.79, 0.058, 0.056), (0, 0.17, -2.84, 0.052, 0.052), (0, 0.205, -2.86, 0.05, 0.05)],
         LINER, seg=12, sub=2)
    # arms: shoulder (inside the torso) -> deltoid -> elbow -> wrist
    arms = {
        'R': [(0.13, 0.045, -2.725, 0.058, 0.058), (0.198, 0.015, -2.73, 0.060, 0.058), (0.205, -0.12, -2.84, 0.052, 0.050),
              (0.192, -0.252, -2.955, 0.046, 0.044), (0.13, -0.256, -3.09, 0.040, 0.038), (0.055, -0.246, -3.205, 0.033, 0.031)],
        'L': [(-0.13, 0.045, -2.725, 0.058, 0.058), (-0.198, 0.015, -2.73, 0.060, 0.058), (-0.232, -0.13, -2.77, 0.052, 0.050),
              (-0.252, -0.262, -2.81, 0.046, 0.044), (-0.276, -0.255, -2.95, 0.040, 0.038), (-0.292, -0.240, -3.075, 0.033, 0.031)],
    }
    for side, pts in arms.items():
        loft(P, pts, SAGE, side=V((0, 0, 1)), seg=16, sub=3)
    # legs: hip -> knee -> ankle (into the boot shaft)
    for sx in (-1, 1):
        loft(P, [
            (sx * 0.085, -0.43, -2.84, 0.088, 0.088),
            (sx * 0.115, -0.425, -2.97, 0.085, 0.082),
            (sx * 0.150, -0.415, -3.15, 0.074, 0.070),
            (sx * 0.168, -0.400, -3.300, 0.062, 0.060),
            (sx * 0.170, -0.470, -3.420, 0.056, 0.054),
            (sx * 0.170, -0.560, -3.560, 0.050, 0.048),
            (sx * 0.170, -0.620, -3.660, 0.044, 0.042),
        ], SAGE, side=V((1, 0, 0)), seg=16, sub=3)
        # knee bulge / seam
        loft(P, [(sx * 0.168, -0.392, -3.30, 0.066, 0.062), (sx * 0.169, -0.43, -3.36, 0.06, 0.058)], SEAM, seg=12, sub=1)
        # thigh cargo pocket (outer side)
        P.box((0.018, 0.16, 0.12), SEAM, loc=T((sx * 0.215, -0.42, -3.04)), rot=(0, 0, -sx * 9), bevel=0.006)
        # boot: shaft + foot
        loft(P, [(sx * 0.170, -0.590, -3.610, 0.050, 0.049), (sx * 0.170, -0.655, -3.700, 0.047, 0.046),
                 (sx * 0.170, -0.690, -3.730, 0.046, 0.040)], BOOT, seg=12, sub=2, caps=True)
        loft(P, [(sx * 0.170, -0.700, -3.670, 0.038, 0.030), (sx * 0.171, -0.700, -3.760, 0.048, 0.038),
                 (sx * 0.173, -0.705, -3.870, 0.045, 0.032), (sx * 0.175, -0.712, -3.945, 0.032, 0.022)],
             BOOT, side=V((1, 0, 0)), seg=12, sub=3)
    # kneeboard strapped on the right thigh
    P.box((0.13, 0.19, 0.008), BOARD, loc=T((0.155, -0.338, -3.14)), rot=(-6, 0, -6), bevel=0.002)
    P.box((0.15, 0.025, 0.012), WEB, loc=T((0.155, -0.342, -3.07)), rot=(-6, 0, -6))
    # breast pockets and the front zip seam
    for sx in (-1, 1):
        P.box((0.085, 0.006, 0.095), SEAM, loc=T((sx * 0.085, 0.0, -2.842)), rot=(0, 0, 0), bevel=0.003)
    P.box((0.010, 0.006, 0.40), SEAM, loc=T((0.0, -0.17, -2.860)), rot=(-8, 0, 0))
    return P


def build_gloves(P):
    def grip_hand(axis, r, palm_side, wrist):
        a0, a1 = V(axis[0]), V(axis[1])
        up = (a1 - a0).normalized()
        fwd = V((0, 0, -1))
        fwd = (fwd - up * fwd.dot(up)).normalized()
        right = up.cross(fwd).normalized() * -1  # +X
        # four fingers wrapped from the palm side round the front
        for i in range(4):
            h = a0 + up * (0.020 + i * 0.021)
            fr = 0.0105 - i * 0.0007
            R = r + fr
            pts = []
            for k in range(7):
                ang = math.radians(-20 + 200 * k / 6)  # 0 = palm side, 90 = front, 180 = far side
                d = right * palm_side * math.cos(ang) + fwd * math.sin(ang)
                pts.append((*(h + d * R), fr, fr))
            loft(P, pts, GLOVE, side=V((0, 0, 1)), seg=8, sub=2)
        # palm and back of the hand behind / beside the grip
        pc = a0 + up * 0.05 + right * palm_side * (r + 0.017) + (-fwd) * 0.02
        P.sphere(1.0, GLOVE, loc=T(pc), scale=(0.019, 0.042, 0.04), seg=14, rings=10)
        # thumb over the top of the grip
        tb = a0 + up * 0.095
        loft(P, [(*(tb + right * palm_side * 0.03 + (-fwd) * 0.02), 0.012, 0.012),
                 (*(tb + up * 0.012 + right * palm_side * 0.005 - fwd * 0.004), 0.011, 0.011),
                 (*(tb + up * 0.006 - right * palm_side * 0.016 + fwd * 0.012), 0.010, 0.010)], GLOVE, seg=8, sub=2)
        # wrist cuff from the forearm to the palm
        loft(P, [(*V(wrist), 0.036, 0.034), (*(V(wrist) + (pc - V(wrist)) * 0.55), 0.032, 0.028), (*pc, 0.02, 0.02)],
             GLOVE, side=V((0, 0, 1)), seg=12, sub=2)
    grip_hand(STICK_AXIS, STICK_R, +1, (0.055, -0.246, -3.205))
    grip_hand(THROTTLE_AXIS, THROTTLE_R, -1, (-0.292, -0.240, -3.075))


def build_harness(P, body_obj):
    """Straps laid on the body surface by ray casts against the built body."""
    dg = bpy.context.evaluated_depsgraph_get()
    sc = bpy.context.scene

    def hit(p, d, back=0.12):
        o, dd = T(p), T(d).normalized()
        o = o - dd * back
        ok, loc, nrm, _, ob, _ = sc.ray_cast(dg, o, dd)
        if not ok:
            return None
        return (loc.x, loc.z, -loc.y), (nrm.x, nrm.z, -nrm.y)

    def strap(points, dirs, width=0.042, thick=0.007, off=0.006, m=WEB, back=0.12):
        pts, nrm = [], []
        for p, d in zip(points, dirs):
            h = hit(p, d, back)
            if not h:
                continue
            q, n = h
            pts.append(tuple(q[i] + n[i] * off for i in range(3)))
            nrm.append(n)
        if len(pts) >= 2:
            ribbon(P, pts, nrm, width, thick, m)
        return pts

    FWD, DOWN, OUT = (0, 0, 1), (0, -1, 0), None
    buckle = None
    for sx in (-1, 1):
        # shoulder strap: from the seat back, over the shoulder, down the chest
        pts = [(sx * 0.10, 0.12, -2.66), (sx * 0.105, 0.12, -2.72), (sx * 0.10, 0.12, -2.79)]
        dirs = [DOWN, DOWN, DOWN]
        for y in (0.06, 0.0, -0.06, -0.12, -0.18, -0.235):
            x = sx * (0.10 - (0.06 - y) * 0.16)
            pts.append((x, y, -2.95))
            dirs.append(FWD)
        strap(pts, dirs)
        # lap belt from the hip to the buckle
        lp = []
        ld = []
        for k in range(6):
            t = k / 5
            x = sx * (0.175 - 0.16 * t)
            y = -0.30 - 0.03 * math.sin(math.pi * t)
            lp.append((x, y, -2.98 if t > 0.25 else -2.82))
            ld.append(FWD if t > 0.25 else (-sx, 0, 0.3))
        strap(lp, ld, width=0.05)
        # leg strap round the top of the thigh
        gp, gd = [], []
        for k in range(5):
            t = k / 4
            gp.append((sx * (0.06 + 0.13 * t), -0.36 - 0.02 * math.sin(math.pi * t), -3.02))
            gd.append(DOWN)
        strap(gp, gd, width=0.038, back=0.05)
    # quick-release box on the belly
    h = hit((0, -0.26, -2.95), FWD)
    if h:
        q, n = h
        c = V(q) + V(n) * 0.012
        P.cyl(0.036, 0.018, METAL, loc=T(c), rot=(90, 0, 0), seg=16, bevel=0.003)
        P.cyl(0.024, 0.024, WEB, loc=T(c), rot=(90, 0, 0), seg=12)
    # oxygen / comms connector on the left chest and the hose down into the seat
    h = hit((-0.075, -0.09, -2.95), FWD)
    if h:
        q, n = h
        c = V(q) + V(n) * 0.012
        P.cyl(0.020, 0.03, METAL, loc=T(c), rot=(90, 0, 0), seg=12)
        loft(P, [(*c, 0.016, 0.016), (c.x - 0.03, c.y - 0.10, c.z + 0.02, 0.016, 0.016),
                 (-0.16, -0.30, -2.86, 0.016, 0.016), (-0.21, -0.40, -2.78, 0.016, 0.016)],
             HOSE, seg=8, sub=4, ribs=(1, 0.0035))
        return tuple(c)
    return (-0.075, -0.09, -2.86)


def build_head(connector):
    H = kit.Part()
    hc = V(HEAD_C)
    # liner / head form inside the shell (shows only through the open bottom)
    H.sphere(1.0, LINER, loc=T(hc + V((0, -0.01, 0.0))), scale=(HELMET[0] * 0.9, HELMET[2] * 0.9, HELMET[1] * 0.9),
             seg=16, rings=10)

    # shell: open at the bottom, cut higher at the face (visor and mask cover it)
    def shell_cut(a, e):
        front = abs(a) < 62
        return e < (-14 if front else -58 + 18 * max(0.0, (abs(a) - 120) / 60))
    ellipsoid_patch(H, HEAD_C, HELMET, HELM, az=(-180, 180), el=(-70, 90), naz=32, nel=16, thick=0.09, cut=shell_cut)
    # visor housing along the brow and the centre track
    ellipsoid_patch(H, HEAD_C, (HELMET[0] + 0.012, HELMET[1] + 0.012, HELMET[2] + 0.013), TRIM,
                    az=(-74, 74), el=(10, 30), naz=16, nel=3, thick=0.12)
    H.box((0.02, 0.06, 0.012), TRIM, loc=T(hc + V((0, HELMET[1] + 0.004, -0.05))), rot=(28, 0, 0), bevel=0.004)
    # visor down: tinted, wraps the face from brow to the mask
    ellipsoid_patch(H, HEAD_C, (HELMET[0] + 0.006, HELMET[1] + 0.004, HELMET[2] + 0.010), VISOR,
                    az=(-70, 70), el=(-34, 12), naz=18, nel=6, thick=0.035)
    # oxygen mask: a rounded cone pointing forward-down from the mouth
    base = hc + V((0, -0.083, -0.098))
    axis = V((0, -0.42, -1.0)).normalized()
    Rm = rot_to(axis)
    # mask shell, then the exhalation valve (metal) on its tip
    prof = [(0.050, 0.0), (0.054, 0.018), (0.047, 0.045), (0.034, 0.068), (0.026, 0.076),
            (0.021, 0.077), (0.021, 0.094), (0.0, 0.096)]
    faces = H.lathe(prof, MASK, seg=16, mats=[MASK, MASK, MASK, MASK, METAL, METAL, METAL])
    vs = {v for f_ in faces for v in f_.verts}
    for v in vs:
        v.co.z *= 0.86
    H.transform(Matrix.Translation(T(base)) @ Rm, verts=list(vs))
    tip = base + axis * 0.09
    # mask harness to bayonets on the helmet sides
    for sx in (-1, 1):
        bay = hc + V((sx * (HELMET[0] - 0.006), -0.045, -0.055))
        H.box((0.012, 0.03, 0.03), TRIM, loc=T(bay + V((sx * 0.006, 0, 0))), bevel=0.003)
        ribbon(H, [tuple(base + V((sx * 0.046, 0.012, -0.005))), tuple(bay + V((sx * 0.004, 0, -0.006)))],
               [(sx, 0.2, -0.3), (sx, 0.1, 0)], 0.016, 0.004, MASK)
    # hose: from the valve, under the chin, to the chest connector
    c = V(connector)
    loft(H, [(*(tip + axis * 0.012), 0.017, 0.017), (*(tip + V((0, -0.06, 0.01))), 0.017, 0.017),
             (*(V((-0.035, 0.03, -2.99))), 0.017, 0.017), (*(c + V((0.0, 0.03, -0.02))), 0.017, 0.017), (*c, 0.016, 0.016)],
         HOSE, seg=8, sub=5, ribs=(1, 0.0035))
    return H, tip, axis


def main():
    A = kit.Asset('pilot', 'pilot', notes=(
        'Seated jet pilot in aircraft model space: parent to the MiG model with an identity transform '
        '(eye at (0, 0.22, -2.95)). pilot_head pivots at the top of the neck (rotation.y = look, +x = nod down); '
        'hide pilot_head in the cockpit view. Sage flight suit, no insignia. LOD1 is for hostile jets. '
        'Built by tools/blender/build_pilot.py.'))
    make_materials()
    body = build_body()
    build_gloves(body)
    body_obj = A.mesh('pilot_body', body, pivot=(0, 0, 0), smooth_angle=60)
    bpy.context.view_layer.update()
    P2 = kit.Part()
    connector = build_harness(P2, body_obj)
    harness = A.mesh('pilot_harness', P2, pivot=(0, 0, 0), smooth_angle=60)
    # join harness into the body node
    C.select_only([body_obj, harness], active=body_obj)
    bpy.ops.object.join()
    A.nodes.pop('pilot_harness', None)
    A.world.pop('pilot_harness', None)
    head, tip, axis = build_head(connector)
    head_obj = A.mesh('pilot_head', head, pivot=T(NECK_TOP), smooth_angle=60, moving=True)
    # point the mask valve cylinder (last 12-segment cylinder before the bayonets) along the axis: done in
    # build_head by construction (rot), so nothing to fix here.
    A.socket('pilot_eye', T(EYE), parent='pilot_head')
    print('PILOT tris', C.tri_count(A.meshes()))
    args = C.argv()
    if args and args[0] == 'preview':
        preview(A, args[1] if len(args) > 1 else os.path.join(C.BUILD, 'pilot_preview'))
        return
    baked = A.bake(size=512, ao_samples=48, ao_mix=0.45)
    baked['noDetail'] = True
    info = A.export(tex=512, lod1_tex=128, lod1_ratio=0.16)
    print('BUILT pilot', [(l['triangles'], l['bytes']) for l in info['lods']])


def preview(A, out, with_jet=True):
    """Fit check: the unbaked figure in the decoded mig21 cockpit (canopy hidden)."""
    if with_jet and os.path.exists(C.MIG_DECODED):
        before = set(bpy.data.objects)
        bpy.ops.import_scene.gltf(filepath=C.MIG_DECODED)
        for o in set(bpy.data.objects) - before:
            if o.name.startswith(('canopy_glass', 'glass_misc')):
                o.hide_render = True
    C.setup_render(res=(1000, 750), samples=16)
    C.sky_world(strength=1.4)
    C.sun(direction=(-0.35, 0.45, -0.8), energy=4.5)
    views = {
        'side': ((1.6, 0.25, -2.95), (0, -0.2, -3.0), 32),
        'front_high': ((0.0, 0.75, -4.3), (0, -0.15, -2.95), 34),
        'rear_high': ((-0.9, 1.3, -1.6), (0, -0.1, -3.0), 34),
        'three_q': ((1.3, 0.9, -4.0), (0, -0.1, -2.95), 34),
        'chase': ((-2.2, 1.6, -0.6), (0, -0.1, -2.9), 30),
        'eye_down': (EYE, (0.0, -0.45, -3.35), 74),
        'eye_left': (EYE, (-0.6, -0.3, -3.1), 74),
        'stick': ((0.2, -0.03, -3.36), (0.0, -0.22, -3.3), 22),
        'throttle': ((0.0, -0.04, -3.3), (-0.29, -0.24, -3.15), 22),
    }
    only = os.environ.get('PILOT_VIEWS')
    if only:
        views = {k: v for k, v in views.items() if k in only.split(',')}
    for name, (loc, tgt, lens) in views.items():
        cam = C.camera(T(loc), look_at=T(tgt), lens=lens if lens < 60 else 18, name=name)
        if name.startswith('eye'):
            A.nodes['pilot_head'].hide_render = True
            cam.data.clip_start = 0.05
        else:
            A.nodes['pilot_head'].hide_render = False
        C.render(os.path.join(out, f'pilot_{name}.png'))


if __name__ == '__main__':
    main()
