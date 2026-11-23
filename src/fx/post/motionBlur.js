import * as THREE from 'three/webgpu';
import {
  Fn, float, vec2, vec3, vec4, uv, int, ivec2, Loop, If, max, min, mix, clamp, smoothstep, length,
  dot, select, abs, rtt, convertToTexture, interleavedGradientNoise, screenCoordinate, normalize, fract,
} from 'three/tsl';
import { reversedDepthToDistance } from './nodes.js';

/**
 * Reconstruction-filter motion blur (McGuire et al. 2012, "A Reconstruction
 * Filter for Plausible Motion Blur", with the Jimenez 2014 "Next-Generation
 * Post Processing in Call of Duty" refinements). Pure TSL; runs on WebGPU and
 * the WebGL2 fallback.
 *
 *   prep     full res   rgba16f: x,y = blur half-vector in pixels (shutter,
 *                       player shutter, speed zoom and clamp applied),
 *                       z = linear depth in km, w = 1 on the player airframe
 *   tile4    1/4 res    max-length velocity of each 4x4 block
 *   tileMax  1/K res    max-length velocity of each K x K tile (K = max blur radius)
 *   neighbor 1/K res    max over the 3x3 tile neighbourhood
 *   gather   full res   S jittered taps along the dominant (neighbour) velocity,
 *                       every other tap along the pixel's own velocity; each
 *                       tap weighted by soft depth (foreground / background)
 *                       and by whether its own blur covers the centre
 *
 * Why the extra machinery over a plain per-pixel smear:
 *  - a fast background blurs *behind* a slow foreground's silhouette, without
 *    a sharp halo around it (tile neighbour max finds the background's motion
 *    even on foreground pixels; the depth weights decide who covers whom);
 *  - thin fast objects blur over the slow pixels next to them;
 *  - the player's jet gets its own short shutter (`playerShutter`): it rides
 *    with the camera, so only its own roll/pitch relative to the lens should
 *    smear, and only a little. Pixels are tagged as "player" by the airframe's
 *    material (velocity MRT .z = 1, see PostFX.usePlayerVelocity) or by being
 *    within the jet's own distance shell (`nearShell`: catches the VFX riding
 *    with it — afterburner, wing vapour — which do not write the tag).
 *
 * Speed zoom (`zoom`): an extra radial component from the flight-path focus,
 * added to world pixels only, grows with speed near the ground. It turns
 * "terrain sliding past" into the sense of rushing at it.
 *
 * Inputs: color (texture node, HDR), velocity (MRT texture: NDC delta per
 * frame), depth (reversed-Z texture), uniforms (see createMotionBlur).
 * The velocity buffer itself is never modified: TRAA reprojects with it.
 */
