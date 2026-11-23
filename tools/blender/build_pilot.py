"""Seated jet pilot for the MiG-21 cockpit (player and hostile jets).

blender -b --factory-startup --python tools/blender/build_pilot.py
node tools/blender/write-catalog.mjs

Writes public/models/pilot.glb (LOD0, player) and pilot_lod1.glb (hostile
jets) plus assets/authoring/build/manifest/pilot.json.

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

Nodes: `pilot` (root) > `pilot_body` (torso, limbs, G-suit, harness, life
preserver, gloves, boots) and `pilot_head` (helmet, visor, mask, hose) whose
origin is the top of the neck, so the runtime can turn the head (rotation.y =
yaw, +x = nod down). In the cockpit view the runtime hides `pilot_head` only:
the camera sits inside it; the body below the eye stays.

[models polish 2] 1990s fast-jet kit, no insignia, names, patches or flags:
  hard helmet (ZSh-5 class: off-white shell, visor cover with a centre lock,
  dark visor down, edge beading, ear bulges), rubber oxygen mask with a hard
  shell, valve and corrugated hose on side straps, comms lead;
  sage flight suit with creases at the joints (normal map), anti-g suit over
  the abdomen, thighs and calves with laced seams and a hose, torso harness
  with chest strap, lap belt, leg loops and adjusters, a horseshoe life
  preserver round the neck, leather gloves with gauntlets, soled boots,
  kneeboard, pockets.
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
    'webbing': ((0.105, 0.100, 0.070), 0.88, 0.0),
    'helmet': ((0.56, 0.56, 0.52), 0.26, 0.0),
    'helmet_trim': ((0.030, 0.031, 0.030), 0.55, 0.0),
    'liner': ((0.022, 0.022, 0.020), 0.95, 0.0),
    'visor': ((0.012, 0.012, 0.016), 0.04, 0.55),
    'mask': ((0.040, 0.045, 0.038), 0.72, 0.0),
    'mask_shell': ((0.16, 0.165, 0.155), 0.40, 0.0),
    'hose': ((0.085, 0.092, 0.070), 0.65, 0.0),
    'boot': ((0.020, 0.018, 0.016), 0.55, 0.0),
    'sole': ((0.012, 0.012, 0.012), 0.85, 0.0),
    'kneeboard': ((0.060, 0.062, 0.058), 0.6, 0.0),
    'paper': ((0.62, 0.61, 0.56), 0.85, 0.0),
    'skin': ((0.44, 0.28, 0.19), 0.55, 0.0),
    'eye': ((0.02, 0.016, 0.014), 0.3, 0.0),
    'hardware': ((0.50, 0.50, 0.48), 0.30, 1.0),
})
kit.SURF.update({'webbing': 'fabric', 'helmet': 'paint', 'helmet_trim': 'rubber', 'liner': 'plain', 'visor': 'glass',
                 'mask': 'rubber', 'mask_shell': 'plain', 'hose': 'rubber', 'boot': 'plain', 'sole': 'rubber',
                 'kneeboard': 'plain', 'paper': 'plain', 'skin': 'plain', 'eye': 'plain',
                 'hardware': 'metal'})

SAGE = (0.118, 0.132, 0.086)       # flight suit
GSUIT = (0.070, 0.082, 0.052)      # anti-g suit, darker and greener
LPU = (0.150, 0.118, 0.062)        # stowed life preserver: faded khaki cover
LEATHER = (0.060, 0.042, 0.028)    # gloves


def T(p):
    """three.js model space -> Blender (x, -z, y)."""
    return V((p[0], -p[2], p[1]))


def mat(name):
    return kit.mat(name, dirt=0.0, var=0.06, scale=14.0)


def cloth(key, col, rough=0.9, fold=1.0, lace=False, var=0.08, leather=False, stitch=False):
    """Cloth with creases that wrap the limb it is on. The lofts write
    aux = (around 0..1, along in metres) and aux2.x = how hard the cloth is
    working there (elbow, knee, waist); the creases are ridged noise sampled
    on a cylinder so they run round the limb with no seam. `lace` adds the
    anti-g suit's laced seams down the inside and outside of the leg."""
    m = bpy.data.materials.get(key)
    if m:
        return m
    m, N = kit.new_material(key)
    a1 = N.xyz(N.uv('aux'))
    u, v, work = a1['X'], a1['Y'], N.xyz(N.uv('aux2'))['X']
    ang = N.mul(u, 2 * math.pi)
    cylv = N.vec(N.mul(N.math('COSINE', ang), 0.30), N.mul(N.math('SINE', ang), 0.30), N.mul(v, 15.0))
    n1 = N.noise(1.0, 3.0, 0.55, vec=cylv, distortion=0.7)
    crease = N.ramp(N.inv(N.math('ABSOLUTE', N.math('SUBTRACT', N.mul(n1, 2.0), 1.0))), 0.50, 1.0)
    slow = N.noise(11.0, 3.0, 0.5, distortion=0.5)
    grain = N.noise(380.0, 2.0, 0.5)
    h = N.add(N.add(N.mul(N.mul(crease, work), 1.7 * fold), N.mul(slow, 0.55 * fold)), N.mul(grain, 0.03 if leather else 0.07))
    big = N.noise(5.0, 3.0, 0.5)
    c = N.mix(big, [x * (1 - var) for x in col], [min(1, x * (1 + var)) for x in col])
    c = N.mix(N.mul(N.mul(N.inv(crease), work), 0.42), c, [x * 0.62 for x in col])   # shade in the valleys
    c = N.mix(N.mul(N.ramp(grain, 0.3, 0.7), 0.10), c, [min(1, x * 1.25) for x in col])
    rgh = rough
    if lace:
        f = N.math('FRACT', N.mul(u, 2.0))
        dist = N.math('SUBTRACT', 0.5, N.math('ABSOLUTE', N.math('SUBTRACT', f, 0.5)))   # 0 on the two seams
        band = N.ramp(dist, 0.045, 0.035, smooth=False)
        rail = N.mul(N.ramp(dist, 0.045, 0.040, smooth=False), N.ramp(dist, 0.028, 0.033, smooth=False))
        zig = N.ramp(N.math('ABSOLUTE', N.math('SUBTRACT', N.math('FRACT', N.mul(v, 42.0)), 0.5)), 0.30, 0.20, smooth=False)
        lacing = N.math('MAXIMUM', rail, N.mul(band, zig))
        h = N.add(h, N.mul(lacing, 1.3))
        c = N.mix(N.mul(band, 0.55), c, [x * 0.45 for x in col])
        c = N.mix(N.mul(N.mul(band, zig), 0.6), c, (0.11, 0.11, 0.085))
    if stitch:
        # flat stowed cover: a seam just inboard of each edge, in dashes, and pressed fold lines across it
        f = N.math('FRACT', N.mul(u, 2.0))
        dist = N.math('SUBTRACT', 0.5, N.math('ABSOLUTE', N.math('SUBTRACT', f, 0.5)))   # 0 at the two edges
        seam = N.mul(N.ramp(dist, 0.050, 0.060, smooth=False), N.ramp(dist, 0.078, 0.068, smooth=False))
        dash = N.ramp(N.math('ABSOLUTE', N.math('SUBTRACT', N.math('FRACT', N.mul(v, 150.0)), 0.5)), 0.36, 0.26, smooth=False)
        st = N.mul(seam, dash)
        cross = N.ramp(N.math('ABSOLUTE', N.math('SUBTRACT', N.math('FRACT', N.mul(v, 9.0)), 0.5)), 0.035, 0.02, smooth=False)
        h = N.add(N.add(h, N.mul(st, 0.9)), N.mul(N.add(seam, cross), -0.7))
        c = N.mix(N.mul(N.add(seam, cross), 0.5), c, [x * 0.5 for x in col])
        c = N.mix(N.mul(st, 0.7), c, [min(1, x * 1.6) for x in col])
    kit.finish(m, N, c, rgh, 0.0, 'fabric', height=h, dist=0.034, soft=0.25, bevel=0.012)
    return m


