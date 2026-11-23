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
        A.bake(size=size, ao_samples=32)
        info = A.export(tex=size, lod1=False)
    else:
        spec = GROUND[asset_id]
        fn, size = spec[0], spec[1]
        opts = spec[2] if len(spec) > 2 else {}
        kit.BURN = bool(opts.get('burn'))
        A = fn()
        A.bake(size=size, ao_samples=48)
        info = A.export(tex=size, lod1_tex=max(128, size // 2), lod1_ratio=opts.get('lod1_ratio', 0.5),
                        lod1=opts.get('lod1', True))
        kit.BURN = False
    print(f'BUILT {asset_id} in {time.time() - t0:.1f}s', [(l['triangles'], l['bytes']) for l in info['lods']])
