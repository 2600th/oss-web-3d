"""MiG-21 with moving control surfaces: stabilators, ailerons and flaps cut out
of the airframe and parented to named, pivoted nodes.

  node tools/blender/decode-glb.mjs assets/authoring/source/mig21_source.glb assets/authoring/build/mig21_decoded.glb
  blender -b --factory-startup --python tools/blender/build_mig_surfaces.py [-- --render]
  node tools/blender/build-mig-player.mjs     (optimise -> public/models/mig21.glb, with attribution)

The source is the original Sketchfab-derived model as first shipped
(assets/authoring/source/mig21_source.glb, nose +Z, unscaled). Never feed the
already-baked public/models/mig21.glb back in.

Output (`assets/authoring/build/mig21_split_raw.glb`) is BAKED to the runtime
conventions (metres, nose -Z, +Y up, origin at the bbox centre, 15.76 m), the
exact transform Aircraft.js used to apply at load time. The root node `mig21`
carries `extras.baked = 1`, which Aircraft.js / loadModel read to skip their
own normalisation.

Pivot nodes (glTF/three names; each rotates on its local X axis, which is the
hinge line; positive angle = trailing edge DOWN):

  stab_L, stab_R          all-moving tailplanes, pivot at 40 % root chord
  aileron_L, aileron_R    outer trailing edge, hinge at the surface's leading edge
  flap_L, flap_R          inner trailing edge, hinge at the leading edge, low

How the cut works: the source airframe is one joined mesh whose panels are
separate edge-connected islands (tools/blender/probe_surfaces.py lists them).
Every island whose bounding box lies entirely inside a surface's region box
moves with that surface; everything else stays. The regions were measured with
probe_surfaces.py (Blender axes: x right, y nose, z up):

  stabilator  |x| 0.43..2.0   y -7.55..-4.30   z -0.64..-0.42
  aileron     |x| 2.02..3.30  y -3.25..-2.58   z -0.81..-0.64
  flap        |x| 0.55..2.00  y -3.25..-2.38   z -0.81..-0.58

The rudder and the airbrakes are fused into the fin / belly skin and are NOT cut.
`-- --render` also writes deflected check renders to assets/authoring/build/surfaces/.
"""
import math
import os
import sys
import bpy
import bmesh
from mathutils import Vector, Matrix
sys.path.insert(0, os.path.dirname(__file__))
import common as C

OUT = os.path.join(C.BUILD, 'mig21_split_raw.glb')
RENDER = '--render' in C.argv()

# Node names in mig21.glb -> readable names (same table as build-mig-variants.mjs).
NODE_NAMES = {
    'Object_13': 'airframe', 'Object_9': 'cockpit_interior', 'Object_8': 'cockpit_seat',
    'Object_30': 'canopy_glass', 'Object_28': 'stores', 'Object_23': 'underside',
    'Object_27': 'details_alpha', 'Object_12': 'pylons', 'Object_26': 'gear_doors',
    'Object_5': 'ventral', 'Object_2': 'ventral_fairing', 'Object_7': 'strake',
    'Object_3': 'glass_misc', 'Object_11': 'pitot',
}

# (name, |x| range, y range, z range)
REGIONS = [
    ('stab', (0.43, 2.0), (-7.55, -4.30), (-0.64, -0.42)),
    ('aileron', (2.02, 3.30), (-3.25, -2.58), (-0.81, -0.64)),
    ('flap', (0.55, 2.00), (-3.25, -2.38), (-0.81, -0.58)),
]
# Parts that never carry control-surface geometry.
SKIP = {'cockpit_interior', 'cockpit_seat', 'canopy_glass', 'glass_misc', 'pitot', 'stores', 'pylons'}


def islands(bm):
    bm.faces.ensure_lookup_table()
    seen = set()
    for f in bm.faces:
        if f.index in seen:
            continue
        isl, st = [], [f]
        seen.add(f.index)
        while st:
            g = st.pop()
            isl.append(g.index)
            for e in g.edges:
                for h in e.link_faces:
                    if h.index not in seen:
                        seen.add(h.index)
                        st.append(h)
        yield isl


def classify(mn, mx):
    """Region label ('stab_L', ...) of an island bbox, or None."""
    side = 'L' if mx.x < 0 else 'R' if mn.x > 0 else None
    if side is None:
        return None
    ax0, ax1 = (-mx.x, -mn.x) if side == 'L' else (mn.x, mx.x)
    for name, (x0, x1), (y0, y1), (z0, z1) in REGIONS:
        if ax0 >= x0 and ax1 <= x1 and mn.y >= y0 and mx.y <= y1 and mn.z >= z0 and mx.z <= z1:
            return f'{name}_{side}'
    return None


def separate(obj, code, new_name):
    """Move the faces whose `surf` attribute == code into a new object (keeps UVs,
    materials, custom normals). Face indices shift after every separation, so
    the selection is read back from the attribute each time."""
    C.select_only([obj])
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_mode(type='FACE')
    bpy.ops.mesh.select_all(action='DESELECT')
    bpy.ops.object.mode_set(mode='OBJECT')
    surf = obj.data.attributes['surf'].data
    for p in obj.data.polygons:
        p.select = surf[p.index].value == code
    before = set(bpy.data.objects)
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.separate(type='SELECTED')
    bpy.ops.object.mode_set(mode='OBJECT')
    new = [o for o in bpy.data.objects if o not in before]
    assert len(new) == 1, new
    new[0].name = new_name
    new[0].data.name = new_name
    return new[0]


C.reset()
meshes, info = C.import_mig()
print('NORMALISE', info)
for o in meshes:
    if o.name in NODE_NAMES:
        o.name = NODE_NAMES[o.name]
        o.data.name = o.name