def helmet_paint(key, col):
    """Glossy painted shell with handling scuffs and a few chips to dark primer."""
    m, N = kit.new_material(key)
    scuff = N.ramp(N.noise(9.0, 5.0, 0.7, distortion=1.2), 0.60, 0.72)
    fine = N.ramp(N.noise(140.0, 3.0, 0.6), 0.55, 0.75)
    chip = N.mul(N.ramp(N.noise(55.0, 4.0, 0.6), 0.70, 0.73, smooth=False), N.ramp(N.noise(6.0, 3.0, 0.5), 0.45, 0.6))
    c = N.mix(N.mul(scuff, 0.45), col, [x * 0.66 for x in col])
    c = N.mix(N.mul(chip, 0.9), c, (0.035, 0.036, 0.034))
    rough = N.math('ADD', N.math('ADD', N.mul(N.mul(scuff, fine), 0.38), N.mul(chip, 0.45)), 0.17)
    kit.finish(m, N, c, rough, 0.0, 'paint', height=N.mul(chip, -1.0), dist=0.004, wear=0.0, soft=0.1)
    return m


# ---------------------------------------------------------------- geometry
def catmull(points, sub):
    """Catmull-Rom through `points` (tuples), `sub` steps per span."""
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
    """Tube through three-space points [(x, y, z, ra, rb[, work]), ...]; ra
    along `side` (Blender axis), rb across. Ends closed with a slightly domed
    cap. `ribs` = (period_rings, depth) gives a corrugated hose. Writes the
    cloth coordinates (see cloth()): `work` 0..1 is how creased it is there."""
    raw = [(*T(p[:3]), p[3], p[4], (p[5] if len(p) > 5 else 0.25)) for p in pts]
    path = catmull(raw, sub) if len(raw) > 2 else raw

    def f():
        bm = part.bm
        la, lb = bm.loops.layers.uv['aux'], bm.loops.layers.uv['aux2']
        rings = []
        where = {}
        dist = [0.0]
        for i in range(1, len(path)):
            dist.append(dist[-1] + (V(path[i][:3]) - V(path[i - 1][:3])).length)
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
            ring = [bm.verts.new(c + a * (ra * math.cos(2 * math.pi * j / seg)) + b * (rb * math.sin(2 * math.pi * j / seg)))
                    for j in range(seg)]
            for j, vtx in enumerate(ring):
                where[vtx] = (i, j)
            rings.append(ring)
        faces = []
        for r0, r1 in zip(rings, rings[1:]):
            for j in range(seg):
                k = (j + 1) % seg
                fc = bm.faces.new((r0[j], r0[k], r1[k], r1[j]))
                faces.append(fc)
                for lp in fc.loops:
                    i, jj = where[lp.vert]
                    uu = 1.0 if (jj == 0 and k == 0) else jj / seg
                    lp[la].uv = (uu, dist[i])
                    lp[lb].uv = (max(0.0, min(1.0, path[i][5])), 0.0)
        if caps:
            for idx in (0, -1):
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


def epoint(centre, axes, a, e, s=1.0, frame=None):
    """Point on an ellipsoid (three space): azimuth a (0 = forward / -Z, +90 = right), elevation e, degrees."""
    a, e = math.radians(a), math.radians(e)
    v = V((math.sin(a) * math.cos(e) * axes[0] * s, math.sin(e) * axes[1] * s, -math.cos(a) * math.cos(e) * axes[2] * s))
    if frame is not None:
        v = frame @ v
    return (centre[0] + v.x, centre[1] + v.y, centre[2] + v.z)


