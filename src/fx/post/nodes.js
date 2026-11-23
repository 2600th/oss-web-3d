import {
  Fn, float, vec2, vec3, vec4, uv, int, Loop, If, max, min, mix, clamp, smoothstep, exp, pow, abs,
  length, dot, atan, cos, sin, select, fract, screenSize, screenCoordinate, luminance, log2, mat3,
  interleavedGradientNoise,
} from 'three/tsl';

/**
 * TSL building blocks for the post chain. Everything here is backend-agnostic
 * TSL (runs on WebGPU and the WebGL2 fallback).
 *
 * Depth convention: the renderer uses a REVERSED float depth buffer (near = 1,
 * far/sky = 0). View distance from reversed depth d (WebGPU [0,1] clip range):
 *     z = near * far / (d * (far - near) + near)
 * Sky is drawn with depthWrite off, so its pixels keep the cleared 0.
 */
export const reversedDepthToDistance = (d, near, far) => near.mul(far).div(d.mul(far.sub(near)).add(near));

// Motion blur lives in ./motionBlur.js (reconstruction filter).

// ---------------------------------------------------------------------------
// Sun occlusion (rendered into a 1x1 target, sampled by the flare)
// ---------------------------------------------------------------------------

/**
 * Fraction of the sun's disc that reaches the lens, in [0,1]:
 * an n x n disc of taps around the sun's screen position; a tap counts if the
 * depth is the cleared sky value (terrain/aircraft occlude) AND the composited
 * HDR colour there is still sun-bright (clouds composite before post, keep the
 * sky depth, and only show up as lost luminance). Off-screen taps count as
 * visible; the flare fades with the sun's distance from the frame instead.
 * Output: x = visibility, y = mean luminance seen.
 */
export function sunVisibility({ color, depth, sunUV, aspect, radius, refLum, grid }) {
  return Fn(() => {
    const acc = float(0).toVar();
    const peak = float(0).toVar();
    const wAcc = float(0).toVar();
    const anyOn = float(0).toVar();
    const g = float(grid);
    Loop(grid, grid, ({ i, j }) => {
      const o = vec2(float(i), float(j)).add(0.5).div(g).mul(2).sub(1);
      const inDisc = dot(o, o).lessThanEqual(1.0);
      const suv = sunUV.add(o.mul(radius).mul(vec2(aspect.reciprocal(), 1)));
      const onScreen = suv.x.greaterThanEqual(0).and(suv.x.lessThanEqual(1)).and(suv.y.greaterThanEqual(0)).and(suv.y.lessThanEqual(1));
      const d = depth.sample(suv.clamp(0, 1)).x;
      const lum = luminance(color.sample(suv.clamp(0, 1)).rgb);
      const sky = select(d.lessThanEqual(0.0), float(1), float(0));
      const w = select(inDisc, float(1), float(0));
      acc.addAssign(select(onScreen, sky, float(1)).mul(w));
      peak.assign(max(peak, select(onScreen.and(inDisc), lum.mul(sky), float(0))));
      anyOn.assign(max(anyOn, select(onScreen.and(inDisc), float(1), float(0))));
      wAcc.addAssign(w);
    });
    // Geometry: fraction of the disc that is sky. Clouds: the brightest sky tap
    // (the sun's core) against its clear-sky value — clouds dim it, they do not
    // write depth. Fully off-screen: trust geometry alone.
    const cloud = select(anyOn.greaterThan(0.5), smoothstep(0.04, 0.45, peak.div(refLum)), float(1));
    return vec4(acc.div(wAcc).mul(cloud), peak, cloud, 1);
  })();
}

// ---------------------------------------------------------------------------
// Sun lens flare (analytic, full resolution, added in exposed HDR)
// ---------------------------------------------------------------------------

const hexDist = (q) => {
  const a = abs(q);
  return max(a.x.mul(0.866025).add(a.y.mul(0.5)), a.y);
};

/**
 * Lens flare for the sun: core glare, a 6+8 blade starburst, a thin anamorphic
 * streak, a faint chromatic halo ring and a chain of aperture ghosts mirrored
 * through the optical centre. All terms are aspect-correct and in HDR units
 * scaled by `amount` (= visibility * intensity * on-screen fade).
 * `p`/`s` are pixel and sun positions in centred, aspect-corrected space.
 */
