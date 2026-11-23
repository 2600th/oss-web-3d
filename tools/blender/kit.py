"""Procedural modelling + bake + export kit for Safed Sagar props.

Blender frame while modelling: FRONT = +Y, UP = +Z, RIGHT = +X, metres.
The glTF exporter turns that into three.js FRONT = -Z, UP = +Y.

An asset is a hierarchy of *nodes* (empties or meshes) under a root empty
named after the asset id. Moving parts (turret, barrels, dish, launcher...)
are mesh objects whose origin is their pivot; sockets are empties.
"""
import json
import math
import os
import random
import subprocess
import sys

import bmesh
import bpy
from mathutils import Matrix, Vector

sys.path.insert(0, os.path.dirname(__file__))
import common as C  # noqa: E402

V = Vector
OUT_MODELS = os.path.join(C.ROOT, 'public', 'models')
RAW = os.path.join(C.BUILD, 'raw')
NODE = os.environ.get('NODE_BIN', 'node')


# ============================================================== materials
# Palette (linear-ish sRGB values as typed into Blender colour fields).
PALETTE = {
    # name: (color, roughness, metallic)
    'olive': ((0.125, 0.135, 0.072), 0.72, 0.05),
    'khaki': ((0.200, 0.175, 0.105), 0.78, 0.05),
    'sand': ((0.330, 0.270, 0.170), 0.80, 0.03),
    'grey_paint': ((0.150, 0.160, 0.165), 0.60, 0.10),
    'steel': ((0.055, 0.055, 0.058), 0.42, 0.85),
    'gunmetal': ((0.030, 0.031, 0.033), 0.38, 0.90),
    'rubber': ((0.018, 0.018, 0.018), 0.92, 0.0),
    'canvas': ((0.175, 0.150, 0.090), 0.95, 0.0),
    'canvas_dark': ((0.090, 0.088, 0.055), 0.95, 0.0),
    'burlap': ((0.300, 0.240, 0.150), 1.00, 0.0),
    'stone': ((0.170, 0.150, 0.130), 0.92, 0.0),
    'stone_dark': ((0.090, 0.082, 0.075), 0.95, 0.0),
    'timber': ((0.120, 0.075, 0.040), 0.85, 0.0),
    'glass': ((0.010, 0.014, 0.016), 0.08, 0.0),
    'white_missile': ((0.62, 0.62, 0.60), 0.45, 0.05),
    'grey_missile': ((0.30, 0.31, 0.31), 0.50, 0.10),
    'olive_missile': ((0.10, 0.12, 0.07), 0.55, 0.05),
    'band_red': ((0.35, 0.02, 0.015), 0.55, 0.0),
    'band_yellow': ((0.55, 0.38, 0.02), 0.55, 0.0),
    'band_blue': ((0.02, 0.06, 0.20), 0.55, 0.0),
    'nozzle': ((0.025, 0.022, 0.020), 0.70, 0.60),
    'seeker': ((0.05, 0.05, 0.06), 0.15, 0.30),
    'brass': ((0.45, 0.30, 0.09), 0.35, 1.0),
    'aluminium': ((0.55, 0.56, 0.57), 0.38, 1.0),
    'dish': ((0.42, 0.43, 0.42), 0.50, 0.70),
    'black': ((0.012, 0.012, 0.012), 0.80, 0.0),
    'flare_pellet': ((0.70, 0.60, 0.45), 0.90, 0.0),
    'red_light': ((0.5, 0.02, 0.01), 0.4, 0.0),
    'concrete': ((0.28, 0.27, 0.25), 0.90, 0.0),
    'paint_white': ((0.70, 0.70, 0.68), 0.80, 0.0),
    'paint_yellow': ((0.60, 0.42, 0.04), 0.80, 0.0),
    'rust': ((0.16, 0.065, 0.025), 0.90, 0.20),
    'drum_green': ((0.07, 0.10, 0.05), 0.65, 0.30),
    'drum_blue': ((0.03, 0.06, 0.12), 0.60, 0.30),
    'crate': ((0.11, 0.12, 0.055), 0.85, 0.0),
    'net': ((0.10, 0.10, 0.055), 1.0, 0.0),
    'soot': ((0.020, 0.018, 0.016), 0.97, 0.05),
}
DUST = (0.30, 0.255, 0.20)
BURN = False  # set by builders for *_destroyed variants


