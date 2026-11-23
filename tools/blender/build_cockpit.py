"""mig21_cockpit.glb - first-person overlay for the player MiG-21.

The War Thunder-derived mig21.glb already has a full cockpit (tub, panel,
gunsight combiner, seat, canopy arch; see docs/v2/evidence/assets/cockpit/).
This overlay adds what it lacks for a first-person camera, in the same model
space Aircraft.js presents (metres, nose -Z, origin = bbox centre), so it is
parented to `aircraft.model` with an identity transform:

  eye            socket: measured pilot eye point
  hud            socket: centre of the gunsight combiner glass (HUD projection)
  mfd_screen     emissive display face over the panel's dark MFD
  aux_screen_*   emissive faces over the smaller displays
  periscope      canopy-top rear-view periscope fairing + mirror

Positions are found by ray-casting from the eye through points picked on
the reference renders, so they sit on the real panel geometry.

blender -b --python tools/blender/build_cockpit.py
node tools/blender/optimize-glb.mjs assets/authoring/build/mig21_cockpit_raw.glb public/models/mig21_cockpit.glb
"""
import math
import os
import sys
import bpy
import bmesh
from mathutils import Vector
sys.path.insert(0, os.path.dirname(__file__))
import common as C

EYE = Vector((0, 2.95, 0.22))  # blender coords; three (0, 0.22, -2.95)
RES = (1280, 720)

bpy.ops.wm.open_mainfile(filepath=os.path.join(C.BUILD, 'mig21_normalised.blend'))
sc = bpy.context.scene
sc.render.resolution_x, sc.render.resolution_y = RES
ref_objs = [o for o in bpy.data.objects if o.type == 'MESH']


def make_cam(pitch_deg):
    pitch = math.radians(pitch_deg)
    d = Vector((0, math.cos(pitch), math.sin(pitch)))
    o = C.camera(EYE, direction=d, name=f'probe{pitch_deg}')
    o.data.sensor_fit = 'VERTICAL'
    o.data.angle_y = math.radians(62)
    bpy.context.view_layer.update()
    return o


def ray(cam, px, py, only=None):
    """World hit for pixel (px, py) of a RES render from `cam`."""
    fr = [cam.matrix_world @ v for v in cam.data.view_frame(scene=sc)]
    # view_frame order: top-right, bottom-right, bottom-left, top-left
    tr, br, bl, tl = fr
    u, v = px / RES[0], py / RES[1]
    top = tl.lerp(tr, u)
    bot = bl.lerp(br, u)
    p = top.lerp(bot, v)
    o = cam.matrix_world.translation
    d = (p - o).normalized()
    dg = bpy.context.evaluated_depsgraph_get()
    hit, loc, nrm, _, obj, _ = sc.ray_cast(dg, o, d)
    skip = 0
    while hit and only and obj.name not in only and skip < 8:
        hit, loc, nrm, _, obj, _ = sc.ray_cast(dg, loc + d * 1e-3, d)
        skip += 1
    return (loc, nrm, obj.name) if hit else (None, None, None)


cam_fwd = make_cam(-4)
cam_down = make_cam(-30)
hud_c, hud_n, hud_obj = ray(cam_fwd, 637, 330, only={'Object_30', 'Object_9'})
print('HUD hit', hud_obj, tuple(round(v, 3) for v in hud_c), tuple(round(v, 2) for v in hud_n))

SCREENS = {
    # name: (tl, tr, bl) pixels in the -30 deg view; colour; texture kind
    'mfd_screen': ((672, 420), (814, 420), (672, 522), 'mfd'),
    'aux_screen_c': ((560, 490), (600, 490), (560, 538), 'text'),
    'aux_screen_l': ((432, 290), (464, 290), (432, 334), 'text'),
    'aux_screen_r': ((810, 290), (842, 290), (810, 334), 'text'),
    'aux_screen_tr': ((868, 250), (922, 250), (868, 306), 'mfd'),
}


