import * as THREE from 'three/webgpu';
import {
  Fn, If, vec2, vec3, vec4, float, int, texture, property, positionWorld, cameraViewMatrix,
  mix, smoothstep, clamp, max, min, abs, dot, length, normalize, sqrt, pow, step, fract, floor, sin,
  dFdx, dFdy, log2, exp2,
} from 'three/tsl';
import { DETAIL, SURROUND, TILE_SIZE } from './detail.js';
import { LAYERS, LAYER } from './layers.js';
import { CURV_RANGE, TILE_SLOPE } from './textures.js';
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
  screeOchre: C(0.235, 0.19, 0.135),
  screeGrey: C(0.2, 0.19, 0.172),
  screeBrown: C(0.2, 0.135, 0.09),
  screePale: C(0.3, 0.27, 0.225),
  rockSlate: C(0.13, 0.12, 0.118),
  rockDark: C(0.07, 0.066, 0.064),
  rockTan: C(0.2, 0.165, 0.13),
  rockRust: C(0.22, 0.14, 0.095),
  talus: C(0.19, 0.182, 0.172),
  talusWarm: C(0.215, 0.18, 0.14),
  shrub: C(0.05, 0.056, 0.034),
  snowFresh: C(0.78, 0.8, 0.83),
  snowFirn: C(0.58, 0.61, 0.65),
  ice: C(0.3, 0.46, 0.55),
  grassDry: C(0.2, 0.18, 0.085),
  grassGreen: C(0.07, 0.15, 0.04),
  gravel: C(0.26, 0.255, 0.245),
};
const LUMA = vec3(0.2126, 0.7152, 0.0722);

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
    const surf = texture(tex.surf, innerUV(p)).toVar();
    const riv = texture(tex.river, innerUV(p)).toVar();
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
    const amp = ampAt(p, tI).toVar();
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
    const cavity = smoothstep(-0.75, 0.4, hDet.add(hFine.mul(0.4)).add(streak.mul(0.7))).toVar();

    // ---------------------------------------------------------- weights
    const sdf = riv.r.mul(255 * DEM.riverStep).add(DEM.riverMin);
    // The carved bed is wider than the water: the stream braids inside it, so
    // small nallahs thin out to threads and the rest of the bed shows as gravel.
    const bed = sdf.add(float(1).sub(tI).mul(300)).toVar();
    const edge = bed.add(4).add(sC.height.mul(6)).add(sA.height.mul(3.5)).toVar();
    const water = smoothstep(0.9, -0.9, edge).toVar();

    // [textures] outcrops start a little lower (0.6 -> 0.54) and follow the
    // detail field's ribs more (0.08 -> 0.12): the photos show bedrock breaking
    // through most slopes, not only the cliffs
    const rockW = smoothstep(0.54, 0.94, tanGeo.add(hDet.mul(0.12)).add(streak.mul(0.22)).sub(curv.mul(0.5))).toVar();

    // Snow line: higher on sun-facing (south, +Z) slopes, lower in hollows,
    // blown off ridges; steep faces shed it.
    const snowLine = float(4760)
      .add(nGeo.z.mul(380))
      .sub(clamp(curv, -0.12, 0.2).mul(1500))
      .add(macroB.mul(230))
      .add(hDet.mul(55))
      .add(streak.mul(160)).toVar(); // gullies hold snow, ribs shed it
    const above = alt.sub(snowLine).toVar();
    // steep faces and the crowns of the detail field shed their cover
    const snowRaw = smoothstep(-90, 90, above)
      .mul(float(1).sub(smoothstep(0.8, 1.35, tanGeo.add(hDet.mul(0.22)))))
      .sub(smoothstep(0.45, 0.95, tanGeo).mul(0.3)).toVar();
    // Bare ice: just under the snow line, in hollows on gentle ground.
    const iceW = smoothstep(-520, -120, above)
      .mul(float(1).sub(smoothstep(-60, 60, above)))
      .mul(smoothstep(0.05, 0.14, curv))
      .mul(float(1).sub(smoothstep(0.3, 0.55, tanGeo)))
      .mul(smoothstep(4300, 4600, alt)).toVar();

    const veg = riv.a.mul(tI).toVar();
    const grassW = smoothstep(0.18, 0.55, veg.add(hDet.mul(0.16)).add(macroB.mul(0.1)))
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
    const height = scree.h.toVar();
    const tnorm = scree.n.toVar();
    const rough = scree.r.toVar();
    const lao = scree.ao.toVar();

    // [textures] Talus: angular frost-shattered blocks on the steeper scree,
    // more of it high up, patchy at the hundred-metre scale; height-blended
    // into the scree so the blocks sit on top of the gravel.
    const talusW = smoothstep(0.38, 0.72, tanGeo.mul(0.8)
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
      const tint = mix(PAL.grassDry, PAL.grassGreen, smoothstep(0.45, 0.95, veg.add(macroB.mul(0.12))));
      albedo.assign(mix(albedo, L.d.mul(tint), grassW));
      height.assign(mix(height, L.h, grassW));
      tnorm.assign(mix(tnorm, L.n, grassW));
      rough.assign(mix(rough, L.r, grassW));
      lao.assign(mix(lao, L.ao, grassW));
    });

    If(gravelW.greaterThan(0.004), () => {
      const L = topLayer(LAYER.gravel, 3.1);
      const wet = smoothstep(9, 0.5, edge); // damp ground by the water
      // [textures] grey glacial cobbles: half the pebbles' colour, and less of
      // their contrast once enlarged (from the air they read as white beads)
      const gd = mix(vec3(dot(L.d, LUMA)), L.d, 0.5);
      const gdc = mix(vec3(1), gd, mix(float(1), float(0.6), smoothstep(1, 4, lod)));
      albedo.assign(mix(albedo, gdc.mul(PAL.gravel).mul(mix(float(1), float(0.55), wet)), gravelW));
      height.assign(mix(height, L.h, gravelW));
      tnorm.assign(mix(tnorm, L.n, gravelW));
      rough.assign(mix(rough, mix(L.r, float(0.42), wet), gravelW));
      lao.assign(mix(lao, L.ao, gravelW));
    });

    // ---------------------------------------------------------- shrubs
    // [textures] Sparse scrub clumps (the dark dots on every lower slope in
    // the photos): one jittered disc per 5 m cell, present with a probability
    // that follows the valley vegetation and thins out with height and slope.
    // Once a clump is under ~2 px the dots fade to their mean coverage.
    const shrubDensity = clamp(veg.mul(0.8).add(0.16), 0, 0.85)
      .mul(float(1).sub(smoothstep(3500, 4250, alt)))
      .mul(float(1).sub(smoothstep(0.42, 0.8, tanGeo)))
      .mul(float(1).sub(water)).mul(float(1).sub(gravelW)).mul(float(1).sub(rockW)).mul(tI).toVar();
    If(shrubDensity.greaterThan(0.01), () => {
      const SH = 5.0;
      const cell = floor(p.div(SH));
      const h1 = fract(sin(dot(cell, vec2(127.1, 311.7))).mul(43758.5453));
      const h2 = fract(sin(dot(cell, vec2(269.5, 183.3))).mul(43758.5453));
      const h3 = fract(h1.mul(17.13).add(h2.mul(5.71)));
      const centre = cell.add(vec2(h1, h2).mul(0.6).add(0.2)).mul(SH);
      const rad = h3.mul(0.85).add(0.45); // 0.45 - 1.3 m
      const pix = max(length(dpx), length(dpy)).add(0.02); // metres per pixel
      // Two overlapping lobes per clump and a ragged edge from the detail
      // tile's slope channels, so no clump is a clean circle.
      const rel = p.sub(centre);
      const lobe = vec2(h3.sub(0.5), h1.sub(0.5)).mul(rad).mul(1.1);
      const nz = texture(tex.tile, p.div(3.1)).grad(dpx.div(3.1), dpy.div(3.1));
      const rag = nz.r.add(nz.g).sub(1).mul(rad).mul(1.6);
      const d = min(length(rel), length(rel.sub(lobe)).mul(1.25)).add(rag);
      const present = step(fract(h1.mul(91.7).add(h3)), shrubDensity);
      const soft = max(pix, rad.mul(0.18));
      const disc = smoothstep(rad.add(soft), rad.sub(soft), d).mul(present);
      const far = smoothstep(0.35, 0.9, pix.div(rad));
      // its shadow on the ground, thrown away from the sun (clumps ~0.6 m tall)
      const toShadow = uniforms.sunDir.xz.div(max(uniforms.sunDir.y, 0.25)).mul(0.6);
      const ds = length(rel.add(toShadow)).add(rag);
      const shadow = smoothstep(rad.add(soft), rad.sub(soft).mul(0.8), ds).mul(present).mul(float(1).sub(disc)).mul(float(1).sub(far));
      albedo.mulAssign(float(1).sub(shadow.mul(0.45)));
      const cover = mix(disc, shrubDensity.mul(0.06), far).toVar();
      // leafy clumps: dark gaps between the lit tufts
      const tuft = nz.a; // the height low byte: fine, noisy
      const shade = mix(float(0.7), float(1.3), h2).mul(mix(float(0.55), float(1.15), tuft.mul(0.5).add(smoothstep(0, rad, d).mul(0.5))));
      albedo.assign(mix(albedo, PAL.shrub.mul(shade), cover));
      rough.assign(mix(rough, float(0.85), cover));
      lao.assign(mix(lao, float(0.8), cover));
      // a dome: the clump's own normal tilt, near the camera only
      tnorm.assign(mix(tnorm, vec2(rel.x, rel.y.negate()).div(rad).mul(0.8).add(vec2(nz.r, nz.g).sub(0.5).mul(1.5)), disc.mul(float(1).sub(far))));
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
      snowW.assign(smoothstep(0.32, 0.68, snowRaw.add(float(0.5).sub(height).mul(0.3)).sub(cavity.sub(0.6).mul(0.25))));
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
    // [textures] layer AO weight 0.6 -> 0.8 (stone crevices in scree and talus)
    oAO.assign(mix(skyVis.mul(mix(float(0.72), float(1), cavity)).mul(mix(float(1), lao, 0.8)), refl.ao, water));

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
    const sweep = texture(uniforms.shadowTex, innerUV(p)).r.mul(255 * uniforms.shadowStep).add(uniforms.shadowMin);
    oLit.assign(mix(float(1), smoothstep(uniforms.shadowSoft, uniforms.shadowSoft.negate(), sweep), tI.mul(uniforms.shadowOn)));

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
 * The sun shadow map only covers a small box around the player. Receivers that
 * fall inside that box in the light's xy but beyond its depth range read as
 * fully shadowed (a dark square on the ground far below the aircraft), so the
 * map's result is only trusted inside the box's depth range.
 */
export function applyShadowHooks(mat, env, uniforms) {
  if (env?.applyCloudShadow) {
    if (mat.userData) delete mat.userData.cloudShadowFn; // force a fresh install to wrap
    env.applyCloudShadow(mat);
  } else if (env?.cloudShadow) {
    mat.receivedShadowNode = Fn(([s]) => s.mul(env.cloudShadow(positionWorld)));
  } else {
    mat.receivedShadowNode = null;
  }
  const prev = mat.receivedShadowNode;
  const lit = mat.terrainLit;
  const wrapped = Fn(([s]) => {
    // distance from the shadow camera along the light, in metres
    const depth = dot(uniforms.shadowCamPos.sub(positionWorld), uniforms.sunDir);
    const inBox = step(uniforms.shadowRange.x, depth).mul(step(depth, uniforms.shadowRange.y));
    const map = mix(float(1), s, inBox);
    return (prev ? prev(map) : map).mul(lit);
  });
  mat.receivedShadowNode = wrapped;
  mat.needsUpdate = true;
  return wrapped;
}
