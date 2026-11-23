"""Diagnostic: list large loose parts of the MiG airframe (control-surface hunt)."""
import os
import sys
import bpy
import bmesh
from mathutils import Vector
sys.path.insert(0, os.path.dirname(__file__))
import common as C

bpy.ops.wm.open_mainfile(filepath=os.path.join(C.BUILD, 'mig21_normalised.blend'))
for name in sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else ['Object_13', 'Object_12', 'Object_23']:
    o = bpy.data.objects[name]
    bm = bmesh.new()
    bm.from_mesh(o.data)
    bm.faces.ensure_lookup_table()
    seen = set()
    out = []
    for f in bm.faces:
        if f.index in seen:
            continue
        isl, st = [], [f]
        seen.add(f.index)
        while st:
            g = st.pop()
            isl.append(g)
            for e in g.edges:
                for h in e.link_faces:
                    if h.index not in seen:
                        seen.add(h.index)
                        st.append(h)
        pts = [v.co for g in isl for v in g.verts]
        mn = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
        mx = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
        if (mx - mn).length > 0.6:
            out.append((len(isl), mn, mx))
    out.sort(key=lambda t: (round(t[1].y, 1), t[1].x))
    print('==', name, len(out), 'large islands')
    for n, mn, mx in out:
        print(f'ISL {name} faces={n:6d} x[{mn.x:6.2f},{mx.x:6.2f}] y[{mn.y:6.2f},{mx.y:6.2f}] z[{mn.z:6.2f},{mx.z:6.2f}]')