def _principled(nt):
    return nt.nodes.get('Principled BSDF')


def mat(name, dirt=0.35, var=0.12, scale=3.0):
    """Procedural paint/material from the palette: colour variation noise,
    dust collecting low on the object, slight roughness breakup. Burned
    variants turn every material into soot + rust."""
    key = ('burn_' if BURN else '') + name
    m = bpy.data.materials.get(key)
    if m:
        return m
    col, rough, metal = PALETTE[name]
    if BURN and name not in ('glass',):
        col, rough, metal = PALETTE['soot'][0], 0.96, 0.05 if metal < 0.5 else 0.35
    m = bpy.data.materials.new(key)
    m.use_nodes = True
    nt = m.node_tree
    b = _principled(nt)
    b.inputs['Roughness'].default_value = rough
    b.inputs['Metallic'].default_value = metal
    m['pal_rough'] = rough
    m['pal_metal'] = metal
    tc = nt.nodes.new('ShaderNodeTexCoord')
    noise = nt.nodes.new('ShaderNodeTexNoise')
    noise.inputs['Scale'].default_value = scale
    noise.inputs['Detail'].default_value = 6
    nt.links.new(tc.outputs['Object'], noise.inputs['Vector'])
    # colour variation
    ramp = nt.nodes.new('ShaderNodeMix')
    ramp.data_type = 'RGBA'
    ramp.inputs['A'].default_value = (*[c * (1 - var) for c in col], 1)
    ramp.inputs['B'].default_value = (*[min(1, c * (1 + var)) for c in col], 1)
    nt.links.new(noise.outputs['Fac'], ramp.inputs['Factor'])
    last = ramp.outputs['Result']
    if BURN and name != 'glass':
        rust = nt.nodes.new('ShaderNodeMix')
        rust.data_type = 'RGBA'
        n2 = nt.nodes.new('ShaderNodeTexNoise')
        n2.inputs['Scale'].default_value = 6.0
        nt.links.new(tc.outputs['Object'], n2.inputs['Vector'])
        mr = nt.nodes.new('ShaderNodeMapRange')
        mr.inputs['From Min'].default_value = 0.55
        mr.inputs['From Max'].default_value = 0.70
        nt.links.new(n2.outputs['Fac'], mr.inputs['Value'])
        nt.links.new(mr.outputs['Result'], rust.inputs['Factor'])
        nt.links.new(last, rust.inputs['A'])
        rust.inputs['B'].default_value = (*PALETTE['rust'][0], 1)
        last = rust.outputs['Result']
    if dirt > 0 and name not in ('glass', 'seeker'):
        # dust: more near the bottom of the object (generated Z) + noise
        sep = nt.nodes.new('ShaderNodeSeparateXYZ')
        nt.links.new(tc.outputs['Generated'], sep.inputs['Vector'])
        mr = nt.nodes.new('ShaderNodeMapRange')
        mr.inputs['From Min'].default_value = 0.45
        mr.inputs['From Max'].default_value = 0.0
        nt.links.new(sep.outputs['Z'], mr.inputs['Value'])
        n3 = nt.nodes.new('ShaderNodeTexNoise')
        n3.inputs['Scale'].default_value = 9.0
        nt.links.new(tc.outputs['Object'], n3.inputs['Vector'])
        mul = nt.nodes.new('ShaderNodeMath')
        mul.operation = 'MULTIPLY'
        nt.links.new(mr.outputs['Result'], mul.inputs[0])
        nt.links.new(n3.outputs['Fac'], mul.inputs[1])
        mul2 = nt.nodes.new('ShaderNodeMath')
        mul2.operation = 'MULTIPLY'
        mul2.inputs[1].default_value = dirt * 1.6
        mul2.use_clamp = True
        nt.links.new(mul.outputs[0], mul2.inputs[0])
        dmix = nt.nodes.new('ShaderNodeMix')
        dmix.data_type = 'RGBA'
        nt.links.new(mul2.outputs[0], dmix.inputs['Factor'])
        nt.links.new(last, dmix.inputs['A'])
        dmix.inputs['B'].default_value = (*DUST, 1)
        last = dmix.outputs['Result']
    nt.links.new(last, b.inputs['Base Color'])
    return m


