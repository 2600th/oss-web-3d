"""Render a quick 3/4 preview of one or more GLBs (as shipped) side by side.

blender -b --python tools/blender/preview.py -- out.png a.glb [b.glb ...]
GLBs are laid out along +X (blender), each framed by its bbox.
"""
import math
import os
import sys
import bpy
from mathutils import Vector
sys.path.insert(0, os.path.dirname(__file__))
import common as C

args = C.argv()
out, files = os.path.abspath(args[0]), [os.path.abspath(f) for f in args[1:]]
C.reset()
C.setup_render(res=(1600, 900), samples=32)
C.sky_world(strength=1.0, color=(0.62, 0.70, 0.80))
C.sun(direction=(-0.5, 0.6, -0.65), energy=4.0)
x = 0.0
groups = []
for f in files:
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=f)
    objs = [o for o in bpy.data.objects if o not in before]
    roots = [o for o in objs if o.parent is None]
    mn, mx = C.bbox_world(objs)
    w = mx.x - mn.x
    for r in roots:
        r.location.x += x - mn.x
    x += w + max(0.4, w * 0.15)
    groups.append(objs)
    print('IMPORTED', os.path.basename(f), 'tris', C.tri_count(objs), 'size', tuple(round(v, 2) for v in (mx - mn)))
allo = [o for g in groups for o in g]
mn, mx = C.bbox_world(allo)
centre = (mn + mx) / 2
ext = (mx - mn).length
VIEWS = {'rear': (0.35, -0.9, 0.45), 'front': (-0.45, 0.85, 0.5), 'side': (1.0, 0.05, 0.25), 'top': (0.05, 0.1, 1.0)}
vx = Vector(VIEWS[os.environ.get('VIEW', 'front')])
cam = C.camera(centre + vx * ext, look_at=centre, lens=50)
# ground plane for contact
bpy.ops.mesh.primitive_plane_add(size=ext * 6, location=(centre.x, centre.y, mn.z))
bpy.context.object.data.materials.append(C.pbr('ground', (0.42, 0.40, 0.37), rough=0.95))
# fit
bpy.ops.object.select_all(action='DESELECT')
for o in allo:
    if o.type == 'MESH':
        o.select_set(True)
bpy.context.view_layer.update()
try:
    bpy.ops.view3d.camera_to_view_selected()
except Exception:
    pass
C.render(out)
