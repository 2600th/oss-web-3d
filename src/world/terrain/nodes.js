import {
  Fn, vec2, ivec2, float, texture, textureLoad, floor, clamp, mix, smoothstep, min,
} from 'three/tsl';
import { DETAIL, SURROUND, AMP_MAX, AMP_OUTSIDE, INNER_BLEND, OUTER_BLEND, TILE_SIZE } from './detail.js';
import { TILE_SLOPE } from './textures.js';

/**
 * TSL mirror of heightfield.js. Every function here must stay in step with its
 * CPU twin: same filters, same constants (both read detail.js).
 */
export function makeTerrainNodes(DEM, tex) {
  const minXZ = vec2(DEM.minX, DEM.minZ);
  const maxXZ = vec2(DEM.maxX, DEM.maxZ);
  const cell = vec2(DEM.cellX, DEM.cellZ);
  const oMin = vec2(DEM.outerMinX, DEM.outerMinZ);
  const oMax = vec2(DEM.outerMaxX, DEM.outerMaxZ);
  const oSize = vec2(DEM.outerW - 1, DEM.outerH - 1);
  const tileScale = DEM.meta.tile.heightScale;

  /** Manual bilinear fetch of an R32F texture at grid coordinates (matches heightfield.bilinear). */
  const bilinear = (t, w, h) => Fn(([g]) => {
    const f = clamp(g, vec2(0), vec2(w - 1.0001, h - 1.0001));
    const i = floor(f);
    const k = f.sub(i);
    const ii = ivec2(i);
    const a = textureLoad(t, ii).r;
    const b = textureLoad(t, ii.add(ivec2(1, 0))).r;
    const c = textureLoad(t, ii.add(ivec2(0, 1))).r;
    const d = textureLoad(t, ii.add(ivec2(1, 1))).r;
    const top = a.add(b.sub(a).mul(k.x));
    return top.add(c.add(d.sub(c).mul(k.x)).sub(top).mul(k.y));
  });
  const innerAt = bilinear(tex.height, DEM.res, DEM.res);
  const outerAt = bilinear(tex.outer, DEM.outerW, DEM.outerH);

  /** Tile coordinates of world xz `p` for a detail.js layer. */
  const layerUV = (L, p) => vec2(
    p.x.mul(L.cos).sub(p.y.mul(L.sin)),
    p.x.mul(L.sin).add(p.y.mul(L.cos)),
  ).div(L.size).add(vec2(L.ox, L.oz));

  /** Tile height in [-1, 1], exact (level 0, both height bytes). Vertex-stage safe. */
  const tileHeight = (L, p) => {
    const s = texture(tex.tile, layerUV(L, p)).level(0);
    return s.b.mul(255 * 256).add(s.a.mul(255)).sub(32768).mul(tileScale);
  };

  /**
   * Tile height with the bilinear filter done by hand (four texel loads). The
   * sampler's 8-bit filter weights are fine for metre-scale detail but cost
   * over a metre on the surround, whose layers span kilometres of relief.
   */
  const tileHeightExact = (L, p) => {
    const f = layerUV(L, p).mul(TILE_SIZE).sub(0.5);
    const i = floor(f);
    const k = f.sub(i);
    const ii = ivec2(i);
    const at = (dx, dy) => {
      const t = textureLoad(tex.tile, ii.add(ivec2(dx, dy)).bitAnd(ivec2(TILE_SIZE - 1)));
      return t.b.mul(255 * 256).add(t.a.mul(255)).sub(32768).mul(tileScale);
    };
    const a = at(0, 0);
    const b = at(1, 0);
    const c = at(0, 1);
    const d = at(1, 1);
    const top = a.add(b.sub(a).mul(k.x));
    return top.add(c.add(d.sub(c).mul(k.x)).sub(top).mul(k.y));
  };

  /** Filtered tile sample for shading: world-space gradient of a unit-amplitude layer, and its height. */
  const tileShade = (L, p, dpx = null, dpy = null) => {
    // Explicit gradients (needed inside branches): the UV is linear in p.
    const rot = (d) => vec2(d.x.mul(L.cos).sub(d.y.mul(L.sin)), d.x.mul(L.sin).add(d.y.mul(L.cos))).div(L.size);
    const s = dpx ? texture(tex.tile, layerUV(L, p)).grad(rot(dpx), rot(dpy)) : texture(tex.tile, layerUV(L, p));
    const d = s.rg.mul(2).sub(1).mul((TILE_SLOPE * TILE_SIZE) / L.size);
    return {
      grad: vec2(d.x.mul(L.cos).add(d.y.mul(L.sin)), d.y.mul(L.cos).sub(d.x.mul(L.sin))),
      height: s.b.mul((255 * 256) * tileScale).sub((32768 - 128) * tileScale),
    };
  };

  /** Distance (m) inside the DEM rectangle / the outer rectangle. */
  const inset = (p, lo, hi) => min(min(p.x.sub(lo.x), hi.x.sub(p.x)), min(p.y.sub(lo.y), hi.y.sub(p.y)));
  const innerWeight = (p) => smoothstep(0, INNER_BLEND, inset(p, minXZ, maxXZ));
  const outerWeight = (p) => smoothstep(0, OUTER_BLEND, inset(p, oMin, oMax));

  const ampUV = (p) => p.sub(minXZ).div(cell).mul(0.5).add(0.5).div(DEM.ampRes);
  /** Sub-DEM displacement amplitude (m). */
  const ampAt = (p, tI) => mix(float(AMP_OUTSIDE), texture(tex.amp, ampUV(p)).level(0).r.mul(AMP_MAX), tI);

  /** World xz -> terrain height (m). Mirrors heightfield.terrainHeight. */
  const heightAt = Fn(([p]) => {
    const tI = innerWeight(p);
    const tO = outerWeight(p);
    const inner = innerAt(p.sub(minXZ).div(cell));
    const outer = outerAt(p.sub(oMin).div(oMax.sub(oMin)).mul(oSize));
    const proc = float(SURROUND.BASE)
      .add(tileHeightExact(SURROUND.L0, p).mul(SURROUND.G0))
      .add(tileHeightExact(SURROUND.L1, p).mul(SURROUND.G1))
      .add(tileHeightExact(SURROUND.L2, p).mul(SURROUND.G2));
    const out = proc.add(outer.sub(proc).mul(tO));
    const base = out.add(inner.sub(out).mul(tI));
    const m = smoothstep(-DETAIL.MASK_EDGE, DETAIL.MASK_EDGE, tileHeight(DETAIL.MASK, p));
    const a = tileHeight(DETAIL.A, p);
    const ab = a.add(tileHeight(DETAIL.B, p).sub(a).mul(m));
    const c = tileHeight(DETAIL.C, p);
    const det = ab.add(c.mul(DETAIL.C_GAIN))
      .add(smoothstep(DETAIL.LEDGE_LO, DETAIL.LEDGE_HI, ab).mul(smoothstep(DETAIL.LEDGE_GATE_LO, DETAIL.LEDGE_GATE_HI, c)).mul(DETAIL.LEDGE));
    return base.add(ampAt(p, tI).mul(det));
  });

  /** UV into the DEM-registered textures (surf, river, shadow). */
  const innerUV = (p) => p.sub(minXZ).div(cell).add(0.5).div(DEM.res);
  const outerUV = (p) => p.sub(oMin).div(oMax.sub(oMin)).mul(oSize).add(0.5).div(vec2(DEM.outerW, DEM.outerH));

  return { heightAt, innerWeight, outerWeight, ampAt, tileShade, tileHeight, layerUV, innerUV, outerUV };
}
