/**
 * Sharper cockpit textures for the player MiG-21 (first-person view).
 *
 *   node tools/blender/upgrade-cockpit-textures.mjs            rewrite both GLBs in place
 *   node tools/blender/upgrade-cockpit-textures.mjs --check <dir>   write check sheets only
 *
 * 1. public/models/mig21.glb, cockpit atlas (material 14741d76...): the
 *    1024 px base colour (every gauge face is ~30-50 px there, so the panel
 *    read as a blur at the 0.05 m near plane) becomes 2048 px: lanczos3
 *    upscale + a mild unsharp mask, then every instrument face listed in
 *    DIALS below is redrawn as a vector dial (SVG rendered by sharp) at the
 *    new resolution. The dial faces are original procedural art of this
 *    project (generic Soviet-style instruments: black face, white ticks and
 *    numerals, white needles, an attitude ball, a compass card); they copy no
 *    real instrument artwork and no game's assets. The atlas is stored
 *    mirrored vertically relative to the panel as rendered (the source UVs
 *    run bottom-up), so each face is drawn upright and flipped before it is
 *    composited. Normal map and KHR_materials_specular texture are untouched.
 * 2. public/models/mig21_cockpit.glb, overlay screens: screen_mfd and
 *    screen_text (256 px, aliased 1 px lines from tools/blender/build_cockpit.py)
 *    become 512 px anti-aliased drawings with the same layout (radar B-scope:
 *    range arcs, azimuth limits, centre line, blips; amber segment readouts).
 *
 * Idempotent guard: the atlas is only rebuilt while it is still 1024 px, so
 * re-running after `tools/blender/build-mig-player.mjs` is safe; running it
 * twice in a row skips step 1. Dial centres are atlas pixels at 1024 px,
 * found with a circle Hough transform and checked by eye on the --check sheet.
 */
import { statSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { io, sharp } from './gltf-pipeline.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PLAYER = join(ROOT, 'public/models/mig21.glb');
const OVERLAY = join(ROOT, 'public/models/mig21_cockpit.glb');
const ATLAS_MATERIAL = '14741d76-e811-42f1-944c-dacd049162be';
const SCALE = 2; // 1024 -> 2048
const SCREEN = 512;

// [x, y, r] in 1024-px atlas pixels (r = outer edge of the bezel), kind.
const DIALS = [
  // main panel, right column (top to bottom as stored = bottom to top in the cockpit)
  [284.5, 47.5, 20.5, 'tach'],
  [284.5, 95, 19.5, 'gmeter'],
  [284.5, 144, 20, 'speed'],
  [287, 182, 9.5, 'small'],
  // main panel, left and middle columns
  [75.5, 92, 21, 'hsi'],
  [27.5, 108.5, 16, 'clock'],
  [27.5, 148, 16, 'vsi'],
  [79.5, 148, 25, 'adi'],
  [132.5, 147, 20, 'alt'],
  [133, 224, 10, 'small'],
  // small panel by the throttle
  [498.5, 42, 10, 'small'],
  [495.5, 81, 10.5, 'small'],
  // right console
  [700, 406, 12.5, 'generic'],
  [737.5, 406, 12.5, 'generic'],
  [698, 450, 12.5, 'adi'],
  [740.5, 443, 12.5, 'generic'],
  [746, 490, 10, 'small'],
  [746, 516, 9.5, 'small'],
  // left console and sub-panels
  [718.3, 834.3, 15, 'gmeter'],
  [896.7, 797.3, 14, 'adi'],
  [763.3, 751.7, 6.5, 'small'],
  [822.7, 1001.7, 9, 'small'],
  [579, 849, 8, 'small'],
];

// ------------------------------------------------------------------ dial art
// All faces are drawn in a -100..100 box (100 = bezel edge), upright as the
// pilot sees them.
const WHITE = '#ecebe4';
const FONT = 'Arial, Helvetica, sans-serif';
const rad = (deg) => (deg * Math.PI) / 180;
const pt = (r, deg) => [Math.sin(rad(deg)) * r, -Math.cos(rad(deg)) * r]; // 0 deg = 12 o'clock, clockwise

function ticks({ from, to, steps, major, r0 = 78, r1 = 87, rm = 69, w = 1.8, wm = 3.6 }) {
  let s = '';
  for (let i = 0; i <= steps; i++) {
    const a = from + ((to - from) * i) / steps;
    const isMajor = i % major === 0;
    const [x0, y0] = pt(isMajor ? rm : r0, a);
    const [x1, y1] = pt(r1, a);
    s += `<line x1="${x0.toFixed(2)}" y1="${y0.toFixed(2)}" x2="${x1.toFixed(2)}" y2="${y1.toFixed(2)}" stroke="${WHITE}" stroke-width="${isMajor ? wm : w}" stroke-linecap="butt"/>`;
  }
  return s;
}

function numerals(labels, from, to, r = 55, size = 17) {
  let s = '';
  labels.forEach((t, i) => {
    if (t === null) return;
    const a = labels.length === 1 ? from : from + ((to - from) * i) / (labels.length - 1);
    const [x, y] = pt(r, a);
    s += `<text x="${x.toFixed(1)}" y="${(y + size * 0.36).toFixed(1)}" font-family="${FONT}" font-weight="bold" font-size="${size}" fill="${WHITE}" text-anchor="middle">${t}</text>`;
  });
  return s;
}

/** A pointer: a bar of width w that tapers to a point over its last 15 %, with a short tail. */
function needle(deg, { len = 76, tail = 16, w = 5, color = WHITE } = {}) {
  const P = (along, side) => {
    const [ax, ay] = pt(along, deg);
    const [sx, sy] = pt(side, deg + 90);
    return `${(ax + sx).toFixed(2)},${(ay + sy).toFixed(2)}`;
  };
  const h = w * 0.7; // half width; pointers read thin at 40-80 px otherwise
  const pts = [P(len, 0), P(len * 0.85, h * 0.7), P(0, h), P(-tail, h * 1.2), P(-tail, -h * 1.2), P(0, -h), P(len * 0.85, -h * 0.7)];
  return `<polygon points="${pts.join(' ')}" fill="${color}"/>`;
}

const hub = (c = '#2a2a2a') => `<circle r="9" fill="${c}"/><circle r="3.5" fill="#9a9a96"/>`;
const label = (t, y, size = 10) => `<text x="0" y="${y}" font-family="${FONT}" font-size="${size}" fill="${WHITE}" text-anchor="middle" opacity="0.85">${t}</text>`;

function bezel(inner = 86) {
  return `<defs><radialGradient id="face" cx="0" cy="0" r="${inner}" gradientUnits="userSpaceOnUse">`
    + '<stop offset="0" stop-color="#121314"/><stop offset="1" stop-color="#050506"/></radialGradient></defs>'
    + '<circle r="100" fill="#1d1f20"/><circle r="96" fill="none" stroke="#3a3d3e" stroke-width="2"/>'
    + `<circle r="${inner + 3}" fill="#0a0a0b"/><circle r="${inner}" fill="url(#face)"/>`;
}

// a faint reflection on the cover glass
const glass = () => '<path d="M -62 -50 A 80 80 0 0 1 40 -72" fill="none" stroke="#ffffff" stroke-width="5" stroke-linecap="round" opacity="0.07"/>';

function face(kind) {
  let s = '';
  switch (kind) {
    case 'tach': // engine rpm %, 0..110 over 300 deg
      s += bezel();
      s += ticks({ from: -150, to: 150, steps: 55, major: 10 });
      s += `<path d="M ${pt(83, 105).join(' ')} A 83 83 0 0 1 ${pt(83, 150).join(' ')}" fill="none" stroke="#c8302a" stroke-width="5"/>`;
      s += numerals([0, 2, 4, 6, 8, 10], -150, 122.7, 55, 18);
      s += label('%', 32, 13) + label('ОБ/МИН', 48, 9);
      s += needle(86) + hub('#b89a2a');
      break;
    case 'gmeter': // accelerometer -2..+8 g, red limits
      s += bezel();
      s += ticks({ from: -135, to: 135, steps: 40, major: 4 });
      s += `<path d="M ${pt(83, 108).join(' ')} A 83 83 0 0 1 ${pt(83, 135).join(' ')}" fill="none" stroke="#c8302a" stroke-width="6"/>`;
      s += `<path d="M ${pt(83, -135).join(' ')} A 83 83 0 0 1 ${pt(83, -121).join(' ')}" fill="none" stroke="#c8302a" stroke-width="6"/>`;
      s += numerals(['-2', 0, 2, 4, 6, 8], -135, 135, 55, 17);
      s += label('g', 34, 14);
      s += needle(-81) + hub();
      break;
    case 'speed': // indicated airspeed, km/h x100, two pointers
      s += bezel();
      s += ticks({ from: -160, to: 160, steps: 48, major: 4 });
      s += numerals([2, 4, 6, 8, 10, 12, 14], -160, 160, 56, 16);
      s += label('КМ/Ч', 34, 11) + label('×100', 48, 9);
      s += needle(37, { len: 78, w: 5 }) + needle(-60, { len: 56, w: 3.6, color: '#d9b440' }) + hub();
      break;
    case 'alt': // barometric altimeter, 0..9 (km and hundreds)
      s += bezel();
      s += ticks({ from: 0, to: 360, steps: 50, major: 5 });
      s += numerals([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 0, 324, 57, 18);
      s += '<rect x="-22" y="18" width="44" height="17" fill="#000" stroke="#555" stroke-width="1.5"/>';
      s += `<text x="0" y="31" font-family="${FONT}" font-size="13" fill="${WHITE}" text-anchor="middle">4 9 5</text>`;
      s += label('М', -24, 12);
      s += needle(198, { len: 78, w: 4.5 }) + needle(63, { len: 50, w: 6 }) + hub();
      break;
    case 'clock':
      s += bezel();
      s += ticks({ from: 0, to: 360, steps: 60, major: 5 });
      s += numerals([12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], 0, 330, 57, 17);
      s += needle(312, { len: 54, w: 5 }) + needle(48, { len: 76, w: 3.5 }) + needle(150, { len: 80, w: 1.6, tail: 22, color: '#d94a2e' }) + hub();
      break;
    case 'vsi': // vertical speed, 0 at 9 o'clock, +/- 200 m/s
      s += bezel();
      s += ticks({ from: -180, to: 0, steps: 24, major: 4 });
      s += numerals([20, 10, 5, 0, 5, 10, 20], -180, 0, 56, 16);
      s += label('М/С', 30, 11);
      s += needle(-78) + hub();
      break;
    case 'hsi': { // compass card, course arrow
      s += bezel(90);
      let card = ticks({ from: 0, to: 360, steps: 72, major: 6, r0: 80, r1: 88, rm: 72 });
      const nums = ['N', 3, 6, 'E', 12, 15, 'S', 21, 24, 'W', 30, 33];
      card += numerals(nums, 0, 330, 60, 15);
      s += `<g transform="rotate(-24)">${card}</g>`;
      // course arrow and deviation bar
      s += '<g transform="rotate(18)"><polygon points="0,-74 -7,-58 -2.5,-58 -2.5,-22 2.5,-22 2.5,-58 7,-58" fill="#e8c23a"/>'
        + '<rect x="-2.5" y="22" width="5" height="44" fill="#e8c23a"/><rect x="5" y="-20" width="5" height="40" fill="#d6d6d0"/>'
        + '<circle cx="-30" cy="0" r="3" fill="none" stroke="#d6d6d0" stroke-width="1.6"/><circle cx="-15" cy="0" r="3" fill="none" stroke="#d6d6d0" stroke-width="1.6"/>'
        + '<circle cx="30" cy="0" r="3" fill="none" stroke="#d6d6d0" stroke-width="1.6"/><circle cx="45" cy="0" r="3" fill="none" stroke="#d6d6d0" stroke-width="1.6"/></g>';
      // fixed aircraft symbol and lubber line
      s += '<polygon points="0,-12 4,0 16,4 16,8 4,7 3,16 8,19 8,21 -8,21 -8,19 -3,16 -4,7 -16,8 -16,4 -4,0" fill="#f2f2ee"/>';
      s += '<polygon points="0,-90 -6,-99 6,-99" fill="#f2f2ee"/>';
      break;
    }
    case 'adi': { // attitude ball: sky up, earth down, pitch ladder, bank scale
      const ladder = [-20, -10, 10, 20].map((p) => {
        const y = -p * 2.6;
        const w = Math.abs(p) === 10 ? 22 : 34;
        return `<line x1="${-w}" y1="${y}" x2="${w}" y2="${y}" stroke="#f4f4f0" stroke-width="2.2"/>`
          + `<text x="${w + 10}" y="${y + 4}" font-family="${FONT}" font-size="10" fill="#f4f4f0" text-anchor="middle">${Math.abs(p)}</text>`;
      }).join('');
      s += '<defs><clipPath id="ball"><circle r="78"/></clipPath></defs>';
      s += '<circle r="100" fill="#1d1f20"/><circle r="96" fill="none" stroke="#3a3d3e" stroke-width="2"/><circle r="86" fill="#060607"/>';
      s += `<g clip-path="url(#ball)" transform="rotate(-8)"><g transform="translate(0,6)">`
        + '<rect x="-100" y="-120" width="200" height="120" fill="#3f84c4"/><rect x="-100" y="0" width="200" height="120" fill="#5c3d22"/>'
        + `<line x1="-100" y1="0" x2="100" y2="0" stroke="#f8f8f4" stroke-width="3"/>${ladder}</g></g>`;
      s += '<circle r="78" fill="none" stroke="#000" stroke-width="3"/>';
      // bank scale on the bezel ring (fixed) with a pointer
      for (const a of [-60, -30, -20, -10, 0, 10, 20, 30, 60]) {
        const [x0, y0] = pt(80, a);
        const [x1, y1] = pt(a % 30 === 0 ? 92 : 87, a);
        s += `<line x1="${x0.toFixed(1)}" y1="${y0.toFixed(1)}" x2="${x1.toFixed(1)}" y2="${y1.toFixed(1)}" stroke="#f4f4f0" stroke-width="${a % 30 === 0 ? 3 : 2}"/>`;
      }
      s += `<polygon points="0,-79 -6,-70 6,-70" fill="#f4f4f0" transform="rotate(-8)"/>`;
      // fixed aircraft symbol (yellow)
      s += '<path d="M -52 0 L -20 0 L -12 10 L 0 0 L 12 10 L 20 0 L 52 0" fill="none" stroke="#f2c230" stroke-width="5.5" stroke-linejoin="round"/>'
        + '<circle r="4" fill="#f2c230"/>';
      break;
    }
    case 'small': // tiny gauge: ticks and a needle (numerals would be sub-pixel)
      s += bezel(84);
      s += ticks({ from: -135, to: 135, steps: 10, major: 2, r0: 66, r1: 80, rm: 54, w: 5, wm: 8 });
      s += needle(-30, { len: 70, w: 8, tail: 12 }) + '<circle r="13" fill="#2a2a2a"/>';
      break;
    default: // generic 0..5 instrument
      s += bezel();
      s += ticks({ from: -135, to: 135, steps: 25, major: 5, w: 2.4, wm: 4.4 });
      s += numerals([0, 1, 2, 3, 4, 5], -135, 135, 54, 20);
      s += needle(25, { w: 6 }) + hub();
  }
  return s + glass();
}

function dialSVG(kind, px) {
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="-100 -100 200 200">${face(kind)}</svg>`);
}

/** Upscaled atlas with the faces drawn in. Returns a sharp-compatible raw RGB buffer. */
async function buildAtlas(src) {
  const meta = await sharp(src).metadata();
  const W = meta.width * SCALE;
  const H = meta.height * SCALE;
  const base = await sharp(src).removeAlpha().resize(W, H, { kernel: 'lanczos3' })
    .sharpen({ sigma: 1.1, m1: 0.6, m2: 1.4 }).png().toBuffer();
  const comps = [];
  for (const [x, y, r, kind] of DIALS) {
    const R = r * SCALE;
    const px = Math.ceil(R * 2) + 2;
    const left = Math.round(x * SCALE - px / 2);
    const top = Math.round(y * SCALE - px / 2);
    // drawn upright, then mirrored vertically to match the atlas (see header)
    const img = await sharp(dialSVG(kind, px)).flip().png().toBuffer();
    comps.push({ input: img, left, top });
  }
  return sharp(base).composite(comps);
}

// ------------------------------------------------------------------ screens
function mfdSVG(n) {
  // apex at the bottom, as the 256 px original; units are 256-px pixels
  const cx = 128, cy = 256 - 46;
  const arc = (r) => {
    const a = rad(60);
    return `<path d="M ${cx - Math.sin(a) * r} ${cy - Math.cos(a) * r} A ${r} ${r} 0 0 1 ${cx + Math.sin(a) * r} ${cy - Math.cos(a) * r}" fill="none" stroke="#5cff8c" stroke-width="1.6"/>`;
  };
  let s = '<rect width="256" height="256" fill="rgb(0,9,5)"/>';
  s += '<g opacity="0.9">' + [60, 110, 160, 210].map(arc).join('') + '</g>';
  for (const a of [-60, 60]) {
    s += `<line x1="${cx}" y1="${cy}" x2="${cx + Math.sin(rad(a)) * 215}" y2="${cy - Math.cos(rad(a)) * 215}" stroke="#5cff8c" stroke-width="1.6"/>`;
  }
  for (const a of [-30, 30]) {
    s += `<line x1="${cx + Math.sin(rad(a)) * 60}" y1="${cy - Math.cos(rad(a)) * 60}" x2="${cx + Math.sin(rad(a)) * 212}" y2="${cy - Math.cos(rad(a)) * 212}" stroke="#5cff8c" stroke-width="0.8" stroke-dasharray="3 5" opacity="0.6"/>`;
  }
  s += `<line x1="${cx}" y1="${cy}" x2="${cx}" y2="${cy - 215}" stroke="#5cff8c" stroke-width="1.4"/>`;
  // elevation scale on the left
  for (let i = 0; i < 9; i++) s += `<line x1="14" y1="${32 + i * 24}" x2="20" y2="${32 + i * 24}" stroke="#5cff8c" stroke-width="1.6"/>`;
  s += '<polygon points="22,128 28,124 28,132" fill="#5cff8c"/>';
  // blips and a target marker
  s += '<circle cx="150" cy="96" r="3.6" fill="#8dffae"/><circle cx="95" cy="136" r="3.2" fill="#8dffae"/>';
  s += '<rect x="143" y="89" width="14" height="14" fill="none" stroke="#8dffae" stroke-width="1.2"/>';
  // range readout
  s += `<text x="236" y="22" font-family="${FONT}" font-size="13" fill="#5cff8c" text-anchor="end">30</text>`;
  s += `<text x="236" y="236" font-family="${FONT}" font-size="11" fill="#5cff8c" text-anchor="end" opacity="0.8">ЗАХВ</text>`;
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${n}" height="${n}" viewBox="0 0 256 256">${s}</svg>`);
}

/** One seven-segment digit at (x, y), 12 x 18 units. */
function segDigit(ch, x, y) {
  const SEG = { 0: 'abcdef', 1: 'bc', 2: 'abged', 3: 'abgcd', 4: 'fgbc', 5: 'afgcd', 6: 'afgedc', 7: 'abc', 8: 'abcdefg', 9: 'abcdfg', '-': 'g' };
  const on = SEG[ch] ?? '';
  const w = 12, h = 18, t = 2.4;
  const segs = {
    a: [x + 1.5, y, w - 3, t], d: [x + 1.5, y + h - t, w - 3, t], g: [x + 1.5, y + h / 2 - t / 2, w - 3, t],
    f: [x, y + 1.2, t, h / 2 - 1.8], b: [x + w - t, y + 1.2, t, h / 2 - 1.8],
    e: [x, y + h / 2 + 0.6, t, h / 2 - 1.8], c: [x + w - t, y + h / 2 + 0.6, t, h / 2 - 1.8],
  };
  let s = '';
  for (const [k, [sx, sy, sw, sh]] of Object.entries(segs)) {
    s += `<rect x="${sx.toFixed(2)}" y="${sy.toFixed(2)}" width="${sw.toFixed(2)}" height="${sh.toFixed(2)}" rx="0.8" fill="#ff9e26" opacity="${on.includes(k) ? 1 : 0.07}"/>`;
  }
  return s;
}

function textSVG(n) {
  let s = '<rect width="256" height="256" fill="rgb(0,9,5)"/>';
  // Four characters a row: the side displays are narrow quads (~1:1.4), so
  // eight-character rows squeezed into unreadable noise there.
  const rows = ['0540', '-127', '3245', '18.6', '1200', '0395'];
  const k = 2.6; // digit scale (12 x 18 units each)
  rows.forEach((row, ri) => {
    const y = 10 + ri * 41;
    let x = 18;
    for (const ch of row) {
      if (ch === '.') { s += `<rect x="${x - 9}" y="${y + 18 * k * 0.85 - 6}" width="6" height="6" fill="#ff9e26"/>`; continue; }
      if (ch !== ' ') s += `<g transform="translate(${x} ${y}) scale(${k} ${k * 0.85})">${segDigit(ch, 0, 0)}</g>`;
      x += 58;
    }
  });
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${n}" height="${n}" viewBox="0 0 256 256">${s}</svg>`);
}

// ------------------------------------------------------------------ main
const args = process.argv.slice(2);
const checkDir = args[0] === '--check' ? args[1] : null;

if (checkDir) {
  mkdirSync(checkDir, { recursive: true });
  const kinds = [...new Set(DIALS.map((d) => d[3]))];
  const tiles = await Promise.all(kinds.map((k) => sharp(dialSVG(k, 256)).png().toBuffer()));
  await sharp({ create: { width: kinds.length * 262, height: 262, channels: 3, background: '#2b8f86' } })
    .composite(tiles.map((input, i) => ({ input, left: i * 262 + 3, top: 3 }))).png().toFile(join(checkDir, 'dial_kinds.png'));
  await sharp(mfdSVG(SCREEN)).png().toFile(join(checkDir, 'screen_mfd.png'));
  await sharp(textSVG(SCREEN)).png().toFile(join(checkDir, 'screen_text.png'));
  const doc = await io.read(PLAYER);
  const mat = doc.getRoot().listMaterials().find((m) => m.getName() === ATLAS_MATERIAL);
  const tex = mat.getBaseColorTexture();
  const meta = await sharp(Buffer.from(tex.getImage())).metadata();
  if (meta.width === 1024) await (await buildAtlas(Buffer.from(tex.getImage()))).png().toFile(join(checkDir, 'atlas_2048.png'));
  console.log('check sheets in', checkDir);
  process.exit(0);
}

const before = { player: statSync(PLAYER).size, overlay: statSync(OVERLAY).size };

{
  const doc = await io.read(PLAYER);
  const mat = doc.getRoot().listMaterials().find((m) => m.getName() === ATLAS_MATERIAL);
  if (!mat) throw new Error(`no material ${ATLAS_MATERIAL} in ${PLAYER}`);
  const tex = mat.getBaseColorTexture();
  const src = Buffer.from(tex.getImage());
  const meta = await sharp(src).metadata();
  if (meta.width !== 1024) {
    console.log(`atlas is ${meta.width} px already: skipped`);
  } else {
    const atlas = await (await buildAtlas(src)).webp({ quality: 85, effort: 6 }).toBuffer();
    tex.setImage(new Uint8Array(atlas)).setMimeType('image/webp');
    await io.write(PLAYER, doc);
  }
}

{
  const doc = await io.read(OVERLAY);
  for (const t of doc.getRoot().listTextures()) {
    const name = t.getName();
    const svg = name === 'cockpit_mfd' ? mfdSVG(SCREEN) : name === 'cockpit_text' ? textSVG(SCREEN) : null;
    if (!svg) continue;
    const img = await sharp(svg).removeAlpha().webp({ quality: 90, effort: 6 }).toBuffer();
    t.setImage(new Uint8Array(img)).setMimeType('image/webp');
  }
  await io.write(OVERLAY, doc);
}

const after = { player: statSync(PLAYER).size, overlay: statSync(OVERLAY).size };
console.log(`mig21.glb ${before.player} -> ${after.player} (${after.player - before.player >= 0 ? '+' : ''}${after.player - before.player} B)`);
console.log(`mig21_cockpit.glb ${before.overlay} -> ${after.overlay} (${after.overlay - before.overlay >= 0 ? '+' : ''}${after.overlay - before.overlay} B)`);
