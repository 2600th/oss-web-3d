"""Shared helpers for the Safed Sagar Blender asset scripts.

Conventions (see docs/v2/ARCHITECTURE.md):
  * metres, +Y up, forward (nose / muzzle / vehicle front) = -Z in glTF/three.
  * Blender is Z-up; the glTF exporter maps Blender (x, y, z) -> glTF (x, z, -y).
    So in Blender we model with FRONT = +Y, UP = +Z, RIGHT = +X.
"""
import bpy
import bmesh
import math
import os
import sys
from mathutils import Vector, Matrix

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
BUILD = os.path.join(ROOT, 'assets', 'authoring', 'build')
MIG_DECODED = os.path.join(BUILD, 'mig21_decoded.glb')
REAL_LENGTH = 15.76  # same constant as src/flight/Aircraft.js


def argv():
    return sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    for c in list(bpy.data.collections):
        bpy.data.collections.remove(c)


def eevee_engine():
    items = {e.identifier for e in bpy.types.RenderSettings.bl_rna.properties['engine'].enum_items}
    for n in ('BLENDER_EEVEE', 'BLENDER_EEVEE_NEXT'):
        if n in items:
            return n
    return 'CYCLES'


def world_mig_normalise(objs):
    """Apply the exact normalisation Aircraft.js performs at load time:
    centre the bbox on the origin, scale longest axis to REAL_LENGTH, rotate
    180 deg about up so the nose points along Blender +Y (= glTF -Z)."""
    bpy.context.view_layer.update()
    mn = Vector((1e9,) * 3)
    mx = Vector((-1e9,) * 3)
    for o in objs:
        if o.type != 'MESH':
            continue
        for c in o.bound_box:
            w = o.matrix_world @ Vector(c)
            mn = Vector(map(min, mn, w))
            mx = Vector(map(max, mx, w))
    centre = (mn + mx) / 2
    size = mx - mn
    longest = max(size)
    s = REAL_LENGTH / longest
    M = Matrix.Rotation(math.pi, 4, 'Z') @ Matrix.Scale(s, 4) @ Matrix.Translation(-centre)
    for o in objs:
        if o.parent is None:
            o.matrix_world = M @ o.matrix_world
    bpy.context.view_layer.update()
    return {'centre': tuple(centre), 'size': tuple(size), 'scale': s}


def import_mig(path=MIG_DECODED, apply=True):
    if not os.path.exists(path):
        raise SystemExit(f'missing {path}; run node tools/blender/decode-glb.mjs public/models/mig21.glb {path}')
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    objs = [o for o in bpy.data.objects if o not in before]
    info = world_mig_normalise(objs)
    meshes = [o for o in objs if o.type == 'MESH']
    if apply:
        # unparent + bake transforms so mesh data is in aircraft model space
        for o in meshes:
            mw = o.matrix_world.copy()
            o.parent = None
            o.matrix_world = mw
        for o in objs:
            if o.type != 'MESH':
                bpy.data.objects.remove(o)
        bpy.ops.object.select_all(action='DESELECT')
        for o in meshes:
            o.select_set(True)
        bpy.context.view_layer.objects.active = meshes[0]
        bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    return meshes, info


def bbox_world(objs):
    mn = Vector((1e9,) * 3)
    mx = Vector((-1e9,) * 3)
    for o in objs:
        if o.type != 'MESH':
            continue
        for c in o.bound_box:
            w = o.matrix_world @ Vector(c)
            mn = Vector(map(min, mn, w))
            mx = Vector(map(max, mx, w))
    return mn, mx


def tri_count(objs):
    dg = bpy.context.evaluated_depsgraph_get()
    n = 0
    for o in objs:
        if o.type != 'MESH':
            continue
        e = o.evaluated_get(dg)
        m = e.to_mesh()
        m.calc_loop_triangles()
        n += len(m.loop_triangles)
        e.to_mesh_clear()
    return n


# ---------------------------------------------------------------- render setup

def setup_render(res=(1280, 720), samples=32, engine=None, film_transparent=False):
    sc = bpy.context.scene
    sc.render.engine = engine or eevee_engine()
    sc.render.resolution_x, sc.render.resolution_y = res
    sc.render.resolution_percentage = 100
    sc.render.film_transparent = film_transparent
    sc.render.image_settings.file_format = 'PNG'
    try:
        sc.view_settings.view_transform = 'AgX'
    except Exception:
        pass
    if sc.render.engine == 'CYCLES':
        sc.cycles.samples = samples
        sc.cycles.use_denoising = True
        sc.cycles.device = 'CPU'
    else:
        try:
            sc.eevee.taa_render_samples = samples
        except Exception:
            pass
    return sc