def screen_image(kind, w=256, h=256):
    name = f'cockpit_{kind}'
    img = bpy.data.images.get(name) or bpy.data.images.new(name, w, h, alpha=False)
    px = [0.0] * (w * h * 4)
    cx, cy = w * 0.5, h * 0.18
    for y in range(h):
        for x in range(w):
            r = g = b = 0.0
            g = 0.035 + 0.02 * ((x // 4 + y // 4) % 2) * 0  # dark phosphor base
            b = 0.02
            if kind == 'mfd':
                d = math.hypot(x - cx, y - cy)
                ang = math.degrees(math.atan2(x - cx, y - cy))
                on = False
                for rr in (60, 110, 160, 210):
                    if abs(d - rr) < 1.2 and abs(ang) < 60:
                        on = True
                if abs(ang - 60) < 0.5 or abs(ang + 60) < 0.5 or (abs(ang) < 0.4 and d < 215):
                    on = on or d < 215
                if 14 < x < 20 and 30 < y < 226 and y % 24 < 2:
                    on = True
                if (x - 150) ** 2 + (y - 160) ** 2 < 16 or (x - 95) ** 2 + (y - 120) ** 2 < 12:
                    on = True
                if on:
                    r, g, b = 0.25, 1.0, 0.45
            else:
                # rows of digits-like segments
                row = y // 32
                col = x // 22
                if 6 < y % 32 < 22 and 4 < x % 22 < 16 and (row * 7 + col * 3) % 5 != 0 and row < 7:
                    seg = (x % 22 < 6 or x % 22 > 14 or y % 32 in (7, 8, 14, 15, 21))
                    if seg:
                        r, g, b = 1.0, 0.62, 0.15
            i = (y * w + x) * 4
            px[i:i + 4] = (r, g, b, 1.0)
    img.pixels[:] = px
    img.filepath_raw = os.path.join(C.BUILD, f'{name}.png')
    img.file_format = 'PNG'
    img.save()
    return img


def emissive_mat(name, img, strength=2.5):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    b = nt.nodes['Principled BSDF']
    t = nt.nodes.new('ShaderNodeTexImage')
    t.image = img
    nt.links.new(t.outputs['Color'], b.inputs['Base Color'])
    nt.links.new(t.outputs['Color'], b.inputs['Emission Color'])
    b.inputs['Emission Strength'].default_value = strength
    b.inputs['Roughness'].default_value = 0.25
    return m


# ---- build overlay
for o in list(bpy.data.objects):
    o.hide_render = True
out_coll = C.coll('cockpit_overlay')
root = C.empty('mig21_cockpit', collection=out_coll)
root['note'] = 'Parent to aircraft.model with identity transform (aircraft model space).'
eye = C.empty('eye', EYE, parent=root, collection=out_coll)
if hud_c is not None:
    C.empty('hud', hud_c, parent=root, collection=out_coll)

mats = {k: emissive_mat(f'screen_{k}', screen_image(k)) for k in ('mfd', 'text')}
for name, (tl, tr, bl, kind) in SCREENS.items():
    a, na, oa = ray(cam_down, *tl)
    b, nb, ob = ray(cam_down, *tr)
    c, nc, oc = ray(cam_down, *bl)
    if a is None or b is None or c is None:
        print('SCREEN MISS', name)
        continue
    n = ((b - a).cross(c - a)).normalized()
    if n.dot(EYE - a) < 0:
        n = -n
    off = n * 0.002
    d = b + (c - a)
    bm = bmesh.new()
    vs = [bm.verts.new(p + off) for p in (c, d, b, a)]  # bl, br, tr, tl
    f = bm.faces.new(vs)
    uv = bm.loops.layers.uv.new('UVMap')
    for loop, t in zip(f.loops, ((0, 0), (1, 0), (1, 1), (0, 1))):
        loop[uv].uv = t
    if f.normal.dot(EYE - a) < 0:
        f.normal_flip()
    C.mesh_obj(name, bm, mats[kind], collection=out_coll, parent=root)
    print('SCREEN', name, oa, tuple(round(v, 3) for v in a), 'size', round((b - a).length, 3), round((c - a).length, 3))

# periscope fairing on the canopy top (canopy apex measured at y~2.75, z~0.43)
paint = C.pbr('periscope_paint', (0.32, 0.35, 0.38), rough=0.55, metal=0.2)
mirror = C.pbr('periscope_mirror', (0.9, 0.92, 0.95), rough=0.05, metal=1.0)
bm = bmesh.new()
bmesh.ops.create_uvsphere(bm, u_segments=12, v_segments=6, radius=1.0)
bmesh.ops.scale(bm, vec=(0.035, 0.11, 0.03), verts=bm.verts)
for v in bm.verts:
    if v.co.z < 0:
        v.co.z *= 0.2
    if v.co.y > 0:
        v.co.y *= 1.4  # longer, pointed nose
bmesh.ops.translate(bm, vec=(0, 2.95, 0.432), verts=bm.verts)
peri = C.mesh_obj('periscope', bm, paint, collection=out_coll, parent=root, smooth=True)
bm = bmesh.new()
bmesh.ops.create_grid(bm, x_segments=1, y_segments=1, size=0.025)
for v in bm.verts:
    v.co.z += 0
bmesh.ops.rotate(bm, cent=(0, 0, 0), matrix=__import__('mathutils').Matrix.Rotation(math.radians(70), 3, 'X'), verts=bm.verts)
bmesh.ops.translate(bm, vec=(0, 2.86, 0.425), verts=bm.verts)
C.mesh_obj('periscope_mirror', bm, mirror, collection=out_coll, parent=root)

objs = [o for o in out_coll.objects if o.type == 'MESH']
print('COCKPIT overlay tris', C.tri_count(objs))
C.export_glb(os.path.join(C.BUILD, 'mig21_cockpit_raw.glb'), [root])

# check render: the reference cockpit + overlay, from the eye
for o in bpy.data.objects:
    o.hide_render = False
C.setup_render(res=RES, samples=24)
C.sky_world(strength=1.2)
C.sun(direction=(-0.3, 0.5, -0.8), energy=4.5)
sc.camera = cam_down
C.render(os.path.join(C.ROOT, 'docs', 'v2', 'evidence', 'assets', 'cockpit', 'overlay_eye_down_panel.png'))
sc.camera = cam_fwd
C.render(os.path.join(C.ROOT, 'docs', 'v2', 'evidence', 'assets', 'cockpit', 'overlay_eye_forward.png'))
