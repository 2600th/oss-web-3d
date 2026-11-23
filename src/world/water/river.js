import * as THREE from 'three/webgpu';
import {
  vec2, vec3, float, texture, time, fract, abs, mix, smoothstep, clamp, max, min, dot, length, sqrt, pow, uniform,
} from 'three/tsl';
import { TILE_SIZE } from '../terrain/detail.js';
import { TILE_SLOPE } from '../terrain/textures.js';

// Glacial rivers, shaded as part of the terrain surface.
//
// The build tool carves a level bed into the DEM along every channel and bakes
// a distance-to-bank field and a downstream direction (tools/terrain/build-dem.mjs:
// flowx/flowz, length = fall of the bed). The terrain material calls
// `riverSurface` with those, so the water is the terrain's own surface: no
// second mesh, no sorting, no z-fighting at any LOD or distance.
//
// Look (reference: summer photographs of the Dras at Dras and near Tiger Hill,
// the Suru-Dras confluence at Kargil, the Indus below Batalik): melt-water
// carrying rock flour is opaque, pale and only faintly jade: sRGB ~(135-165,
// 150-190, 145-175), about as bright as the dry scree beside it, never
// saturated cyan. It is shaded as a rough dielectric over a scattering body
// (the flour), not as clear refracting water:
//
//   body      grey-jade "milk", paler and browner where the water is shallow
//             over the bed, with slow sediment plumes advected downstream
//   ripples   two phases of the detail tile's slope field advected along the
//             flow (flow mapping: Vlachos, "Water Flow in Portal 2", SIGGRAPH
//             2010), at three scales; calm and fast reaches are anisotropic
//             (streamwise streaks), rapids are isotropic chop
//   specular  three's GGX for the key light (sun glint by day, moon at night)
//             and the PMREM sky for reflections, F0 0.04 Schlick. Roughness
//             grows with the pixel footprint so the ripples the mips average
//             away become glitter width instead of aliasing (Toksvig 2004 /
//             LEAN mapping idea): one broad sun path at 10 km, sparkle at 50 m
//   horizon   a river in a valley reflects the valley walls, not the sky:
//             `riverReflection` turns the terrain's horizon-scan sky
//             visibility into a horizon elevation and occludes the sky
//             reflection below it (horizon specular occlusion, Jimenez et al.,
//             "Practical Real-Time Strategies for Accurate Indirect
//             Occlusion", 2016), adding the walls' own radiance instead
//   foam      whitewater where the bed steepens (rapids), broken by two
//             advected noise scales; thin foam lines along the banks

// Linear albedo of the water body (rock flour scattering), centre and shallows.
const MILK = vec3(0.118, 0.148, 0.14);
const MILK_PALE = vec3(0.15, 0.168, 0.152); // sediment-rich / shallow over the bed
const BED = vec3(0.13, 0.12, 0.1); // wet gravel seen through a few centimetres of water
const FOAM = vec3(0.78, 0.8, 0.8);

// Radiance of the valley walls the water reflects: the environment's lit-ground
// estimate (the HemisphereLight ground colour, Environment._updateLights).
// Read from the scene being rendered, so the water needs no wiring.
const hemiOf = new WeakMap();
let hemiAge = 0;
const findHemi = (scene) => {
  if (!scene) return null;
  let h = hemiOf.get(scene);
  if (h === undefined || (h === null && ++hemiAge % 120 === 0)) {
    h = null;
    scene.traverse((o) => { if (!h && o.isHemisphereLight) h = o; });
    hemiOf.set(scene, h);
  }
  return h;
};
/** Ground fill relative to the physical sky ambient (Environment.ambientFill). */
const AMBIENT_FILL = 0.25;
export const wallRadiance = uniform(new THREE.Color(0.05, 0.045, 0.04)).onRenderUpdate((frame, self) => {
  const h = findHemi(frame.scene);
  // groundColor * intensity = ground radiance * PI * fill  (see Environment._updateLights)
  if (h) self.value.copy(h.groundColor).multiplyScalar(h.intensity / (Math.PI * AMBIENT_FILL));
});