def emissive(name, color, strength=4.0):
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    m.use_nodes = True
    b = _principled(m.node_tree)
    b.inputs['Base Color'].default_value = (*color, 1)
    b.inputs['Emission Color'].default_value = (*color, 1)
    b.inputs['Emission Strength'].default_value = strength
    m['pal_rough'] = 0.5
    m['pal_metal'] = 0.0
    m['emissive'] = True
    return m


# ============================================================== geometry
def M(loc=(0, 0, 0), rot=(0, 0, 0), scale=(1, 1, 1)):
    from mathutils import Euler
    return Matrix.Translation(V(loc)) @ Euler([math.radians(a) for a in rot]).to_matrix().to_4x4() @ Matrix.Diagonal((*scale, 1))


class Part:
    """Accumulates geometry for one node; each primitive carries a material."""

    def __init__(self):
        self.bm = bmesh.new()
        self.mats = []
        self.mods = []  # (verts) groups that want bevel

    def _mi(self, m):
        if m not in self.mats:
            self.mats.append(m)
        return self.mats.index(m)

    def _tag(self, geom_faces, m, smooth=False):
        mi = self._mi(m)
        for f in geom_faces:
            f.material_index = mi
            f.smooth = smooth

    def _new_faces(self, before):
        self.bm.faces.ensure_lookup_table()
        return [f for f in self.bm.faces if f.index >= before or f.index == -1]

    def _run(self, fn, m, smooth, bevel=0.0, seg=1):
        self.bm.faces.index_update()
        before = set(self.bm.faces)
        bv = set(self.bm.verts)
        fn()
        new = [f for f in self.bm.faces if f not in before]
        newv = [v for v in self.bm.verts if v not in bv]
        if bevel > 0:
            edges = list({e for f in new for e in f.edges})
            sharp = [e for e in edges if e.is_manifold and e.calc_face_angle(0) > math.radians(50)]
            if sharp:
                res = bmesh.ops.bevel(self.bm, geom=sharp, offset=bevel, segments=seg, profile=0.5, affect='EDGES', clamp_overlap=True)
                new = [f for f in self.bm.faces if f not in before]
        self._tag(new, m, smooth)
        return newv

    def box(self, size, m, loc=(0, 0, 0), rot=(0, 0, 0), bevel=0.0, seg=1, taper=None):
        """Box of `size` (x, y, z). `taper`=(sx, sy) scales the top face."""
        def f():
            r = bmesh.ops.create_cube(self.bm, size=1.0)
            vs = r['verts']
            for v in vs:
                if taper and v.co.z > 0:
                    v.co.x *= taper[0]
                    v.co.y *= taper[1]
            bmesh.ops.transform(self.bm, matrix=M(loc, rot, size), verts=vs)
        return self._run(f, m, False, bevel, seg)

    def cyl(self, r, depth, m, loc=(0, 0, 0), rot=(0, 0, 0), seg=12, r2=None, smooth=True, bevel=0.0, cap=True):
        """Cylinder/cone along local Z."""
        def f():
            res = bmesh.ops.create_cone(self.bm, cap_ends=cap, cap_tris=False, segments=seg, radius1=r,
                                        radius2=r if r2 is None else r2, depth=depth)
            bmesh.ops.transform(self.bm, matrix=M(loc, rot), verts=res['verts'])
        return self._run(f, m, smooth, bevel)

    def sphere(self, r, m, loc=(0, 0, 0), scale=(1, 1, 1), rot=(0, 0, 0), seg=12, rings=8, smooth=True):
        def f():
            res = bmesh.ops.create_uvsphere(self.bm, u_segments=seg, v_segments=rings, radius=r)
            bmesh.ops.transform(self.bm, matrix=M(loc, rot, scale), verts=res['verts'])
        return self._run(f, m, smooth)

    def torus(self, R, r, m, loc=(0, 0, 0), rot=(0, 0, 0), seg=16, rseg=6):
        def f():
            vs = []
            rings = []
            for i in range(seg):
                a = 2 * math.pi * i / seg
                ring = []
                for j in range(rseg):
                    b = 2 * math.pi * j / rseg
                    p = V(((R + r * math.cos(b)) * math.cos(a), (R + r * math.cos(b)) * math.sin(a), r * math.sin(b)))
                    ring.append(self.bm.verts.new(p))
                rings.append(ring)
            for i in range(seg):
                for j in range(rseg):
                    a, b = rings[i], rings[(i + 1) % seg]
                    self.bm.faces.new((a[j], b[j], b[(j + 1) % rseg], a[(j + 1) % rseg]))
            allv = [v for r_ in rings for v in r_]
            bmesh.ops.transform(self.bm, matrix=M(loc, rot), verts=allv)
        return self._run(f, m, True)

    def lathe(self, profile, m, seg=16, loc=(0, 0, 0), rot=(0, 0, 0), smooth=True, mats=None):
        """Surface of revolution about local +Y. profile = [(radius, y), ...]
        front-to-back or back-to-front; zero radius closes a pole.
        `mats` optionally gives a material per profile segment."""
        def f():
            rings = []
            for (rad, y) in profile:
                if rad <= 1e-6:
                    rings.append([self.bm.verts.new((0, y, 0))])
                else:
                    rings.append([self.bm.verts.new((rad * math.cos(2 * math.pi * i / seg), y, rad * math.sin(2 * math.pi * i / seg)))
                                  for i in range(seg)])
            faces = []
            for k in range(len(rings) - 1):
                a, b = rings[k], rings[k + 1]
                seg_faces = []
                for i in range(seg):
                    j = (i + 1) % seg
                    if len(a) == 1 and len(b) == 1:
                        continue
                    if len(a) == 1:
                        q = (a[0], b[j], b[i])
                    elif len(b) == 1:
                        q = (a[i], a[j], b[0])
                    else:
                        q = (a[i], a[j], b[j], b[i])
                    try:
                        seg_faces.append(self.bm.faces.new(q))
                    except ValueError:
                        pass
                faces.append(seg_faces)
            # close open ends with caps
            for ring in (rings[0], rings[-1]):
                if len(ring) > 1:
                    try:
                        faces.append([self.bm.faces.new(ring)])
                    except ValueError:
                        pass
            allv = [v for r_ in rings for v in r_]
            bmesh.ops.transform(self.bm, matrix=M(loc, rot), verts=allv)
            self._lathe_faces = faces
        self.bm.faces.index_update()
        before = set(self.bm.faces)
        f()
        new = [x for x in self.bm.faces if x not in before]
        # consistent outward normals
        bmesh.ops.recalc_face_normals(self.bm, faces=new)
        self._tag(new, m, smooth)
        if mats:
            for k, sf in enumerate(self._lathe_faces[:len(profile) - 1]):
                if k < len(mats) and mats[k] is not None:
                    mi = self._mi(mats[k])
                    for x in sf:
                        x.material_index = mi
        return new

    def fin(self, root, tip, span, thick, m, loc=(0, 0, 0), rot=(0, 0, 0), sweep=0.0, tip_off=0.0, x0=0.0):
        """Trapezoid fin in its local XY plane: root chord along Y at x=x0,
        extends to +X by `span`; leading edge at +Y; `sweep` moves the tip aft."""
        def f():
            t = thick / 2
            le_r, te_r = root / 2, -root / 2
            le_t, te_t = tip / 2 - sweep + tip_off, -tip / 2 - sweep + tip_off
            pts = [(x0, le_r), (x0 + span, le_t), (x0 + span, te_t), (x0, te_r)]
            th = [1, 0.4, 0.4, 1]
            top = [self.bm.verts.new((x, y, t * k)) for (x, y), k in zip(pts, th)]
            bot = [self.bm.verts.new((x, y, -t * k)) for (x, y), k in zip(pts, th)]
            # mid edge for a sharp-ish leading/trailing edge
            fs = [self.bm.faces.new(top), self.bm.faces.new(bot[::-1])]
            for i in range(4):
                j = (i + 1) % 4
                fs.append(self.bm.faces.new((top[i], bot[i], bot[j], top[j])))
            bmesh.ops.recalc_face_normals(self.bm, faces=fs)
            bmesh.ops.transform(self.bm, matrix=M(loc, rot), verts=top + bot)
        return self._run(f, m, False)

    def poly_prism(self, pts, height, m, loc=(0, 0, 0), rot=(0, 0, 0), bevel=0.0):
        """Extrude a 2D polygon (x, y) along +Z by height."""
        def f():
            bot = [self.bm.verts.new((x, y, 0)) for x, y in pts]
            top = [self.bm.verts.new((x, y, height)) for x, y in pts]
            fs = [self.bm.faces.new(bot[::-1]), self.bm.faces.new(top)]
            n = len(pts)
            for i in range(n):
                j = (i + 1) % n
                fs.append(self.bm.faces.new((bot[i], bot[j], top[j], top[i])))
            bmesh.ops.recalc_face_normals(self.bm, faces=fs)
            bmesh.ops.transform(self.bm, matrix=M(loc, rot), verts=top + bot)
        return self._run(f, m, False, bevel)

    def grid_quad(self, w, h, m, loc=(0, 0, 0), rot=(0, 0, 0), double=True):
        def f():
            vs = [self.bm.verts.new(p) for p in ((-w / 2, -h / 2, 0), (w / 2, -h / 2, 0), (w / 2, h / 2, 0), (-w / 2, h / 2, 0))]
            self.bm.faces.new(vs)
            if double:
                vs2 = [self.bm.verts.new(v.co.copy() + V((0, 0, -0.002))) for v in vs]
                self.bm.faces.new(vs2[::-1])
                vs = vs + vs2
            bmesh.ops.transform(self.bm, matrix=M(loc, rot), verts=vs)
        return self._run(f, m, False)

    def transform(self, matrix, verts=None):
        bmesh.ops.transform(self.bm, matrix=matrix, verts=verts if verts is not None else self.bm.verts)

    def merge(self, other, matrix=None):
        """Append another Part's geometry (materials remapped)."""
        me = bpy.data.meshes.new('tmp')
        other.bm.to_mesh(me)
        remap = [self._mi(m) for m in other.mats]
        start = len(self.bm.faces)
        before = set(self.bm.faces)
        bv = set(self.bm.verts)
        self.bm.from_mesh(me)
        newf = [f for f in self.bm.faces if f not in before]
        for f in newf:
            f.material_index = remap[f.material_index] if f.material_index < len(remap) else 0
        if matrix is not None:
            bmesh.ops.transform(self.bm, matrix=matrix, verts=[v for v in self.bm.verts if v not in bv])
        bpy.data.meshes.remove(me)


