"""Temporal flicker metrics over a captured clip.

usage: python flicker.py <captures dir> <clip> [--map out.png] [--json out.json]

Frames: <dir>/<clip>/00000.png|jpg ; masks: <dir>/<clip>_mask/00000.png (half res:
R = cloud opacity, G = 0 jet / 128 terrain / 255 sky, B = cloud front km * 2).

Metrics, on Rec.709 luma of the 8-bit output, per pixel and frame triple:
  d2   = |f(t-1) - 2 f(t) + f(t+1)| / 2       temporal second difference (high-pass)
  pop  = min(|f(t)-f(t-1)|, |f(t+1)-f(t)|) where the two steps have opposite sign,
         else 0: a value that goes up and comes back (or down and back) within
         three frames. A moving edge or a steady drift is monotone and scores 0.
Motion compensation (default; --raw turns it off): frames t-1 and t+1 are first
warped onto frame t with dense optical flow (OpenCV DIS), so what is compared is
the same piece of cloud in three frames, not the same screen pixel. Without it a
cloud sliding past at 20 px a frame scores as flicker everywhere it has texture.
Regions (a pixel counts only if it is in the region in all three frames):
  sky    sky or cloud behind it, no terrain or aircraft
  cloud  sky with resolved cloud opacity > 0.03
  edge   cloud with 0.03 < opacity < 0.9 (rims)
  far    cloud whose front is > 30 km away (the horizon band)
  jet    sky within 48 px of the aircraft silhouette (3 px guard band excluded)
  horizon  within 8 px of the line where terrain meets sky or cloud
  frame  everything except the aircraft (terrain included: sun shafts cross it)
"""
import sys, os, json, glob
import numpy as np
from PIL import Image, ImageFilter
import cv2


MC = '--raw' not in sys.argv


def load(dirp, clip):
    fs = sorted(glob.glob(os.path.join(dirp, clip, '0*.png')) + glob.glob(os.path.join(dirp, clip, '0*.jpg')))
    ms = sorted(glob.glob(os.path.join(dirp, clip + '_mask', '0*.png')))
    frames = []
    for f in fs:
        a = np.asarray(Image.open(f).convert('RGB'), dtype=np.float32)
        frames.append(a @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32))
    if '--range' in sys.argv:
        i = sys.argv.index('--range'); a, b = int(sys.argv[i + 1]), int(sys.argv[i + 2]); frames = frames[a:b]; ms = ms[a:b]
    H, W = frames[0].shape
    masks = []
    for m in ms:
        im = Image.open(m).convert('RGB').resize((W, H), Image.NEAREST)
        masks.append(np.asarray(im))
    return np.stack(frames), (np.stack(masks) if masks else None)


def dilate(b, r):
    return cv2.dilate(b.astype(np.uint8), np.ones((2 * r + 1, 2 * r + 1), np.uint8)) > 0


def erode(b, r):
    return ~dilate(~b, r)


