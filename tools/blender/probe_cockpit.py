"""Measure the cockpit of the baked mig21.glb for the pilot figure.

blender -b --factory-startup --python tools/blender/probe_cockpit.py [-- decoded.glb]

Prints, in runtime model space (three: x right, y up, z aft, metres): the
loose parts of the seat and interior near the stick and the left-console
throttle, and seat-cushion / back / pedal heights from ray casts.
"""
import os
import sys
import bpy
import bmesh
from mathutils import Vector
sys.path.insert(0, os.path.dirname(__file__))
import common as C

path = (C.argv() or [C.MIG_DECODED])[0]
C.reset()
bpy.ops.import_scene.gltf(filepath=path)
bpy.context.view_layer.update()


def g(v):
    return (round(v.x, 3), round(v.z, 3), round(-v.y, 3))


def islands(o):
    bm = bmesh.new()
    bm.from_mesh(o.data)
    bm.verts.ensure_lookup_table()
    seen, out, M = set(), [], o.matrix_world
    for v in bm.verts:
        if v.index in seen:
            continue
        stack, pts = [v], []
        seen.add(v.index)
        while stack:
            a = stack.pop()
            pts.append(M @ a.co)
            for e in a.link_edges:
                b = e.other_vert(a)
                if b.index not in seen:
                    seen.add(b.index)
                    stack.append(b)
        mn = Vector(map(min, *pts)) if len(pts) > 1 else pts[0]
        mx = Vector(map(max, *pts)) if len(pts) > 1 else pts[0]
        out.append((mn, mx, len(pts)))
    bm.free()
    return out


objs = {o.name: o for o in bpy.data.objects if o.type == 'MESH'}
for name in ('cockpit_interior', 'cockpit_seat'):
    o = objs[name]
    isl = islands(o)
    print(name, 'islands', len(isl))
    for mn, mx, n in sorted(isl, key=lambda t: -t[2]):
        a, b = g(Vector((mn.x, mx.y, mn.z))), g(Vector((mx.x, mn.y, mx.z)))
        c = ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2)
        size = (round(b[0] - a[0], 3), round(b[1] - a[1], 3), round(b[2] - a[2], 3))
        stick = abs(c[0]) < 0.12 and -3.6 < c[2] < -3.0 and -0.75 < c[1] < 0.0
        left = c[0] < -0.2 and -3.3 < c[2] < -2.3 and -0.7 < c[1] < 0.0
        if name == 'cockpit_seat' or ((stick or left) and n >= 20 and max(size) > 0.04):
            print(f'  {"STICK" if stick else "LEFT " if left else "SEAT "} c={tuple(round(x, 3) for x in c)} size={size} verts={n}')

sc = bpy.context.scene
dg = bpy.context.evaluated_depsgraph_get()
for nm in list(objs):
    if nm in ('canopy_glass', 'glass_misc'):
        objs[nm].hide_viewport = True
dg = bpy.context.evaluated_depsgraph_get()


def ray(o3, d3):
    o = Vector((o3[0], -o3[2], o3[1]))
    d = Vector((d3[0], -d3[2], d3[1]))
    h = sc.ray_cast(dg, o, d)
    return (g(h[1]), h[4].name) if h[0] else None


print('SEAT PAN (down)')
for z in (-3.25, -3.15, -3.05, -2.95, -2.85, -2.75, -2.65):
    for x in (0.0, 0.12):
        print('  z', z, 'x', x, ray((x, 0.0, z), (0, -1, 0)))
print('SEAT BACK (aft)')
for y in (-0.45, -0.3, -0.15, 0.0, 0.1, 0.2, 0.3):
    print('  y', y, ray((0.0, y, -3.0), (0, 0, 1)), ray((0.12, y, -3.0), (0, 0, 1)))
print('FLOOR/PEDALS (down, fwd)')
for z in (-3.4, -3.6, -3.8, -4.0):
    for x in (-0.15, 0.15):
        print('  z', z, 'x', x, ray((x, -0.35, z), (0, -1, 0)))
print('FWD from knees')
for x in (-0.15, 0.15):
    for y in (-0.45, -0.6, -0.7):
        print('  x', x, 'y', y, ray((x, y, -3.2), (0, 0, -1)))
print('SIDES')
for y in (-0.4, -0.2, 0.0, 0.2, 0.35):
    for z in (-3.1, -2.85):
        print('  y', y, 'z', z, 'L', ray((0, y, z), (-1, 0, 0)), 'R', ray((0, y, z), (1, 0, 0)))
print('CANOPY above head')
for z in (-3.1, -2.95, -2.8):
    for x in (0.0, 0.1):
        objs['canopy_glass'].hide_viewport = False
        dg = bpy.context.evaluated_depsgraph_get()
        print('  z', z, 'x', x, ray((x, 0.22, z), (0, 1, 0)))