# ============================================================== nodes
class Asset:
    def __init__(self, asset_id, kind, notes=''):
        C.reset()
        self.id = asset_id
        self.kind = kind
        self.notes = notes
        self.coll = C.coll(asset_id)
        self.root = C.empty(asset_id, collection=self.coll, size=0.5)
        self.nodes = {asset_id: self.root}
        self.world = {asset_id: V((0, 0, 0))}
        self.sockets = []
        self.pivots = {}

    def mesh(self, name, part, pivot=(0, 0, 0), parent=None, smooth_angle=35, moving=False):
        """Create a mesh node from a Part whose geometry is in asset (world)
        space; the node origin is `pivot` (world). `moving` marks an
        animatable pivot node (listed in the catalog)."""
        parent = parent or self.id
        pv = V(pivot)
        part.transform(Matrix.Translation(-pv))
        me = bpy.data.meshes.new(name)
        part.bm.normal_update()
        part.bm.to_mesh(me)
        part.bm.free()
        for m in part.mats:
            me.materials.append(m)
        try:
            me.set_sharp_from_angle(angle=math.radians(smooth_angle))
        except Exception:
            pass
        o = bpy.data.objects.new(name, me)
        self.coll.objects.link(o)
        o.parent = self.nodes[parent]
        o.location = pv - self.world[parent]
        self.nodes[name] = o
        self.world[name] = pv
        if moving:
            self.pivots[name] = {'parent': parent}
        return o

    def ground_plane(self, z=0.0, size=40):
        """Temporary occluder so the AO bake darkens contact areas."""
        bpy.ops.mesh.primitive_plane_add(size=size, location=(0, 0, z))
        p = bpy.context.object
        p.name = '_ao_ground'
        self._ground = p
        return p

    def socket(self, name, pos, parent=None):
        parent = parent or self.id
        e = C.empty(name, collection=self.coll, size=0.08)
        e.parent = self.nodes[parent]
        e.location = V(pos) - self.world[parent]
        self.nodes[name] = e
        self.world[name] = V(pos)
        self.sockets.append(name)
        return e

    def meshes(self):
        return [o for o in self.nodes.values() if o.type == 'MESH']

    # ---------------------------------------------------------- bake
    def bake(self, size=1024, ao_samples=48, ao_mix=0.55, margin=8):
        objs = self.meshes()
        sc = bpy.context.scene
        sc.render.engine = 'CYCLES'
        sc.cycles.device = 'CPU'
        sc.cycles.samples = ao_samples
        sc.cycles.use_denoising = False
        try:
            sc.render.bake.margin = margin
        except Exception:
            pass
        # one UV atlas for all meshes
        for o in objs:
            o.hide_set(False)
            while o.data.uv_layers:
                o.data.uv_layers.remove(o.data.uv_layers[0])
            o.data.uv_layers.new(name='UVMap')
        C.select_only(objs)
        bpy.ops.object.mode_set(mode='EDIT')
        bpy.ops.mesh.select_all(action='SELECT')
        bpy.ops.uv.smart_project(angle_limit=math.radians(60), island_margin=0.0, area_weight=0.0, scale_to_bounds=False)
        try:
            bpy.ops.uv.pack_islands(rotate=True, margin=2.5 / size * 4)
        except TypeError:
            bpy.ops.uv.pack_islands(margin=0.004)
        bpy.ops.object.mode_set(mode='OBJECT')

        def img(name, non_color):
            im = bpy.data.images.new(f'{self.id}_{name}', size, size, alpha=False, float_buffer=False)
            if non_color:
                im.colorspace_settings.name = 'Non-Color'
            return im

        albedo, ao, rough, metal = img('albedo', False), img('ao', True), img('rough', True), img('metal', True)
        mats = {m for o in objs for m in o.data.materials if m}
        tex_nodes = {}
        for m in mats:
            t = m.node_tree.nodes.new('ShaderNodeTexImage')
            tex_nodes[m] = t
            m.node_tree.nodes.active = t

        def run(kind, image, **kw):
            for m, t in tex_nodes.items():
                t.image = image
                m.node_tree.nodes.active = t
            C.select_only(objs)
            bpy.ops.object.bake(type=kind, use_clear=True, margin=margin, **kw)

        run('DIFFUSE', albedo, pass_filter={'COLOR'})
        sc.cycles.samples = ao_samples
        run('AO', ao)
        run('ROUGHNESS', rough)
        # metallic via emission
        saved = {}
        for m in mats:
            b = _principled(m.node_tree)
            saved[m] = (tuple(b.inputs['Emission Color'].default_value), b.inputs['Emission Strength'].default_value,
                        [l for l in m.node_tree.links if l.to_socket == b.inputs['Emission Color']])
            for l in saved[m][2]:
                m.node_tree.links.remove(l)
            mv = b.inputs['Metallic'].default_value
            b.inputs['Emission Color'].default_value = (mv, mv, mv, 1)
            b.inputs['Emission Strength'].default_value = 1.0
        sc.cycles.samples = 1
        run('EMIT', metal)
        # emissive map (for lights / glowing parts)
        emis_mats = [m for m in mats if m.get('emissive')]
        emis_img = None
        if emis_mats:
            emis_img = img('emissive', False)
            for m in mats:
                b = _principled(m.node_tree)
                if m.get('emissive'):
                    c, s, _ = saved[m]
                    b.inputs['Emission Color'].default_value = c
                else:
                    b.inputs['Emission Color'].default_value = (0, 0, 0, 1)
            run('EMIT', emis_img)

        import numpy as np
        n = size * size
        A = np.array(albedo.pixels[:]).reshape(n, 4)
        O = np.array(ao.pixels[:]).reshape(n, 4)[:, 0]
        R = np.array(rough.pixels[:]).reshape(n, 4)[:, 0]
        Mt = np.array(metal.pixels[:]).reshape(n, 4)[:, 0]
        # bake a share of AO into albedo so contact shadows read under direct sun
        A[:, :3] *= (1 - ao_mix + ao_mix * O)[:, None]
        albedo.pixels[:] = A.ravel()
        orm = img('orm', True)
        ORM = np.ones((n, 4))
        ORM[:, 0], ORM[:, 1], ORM[:, 2] = O, R, Mt
        orm.pixels[:] = ORM.ravel()
        for im in (albedo, orm) + ((emis_img,) if emis_img else ()):
            im.filepath_raw = os.path.join(RAW, f'{im.name}.png')
            im.file_format = 'PNG'
            os.makedirs(RAW, exist_ok=True)
            im.save()
            im.pack()

        g = getattr(self, '_ground', None)
        if g is not None:
            bpy.data.objects.remove(g)
            self._ground = None
        baked = make_baked_material(f'{self.id}_baked', albedo, orm, emis_img)
        glass = [m for m in mats if m.name.endswith('glass')]
        for o in objs:
            o.data.materials.clear()
            o.data.materials.append(baked)
        for m in mats:
            bpy.data.materials.remove(m)
        self.bake_size = size
        return baked

    # ---------------------------------------------------------- export
    def export(self, lod1_ratio=0.35, tex=1024, lod1_tex=512, extra=None, lod1=True):
        os.makedirs(RAW, exist_ok=True)
        info = {'id': self.id, 'kind': self.kind, 'notes': self.notes, 'sockets': self.sockets,
                'pivots': sorted(self.pivots.keys()), 'lods': []}
        if extra:
            info.update(extra)
        raw0 = os.path.join(RAW, f'{self.id}.glb')
        self.root['asset_id'] = self.id
        self.root['sockets'] = ','.join(self.sockets)
        C.export_glb(raw0, [self.root])
        info['lods'].append(optimize(raw0, os.path.join(OUT_MODELS, f'{self.id}.glb'), tex))
        if lod1:
            for o in self.meshes():
                tris = C.tri_count([o])
                if tris < 60:
                    continue
                d = o.modifiers.new('lod', 'DECIMATE')
                d.ratio = max(lod1_ratio, min(1.0, 40 / max(tris, 1)))
                d.use_collapse_triangulate = True
                C.select_only([o])
                bpy.ops.object.modifier_apply(modifier='lod')
            raw1 = os.path.join(RAW, f'{self.id}_lod1.glb')
            C.export_glb(raw1, [self.root])
            info['lods'].append(optimize(raw1, os.path.join(OUT_MODELS, f'{self.id}_lod1.glb'), lod1_tex))
        mn, mx = C.bbox_world(self.meshes())
        # blender -> three: (x, y, z) -> (x, z, -y)
        info['bounds'] = {'min': [round(mn.x, 3), round(mn.z, 3), round(-mx.y, 3)],
                          'max': [round(mx.x, 3), round(mx.z, 3), round(-mn.y, 3)]}
        os.makedirs(os.path.join(C.BUILD, 'manifest'), exist_ok=True)
        with open(os.path.join(C.BUILD, 'manifest', f'{self.id}.json'), 'w') as f:
            json.dump(info, f, indent=1)
        print('ASSET', json.dumps(info))
        return info