def shell(part, centre, axes, m, az=(-180, 180), lo=lambda a: -90, hi=lambda a: 90, naz=24, nel=10, thick=0.0):
    """Ellipsoid shell between two elevation curves lo(az) .. hi(az): smooth
    rims (no stair-steps), optional inner skin and rim. Returns the lower and
    upper rim polylines (three space)."""
    full = az[1] - az[0] >= 360
    A = [az[0] + (az[1] - az[0]) * i / naz for i in range(naz + (0 if full else 1))]

    def f():
        bm = part.bm
        layers = [1.0] + ([1.0 - thick] if thick > 0 else [])
        grids = [[[bm.verts.new(T(epoint(centre, axes, a, lo(a) + (hi(a) - lo(a)) * j / nel, s))) for j in range(nel + 1)] for a in A]
                 for s in layers]
        na = len(A)
        faces = []
        for gi, g in enumerate(grids):
            for i in range(na if full else na - 1):
                i2 = (i + 1) % na
                for j in range(nel):
                    q = (g[i][j], g[i2][j], g[i2][j + 1], g[i][j + 1])
                    faces.append(bm.faces.new(q if gi == 0 else q[::-1]))
        if thick > 0:
            o, n = grids
            for i in range(na if full else na - 1):
                i2 = (i + 1) % na
                for j in (0, nel):
                    try:
                        faces.append(bm.faces.new((o[i][j], o[i2][j], n[i2][j], n[i][j])))
                    except ValueError:
                        pass
            if not full:
                for i in (0, na - 1):
                    for j in range(nel):
                        faces.append(bm.faces.new((o[i][j], o[i][j + 1], n[i][j + 1], n[i][j])))
        allv = [v for g in grids for col in g for v in col]
        bmesh.ops.remove_doubles(bm, verts=allv, dist=1e-5)   # poles
        bmesh.ops.recalc_face_normals(bm, faces=[f_ for f_ in faces if f_.is_valid])
    part._run(f, m, True)
    return [epoint(centre, axes, a, lo(a)) for a in A], [epoint(centre, axes, a, hi(a)) for a in A]


def tube3(part, pts3, r, m, seg=6, closed=False):
    P = [tuple(T(p)) for p in pts3]
    if closed:
        P = P + [P[0], P[1]]
    part.tube(P, r, m, seg=seg, caps=not closed)


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


def obox(part, size, m, centre, normal, up=(0, 1, 0), lift=0.0):
    """Box lying on a surface: local Z = `normal`, local Y ~ `up` (three space)."""
    n = T(normal).normalized()
    u = T(up)
    u = (u - n * u.dot(n)).normalized()
    x = u.cross(n).normalized()
    R = Matrix((x, u, n)).transposed().to_4x4()
    mk = part.mark()
    part.box(size, m)
    part.transform(Matrix.Translation(T(centre) + n * lift) @ R, verts=part.since(mk))


# ---------------------------------------------------------------- the figure
EYE = (0.0, 0.22, -2.95)
NECK_TOP = (0.0, 0.165, -2.845)   # head pivot (top of the cervical spine)
HEAD_C = (0.0, 0.243, -2.866)     # helmet centre
HELMET = (0.128, 0.142, 0.152)    # semi-axes x, y, z -> top at y 0.385 (canopy 0.42)

STICK_AXIS = ((0.0, -0.272, -3.296), (0.0, -0.158, -3.33))
STICK_R = 0.022
THROTTLE_AXIS = ((-0.288, -0.292, -3.155), (-0.288, -0.212, -3.165))
THROTTLE_R = 0.026

MT = {}


def make_materials():
    """After kit.Asset() (which resets the file)."""
    MT.update(
        suit=cloth('suit', SAGE), gsuit=cloth('gsuit', GSUIT, rough=0.85, fold=0.6, lace=True),
        lpu=cloth('lpu', LPU, rough=0.86, fold=0.25, stitch=True), glove=cloth('glove', LEATHER, rough=0.42, fold=0.7, leather=True),
        web=mat('webbing'), helm=helmet_paint('helmet_paint', kit.PALETTE['helmet'][0]), skin=mat('skin'), eye=mat('eye'), hw=mat('hardware'), trim=mat('helmet_trim'), liner=mat('liner'), visor=mat('visor'),
        mask=mat('mask'), mshell=mat('mask_shell'), hose=mat('hose'), boot=mat('boot'), sole=mat('sole'),
        metal=mat('aluminium'), board=mat('kneeboard'), paper=mat('paper'), dark=mat('black'))