export function createMotionBlur({ color, velocity, depth, near, far, u, samples = 12, tile = 32 }) {
  const K = tile;

  // ---- prep: per-pixel blur vector (px), depth (km), player tag -------------
  const prep = rtt(Fn(() => {
    const uv0 = uv();
    const res = u.res;
    const s = velocity.sample(uv0);
    // NDC delta -> pixels; y flips (NDC up, texture down); half extent
    const v = s.xy.mul(vec2(0.5, -0.5)).mul(res).mul(u.strength).mul(0.5).toVar();
    const z = reversedDepthToDistance(depth.sample(uv0).x, near, far);
    // player airframe (material tag) or anything in its distance shell
    const tagged = s.z.greaterThan(0.5);
    const shell = z.lessThan(u.nearShell);
    const isPlayer = select(tagged.or(shell), float(1), float(0));
    // speed zoom: radial from the flight-path focus, world pixels only
    const fromFocus = uv0.sub(u.focus).mul(res);
    const zoom = fromFocus.mul(u.zoom).mul(smoothstep(0.05, 0.45, length(uv0.sub(u.focus).mul(vec2(1.4, 1)))));
    v.assign(mix(v.add(zoom), v.mul(u.playerShutter), isPlayer));
    // clamp the half extent to the tile size (the reconstruction's contract)
    const l = length(v);
    v.mulAssign(min(1, u.maxPx.div(max(l, 1e-4))));
    return vec4(v, z.mul(0.001), isPlayer);
  })(), null, null, { type: THREE.HalfFloatType, depthBuffer: false });
  prep.renderTarget.texture.name = 'MotionBlur.prep'; // (not node.name: that becomes a WGSL identifier)

  const maxByLength = (a, b) => select(dot(b, b).greaterThan(dot(a, a)), b, a);

  // ---- tile max (two levels: 4x4 then K/4 x K/4) ----------------------------
  const tile4 = rtt(Fn(() => {
    const base = ivec2(screenCoordinate.xy.floor().mul(4));
    const lim = ivec2(u.res).sub(1);
    const m = vec2(0).toVar();
    Loop(4, 4, ({ i, j }) => {
      const p = base.add(ivec2(int(i), int(j))).min(lim);
      m.assign(maxByLength(m, prep.load(p).xy));
    });
    return vec4(m, 0, 1);
  })(), null, null, { type: THREE.HalfFloatType, depthBuffer: false, magFilter: THREE.NearestFilter, minFilter: THREE.NearestFilter });
  tile4.setResolutionScale(1 / 4);
  tile4.renderTarget.texture.name = 'MotionBlur.tile4'; // (not node.name: that becomes a WGSL identifier)

  const n = K / 4;
  const tileMax = rtt(Fn(() => {
    const base = ivec2(screenCoordinate.xy.floor().mul(n));
    const lim = ivec2(u.res.div(4).floor()).sub(1);
    const m = vec2(0).toVar();
    Loop(n, n, ({ i, j }) => {
      const p = base.add(ivec2(int(i), int(j))).min(lim);
      m.assign(maxByLength(m, tile4.load(p).xy));
    });
    return vec4(m, 0, 1);
  })(), null, null, { type: THREE.HalfFloatType, depthBuffer: false, magFilter: THREE.NearestFilter, minFilter: THREE.NearestFilter });
  tileMax.setResolutionScale(1 / K);
  tileMax.renderTarget.texture.name = 'MotionBlur.tileMax'; // (not node.name: that becomes a WGSL identifier)

  const neighbor = rtt(Fn(() => {
    const c = ivec2(screenCoordinate.xy.floor());
    const lim = ivec2(u.res.div(K).floor()).sub(1);
    const m = vec2(0).toVar();
    Loop({ start: -1, end: 2, type: 'int' }, { start: -1, end: 2, type: 'int' }, ({ i, j }) => {
      const o = ivec2(i, j);
      const p = c.add(o).max(ivec2(0)).min(lim);
      const v = tileMax.load(p).xy;
      // McGuire's diagonal test: a diagonal tile only counts if its motion
      // actually points into this tile (avoids fat blocky tile shapes)
      const diag = abs(float(i)).add(abs(float(j))).greaterThan(1.5);
      const toward = dot(normalize(vec2(float(i), float(j)).negate()), normalize(v.add(1e-5))).greaterThan(0.6);
      m.assign(select(diag.and(toward.not()), m, maxByLength(m, v)));
    });
    return vec4(m, 0, 1);
  })(), null, null, { type: THREE.HalfFloatType, depthBuffer: false, magFilter: THREE.NearestFilter, minFilter: THREE.NearestFilter });
  neighbor.setResolutionScale(1 / K);
  neighbor.renderTarget.texture.name = 'MotionBlur.neighborMax'; // (not node.name: that becomes a WGSL identifier)

  // ---- gather ------------------------------------------------------------------
  const SOFT_Z = 0.06; // relative soft-depth extent
  const cone = (d, l) => clamp(float(1).sub(d.div(max(l, 1e-3))), 0, 1);
  const cylinder = (d, l) => float(1).sub(smoothstep(l.mul(0.95), l.mul(1.05), d));
  // 1 when b is in front of a (soft, relative to depth)
  const inFront = (za, zb) => clamp(float(1).sub(zb.sub(za).div(za.mul(SOFT_Z).max(1e-5))), 0, 1);

  const gather = Fn(() => {
    const uv0 = uv();
    const res = u.res;
    const center = color.sample(uv0).toVar();
    const result = vec4(center).toVar();
    // jittered tile lookup hides the tile grid (Jimenez)
    const noise = interleavedGradientNoise(screenCoordinate.xy.add(u.frameOffset));
    const noise2 = interleavedGradientNoise(screenCoordinate.xy.add(vec2(17.0, 53.0)).add(u.frameOffset));
    const tileJ = vec2(noise, noise2).sub(0.5).mul(0.5).div(res.div(K).floor());
    const vN = neighbor.sample(uv0.add(tileJ)).xy;
    const lenN = length(vN);

    If(lenN.greaterThan(0.6), () => {
      const pc = prep.sample(uv0);
      const vC = pc.xy;
      const lenC = max(length(vC), 0.5);
      const zC = pc.z;
      const dirN = vN.div(lenN);
      // pixel's own direction for the alternate taps (fallback: the tile's)
      const dirC = select(length(pc.xy).greaterThan(0.5), pc.xy.div(lenC), dirN);
      const lenAlt = max(lenC, lenN.mul(0.5));
      // centre weight ~ 1 / own blur length (sharp pixels stay sharp)
      const wC = float(samples).div(lenC.mul(2));
      const acc = vec4(center.rgb.mul(wC), wC).toVar();
      const S = float(samples);
      Loop(samples, ({ i }) => {
        // symmetric, jittered positions in (-1, 1)
        const t = float(i).add(noise).add(0.5).div(S).mul(2).sub(1);
        const odd = fract(float(i).mul(0.5)).greaterThan(0.25);
        const d = select(odd, dirC.mul(lenAlt), dirN.mul(lenN));
        const off = d.mul(t);
        const suv = uv0.add(off.div(res));
        const ps = prep.sample(suv);
        const dist = length(off);
        const lenS = max(length(ps.xy), 0.5);
        const zS = ps.z;
        const f = inFront(zC, zS); // tap is in front of the centre
        const b = inFront(zS, zC); // tap is behind the centre
        const w = f.mul(cone(dist, lenS))
          .add(b.mul(cone(dist, lenC)))
          .add(cylinder(dist, lenS).mul(cylinder(dist, lenC)).mul(2));
        acc.addAssign(vec4(color.sample(suv).rgb.mul(w), w));
      });
      result.assign(vec4(acc.rgb.div(acc.w), center.a));
    });
    return result;
  });

  const out = convertToTexture(gather());
  out.renderTarget.texture.name = 'MotionBlur.gather'; // (not node.name: that becomes a WGSL identifier)
  return { output: out, prep, tile4, tileMax, neighbor };
}
