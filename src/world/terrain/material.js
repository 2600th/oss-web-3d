import * as THREE from 'three/webgpu';
import {
  Fn, If, Loop, vec2, vec3, vec4, float, int, texture, property, positionWorld, positionView, cameraViewMatrix,
  mix, smoothstep, clamp, max, min, abs, dot, length, normalize, sqrt, pow, step, fract, floor, sin, cos,
  dFdx, dFdy, log2, exp2, screenUV, select,
} from 'three/tsl';
import { DETAIL, SURROUND, TILE_SIZE } from './detail.js';
import { LAYERS, LAYER } from './layers.js';
import { CURV_RANGE, TILE_SLOPE, LAND } from './textures.js';
import { SNOW } from './snow.js';
import { riverSurface, riverReflection } from '../water/river.js';

// Terrain surface shading.
//
// Everything is derived per pixel from world position and the DEM-registered
// textures: there are no vertex normals or UVs, so shading is identical on
// every clipmap level and never pops when geometry morphs.
//
//   normal   DEM gradient (mipmapped) + detail-tile gradients (the same field
//            the vertices are displaced by, plus finer shading-only octaves)
//            + layer normal maps (triplanar on rock)
//   layers   scree by default; rock and strata on steep faces (triplanar,
//            height-blended); grass on valley floors beside water; gravel bars
//            on the banks; snow by altitude, aspect, curvature and slope; bare
//            glacier ice in high hollows; river water from the bank distance
//   colour   each layer's texture is normalised by its mean and multiplied by
//            a palette that drifts with large-scale noise and rock strata
//   tiling   layer textures are sampled at a scale that doubles with distance
//            (two adjacent octaves cross-faded), so the ground is as detailed
//            at 2 km as at 20 m and no single repeat is ever visible
//
// Cost control: layers that do not contribute to a pixel are skipped with real
// branches (all samples inside them use explicit gradients), so a typical pixel
// pays for the DEM textures, the detail field and one ground layer.
//
// Palette values are linear albedo.
//
// [textures] Re-graded against photos of the sector (Drass/Tololing, the
// Kargil-Leh road, Kargil town, the Shingo/Indus gorges; see
// docs/v2/evidence/polish-textures/README.md): slopes are grey-khaki to
// reddish-brown, rock is dark grey-brown (the old lavender `rockPurple` read
// as purple patches under the blue aerial perspective), and the lit ground
// is darker and more varied than the old pale tan.
const C = (r, g, b) => vec3(r, g, b);
const PAL = {
  // [terrain-2] rock and scree a little warmer and more saturated (ochre /
  // umber of the Drass and Indus walls; see polish-terrain-2/README.md)
  screeOchre: C(0.25, 0.188, 0.12),
  screeGrey: C(0.205, 0.19, 0.166),
  screeBrown: C(0.215, 0.138, 0.085),
  screePale: C(0.3, 0.268, 0.215),
  rockSlate: C(0.138, 0.122, 0.112),
  rockDark: C(0.075, 0.066, 0.06),
  rockTan: C(0.225, 0.168, 0.118),
  rockRust: C(0.245, 0.142, 0.082),
  talus: C(0.195, 0.182, 0.165),
  talusWarm: C(0.225, 0.182, 0.135),
  // [terrain-2] ground cover: silvery artemisia, olive caragana, dry cushions;
  // about half the ground's albedo, not a quarter (they read as holes)
  sage: C(0.122, 0.118, 0.082),
  caragana: C(0.064, 0.08, 0.04),
  cushionDry: C(0.13, 0.105, 0.068),
  boulder: C(0.2, 0.17, 0.135),
  boulderGrey: C(0.17, 0.163, 0.152),
  cropGreen: C(0.058, 0.098, 0.034),
  cropLush: C(0.048, 0.108, 0.032),
  cropRipe: C(0.14, 0.128, 0.058),
  fallow: C(0.165, 0.122, 0.085),
  stubble: C(0.21, 0.185, 0.115),
  fieldWall: C(0.2, 0.18, 0.15),
  poplar: C(0.036, 0.06, 0.026),
  snowFresh: C(0.78, 0.8, 0.83),
  snowFirn: C(0.58, 0.61, 0.65),
  ice: C(0.3, 0.46, 0.55),
  grassDry: C(0.2, 0.18, 0.085),
  grassGreen: C(0.068, 0.12, 0.042), // [terrain-2] was 0.07, 0.15, 0.04: lime
  gravel: C(0.225, 0.215, 0.2), // [terrain-2] was 0.26 grey: bars read white from the air
  sand: C(0.27, 0.245, 0.205),
};
const LUMA = vec3(0.2126, 0.7152, 0.0722);
/** [terrain-2] Scorch marks the material can show at once (Terrain.setScorches). */
export const SCORCH_MAX = 16;