export const sunFlare = Fn(([uv0, sunUV, aspect, amount, rot]) => {
  const k = vec2(aspect, 1);
  const p = uv0.sub(0.5).mul(k);
  const s = sunUV.sub(0.5).mul(k);
  const d = p.sub(s);
  const dist = length(d);
  const out = vec3(0).toVar();

  // core glare: tight + wide lobes
  out.addAssign(vec3(1.0, 0.92, 0.8).mul(exp(dist.mul(-55)).mul(4.0).add(exp(dist.mul(-11)).mul(0.35))));

  // starburst (iris blades) with per-ray length variation
  const ang = atan(d.y, d.x).add(rot);
  const r6 = pow(abs(cos(ang.mul(3.0))), 160.0);
  const r8 = pow(abs(cos(ang.mul(4.0).add(0.6))), 260.0).mul(0.55);
  const fine = pow(abs(cos(ang.mul(23.0).add(1.7))), 30.0).mul(0.25);
  const vary = fract(sin(ang.mul(37.0).floor().mul(12.9898)).mul(43758.5453)).mul(0.6).add(0.4);
  const rays = r6.add(r8).mul(vary).mul(exp(dist.mul(-5.2))).mul(2.4).add(fine.mul(exp(dist.mul(-14))).mul(1.5));
  out.addAssign(vec3(1.0, 0.95, 0.88).mul(rays));

  // anamorphic streak (cylindrical front element): a hair-thin hot core and
  // a softer cool sheath, both running most of the frame width
  const ax = abs(d.x);
  const core = exp(abs(d.y).mul(-520)).mul(exp(ax.mul(-1.6))).mul(0.5);
  const sheath = exp(abs(d.y).mul(-95)).mul(exp(ax.mul(-3.2))).mul(0.12);
  out.addAssign(vec3(0.62, 0.8, 1.0).mul(core).add(vec3(0.3, 0.5, 1.0).mul(sheath)));

  // halo ring around the sun, slightly chromatic
  const ring = (rad, w) => exp(dist.sub(rad).div(w).pow(2).negate());
  out.addAssign(vec3(ring(0.335, 0.014), ring(0.325, 0.014), ring(0.315, 0.015)).mul(0.09));

  // ghosts along the sun -> centre axis (position = s * f, f < 0 is mirrored)
  const ghost = (f, size, tint, strength, hex) => {
    const q = p.sub(s.mul(f));
    const gd = hex ? hexDist(q) : length(q);
    const disc = smoothstep(size, size * 0.82, gd);
    const rim = smoothstep(size * 0.7, size * 0.98, gd).mul(disc).mul(0.6).add(0.4);
    return vec3(...tint).mul(disc.mul(rim)).mul(strength);
  };
  out.addAssign(ghost(-0.35, 0.045, [0.5, 0.9, 0.6], 0.16, true));
  out.addAssign(ghost(-0.62, 0.085, [0.9, 0.55, 1.0], 0.055, true));
  out.addAssign(ghost(-0.9, 0.03, [1.0, 0.75, 0.35], 0.22, false));
  out.addAssign(ghost(-1.25, 0.16, [0.35, 0.6, 1.0], 0.05, true));
  out.addAssign(ghost(0.45, 0.022, [1.0, 0.6, 0.4], 0.18, false));
  out.addAssign(ghost(0.72, 0.06, [0.5, 1.0, 0.8], 0.06, true));
  out.addAssign(ghost(-1.7, 0.05, [1.0, 0.45, 0.3], 0.1, false));
  // big soft ghost hugging the centre
  out.addAssign(ghost(-0.12, 0.26, [0.6, 0.75, 1.0], 0.025, false));

  return out.mul(amount);
}, { uv0: 'vec2', sunUV: 'vec2', aspect: 'float', amount: 'float', rot: 'float', return: 'vec3' });

/** Wide glow used to reveal lens dirt around the sun. */
export const sunGlow = Fn(([uv0, sunUV, aspect]) => {
  const k = vec2(aspect, 1);
  const dist = length(uv0.sub(sunUV).mul(k));
  return exp(dist.mul(-4.5));
}, { uv0: 'vec2', sunUV: 'vec2', aspect: 'float', return: 'float' });

// ---------------------------------------------------------------------------
// Tone mapping + look
// ---------------------------------------------------------------------------

