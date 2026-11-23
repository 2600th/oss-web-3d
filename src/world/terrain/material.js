import * as THREE from 'three/webgpu';
import {
  Fn, If, vec2, vec3, vec4, float, int, texture, property, positionWorld, cameraViewMatrix,
  mix, smoothstep, clamp, max, abs, dot, length, normalize, sqrt, pow, step, fract, floor, sin,
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
const C = (r, g, b) => vec3(r, g, b);
const PAL = {
  screeOchre: C(0.275, 0.21, 0.135),
  screeGrey: C(0.235, 0.22, 0.195),
  screeBrown: C(0.2, 0.14, 0.088),
  screePale: C(0.35, 0.305, 0.235),
  rockPurple: C(0.19, 0.16, 0.18),
  rockDark: C(0.095, 0.088, 0.092),
  rockTan: C(0.27, 0.215, 0.155),
  rockRust: C(0.24, 0.15, 0.1),
  snowFresh: C(0.78, 0.8, 0.83),
  snowFirn: C(0.58, 0.61, 0.65),
  ice: C(0.3, 0.46, 0.55),
  grassDry: C(0.21, 0.185, 0.08),
  grassGreen: C(0.075, 0.15, 0.04),
  gravel: C(0.31, 0.3, 0.28),
};

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

    const rockW = smoothstep(0.6, 0.98, tanGeo.add(hDet.mul(0.08)).add(streak.mul(0.22)).sub(curv.mul(0.5))).toVar();

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
    const texContrast = texKeep.mul(mix(float(1), float(0.5), smoothstep(2, 7, lod))).toVar();
    const bumpKeep = texKeep.mul(mix(float(1), float(0.4), smoothstep(1, 6, lod))).toVar();
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
    const topLayer = (i, size) => {
      const s = sampleLayer(i, p, dpx, dpy, size);
      const a = s.a.toVar();
      const n = s.n.toVar();
      return { d: mix(vec3(1), a.rgb.div(mean(i)), texContrast), h: a.a, n: n.rg.mul(2).sub(1).mul(bumpKeep), r: n.b, ao: mix(float(1), n.a, texKeep) };
    };

    // ---------------------------------------------------------- palette
    const hue = macroA.mul(0.5).add(0.5); // 0..1 across kilometres
    const screeTint = mix(
      mix(mix(PAL.screeOchre, PAL.screeGrey, smoothstep(0.38, 0.72, hue)), PAL.screeBrown, smoothstep(0.05, -0.55, macroB)),
      PAL.screePale, smoothstep(0.25, 0.8, macroB).mul(0.55),
    );

    // ---------------------------------------------------------- ground
    const scree = topLayer(LAYER.scree, 5.2);
    // higher ground is greyer (frost-shattered), ridges paler, hollows and gullies darker
    const relief = clamp(curv.mul(-1.3).add(streak.mul(0.16)), -0.2, 0.2).add(1);
    const albedo = scree.d.mul(mix(screeTint, PAL.screeGrey.mul(1.06), smoothstep(3900, 4800, alt).mul(0.55))).mul(relief).toVar();
    const height = scree.h.toVar();
    const tnorm = scree.n.toVar();
    const rough = scree.r.toVar();
    const lao = scree.ao.toVar();

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
      albedo.assign(mix(albedo, L.d.mul(PAL.gravel).mul(mix(float(1), float(0.55), wet)), gravelW));
      height.assign(mix(height, L.h, gravelW));
      tnorm.assign(mix(tnorm, L.n, gravelW));
      rough.assign(mix(rough, mix(L.r, float(0.42), wet), gravelW));
      lao.assign(mix(lao, L.ao, gravelW));
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
      rockBend.mulAssign(texKeep.mul(mix(float(1), float(0.55), smoothstep(1, 6, lod))));
      const rockMean = mix(mean(LAYER.rock), mean(LAYER.strata), strata);
      const tint0 = mix(PAL.rockPurple, PAL.rockTan, smoothstep(0.5, 0.85, hue.add(macroB.mul(0.25))));
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
    albedo.mulAssign(mix(float(0.72), float(1.07), cavity));

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
      snowBend.assign(L.n.mul(0.5));
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
    oAO.assign(mix(skyVis.mul(mix(float(0.72), float(1), cavity)).mul(mix(float(1), lao, 0.6)), refl.ao, water));

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