export function buildTerrainMaterial({ DEM, tex, nodes, layers, uniforms, quality }) {
  const { tileShade, innerWeight, outerWeight, ampAt, innerUV, outerUV } = nodes;
  const mat = new THREE.MeshStandardNodeMaterial({ metalness: 0 });
  const tileScale = DEM.meta.tile.heightScale;
  mat.name = 'terrain';

  // Outputs of the surface function, read by the other material slots.
  const oRough = property('float', 'terrainRough');
  const oNormal = property('vec3', 'terrainNormal');
  const oAO = property('float', 'terrainAO');
  const oEmissive = property('vec3', 'terrainEmissive');
  const oLit = property('float', 'terrainLit');

  const surface = Fn(() => {
    const P = positionWorld;
    const p = P.xz;
    const alt = P.y;
    const dPdx = dFdx(P).toVar();
    const dPdy = dFdy(P).toVar();
    const dpx = dPdx.xz;
    const dpy = dPdy.xz;
    const dist = length(P.sub(uniforms.cam)).toVar();

    // ---------------------------------------------------------- DEM-scale inputs
    const tI = innerWeight(p).toVar();
    // [terrain-2] surf, river and ground are layers of one array texture
    const surf = texture(tex.land, innerUV(p)).depth(int(LAND.surf)).toVar();
    const riv = texture(tex.land, innerUV(p)).depth(int(LAND.river)).toVar();
    const gnd = texture(tex.land, innerUV(p)).depth(int(LAND.ground)).toVar();
    const toGrad = (rg) => {
      const n = rg.mul(2).sub(1);
      return n.div(sqrt(max(float(1).sub(dot(n, n)), 0.02))).negate();
    };
    const gDem = toGrad(surf.rg).toVar();
    const gBase = gDem.toVar();
    const skyVis = surf.b.toVar();
    const macro = tileShade(SURROUND.L1, p); // 0.9 - 7 km features: geology-scale variation
    const macroA = macro.height.toVar();

    // Beyond the measured DEM: coarse real terrain, then procedural mountains.
    If(tI.lessThan(0.999), () => {
      const tO = outerWeight(p);
      const osurf = texture(tex.outerSurf, outerUV(p)).grad(dpx.div(vec2(DEM.outerMaxX - DEM.outerMinX, DEM.outerMaxZ - DEM.outerMinZ)), dpy.div(vec2(DEM.outerMaxX - DEM.outerMinX, DEM.outerMaxZ - DEM.outerMinZ)));
      const g0 = tileShade(SURROUND.L0, p, dpx, dpy);
      const g2 = tileShade(SURROUND.L2, p, dpx, dpy);
      const gProc = g0.grad.mul(SURROUND.G0).add(macro.grad.mul(SURROUND.G1)).add(g2.grad.mul(SURROUND.G2));
      gBase.assign(mix(mix(gProc, toGrad(osurf.rg), tO), gDem, tI));
      skyVis.assign(mix(mix(float(0.82), osurf.b, tO), surf.b, tI));
    });
    const curv = surf.a.sub(0.5).mul(2 * CURV_RANGE).mul(tI).toVar(); // > 0 hollow, < 0 ridge

    // ---------------------------------------------------------- sub-DEM detail
    // [terrain-2] the amplitude comes from the vertex stage (a varying): one
    // texture binding fewer in the fragment stage
    const amp = (nodes.ampFrag ?? ampAt(p, tI)).toVar();
    const sA = tileShade(DETAIL.A, p);
    const sB = tileShade(DETAIL.B, p);
    const sM = tileShade(DETAIL.MASK, p);
    const sC = tileShade(DETAIL.C, p);
    const macroB = sM.height.toVar(); // 160 m - 1.3 km features
    const sel = smoothstep(-DETAIL.MASK_EDGE, DETAIL.MASK_EDGE, macroB);
    const ab = mix(sA.height, sB.height, sel).toVar();
    const lt = clamp(ab.sub(DETAIL.LEDGE_LO).div(DETAIL.LEDGE_HI - DETAIL.LEDGE_LO), 0, 1).toVar();
    const gate = smoothstep(DETAIL.LEDGE_GATE_LO, DETAIL.LEDGE_GATE_HI, sC.height).toVar();
    const ledge = lt.mul(lt).mul(float(3).sub(lt.mul(2))).mul(gate);
    const ledgeSlope = lt.mul(float(1).sub(lt)).mul((6 * DETAIL.LEDGE) / (DETAIL.LEDGE_HI - DETAIL.LEDGE_LO)).mul(gate);
    const hDet = ab.add(sC.height.mul(DETAIL.C_GAIN)).add(ledge.mul(DETAIL.LEDGE)).toVar(); // ~[-1, 1.5]
    const gDet = mix(sA.grad, sB.grad, sel).mul(ledgeSlope.add(1)).add(sC.grad.mul(DETAIL.C_GAIN));
    const gGeo = gBase.add(gDet.mul(amp)).toVar();
    const gFine = vec2(0).toVar();
    const hFine = float(0).toVar();
    if (quality.fineDetail) {
      const sD = tileShade(DETAIL.D, p);
      gFine.assign(sD.grad.mul(max(amp, 1.6)).mul(DETAIL.D_GAIN));
      hFine.assign(sD.height);
    }
    // Fall-line streaks: the tile sampled on the two vertical planes, stretched
    // ~8x in height, so its ridges run straight down whatever slope they are on:
    // gullies, chutes and rock ribs at the scale the DEM just misses.
    const streak = float(0).toVar();
    If(dot(gGeo, gGeo).greaterThan(0.06), () => {
      const ACROSS = 330;
      const ALONG = 2500;
      const wx = gGeo.x.mul(gGeo.x);
      const wz = gGeo.y.mul(gGeo.y);
      const inv = float(1).div(wx.add(wz));
      const sx = texture(tex.tile, vec2(P.z.div(ACROSS), P.y.div(ALONG)))
        .grad(vec2(dPdx.z.div(ACROSS), dPdx.y.div(ALONG)), vec2(dPdy.z.div(ACROSS), dPdy.y.div(ALONG)));
      const sz = texture(tex.tile, vec2(P.x.div(ACROSS).add(0.37), P.y.div(ALONG).add(0.5)))
        .grad(vec2(dPdx.x.div(ACROSS), dPdx.y.div(ALONG)), vec2(dPdy.x.div(ACROSS), dPdy.y.div(ALONG)));
      const k = smoothstep(0.06, 0.3, dot(gGeo, gGeo)).mul(tI.mul(0.6).add(0.4)).mul(mix(float(1), float(0.45), smoothstep(6000, 22000, dist)));
      const hs = (s) => s.b.mul(255 * 256 * tileScale).sub((32768 - 128) * tileScale);
      streak.assign(hs(sx).mul(wx).add(hs(sz).mul(wz)).mul(inv).mul(k));
      // slope across the fall line only (the long axis carries almost none)
      const ds = (s) => s.r.mul(2).sub(1).mul((TILE_SLOPE * TILE_SIZE) / ACROSS);
      gGeo.addAssign(vec2(ds(sz).mul(wz), ds(sx).mul(wx)).mul(inv).mul(k).mul(quality.streak));
    });
    const tanGeo = length(gGeo).toVar();
    const ny = float(1).div(sqrt(tanGeo.mul(tanGeo).add(1))).toVar();
    const nGeo = vec3(gGeo.x.negate(), 1, gGeo.y.negate()).mul(ny).toVar();
    // [terrain-2] Scaled by the local displacement amplitude: the unit detail
    // field is there everywhere, but where `amp` is ~0 (valley floors, fans)
    // the ground has none of that relief, and darkening its "hollows" drew a
    // net of bright and dark worm-like ripples over every flat valley floor.
    // The ledge contours of the field also read as lines; the C octave and
    // the ledge count less here than in the geometry.
    const cavRaw = smoothstep(-0.75, 0.4, ab.add(sC.height.mul(DETAIL.C_GAIN * 0.6)).add(ledge.mul(DETAIL.LEDGE * 0.4)).add(hFine.mul(0.4)).add(streak.mul(0.7)));
    const cavity = mix(float(0.62), cavRaw, smoothstep(0.6, 4, amp)).toVar();

    // ---------------------------------------------------------- weights
    const sdf = riv.r.mul(255 * DEM.riverStep).add(DEM.riverMin);
    // The carved bed is wider than the water: the stream braids inside it, so
    // small nallahs thin out to threads and the rest of the bed shows as gravel.
    const bed = sdf.add(float(1).sub(tI).mul(300)).toVar();
    // [water] The braid noise frays the banks but must not cut the channel.
    // Narrow nallahs used to render as a chain of pools (their bed was
    // narrower than the 29 m grid the field is sampled on; the build now
    // rasterises every channel at least 22 m half-wide). The noise fades out
    // where the field is a few metres inside the bed, so every stream keeps a
    // continuous thread.
    const braid = sC.height.mul(6).add(sA.height.mul(3.5)).mul(smoothstep(-9, -4, sdf));
    const edge = bed.add(4).add(braid).toVar();
    const water = smoothstep(0.9, -0.9, edge).toVar();

    // [textures] outcrops start a little lower (0.6 -> 0.54) and follow the
    // detail field's ribs more (0.08 -> 0.12): the photos show bedrock breaking
    // through most slopes, not only the cliffs
    const rockW = smoothstep(0.54, 0.94, tanGeo.add(hDet.mul(0.12)).add(streak.mul(0.22)).sub(curv.mul(0.5))).toVar();

    // Snow line: higher on sun-facing (south, +Z) slopes, lower in hollows,
    // blown off ridges; steep faces shed it.
    // [terrain-2] The constants live in snow.js, shared with the CPU twin
    // (siteSnow in src/assets/system.js). New: a 97 m patch layer moves the
    // line by +-SNOW.PATCH m, so it breaks up into drifts and bare islands
    // instead of following a contour.
    const snowPatch = tileShade(DETAIL.SNOW_PATCH, p).height;
    const snowLine = float(SNOW.LINE)
      .add(nGeo.z.mul(SNOW.ASPECT))
      .sub(clamp(curv, SNOW.CURV_LO, SNOW.CURV_HI).mul(SNOW.CURV))
      .add(macroB.mul(SNOW.MACRO))
      .add(hDet.mul(SNOW.DETAIL))
      .add(streak.mul(SNOW.STREAK)) // gullies hold snow, ribs shed it
      .add(snowPatch.mul(SNOW.PATCH)).toVar();
    const above = alt.sub(snowLine).toVar();
    // steep faces and the crowns of the detail field shed their cover
    const snowRaw = smoothstep(-SNOW.BAND, SNOW.BAND, above)
      .mul(float(1).sub(smoothstep(SNOW.SHED_LO, SNOW.SHED_HI, tanGeo.add(hDet.mul(SNOW.SHED_DET)))))
      .sub(smoothstep(SNOW.STEEP_LO, SNOW.STEEP_HI, tanGeo).mul(SNOW.STEEP)).toVar();
    // Bare ice: just under the snow line, in hollows on gentle ground.
    const iceW = smoothstep(-520, -120, above)
      .mul(float(1).sub(smoothstep(-60, 60, above)))
      .mul(smoothstep(0.05, 0.14, curv))
      .mul(float(1).sub(smoothstep(0.3, 0.55, tanGeo)))
      .mul(smoothstep(4300, 4600, alt)).toVar();

    const veg = riv.a.mul(tI).toVar();
    // [terrain-2] ground data (groundData.js): fans of debris under steep
    // ground, moisture along the channels, irrigated-field suitability
    const fan = gnd.g.mul(tI).toVar();
    const moist = gnd.b.mul(tI).toVar();
    const grassW = smoothstep(0.18, 0.55, max(veg, moist.mul(0.9)).add(hDet.mul(0.16)).add(macroB.mul(0.1)))
      .mul(float(1).sub(rockW)).mul(float(1).sub(water)).toVar();
    const gravelW = smoothstep(34, 2, bed).mul(float(1).sub(smoothstep(0.25, 0.5, tanGeo))).toVar();

    // ---------------------------------------------------------- layer sampling
    // Texture scale doubles with distance; two adjacent octaves are cross-faded.
    const lod = clamp(log2(max(dist.div(quality.detailNear), 1)), 0, 9).toVar();
    const oct = floor(lod).toVar();
    const octF = smoothstep(0.1, 0.9, lod.sub(oct)).toVar();
    const sc0 = exp2(oct).toVar();
    const off = (o) => fract(vec2(o.mul(0.3183).add(0.11), o.mul(0.7071).add(0.47)));
    const off0 = off(oct).toVar();
    const off1 = off(oct.add(1)).toVar();
    // Past ~6 km the layer textures only add noise: fade them to their mean.
    const texKeep = float(1).sub(smoothstep(5000, 16000, dist)).toVar();
    // Enlarged octaves keep their structure but lose contrast: pebbles scaled up
    // to boulders should not stay as bright as pebbles.
    // [textures] Less than before (0.5 / 0.4): the ground read flat and pale
    // from 100 m up (luma variation 0.08 against 0.2-0.3 in photos).
    const texContrast = texKeep.mul(mix(float(1), float(0.78), smoothstep(3, 8, lod))).toVar();
    const bumpKeep = texKeep.mul(mix(float(1), float(0.6), smoothstep(2, 7, lod))).toVar();
    const sampleLayer = (i, q, qx, qy, size) => {
      const s0 = sc0.mul(size);
      const u0 = q.div(s0).add(off0);
      const a0 = texture(layers.albedo, u0).depth(int(i)).grad(qx.div(s0), qy.div(s0));
      const n0 = texture(layers.nrm, u0).depth(int(i)).grad(qx.div(s0), qy.div(s0));
      if (!quality.octaveBlend) return { a: a0, n: n0 };
      const s1 = s0.mul(2);
      const u1 = q.div(s1).add(off1);
      const a1 = texture(layers.albedo, u1).depth(int(i)).grad(qx.div(s1), qy.div(s1));
      const n1 = texture(layers.nrm, u1).depth(int(i)).grad(qx.div(s1), qy.div(s1));
      return { a: mix(a0, a1, octF), n: mix(n0, n1, octF) };
    };
    const mean = (i) => vec3(...LAYERS[i].mean);
    /** Top-projected layer: albedo detail (mean 1), height, tangent normal xy, roughness, ao. */
    const topLayer = (i, size, bump = 1) => { // [textures] bump: per-layer normal gain
      const s = sampleLayer(i, p, dpx, dpy, size);
      const a = s.a.toVar();
      const n = s.n.toVar();
      return { d: mix(vec3(1), a.rgb.div(mean(i)), texContrast), h: a.a, n: n.rg.mul(2).sub(1).mul(bumpKeep.mul(bump)), r: n.b, ao: mix(float(1), n.a, texKeep) };
    };

    // ---------------------------------------------------------- palette
    const hue = macroA.mul(0.5).add(0.5); // 0..1 across kilometres
    const screeTint = mix(
      mix(mix(PAL.screeOchre, PAL.screeGrey, smoothstep(0.38, 0.72, hue)), PAL.screeBrown, smoothstep(0.05, -0.55, macroB)),
      PAL.screePale, smoothstep(0.25, 0.8, macroB).mul(0.55),
    );

    // ---------------------------------------------------------- ground
    const scree = topLayer(LAYER.scree, 3.6, 1.6);
    // higher ground is greyer (frost-shattered), ridges paler, hollows and gullies darker
    const relief = clamp(curv.mul(-1.3).add(streak.mul(0.16)), -0.2, 0.2).add(1).toVar();
    // [textures] hundred-metre debris patches: darker and lighter fans of scree
    // and ten-metre ones from the shading-only detail octave: the layer
    // textures average out to their mean beyond ~100 m, so without these the
    // slopes read as one flat colour
    const patch = mix(float(0.78), float(1.16), smoothstep(-0.55, 0.6, macroB.add(sC.height.mul(0.5))))
      .mul(hFine.mul(0.22).add(1)).toVar();
    const albedo = scree.d.mul(mix(screeTint, PAL.screeGrey.mul(1.06), smoothstep(3900, 4800, alt).mul(0.55))).mul(relief).mul(patch).toVar();
    // [terrain-2] fresh debris on the fans is paler and greyer than the
    // weathered, varnished slope it spills over
    albedo.assign(mix(albedo, albedo.mul(vec3(1.08, 1.1, 1.14)), fan.mul(0.8)));
    const height = scree.h.toVar();
    const tnorm = scree.n.toVar();
    const rough = scree.r.toVar();
    const lao = scree.ao.toVar();

    // [textures] Talus: angular frost-shattered blocks on the steeper scree,
    // more of it high up, patchy at the hundred-metre scale; height-blended
    // into the scree so the blocks sit on top of the gravel.
    const talusW = smoothstep(0.38, 0.72, tanGeo.mul(0.8)
      .add(fan.mul(0.42)) // [terrain-2] debris fans under the cliffs
      .add(smoothstep(3900, 4900, alt).mul(0.32))
      .add(macroB.mul(0.3)).add(hDet.mul(0.12)).sub(streak.mul(0.08)))
      .mul(float(1).sub(rockW)).toVar();
    If(talusW.greaterThan(0.004), () => {
      const L = topLayer(LAYER.talus, 2.4, 1.5);
      const w = smoothstep(0.28, 0.72, talusW.add(L.h.sub(height).mul(0.45).mul(texKeep)));
      const tint = mix(PAL.talus, PAL.talusWarm, smoothstep(0.35, 0.8, hue));
      albedo.assign(mix(albedo, L.d.mul(tint).mul(relief), w));
      height.assign(mix(height, L.h, w));
      tnorm.assign(mix(tnorm, L.n, w));
      rough.assign(mix(rough, L.r, w));
      lao.assign(mix(lao, L.ao, w));
    });

    If(grassW.greaterThan(0.004), () => {
      const L = topLayer(LAYER.grass, 3.4);
      // [terrain-2] green only where the water is: the channel margins and
      // seepage lines; the rest of the oasis mask stays dry steppe grass
      const green = max(smoothstep(0.55, 1.0, veg.add(macroB.mul(0.12))).mul(0.45), smoothstep(0.35, 0.6, moist.add(sC.height.mul(0.35)).add(hFine.mul(0.15))));
      const tint = mix(PAL.grassDry, PAL.grassGreen, green);
      albedo.assign(mix(albedo, L.d.mul(tint), grassW));
      height.assign(mix(height, L.h, grassW));
      tnorm.assign(mix(tnorm, L.n, grassW));
      rough.assign(mix(rough, L.r, grassW));
      lao.assign(mix(lao, L.ao, grassW));
    });

    If(gravelW.greaterThan(0.004), () => {
      const L = topLayer(LAYER.gravel, 3.1);
      // [terrain-2] the wet strip is wider and ragged: the river has just left it
      const wet = smoothstep(11, 0.5, edge.add(sC.height.mul(3)));
      // [textures] grey glacial cobbles: half the pebbles' colour, and less of
      // their contrast once enlarged (from the air they read as white beads)
      const gd = mix(vec3(dot(L.d, LUMA)), L.d, 0.5);
      const gdc = mix(vec3(1), gd, mix(float(1), float(0.6), smoothstep(1, 4, lod)));
      // [terrain-2] bars: silt and sand in the lee of the cobble ridges (the
      // detail field's hollows), cobbles on the crests; darker and glossy wet
      const sandy = smoothstep(0.1, -0.35, hDet.add(sA.height.mul(0.4))).mul(float(1).sub(wet)).mul(0.8);
      const gcol = mix(gdc.mul(PAL.gravel), mix(vec3(1), gdc, 0.35).mul(PAL.sand), sandy);
      albedo.assign(mix(albedo, gcol.mul(mix(float(1), float(0.5), wet)), gravelW));
      height.assign(mix(height, mix(L.h, float(0.3), sandy), gravelW));
      tnorm.assign(mix(tnorm, L.n.mul(float(1).sub(sandy.mul(0.7))), gravelW));
      rough.assign(mix(rough, mix(L.r, float(0.38), wet), gravelW));
      lao.assign(mix(lao, L.ao, gravelW));
    });

    // ---------------------------------------------------------- fields
    // [terrain-2] Irrigated village fields (barley, alfalfa, fallow): the only
    // real green in summer Ladakh away from the water. Strip plots behind low
    // stone walls, laid out along the valley (the river's flow direction at the
    // centre of each 420 m block) and grouped into villages by a 2.6 km noise:
    // hard-edged oases against the bare fan, not a green wash.
    const fieldW = float(0).toVar();
    const fieldShade = float(0).toVar();
    If(gnd.a.mul(tI).greaterThan(0.03), () => {
      const village = tileShade({ size: 2600, cos: 0.6, sin: 0.8, ox: 0.61, oz: 0.23 }, p).height;
      const fm = smoothstep(0.6, 0.72, gnd.a.add(village.mul(0.6)).add(sC.height.mul(0.08)).sub(water)).mul(float(1).sub(rockW)).toVar();
      If(fm.greaterThan(0.004), () => {
        const BLOCK = 420;
        const bc = floor(p.div(BLOCK)).add(0.5).mul(BLOCK);
        const fl = texture(tex.land, innerUV(bc)).depth(int(LAND.river)).level(4).gb.mul(2).sub(1);
        const ax = select(length(fl).greaterThan(0.15), normalize(fl), vec2(0.8, 0.6)).toVar();
        // plots are not ruled: warp the layout by a few metres (sA: a 770 m
        // octave of the detail field, so the warp is smooth across plots)
        const pw = p.add(sA.grad.mul(160)).add(vec2(sC.height, sB.height).mul(4));
        const u = dot(pw, ax);
        const v = dot(pw, vec2(ax.y.negate(), ax.x));
        const ACROSS = 17;
        const row = floor(v.div(ACROSS));
        const hr = fract(sin(row.add(floor(bc.x.div(BLOCK)).mul(31)).mul(12.9898)).mul(43758.5453));
        const ALONG = hr.mul(34).add(24);
        const uu = u.div(ALONG).add(fract(hr.mul(78.233)));
        const cell = vec2(floor(uu), row);
        const hc = fract(sin(dot(cell.add(floor(bc.div(BLOCK)).mul(17)), vec2(127.1, 311.7))).mul(43758.5453));
        const hb = fract(hc.mul(41.31));
        // summer: mostly barley and alfalfa, some ripening, a few fallow or cut
        const crop = mix(PAL.cropGreen, PAL.cropLush, smoothstep(0.3, 0.55, hc)).toVar();
        crop.assign(mix(crop, PAL.cropRipe, step(0.62, hc)));
        crop.assign(mix(crop, PAL.fallow, step(0.8, hc)));
        crop.assign(mix(crop, PAL.stubble, step(0.93, hc)));
        crop.mulAssign(hb.mul(0.3).add(0.85));
        // drill rows near the camera, and a field's own patchiness
        const pix = max(length(dpx), length(dpy));
        const rows = sin(v.mul(6.2832 / 0.9)).mul(float(1).sub(smoothstep(0.08, 0.35, pix))).mul(0.12);
        const patchy = sC.height.mul(0.5).add(hFine.mul(0.35));
        crop.mulAssign(float(1).add(rows).add(patchy.mul(0.3)));
        // walls and paths between plots, about a metre wide
        const du = float(0.5).sub(fract(uu).sub(0.5).abs()).mul(ALONG);
        const dv = float(0.5).sub(fract(v.div(ACROSS)).sub(0.5).abs()).mul(ACROSS);
        const wall = smoothstep(max(pix, 0.25).add(0.55), 0.5, min(du, dv));
        // poplar and willow rows along some of the long field edges: the dark
        // lines that mark every Ladakhi village from the air
        const treeRow = step(0.62, hr).mul(smoothstep(3.2, 1.6, dv));
        const crown = smoothstep(0.55, 0.25, fract(u.div(3.1).add(hr.mul(7))).sub(0.5).abs()).mul(treeRow);
        const trees = max(crown, treeRow.mul(smoothstep(0.6, 1.5, pix)).mul(0.55)).toVar();
        // prefilter: once a pixel spans several metres the 1 m walls and 3 m
        // tree rows alias into moire stripes (seen from 3-5 km), so they fade
        // to their mean cover; past a plot width the crops do too
        const far = smoothstep(2.5, 9, pix);
        const wallA = mix(wall, float(0.1), far);
        trees.assign(mix(trees, float(0.09), far));
        const cropMean = PAL.cropGreen.mul(0.45).add(PAL.cropLush.mul(0.2)).add(PAL.cropRipe.mul(0.18)).add(PAL.fallow.mul(0.11)).add(PAL.stubble.mul(0.06));
        crop.assign(mix(crop, cropMean.mul(float(1).add(patchy.mul(0.3))), smoothstep(12, 34, pix)));
        const col = mix(mix(crop, PAL.fieldWall, wallA.mul(0.85)), PAL.poplar, trees);
        fieldW.assign(fm);
        albedo.assign(mix(albedo, col, fm));
        rough.assign(mix(rough, float(0.85), fm));
        tnorm.assign(mix(tnorm, tnorm.mul(0.25), fm));
        lao.assign(mix(lao, mix(mix(float(0.95), float(0.75), wallA), float(0.55), trees), fm));
        // the tree rows' shadow (direct light only), on the anti-sun side
        fieldShade.assign(fm.mul(trees.mul(0.35).add(mix(treeRow.mul(smoothstep(4.5, 2, dv)), float(0.05), far).mul(0.25))));
      });
    });

    // ---------------------------------------------------------- shrubs and boulders
    // [terrain-2] Replaces the round dark scrub discs, which read as holes or
    // oil at night and from 100-500 m. Each 5 m cell holds at most one clump,
    // either:
    //  - a cushion shrub (artemisia / caragana): three lobes and a ragged rim,
    //    silvery sage to olive (greener by the water) or dry brown, about half
    //    the ground's albedo, lit on top and darker at the rim;
    //  - a boulder (on debris fans, talus, gravel bars, below outcrops): an
    //    angular block, rock-coloured, lighter on top.
    // Their cast shadow goes into the direct-light shadow (`clumpLit`, folded
    // into `terrainLit`), not into the albedo, so there are no black holes in
    // shade, under cloud or by moonlight. The ground around each base keeps a
    // soft ring of ambient occlusion. Past ~2 px a clump fades to its mean
    // cover and shadow. Density follows moisture, the oasis mask, slope and
    // altitude, clustered by a 140 m noise; fields and water have none.
    // [textures] The 2x2 cells nearest the pixel are tested, so a clump (or
    // its shadow) can reach over its cell edge (~3.7 m from the centre).
    const clumpLit = float(1).sub(fieldShade).toVar();
    const cluster = smoothstep(-0.55, 0.45, tileShade({ size: 140, cos: 0.31, sin: 0.95, ox: 0.17, oz: 0.71 }, p).height).toVar();
    const shrubD = clamp(veg.mul(0.35).add(moist.mul(0.5)).add(0.18), 0, 0.75)
      .mul(cluster.mul(0.85).add(0.15))
      .mul(float(1).sub(smoothstep(3700, 4400, alt)))
      .mul(float(1).sub(smoothstep(0.42, 0.85, tanGeo)))
      .mul(float(1).sub(water)).mul(float(1).sub(gravelW.mul(0.8))).mul(float(1).sub(rockW)).mul(float(1).sub(fieldW))
      .mul(float(1).sub(smoothstep(0.1, 0.4, snowRaw))).mul(tI).toVar();
    const rockD = clamp(fan.mul(0.55).add(talusW.mul(0.3)).add(gravelW.mul(0.22)).add(rockW.mul(0.25)), 0, 0.75)
      .mul(cluster.mul(0.6).add(0.4))
      .mul(float(1).sub(water)).mul(float(1).sub(fieldW)).mul(float(1).sub(smoothstep(0.2, 0.6, snowRaw))).mul(tI).toVar();
    If(max(shrubD, rockD).greaterThan(0.01), () => {
      const SH = 5.0;
      const pix = max(length(dpx), length(dpy)).add(0.02); // metres per pixel
      const nz = texture(tex.tile, p.div(3.1)).grad(dpx.div(3.1), dpy.div(3.1));
      const ragN = nz.r.add(nz.g).sub(1).mul(1.6);
      const pRock = rockD.div(max(shrubD.add(rockD), 1e-3)).toVar();
      const dens = max(shrubD, rockD);
      // shadow offset per metre of clump height, away from the sun
      const toShadow = uniforms.sunDir.xz.div(max(uniforms.sunDir.y, 0.1)).toVar();
      const base = floor(p.div(SH).sub(0.5));
      const disc = float(0).toVar();
      const shadow = float(0).toVar();
      const ring = float(0).toVar();
      const rel = vec2(0).toVar();
      const rad = float(1).toVar();
      const d = float(9).toVar();
      const hue2 = float(0).toVar();
      const kind = float(0).toVar();
      for (const [ox, oy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
        const cell = base.add(vec2(ox, oy));
        const h1 = fract(sin(dot(cell, vec2(127.1, 311.7))).mul(43758.5453));
        const h2 = fract(sin(dot(cell, vec2(269.5, 183.3))).mul(43758.5453));
        const h3 = fract(h1.mul(17.13).add(h2.mul(5.71)));
        const h4 = fract(h2.mul(31.77).add(h1.mul(7.31)));
        const isRock = step(h4, pRock);
        const centre = cell.add(vec2(h1, h2).mul(0.5).add(0.25)).mul(SH);
        // many small, few large
        const r = mix(mix(float(0.35), float(1.25), h3.mul(h3)), mix(float(0.35), float(1.75), h3.mul(h3).mul(h3)), isRock);
        const tall = r.mul(mix(float(0.6), float(0.75), isRock)).add(0.1);
        const q = p.sub(centre);
        // shrub: three overlapping lobes and a ragged, leafy rim
        const l1 = vec2(h3.sub(0.5), h1.sub(0.5)).mul(r).mul(1.1);
        const l2 = vec2(h2.sub(0.5), h4.sub(0.5)).mul(r).mul(-0.9);
        const dShrub = min(min(length(q), length(q.sub(l1)).mul(1.2)), length(q.sub(l2)).mul(1.35)).add(ragN.mul(r).mul(0.8));
        // boulder: a rotated, stretched hexagonal block with a less ragged edge
        const ang = h1.mul(6.2832);
        const ca = cos(ang);
        const sa = sin(ang);
        const qr = vec2(q.x.mul(ca).add(q.y.mul(sa)), q.y.mul(ca).sub(q.x.mul(sa))).mul(vec2(1, mix(float(1), float(1.6), h4)));
        const hx = max(max(abs(qr.x), abs(qr.x.mul(0.5).add(qr.y.mul(0.866)))), abs(qr.x.mul(0.5).sub(qr.y.mul(0.866))));
        const dRock = hx.mul(1.05).add(ragN.mul(r).mul(0.18));
        const dk = mix(dShrub, dRock, isRock);
        const present = step(fract(h1.mul(91.7).add(h3)), dens);
        const soft = max(pix, r.mul(mix(float(0.16), float(0.06), isRock)));
        const ck = smoothstep(r.add(soft), r.sub(soft), dk).mul(present);
        // cast shadow: the footprint swept away from the sun by the clump's
        // height (a capsule), capped so it stays inside the cells looked at
        const off = toShadow.mul(tall);
        const offL = length(off);
        const offC = off.mul(min(offL, max(float(3.6).sub(r), 0.2)).div(max(offL, 1e-3)));
        const tq = clamp(dot(q, offC.negate()).div(max(dot(offC, offC), 1e-4)), 0, 1);
        const sd = length(q.add(offC.mul(tq))).add(ragN.mul(r).mul(0.4));
        const sk = smoothstep(r.add(soft), r.mul(0.65), sd).mul(present);
        shadow.assign(max(shadow, sk));
        ring.assign(max(ring, smoothstep(r.mul(1.6).add(soft), r, dk).mul(present)));
        If(ck.greaterThan(disc), () => {
          disc.assign(ck);
          rel.assign(q);
          rad.assign(r);
          d.assign(dk);
          hue2.assign(h2);
          kind.assign(isRock);
        });
      }
      const far = smoothstep(0.35, 0.9, pix.div(rad)).toVar();
      const near = float(1).sub(far);
      // mean cover of a cell: E[pi r^2] * density / 25 m^2
      const meanCover = mix(shrubD.mul(0.05), rockD.mul(0.075), pRock).toVar();
      const cover = mix(disc, meanCover, far).toVar();
      shadow.mulAssign(float(1).sub(disc));
      const meanShadow = meanCover.mul(min(length(toShadow), 2.5).mul(0.4).add(0.3));
      clumpLit.mulAssign(float(1).sub(mix(shadow, meanShadow, far).mul(0.8)));
      const contact = ring.mul(float(1).sub(disc)).mul(near);
      // colour
      const tuft = nz.a; // the height low byte: fine, noisy
      const top = smoothstep(rad, rad.mul(0.15), d); // 1 on the crown, 0 at the rim
      const leafy = clamp(moist.mul(1.4).add(hue2.mul(0.5)).sub(0.25), 0, 1);
      const shrubCol = mix(mix(PAL.sage, PAL.caragana, leafy), PAL.cushionDry, step(0.8, hue2))
        .mul(mix(float(0.62), float(1.12), tuft.mul(0.45).add(top.mul(0.55))));
      const rockCol = mix(PAL.boulder, PAL.boulderGrey, hue2).mul(mix(float(0.7), float(1.18), top)).mul(tuft.mul(0.25).add(0.88));
      const meanCol = mix(PAL.sage.mul(0.85), PAL.boulder.mul(0.95), pRock);
      const col = mix(mix(shrubCol, rockCol, kind), meanCol, far);
      albedo.assign(mix(albedo, col, cover));
      rough.assign(mix(rough, mix(float(0.88), float(0.7), kind), cover));
      lao.assign(mix(lao, mix(float(0.62), float(1), top), cover).mul(float(1).sub(contact.mul(0.4))));
      height.assign(mix(height, float(0.9), cover));
      // a dome: the clump's own normal tilt, near the camera only
      const bump = mix(float(0.85), float(1.25), kind);
      const noiseN = vec2(nz.r, nz.g).sub(0.5).mul(mix(float(1.5), float(0.5), kind));
      tnorm.assign(mix(tnorm, vec2(rel.x, rel.y.negate()).div(rad).mul(bump).add(noiseN), disc.mul(near)));
    });

    // ---------------------------------------------------------- rock
    const rockBlend = float(0).toVar();
    const rockBend = vec3(0).toVar();
    If(rockW.greaterThan(0.004), () => {
      // Strata: bands that follow altitude, tilted and warped by large-scale noise.
      const bandCoord = alt.div(85).add(macroA.mul(2.4)).add(dot(p, vec2(0.0013, 0.0008)));
      const bandUV = vec2(bandCoord.mul(0.097), bandCoord.mul(0.013).add(0.37));
      const band = texture(tex.tile, bandUV).grad(vec2(0.0005), vec2(0.0005)).b; // 0..1
      const strata = step(0.56, band.add(macroB.mul(0.08))).toVar();
      const rockIndex = mix(float(LAYER.rock), float(LAYER.strata), strata);
      const SIZE = 7.5;
      const rgba = vec4(0).toVar();
      const rao = vec2(0).toVar();
      if (quality.triplanar) {
        const bw = pow(abs(nGeo), vec3(5)).toVar();
        const bsum = bw.x.add(bw.y).add(bw.z);
        const wx = bw.x.div(bsum).toVar();
        const wy = bw.y.div(bsum).toVar();
        const wz = bw.z.div(bsum).toVar();
        const wsum = float(0).toVar();
        const proj = (w, q, qx, qy, bendOf) => If(w.greaterThan(0.06), () => {
          const s = sampleLayer(rockIndex, q, qx, qy, SIZE);
          const n = s.n.toVar();
          rgba.addAssign(s.a.mul(w));
          rao.addAssign(n.ba.mul(w));
          rockBend.addAssign(bendOf(n.rg.mul(2).sub(1)).mul(w));
          wsum.addAssign(w);
        });
        // Each projection bends the normal within its own plane (UDN blend).
        proj(wx, vec2(P.z, P.y.negate()), vec2(dPdx.z, dPdx.y.negate()), vec2(dPdy.z, dPdy.y.negate()), (t) => vec3(0, t.y, t.x));
        proj(wy, p, dpx, dpy, (t) => vec3(t.x, 0, t.y.negate()));
        proj(wz, vec2(P.x, P.y.negate()), vec2(dPdx.x, dPdx.y.negate()), vec2(dPdy.x, dPdy.y.negate()), (t) => vec3(t.x, t.y, 0));
        rgba.divAssign(wsum);
        rao.divAssign(wsum);
        rockBend.divAssign(wsum);
      } else {
        const s = sampleLayer(rockIndex, p, dpx, dpy, SIZE);
        const n = s.n.toVar();
        rgba.assign(s.a);
        rao.assign(n.ba);
        rockBend.assign(vec3(n.r.mul(2).sub(1), 0, n.g.mul(2).sub(1).negate()));
      }
      rockBend.mulAssign(texKeep.mul(mix(float(1), float(0.7), smoothstep(1, 6, lod)))); // [textures] was 0.55
      const rockMean = mix(mean(LAYER.rock), mean(LAYER.strata), strata);
      const tint0 = mix(PAL.rockSlate, PAL.rockTan, smoothstep(0.5, 0.85, hue.add(macroB.mul(0.25))));
      const tint1 = mix(tint0, PAL.rockDark, smoothstep(0.3, 0.16, band));
      const tint = mix(tint1, PAL.rockRust, strata.mul(0.45));
      // rock takes over where its height map stands proud of the ground's
      rockBlend.assign(smoothstep(0.38, 0.62, rockW.add(rgba.a.sub(height).mul(0.35).mul(texKeep))));
      albedo.assign(mix(albedo, mix(vec3(1), rgba.rgb.div(rockMean), texContrast).mul(tint), rockBlend));
      rough.assign(mix(rough, rao.x, rockBlend));
      lao.assign(mix(lao, mix(float(1), rao.y, texKeep), rockBlend));
      height.assign(mix(height, rgba.a, rockBlend));
    });

    // dust and shade collect in the hollows of the detail field
    albedo.mulAssign(mix(float(0.64), float(1.08), cavity)); // [textures] was 0.72

    // ---------------------------------------------------------- ice and snow
    const snowW = float(0).toVar();
    const snowBend = vec2(0).toVar();
    If(iceW.greaterThan(0.004), () => {
      albedo.assign(mix(albedo, PAL.ice.mul(mix(float(0.7), float(1.15), cavity)), iceW));
      rough.assign(mix(rough, float(0.22), iceW));
    });
    If(snowRaw.greaterThan(0.004), () => {
      const L = topLayer(LAYER.snow, 3.3);
      // snow settles in the low parts of whatever is underneath first
      snowW.assign(smoothstep(SNOW.COVER_LO, SNOW.COVER_HI, snowRaw.add(float(0.5).sub(height).mul(0.3)).sub(cavity.sub(0.6).mul(0.25))));
      const firn = smoothstep(260, -40, above);
      const col = mix(PAL.snowFresh, PAL.snowFirn, firn.mul(0.8)).mul(L.d.mul(0.25).add(0.75));
      albedo.assign(mix(albedo, col, snowW));
      rough.assign(mix(rough, mix(float(0.62), L.r, 0.35), snowW));
      lao.assign(mix(lao, float(1), snowW.mul(0.7)));
      // [textures] Wind-packed sastrugi: the detail tile stretched 4x along the
      // prevailing westerly, as a normal only. The snow had no relief below the
      // DEM scale except the faint layer normal (snow_02's boot prints made a
      // stronger albedo detail a poor idea).
      const W = vec2(0.83, 0.557);
      const N = vec2(-0.557, 0.83);
      const AL = 26;
      const AC = 6.5;
      const s = texture(tex.tile, vec2(dot(p, W).div(AL), dot(p, N).div(AC)))
        .grad(vec2(dot(dpx, W).div(AL), dot(dpx, N).div(AC)), vec2(dot(dpy, W).div(AL), dot(dpy, N).div(AC)));
      const k = TILE_SLOPE * TILE_SIZE * 0.07;
      const gw = s.r.mul(2).sub(1).mul(k / AL);
      const gn = s.g.mul(2).sub(1).mul(k / AC);
      const gs = W.mul(gw).add(N.mul(gn)).mul(texKeep).mul(mix(float(1), float(0.4), smoothstep(2, 6, lod)));
      snowBend.assign(L.n.mul(0.45).add(vec2(gs.x.negate(), gs.y)));
    });

    // ---------------------------------------------------------- water
    const waterGrad = vec2(0).toVar();
    const foam = float(0).toVar();
    If(water.greaterThan(0.004), () => {
      const r = riverSurface({ p, dpx, dpy, edge, flow: riv.gb.mul(2).sub(1), flowBase: DEM.meta.riverFlow?.base ?? 0.35, tile: tex.tile, dist });
      albedo.assign(mix(albedo, r.color, water));
      rough.assign(mix(rough, r.roughness, water));
      waterGrad.assign(r.grad);
      foam.assign(r.foam);
    });
    // [water] Wet margin: the metre or two of bank the river keeps splashing and
    // that it has just left is darker and glossy (ragged with the detail field).
    const wetBand = smoothstep(2.8, 0.2, edge.add(sA.height.mul(0.8))).mul(float(1).sub(water)).mul(float(1).sub(snowW)).toVar();
    albedo.mulAssign(mix(float(1), float(0.62), wetBand));
    rough.assign(mix(rough, float(0.22), wetBand));

    // ---------------------------------------------------------- scorch marks
    // [terrain-2] Hook for burn rings at impact sites: `uniforms.scorch` holds up
    // to SCORCH_MAX (x, z, radius, strength 0..1), filled by Terrain.setScorches
    // from whatever ring buffer the VFX owner keeps. Skipped while it is empty.
    If(uniforms.scorchCount.greaterThan(0), () => {
      const burn = float(0).toVar();
      Loop(SCORCH_MAX, ({ i }) => {
        const sc = uniforms.scorch.element(i);
        const dd = length(p.sub(sc.xy)).div(max(sc.z, 0.1)).add(sC.height.mul(0.25)).add(hFine.mul(0.15));
        burn.assign(max(burn, smoothstep(1, 0.3, dd).mul(sc.w)));
      });
      albedo.mulAssign(float(1).sub(burn.mul(0.8).mul(float(1).sub(water))));
      rough.assign(mix(rough, float(0.95), burn));
    });

    // ---------------------------------------------------------- normal
    const dry = float(1).sub(water);
    // snow buries fine relief; water replaces everything below the DEM scale
    const g = mix(gGeo.add(gFine.mul(float(1).sub(snowW.mul(0.75)))), gDem.mul(0.25).add(waterGrad), water);
    const nBase = normalize(vec3(g.x.negate(), 1, g.y.negate()));
    const topBend = vec3(mix(tnorm.x, snowBend.x, snowW), 0, mix(tnorm.y, snowBend.y, snowW).negate());
    const bend = mix(topBend, rockBend, rockBlend.mul(float(1).sub(snowW))).mul(dry).mul(quality.normalStrength);
    const nWorld = normalize(nBase.add(bend)).toVar();
    oNormal.assign(nWorld);
    oRough.assign(clamp(rough, 0.05, 1));
    // sky visibility from the horizon scan, the detail field's hollows, layer AO
    const viewDir = normalize(uniforms.cam.sub(P));
    // [water] the river's AO input is its horizon specular occlusion; the walls it mirrors are added below
    const refl = riverReflection({ n: nWorld, viewDir, skyVis, foam });
    // [terrain-2] Ambient occlusion, three scales multiplied:
    //  - the pack's horizon scan (58 m - 3.7 km, `skyVis`) times the full-
    //    resolution near scan above the tangent plane (29 - 230 m, groundData.js):
    //    gully floors, the foot of each slope, valley bottoms. Squared: the
    //    measured near visibility is honest but mild (p5 0.91), and the
    //    reference photos' gullies and slope feet are darker than that in
    //    skylight;
    //  - the screen-space GTAO of the post chain within its range (half-res
    //    prepass, 400 m on high, 600 m on ultra; off on medium for the terrain,
    //    low and WebGL2), with the same same-surface test the other lit
    //    materials use (src/fx/post/ambientOcclusion.js);
    //  - the detail field's hollows and the layers' own AO.
    const nearVis = mix(float(1), gnd.r, tI.mul(uniforms.nearAO));
    const gt = uniforms.aoTex.sample(screenUV);
    const zv = positionView.z.negate();
    const sameSurf = abs(gt.g.negate().sub(zv)).lessThan(max(zv.mul(0.04), 0.2));
    const gtao = select(sameSurf, mix(float(1), gt.r, uniforms.aoStrength), float(1));
    // [textures] layer AO weight 0.6 -> 0.8 (stone crevices in scree and talus)
    const dryAO = skyVis.mul(nearVis.mul(nearVis)).mul(mix(float(0.72), float(1), cavity)).mul(mix(float(1), lao, 0.8)).mul(gtao);
    oAO.assign(mix(dryAO, refl.ao, water));

    // ---------------------------------------------------------- emissive extras
    // Snow glitter: sparse facets that flash when they line up with the sun,
    // close to the camera only. Sky reflection stand-in for water while the
    // scene has no environment map (uniforms.skyReflect is 0 once one exists).
    const half = normalize(viewDir.add(uniforms.sunDir));
    const rnd = fract(sin(dot(floor(P.mul(34)), vec3(12.9898, 78.233, 37.719))).mul(43758.5453));
    const facet = normalize(nWorld.add(vec3(rnd.sub(0.5), 0, fract(rnd.mul(57.31)).sub(0.5)).mul(0.9)));
    const glitter = pow(max(dot(facet, half), 0), 900).mul(step(0.86, rnd))
      .mul(snowW).mul(smoothstep(260, 30, dist)).mul(uniforms.sunVisible).mul(6);
    const fres = pow(float(1).sub(max(dot(nWorld, viewDir), 0)), 5).mul(0.96).add(0.04);
    const skyRefl = uniforms.skyColor.mul(fres.mul(0.5)).mul(water).mul(float(1).sub(foam)).mul(uniforms.skyReflect);
    oEmissive.assign(uniforms.sunColor.mul(glitter).add(skyRefl).add(refl.wall.mul(water))); // [water] wall reflection

    // ---------------------------------------------------------- long shadows
    // Heightfield sweep (shadowSweep.js): metres below the shadow boundary.
    // [ground polish] R16F metres (shadowConst.js); it was an 8-bit code to decode.
    const sweep = texture(uniforms.shadowTex, innerUV(p)).r;
    // [terrain-2] times the shrub and boulder shadows (direct light only), where
    // they were not painted over by rock, snow or water afterwards
    const clumpKeep = float(1).sub(rockBlend).mul(float(1).sub(snowW)).mul(dry);
    oLit.assign(mix(float(1), smoothstep(uniforms.shadowSoft, uniforms.shadowSoft.negate(), sweep), tI.mul(uniforms.shadowOn))
      .mul(mix(float(1), clumpLit, clumpKeep)));

    return vec4(albedo, 1);
  });

  mat.colorNode = surface();
  mat.roughnessNode = oRough;
  mat.metalnessNode = float(0);
  mat.normalNode = normalize(cameraViewMatrix.mul(vec4(oNormal, 0)).xyz);
  mat.aoNode = oAO;
  mat.emissiveNode = oEmissive;
  mat.terrainLit = oLit;
  return mat;
}

/**
 * Fold the terrain's own long-range shadow into the material's received shadow
 * (direct sunlight only), on top of whatever is already there. The atmosphere
 * system installs the cloud shadow with env.applyCloudShadow(material) and may
 * re-install it; Terrain.update calls this again whenever the node it finds is
 * not the one returned here.
 *
 * [shadows] The sun shadow map is now camera-fitted cascades (src/world/shadows/
 * SunShadows.js) that return 1 outside their range and fade out at its end, so
 * the old depth-range gate for the single 120 m box around the player is gone
 * (`uniforms.shadowCamPos` / `shadowRange` are no longer read). The terrain
 * does not cast into those maps; `lit` (the heightfield sweep) is its shadow.
 * The environment's own terrain-shadow term is skipped here (`terrain: false`):
 * `lit` already is that term.
 */
export function applyShadowHooks(mat, env, uniforms) { // eslint-disable-line no-unused-vars
  if (env?.applyCloudShadow) {
    if (mat.userData) delete mat.userData.cloudShadowFn; // force a fresh install to wrap
    env.applyCloudShadow(mat, { terrain: false });
  } else if (env?.cloudShadow) {
    mat.receivedShadowNode = Fn(([s]) => s.mul(env.cloudShadow(positionWorld)));
  } else {
    mat.receivedShadowNode = null;
  }
  const prev = mat.receivedShadowNode;
  const lit = mat.terrainLit;
  const wrapped = Fn(([s]) => (prev ? prev(s) : s).mul(lit));
  mat.receivedShadowNode = wrapped;
  mat.needsUpdate = true;
  return wrapped;
}
