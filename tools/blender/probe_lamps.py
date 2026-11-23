"""Find the navigation-lamp lenses and the true wingtips on the baked mig21.glb.

blender -b --factory-startup --python tools/blender/probe_lamps.py [-- decoded.glb]

Prints, in runtime model space (glTF / three: x right, y up, z aft, metres):
  * every loose part of the `glass_misc` mesh (lamp lenses, small glazing)
  * the outermost airframe vertices on each wing (the wingtip)
  * the highest points of the fin and the spine/belly lamp bumps
Used to place the sprites in src/world/timeofday/lights/fixtures.js.
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
    """Blender world -> glTF/three model space."""
    return (round(v.x, 3), round(v.z, 3), round(-v.y, 3))


def islands(o):
    bm = bmesh.new()
    bm.from_mesh(o.data)
    bm.verts.ensure_lookup_table()
    seen = set()
    out = []
    M = o.matrix_world
    for v in bm.verts:
        if v.index in seen:
            continue
        stack = [v]
        seen.add(v.index)
        pts = []
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
        out.append(((mn + mx) / 2, mx - mn, len(pts)))
    bm.free()
    return out


meshes = [o for o in bpy.data.objects if o.type == 'MESH']
for o in meshes:
    a, b = C.bbox_world([o])
    print(f'OBJ {o.name:22s} verts={len(o.data.vertices):6d} min={g(Vector((a.x, b.y, a.z)))} max={g(Vector((b.x, a.y, b.z)))}')

glass = [o for o in meshes if 'glass_misc' in o.name]
for o in glass:
    for c, s, n in sorted(islands(o), key=lambda t: t[0].x):
        print('GLASS island centre', g(c), 'size', (round(s.x, 3), round(s.z, 3), round(s.y, 3)), 'verts', n)

# outermost vertices (wingtips) over all meshes
allv = []
for o in meshes:
    M = o.matrix_world
    for v in o.data.vertices:
        allv.append((M @ v.co, o.name))
for side, key in (('L', lambda t: t[0].x), ('R', lambda t: -t[0].x)):
    best = sorted(allv, key=key)[:12]
    print('WINGTIP', side, [(g(p), n) for p, n in best])
top = sorted(allv, key=lambda t: -t[0].z)[:8]
print('TOP', [(g(p), n) for p, n in top])
aft = sorted(allv, key=lambda t: t[0].y)[:8]
print('AFT', [(g(p), n) for p, n in aft])

# fuselage top / bottom on the centreline (spine beacon, belly strobe)
sc = bpy.context.scene
hide = {'stores', 'pylons', 'gear_doors', 'canopy_glass', 'glass_misc'}
for o in meshes:
    if o.name in hide:
        o.hide_set(True)
        o.hide_viewport = True
dg = bpy.context.evaluated_depsgraph_get()
for z in (-2.0, -1.0, -0.5, 0.0, 0.2, 0.4, 0.8, 1.2, 2.0, 3.0, 4.0):
    by = -z  # three z -> blender -y
    up = sc.ray_cast(dg, Vector((0, by, 6)), Vector((0, 0, -1)))
    dn = sc.ray_cast(dg, Vector((0, by, -6)), Vector((0, 0, 1)))
    print('CENTRELINE z', z, 'top', g(up[1]) if up[0] else None, up[4].name if up[0] else '',
          'bottom', g(dn[1]) if dn[0] else None, dn[4].name if dn[0] else '')
    # every surface crossed going up from below (tank, then belly skin, ...)
    hits, o = [], Vector((0, by, -6))
    for _ in range(6):
        h = sc.ray_cast(dg, o, Vector((0, 0, 1)))
        if not h[0]:
            break
        hits.append((round(h[1].z, 3), h[4].name))
        o = h[1] + Vector((0, 0, 0.002))
    print('   up-stack', hits)

# what is around the wing lamp lenses and the tail lamp: rays toward each lens
for o in meshes:
    o.hide_viewport = o.name in ('stores', 'pylons')
dg = bpy.context.evaluated_depsgraph_get()
for name, p in (('wingR', (2.81, -0.746, 1.419)), ('wingL', (-2.81, -0.746, 1.419)), ('tail', (0.0, 1.704, 7.635))):
    for d in ((0, 0, 1), (0, 0, -1), (0, -1, 0), (0, 1, 0), (1, 0, 0), (-1, 0, 0)):
        bd = Vector((d[0], -d[2], d[1]))
        bp = Vector((p[0], -p[2], p[1]))
        h = sc.ray_cast(dg, bp - bd * 0.5, bd)
        print('LAMP', name, 'ray dir', d, 'first hit', g(h[1]) if h[0] else None, h[4].name if h[0] else '')
