"""Render one framed thumbnail per shipped GLB (for the contact sheet).

blender -b --python tools/blender/render_thumbs.py -- <outdir> a.glb [b.glb ...]
Then: node tools/blender/contact-sheet.mjs
"""
import math
import os
import sys
import bpy
from mathutils import Vector
sys.path.insert(0, os.path.dirname(__file__))
import common as C

args = C.argv()
outdir = os.path.abspath(args[0])
files = [os.path.abspath(f) for f in args[1:]]
os.makedirs(outdir, exist_ok=True)
for f in files:
    C.reset()
    sc = C.setup_render(res=(640, 480), samples=24)
    C.sky_world(strength=0.9, color=(0.62, 0.70, 0.80))
    C.sun(direction=(-0.45, 0.55, -0.70), energy=4.2)
    bpy.ops.import_scene.gltf(filepath=f)
    objs = [o for o in bpy.data.objects if o.type in ('MESH', 'EMPTY')]
    mn, mx = C.bbox_world(objs)
    centre = (mn + mx) / 2
    radius = max((mx - mn).length / 2, 0.05)
    d = Vector((-0.62, 0.70, 0.42)).normalized()
    fov = math.radians(32)
    dist = radius / math.sin(fov / 2) * 1.02
    cam = C.camera(centre + d * dist, look_at=centre)
    cam.data.sensor_fit = 'VERTICAL'
    cam.data.angle_y = fov
    cam.data.clip_start = dist * 0.01
    cam.data.clip_end = dist * 10
    bpy.ops.mesh.primitive_plane_add(size=radius * 40, location=(centre.x, centre.y, mn.z - 0.002))
    bpy.context.object.data.materials.append(C.pbr('ground', (0.34, 0.32, 0.29), rough=0.95))
    name = os.path.splitext(os.path.basename(f))[0]
    C.render(os.path.join(outdir, name + '.png'))
