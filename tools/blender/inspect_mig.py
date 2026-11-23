"""Import the decoded MiG-21, normalise it like Aircraft.js and print what is in it.

blender -b --factory-startup --python tools/blender/inspect_mig.py
Saves assets/authoring/build/mig21_normalised.blend for further scripts.
"""
import os
import sys
import bpy
sys.path.insert(0, os.path.dirname(__file__))
import common as C

C.reset()
meshes, info = C.import_mig()
print('NORMALISE', info)
mn, mx = C.bbox_world(meshes)
print('BBOX (blender: x right, y nose, z up)', tuple(round(v, 3) for v in mn), tuple(round(v, 3) for v in mx))
for o in meshes:
    a, b = C.bbox_world([o])
    me = o.data
    me.calc_loop_triangles()
    mats = [m.name[:8] if m else None for m in me.materials]
    print(f'OBJ {o.name:10s} tris={len(me.loop_triangles):7d} min={tuple(round(v,2) for v in a)} max={tuple(round(v,2) for v in b)} mats={mats}')
for m in bpy.data.materials:
    imgs = []
    if m.use_nodes:
        for n in m.node_tree.nodes:
            if n.type == 'TEX_IMAGE' and n.image:
                links = [l.to_socket.name for l in n.outputs[0].links]
                imgs.append((n.image.name, tuple(n.image.size), links))
    print('MAT', m.name, imgs)
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(C.BUILD, 'mig21_normalised.blend'))