const LIN_SRGB_TO_REC2020 = mat3(vec3(0.6274, 0.0691, 0.0164), vec3(0.3293, 0.9195, 0.0880), vec3(0.0433, 0.0113, 0.8956));
const LIN_REC2020_TO_SRGB = mat3(vec3(1.6605, -0.1246, -0.0182), vec3(-0.5876, 1.1329, -0.1006), vec3(-0.0728, -0.0083, 1.1187));
const AGX_INSET = mat3(vec3(0.856627153315983, 0.137318972929847, 0.11189821299995), vec3(0.0951212405381588, 0.761241990602591, 0.0767994186031903), vec3(0.0482516061458583, 0.101439036467562, 0.811302368396859));
const AGX_OUTSET = mat3(vec3(1.1271005818144368, -0.1413297634984383, -0.14132976349843826), vec3(-0.11060664309660323, 1.157823702216272, -0.11060664309660294), vec3(-0.016493938717834573, -0.016493938717834257, 1.2519364065950405));

const agxContrast = (x) => {
  const x2 = x.mul(x);
  const x4 = x2.mul(x2);
  return x4.mul(x2).mul(15.5).sub(x4.mul(x).mul(40.14)).add(x4.mul(31.96)).sub(x2.mul(x).mul(6.868)).add(x2.mul(0.4298)).add(x.mul(0.1191)).sub(0.00232);
};

/**
 * AgX with a bespoke "Kargil noon" look. Same structure as Blender's AgX looks:
 * an ASC-CDL (slope / power / saturation) applied to the sigmoid's output in
 * AgX space, before the outset. The base AgX desaturates bright highlights
 * hard — right for the sun, wrong for a frame that is mostly sunlit snow — so
 * the look restores chroma and adds a touch of contrast and warm slope.
 * Input: exposed linear sRGB. Output: display-linear sRGB in [0,1].
 */
export const agxLook = Fn(([color, slope, power, sat]) => {
  const c = LIN_SRGB_TO_REC2020.mul(color).toVar();
  c.assign(AGX_INSET.mul(c));
  c.assign(max(c, 1e-10));
  c.assign(log2(c).sub(-12.47393).div(4.026069 + 12.47393).clamp(0, 1));
  c.assign(agxContrast(c));
  // look (CDL)
  c.assign(pow(max(c.mul(slope), 0.0), power));
  const l = dot(c, vec3(0.2626983, 0.6780088, 0.0592929));
  c.assign(mix(vec3(l), c, sat));
  c.assign(AGX_OUTSET.mul(c));
  c.assign(pow(max(c, 0.0), vec3(2.2)));
  c.assign(LIN_REC2020_TO_SRGB.mul(c));
  return c.clamp(0, 1);
}, { color: 'vec3', slope: 'vec3', power: 'vec3', sat: 'float', return: 'vec3' });

/** Display-space split tone: cool shade, warm sun. */
export const splitTone = Fn(([c, shadowTint, highlightTint, balance]) => {
  const l = luminance(c);
  const t = smoothstep(balance.sub(0.35), balance.add(0.35), l);
  return c.mul(mix(shadowTint, highlightTint, t));
}, { c: 'vec3', shadowTint: 'vec3', highlightTint: 'vec3', balance: 'float', return: 'vec3' });

// ---------------------------------------------------------------------------
// Screen states (display-linear, after tone mapping)
// ---------------------------------------------------------------------------

/**
 * greyout: desaturate, dim and close a tunnel; redout: red wash, tunnel;
 * damage + lowHealth: red edge pulse with desaturation.
 * `r` = normalised radial distance (0 centre, ~1 corners).
 */
export const screenStates = Fn(([c, r, grey, red, damage, lowHealth]) => {
  const out = vec3(c).toVar();
  const l = luminance(out);
  // greyout: colour leaves first, then light, then the periphery closes in
  out.assign(mix(out, vec3(l), clamp(grey.mul(1.4), 0, 0.92)));
  // (arcade: full G-LOC keeps a dim pinhole rather than a black screen)
  const tunnelR = mix(1.25, 0.3, grey);
  const tunnel = smoothstep(tunnelR, tunnelR.sub(0.55), r).mul(0.97).add(0.03);
  out.mulAssign(mix(1, tunnel, smoothstep(0.1, 0.8, grey)).mul(float(1).sub(grey.mul(grey).mul(0.7))));
  // redout
  const redTunnel = smoothstep(mix(1.3, 0.25, red), mix(0.6, -0.2, red), r);
  out.assign(mix(out, vec3(l.mul(1.1).add(0.08), l.mul(0.12), l.mul(0.1)), clamp(red.mul(1.2), 0, 0.9)));
  out.mulAssign(mix(1, redTunnel, red.mul(0.85)));
  // damage / low health edge pulse
  const hurt = max(damage, lowHealth);
  const edge = smoothstep(0.35, 1.05, r);
  out.assign(mix(out, vec3(luminance(out)), damage.mul(0.55)));
  out.assign(mix(out, vec3(0.55, 0.02, 0.01), edge.mul(hurt).mul(0.75)));
  return out;
}, { c: 'vec3', r: 'float', grey: 'float', red: 'float', damage: 'float', lowHealth: 'float', return: 'vec3' });

