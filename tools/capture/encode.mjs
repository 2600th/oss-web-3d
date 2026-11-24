#!/usr/bin/env node
// Encode a captured frame sequence (captures/<clip>/00000.jpg ...) to an MP4.
//   node tools/capture/encode.mjs <clip> [--fps 30] [--crf 14] [--out path.mp4] [--keep]
// Needs ffmpeg on PATH. Frames are deleted after a successful encode unless --keep.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const clip = args.find((a) => !a.startsWith('--'));
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
if (!clip) { console.error('usage: encode.mjs <clip> [--fps 30] [--crf 14] [--out file.mp4] [--keep]'); process.exit(1); }
const dir = path.join(root, 'captures', clip);
const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^\d{5}\.(jpg|png)$/.test(f)).sort() : [];
if (!files.length) { console.error(`no frames in ${dir}`); process.exit(1); }
const ext = path.extname(files[0]);
const out = path.resolve(opt('out', path.join(root, 'captures', `${clip}.mp4`)));
const r = spawnSync('ffmpeg', ['-y', '-v', 'error', '-framerate', opt('fps', '30'), '-i', path.join(dir, `%05d${ext}`),
  '-c:v', 'libx264', '-preset', 'slow', '-crf', opt('crf', '14'), '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out], { stdio: 'inherit' });
if (r.status !== 0) process.exit(r.status ?? 1);
if (!args.includes('--keep')) fs.rmSync(dir, { recursive: true, force: true });
console.log(`${out} (${files.length} frames)`);