# ---------------------------------------------------------------- classify
parts = {}  # label -> [objects]
for o in list(meshes):
    if o.name in SKIP:
        continue
    bm = bmesh.new()
    bm.from_mesh(o.data)
    bm.verts.ensure_lookup_table()
    groups = {}
    for isl in islands(bm):
        pts = [v.co for i in isl for v in bm.faces[i].verts]
        mn = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
        mx = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
        lab = classify(mn, mx)
        if lab:
            groups.setdefault(lab, []).extend(isl)
    bm.free()
    if not groups:
        continue
    labels = sorted(groups)
    attr = o.data.attributes.new('surf', 'INT', 'FACE')
    for code, lab in enumerate(labels, start=1):
        for i in groups[lab]:
            attr.data[i].value = code
    for code, lab in enumerate(labels, start=1):
        print(f'CUT {o.name:16s} -> {lab:10s} faces={len(groups[lab])}')
        parts.setdefault(lab, []).append(separate(o, code, f'{lab}_{o.name}'))
    o.data.attributes.remove(o.data.attributes['surf'])

for objs in parts.values():
    for p in objs:
        if 'surf' in p.data.attributes:
            p.data.attributes.remove(p.data.attributes['surf'])

expected = {f'{n}_{s}' for n, *_ in REGIONS for s in 'LR'}
missing = expected - set(parts)
if missing:
    raise SystemExit(f'control surfaces not found: {sorted(missing)}')

# ---------------------------------------------------------------- hinges
root = bpy.data.objects.new('mig21', None)
C.link(root)
root['baked'] = 1
root['conventions'] = 'metres, +Y up, nose -Z, origin at bbox centre, length 15.76 m'
root['surfaces'] = 'stab_L stab_R aileron_L aileron_R flap_L flap_R: rotation.x, + = trailing edge down'

hinges = {}
for lab, objs in sorted(parts.items()):
    verts = [o.matrix_world @ v.co for o in objs for v in o.data.vertices]
    kind = lab.split('_')[0]
    xs = [abs(v.x) for v in verts]
    inner = min(xs)
    if kind == 'stab':
        # all-moving: pivot at ~40 % of the root chord, mid-thickness
        root_v = [v for v in verts if abs(v.x) < inner + 0.18]
        le = max(v.y for v in root_v)
        te = min(v.y for v in root_v)
        y = le - 0.40 * (le - te)
        z = sum(v.z for v in root_v) / len(root_v)
    else:
        # hinged at its own leading edge
        le = max(v.y for v in verts)
        y = le - 0.02
        zs = [v.z for v in verts if v.y > le - 0.12] or [v.z for v in verts]
        z = sum(zs) / len(zs) - (0.03 if kind == 'flap' else 0.0)
    x = (inner + 0.02) * (-1 if lab.endswith('_L') else 1)
    pivot = bpy.data.objects.new(lab, None)
    pivot.empty_display_size = 0.3
    C.link(pivot)
    pivot.location = (x, y, z)
    pivot.parent = root
    bpy.context.view_layer.update()
    for o in objs:
        mw = o.matrix_world.copy()
        o.parent = pivot
        o.matrix_world = mw
    hinges[lab] = (round(x, 3), round(y, 3), round(z, 3))
    print(f'HINGE {lab:10s} blender=({x:.3f}, {y:.3f}, {z:.3f}) three=({x:.3f}, {z:.3f}, {-y:.3f}) parts={len(objs)} '
          f'tris={C.tri_count(objs)}')

for o in meshes:
    if o.parent is None:
        o.parent = root
root['hinges_three'] = str({k: (v[0], v[2], -v[1]) for k, v in hinges.items()})
bpy.context.view_layer.update()
print('TRIS', C.tri_count([o for o in bpy.data.objects if o.type == 'MESH']))

# ---------------------------------------------------------------- check renders
if RENDER:
    outdir = os.path.join(C.BUILD, 'surfaces')
    C.setup_render(res=(1280, 800), samples=24)
    C.sky_world(strength=1.0, color=(0.62, 0.70, 0.80))
    C.sun(direction=(-0.4, 0.5, -0.75), energy=4.0)
    poses = {
        'neutral': {},
        'deflected': {'stab_L': -0.35, 'stab_R': -0.35, 'aileron_L': 0.35, 'aileron_R': -0.35, 'flap_L': 0.45, 'flap_R': 0.45},
    }
    views = {'rear': ((0.55, -1.0, 0.55), 11, (0, -3.5, -0.4)), 'top': ((0.25, -0.35, 1.0), 11, (0, -3.5, -0.4)),
             'below': ((0.6, -0.8, -0.55), 11, (0, -3.5, -0.4)),
             'side_tail': ((1.0, -0.15, 0.12), 5, (1.2, -5.6, -0.5)), 'wing_te': ((0.35, -1.0, 0.25), 4.5, (2.2, -2.8, -0.7))}
    for pose, angles in poses.items():
        for lab in hinges:
            bpy.data.objects[lab].rotation_euler = (0, 0, 0)
        for lab, a in angles.items():
            # Blender X = glTF/three X and both are right-handed, so +a is trailing edge down in both.
            bpy.data.objects[lab].rotation_euler = (a, 0, 0)
        for vname, (d, dist, look) in views.items():
            look = Vector(look)
            C.camera(look + Vector(d).normalized() * dist, look_at=look, lens=40, name=f'cam_{vname}')
            C.render(os.path.join(outdir, f'{pose}_{vname}.png'))
    for lab in hinges:
        bpy.data.objects[lab].rotation_euler = (0, 0, 0)

C.export_glb(OUT, [root])
print('WROTE', OUT)
