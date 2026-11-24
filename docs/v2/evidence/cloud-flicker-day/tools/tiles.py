"""Large-scale flicker: frames averaged into 32x32 px tiles, then the temporal `pop` of each tile.
usage: python tiles.py <captures dir> <clip...>"""
import sys, os, glob
import numpy as np
from PIL import Image
import cv2
for clip in sys.argv[2:]:
    fs = sorted(glob.glob(os.path.join(sys.argv[1], clip, '0*.*')))
    L = []
    for f in fs:
        a = np.asarray(Image.open(f).convert('RGB'), dtype=np.float32) @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
        L.append(cv2.resize(a, (a.shape[1] // 32, a.shape[0] // 32), interpolation=cv2.INTER_AREA))
    L = np.stack(L)
    d1 = L[1:-1] - L[:-2]; d3 = L[2:] - L[1:-1]
    pop = np.where(d1 * d3 < 0, np.minimum(np.abs(d1), np.abs(d3)), 0)
    g = L.mean((1, 2)); gd1 = g[1:-1] - g[:-2]; gd3 = g[2:] - g[1:-1]
    gpop = np.where(gd1 * gd3 < 0, np.minimum(np.abs(gd1), np.abs(gd3)), 0)
    m = pop.mean(0)
    H = m.shape[0]
    print(f"{clip}: tile pop mean={pop.mean():.3f} p99={np.percentile(pop,99):.2f} max={pop.max():.2f} | top third {pop[:, :H//3].mean():.3f} mid {pop[:, H//3:2*H//3].mean():.3f} bottom {pop[:, 2*H//3:].mean():.3f} | global mean-luma pop mean={gpop.mean():.3f} max={gpop.max():.3f}")
    ys, xs = np.unravel_index(np.argsort(m.ravel())[-4:], m.shape)
    print('   worst tiles (x,y px, mean pop):', [(int(x) * 32 + 16, int(y) * 32 + 16, round(float(m[y, x]), 2)) for x, y in zip(xs, ys)])
