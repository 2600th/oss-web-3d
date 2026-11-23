"""Build procedural props (weapons, ground units) into public/models/.

blender -b --factory-startup --python tools/blender/build_assets.py -- [id ...]
  (no ids = everything). Writes <id>.glb (+ <id>_lod1.glb for ground units)
  and assets/authoring/build/manifest/<id>.json (tris, bytes, sockets, pivots,
  bounds), which tools/blender/write-manifest.mjs collects.
"""
import os
import sys
import time
sys.path.insert(0, os.path.dirname(__file__))
import common as C  # noqa: E402
import kit  # noqa: E402
import assets_weapons as W  # noqa: E402
try:
    import assets_ground as G  # noqa: E402
    GROUND = G.BUILDERS
except ImportError as e:  # pragma: no cover
    print('ground builders unavailable:', e)
    GROUND = {}

ids = C.argv()
todo = list(W.BUILDERS) + list(GROUND)
if ids:
    todo = [i for i in todo if i in ids]
    missing = set(ids) - set(todo)
    if missing:
        raise SystemExit(f'unknown ids: {sorted(missing)}')

for asset_id in todo:
    t0 = time.time()
    if asset_id in W.BUILDERS:
        fn, size = W.BUILDERS[asset_id]
        kit.BURN = False
        A = fn()
        kit.DETAIL = 0.3   # weapons are small: finer edge radius and grain
        A.bake(size=size, ao_samples=32, cavity=0.1, wear=0.6)
        kit.DETAIL = 1.0
        info = A.export(tex=size, lod1=False)
    else:
        spec = GROUND[asset_id]
        fn, size = spec[0], spec[1]
        opts = spec[2] if len(spec) > 2 else {}
        kit.BURN = bool(opts.get('burn'))
        A = fn()
        A.bake(size=size, ao_samples=48)
        # budgets: about 12k triangles LOD0, 3k LOD1, 700 KB per GLB
        info = A.export(tex=size, lod1_tex=max(128, size // 2), lod1_tris=opts.get('lod1_tris', 3000),
                        lod1=opts.get('lod1', True), ntex=opts.get('ntex', size), otex=opts.get('otex', size),
                        lod1_ntex=max(128, opts.get('ntex', size) // 2))
        kit.BURN = False
    print(f'BUILT {asset_id} in {time.time() - t0:.1f}s', [(l['triangles'], l['bytes']) for l in info['lods']])