/**
 * Animated film grain (display space). Two octaves of hashed noise (fine +
 * a softer 2 px clump) so it reads as grain, not as per-pixel digital noise;
 * strongest in the mid-tones and nearly absent in clipped whites and blacks,
 * like real stock.
 */
// (inline, not a typed Fn: it reads the fragment-coordinate builtin)
export const filmGrain = (c, amount, seed) => {
  const hash = (q) => fract(sin(dot(q, vec2(12.9898, 78.233))).mul(43758.5453));
  const p = screenCoordinate.xy.add(vec2(seed.mul(113.0), seed.mul(71.0))).mod(1024.0);
  const fine = hash(p).sub(0.5);
  const clump = hash(p.mul(0.5).floor().add(vec2(seed.mul(7.0), 3.0))).sub(0.5);
  const n = fine.mul(0.65).add(clump.mul(0.55));
  const l = luminance(c);
  const w = smoothstep(0.0, 0.18, l).mul(float(1).sub(smoothstep(0.55, 0.98, l))).mul(0.8).add(0.2);
  return c.add(n.mul(amount).mul(w));
};

// ---------------------------------------------------------------------------
// Speed: airflow streaks, sonic shock
// ---------------------------------------------------------------------------

/**
 * Thin condensation / airflow streaks whipping outward from the flight-path
 * focus (0..1 coverage). Polar coordinates around the focus: each of 260
 * angular lanes carries at most one short, hair-thin dash travelling outward;
 * lanes are sparse and randomly phased so it never reads as a tunnel. Kept to
 * the periphery: the centre of attention stays clean.
 */
export const airflowStreaks = Fn(([uv0, focus, aspect, t]) => {
  const d = uv0.sub(focus).mul(vec2(aspect, 1));
  const r = length(d);
  const a = atan(d.y, d.x).div(6.2831853).add(0.5);
  const lanes = float(260);
  const lane = a.mul(lanes).floor();
  const h1 = fract(sin(lane.mul(12.9898)).mul(43758.5453));
  const h2 = fract(sin(lane.mul(78.233)).mul(24634.6345));
  // hair-thin across the lane, the dash fades in along its length
  const across = abs(fract(a.mul(lanes)).sub(0.5)).mul(2);
  const thin = smoothstep(0.35, 0.0, across);
  const speed = h2.mul(1.4).add(1.6);
  const phase = fract(r.mul(0.55).sub(t.mul(speed)).add(h1));
  const len = h2.mul(0.06).add(0.03);
  const dash = smoothstep(0.0, len, phase).mul(smoothstep(len.mul(1.6), len, phase));
  const sparse = select(h1.greaterThan(0.72), float(1), float(0));
  const periphery = smoothstep(0.32, 0.75, r);
  return thin.mul(dash).mul(sparse).mul(periphery);
}, { uv0: 'vec2', focus: 'vec2', aspect: 'float', t: 'float', return: 'float' });

/**
 * Sonic "thump": one ring expanding from the flight-path focus that bends the
 * image as it passes. shock.x = phase 0..1, shock.y = amplitude (uv).
 */
export const shockOffset = Fn(([uv0, focus, aspect, shock]) => {
  const k = vec2(aspect, 1);
  const d = uv0.sub(focus).mul(k);
  const r = length(d);
  const R = shock.x.mul(1.3);
  const band = exp(r.sub(R).div(0.05).pow(2).negate());
  const fade = float(1).sub(shock.x).mul(smoothstep(0.0, 0.08, shock.x));
  return d.div(max(r, 1e-4)).div(k).mul(band).mul(fade).mul(shock.y);
}, { uv0: 'vec2', focus: 'vec2', aspect: 'float', shock: 'vec2', return: 'vec2' });

/** UV with uniform (non-stretched) aspect for overlay textures. */
export const aspectUV = (uv0, aspect) => uv0.sub(0.5).mul(vec2(aspect, 1)).add(0.5);

export { int };