/**
 * @param p        world xz (dpx, dpy: its screen-space derivatives)
 * @param edge     metres to the bank (negative in the water), already perturbed for a ragged shoreline
 * @param flow     downstream direction, xz; its length runs from flowBase (level) to 1 (steep)
 * @param tile     the detail tile texture (its R,G slope channels are the ripple field)
 * @param dist     metres from the camera
 */
export function riverSurface({ p, dpx, dpy, edge, flow, flowBase, tile, dist }) {
  const len = length(flow);
  const dir = flow.div(max(len, 0.2));
  const perp = vec2(dir.y.negate(), dir.x);
  // 0 on a level reach, 1 where the bed falls ~9 m in 100 m
  const rapids = smoothstep(0.12, 0.8, len.sub(flowBase).div(1 - flowBase));
  const speed = float(2.4).add(rapids.mul(5.5)); // m/s

  const PERIOD = 2.6;
  const ph0 = fract(time.div(PERIOD));
  const ph1 = fract(time.div(PERIOD).add(0.5));
  const w0 = float(1).sub(abs(ph0.mul(2).sub(1)));
  // pixel footprint (m): ripples smaller than a few pixels are averaged by the mips
  const foot = max(length(dpx), length(dpy));
  // explicit gradients: this runs inside a branch of the terrain shader
  const at = (ph, scale, off, rate) => p.sub(dir.mul(speed.mul(rate)).mul(ph.sub(0.5)).mul(PERIOD)).div(scale).add(off);
  const sample = (ph, scale, off, rate = 1) => texture(tile, at(ph, scale, off, rate)).grad(dpx.div(scale), dpy.div(scale));
  // Streamwise streaks: the same field filtered over an ellipse `streak` metres
  // long down the current and a pixel wide across it (the sampler's anisotropic
  // filter does the smearing), so the surface reads combed by the flow.
  const streaked = (ph, scale, off, streak, rate = 1) => {
    const w = max(foot, 0.02);
    return texture(tile, at(ph, scale, off, rate)).grad(dir.mul(max(w, streak).div(scale)), perp.mul(w.div(scale)));
  };
  const a0 = sample(ph0, 23, vec2(0.13, 0.71));
  const a1 = sample(ph1, 23, vec2(0.57, 0.29));
  const b0 = streaked(ph0, 6.5, vec2(0.31, 0.47), 5);
  const b1 = streaked(ph1, 6.5, vec2(0.83, 0.05), 5);
  const c0 = streaked(ph0, 1.9, vec2(0.71, 0.13), 1.6, 1.2);
  const c1 = streaked(ph1, 1.9, vec2(0.05, 0.61), 1.6, 1.2);
  const big = mix(a1, a0, w0);
  const small = mix(b1, b0, w0);
  const fine = mix(c1, c0, w0);
  const slope = (s, scale, amp) => s.rg.mul(2).sub(1).mul((TILE_SLOPE * TILE_SIZE * amp) / scale);

  const fineKeep = smoothstep(0.9, 0.12, foot);
  // Ripple amplitude grows with the current.
  const chop = float(0.75).add(rapids.mul(1.1));
  const gIso = slope(big, 23, 0.16).add(slope(small, 6.5, 0.06)).add(slope(fine, 1.9, 0.02).mul(fineKeep)).mul(chop);
  // Smooth fast water: the surface is combed into streamwise ridges (slopes mostly
  // across the flow); rapids break that into isotropic chop.
  const along = dot(gIso, dir);
  const across = dot(gIso, perp);
  const aniso = float(1).sub(rapids.mul(0.85));
  const grad = dir.mul(along.mul(mix(float(1), float(0.5), aniso))).add(perp.mul(across.mul(mix(float(1), float(1.35), aniso))));

  // Slope variance lost below the pixel (the mips flatten the field): fold it
  // into roughness so the glint widens with distance instead of flickering.
  const lost = smoothstep(0.15, 1.5, foot).mul(0.012).add(smoothstep(1.5, 12, foot).mul(0.02)).mul(chop.mul(chop));

  const depth = clamp(edge.negate().div(9), 0, 1); // proxy: deeper toward the middle
  // advected noise at two scales, multiplied so foam breaks into streaks and patches
  const churn = big.b.mul(small.b).mul(4); // ~0..1.6
  // Whitewater: never a solid sheet; even a steep chute is about half foam,
  // broken by darker green-grey water in the troughs (fine scale adds the lace).
  const lace = churn.mul(0.6).add(fine.b.mul(mix(float(0.3), float(0.8), fineKeep)));
  const thr = mix(float(1.55), float(0.9), rapids);
  const foamRapid = smoothstep(thr, thr.add(0.28), lace).mul(smoothstep(0.05, 0.35, rapids));
  const foamBank = smoothstep(-1.8, -0.15, edge).mul(smoothstep(0.85, 1.15, churn)).mul(0.45);
  // Spume: thin flecks and lines of bubbles carried down from the last rapid,
  // drawn out along the current by the streaked samples.
  const fleck = smoothstep(0.72, 0.88, fine.b).mul(smoothstep(0.5, 0.75, small.b)).mul(smoothstep(0.5, 0.08, foot)).mul(rapids.mul(0.7).add(0.15));
  const foam = clamp(foamRapid.add(foamBank).add(fleck), 0, 1).mul(smoothstep(4500, 900, dist));

  // Sediment plumes: the coarse noise, stretched downstream by the advection,
  // shifts the milk between greyer and paler (±12 %).
  const plume = big.b.sub(0.5).mul(2);
  const body = mix(MILK, MILK_PALE, clamp(smoothstep(0.75, 0.1, depth).mul(0.7).add(plume.mul(0.35)).add(rapids.mul(0.3)), 0, 1))
    .mul(plume.mul(0.12).add(1));
  // The last metre or two: the bed shows through.
  const shallow = smoothstep(-2.2, -0.1, edge).mul(0.55);
  const milk = mix(body, BED, shallow);
  // Aerated water at rapids is paler before it is foam.
  const aerated = mix(milk, FOAM.mul(0.55), rapids.mul(0.3));
  const color = mix(aerated, FOAM.mul(fine.b.mul(0.3).add(0.78)), foam);

  // slicks and wind-roughened lanes alternate (glossy vs matte bands in the sky reflection)
  const rough0 = float(0.045).add(smoothstep(0.38, 0.66, big.b).mul(0.09)).add(rapids.mul(0.1));
  const roughness = mix(sqrt(rough0.mul(rough0).add(lost)), float(0.6), foam);
  return { color, roughness, grad, foam, depth, rapids };
}

