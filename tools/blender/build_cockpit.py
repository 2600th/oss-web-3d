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

The `hud` socket is found by ray-casting from the eye through a point picked
on the reference render. The display faces are not picked that way any more:
each is the rectangle of its painted glass, mapped from the cockpit atlas
through the panel's own UVs (tools/blender/probe-cockpit-screens.mjs prints
the SCREENS table), and laid 2 mm proud of the panel face found under it.

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

# The displays are drawn in the cockpit atlas on flat panel faces that stand
# upright and face the pilot (normal -Y here). name: the painted glass as
# (x0, x1, z0, z1) in aircraft model space (Blender: x right, z up; printed by
# tools/blender/probe-cockpit-screens.mjs), texture kind, and the window of
# the texture it shows as (u0, v0, u1, v1), v up.
#
# The first version built each quad from three pixels picked on the -30 deg
# reference view (top-left, top-right, bottom-left) and ray-cast from the eye.
# Two of those picks landed on the stick grip, which stands between the eye and the
# panel: mfd_screen came out as a shelf lying 72 deg off the panel with its
# lower edge 10 cm towards the pilot, and aux_screen_c as a sliver across the
# stick's side, its rows of digits running up and back. The three that did hit
# their panel were parallelograms (a rectangle in the view is not one on the
# panel), so the gunsight displays leaned 10 deg and left their painted glass
# showing along two edges.
FULL = (0.0, 0.0, 1.0, 1.0)
TEXT_ROWS = 6  # rows of the readout texture (upgrade-cockpit-textures.mjs, textSVG)
SCREENS = {
    'mfd_screen': ((0.0361, 0.1663, -0.2377, -0.1113), 'mfd', FULL),
    # a 72 mm square: the top four rows, so a digit keeps the proportions it has
    # on the narrow gunsight displays (the readout is drawn for their shape)
    'aux_screen_c': ((-0.0913, -0.0198, -0.2766, -0.2048), 'text', (0.0, 1 - 4 / TEXT_ROWS, 1.0, 1.0)),
    'aux_screen_l': ((-0.1295, -0.1104, 0.0439, 0.0758), 'text', FULL),
    'aux_screen_r': ((0.1080, 0.1270, 0.0439, 0.0758), 'text', FULL),
    'aux_screen_tr': ((0.1749, 0.2374, -0.0071, 0.0540), 'mfd', FULL),
}
PROUD = 0.002  # m in front of the panel face: clear of depth fighting, no visible parallax
# The readout glass is painted white, and the atlas is ~1 px per mm: cover its
# soft edge. The radar glass is painted black, so those quads stop at the art.
BLEED = {'text': 0.001, 'mfd': 0.0}
TEXT_ASPECT = (0.0191 + 2 * BLEED['text']) / (0.0319 + 2 * BLEED['text'])  # gunsight display, w / h


def panel_under(x0, x1, z0, z1, n=9):
    """Depth (y) of the pilot-facing panel face behind a model-space rectangle.

    Rays run along the nose axis through a grid over the rectangle and pass
    through whatever stands in front (stick, gunsight box): the panel is the
    nearest depth that every ray meets on a face looking straight back at the
    pilot. Also returns how many rays met anything else within 1 cm in front
    of it, which would poke through the display.
    """
    dg = bpy.context.evaluated_depsgraph_get()
    d = Vector((0, 1, 0))
    seen = {}
    rays = []
    for j in range(n):
        for i in range(n):
            o = Vector((x0 + (x1 - x0) * (i + 0.5) / n, EYE.y, z0 + (z1 - z0) * (j + 0.5) / n))
            hits = []
            for _ in range(64):
                hit, loc, nrm, _, obj, _ = sc.ray_cast(dg, o, d)
                if not hit or loc.y > EYE.y + 1.0:
                    break
                hits.append((loc.y, nrm.y))
                o = loc + d * 1e-4
            rays.append(hits)
            for key in {round(y, 3) for y, ny in hits if ny < -0.99}:
                seen[key] = seen.get(key, 0) + 1
    full = sorted(k for k, c in seen.items() if c == n * n)
    if not full:
        raise SystemExit(f'no flat panel face behind ({x0}, {x1}, {z0}, {z1}): {sorted(seen.items())}')
    key = full[0]
    depth = sum(y for hits in rays for y, ny in hits if ny < -0.99 and round(y, 3) == key) / (n * n)
    proud = sum(1 for hits in rays if any(depth - 0.01 < y < depth - 1e-4 for y, _ in hits))
    return depth, proud


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
for name, ((x0, x1, z0, z1), kind, (u0, v0, u1, v1)) in SCREENS.items():
    depth, poking = panel_under(x0, x1, z0, z1)
    if poking:
        raise SystemExit(f'{name}: {poking} rays meet cockpit geometry within 1 cm in front of the panel')
    e = BLEED[kind]
    x0, x1, z0, z1 = x0 - e, x1 + e, z0 - e, z1 + e
    y = depth - PROUD  # the pilot sits at smaller y
    bm = bmesh.new()
    # bottom-left, bottom-right, top-right, top-left as the pilot sees them (x = his right, z = up)
    corners = ((x0, z0, u0, v0), (x1, z0, u1, v0), (x1, z1, u1, v1), (x0, z1, u0, v1))
    f = bm.faces.new([bm.verts.new((x, y, z)) for x, z, _, _ in corners])
    uv = bm.loops.layers.uv.new('UVMap')
    for loop, (_, _, u, v) in zip(f.loops, corners):
        loop[uv].uv = (u, v)
    bm.normal_update()
    if f.normal.dot(EYE - f.calc_center_median()) < 0:
        raise SystemExit(f'{name}: face winds away from the eye (the texture would read mirrored)')
    C.mesh_obj(name, bm, mats[kind], collection=out_coll, parent=root)
    # how far the texture is stretched on this quad (1 = a digit keeps its drawn proportions)
    drawn = TEXT_ASPECT if kind == 'text' else 1.0
    stretch = ((x1 - x0) / (z1 - z0)) / (drawn * (u1 - u0) / (v1 - v0))
    print('SCREEN', name, 'panel y', round(depth, 4), 'size mm', round((x1 - x0) * 1000, 1), round((z1 - z0) * 1000, 1), 'texture stretch', round(stretch, 3))

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
