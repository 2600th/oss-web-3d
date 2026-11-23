"""Procedural modelling + bake + export kit for Safed Sagar props.

Blender frame while modelling: FRONT = +Y, UP = +Z, RIGHT = +X, metres.
The glTF exporter turns that into three.js FRONT = -Z, UP = +Y.

An asset is a hierarchy of *nodes* (empties or meshes) under a root empty
named after the asset id. Moving parts (turret, barrels, dish, launcher...)
are mesh objects whose origin is their pivot; sockets are empties.

[models polish 2] Every asset now bakes three textures instead of two:
  base colour   procedural paint / cloth / stone with sun fade, dust, mud,
                cavity grime and edge wear (bare metal on painted steel)
  normal        rounded edges (Cycles Bevel node, so a 12-triangle box reads
                as a pressed panel) plus a per-material height field
  ORM           occlusion, roughness, metalness (wear lowers roughness and
                raises metalness where paint is gone)
LOD1 drops the faces a builder tagged as LOD0-only detail (`part.detail = 1`),
then decimates what is left to a triangle target; it keeps the LOD0 UVs, so it
samples the same (smaller) textures and cannot differ in colour.
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
    'olive': ((0.125, 0.135, 0.072), 0.66, 0.0),
    'khaki': ((0.200, 0.175, 0.105), 0.74, 0.0),
    'sand': ((0.330, 0.270, 0.170), 0.78, 0.0),
    'grey_paint': ((0.150, 0.160, 0.165), 0.60, 0.0),
    'steel': ((0.050, 0.052, 0.055), 0.52, 0.25),     # blacked chassis steel
    'gunmetal': ((0.050, 0.052, 0.058), 0.40, 0.70),  # phosphated gun steel
    'rubber': ((0.020, 0.020, 0.021), 0.90, 0.0),
    'canvas': ((0.175, 0.150, 0.090), 0.95, 0.0),
    'canvas_dark': ((0.090, 0.088, 0.055), 0.95, 0.0),
    'burlap': ((0.300, 0.240, 0.150), 1.00, 0.0),
    'stone': ((0.170, 0.150, 0.130), 0.92, 0.0),
    'stone_dark': ((0.090, 0.082, 0.075), 0.95, 0.0),
    'timber': ((0.120, 0.075, 0.040), 0.85, 0.0),
    'glass': ((0.012, 0.018, 0.022), 0.07, 0.0),
    'white_missile': ((0.62, 0.62, 0.60), 0.45, 0.0),
    'grey_missile': ((0.30, 0.31, 0.31), 0.50, 0.0),
    'olive_missile': ((0.10, 0.12, 0.07), 0.55, 0.0),
    'band_red': ((0.35, 0.02, 0.015), 0.55, 0.0),
    'band_yellow': ((0.55, 0.38, 0.02), 0.55, 0.0),
    'band_blue': ((0.02, 0.06, 0.20), 0.55, 0.0),
    'nozzle': ((0.060, 0.052, 0.046), 0.62, 0.75),
    'seeker': ((0.05, 0.05, 0.06), 0.12, 0.0),
    'brass': ((0.45, 0.30, 0.09), 0.35, 1.0),
    'aluminium': ((0.55, 0.56, 0.57), 0.38, 1.0),
    'dish': ((0.30, 0.31, 0.30), 0.55, 0.0),
    'black': ((0.012, 0.012, 0.012), 0.80, 0.0),
    'flare_pellet': ((0.70, 0.60, 0.45), 0.90, 0.0),
    'red_light': ((0.5, 0.02, 0.01), 0.4, 0.0),
    'amber_light': ((0.55, 0.22, 0.02), 0.4, 0.0),
    'concrete': ((0.28, 0.27, 0.25), 0.90, 0.0),
    'paint_white': ((0.70, 0.70, 0.68), 0.80, 0.0),
    'paint_yellow': ((0.60, 0.42, 0.04), 0.80, 0.0),
    'rust': ((0.16, 0.065, 0.025), 0.90, 0.20),
    'drum_green': ((0.07, 0.10, 0.05), 0.60, 0.0),
    'drum_blue': ((0.03, 0.06, 0.12), 0.58, 0.0),
    'crate': ((0.11, 0.12, 0.055), 0.85, 0.0),
    'net': ((0.10, 0.10, 0.055), 1.0, 0.0),
    'soot': ((0.020, 0.018, 0.016), 0.97, 0.05),
    'lens': ((0.55, 0.55, 0.50), 0.10, 0.0),
    'lens_red': ((0.30, 0.02, 0.015), 0.15, 0.0),
    'lens_amber': ((0.45, 0.17, 0.02), 0.15, 0.0),
}
DUST = (0.30, 0.255, 0.20)
MUD = (0.115, 0.092, 0.068)
BARE = (0.23, 0.22, 0.21)          # worn-through steel
BARE_BURNT = (0.20, 0.085, 0.035)  # scale rust where burnt paint flaked
BURN = False   # set by builders for *_destroyed variants
DETAIL = 1.0   # scale of the baked edge radius / height depth (weapons and the pilot are small)

# Surface classes. Every palette entry belongs to one; the class decides the
# baked normal detail, how edges wear and how the sun fades it.
#   bevel   edge radius baked into the normal map (m)
#   freq    noise frequency of the height field (1/m), dist = its depth (m)
#   wear    0..1: exposed edges and chips wear through to bare metal
#   soft    0..1: exposed edges lighten (frayed cloth, chipped stone, dry wood)
#   bleach  0..1: surfaces facing the sky fade
KINDS = {
    'paint': dict(bevel=0.012, freq=55.0, dist=0.0012, wear=1.0, soft=0.0, bleach=0.07),
    'metal': dict(bevel=0.008, freq=70.0, dist=0.0008, wear=0.35, soft=0.0, bleach=0.0),
    'rubber': dict(bevel=0.010, freq=40.0, dist=0.0015, wear=0.0, soft=0.30, bleach=0.05),
    'fabric': dict(bevel=0.025, freq=26.0, dist=0.006, wear=0.0, soft=0.40, bleach=0.20),
    'burlap': dict(bevel=0.030, freq=38.0, dist=0.007, wear=0.0, soft=0.35, bleach=0.14),
    'stone': dict(bevel=0.030, freq=7.0, dist=0.030, wear=0.0, soft=0.40, bleach=0.08),
    'wood': dict(bevel=0.012, freq=30.0, dist=0.004, wear=0.0, soft=0.45, bleach=0.12),
    'paintwood': dict(bevel=0.010, freq=30.0, dist=0.003, wear=0.0, soft=0.55, bleach=0.12),
    'glass': dict(bevel=0.004, freq=0.0, dist=0.0, wear=0.0, soft=0.0, bleach=0.0),
    'plain': dict(bevel=0.008, freq=50.0, dist=0.0010, wear=0.0, soft=0.15, bleach=0.0),
}
SURF = {
    'olive': 'paint', 'khaki': 'paint', 'sand': 'paint', 'grey_paint': 'paint', 'steel': 'metal', 'gunmetal': 'metal',
    'rubber': 'rubber', 'canvas': 'fabric', 'canvas_dark': 'fabric', 'burlap': 'burlap', 'stone': 'stone',
    'stone_dark': 'stone', 'timber': 'wood', 'glass': 'glass', 'white_missile': 'paint', 'grey_missile': 'paint',
    'olive_missile': 'paint', 'band_red': 'paint', 'band_yellow': 'paint', 'band_blue': 'paint', 'nozzle': 'metal',
    'seeker': 'glass', 'brass': 'metal', 'aluminium': 'metal', 'dish': 'paint', 'black': 'plain', 'concrete': 'stone',
    'rust': 'metal', 'drum_green': 'paint', 'drum_blue': 'paint', 'crate': 'paintwood', 'net': 'fabric',
    'lens': 'glass', 'lens_red': 'glass', 'lens_amber': 'glass',
}


def _principled(nt):
    return nt.nodes.get('Principled BSDF')


class NT:
    """Terse shader-node construction: every helper returns an output socket.
    `pos` / `nrm` are the world-space position and shading normal, so a
    material bakes the same on every part of an asset."""

    def __init__(self, nt):
        self.nt = nt
        geo = nt.nodes.new('ShaderNodeNewGeometry')
        self.pos, self.nrm = geo.outputs['Position'], geo.outputs['Normal']

    def _in(self, sock, v):
        if v is None:
            return
        if isinstance(v, bpy.types.NodeSocket):
            self.nt.links.new(v, sock)
        else:
            sock.default_value = v

    def math(self, op, a, b=None, clamp=False):
        n = self.nt.nodes.new('ShaderNodeMath')
        n.operation, n.use_clamp = op, clamp
        self._in(n.inputs[0], a)
        self._in(n.inputs[1], b)
        return n.outputs[0]

    def add(self, a, b):
        return self.math('ADD', a, b)

    def mul(self, a, b, clamp=False):
        return self.math('MULTIPLY', a, b, clamp)

    def inv(self, a):
        return self.math('SUBTRACT', 1.0, a)

    def vmath(self, op, a, b=None):
        n = self.nt.nodes.new('ShaderNodeVectorMath')
        n.operation = op
        self._in(n.inputs[0], a)
        self._in(n.inputs[1], b)
        return n.outputs['Value' if op in ('DOT_PRODUCT', 'LENGTH') else 'Vector']

    def scale(self, vec, xyz):
        n = self.nt.nodes.new('ShaderNodeVectorMath')
        n.operation = 'MULTIPLY'
        self._in(n.inputs[0], vec)
        n.inputs[1].default_value = xyz
        return n.outputs['Vector']

    def noise(self, scale, detail=4.0, rough=0.5, vec=None, distortion=0.0):
        n = self.nt.nodes.new('ShaderNodeTexNoise')
        n.inputs['Scale'].default_value = scale
        n.inputs['Detail'].default_value = detail
        n.inputs['Roughness'].default_value = rough
        n.inputs['Distortion'].default_value = distortion
        self.nt.links.new(vec if vec is not None else self.pos, n.inputs['Vector'])
        return n.outputs['Fac']

    def voronoi(self, scale, feature='F1', vec=None, out='Distance'):
        n = self.nt.nodes.new('ShaderNodeTexVoronoi')
        n.feature = feature
        n.inputs['Scale'].default_value = scale
        self.nt.links.new(vec if vec is not None else self.pos, n.inputs['Vector'])
        return n.outputs[out]

    def ramp(self, v, a, b, lo=0.0, hi=1.0, smooth=True):
        """Map v from [a, b] to [lo, hi], clamped (a > b inverts)."""
        n = self.nt.nodes.new('ShaderNodeMapRange')
        n.interpolation_type = 'SMOOTHSTEP' if smooth else 'LINEAR'
        n.clamp = True
        self._in(n.inputs['Value'], v)
        if a > b:  # smoothstep needs an ascending range
            a, b, lo, hi = b, a, hi, lo
        n.inputs['From Min'].default_value, n.inputs['From Max'].default_value = a, b
        n.inputs['To Min'].default_value, n.inputs['To Max'].default_value = lo, hi
        return n.outputs['Result']

    def mix(self, fac, a, b):
        n = self.nt.nodes.new('ShaderNodeMix')
        n.data_type = 'RGBA'
        self._in(n.inputs['Factor'], fac)
        for k, v in (('A', a), ('B', b)):
            if isinstance(v, (tuple, list)):
                n.inputs[k].default_value = (*v[:3], 1)
            else:
                self.nt.links.new(v, n.inputs[k])
        return n.outputs['Result']

    def xyz(self, vec):
        n = self.nt.nodes.new('ShaderNodeSeparateXYZ')
        self.nt.links.new(vec, n.inputs[0])
        return n.outputs

    def vec(self, x, y, z):
        n = self.nt.nodes.new('ShaderNodeCombineXYZ')
        for i, v in enumerate((x, y, z)):
            self._in(n.inputs[i], v)
        return n.outputs[0]

    def uv(self, name):
        n = self.nt.nodes.new('ShaderNodeUVMap')
        n.uv_map = name
        return n.outputs['UV']

    def rgb(self, r, g, b):
        n = self.nt.nodes.new('ShaderNodeCombineColor')
        for i, v in enumerate((r, g, b)):
            self._in(n.inputs[i], v)
        return n.outputs[0]

    def bevel(self, radius, samples=6):
        n = self.nt.nodes.new('ShaderNodeBevel')
        n.samples = samples
        n.inputs['Radius'].default_value = radius
        return n.outputs['Normal']

    def bump(self, height, dist, normal=None, strength=1.0):
        n = self.nt.nodes.new('ShaderNodeBump')
        n.inputs['Strength'].default_value = strength
        n.inputs['Distance'].default_value = dist
        self._in(n.inputs['Height'], height)
        if normal is not None:
            self.nt.links.new(normal, n.inputs['Normal'])
        return n.outputs['Normal']


def new_material(key):
    m = bpy.data.materials.new(key)
    m.use_nodes = True
    return m, NT(m.node_tree)


def finish(m, N, colour, rough, metal, kind, height=None, dist=None, wear=None, soft=None, bevel=None):
    """Common tail of every bakeable material: rounded edges + height into the
    normal, and the wear masks Asset.bake() reads through an emission pass
    (R = wear through to bare metal, G = soft edge lightening). The sockets
    feeding colour / roughness / metal / mask are kept as BAKE_* reroutes so
    the bake can read each one exactly (a DIFFUSE bake would multiply the
    colour by 1 - metallic)."""
    K = KINDS[kind]
    nt = m.node_tree
    b = _principled(nt)
    radius = (K['bevel'] if bevel is None else bevel) * DETAIL
    bev = N.bevel(radius)
    normal = bev
    d = (K['dist'] if dist is None else dist) * DETAIL
    if height is not None and d > 0:
        normal = N.bump(height, d, normal=bev)
    nt.links.new(normal, b.inputs['Normal'])
    # edge = how far the rounded normal leans away from the face normal
    wide = N.bevel(max(radius * 2.2, 0.006 * DETAIL), samples=8)
    edge = N.ramp(N.vmath('DOT_PRODUCT', wide, N.nrm), 0.985, 0.80, 0.0, 1.0)
    f = 1.0 / max(DETAIL, 0.2)
    breakup = N.ramp(N.noise(22.0 * f, 5.0, 0.65), 0.38, 0.62)
    chips = N.ramp(N.noise(46.0 * f, 3.0, 0.6), 0.71, 0.76)
    w = K['wear'] if wear is None else wear
    sf = K['soft'] if soft is None else soft
    worn = N.mul(N.math('MAXIMUM', N.mul(edge, breakup), N.mul(chips, 0.55)), w, clamp=True)
    softm = N.mul(edge, sf, clamp=True)

    def keep(name, v):
        r = nt.nodes.new('NodeReroute')
        r.name = name
        if isinstance(v, bpy.types.NodeSocket):
            nt.links.new(v, r.inputs[0])
        else:
            c = nt.nodes.new('ShaderNodeRGB')
            c.outputs[0].default_value = (*v[:3], 1) if isinstance(v, (tuple, list)) else (v, v, v, 1)
            nt.links.new(c.outputs[0], r.inputs[0])
        return r.outputs[0]

    nt.links.new(keep('BAKE_COLOR', colour), b.inputs['Base Color'])
    nt.links.new(keep('BAKE_ROUGH', rough), b.inputs['Roughness'])
    nt.links.new(keep('BAKE_METAL', metal), b.inputs['Metallic'])
    keep('BAKE_MASK', N.rgb(worn, softm, 0.0))
    m['kind'] = kind
    return m


def mat(name, dirt=0.35, var=0.12, scale=3.0, mud=0.0, kind=None):
    """Procedural material from the palette: colour variation, sun fade on
    top faces, dust low on the object, optional mud thrown up the lower body,
    a height field for the normal map and edge wear. Burned variants turn
    every material into soot, scale rust and the odd patch of surviving paint."""
    key = ('burn_' if BURN else '') + name + (f'_m{mud}' if mud else '') + (f'_d{dirt}' if dirt != 0.35 else '') + \
        (f'_{kind}' if kind else '')
    m = bpy.data.materials.get(key)
    if m:
        return m
    col, rough, metal = PALETTE[name]
    kind = kind or SURF.get(name, 'plain')
    K = KINDS[kind]
    m, N = new_material(key)
    z = N.xyz(N.pos)['Z']
    up = N.ramp(N.xyz(N.nrm)['Z'], 0.2, 0.95)
    burnt = BURN and kind != 'glass'
    f = 1.0 / max(DETAIL, 0.2)
    # colour variation: a large slow one (fade, batches of paint) and a fine one
    big = N.noise(scale * 0.35 * f, 3.0, 0.5)
    fine = N.noise(scale * 4.0 * f, 5.0, 0.6)
    v = N.add(N.mul(big, 0.6), N.mul(fine, 0.4))
    last = N.mix(v, [c * (1 - var) for c in col], [min(1, c * (1 + var)) for c in col])
    rgh = N.add(rough - 0.05, N.mul(fine, 0.10))
    wear = None
    if burnt:
        soot = PALETTE['soot'][0]
        # most paint gone: soot, with scale rust where it burnt hottest and a
        # few scorched patches of the old colour
        heat = N.noise(1.6, 4.0, 0.55)
        last = N.mix(N.ramp(heat, 0.30, 0.62), [c * 0.32 for c in col], soot)
        if kind in ('paint', 'metal'):
            rust = N.mix(N.noise(30.0, 3.0, 0.7), PALETTE['rust'][0], (0.30, 0.16, 0.07))
            last = N.mix(N.ramp(N.noise(3.4, 5.0, 0.6), 0.50, 0.66), last, rust)
        ash = N.ramp(N.noise(9.0, 4.0, 0.6), 0.62, 0.78)
        last = N.mix(N.mul(ash, N.mul(up, 0.55)), last, (0.20, 0.19, 0.18))
        rgh, metal = 0.95, (0.05 if metal < 0.5 else 0.30)
        wear = 0.8 if kind in ('paint', 'metal') else 0.0
    else:
        if K['bleach'] > 0:
            lum = sum(col) / 3
            k = 1 + 2.2 * K['bleach']
            faded = [min(1.0, (c * 0.70 + lum * 0.30) * k) for c in col]
            last = N.mix(N.mul(up, N.ramp(big, 0.25, 0.75, 0.35, 1.0)), last, faded)
        if dirt > 0 and kind != 'glass':
            # dust settles low and on anything facing up
            low = N.ramp(z, 1.3, 0.0)
            d = N.mul(N.add(N.mul(low, 0.85), N.mul(up, 0.26)), N.ramp(N.noise(9.0, 5.0, 0.6), 0.25, 0.8), clamp=True)
            d = N.mul(d, dirt * 1.5, clamp=True)
            last = N.mix(d, last, DUST)
            rgh = N.math('ADD', rgh, N.mul(d, 0.25), clamp=True)
        elif dirt > 0 and name == 'glass':
            # a film of road dust, thicker toward the bottom of the pane
            d = N.mul(N.add(N.mul(N.ramp(N.noise(5.0, 4.0, 0.6), 0.3, 0.8), 0.5), N.mul(N.ramp(z, 2.6, 1.9), 0.35)), dirt, clamp=True)
            last = N.mix(d, last, [c * 0.6 for c in DUST])
            rgh = N.math('ADD', rgh, N.mul(d, 0.7), clamp=True)
        if mud > 0:
            # mud thrown up from the wheels: dense below the axles, spatter above
            reach = N.ramp(z, 1.30, 0.25)
            sp = N.noise(13.0, 6.0, 0.72, distortion=0.4)
            mmask = N.mul(N.ramp(N.add(N.mul(reach, 0.9), N.mul(sp, 0.75)), 0.92, 1.12), mud, clamp=True)
            last = N.mix(mmask, last, N.mix(N.noise(6.0, 3.0), MUD, DUST))
            rgh = N.math('ADD', rgh, N.mul(mmask, 0.3), clamp=True)
    # height field for the normal map
    h = None
    if kind in ('paint', 'metal', 'plain', 'rubber'):
        h = N.noise(K['freq'] * f, 4.0, 0.6)
        if burnt:
            h = N.add(h, N.mul(N.voronoi(40.0), 1.5))  # blistered paint
    elif kind in ('fabric', 'burlap'):
        rumple = N.noise(K['freq'], 5.0, 0.62, distortion=0.6)
        slow = N.noise(3.2, 3.0, 0.5, distortion=1.2)
        h = N.add(N.mul(rumple, 0.45), N.mul(slow, 1.6))
    elif kind == 'stone':
        crack = N.ramp(N.voronoi(11.0, 'DISTANCE_TO_EDGE'), 0.0, 0.06)
        h = N.add(N.noise(K['freq'], 8.0, 0.68), N.mul(crack, 0.35))
        if not burnt:
            last = N.mix(N.mul(N.inv(crack), 0.5), last, [c * 0.55 for c in col])
    elif kind in ('wood', 'paintwood'):
        # grain: noise stretched along the axis the piece most likely runs
        g1 = N.noise(K['freq'], 4.0, 0.6, vec=N.scale(N.pos, (0.12, 2.2, 2.2)))
        g2 = N.noise(K['freq'], 4.0, 0.6, vec=N.scale(N.pos, (2.2, 0.12, 2.2)))
        ax = N.ramp(N.math('ABSOLUTE', N.xyz(N.nrm)['X']), 0.45, 0.55)
        h = N.add(N.mul(g1, N.inv(ax)), N.mul(g2, ax))
        if not burnt:
            last = N.mix(N.ramp(h, 0.35, 0.7, 0.0, 0.35), last, [c * 0.6 for c in col])
    finish(m, N, last, rgh, metal, kind, height=h, wear=wear,
           dist=(K['dist'] * 2.5 if burnt and kind in ('paint', 'metal') else None))
    return m


def tyre(hub='olive', mud=0.5):
    """Wheel material driven by the lathe's aux UVs (Part.lathe aux=...):
    tread blocks and sidewall ribs on the rubber, a stud ring, hand holes and
    a hub on the disc. The tread is baked, not modelled: at the distances a
    ground unit is seen from, it is the normal map and the dust in the
    grooves that read, and the triangles go to the rest of the vehicle."""
    key = ('burn_' if BURN else '') + f'tyre_{hub}_{mud}'
    m = bpy.data.materials.get(key)
    if m:
        return m
    m, N = new_material(key)
    a1 = N.xyz(N.uv('aux'))
    a2 = N.xyz(N.uv('aux2'))
    ang, lat, rf = a1['X'], N.math('SUBTRACT', N.mul(a1['Y'], 2.0), 1.0), a2['X']
    alat = N.math('ABSOLUTE', lat)
    is_tyre = N.ramp(rf, 0.585, 0.60, smooth=False)
    tread = N.ramp(rf, 0.955, 0.975)

    def tooth(v, n, a, b, off=0.0):
        """1 inside each of n teeth per turn of v (half-width a..b of the period)."""
        ph = N.math('FRACT', N.add(N.mul(v, n), off) if off else N.mul(v, n))
        return N.ramp(N.math('ABSOLUTE', N.math('SUBTRACT', ph, 0.5)), a, b, smooth=False)

    # chevron lugs: 26 per turn, the two halves staggered, a centre groove
    side = N.ramp(lat, -0.02, 0.02, 0.0, 0.5, smooth=False)
    ph = N.math('FRACT', N.add(N.add(N.mul(ang, 26.0), N.mul(alat, 0.9)), side))
    lug = N.mul(N.ramp(N.math('ABSOLUTE', N.math('SUBTRACT', ph, 0.5)), 0.30, 0.22, smooth=False), N.ramp(alat, 0.07, 0.12, smooth=False))
    # sidewall: fine radial ribs in a band, a bead near the rim, a rub strip
    rib = N.mul(tooth(ang, 96.0, 0.30, 0.20), N.mul(N.ramp(rf, 0.80, 0.82), N.ramp(rf, 0.90, 0.88)))
    bead = N.mul(N.ramp(rf, 0.62, 0.64), N.ramp(rf, 0.69, 0.67))
    strip = N.mul(N.ramp(rf, 0.74, 0.75), N.ramp(rf, 0.775, 0.765))
    h_rub = N.add(N.mul(tread, N.mul(lug, 3.0)), N.mul(N.inv(tread), N.add(N.mul(rib, 0.5), N.add(bead, N.mul(strip, 0.7)))))
    # disc: 8 studs on a ring, 6 hand holes
    stud = N.mul(tooth(ang, 8.0, 0.16, 0.10), N.mul(N.ramp(rf, 0.27, 0.29), N.ramp(rf, 0.35, 0.33)))
    hole = N.mul(tooth(ang, 6.0, 0.24, 0.18, off=0.25), N.mul(N.ramp(rf, 0.40, 0.42), N.ramp(rf, 0.52, 0.50)))
    h_disc = N.math('SUBTRACT', N.mul(stud, 1.2), N.mul(hole, 2.0))
    height = N.add(N.mul(is_tyre, h_rub), N.mul(N.inv(is_tyre), h_disc))
    rub_c, rub_r, _ = PALETTE['rubber']
    hub_c, hub_r, hub_m = PALETTE[hub]
    if BURN:
        # the rubber is a sagging char; rims are scaled rust
        rubber = N.mix(N.noise(9.0, 4.0), (0.012, 0.011, 0.010), (0.075, 0.07, 0.065))
        disc = N.mix(N.noise(14.0, 4.0, 0.7), PALETTE['rust'][0], (0.07, 0.05, 0.04))
    else:
        grey = N.mix(N.noise(18.0, 4.0, 0.6), rub_c, [c * 2.6 for c in rub_c])
        # dust packs the grooves; the sidewall carries a thinner film
        groove = N.mul(tread, N.inv(lug))
        dusty = N.math('ADD', N.mul(groove, 0.85), N.mul(N.inv(tread), N.add(0.22, N.mul(N.noise(7.0, 4.0, 0.6), 0.5))), clamp=True)
        rubber = N.mix(N.mul(dusty, mud * 1.5, clamp=True), grey, N.mix(N.noise(5.0, 3.0), MUD, DUST))
        disc = N.mix(N.mul(hole, 0.92), N.mix(N.noise(8.0, 4.0), [c * 0.85 for c in hub_c], [min(1, c * 1.15) for c in hub_c]), (0.008, 0.008, 0.008))
        disc = N.mix(N.mul(N.ramp(N.noise(6.0, 5.0, 0.65), 0.35, 0.8), mud * 0.9, clamp=True), disc, DUST)
        disc = N.mix(N.mul(stud, 0.8), disc, (0.09, 0.09, 0.09))
    colour = N.mix(is_tyre, disc, rubber)
    rough = N.add(N.mul(is_tyre, 0.95 if BURN else rub_r), N.mul(N.inv(is_tyre), 0.9 if BURN else hub_r + 0.08))
    metal = N.mul(N.inv(is_tyre), 0.25 if BURN else hub_m)
    finish(m, N, colour, rough, metal, 'rubber', height=height, dist=0.016, wear=0.0, soft=0.12, bevel=0.006)
    return m


def track():
    """Steel track run: link ribs across the run every 11 cm (world Y, so the
    top and bottom runs carry them and the wraps fade out), packed dirt
    between the grousers, polished wear on the high spots."""
    key = ('burn_' if BURN else '') + 'track'
    m = bpy.data.materials.get(key)
    if m:
        return m
    m, N = new_material(key)
    y = N.xyz(N.pos)['Y']
    ph = N.math('FRACT', N.mul(y, 1.0 / 0.11))
    link = N.ramp(N.math('ABSOLUTE', N.math('SUBTRACT', ph, 0.5)), 0.36, 0.26, smooth=False)
    flat = N.ramp(N.math('ABSOLUTE', N.xyz(N.nrm)['Z']), 0.6, 0.9)     # only the runs, not the edges
    h = N.mul(link, flat)
    steel = N.mix(N.noise(20.0, 4.0, 0.6), (0.035, 0.032, 0.03), (0.075, 0.06, 0.05))
    if BURN:
        col = N.mix(N.noise(6.0, 4.0, 0.6), PALETTE['rust'][0], (0.03, 0.028, 0.026))
    else:
        col = N.mix(N.mul(N.inv(h), 0.8), steel, N.mix(N.noise(5.0, 3.0), MUD, DUST))
        col = N.mix(N.mul(h, 0.35), col, (0.30, 0.29, 0.28))
    rough = N.add(0.55, N.mul(N.inv(h), 0.4))
    finish(m, N, col, rough, N.add(0.25, N.mul(h, 0.5)), 'metal', height=h, dist=0.018, wear=0.3, bevel=0.01)
    return m


def corrugated(name='grey_paint', pitch=0.076, axis='X'):
    """Corrugated iron sheet: sine waves along `axis` baked into the normal,
    rust creeping up from the edges and the fixings."""
    key = ('burn_' if BURN else '') + f'cgi_{name}_{axis}'
    m = bpy.data.materials.get(key)
    if m:
        return m
    m, N = new_material(key)
    col, rough, _ = PALETTE[name]
    w = N.math('SINE', N.mul(N.xyz(N.pos)[axis], 2 * math.pi / pitch))
    zinc = N.mix(N.noise(9.0, 4.0, 0.6), [c * 0.8 for c in col], [min(1, c * 1.3) for c in col])
    rust = N.mix(N.noise(34.0, 3.0, 0.7), PALETTE['rust'][0], (0.26, 0.13, 0.06))
    rmask = N.ramp(N.add(N.noise(3.0, 5.0, 0.65), N.mul(w, -0.05)), 0.50, 0.68)
    c = N.mix(rmask, zinc, rust)
    if not BURN:
        c = N.mix(N.mul(N.ramp(N.noise(7.0, 4.0), 0.3, 0.8), 0.4), c, DUST)
    else:
        c = N.mix(N.ramp(N.noise(2.0, 4.0), 0.3, 0.6), rust, PALETTE['soot'][0])
    finish(m, N, c, N.add(rough, N.mul(rmask, 0.3)), N.mul(N.inv(rmask), 0.6), 'metal', height=w, dist=0.012, wear=0.2)
    return m


def camo_net():
    """Garnished camouflage net: three-tone scrim patches, knotted texture,
    dark gaps where the garnish is thin."""
    key = ('burn_' if BURN else '') + 'camo_net'
    m = bpy.data.materials.get(key)
    if m:
        return m
    m, N = new_material(key)
    blot = N.noise(1.5, 3.0, 0.5, distortion=1.5)
    blot2 = N.noise(2.3, 3.0, 0.5, distortion=1.0)
    c = N.mix(N.ramp(blot, 0.45, 0.50), (0.085, 0.105, 0.045), (0.19, 0.15, 0.085))
    c = N.mix(N.ramp(blot2, 0.56, 0.60), c, (0.040, 0.046, 0.028))
    cell = N.voronoi(9.0)
    gap = N.ramp(cell, 0.30, 0.44)
    c = N.mix(N.mul(gap, 0.55), c, (0.012, 0.013, 0.010))
    c = N.mix(N.mul(N.ramp(N.xyz(N.nrm)['Z'], 0.3, 0.9), N.mul(N.ramp(N.noise(6.0, 4.0), 0.3, 0.8), 0.15)), c, DUST)
    h = N.add(N.mul(N.inv(gap), 1.0), N.mul(N.noise(40.0, 3.0, 0.6), 0.4))
    finish(m, N, c, 1.0, 0.0, 'fabric', height=h, dist=0.02, soft=0.2)
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
    """Accumulates geometry for one node; each primitive carries a material.
    `detail = 1` tags what is built next as LOD0-only (dropped from LOD1)."""

    def __init__(self):
        self.bm = bmesh.new()
        self.bm.loops.layers.uv.new('aux')
        self.bm.loops.layers.uv.new('aux2')
        self.bm.faces.layers.int.new('lodskip')
        self.mats = []
        self.detail = 0

    def _mi(self, m):
        if m not in self.mats:
            self.mats.append(m)
        return self.mats.index(m)

    def _tag(self, geom_faces, m, smooth=False):
        mi = self._mi(m)
        skip = self.bm.faces.layers.int['lodskip']
        for f in geom_faces:
            f.material_index = mi
            f.smooth = smooth
            f[skip] = self.detail

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
                bmesh.ops.bevel(self.bm, geom=sharp, offset=bevel, segments=seg, profile=0.5, affect='EDGES', clamp_overlap=True)
                new = [f for f in self.bm.faces if f not in before]
                newv = [v for v in self.bm.verts if v not in bv]
        self._tag(new, m, smooth)
        return newv

    def box(self, size, m, loc=(0, 0, 0), rot=(0, 0, 0), bevel=0.0, seg=1, taper=None, skip=()):
        """Box of `size` (x, y, z). `taper`=(sx, sy) scales the top face.
        `skip` drops faces by outward axis ('+x', '-z', ...): hidden sides."""
        def f():
            r = bmesh.ops.create_cube(self.bm, size=1.0)
            vs = r['verts']
            if skip:
                axes = {'+x': V((1, 0, 0)), '-x': V((-1, 0, 0)), '+y': V((0, 1, 0)), '-y': V((0, -1, 0)), '+z': V((0, 0, 1)), '-z': V((0, 0, -1))}
                fs = {fc for v in vs for fc in v.link_faces}
                kill = [fc for fc in fs if any(fc.normal.dot(axes[a]) > 0.9 for a in skip)]
                bmesh.ops.delete(self.bm, geom=kill, context='FACES_ONLY')
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

    def torus(self, R, r, m, loc=(0, 0, 0), rot=(0, 0, 0), seg=16, rseg=6, arc=360.0):
        def f():
            rings = []
            closed = arc >= 360.0
            n = seg if closed else seg + 1
            for i in range(n):
                a = math.radians(arc) * i / seg
                ring = []
                for j in range(rseg):
                    b = 2 * math.pi * j / rseg
                    p = V(((R + r * math.cos(b)) * math.cos(a), (R + r * math.cos(b)) * math.sin(a), r * math.sin(b)))
                    ring.append(self.bm.verts.new(p))
                rings.append(ring)
            for i in range(seg):
                a, b = rings[i], rings[(i + 1) % n]
                for j in range(rseg):
                    self.bm.faces.new((a[j], b[j], b[(j + 1) % rseg], a[(j + 1) % rseg]))
            allv = [v for r_ in rings for v in r_]
            bmesh.ops.transform(self.bm, matrix=M(loc, rot), verts=allv)
        return self._run(f, m, True)

    def lathe(self, profile, m, seg=16, loc=(0, 0, 0), rot=(0, 0, 0), smooth=True, mats=None, aux=None):
        """Surface of revolution about local +Y. profile = [(radius, y), ...]
        front-to-back or back-to-front; zero radius closes a pole.
        `mats` optionally gives a material per profile segment.
        `aux` = (R, half_width) writes wheel coordinates for kit.tyre():
        aux = (angle / turn, lateral 0..1), aux2 = (radius / R, 0)."""
        def f():
            rings = []
            for (rad, y) in profile:
                if rad <= 1e-6:
                    rings.append([self.bm.verts.new((0, y, 0))])
                else:
                    rings.append([self.bm.verts.new((rad * math.cos(2 * math.pi * i / seg), y, rad * math.sin(2 * math.pi * i / seg)))
                                  for i in range(seg)])
            faces = []
            if aux:
                la, lb = self.bm.loops.layers.uv['aux'], self.bm.loops.layers.uv['aux2']
            for k in range(len(rings) - 1):
                a, b = rings[k], rings[k + 1]
                seg_faces = []
                for i in range(seg):
                    j = (i + 1) % seg
                    if len(a) == 1 and len(b) == 1:
                        continue
                    if len(a) == 1:
                        q = (a[0], b[j], b[i])
                        info = ((k, i + 0.5), (k + 1, i + 1), (k + 1, i))
                    elif len(b) == 1:
                        q = (a[i], a[j], b[0])
                        info = ((k, i), (k, i + 1), (k + 1, i + 0.5))
                    else:
                        q = (a[i], a[j], b[j], b[i])
                        info = ((k, i), (k, i + 1), (k + 1, i + 1), (k + 1, i))
                    try:
                        fc = self.bm.faces.new(q)
                    except ValueError:
                        continue
                    seg_faces.append(fc)
                    if aux:
                        for lp, (pk, pi) in zip(fc.loops, info):
                            rad, y = profile[pk]
                            lp[la].uv = (pi / seg, 0.5 + 0.5 * y / aux[1])
                            lp[lb].uv = (rad / aux[0], 0.0)
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
            fs = [self.bm.faces.new(top), self.bm.faces.new(bot[::-1])]
            for i in range(4):
                j = (i + 1) % 4
                fs.append(self.bm.faces.new((top[i], bot[i], bot[j], top[j])))
            bmesh.ops.recalc_face_normals(self.bm, faces=fs)
            bmesh.ops.transform(self.bm, matrix=M(loc, rot), verts=top + bot)
        return self._run(f, m, False)

    def poly_prism(self, pts, height, m, loc=(0, 0, 0), rot=(0, 0, 0), bevel=0.0, smooth=False):
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
        return self._run(f, m, smooth, bevel)

    def loft(self, sections, m, smooth=True, caps=True, closed=True):
        """Skin between sections, each a list of the same number of 3D points
        (a closed loop when `closed`, else an open strip -> a sheet)."""
        def f():
            rings = [[self.bm.verts.new(p) for p in sec] for sec in sections]
            n = len(rings[0])
            fs = []
            for a, b in zip(rings, rings[1:]):
                for i in range(n if closed else n - 1):
                    j = (i + 1) % n
                    fs.append(self.bm.faces.new((a[i], a[j], b[j], b[i])))
            if caps and closed:
                fs.append(self.bm.faces.new(rings[0][::-1]))
                fs.append(self.bm.faces.new(rings[-1]))
            bmesh.ops.recalc_face_normals(self.bm, faces=fs)
        return self._run(f, m, smooth)

    def _face_away(self, faces, away):
        """Flip faces so they look away from `away` (x, y, z; None = the face's
        own coordinate on that axis, i.e. away from an axis line)."""
        for fc in faces:
            c = fc.calc_center_median()
            o = V([c[i] if away[i] is None else away[i] for i in range(3)])
            fc.normal_update()
            if fc.normal.dot(c - o) < 0:
                fc.normal_flip()

    def sheet(self, grid, m, thick=0.0, smooth=True, away=None, rim=False):
        """Quad sheet through grid[j][i] 3D points. thick > 0: a second,
        reversed skin `thick` behind it, so cloth and thin plate read from
        both sides with back-face culling on; `rim` closes the edge between
        the two skins, so the sheet has a real thickness seen edge-on (hems,
        net edges, wing lips). A single skin faces away from the point / axis
        `away`."""
        def f():
            vs = [[self.bm.verts.new(p) for p in row] for row in grid]
            fs = []
            for j in range(len(vs) - 1):
                for i in range(len(vs[0]) - 1):
                    fs.append(self.bm.faces.new((vs[j][i], vs[j][i + 1], vs[j + 1][i + 1], vs[j + 1][i])))
            if away is not None:
                self._face_away(fs, away)
            if thick:
                self.bm.normal_update()
                dup = bmesh.ops.duplicate(self.bm, geom=fs)
                back = [g for g in dup['geom'] if isinstance(g, bmesh.types.BMFace)]
                bmesh.ops.reverse_faces(self.bm, faces=back)
                # the back skin sits `thick` behind the front one (offsets from
                # the front vertices' normals: the copies' own normals are not
                # reliable after the flip, and used to put it in front, so the
                # two skins faced each other)
                vmap = dup['vert_map']
                for v in {v for fc in fs for v in fc.verts}:
                    vmap[v].co = v.co - v.normal * thick
                if rim:
                    front = set(fs)
                    for e in {e for fc in fs for e in fc.edges}:
                        owners = [fc for fc in e.link_faces if fc in front]
                        if len(owners) != 1:
                            continue
                        a, b = e.verts
                        # wind against the owning face so the rim faces outward
                        lv = [l.vert for l in owners[0].loops]
                        if lv[(lv.index(a) + 1) % len(lv)] is not b:
                            a, b = b, a
                        try:
                            self.bm.faces.new((b, a, vmap[a], vmap[b]))
                        except (ValueError, KeyError):
                            pass
        return self._run(f, m, smooth)

    def fan(self, ring, centre, m, away, smooth=True, close=True):
        """Triangle fan from `centre` to a ring of points (an end wall)."""
        def f():
            c = self.bm.verts.new(centre)
            vs = [self.bm.verts.new(p) for p in ring]
            fs = []
            n = len(vs)
            for i in range(n if close else n - 1):
                fs.append(self.bm.faces.new((vs[i], vs[(i + 1) % n], c)))
            self._face_away(fs, away)
        return self._run(f, m, smooth)

    def tube(self, pts, r, m, seg=6, caps=True, smooth=True):
        """Round bar through a polyline of 3D points (mitred at the corners)."""
        P = [V(p) for p in pts]

        def f():
            rings = []
            prev_a = None
            for i, c in enumerate(P):
                t = (P[min(i + 1, len(P) - 1)] - P[max(i - 1, 0)]).normalized()
                a = (prev_a - t * prev_a.dot(t)) if prev_a is not None else t.orthogonal()
                if a.length < 1e-5:
                    a = t.orthogonal()
                a.normalize()
                prev_a = a
                b = t.cross(a)
                rings.append([self.bm.verts.new(c + (a * math.cos(2 * math.pi * j / seg) + b * math.sin(2 * math.pi * j / seg)) * r)
                              for j in range(seg)])
            fs = []
            for r0, r1 in zip(rings, rings[1:]):
                for j in range(seg):
                    k = (j + 1) % seg
                    fs.append(self.bm.faces.new((r0[j], r0[k], r1[k], r1[j])))
            if caps:
                fs.append(self.bm.faces.new(rings[0][::-1]))
                fs.append(self.bm.faces.new(rings[-1]))
            bmesh.ops.recalc_face_normals(self.bm, faces=fs)
        return self._run(f, m, smooth)

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

    def mark(self):
        """Remember the current vertices; `since(mark)` returns the ones added after."""
        return set(self.bm.verts)

    def since(self, mark):
        return [v for v in self.bm.verts if v not in mark]

    def merge(self, other, matrix=None):
        """Append another Part's geometry (materials remapped)."""
        me = bpy.data.meshes.new('tmp')
        other.bm.to_mesh(me)
        remap = [self._mi(m) for m in other.mats]
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
def use_gpu():
    """Cycles on the GPU when one is usable (the bakes are ray traced)."""
    if os.environ.get('BAKE_CPU'):
        return False
    try:
        prefs = bpy.context.preferences.addons['cycles'].preferences
        for kind in ('OPTIX', 'CUDA', 'HIP', 'METAL', 'ONEAPI'):
            try:
                prefs.compute_device_type = kind
            except TypeError:
                continue
            prefs.get_devices()
            devs = [d for d in prefs.devices if d.type == kind]
            if devs:
                for d in prefs.devices:
                    d.use = d.type == kind
                return True
    except Exception as e:  # pragma: no cover
        print('gpu unavailable:', e)
    return False


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
        self._footprint = None

    def footprint(self, part):
        """Fix the catalogue bounds to what `part` holds right now (asset
        space). The game seats a unit on the terrain by its bounds, so loose
        rubble, guy lines and thrown debris added afterwards must not widen
        them."""
        mn, mx = V((1e9,) * 3), V((-1e9,) * 3)
        for v in part.bm.verts:
            mn = V(map(min, mn, v.co))
            mx = V(map(max, mx, v.co))
        if self._footprint:
            mn = V(map(min, mn, self._footprint[0]))
            mx = V(map(max, mx, self._footprint[1]))
        self._footprint = (mn, mx)

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
    def bake(self, size=1024, ao_samples=48, ao_mix=0.55, margin=4, cavity=0.18, wear=1.0, cull=True):
        objs = self.meshes()
        sc = bpy.context.scene
        sc.render.engine = 'CYCLES'
        sc.cycles.device = 'GPU' if use_gpu() else 'CPU'
        sc.cycles.samples = ao_samples
        sc.cycles.use_denoising = False
        try:
            sc.render.bake.margin = margin
        except Exception:
            pass
        # one UV atlas for all meshes (the aux layers stay for the materials).
        # Triangulate first: the tangent space the normal map is baked in must
        # be the one that is exported, and the exporter needs triangles for it.
        for o in objs:
            o.hide_set(False)
            bm = bmesh.new()
            bm.from_mesh(o.data)
            bmesh.ops.triangulate(bm, faces=bm.faces[:])
            bm.to_mesh(o.data)
            bm.free()
            for l in [l for l in o.data.uv_layers if l.name not in ('aux', 'aux2')]:
                o.data.uv_layers.remove(l)
            uvl = o.data.uv_layers.new(name='UVMap')
            o.data.uv_layers.active = uvl
            uvl.active_render = True
        def unwrap():
            C.select_only(objs)
            bpy.ops.object.mode_set(mode='EDIT')
            bpy.ops.mesh.select_all(action='SELECT')
            bpy.ops.uv.smart_project(angle_limit=math.radians(60), island_margin=0.0, area_weight=0.0, scale_to_bounds=False)
            # a builder's asset is hundreds of small islands: the gutter, not the
            # islands, decides the texel density, so keep it to a few texels
            try:
                bpy.ops.uv.pack_islands(rotate=True, margin_method='FRACTION', margin=3.0 / size, shape_method='CONCAVE')
            except TypeError:
                bpy.ops.uv.pack_islands(rotate=True, margin=3.0 / size)
            bpy.ops.object.mode_set(mode='OBJECT')
        unwrap()

        def img(name, non_color):
            im = bpy.data.images.new(f'{self.id}_{name}', size, size, alpha=False, float_buffer=False)
            if non_color:
                im.colorspace_settings.name = 'Non-Color'
            return im

        albedo, ao, rough, metal = img('albedo', False), img('ao', True), img('rough', True), img('metal', True)
        normal, mask = img('normal', True), img('mask', True)
        mats = {m for o in objs for m in o.data.materials if m}
        tex_nodes = {}
        for m in mats:
            t = m.node_tree.nodes.new('ShaderNodeTexImage')
            tex_nodes[m] = t
            m.node_tree.nodes.active = t

        def run(kind, image, samples=1, **kw):
            sc.cycles.samples = samples
            for m, t in tex_nodes.items():
                t.image = image
                m.node_tree.nodes.active = t
            C.select_only(objs)
            bpy.ops.object.bake(type=kind, use_clear=True, margin=margin, **kw)

        # Pre-pass: faces nothing can see (box bottoms on a deck, ends buried in
        # another part, anything flat on the ground) are black in a quick AO
        # bake. Drop them and unwrap again: they were a third of some atlases.
        if cull:
            import numpy as np
            ps = 512
            pre = bpy.data.images.new(f'{self.id}_pre', ps, ps, alpha=False)
            pre.colorspace_settings.name = 'Non-Color'
            run('AO', pre, samples=24)
            px = np.array(pre.pixels[:]).reshape(ps, ps, 4)[:, :, 0]
            W = ((1 / 3, 1 / 3, 1 / 3), (0.6, 0.2, 0.2), (0.2, 0.6, 0.2), (0.2, 0.2, 0.6), (0.45, 0.45, 0.1), (0.45, 0.1, 0.45),
                 (0.1, 0.45, 0.45), (0.8, 0.1, 0.1), (0.1, 0.8, 0.1), (0.1, 0.1, 0.8))
            dropped = 0
            for o in objs:
                bm = bmesh.new()
                bm.from_mesh(o.data)
                uvl = bm.loops.layers.uv['UVMap']
                kill = []
                for fc in bm.faces:
                    uv = [lp[uvl].uv for lp in fc.loops]
                    if len(uv) != 3:
                        continue
                    best = 0.0
                    for w in W:
                        u = uv[0].x * w[0] + uv[1].x * w[1] + uv[2].x * w[2]
                        v = uv[0].y * w[0] + uv[1].y * w[1] + uv[2].y * w[2]
                        best = max(best, px[min(ps - 1, max(0, int(v * ps))), min(ps - 1, max(0, int(u * ps)))])
                    if best < 0.012:
                        kill.append(fc)
                if kill and len(kill) < len(bm.faces):
                    dropped += len(kill)
                    bmesh.ops.delete(bm, geom=kill, context='FACES')
                    bm.to_mesh(o.data)
                bm.free()
            bpy.data.images.remove(pre)
            print(f'CULL {self.id}: {dropped} hidden triangles dropped')
            if dropped:
                unwrap()

        # Every scalar / colour channel goes through emission, read from the
        # BAKE_* reroutes kit.finish() leaves in each material (materials built
        # elsewhere fall back to the Principled inputs).
        saved = {}
        for m in mats:
            b = _principled(m.node_tree)
            saved[m] = (tuple(b.inputs['Emission Color'].default_value), b.inputs['Emission Strength'].default_value,
                        [(l.from_socket, l.to_socket) for l in m.node_tree.links if l.to_socket == b.inputs['Emission Color']])

        def emit(channel, fallback):
            for m in mats:
                nt = m.node_tree
                b = _principled(nt)
                e = b.inputs['Emission Color']
                for l in list(e.links):
                    nt.links.remove(l)
                b.inputs['Emission Strength'].default_value = 1.0
                r = nt.nodes.get(channel)
                if m.get('emissive') and channel != 'EMISSIVE':
                    r = None
                if r is not None and r.inputs[0].links:
                    nt.links.new(r.inputs[0].links[0].from_socket, e)
                    continue
                v = fallback(m, b)
                e.default_value = (*v[:3], 1) if isinstance(v, (tuple, list)) else (v, v, v, 1)

        def principled_in(name):
            def get(m, b):
                s = b.inputs[name]
                if s.links:
                    return 0.5
                v = s.default_value
                return tuple(v)[:3] if hasattr(v, '__len__') else float(v)
            return get

        emit('BAKE_COLOR', principled_in('Base Color'))
        run('EMIT', albedo, samples=4)
        emit('BAKE_ROUGH', principled_in('Roughness'))
        run('EMIT', rough, samples=2)
        emit('BAKE_METAL', principled_in('Metallic'))
        run('EMIT', metal, samples=2)
        emit('BAKE_MASK', lambda m, b: 0.0)
        run('EMIT', mask, samples=12)
        emis_mats = [m for m in mats if m.get('emissive')]
        emis_img = None
        if emis_mats:
            emis_img = img('emissive', False)
            emit('EMISSIVE', lambda m, b: saved[m][0][:3] if m.get('emissive') else 0.0)
            run('EMIT', emis_img, samples=2)
        for m in mats:  # emission off again: it must not light the AO / normal bakes
            b = _principled(m.node_tree)
            for l in list(b.inputs['Emission Color'].links):
                m.node_tree.links.remove(l)
            b.inputs['Emission Color'].default_value = (0, 0, 0, 1)
            b.inputs['Emission Strength'].default_value = 0.0
        run('AO', ao, samples=ao_samples)
        run('NORMAL', normal, samples=16, normal_space='TANGENT')

        import numpy as np
        n = size * size
        A = np.array(albedo.pixels[:]).reshape(n, 4)
        O = np.array(ao.pixels[:]).reshape(n, 4)[:, 0]
        R = np.array(rough.pixels[:]).reshape(n, 4)[:, 0]
        Mt = np.array(metal.pixels[:]).reshape(n, 4)[:, 0]
        K = np.array(mask.pixels[:]).reshape(n, 4)
        # the albedo image is stored sRGB-encoded; mix in linear light
        L = np.where(A[:, :3] <= 0.04045, A[:, :3] / 12.92, ((A[:, :3] + 0.055) / 1.055) ** 2.4)
        open_ = np.clip((O - 0.55) / 0.35, 0, 1)   # exposed, convex places
        tight = np.clip((0.80 - O) / 0.5, 0, 1)    # creases and undersides
        # cavity grime: dust-coloured film where air does not move
        if cavity > 0 and not BURN:
            g = (tight * cavity)[:, None]
            L = L * (1 - g) + np.array(DUST)[None, :] * 0.55 * g
            R = np.clip(R + tight * cavity * 0.2, 0, 1)
        # soft edge wear: frayed / chipped / dry edges go lighter
        s = (K[:, 1] * open_)[:, None]
        L = np.clip(L * (1 + 0.6 * s) + 0.012 * s, 0, 1)
        # hard wear: paint gone on exposed edges and chips -> bare (or scaled) steel
        w = np.clip(K[:, 0] * open_ * wear, 0, 1)
        bare = np.array(BARE_BURNT if BURN else BARE)
        L = L * (1 - w[:, None] * 0.9) + bare[None, :] * w[:, None] * 0.9
        R = R * (1 - w) + (0.75 if BURN else 0.40) * w
        Mt = np.clip(Mt * (1 - w) + (0.35 if BURN else 0.9) * w, 0, 1)
        # bake a share of AO into albedo so contact shadows read under direct sun
        L *= ((1 - ao_mix + ao_mix * O) ** 1.6)[:, None]
        L = np.clip(L, 0, 1)
        A[:, :3] = np.where(L <= 0.0031308, L * 12.92, 1.055 * L ** (1 / 2.4) - 0.055)
        albedo.pixels[:] = A.ravel()
        orm = img('orm', True)
        ORM = np.ones((n, 4))
        ORM[:, 0], ORM[:, 1], ORM[:, 2] = O, R, Mt
        orm.pixels[:] = ORM.ravel()
        for im in (albedo, orm, normal) + ((emis_img,) if emis_img else ()):
            im.filepath_raw = os.path.join(RAW, f'{im.name}.png')
            im.file_format = 'PNG'
            os.makedirs(RAW, exist_ok=True)
            im.save()
            im.pack()

        g = getattr(self, '_ground', None)
        if g is not None:
            bpy.data.objects.remove(g)
            self._ground = None
        baked = make_baked_material(f'{self.id}_baked', albedo, orm, emis_img, normal)
        for o in objs:
            o.data.materials.clear()
            o.data.materials.append(baked)
            for name in ('aux', 'aux2'):
                l = o.data.uv_layers.get(name)
                if l:
                    o.data.uv_layers.remove(l)
        for m in mats:
            bpy.data.materials.remove(m)
        self.bake_size = size
        return baked

    # ---------------------------------------------------------- export
    def export(self, lod1_ratio=0.35, tex=1024, lod1_tex=512, extra=None, lod1=True, lod1_tris=None, ntex=None, lod1_ntex=None, otex=None):
        os.makedirs(RAW, exist_ok=True)
        info = {'id': self.id, 'kind': self.kind, 'notes': self.notes, 'sockets': self.sockets,
                'pivots': sorted(self.pivots.keys()), 'lods': []}
        if extra:
            info.update(extra)
        raw0 = os.path.join(RAW, f'{self.id}.glb')
        self.root['asset_id'] = self.id
        self.root['sockets'] = ','.join(self.sockets)
        C.export_glb(raw0, [self.root], tangents=True)
        info['lods'].append(optimize(raw0, os.path.join(OUT_MODELS, f'{self.id}.glb'), tex, ntex or tex, otex or tex))
        if lod1:
            # 1. drop what the builder tagged as LOD0-only detail
            for o in self.meshes():
                bm = bmesh.new()
                bm.from_mesh(o.data)
                layer = bm.faces.layers.int.get('lodskip')
                if layer is not None:
                    kill = [f for f in bm.faces if f[layer]]
                    if kill and len(kill) < len(bm.faces):
                        bmesh.ops.delete(bm, geom=kill, context='FACES')
                        bm.to_mesh(o.data)
                bm.free()
            # 2. decimate the rest to the target
            rest = max(1, C.tri_count(self.meshes()))
            # always clearly lighter than LOD0, even when LOD0 is already under the target
            ratio = lod1_ratio if lod1_tris is None else max(0.12, min(0.6, lod1_tris / rest))
            for o in self.meshes():
                tris = C.tri_count([o])
                if tris < 60 or ratio >= 0.999:
                    continue
                d = o.modifiers.new('lod', 'DECIMATE')
                d.ratio = max(ratio, min(1.0, 40 / max(tris, 1)))
                d.use_collapse_triangulate = True
                C.select_only([o])
                bpy.ops.object.modifier_apply(modifier='lod')
            raw1 = os.path.join(RAW, f'{self.id}_lod1.glb')
            C.export_glb(raw1, [self.root], tangents=True)
            info['lods'].append(optimize(raw1, os.path.join(OUT_MODELS, f'{self.id}_lod1.glb'), lod1_tex, lod1_ntex or lod1_tex))
        mn, mx = self._footprint or C.bbox_world(self.meshes())
        # blender -> three: (x, y, z) -> (x, z, -y)
        info['bounds'] = {'min': [round(mn.x, 3), round(mn.z, 3), round(-mx.y, 3)],
                          'max': [round(mx.x, 3), round(mx.z, 3), round(-mn.y, 3)]}
        os.makedirs(os.path.join(C.BUILD, 'manifest'), exist_ok=True)
        with open(os.path.join(C.BUILD, 'manifest', f'{self.id}.json'), 'w') as f:
            json.dump(info, f, indent=1)
        print('ASSET', json.dumps(info))
        return info


def make_baked_material(name, albedo, orm, emis=None, normal=None):
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
    if normal is not None:
        tn = nt.nodes.new('ShaderNodeTexImage')
        tn.image = normal
        nm = nt.nodes.new('ShaderNodeNormalMap')
        nt.links.new(tn.outputs['Color'], nm.inputs['Color'])
        nt.links.new(nm.outputs['Normal'], b.inputs['Normal'])
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


def optimize(src, dst, tex, ntex=None, otex=None):
    import shutil
    node = shutil.which(NODE) or NODE
    r = subprocess.run([node, os.path.join(C.ROOT, 'tools', 'blender', 'optimize-glb.mjs'), src, dst, '--tex', str(tex),
                        '--ntex', str(ntex or tex), '--otex', str(otex or tex),
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