def sky_world(strength=1.0, color=(0.55, 0.68, 0.85)):
    w = bpy.data.worlds.new('World')
    bpy.context.scene.world = w
    w.use_nodes = True
    nt = w.node_tree
    bg = nt.nodes.get('Background') or nt.nodes.new('ShaderNodeBackground')
    bg.inputs[0].default_value = (*color, 1)
    bg.inputs[1].default_value = strength
    out = nt.nodes.get('World Output') or nt.nodes.new('ShaderNodeOutputWorld')
    nt.links.new(bg.outputs[0], out.inputs[0])
    return w


def sun(direction=(-0.4, -0.6, -0.7), energy=4.0, angle=0.02):
    d = bpy.data.lights.new('sun', 'SUN')
    d.energy = energy
    d.angle = angle
    o = bpy.data.objects.new('sun', d)
    bpy.context.scene.collection.objects.link(o)
    o.rotation_euler = Vector(direction).to_track_quat('-Z', 'Y').to_euler()
    return o


def camera(loc, look_at=None, lens=35, fov_deg=None, name='cam', direction=None):
    c = bpy.data.cameras.new(name)
    c.clip_start = 0.02
    c.clip_end = 2000
    if fov_deg:
        c.lens_unit = 'FOV'
        c.angle = math.radians(fov_deg)
    else:
        c.lens = lens
    o = bpy.data.objects.new(name, c)
    bpy.context.scene.collection.objects.link(o)
    o.location = loc
    d = direction if direction is not None else (Vector(look_at) - Vector(loc))
    o.rotation_euler = Vector(d).to_track_quat('-Z', 'Y').to_euler()
    bpy.context.scene.camera = o
    return o


def render(path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    bpy.context.scene.render.filepath = path
    bpy.ops.render.render(write_still=True)
    print('rendered', path)


# ---------------------------------------------------------------- modelling

def coll(name):
    c = bpy.data.collections.get(name) or bpy.data.collections.new(name)
    if c.name not in bpy.context.scene.collection.children:
        bpy.context.scene.collection.children.link(c)
    return c


def link(o, collection=None):
    (collection or bpy.context.scene.collection).objects.link(o)
    return o


def empty(name, loc=(0, 0, 0), parent=None, collection=None, size=0.1):
    o = bpy.data.objects.new(name, None)
    o.empty_display_size = size
    o.empty_display_type = 'ARROWS'
    link(o, collection)
    if parent:
        o.parent = parent
    o.location = loc
    return o


def mesh_obj(name, bm, mat=None, collection=None, parent=None, smooth=None):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    o = bpy.data.objects.new(name, me)
    link(o, collection)
    if mat is not None:
        mats = mat if isinstance(mat, (list, tuple)) else [mat]
        for m in mats:
            me.materials.append(m)
    if parent:
        o.parent = parent
    if smooth is not None:
        for p in me.polygons:
            p.use_smooth = True
        if smooth is not True:
            try:
                me.set_sharp_from_angle(angle=math.radians(smooth))
            except Exception:
                pass
    return o


def pbr(name, color, rough=0.6, metal=0.0, emissive=None, emissive_strength=1.0, alpha=None):
    m = bpy.data.materials.get(name)
    if m:
        return m
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = (*color, 1)
    b.inputs['Roughness'].default_value = rough
    b.inputs['Metallic'].default_value = metal
    if emissive:
        b.inputs['Emission Color'].default_value = (*emissive, 1)
        b.inputs['Emission Strength'].default_value = emissive_strength
    if alpha is not None:
        b.inputs['Alpha'].default_value = alpha
        try:
            m.surface_render_method = 'BLENDED'
        except Exception:
            pass
        m.blend_method = 'BLEND' if hasattr(m, 'blend_method') else None
    return m


def select_only(objs, active=None):
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = active or objs[0]


def export_glb(path, objs, extras=None):
    """Export the given objects (and their children) as a GLB with +Y up."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    sel = set()

    def add(o):
        sel.add(o)
        for c in o.children:
            add(c)
    for o in objs:
        add(o)
    select_only(list(sel))
    if extras:
        for k, v in extras.items():
            bpy.context.scene[k] = v
    kw = dict(filepath=path, export_format='GLB', use_selection=True, export_yup=True,
              export_apply=True, export_extras=True, export_cameras=False, export_lights=False,
              export_animations=True, export_image_format='AUTO')
    try:
        bpy.ops.export_scene.gltf(**kw)
    except TypeError:
        kw.pop('export_image_format')
        bpy.ops.export_scene.gltf(**kw)
    print('exported', path)