/**
 * Valley-wall reflection for the water surface.
 * @param n        final world normal of the water
 * @param viewDir  unit vector from the surface toward the camera
 * @param skyVis   terrain sky visibility (cosine-weighted, horizon scan), 0..1
 * @param foam     foam cover (foam does not mirror anything)
 * @returns {{ao, wall}} ao: specular occlusion for the material's AO input
 *   (three applies AO to indirect specular); wall: reflected wall radiance to add.
 */
export function riverReflection({ n, viewDir, skyVis, foam }) {
  const ndv = clamp(dot(n, viewDir), 0, 1);
  const r = n.mul(ndv.mul(2)).sub(viewDir); // reflect(-v, n)
  const elev = clamp(r.y, -1, 1); // sine of the reflected ray's elevation
  // Uniform horizon of elevation h has cosine-weighted sky visibility cos^2(h),
  // so sin(h) = sqrt(1 - skyVis). A valley is open along its axis, which is the
  // way one usually looks along a river: use about half that horizon.
  const horizon = sqrt(clamp(float(1).sub(skyVis), 0, 1)).mul(0.55);
  const sky = smoothstep(horizon.sub(0.1), horizon.add(0.08), elev);
  const fres = pow(float(1).sub(ndv), 5).mul(0.98).add(0.02);
  const wall = wallRadiance.mul(fres).mul(float(1).sub(sky)).mul(float(1).sub(foam)).mul(0.85);
  // Water's F0 is 0.02 (ior 1.33); the standard material assumes 0.04. Scale the
  // sky reflection by the ratio of the two Schlick curves (0.5 head-on, ~1 grazing).
  const x5 = pow(float(1).sub(ndv), 5);
  const f0fix = x5.mul(0.98).add(0.02).div(x5.mul(0.96).add(0.04));
  // keep a floor: part of the reflection lobe still reaches the sky
  const ao = max(sky, 0.18).mul(f0fix);
  return { ao, wall, sky: min(sky, 1) };
}
