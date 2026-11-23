"""mig21_hostile_lod1: a distant-enemy LOD (<= 25k tris) from the repainted airframe.

  node tools/blender/build-mig-variants.mjs        (writes build/mig21_hostile_raw.glb)
  blender -b --python tools/blender/build_mig_lod1.py
  node tools/blender/optimize-glb.mjs assets/authoring/build/mig21_hostile_lod1_raw.glb public/models/mig21_hostile_lod1.glb --tex 512

The source has ~90k triangles of rivets/bolts modelled as loose geometry and
every skin panel is its own UV island, so a seam-preserving simplifier stalls
around 35k. Here we drop the cockpit and tiny loose parts, weld the panels by
position (Blender keeps UVs per face-corner, so seams survive), then collapse.
"""
import os
import sys
import bpy
import bmesh
from mathutils import Vector
sys.path.insert(0, os.path.dirname(__file__))
import common as C

SRC = os.path.join(C.BUILD, 'mig21_hostile_raw.glb')
OUT = os.path.join(C.BUILD, 'mig21_hostile_lod1_raw.glb')
TARGET = int(os.environ.get('TARGET', 23500))
MIN_ISLAND = float(os.environ.get('MIN_ISLAND', 0.06))  # metres

C.reset()
bpy.ops.import_scene.gltf(filepath=SRC)
for name in ('pitot',):
    o = bpy.data.objects.get(name)
    if o:
        bpy.data.objects.remove(o)
meshes = [o for o in bpy.data.objects if o.type == 'MESH']
# bake the root transform so island sizes are in metres
root = [o for o in bpy.data.objects if o.parent is None][0]
for o in meshes:
    mw = o.matrix_world.copy()
    o.parent = None
    o.matrix_world = mw
C.select_only(meshes)
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

removed = 0
for o in meshes:
    bm = bmesh.new()
    bm.from_mesh(o.data)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=0.0015)
    bm.faces.ensure_lookup_table()
    seen = set()
    kill = []
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
        if (mx - mn).length < MIN_ISLAND:
            kill.extend(isl)
    removed += sum(len(f.verts) - 2 for f in kill)
    bmesh.ops.delete(bm, geom=kill, context='FACES')
    bm.to_mesh(o.data)
    bm.free()
base = C.tri_count(meshes)
print('LOD1 base after cleanup', base, 'removed', removed)
for o in meshes:
    print('LOD1 part', o.name, C.tri_count([o]))

# Per-part weight: the silhouette (airframe) keeps relatively more, stores and
# the cockpit tub much less; small parts are left alone.
WEIGHT = {'airframe': 1.25, 'stores': 0.45, 'cockpit_interior': 0.15, 'cockpit_seat': 0.15,
          'underside': 1.0, 'details_alpha': 0.6}
KEEP = {'canopy_glass', 'glass_misc', 'flaps', 'gear_doors', 'strake', 'pitot'}
ratio = TARGET / base
for it in range(8):
    for o in meshes:
        if o.name in KEEP or C.tri_count([o]) < 400:
            continue
        m = o.modifiers.get('dec') or o.modifiers.new('dec', 'DECIMATE')
        m.decimate_type = 'COLLAPSE'
        m.ratio = min(1.0, ratio * WEIGHT.get(o.name, 1.0))
        m.use_collapse_triangulate = True
        m.use_symmetry = True
        m.symmetry_axis = 'X'
    n = C.tri_count(meshes)
    print('LOD1 ratio', round(ratio, 4), '->', n)
    if n <= 25000:
        break
    ratio *= TARGET / n
for o in meshes:
    if o.modifiers.get('dec'):
        C.select_only([o])
        bpy.ops.object.modifier_apply(modifier='dec')
    o.data.validate()

holder = bpy.data.objects.new('mig21_hostile_lod1', None)
bpy.context.scene.collection.objects.link(holder)
for o in meshes:
    o.parent = holder
holder['lod'] = 1
C.export_glb(OUT, [holder])
print('LOD1 tris', C.tri_count(meshes))