def analyse(dirp, clip, map_out=None, flip=None):
    F, M = load(dirp, clip)
    n, H, W = F.shape
    if M is None:
        raise SystemExit('no masks')
    if flip is None:  # sky should be at the top: flip the masks if it is not
        g = M[0][:, :, 1]
        flip = (g[: H // 4] == 255).mean() < (g[-H // 4:] == 255).mean()
    if flip:
        M = M[:, ::-1]
    nm = min(n, len(M))
    sky1, cloud1, edge1, far1, jet1, hor1, all1 = [], [], [], [], [], [], []
    for k in range(nm):
        op = M[k][:, :, 0].astype(np.float32) / 255
        g = M[k][:, :, 1]
        fr = M[k][:, :, 2].astype(np.float32) / 2
        sky = erode(g == 255, 4)
        jet = g == 0
        sky1.append(sky)
        cloud1.append(sky & (op > 0.03))
        edge1.append(sky & (op > 0.03) & (op < 0.9))
        far1.append(sky & (op > 0.03) & (fr > 30))
        jet1.append(dilate(jet, 48) & ~dilate(jet, 3) & (g == 255) & jet.any())
        hor1.append(dilate(g == 128, 8) & dilate(g == 255, 8) & ~dilate(jet, 24))
        all1.append(~dilate(jet, 12))
    d2s, pops, regs = [], [], {k: [] for k in ('sky', 'cloud', 'edge', 'far', 'jet', 'horizon', 'frame')}
    dis = cv2.DISOpticalFlow_create(cv2.DISOPTICAL_FLOW_PRESET_MEDIUM) if MC else None
    gx, gy = np.meshgrid(np.arange(W, dtype=np.float32), np.arange(H, dtype=np.float32))
    U8 = np.clip(F, 0, 255).astype(np.uint8) if MC else None
    def warp(src, t, k):  # frame k resampled onto frame t's pixels
        fl = dis.calc(U8[t], U8[k], None)
        return cv2.remap(src[k], gx + fl[..., 0], gy + fl[..., 1], cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE), np.hypot(fl[..., 0], fl[..., 1])
    speeds = []
    for t in range(1, nm - 1):
        a, b, c = F[t - 1], F[t], F[t + 1]
        if MC:
            a, sp = warp(F, t, t - 1)
            c, _ = warp(F, t, t + 1)
            speeds.append(float(np.median(sp[sky1[t]])) if sky1[t].any() else 0.0)
        d1, d3 = b - a, c - b
        d2 = np.abs(a - 2 * b + c) / 2
        pop = np.where(d1 * d3 < 0, np.minimum(np.abs(d1), np.abs(d3)), 0)
        d2s.append(d2); pops.append(pop)
        for name, src in (('sky', sky1), ('cloud', cloud1), ('edge', edge1), ('far', far1), ('jet', jet1), ('horizon', hor1), ('frame', all1)):
            regs[name].append(src[t - 1] & src[t] & src[t + 1])
    d2s = np.stack(d2s); pops = np.stack(pops)
    out = {'clip': clip, 'frames': int(n), 'size': [int(W), int(H)], 'motion_compensated': MC, 'sky_speed_px': round(float(np.median(speeds)), 2) if speeds else None}
    for name, r in regs.items():
        r = np.stack(r)
        cnt = int(r.sum())
        if cnt < 500:
            out[name] = None
            continue
        p = pops[r]; d = d2s[r]
        out[name] = {
            'px_per_frame': int(cnt / len(r)),
            'd2_mean': round(float(d.mean()), 4),
            'pop_mean': round(float(p.mean()), 4),
            'pop_gt2_pct': round(float((p > 2).mean() * 100), 4),
            'pop_gt4_pct': round(float((p > 4).mean() * 100), 4),
            'pop_gt8_pct': round(float((p > 8).mean() * 100), 4),
            'pop_p999': round(float(np.percentile(p, 99.9)), 3),
            'pop_max': round(float(p.max()), 2),
        }
    if map_out:
        skyall = np.stack(regs['frame'])
        m = (pops * skyall).mean(0)
        # frame under a red flicker map (x40)
        base = np.asarray(Image.open(sorted(glob.glob(os.path.join(dirp, clip, '0*.*')))[n // 2]).convert('RGB'), dtype=np.float32) * 0.45
        base[:, :, 0] = np.clip(base[:, :, 0] + m * 40 * 4, 0, 255)
        base[:, :, 1] = np.clip(base[:, :, 1] + m * 10 * 4, 0, 255)
        Image.fromarray(base.astype(np.uint8)).save(map_out)
        out['map_peak'] = round(float(m.max()), 2)
        ys, xs = np.unravel_index(np.argsort(m.ravel())[-5:], m.shape)
        out['map_top'] = [[int(x), int(y), round(float(m[y, x]), 2)] for x, y in zip(xs, ys)]
    return out


if __name__ == '__main__':
    dirp, clips = sys.argv[1], [a for i, a in enumerate(sys.argv[2:], 2) if not a.startswith('--') and not a.isdigit() and sys.argv[i - 1] != '--json']
    mp = '--map' in sys.argv
    res = []
    for clip in clips:
        r = analyse(dirp, clip, os.path.join(dirp, clip + '_map.png') if mp else None)
        res.append(r)
        print(clip, 'sky px/frame', r['sky_speed_px'])
        for k in ('sky', 'cloud', 'edge', 'far', 'jet', 'horizon', 'frame'):
            v = r[k]
            if v:
                print(f"  {k:7s} px={v['px_per_frame']:7d} d2={v['d2_mean']:.3f} pop={v['pop_mean']:.3f} >2:{v['pop_gt2_pct']:.3f}% >4:{v['pop_gt4_pct']:.3f}% >8:{v['pop_gt8_pct']:.4f}% p99.9={v['pop_p999']} max={v['pop_max']}")
        if mp:
            print('  map', r.get('map_peak'), r.get('map_top'))
    if '--json' in sys.argv:
        json.dump(res, open(sys.argv[sys.argv.index('--json') + 1], 'w'), indent=1)