def build_body():
    P = kit.Part()
    suit, gs = MT['suit'], MT['gsuit']
    # torso: pelvis -> chest -> collar; ra = half width (x), rb = half depth; last value = how creased
    loft(P, [
        (0, -0.515, -2.835, 0.135, 0.100, 0.5),
        (0, -0.455, -2.815, 0.170, 0.125, 0.9),
        (0, -0.330, -2.775, 0.150, 0.106, 0.9),
        (0, -0.180, -2.745, 0.160, 0.116, 0.6),
        (0, -0.050, -2.727, 0.186, 0.128, 0.5),
        (0, 0.030, -2.730, 0.190, 0.116, 0.4),
        (0, 0.078, -2.752, 0.150, 0.092, 0.5),
        (0, 0.104, -2.772, 0.092, 0.074, 0.5),
        (0, 0.125, -2.790, 0.062, 0.058, 0.3),
    ], suit, side=V((1, 0, 0)), seg=24, sub=4)
    # neck (balaclava / collar) up into the helmet
    loft(P, [(0, 0.10, -2.79, 0.058, 0.056), (0, 0.17, -2.84, 0.052, 0.052), (0, 0.205, -2.86, 0.05, 0.05)],
         MT['liner'], seg=12, sub=2)
    # stand collar of the suit
    loft(P, [(0, 0.098, -2.775, 0.074, 0.070, 0.2), (0, 0.128, -2.795, 0.068, 0.066, 0.2), (0, 0.142, -2.805, 0.067, 0.065, 0.2)], suit,
         seg=14, sub=1, caps=False)
    # arms: shoulder (inside the torso) -> deltoid -> elbow -> wrist
    arms = {
        'R': [(0.13, 0.045, -2.725, 0.058, 0.058, 0.3), (0.212, 0.022, -2.732, 0.080, 0.076, 0.9), (0.216, -0.075, -2.795, 0.068, 0.066, 0.4), (0.208, -0.165, -2.875, 0.061, 0.058, 0.6),
              (0.196, -0.258, -2.958, 0.060, 0.050, 1.0), (0.165, -0.262, -3.03, 0.054, 0.050, 0.5), (0.115, -0.256, -3.115, 0.045, 0.042, 0.6),
              (0.055, -0.246, -3.205, 0.036, 0.034, 0.9)],
        'L': [(-0.13, 0.045, -2.725, 0.058, 0.058, 0.3), (-0.212, 0.022, -2.732, 0.080, 0.076, 0.9), (-0.232, -0.08, -2.755, 0.068, 0.066, 0.4), (-0.246, -0.175, -2.785, 0.061, 0.058, 0.6),
              (-0.256, -0.266, -2.812, 0.060, 0.050, 1.0), (-0.266, -0.262, -2.88, 0.054, 0.050, 0.5), (-0.278, -0.255, -2.975, 0.045, 0.042, 0.6),
              (-0.292, -0.240, -3.075, 0.036, 0.034, 0.9)],
    }
    for side, pts in arms.items():
        loft(P, pts, suit, side=V((0, 0, 1)), seg=16, sub=4)
        sx = 1 if side == 'R' else -1
        # raised shoulder seam where the sleeve is set in
        loft(P, [(sx * 0.168, 0.046, -2.730, 0.082, 0.080, 0.2), (sx * 0.176, 0.044, -2.731, 0.0835, 0.081, 0.2)], suit,
             side=V((0, 0, 1)), seg=16, sub=1, caps=False)
        # knitted cuff under the gauntlet
        w = pts[-1]
        e = pts[-2]
        d = (V(w[:3]) - V(e[:3])).normalized()
        c0 = V(w[:3]) - d * 0.035
        loft(P, [(*c0, 0.038, 0.036), (*(c0 + d * 0.02), 0.039, 0.037)], MT['web'], side=V((0, 0, 1)), seg=12, sub=1, caps=False)
        # pen pocket on the left sleeve
        if sx < 0:
            obox(P, (0.05, 0.09, 0.012), suit, (-0.262, -0.065, -2.752), (-0.95, 0.1, -0.25), up=(0.15, -0.6, 0.75))
            for k in (-0.012, 0.012):
                obox(P, (0.008, 0.05, 0.008), MT['dark'], (-0.270 , -0.045 + k * 0.3, -2.742 + k), (-0.95, 0.1, -0.25), up=(0.15, -0.6, 0.75), lift=0.008)
    # legs: hip -> knee -> ankle (into the boot shaft)
    for sx in (-1, 1):
        loft(P, [
            (sx * 0.085, -0.43, -2.84, 0.088, 0.088, 0.9),
            (sx * 0.115, -0.425, -2.97, 0.085, 0.082, 0.5),
            (sx * 0.150, -0.415, -3.15, 0.074, 0.070, 0.5),
            (sx * 0.168, -0.400, -3.300, 0.064, 0.062, 1.0),
            (sx * 0.170, -0.470, -3.420, 0.056, 0.054, 0.7),
            (sx * 0.170, -0.560, -3.560, 0.050, 0.048, 0.5),
            (sx * 0.170, -0.620, -3.660, 0.044, 0.042, 0.8),
        ], suit, side=V((1, 0, 0)), seg=16, sub=4)
        # anti-g suit: bladders over the thigh and the calf, knee left free
        loft(P, [(sx * 0.098, -0.428, -2.895, 0.096, 0.094, 0.5), (sx * 0.118, -0.424, -2.985, 0.094, 0.091, 0.3),
                 (sx * 0.142, -0.418, -3.10, 0.086, 0.082, 0.3), (sx * 0.158, -0.409, -3.215, 0.076, 0.073, 0.6)],
             gs, side=V((1, 0, 0)), seg=16, sub=3, caps=False)
        loft(P, [(sx * 0.170, -0.452, -3.392, 0.066, 0.063, 0.6), (sx * 0.170, -0.512, -3.485, 0.062, 0.059, 0.3),
                 (sx * 0.170, -0.578, -3.588, 0.057, 0.054, 0.5)],
             gs, side=V((1, 0, 0)), seg=16, sub=3, caps=False)
        # thigh pocket with a flap on the g-suit, outer side
        obox(P, (0.12, 0.15, 0.022), gs, (sx * 0.228, -0.42, -3.04), (sx, 0.1, 0.0), up=(0, 0.15, -1), lift=-0.004)
        obox(P, (0.125, 0.045, 0.008), gs, (sx * 0.228, -0.42, -2.985), (sx, 0.1, 0.0), up=(0, 0.15, -1), lift=0.012)
        # boot: shaft, foot, welted sole with a heel
        boot, sole = MT['boot'], MT['sole']
        loft(P, [(sx * 0.170, -0.590, -3.610, 0.051, 0.050), (sx * 0.170, -0.655, -3.700, 0.048, 0.047),
                 (sx * 0.170, -0.690, -3.730, 0.047, 0.041)], boot, seg=12, sub=2, caps=True)
        loft(P, [(sx * 0.170, -0.700, -3.670, 0.038, 0.030), (sx * 0.171, -0.700, -3.760, 0.048, 0.038),
                 (sx * 0.173, -0.703, -3.870, 0.047, 0.035), (sx * 0.175, -0.708, -3.925, 0.040, 0.029)],
             boot, side=V((1, 0, 0)), seg=12, sub=3)
        loft(P, [(sx * 0.170, -0.736, -3.665, 0.036, 0.010), (sx * 0.171, -0.738, -3.76, 0.050, 0.010),
                 (sx * 0.173, -0.740, -3.87, 0.049, 0.010), (sx * 0.175, -0.740, -3.94, 0.040, 0.010)],
             sole, side=V((1, 0, 0)), seg=8, sub=2)
        obox(P, (0.07, 0.07, 0.022), sole, (sx * 0.170, -0.752, -3.695), (0, -1, 0), up=(0, 0, -1))
        P.detail = 1
        for k in range(4):   # lace bars across the instep
            obox(P, (0.05, 0.006, 0.006), sole, (sx * 0.171, -0.664 - k * 0.004, -3.775 - k * 0.028), (0, 1, -0.25), up=(0, 0.25, -1), lift=0.002)
        P.detail = 0
    # anti-g suit abdominal bladder, and its hose to the left console
    loft(P, [(0, -0.500, -2.830, 0.158, 0.118, 0.4), (0, -0.455, -2.815, 0.181, 0.136, 0.5), (0, -0.395, -2.796, 0.176, 0.130, 0.4),
             (0, -0.348, -2.781, 0.169, 0.121, 0.5)], gs, side=V((1, 0, 0)), seg=24, sub=2, caps=False)
    loft(P, [(-0.150, -0.43, -2.90, 0.019, 0.019), (-0.215, -0.47, -2.93, 0.019, 0.019), (-0.262, -0.53, -2.90, 0.019, 0.019),
             (-0.285, -0.60, -2.84, 0.019, 0.019)], MT['hose'], seg=8, sub=4, ribs=(1, 0.004))
    P.cyl(0.024, 0.03, MT['metal'], loc=T((-0.150, -0.43, -2.90)), rot=(60, 0, 40), seg=8)
    # kneeboard on the right thigh: board, paper under a clip, strap round the leg
    kb = (0.152, -0.318, -3.13)
    obox(P, (0.135, 0.195, 0.010), MT['board'], kb, (-0.1, 1, 0.07), up=(0, 0.07, -1))
    obox(P, (0.118, 0.160, 0.004), MT['paper'], kb, (-0.1, 1, 0.07), up=(0, 0.07, -1), lift=0.007)
    obox(P, (0.085, 0.022, 0.014), MT['metal'], (0.152, -0.312, -3.215), (-0.1, 1, 0.07), up=(0, 0.07, -1), lift=0.008)
    loft(P, [(0.150, -0.415, -3.15, 0.090, 0.086), (0.151, -0.415, -3.172, 0.089, 0.085)], MT['web'], side=V((1, 0, 0)), seg=16, sub=1, caps=False)
    # chest: zip, two slanted pockets with zips
    P.box((0.010, 0.006, 0.36), MT['dark'], loc=T((0.0, -0.17, -2.862)), rot=(-8, 0, 0))
    return P