def make_baked_material(name, albedo, orm, emis=None):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    m.use_backface_culling = True  # -> glTF doubleSided: false; thin sheets are modelled two-sided
    nt = m.node_tree
    b = _principled(nt)
    ta = nt.nodes.new('ShaderNodeTexImage')
    ta.image = albedo
    nt.links.new(ta.outputs['Color'], b.inputs['Base Color'])
    to = nt.nodes.new('ShaderNodeTexImage')
    to.image = orm
    sep = nt.nodes.new('ShaderNodeSeparateColor')
    nt.links.new(to.outputs['Color'], sep.inputs['Color'])
    nt.links.new(sep.outputs['Green'], b.inputs['Roughness'])
    nt.links.new(sep.outputs['Blue'], b.inputs['Metallic'])
    # glTF occlusion via the exporter's settings group
    grp = bpy.data.node_groups.get('glTF Material Output')
    if grp is None:
        grp = bpy.data.node_groups.new('glTF Material Output', 'ShaderNodeTree')
        try:
            grp.interface.new_socket('Occlusion', in_out='INPUT', socket_type='NodeSocketFloat')
        except Exception:
            grp.inputs.new('NodeSocketFloat', 'Occlusion')
    g = nt.nodes.new('ShaderNodeGroup')
    g.node_tree = grp
    nt.links.new(sep.outputs['Red'], g.inputs['Occlusion'])
    if emis is not None:
        te = nt.nodes.new('ShaderNodeTexImage')
        te.image = emis
        nt.links.new(te.outputs['Color'], b.inputs['Emission Color'])
        b.inputs['Emission Strength'].default_value = 1.0
    return m


def optimize(src, dst, tex):
    import shutil
    node = shutil.which(NODE) or NODE
    r = subprocess.run([node, os.path.join(C.ROOT, 'tools', 'blender', 'optimize-glb.mjs'), src, dst, '--tex', str(tex),
                        '--extras', json.dumps({'license': 'MIT', 'author': 'Safed Sagar contributors',
                                                'source': 'tools/blender (procedural)'})],
                       capture_output=True, text=True, cwd=C.ROOT)
    line = [l for l in r.stdout.splitlines() if l.startswith('OPT ')]
    if not line:
        print(r.stdout, r.stderr)
        raise SystemExit('optimize failed for ' + src)
    _, path, tris, size = line[-1].split(' ')
    return {'url': '/' + os.path.relpath(dst, os.path.join(C.ROOT, 'public')).replace('\\', '/'),
            'triangles': int(tris), 'bytes': int(size)}


def rng(seed):
    return random.Random(seed)
