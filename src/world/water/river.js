import { vec2, vec3, float, texture, time, fract, abs, mix, smoothstep, clamp, max, dot, length } from 'three/tsl';
import { TILE_SIZE } from '../terrain/detail.js';
import { TILE_SLOPE } from '../terrain/textures.js';

// Glacial rivers, shaded as part of the terrain surface.
//
// The build tool carves a level bed into the DEM along every channel and bakes
// a distance-to-bank field and a downstream direction. The terrain material
// calls `riverSurface` with those, so the water is the terrain's own surface:
// no second mesh, no sorting, no z-fighting at any LOD or distance.
//
// Look: melt-water carrying rock flour is opaque and milky turquoise, so it is
// shaded as a rough-dielectric surface with its own albedo rather than as clear
// refracting water. Ripples are two phases of a normal field advected along the
// flow direction (flow mapping, Vlachos 2010), foam appears where the bed
// steepens and along the banks.

const MILK_DEEP = vec3(0.075, 0.235, 0.255);
const MILK_SHALLOW = vec3(0.2, 0.36, 0.33);
const FOAM = vec3(0.82, 0.86, 0.86);

/**
 * @param p        world xz (dpx, dpy: its screen-space derivatives)
 * @param edge     metres to the bank (negative in the water), already perturbed for a ragged shoreline
 * @param flow     downstream direction, xz; its length runs from flowBase (level) to 1 (steep)
 * @param tile     the detail tile texture (its R,G slope channels are the ripple field)
 */
export function riverSurface({ p, dpx, dpy, edge, flow, flowBase, tile, dist }) {
  const len = length(flow);
  const dir = flow.div(max(len, 0.2));
  // 0 on a level reach, 1 where the bed falls ~9 m in 100 m
  const rapids = smoothstep(0.12, 0.8, len.sub(flowBase).div(1 - flowBase));
  const speed = float(2.2).add(rapids.mul(5.5)); // m/s

  const PERIOD = 2.6;
  const ph0 = fract(time.div(PERIOD));
  const ph1 = fract(time.div(PERIOD).add(0.5));
  const w0 = float(1).sub(abs(ph0.mul(2).sub(1)));
  const w1 = float(1).sub(w0);
  // explicit gradients: this runs inside a branch of the terrain shader
  const sample = (ph, scale, off) => texture(tile, p.sub(dir.mul(speed).mul(ph.sub(0.5)).mul(PERIOD)).div(scale).add(off))
    .grad(dpx.div(scale), dpy.div(scale));
  const a0 = sample(ph0, 23, vec2(0.13, 0.71));
  const a1 = sample(ph1, 23, vec2(0.57, 0.29));
  const b0 = sample(ph0, 6.5, vec2(0.31, 0.47));
  const b1 = sample(ph1, 6.5, vec2(0.83, 0.05));
  const big = mix(a1, a0, w0);
  const small = mix(b1, b0, w0);
  const slope = (s, scale, amp) => s.rg.mul(2).sub(1).mul((TILE_SLOPE * TILE_SIZE * amp) / scale);
  // Ripple amplitude grows with the current; far away the mips flatten it by themselves.
  const chop = float(0.35).add(rapids.mul(1.1));
  const grad = slope(big, 23, 0.16).add(slope(small, 6.5, 0.045)).mul(chop);

  const depth = clamp(edge.negate().div(9), 0, 1); // proxy: deeper toward the middle
  // advected noise at two scales, multiplied so foam breaks into streaks and patches
  const churn = big.b.mul(small.b).mul(4); // ~0..1.6
  const foamRapid = smoothstep(float(1.25).sub(rapids.mul(0.75)), float(1.5).sub(rapids.mul(0.7)), churn).mul(smoothstep(0.05, 0.4, rapids));
  const foamBank = smoothstep(-2.2, -0.1, edge).mul(smoothstep(0.85, 1.15, churn)).mul(0.5);
  const foam = clamp(foamRapid.add(foamBank), 0, 1).mul(smoothstep(4000, 900, dist));

  const milk = mix(MILK_SHALLOW, MILK_DEEP, smoothstep(0.05, 0.75, depth));
  const color = mix(milk, FOAM, foam);
  const roughness = mix(float(0.09).add(rapids.mul(0.12)), float(0.55), foam);
  return { color, roughness, grad, foam, depth, w1 };
}