def build_gloves(P):
    glove = MT['glove']

    def grip_hand(axis, r, palm_side, wrist, elbow):
        a0, a1 = V(axis[0]), V(axis[1])
        up = (a1 - a0).normalized()
        fwd = V((0, 0, -1))
        fwd = (fwd - up * fwd.dot(up)).normalized()
        right = up.cross(fwd).normalized() * -1  # +X
        # four fingers wrapped from the palm side round the front, in three phalanges
        for i in range(4):
            h = a0 + up * (0.020 + i * 0.021)
            fr = 0.0108 - i * 0.0007
            R = r + fr
            pts = []
            for k in range(7):
                ang = math.radians(-20 + 200 * k / 6)  # 0 = palm side, 90 = front, 180 = far side
                d = right * palm_side * math.cos(ang) + fwd * math.sin(ang)
                knuckle = 1.12 if k in (1, 3, 5) else 1.0
                pts.append((*(h + d * R), fr * knuckle, fr * knuckle, 0.9))
            loft(P, pts, glove, side=V((0, 0, 1)), seg=8, sub=2)
        # palm and back of the hand behind / beside the grip
        pc = a0 + up * 0.05 + right * palm_side * (r + 0.017) + (-fwd) * 0.02
        P.sphere(1.0, glove, loc=T(pc), scale=(0.019, 0.042, 0.04), seg=14, rings=10)
        # thumb over the top of the grip
        tb = a0 + up * 0.095
        loft(P, [(*(tb + right * palm_side * 0.03 + (-fwd) * 0.02), 0.012, 0.012, 0.8),
                 (*(tb + up * 0.012 + right * palm_side * 0.005 - fwd * 0.004), 0.0115, 0.0115, 0.8),
                 (*(tb + up * 0.006 - right * palm_side * 0.016 + fwd * 0.012), 0.010, 0.010, 0.8)], glove, seg=8, sub=2)
        # wrist and flared gauntlet up the forearm
        w, e = V(wrist), V(elbow)
        back = (e - w).normalized()
        loft(P, [(*(w + back * 0.085), 0.047, 0.045, 0.4), (*(w + back * 0.03), 0.040, 0.038, 0.9), (*w, 0.035, 0.033, 1.0),
                 (*(w + (pc - w) * 0.55), 0.032, 0.028, 0.8), (*pc, 0.02, 0.02, 0.5)],
             glove, side=V((0, 0, 1)), seg=12, sub=2)
    grip_hand(STICK_AXIS, STICK_R, +1, (0.055, -0.246, -3.205), (0.13, -0.256, -3.09))
    grip_hand(THROTTLE_AXIS, THROTTLE_R, -1, (-0.292, -0.240, -3.075), (-0.276, -0.255, -2.95))


