"""Look check: mean colour of two clips, frame by frame, whole frame and thirds; and a side-by-side sheet.
usage: python look.py <captures dir> <clipA> <clipB> [--sheet out.jpg] [--frame 30]"""
import sys, os, glob
import numpy as np
from PIL import Image
d, a, b = sys.argv[1:4]
k = int(sys.argv[sys.argv.index('--frame') + 1]) if '--frame' in sys.argv else 30
def stats(clip):
    fs = sorted(glob.glob(os.path.join(d, clip, '0*.*')))
    rows = []
    for f in fs[::6]:
        im = np.asarray(Image.open(f).convert('RGB'), dtype=np.float32)
        h = im.shape[0]
        rows.append([im.mean(), im[: h // 3].mean(), im[h // 3: 2 * h // 3].mean(), im[2 * h // 3:].mean(), *im.mean((0, 1))])
    return np.array(rows), fs
ra, fa = stats(a); rb, fb = stats(b)
n = min(len(ra), len(rb))
print('every 6th frame: mean / top / mid / bottom / R G B')
for i in range(n):
    print(f'  {a}: ' + ' '.join(f'{v:6.1f}' for v in ra[i]) + f'   {b}: ' + ' '.join(f'{v:6.1f}' for v in rb[i]) + '   diff: ' + ' '.join(f'{v:+5.1f}' for v in (rb[i] - ra[i])[:4]))
ia = np.asarray(Image.open(fa[k]).convert('RGB'), dtype=np.float32); ib = np.asarray(Image.open(fb[k]).convert('RGB'), dtype=np.float32)
print(f'frame {k}: mean abs diff {np.abs(ia - ib).mean():.2f}, mean diff {(ib - ia).mean():+.2f}')
if '--sheet' in sys.argv:
    out = sys.argv[sys.argv.index('--sheet') + 1]
    A = Image.open(fa[k]).convert('RGB'); B = Image.open(fb[k]).convert('RGB')
    s = Image.new('RGB', (A.width, A.height * 2 // 2))
    half = A.width // 2
    sheet = Image.new('RGB', (A.width * 2 // 2, A.height))
    w2 = A.width // 2
    sheet = Image.new('RGB', (A.width, A.height // 2))
    sheet.paste(A.resize((w2, A.height // 2), Image.LANCZOS), (0, 0)); sheet.paste(B.resize((w2, A.height // 2), Image.LANCZOS), (w2, 0))
    sheet.save(out, quality=90)
