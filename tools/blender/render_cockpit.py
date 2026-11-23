"""Pilot's-eye renders from inside public/models/mig21.glb (cockpit feasibility).

blender -b --python tools/blender/render_cockpit.py -- [outdir]
Needs assets/authoring/build/mig21_normalised.blend (tools/blender/inspect_mig.py).

Blender space here = aircraft model space as Aircraft.js presents it, Z-up:
  three (x, y, z)  <->  blender (x, -z, y);  nose = blender +Y.
"""
import math
import os
import sys
import bpy
from mathutils import Vector
sys.path.insert(0, os.path.dirname(__file__))
import common as C

out = (C.argv() or [os.path.join(C.ROOT, 'docs', 'v2', 'evidence', 'assets', 'cockpit')])[0]
bpy.ops.wm.open_mainfile(filepath=os.path.join(C.BUILD, 'mig21_normalised.blend'))
C.setup_render(res=(1280, 720), samples=24)
C.sky_world(strength=1.2)
C.sun(direction=(-0.3, 0.5, -0.8), energy=4.5)

# Eye points (blender coords). The Aircraft.js socket is (0, 0.95, -3.1) three
# = (0, 3.1, 0.95) here; the measured pilot eye (see README) is lower and aft.
SOCKET = Vector((0, 3.1, 0.95))
EYE = Vector((0, float(os.environ.get('EYE_Y', 2.95)), float(os.environ.get('EYE_Z', 0.22))))


def cam(name, loc, yaw_deg=0, pitch_deg=0, vfov=62):
    # yaw positive = look left (towards -X), pitch positive = up
    yaw, pitch = math.radians(yaw_deg), math.radians(pitch_deg)
    d = Vector((-math.sin(yaw) * math.cos(pitch), math.cos(yaw) * math.cos(pitch), math.sin(pitch)))
    o = C.camera(loc, direction=d, name=name)
    o.data.sensor_fit = 'VERTICAL'
    o.data.angle_y = math.radians(vfov)
    o.data.clip_start = 0.02
    return o


views = [
    ('socket_forward', SOCKET, 0, 0),
    ('eye_forward', EYE, 0, -4),
    ('eye_left', EYE, 75, -8),
    ('eye_right', EYE, -75, -8),
    ('eye_down_panel', EYE, 0, -30),
    ('eye_back_left', EYE, 140, 5),
]
for name, loc, yaw, pitch in views:
    cam(name, loc, yaw, pitch)
    C.render(os.path.join(out, f'{name}.png'))

# Section view: camera off to the right looking at the cockpit; the near clip
# plane sits on the centreline so the starboard half is cut away.
c = cam('side_section', Vector((3.2, 2.9, 0.0)), 90, 0, vfov=30)
c.data.clip_start = 3.2  # clip away the near (starboard) skin
# markers
for nm, p, col in (('marker_socket', SOCKET, (1, 0, 0)), ('marker_eye', EYE, (0, 1, 0))):
    bpy.ops.mesh.primitive_uv_sphere_add(radius=0.05, location=p)
    s = bpy.context.object
    s.name = nm
    s.data.materials.append(C.pbr(nm, col, emissive=col, emissive_strength=8))
C.render(os.path.join(out, 'side_section.png'))
c2 = cam('side_full', Vector((9.0, 2.6, 0.0)), 90, 0, vfov=22)
C.render(os.path.join(out, 'side_eye_markers.png'))