def build_harness(P):
    """Straps, buckles and the life preserver, laid on the body by ray casts."""
    dg = bpy.context.evaluated_depsgraph_get()
    sc = bpy.context.scene
    web, metal = MT['web'], MT['hw']

    def hit(p, d, back=0.12):
        o, dd = T(p), T(d).normalized()
        o = o - dd * back
        ok, loc, nrm, _, ob, _ = sc.ray_cast(dg, o, dd)
        if not ok:
            return None
        return (loc.x, loc.z, -loc.y), (nrm.x, nrm.z, -nrm.y)

    def strap(points, dirs, width=0.044, thick=0.010, off=0.008, m=web, back=0.12):
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
        return pts, nrm

    def buckle(p, d, size=(0.052, 0.030, 0.008), up=(0, 1, 0)):
        """Friction adapter: an open steel frame with a centre bar, standing proud of the webbing."""
        h = hit(p, d)
        if h:
            q, n = h
            w, l, t = size
            bar = 0.007
            lift = 0.017
            n_ = V(n).normalized()
            u_ = V(up)
            u_ = (u_ - n_ * u_.dot(n_)).normalized()
            x_ = u_.cross(n_).normalized()
            c = V(q)
            for sgn in (-1, 1):
                obox(P, (w, bar, t), metal, tuple(c + u_ * sgn * (l / 2 - bar / 2)), n, up=up, lift=lift)
                obox(P, (bar, l, t), metal, tuple(c + x_ * sgn * (w / 2 - bar / 2)), n, up=up, lift=lift)
            obox(P, (w, bar * 0.8, t * 0.8), metal, tuple(c), n, up=up, lift=lift + 0.002)

    FWD, DOWN = (0, 0, 1), (0, -1, 0)
    for sx in (-1, 1):
        # shoulder strap: from the seat back, over the shoulder, down the chest
        pts = [(sx * 0.125, 0.12, -2.66), (sx * 0.13, 0.12, -2.72), (sx * 0.132, 0.12, -2.79)]
        dirs = [DOWN, DOWN, DOWN]
        for y in (0.06, 0.0, -0.06, -0.12, -0.18, -0.235):
            x = sx * (0.136 - (0.06 - y) * 0.30)   # outboard of the life preserver, converging on the release box
            pts.append((x, y, -2.95))
            dirs.append(FWD)
        strap(pts, dirs)
        buckle((sx * 0.115, -0.01, -2.95), FWD)        # shoulder adjuster
        # lap belt from the hip to the buckle
        lp, ld = [], []
        for k in range(6):
            t = k / 5
            x = sx * (0.178 - 0.16 * t)
            y = -0.30 - 0.03 * math.sin(math.pi * t)
            lp.append((x, y, -2.98 if t > 0.25 else -2.82))
            ld.append(FWD if t > 0.25 else (-sx, 0, 0.3))
        strap(lp, ld, width=0.05)
        buckle((sx * 0.105, -0.318, -2.98), FWD, size=(0.058, 0.034, 0.008), up=(1, 0, 0))
        # leg loop round the top of the thigh
        gp, gd = [], []
        for k in range(5):
            t = k / 4
            gp.append((sx * (0.06 + 0.13 * t), -0.36 - 0.02 * math.sin(math.pi * t), -3.02))
            gd.append(DOWN)
        strap(gp, gd, width=0.038, back=0.05)
    # chest strap between the shoulder straps, with its snap hook
    cp, cd = [], []
    for k in range(7):
        t = k / 6
        cp.append((-0.105 + 0.21 * t, -0.085, -2.95))
        cd.append(FWD)
    strap(cp, cd, width=0.036, off=0.013)
    buckle((0.02, -0.085, -2.95), FWD, size=(0.044, 0.04, 0.012))
    # quick-release box on the belly
    h = hit((0, -0.26, -2.95), FWD)
    if h:
        q, n = h
        c = V(q) + V(n) * 0.014
        P.cyl(0.033, 0.022, MT['metal'], loc=T(c), rot=(90, 0, 0), seg=20)
        P.cyl(0.024, 0.030, MT['dark'], loc=T(c), rot=(90, 0, 0), seg=14)
        for a in range(4):   # the four lugs the straps lock into
            ang = math.radians(45 + 90 * a)
            obox(P, (0.020, 0.014, 0.010), metal, tuple(c + V((math.cos(ang) * 0.036, math.sin(ang) * 0.036, 0.0))), (0, 0, -1),
                 up=(math.cos(ang), math.sin(ang), 0))
    # life preserver: a horseshoe bladder round the neck, lobes down the chest
    lobe = []
    for sx in (-1, 1):
        col = []
        for y in (-0.150, -0.10, -0.04, 0.02, 0.07):
            hh = hit((sx * 0.062, y, -2.95), FWD)
            if hh:
                q, n = hh
                col.append((q[0] + n[0] * 0.013, q[1] + n[1] * 0.013, q[2] + n[2] * 0.013))
        lobe.append(col)
    if all(len(c) >= 4 for c in lobe):
        left, right = lobe
        path = [(*p, 0.050 if i else 0.044, 0.0125, 0.5) for i, p in enumerate(left)]
        path += [(-0.094, 0.112, -2.792, 0.044, 0.012, 0.5), (-0.088, 0.126, -2.735, 0.040, 0.012, 0.5), (-0.046, 0.126, -2.698, 0.038, 0.012, 0.5),
                 (0.046, 0.126, -2.698, 0.038, 0.012, 0.5), (0.088, 0.126, -2.735, 0.040, 0.012, 0.5), (0.094, 0.112, -2.792, 0.044, 0.012, 0.5)]
        path += [(*p, 0.050 if i < len(right) - 1 else 0.044, 0.0125, 0.5) for i, p in enumerate(right[::-1])]
        loft(P, path, MT['lpu'], side=V((1, 0, 0)), seg=12, sub=3)
        # the folded bladder makes each chest lobe a flat packed pouch with a closing flap and a beaded pull
        for col, sx in zip(lobe, (-1, 1)):
            lo_, hi_ = V(col[0]), V(col[2])
            mid = (lo_ + hi_) / 2
            n_ = (0, 0.05, -1)
            obox(P, (0.088, (hi_ - lo_).length + 0.02, 0.020), MT['lpu'], tuple(mid), n_, up=tuple((hi_ - lo_).normalized()), lift=0.010)
            obox(P, (0.092, 0.034, 0.006), MT['lpu'], tuple(hi_), n_, up=tuple((hi_ - lo_).normalized()), lift=0.024)
            P.sphere(0.009, MT['dark'], loc=T(lo_ + V((sx * 0.03, -0.02, -0.03))), seg=8, rings=5)
        # inflation toggles at the bottom of each lobe
        P.detail = 1
        for col in lobe:
            c = V(col[0])
            P.cyl(0.006, 0.035, MT['dark'], loc=T(c + V((0, -0.035, -0.012))), rot=(90, 0, 0), seg=5)
        P.detail = 0
    # oxygen / comms connector on the left chest (the mask hose ends here)
    h = hit((-0.145, -0.20, -2.95), FWD)
    if h:
        q, n = h
        c = V(q) + V(n) * 0.014
        P.cyl(0.021, 0.034, metal, loc=T(c), rot=(90, 0, 0), seg=12)
        loft(P, [(*c, 0.016, 0.016), (c.x - 0.02, c.y - 0.10, c.z + 0.03, 0.016, 0.016),
                 (-0.20, -0.40, -2.84, 0.016, 0.016), (-0.24, -0.50, -2.78, 0.016, 0.016)],
             MT['hose'], seg=8, sub=4, ribs=(1, 0.0035))
        return tuple(c)
    return (-0.145, -0.20, -2.86)


def build_head(connector):
    H = kit.Part()
    hc = V(HEAD_C)
    helm, trim = MT['helm'], MT['trim']
    # head form inside the shell (shows only through the open bottom)
    H.sphere(1.0, MT['liner'], loc=T(hc + V((0, -0.01, 0.012))), scale=(HELMET[0] * 0.88, HELMET[2] * 0.84, HELMET[1] * 0.88),
             seg=16, rings=10)
    # the face behind the visor: brow, cheeks, nose bridge and eyes (seen dimly through the tint)
    FACE = (HELMET[0] * 0.80, HELMET[1] * 0.86, HELMET[2] * 0.86)
    shell(H, HEAD_C, FACE, MT['skin'], az=(-80, 80), lo=lambda a: -50, hi=lambda a: 30, naz=16, nel=8)
    loft(H, [(*epoint(HEAD_C, FACE, 0, 12, 1.0), 0.010, 0.010), (*epoint(HEAD_C, FACE, 0, 0, 1.05), 0.011, 0.012),
             (*epoint(HEAD_C, FACE, 0, -14, 1.13), 0.016, 0.014)], MT['skin'], seg=8, sub=2)
    for sx in (-1, 1):
        H.sphere(1.0, MT['eye'], loc=T(epoint(HEAD_C, FACE, sx * 21, 5, 0.985)), scale=(0.015, 0.008, 0.008), seg=10, rings=6)
        H.sphere(1.0, MT['skin'], loc=T(epoint(HEAD_C, FACE, sx * 22, 14, 1.0)), scale=(0.024, 0.012, 0.008), seg=10, rings=6)

    def sm(x, a, b):
        t = max(0.0, min(1.0, (x - a) / (b - a)))
        return t * t * (3 - 2 * t)

    def rim(a):   # lower edge of the shell: high over the face, low over the ears, up again at the nape
        a = abs(a)
        return -54 + 46 * (1 - sm(a, 48, 74)) + 2 * sm(a, 120, 170)
    low, _ = shell(H, HEAD_C, HELMET, helm, lo=rim, naz=36, nel=14, thick=0.07)
    # edge beading round the rim
    tube3(H, [epoint(HEAD_C, HELMET, -180 + 360 * i / 36, rim(-180 + 360 * i / 36), 0.985) for i in range(36)], 0.0085, trim, seg=6, closed=True)
    # ear bulges
    for sx in (-1, 1):
        H.sphere(1.0, helm, loc=T(epoint(HEAD_C, HELMET, sx * 90, -22, 0.97)), scale=(0.022, 0.050, 0.056), seg=12, rings=6)
    # visor cover over the brow and crown, a guide rail and lock knob down its centre
    big = (HELMET[0] + 0.011, HELMET[1] + 0.011, HELMET[2] + 0.012)
    shell(H, HEAD_C, big, helm, az=(-78, 78), lo=lambda a: 4 + 5 * sm(abs(a), 40, 78), hi=lambda a: 58 - 20 * sm(abs(a), 20, 78),
          naz=18, nel=5, thick=0.085)
    tube3(H, [epoint(HEAD_C, big, 0, e, 1.02) for e in (8, 22, 36, 50)], 0.006, trim, seg=5)
    H.cyl(0.013, 0.014, trim, loc=T(epoint(HEAD_C, big, 0, 18, 1.06)), rot=(72, 0, 0), seg=10)
    # rolled lower lip of the housing
    tube3(H, [epoint(HEAD_C, big, a, 4 + 5 * sm(abs(a), 40, 78), 1.0) for a in range(-78, 79, 12)], 0.0055, helm, seg=5)
    for sx in (-1, 1):   # visor pivots: a boss with a screw head, and the track the visor arm rides in
        H.cyl(0.017, 0.010, helm, loc=T(epoint(HEAD_C, big, sx * 84, 2, 0.995)), rot=(0, 90, 0), seg=12)
        H.cyl(0.008, 0.016, MT['hw'], loc=T(epoint(HEAD_C, big, sx * 84, 2, 1.0)), rot=(0, 90, 0), seg=8)
        tube3(H, [epoint(HEAD_C, big, sx * 82, e, 1.012) for e in (6, 18, 30, 40)], 0.004, trim, seg=4)
    # nape pad and the adjuster on the back of the shell
    obox(H, (0.07, 0.03, 0.012), trim, epoint(HEAD_C, HELMET, 180, -40, 1.0), (0, -0.4, 1), up=(0, 1, 0.4), lift=0.004)
    # visor down: tinted, wraps the face from under the cover to the mask
    tube3(H, [epoint(HEAD_C, VISOR, a, visor_lo(a), 1.0) for a in range(-72, 73, 8)], 0.0032, trim, seg=4)
    # oxygen mask: rubber face piece, hard shell over its front, valve on the nose of it
    base = hc + V((0, -0.084, -0.104))
    axis = V((0, -0.40, -1.0)).normalized()
    upv = V((0, 1, 0))
    upv = (upv - axis * upv.dot(axis)).normalized()
    loft(H, [(*(base - axis * 0.016), 0.043, 0.054), (*(base + axis * 0.010), 0.044, 0.052), (*(base + axis * 0.032), 0.037, 0.043),
             (*(base + axis * 0.050), 0.027, 0.031), (*(base + axis * 0.060), 0.019, 0.021)], MT['mask'], side=V((1, 0, 0)), seg=14, sub=2)
    loft(H, [(*(base + axis * 0.020), 0.0415, 0.047), (*(base + axis * 0.036), 0.036, 0.041), (*(base + axis * 0.053), 0.027, 0.030),
             (*(base + axis * 0.063), 0.018, 0.019)], MT['mshell'], side=V((1, 0, 0)), seg=14, sub=2)
    # exhalation ports on the cheeks of the shell
    for sx in (-1, 1):
        H.cyl(0.009, 0.008, MT['dark'], loc=T(base + axis * 0.040 + V((sx * 0.034, -0.004, 0))), rot=(0, 90 - sx * 20, 0), seg=8)
    tip = base + axis * 0.066
    Rm = rot_to(axis)
    mk = H.mark()
    H.lathe([(0.0125, 0.0), (0.014, 0.003), (0.014, 0.009), (0.009, 0.011), (0.0, 0.011)], MT['metal'], seg=12)
    H.transform(Matrix.Translation(T(tip - axis * 0.004)) @ Rm, verts=H.since(mk))
    # hose stub under the mask and the corrugated hose down to the chest connector
    stub = base + axis * 0.034 - upv * 0.040
    c = V(connector)
    loft(H, [(*(stub + upv * 0.012), 0.0165, 0.0165), (*(stub - upv * 0.03), 0.0165, 0.0165), (*(V((-0.03, 0.045, -2.985))), 0.0165, 0.0165),
             (*(V((-0.085, -0.06, -2.975))), 0.0165, 0.0165), (*(c + V((0.0, 0.035, -0.035))), 0.0165, 0.0165), (*c, 0.0160, 0.0160)],
         MT['hose'], seg=8, sub=5, ribs=(1, 0.0036))
    # mask straps to the receivers on the helmet sides, chin strap under the jaw
    for sx in (-1, 1):
        bay = V(epoint(HEAD_C, HELMET, sx * 70, -32, 1.0))
        obox(H, (0.030, 0.034, 0.012), trim, bay, (sx, 0, -0.35), up=(0, 1, 0), lift=0.004)
        for dy in (0.014, -0.014):
            ribbon(H, [tuple(base + V((sx * 0.040, dy, 0.0))), tuple((base + V((sx * 0.040, dy, 0.0)) + bay) / 2 + V((sx * 0.012, 0, -0.008))), tuple(bay + V((sx * 0.006, dy * 0.5, -0.004)))],
                   [(sx, 0.2, -0.4), (sx, 0.1, -0.3), (sx, 0.1, 0)], 0.013, 0.004, MT['mask'])
    ribbon(H, [epoint(HEAD_C, HELMET, -88, -46, 0.98), epoint(HEAD_C, HELMET, -45, -66, 0.92), epoint(HEAD_C, HELMET, 0, -74, 0.90),
               epoint(HEAD_C, HELMET, 45, -66, 0.92), epoint(HEAD_C, HELMET, 88, -46, 0.98)],
           [(-1, -0.3, 0), (-0.5, -1, -0.3), (0, -1, -0.4), (0.5, -1, -0.3), (1, -0.3, 0)], 0.018, 0.004, MT['web'])
    # comms lead from the left rear of the shell to the shoulder
    tube3(H, [epoint(HEAD_C, HELMET, -140, -40, 1.0), (-0.125, 0.150, -2.735), (-0.150, 0.105, -2.745), (-0.150, 0.06, -2.80)], 0.0045, MT['dark'], seg=4)
    return H


VISOR = (HELMET[0] + 0.005, HELMET[1] + 0.003, HELMET[2] + 0.009)


def _sm(x, a, b):
    t = max(0.0, min(1.0, (x - a) / (b - a)))
    return t * t * (3 - 2 * t)


def visor_lo(a):
    return -34 + 9 * _sm(abs(a), 15, 72) + 6 * (1 - _sm(abs(a), 0, 14))


def visor_material():
    """Smoke-tinted visor: not baked. Alpha-blended so the face shows dimly
    behind it, near-mirror smooth with a clearcoat so it picks up the sky
    (KHR_materials_clearcoat -> a physical material at runtime)."""
    m = bpy.data.materials.new('pilot_visor')
    m.use_nodes = True
    b = m.node_tree.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = (0.012, 0.014, 0.018, 1.0)
    b.inputs['Roughness'].default_value = 0.08
    b.inputs['Metallic'].default_value = 0.0
    b.inputs['Alpha'].default_value = 0.86
    for name, v in (('Coat Weight', 0.35), ('Coat Roughness', 0.03), ('Coat IOR', 1.5), ('Specular IOR Level', 0.25)):
        if name in b.inputs:
            b.inputs[name].default_value = v
    for attr, v in (('blend_method', 'BLEND'), ('surface_render_method', 'BLENDED')):
        try:
            setattr(m, attr, v)
        except Exception:
            pass
    m.use_backface_culling = True
    return m


def build_visor(A):
    """Child node `pilot_visor` of `pilot_head`: one skin of glass from under the housing to the mask."""
    Vp = kit.Part()
    shell(Vp, HEAD_C, VISOR, visor_material(), az=(-72, 72), lo=visor_lo, hi=lambda a: 12, naz=20, nel=7)
    o = A.mesh('pilot_visor', Vp, pivot=T(NECK_TOP), parent='pilot_head', smooth_angle=85)
    bm = bmesh.new()
    bm.from_mesh(o.data)
    bmesh.ops.triangulate(bm, faces=bm.faces[:])
    uv = bm.loops.layers.uv.new('UVMap')
    for f in bm.faces:
        for lp in f.loops:
            lp[uv].uv = (0.5 + lp.vert.co.x * 3.0, 0.5 + lp.vert.co.z * 3.0)
    bm.to_mesh(o.data)
    bm.free()
    return o


def main():
    A = kit.Asset('pilot', 'pilot', notes=(
        'Seated jet pilot in aircraft model space: parent to the MiG model with an identity transform '
        '(eye at (0, 0.22, -2.95)). pilot_head pivots at the top of the neck (rotation.y = look, +x = nod down); '
        'hide pilot_head in the cockpit view. Helmet with visor and oxygen mask, flight suit, anti-g suit, harness, '
        'life preserver; no insignia. LOD1 is for hostile jets. Built by tools/blender/build_pilot.py.'))
    kit.DETAIL = 0.25
    make_materials()
    body = build_body()
    build_gloves(body)
    body_obj = A.mesh('pilot_body', body, pivot=(0, 0, 0), smooth_angle=60)
    bpy.context.view_layer.update()
    P2 = kit.Part()
    connector = build_harness(P2)
    harness = A.mesh('pilot_harness', P2, pivot=(0, 0, 0), smooth_angle=60)
    # join harness into the body node
    C.select_only([body_obj, harness], active=body_obj)
    bpy.ops.object.join()
    A.nodes.pop('pilot_harness', None)
    A.world.pop('pilot_harness', None)
    head = build_head(connector)
    A.mesh('pilot_head', head, pivot=T(NECK_TOP), smooth_angle=60, moving=True)
    A.socket('pilot_eye', T(EYE), parent='pilot_head')
    print('PILOT tris', C.tri_count(A.meshes()))
    args = C.argv()
    if args and args[0] == 'preview':
        preview(A, args[1] if len(args) > 1 else os.path.join(C.BUILD, 'pilot_preview'))
        return
    baked = A.bake(size=1024, ao_samples=64, ao_mix=0.45, cavity=0.0, wear=0.5)
    baked['noDetail'] = True
    build_visor(A)
    # budgets: up to 18k triangles LOD0 (player, seen from the seat), 2.5k LOD1 (hostile jets)
    info = A.export(tex=1024, ntex=1024, otex=512, lod1_tex=256, lod1_ntex=256, lod1_tris=2500)
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
        'head': ((0.45, 0.32, -3.45), (0, 0.2, -2.9), 40),
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
