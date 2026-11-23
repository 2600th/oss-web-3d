import * as THREE from 'three/webgpu';
import {
  Fn, vec2, vec3, vec4, float, uniform, texture, texture3D, uv, Loop, If, Break, select, mix, clamp,
  max, min, dot, sqrt, exp, floor, fract, normalize, smoothstep, saturate, pow, length, abs,
  getViewPosition, getScreenPosition, passTexture, property, outputStruct, context, NodeUpdateType,
} from 'three/tsl';
import { generateShapeNoise, generateDetailNoise, generateCirrusNoise, perlinFbm, worley } from './noise.js';
import { generateBlueNoise } from './blueNoise.js';
import { DEM, terrainHeight } from '../terrain/heightfield.js';

/**
 * Volumetric clouds.
 *
 * Modelling and lighting follow Guerrilla's Nubis (Schneider & Vos 2015, Schneider
 * 2017): a 2D weather map (coverage, type) shapes a low-frequency Perlin-Worley
 * volume that a higher-frequency Worley volume erodes; lighting is a short cone
 * march toward the sun, Beer-Lambert with a powder term, and the octave
 * multiple-scattering approximation of Wrenninge et al. 2013 as used by Hillaire
 * (Frostbite, 2016), with a dual-lobe Henyey-Greenstein phase.
 *
 * Rendering follows the same sources and takram's three-clouds: the march runs at
 * reduced resolution, one pixel of every 2x2 block per frame (Bayer order) with
 * blue-noise ray offsets; a resolve pass reprojects the history (using the
 * cloud's own front depth), rejects it across depth discontinuities, clamps it to
 * the current neighbourhood and blends; the final composite is a depth-aware
 * (joint bilateral) upsample to full resolution.
 *
 * Passes, in order each frame:
 *   update()        weather map (amortised), sun shadow map, camera probe (1x1)
 *   node.updateBefore: march (M = H/2) -> resolve (H = full * cloudScale)
 *   composite       in PostFX via addSceneStage(clouds.stage(), 30)
 *
 * All passes are plain quads into render targets, so the same code runs on the
 * WebGL2 fallback backend.
 */

const PLANET_RADIUS = 6.36e6;
const SHAPE_TILE = 11500; // metres per repeat of the shape volume
const DETAIL_TILE = 760;
const WEATHER_EXTENT = 256000; // metres covered by the (repeating) weather map
const WEATHER_RES = 1024;
const CIRRUS_TILE = 46000;
const SHADOW_EXTENT = 110000;
const SHADOW_REF_Y = 4000; // plane the sun shadow map is parameterised on
const DILATE_TEXELS = 5;
const TOP_FRAC_MIN = 0.3;
const SUB = 2;
const BAYER = [[0, 0], [1, 1], [1, 0], [0, 1]];
const GOLDEN = 0.61803398875;

const hg = (c, g) => {
  const g2 = g * g;
  return float((1 - g2) / (4 * Math.PI)).div(pow(max(float(1 + g2).sub(c.mul(2 * g)), 1e-4), 1.5));
};

export class Clouds {
  constructor(renderer, camera, atmosphere, { steps = 64, scale = 0.5, low = false } = {}) {
    this.renderer = renderer;
    this.camera = camera;
    this.atmosphere = atmosphere;
    this.steps = steps;
    this.scale = scale;
    this.low = low;
    this.enabled = true;
    this.frame = 0;
    this.time = 0;
    this.inCloud = 0;
    this.sunVisibility = 1;
    this.wind = new THREE.Vector3(9, 0, 4); // m/s, world

    this.u = {
      camPos: uniform(new THREE.Vector3()),
      camWorld: uniform(new THREE.Matrix4()),
      projInv: uniform(new THREE.Matrix4()),
      prevView: uniform(new THREE.Matrix4()),
      prevProj: uniform(new THREE.Matrix4()),
      sunDir: uniform(new THREE.Vector3(0, 1, 0)),
      shadowSunDir: uniform(new THREE.Vector3(0, 1, 0)),
      sunE: uniform(new THREE.Vector3(4, 4, 4)),
      ambTop: uniform(new THREE.Vector3(0.3, 0.4, 0.6)),
      ambBot: uniform(new THREE.Vector3(0.2, 0.2, 0.2)),
      base: uniform(5600),
      top: uniform(9400),
      sigma: uniform(0.02), // extinction per metre at density 1
      detailStrength: uniform(0.36),
      softness: uniform(0.1),
      billow: uniform(0.45),
      covMax: uniform(0.8),
      fieldMid: uniform(0.44),
      fieldSpread: uniform(0.085),
      msAtten: uniform(0.38),
      msGain: uniform(0.6),
      coverage: uniform(0.5),
      typeBase: uniform(0.45),
      ridgeBoost: uniform(0.45),
      storm: uniform(0),
      cirrusCov: uniform(0.35),
      cirrusAlt: uniform(12500),
      sunScale: uniform(4.8),
      ambScale: uniform(1.5),
      powder: uniform(0.55),
      crease: uniform(0.62),
      deep: uniform(0.012),
      silver: uniform(0.22),
      windShape: uniform(new THREE.Vector3()),
      windDetail: uniform(new THREE.Vector3()),
      windWeather: uniform(new THREE.Vector2()),
      windCirrus: uniform(new THREE.Vector2()),
      jitter: uniform(0),
      bayer: uniform(new THREE.Vector2()),
      mSize: uniform(new THREE.Vector2(1, 1)),
      hSize: uniform(new THREE.Vector2(2, 2)),
      reset: uniform(1),
      maxDist: uniform(230000),
      stepMin: uniform(55),
      stepGrow: uniform(0.013),
      shadowCentre: uniform(new THREE.Vector2()),
      shadowStrength: uniform(0.45),
      probePos: uniform(new THREE.Vector3()),
      focusPos: uniform(new THREE.Vector3()),
      blendFresh: uniform(0.12),
      blendStale: uniform(0.02),
    };

    // --- static inputs -----------------------------------------------------
    this.shapeTarget = generateShapeNoise(renderer, low ? 64 : 128);
    this.detailTarget = generateDetailNoise(renderer, 32);
    this.cirrusTarget = generateCirrusNoise(renderer, low ? 256 : 512);
    this.ridgeTexture = makeRidgeTexture();

    const bn = generateBlueNoise(64);
    const bytes = new Uint8Array(64 * 64 * 4);
    for (let i = 0; i < bn.length; i++) { bytes[i * 4] = bn[i] * 256; bytes[i * 4 + 3] = 255; }
    this.blueTexture = new THREE.DataTexture(bytes, 64, 64, THREE.RGBAFormat, THREE.UnsignedByteType);
    this.blueTexture.wrapS = this.blueTexture.wrapT = THREE.RepeatWrapping;
    this.blueTexture.minFilter = this.blueTexture.magFilter = THREE.NearestFilter;
    this.blueTexture.needsUpdate = true;

    // --- dynamic targets ---------------------------------------------------
    const rt = (w, h, name, opts = {}) => {
      const t = new THREE.RenderTarget(w, h, { depthBuffer: false, ...opts });
      for (const tex of t.textures) {
        tex.minFilter = tex.magFilter = THREE.LinearFilter;
        tex.generateMipmaps = false;
        tex.name = name;
      }
      return t;
    };
    const wres = low ? 512 : WEATHER_RES;
    this.weatherRaw = rt(wres, wres, 'Clouds.weatherRaw');
    this.weatherTarget = rt(wres, wres, 'Clouds.weather');
    for (const t of [this.weatherRaw, this.weatherTarget]) t.texture.wrapS = t.texture.wrapT = THREE.RepeatWrapping;
    /** Radius (m) over which the weather map's alpha knows about nearby cloud tops. */
    this.skipRadius = DILATE_TEXELS * WEATHER_EXTENT / wres;
    const sres = low ? 256 : 512;
    this.shadowTarget = rt(sres, sres, 'Clouds.shadow');
    this.probeTarget = rt(1, 1, 'Clouds.probe');
    this.marchTarget = rt(1, 1, 'Clouds.march', { type: THREE.HalfFloatType, count: 2 });
    this.history = [
      rt(1, 1, 'Clouds.historyA', { type: THREE.HalfFloatType, count: 2 }),
      rt(1, 1, 'Clouds.historyB', { type: THREE.HalfFloatType, count: 2 }),
    ];
    this._write = 0;

    this._quad = new THREE.QuadMesh();
    this._weatherMaterial = this._material('Clouds.weatherRaw', this._weatherPass());
    this._dilateMaterial = this._material('Clouds.weather', this._dilatePass());
    this._shadowMaterial = this._material('Clouds.shadow', this._shadowPass());
    this._probeMaterial = this._material('Clouds.probe', this._probePass());
    this._weatherAge = 1e9;
    this._probePending = false;
    this._prevView = new THREE.Matrix4();
    this._prevProj = new THREE.Matrix4();
    this._size = new THREE.Vector2();

    /** TSL Fn(worldPos) -> sun visibility through the cloud layer (0..1). */
    this.shadowAt = this._makeShadowFn();
  }

  _material(name, fragment) {
    const m = new THREE.NodeMaterial();
    m.name = name;
    m.depthTest = false;
    m.depthWrite = false;
    m.fragmentNode = fragment;
    return m;
  }

  /* ---------------------------------------------------------------- model */

  _weatherAt(p) {
    return texture(this.weatherTarget.texture, p.xz.div(WEATHER_EXTENT).add(0.5), 0);
  }

  /** Normalised height inside the cloud column for weather sample w. */
  _heights(h, w) {
    const u = this.u;
    const hf = h.sub(u.base).div(u.top.sub(u.base));
    const topFrac = mix(float(TOP_FRAC_MIN), float(1), w.g);
    return { hf, hn: hf.div(topFrac) };
  }

  /**
   * Cloud density 0..1 at world position p with altitude h (h includes the
   * planet-curvature drop). `detail` adds the high-frequency erosion.
   */
  _density(p, h, w, detail, interiorOut = null, near = null, lod = null) {
    const u = this.u;
    const { hn } = this._heights(h, w);
    const sh = texture3D(this.shapeTarget.texture, p.mul(vec3(1 / SHAPE_TILE, 1.2 / SHAPE_TILE, 1 / SHAPE_TILE)).add(u.windShape), 0);
    // Condensation-level base: flat in the large, but not knife-cut - it sags
    // a little with the weather and is ragged at the scale of the billows.
    const lift = w.b.mul(260).add(sh.g.sub(0.45).mul(420));
    // The column narrows toward a rounded top.
    const profile = smoothstep(0, 260, h.sub(u.base).sub(lift)).mul(float(1).sub(smoothstep(0.18, 1.0, hn)));
    // Low-frequency body (Perlin-Worley, 2 %..98 % measured 0.48..0.88), then
    // carve the creases between Worley billows (0.7-1.4 km) out of it so the
    // surface reads as cauliflower rather than as a smooth blob.
    const body = saturate(sh.r.sub(0.5).div(0.36));
    const billow = saturate(sh.b.mul(0.6).add(sh.a.mul(0.4)).sub(0.28).div(0.42));
    const n = body.sub(float(1).sub(billow).mul(u.billow)).toVar();
    if (detail) {
      // High-frequency Worley displaces the surface itself (not just the rim):
      // wispy and inverted at the base, billowy toward the top (Schneider 2015).
      // `lod` (0..1) fades it to its mean where the march step is longer than
      // the features, which would otherwise alias into hatching.
      const erode = u.detailStrength.mul(0.5).toVar();
      const sample = () => {
        const dp = p.mul(1 / DETAIL_TILE).add(u.windDetail).toVar();
        const dt = texture3D(this.detailTarget.texture, dp, 0);
        const dfbm = dot(dt.rgb, vec3(0.625, 0.25, 0.125));
        const flip = saturate(hn.mul(2.5)).toVar();
        const coarse = mix(dfbm, float(1).sub(dfbm), flip).mul(u.detailStrength);
        erode.assign(lod ? mix(coarse, erode, lod) : coarse);
        if (near) {
          // Close to the camera one more, finer octave keeps the surface from
          // reading as a smooth blob (30-120 m features).
          If(near.greaterThan(0.01), () => {
            const fine = texture3D(this.detailTarget.texture, dp.mul(3.17).add(vec3(0.31, 0.57, 0.13)), 0);
            const ffbm = dot(fine.rgb, vec3(0.5, 0.3, 0.2));
            erode.addAssign(mix(ffbm, float(1).sub(ffbm), flip).sub(0.5).mul(u.detailStrength).mul(0.55).mul(near));
          });
        }
      };
      if (lod) If(lod.lessThan(0.99), sample); else sample();
      n.subAssign(erode);
    } else {
      n.subAssign(u.detailStrength.mul(0.5));
    }
    // Re-centre: measured median of the carved noise is ~0.16, spread ~0.75.
    n.assign(saturate(n.add(0.2).div(0.75)));
    const cov = w.r;
    // Coverage is the threshold the shape noise has to clear (kept below 1 so
    // the noise sculpts the cores too); the short ramp gives dense bodies with
    // a soft rim.
    const m = n.mul(profile).sub(float(1).sub(cov)).toVar();
    // Far away the rim is widened to about one march step (a prefiltered edge).
    const d = saturate(m.div(lod ? u.softness.add(lod.mul(0.28)) : u.softness));
    // How far past the threshold: ~0 at the rim and in creases, ~1 in the cores.
    if (interiorOut) interiorOut.assign(saturate(m.div(0.45)));
    // Denser toward the top and in storm cells.
    return d.mul(mix(float(0.65), float(1.15), saturate(hn))).mul(w.b.mul(u.storm).add(1));
  }

  /* --------------------------------------------------------------- passes */

  _weatherPass() {
    const u = this.u;
    const ridgeTex = this.ridgeTexture;
    return Fn(() => {
      const st = uv();
      const world = st.sub(0.5).mul(WEATHER_EXTENT);
      const ruv = clamp(world.sub(vec2(DEM.minX, DEM.minZ)).div(vec2(DEM.maxX - DEM.minX, DEM.maxZ - DEM.minZ)), 0, 1);
      const ridge = texture(ridgeTex, ruv).r.toVar();
      const p = vec3(st.add(u.windWeather), 0.5).toVar();
      const nLow = perlinFbm(p, 5, 3).toVar();
      const nMid = perlinFbm(p.add(vec3(0.37, 0.11, 0.2)), 14, 3).toVar();
      const cells = worley(p.mul(48), 48).mul(0.65).add(worley(p.mul(96), 96).mul(0.35)).toVar();
      // Convection cells, broken up by synoptic-scale noise, anchored on the ridges.
      const field = cells.mul(0.55).add(nMid.mul(0.2)).add(nLow.mul(0.25)).toVar();
      // z-score of the field (median/spread measured on the generated map), so
      // `coverage` reads as the fraction of sky that carries cloud.
      const z = field.sub(u.fieldMid).div(u.fieldSpread).add(ridge.sub(0.42).mul(u.ridgeBoost).mul(4)).toVar();
      const zThr = float(0.5).sub(u.coverage).mul(3.2);
      const cov = saturate(z.sub(zThr).div(1.1)).mul(u.covMax).toVar();
      // Cloud type = how tall the column grows: congestus over the high ground
      // and in the cores of big cells, humilis at the fringes.
      const type = saturate(u.typeBase.add(ridge.sub(0.4).mul(0.5)).add(nLow.sub(0.5).mul(1.1)).add(nMid.sub(0.5).mul(0.9)))
        .mul(mix(float(0.5), float(1), cov));
      const wet = saturate(nLow.sub(0.35).mul(2.2));
      return vec4(cov, type, wet, 1);
    })();
  }

  /**
   * Second weather pass: alpha = the highest cloud-top fraction within
   * DILATE_TEXELS of this texel (0 = no cloud nearby). The march uses it to
   * stride over empty air without stepping through clouds.
   */
  _dilatePass() {
    const raw = this.weatherRaw.texture;
    return Fn(() => {
      const st = uv();
      const texel = 1 / this.weatherRaw.width;
      const top = (s) => select(s.r.greaterThan(0.01), mix(float(TOP_FRAC_MIN), float(1), s.g), float(0));
      const c = texture(raw, st).toVar();
      const m = top(c).toVar();
      for (let ring = 1; ring <= 2; ring++) {
        const r = DILATE_TEXELS * ring / 2 * texel;
        for (let k = 0; k < 8; k++) {
          const a = (k + (ring - 1) * 0.5) / 8 * Math.PI * 2;
          m.assign(max(m, top(texture(raw, st.add(vec2(Math.cos(a) * r, Math.sin(a) * r))))));
        }
      }
      return vec4(c.rgb, m);
    })();
  }

  _shadowPass() {
    const u = this.u;
    const N = this.low ? 8 : 12;
    return Fn(() => {
      const st = uv();
      const q = st.sub(0.5).mul(SHADOW_EXTENT).add(u.shadowCentre).toVar();
      const sd = u.shadowSunDir;
      const tB = u.base.sub(SHADOW_REF_Y).div(sd.y).toVar();
      const tT = u.top.sub(SHADOW_REF_Y).div(sd.y).toVar();
      const ds = tT.sub(tB).div(N).toVar();
      const origin = vec3(q.x, SHADOW_REF_Y, q.y).toVar();
      const tau = float(0).toVar();
      Loop(N, ({ i }) => {
        const t = tB.add(float(i).add(0.5).mul(ds));
        const pos = origin.add(sd.mul(t)).toVar();
        const w = this._weatherAt(pos).toVar();
        tau.addAssign(this._density(pos, pos.y, w, false).mul(ds));
      });
      const T = exp(tau.mul(u.sigma).mul(u.shadowStrength).negate());
      return vec4(vec3(max(T, 0.06)), 1);
    })();
  }

  _makeShadowFn() {
    const u = this.u;
    const tex = this.shadowTarget.texture;
    return Fn(([p]) => {
      const sd = u.shadowSunDir;
      const q = p.xz.add(sd.xz.mul(float(SHADOW_REF_Y).sub(p.y).div(sd.y)));
      const suv = q.sub(u.shadowCentre).div(SHADOW_EXTENT).add(0.5).toVar();
      const s = texture(tex, suv, 0).r;
      const e = abs(suv.sub(0.5));
      const inside = smoothstep(0.5, 0.44, max(e.x, e.y));
      const below = float(1).sub(smoothstep(u.base, u.base.add(1500), p.y));
      return mix(float(1), s, inside.mul(below));
    });
  }

  _probePass() {
    const u = this.u;
    return Fn(() => {
      const p = u.probePos;
      const w = this._weatherAt(p).toVar();
      const d = this._density(p, p.y, w, true);
      return vec4(saturate(d.mul(3)), this.shadowAt(u.focusPos), 0, 1);
    })();
  }

  /** Per-pixel ray set-up shared by the march and the resolve. */
  _ray(st) {
    const u = this.u;
    const dirV = normalize(getViewPosition(st, float(0.5), u.projInv));
    return normalize(u.camWorld.mul(vec4(dirV, 0)).xyz);
  }

  _sceneDistance(depthNode, st, reversed) {
    const depth = depthNode.sample(st).r.toVar();
    const bg = reversed ? depth.lessThanEqual(0) : depth.greaterThanEqual(1);
    const vp = getViewPosition(st, select(bg, float(0.5), depth), this.u.projInv);
    return select(bg, float(1e9), length(vp));
  }

  _marchPass(depthNode, reversed) {
    const u = this.u;
    const atmosphere = this.atmosphere;
    const STEPS = this.steps;
    const OCTAVES = this.low ? 2 : 3;
    const LIGHT = this.low ? [90, 220, 520, 1200] : [60, 130, 280, 600, 1300];
    const colorOut = property('vec4');
    const auxOut = property('vec4');

    const fn = Fn(() => {
      const block = floor(uv().mul(u.mSize)).toVar();
      const st = block.mul(SUB).add(u.bayer).add(0.5).div(u.hSize).toVar();
      const dir = this._ray(st).toVar();
      const sceneDist = this._sceneDistance(depthNode, st, reversed).toVar();
      const cam = u.camPos;

      // Altitude along the ray on a curved planet: y + dy t + hk t^2.
      const hk = max(float(1).sub(dir.y.mul(dir.y)).div(2 * PLANET_RADIUS), 1e-11).toVar();
      const roots = (H) => {
        const c = cam.y.sub(H);
        const disc = dir.y.mul(dir.y).sub(hk.mul(c).mul(4)).toVar();
        const sq = sqrt(max(disc, 0));
        const q = dir.y.add(select(dir.y.lessThan(0), sq.negate(), sq)).mul(-0.5).toVar();
        const qs = select(q.abs().lessThan(1e-7), float(1e-7), q);
        const r1 = q.div(hk);
        const r2 = c.div(qs);
        return { valid: disc.greaterThanEqual(0), lo: min(r1, r2).toVar(), hi: max(r1, r2).toVar() };
      };
      const rB = roots(u.base);
      const rT = roots(u.top);
      const below = cam.y.lessThan(u.base);
      const above = cam.y.greaterThan(u.top);
      const BIG = float(1e9);
      const t0 = select(below, rB.hi, select(above, select(rT.valid.and(rT.lo.greaterThan(0)), rT.lo, BIG), float(0))).toVar();
      const t1 = select(below, rT.hi, select(rB.valid.and(rB.lo.greaterThan(0)), rB.lo, rT.hi)).toVar();
      const tEnd = min(min(t1, sceneDist), u.maxDist).toVar();

      const blue = fract(texture(this.blueTexture, block.add(0.5).div(64), 0).r.add(u.jitter)).toVar();
      const cosT = dot(dir, u.sunDir).toVar();
      // Octave multiple scattering (Wrenninge 2013): attenuation a, contribution b,
      // eccentricity c all halve per octave. Dual-lobe HG phase per octave.
      const phases = [];
      for (let o = 0; o < OCTAVES; o++) {
        const c = 0.5 ** o;
        phases.push(mix(hg(cosT, -0.25 * c), hg(cosT, 0.8 * c), 0.72).toVar());
      }
      // A narrow forward lobe for the silver lining when looking toward the sun.
      const silver = hg(cosT, 0.96).mul(u.silver).toVar();

      const t = t0.add(blue.mul(max(u.stepMin, t0.mul(u.stepGrow)))).toVar();
      const T = float(1).toVar();
      const S = vec3(0).toVar();
      const frontAcc = float(0).toVar();
      const wAcc = float(0).toVar();

      const wasEmpty = float(1).toVar();
      const lastAdv = float(0).toVar();
      const fineLeft = float(0).toVar();
      const fineDt = float(0).toVar();
      Loop(Math.round(STEPS * 1.75), () => {
        If(t.greaterThanEqual(tEnd).or(T.lessThan(0.012)), () => { Break(); });
        const dtBase = max(u.stepMin, t.mul(u.stepGrow)).toVar();
        const dt = select(fineLeft.greaterThan(0.5), fineDt, dtBase).toVar();
        const p = cam.add(dir.mul(t)).toVar();
        const h = p.y.add(t.mul(t).mul(hk)).toVar();
        const w = this._weatherAt(p).toVar();
        const { hf, hn } = this._heights(h, w);
        If(hf.greaterThan(w.a.add(0.03)), () => {
          // No cloud within skipRadius reaches this height: stride freely.
          const adv = max(max(dtBase.mul(2), this.skipRadius), t.mul(0.05));
          t.addAssign(adv);
          lastAdv.assign(adv);
          wasEmpty.assign(1);
          fineLeft.assign(0);
        }).ElseIf(w.r.lessThan(0.015).or(hn.greaterThan(1)).or(hf.lessThan(0)), () => {
          const adv = select(fineLeft.greaterThan(0.5), dt, dtBase.mul(1.6));
          t.addAssign(adv);
          lastAdv.assign(adv);
          wasEmpty.assign(select(fineLeft.greaterThan(0.5), wasEmpty, float(1)));
          fineLeft.assign(max(fineLeft.sub(1), 0));
        }).Else(() => {
          const interior = float(0).toVar();
          const near = float(1).sub(smoothstep(3500, 7000, t));
          const lod = saturate(dtBase.sub(90).div(200));
          const d = this._density(p, h, w, true, interior, near, lod).toVar();
          const hit = d.greaterThan(0.003);
          If(hit.and(wasEmpty.greaterThan(0.5)).and(lastAdv.greaterThan(1)), () => {
            // Just crossed into cloud from empty air: the surface lies somewhere in
            // the last stride. Back up and re-march it in quarter steps, so the
            // first hit is found to within dt/4 instead of dt (this is what turns
            // hit-or-miss speckle into a smooth edge).
            const back = min(lastAdv, dtBase.mul(2));
            t.subAssign(back);
            fineDt.assign(back.mul(0.25));
            fineLeft.assign(4);
            wasEmpty.assign(0);
            lastAdv.assign(0);
          }).ElseIf(hit, () => {
            // --- light march toward the sun ------------------------------
            const tau = float(0).toVar();
            let off = 0;
            LIGHT.forEach((len, k) => {
              const o = off + len * 0.5;
              off += len;
              const lp = p.add(u.sunDir.mul(o)).toVar();
              const lh = h.add(u.sunDir.y.mul(o));
              const lw = k < 2 ? w : this._weatherAt(lp).toVar();
              tau.addAssign(this._density(lp, lh, lw, false).mul(len));
            });
            tau.mulAssign(u.sigma);
            const sun = float(0).toVar();
            for (let o = 0; o < OCTAVES; o++) {
              sun.addAssign(phases[o].mul(exp(tau.mul(pow(u.msAtten, float(o))).negate())).mul(pow(u.msGain, float(o))));
            }
            sun.addAssign(silver.mul(exp(tau.mul(-1.4))));
            // Powder: thin, sun-facing edges scatter less back to the eye.
            const pw = float(1).sub(exp(d.mul(u.sigma).mul(-170).sub(tau.mul(1.6))));
            sun.mulAssign(mix(float(1), pw, u.powder.mul(saturate(float(0.6).sub(cosT.mul(0.5))))));
            // In-scatter probability (Schneider 2017): creases and thin rims have
            // fewer neighbours scattering light into them than convex cores.
            const hs = saturate(hn);
            const inScatter = mix(u.crease, float(1), pow(interior, 0.6)).mul(mix(float(0.55), float(1), smoothstep(0.0, 0.25, hs)));
            sun.mulAssign(mix(inScatter, float(1), saturate(cosT).mul(0.7)));
            const amb = mix(u.ambBot, u.ambTop, hs).mul(mix(float(0.55), float(1), hs)).mul(u.ambScale).mul(mix(float(0.7), float(1), interior));
            // Storm cells absorb: darker bases.
            const absorb = float(1).sub(u.storm.mul(w.b.mul(0.4).add(0.3)).mul(float(1).sub(hs.mul(0.75))));
            // Deep multiple scattering: light that has lost all direction still
            // fills the interior, more so near the top (keeps the inside of a
            // sunlit cloud bright when you fly through it).
            sun.addAssign(u.deep.mul(mix(float(0.35), float(1), hs)));
            const L = u.sunE.mul(sun).mul(u.sunScale).add(amb).mul(absorb);

            const dtc = max(min(dt, tEnd.sub(t)), 0);
            const stepT = exp(d.mul(u.sigma).mul(dtc).negate()).toVar();
            const wgt = T.mul(float(1).sub(stepT)).toVar();
            S.addAssign(L.mul(wgt));
            frontAcc.addAssign(wgt.mul(t));
            wAcc.addAssign(wgt);
            T.mulAssign(stepT);
            t.addAssign(dt);
            lastAdv.assign(dt);
            wasEmpty.assign(0);
            fineLeft.assign(max(fineLeft.sub(1), 0));
          }).Else(() => {
            t.addAssign(dt);
            lastAdv.assign(dt);
            wasEmpty.assign(select(fineLeft.greaterThan(0.5), wasEmpty, float(1)));
            fineLeft.assign(max(fineLeft.sub(1), 0));
          });
        });
      });

      // --- cirrus: a thin 2D sheet above everything -------------------------
      const rC = roots(u.cirrusAlt);
      const tC = select(cam.y.lessThan(u.cirrusAlt), rC.hi, select(rC.valid.and(rC.lo.greaterThan(0)), rC.lo, BIG)).toVar();
      If(tC.lessThan(min(sceneDist, 400000)).and(T.greaterThan(0.02)).and(u.cirrusCov.greaterThan(0.01)), () => {
        const pc = cam.xz.add(dir.xz.mul(tC)).toVar();
        // Two rotated octaves of the fibre texture break up its repeat; a much
        // larger copy masks it into patches so most of the sky stays clear.
        const a = texture(this.cirrusTarget.texture, pc.div(CIRRUS_TILE).add(u.windCirrus), 0);
        const pr = vec2(pc.x.mul(0.82).sub(pc.y.mul(0.57)), pc.x.mul(0.57).add(pc.y.mul(0.82)));
        const a2 = texture(this.cirrusTarget.texture, pr.div(CIRRUS_TILE * 0.37).add(u.windCirrus.mul(1.7)), 0);
        const b = texture(this.cirrusTarget.texture, pc.div(CIRRUS_TILE * 4.3).add(u.windCirrus.mul(0.25)).add(0.37), 0);
        const mask = saturate(b.g.sub(float(1).sub(u.cirrusCov)).div(0.3)).mul(saturate(b.r.mul(2.4).sub(0.7)));
        const fibres = smoothstep(0.4, 0.95, a.r.mul(0.7).add(a2.r.mul(0.3)));
        const far = float(1).sub(smoothstep(150000, 400000, tC));
        const alpha = saturate(fibres.mul(mask).mul(0.42)).mul(far).toVar();
        const ph = hg(cosT, 0.7).mul(2.6).add(hg(cosT, -0.1).mul(1.4));
        const col = u.sunE.mul(min(ph, 0.6)).mul(u.sunScale).mul(0.5).add(u.ambTop.mul(0.6));
        const wgt = T.mul(alpha).toVar();
        S.addAssign(col.mul(wgt));
        frontAcc.addAssign(wgt.mul(tC));
        wAcc.addAssign(wgt);
        T.mulAssign(float(1).sub(alpha));
      });

      // Aerial perspective at the cloud's own (transmittance-weighted) depth.
      // The loop stops at ~1 % transmittance; make that fully opaque so nothing
      // very bright (the sun disc) leaks through a thick cloud.
      T.assign(saturate(T.sub(0.012).div(1 - 0.012)));
      const front = select(wAcc.greaterThan(1e-4), frontAcc.div(max(wAcc, 1e-4)), min(tEnd, 60000)).toVar();
      const ap = atmosphere.apSample(st, front).toVar();
      const opacity = float(1).sub(T);
      const lit = S.mul(ap.a).add(ap.rgb.mul(atmosphere.u.sunIrradiance).mul(atmosphere.u.apStrength).mul(opacity));
      colorOut.assign(vec4(lit, T));
      auxOut.assign(vec4(front.mul(0.001), min(sceneDist, 1e6).mul(0.001), opacity, 1));
      return vec4(0);
    });
    return { fn, output: outputStruct(colorOut, auxOut) };
  }

  _resolvePass(depthNode, reversed) {
    const u = this.u;
    const colorOut = property('vec4');
    const auxOut = property('vec4');
    const mColor = texture(this.marchTarget.textures[0]);
    const mAux = texture(this.marchTarget.textures[1]);
    this._histColor = texture(this.history[1].textures[0]);
    this._histAux = texture(this.history[1].textures[1]);
    const hColor = this._histColor;
    const hAux = this._histAux;

    const fn = Fn(() => {
      const st = uv();
      const pix = floor(st.mul(u.hSize)).toVar();
      const block = floor(pix.div(SUB)).toVar();
      const sub = pix.sub(block.mul(SUB));
      const fresh = abs(sub.x.sub(u.bayer.x)).lessThan(0.5).and(abs(sub.y.sub(u.bayer.y)).lessThan(0.5));
      const uvM = block.add(0.5).div(u.mSize).toVar();
      const cur = mColor.sample(uvM).toVar();
      const curAux = mAux.sample(uvM).toVar();
      // Bilinear reconstruction of the sparse samples at this pixel.
      const uvLin = pix.sub(u.bayer).div(SUB).add(0.5).div(u.mSize);
      const curLin = mColor.sample(uvLin).toVar();

      // Neighbourhood bounds of the current samples (texel-centred 3x3, so the
      // box spans the blue-noise spread of this frame's ray offsets). The pad
      // below keeps the clamp loose: it only has to stop gross ghosting, and a
      // tight box would pull the history toward each frame's noise.
      const lo = min(cur, curLin).toVar();
      const hi = max(cur, curLin).toVar();
      const texel = vec2(1).div(u.mSize);
      for (const [ox, oy] of [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        const s = mColor.sample(uvM.add(texel.mul(vec2(ox, oy))));
        lo.assign(min(lo, s));
        hi.assign(max(hi, s));
      }

      // Reproject through the cloud's own depth.
      const dir = this._ray(st);
      const world = u.camPos.add(dir.mul(curAux.r.mul(1000)));
      const pv = u.prevView.mul(vec4(world, 1)).toVar();
      const puv = getScreenPosition(pv.xyz, u.prevProj).toVar();
      const hist = hColor.sample(puv).toVar();
      const histAux = hAux.sample(puv).toVar();
      const here = min(this._sceneDistance(depthNode, st, reversed), 1e6).mul(0.001).toVar();
      const onScreen = pv.z.lessThan(0).and(puv.x.greaterThan(0)).and(puv.x.lessThan(1)).and(puv.y.greaterThan(0)).and(puv.y.lessThan(1));
      const sameSurface = abs(histAux.g.sub(here)).lessThan(here.mul(0.12).add(0.004));
      const valid = onScreen.and(sameSurface).and(u.reset.lessThan(0.5));
      const pad = hi.sub(lo).mul(0.75).add(0.02);
      const clamped = clamp(hist, lo.sub(pad), hi.add(pad));

      const freshOut = mix(clamped, cur, select(valid, u.blendFresh, float(1)));
      const staleOut = select(valid, mix(clamped, curLin, u.blendStale), curLin);
      colorOut.assign(select(fresh, freshOut, staleOut));
      const frontNew = select(fresh, curAux.r, select(valid, mix(histAux.r, curAux.r, 0.1), curAux.r));
      const limit = select(fresh, curAux.g, select(valid, histAux.g, curAux.g));
      auxOut.assign(vec4(frontNew, limit, curAux.b, 1));
      return vec4(0);
    });
    return { fn, output: outputStruct(colorOut, auxOut) };
  }

  /* ------------------------------------------------------------ pipeline */

  /** Scene stage for PostFX: fn(color, ctx) -> color with clouds composited. */
  stage() {
    return (color, ctx) => {
      if (!this.node) this.node = new CloudsPassNode(this, ctx.depth);
      const node = this.node;
      const u = this.u;
      const reversed = ctx.renderer.reversedDepthBuffer === true;
      return Fn(() => {
        const st = uv();
        const d = min(this._sceneDistance(ctx.depth, st, reversed), 1e6).mul(0.001).toVar();
        const f = st.mul(u.hSize).sub(0.5).toVar();
        const base = floor(f).toVar();
        const w = f.sub(base).toVar();
        const acc = vec4(0).toVar();
        const wsum = float(0).toVar();
        for (const [ox, oy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
          const tuv = base.add(vec2(ox + 0.5, oy + 0.5)).div(u.hSize);
          const c = node.colorNode.sample(tuv).toVar();
          const a = node.auxNode.sample(tuv).toVar();
          const bil = (ox ? w.x : float(1).sub(w.x)).mul(oy ? w.y : float(1).sub(w.y));
          const rel = abs(a.g.sub(d)).div(max(min(a.g, d), 1e-4));
          const similar = rel.lessThan(0.1);
          // Tap marched past this pixel's surface: its cloud only counts if it
          // sits in front of the surface. Tap stopped short: nearly useless.
          const behind = a.g.greaterThan(d);
          const inFront = a.r.lessThan(d);
          const cc = select(similar.or(inFront), c, vec4(0, 0, 0, 1));
          const wd = select(similar, float(1), select(behind, float(0.2), float(0.02)));
          const wt = bil.mul(wd).add(1e-5);
          acc.addAssign(cc.mul(wt));
          wsum.addAssign(wt);
        }
        const cl = acc.div(wsum);
        return vec4(color.rgb.mul(cl.a).add(cl.rgb), color.a);
      })();
    };
  }

  _buildPassMaterials(builder, depthNode) {
    const reversed = builder.renderer.reversedDepthBuffer === true;
    const mk = (name, { fn, output }) => {
      const m = new THREE.NodeMaterial();
      m.name = name;
      m.depthTest = false;
      m.depthWrite = false;
      m.contextNode = context(builder.getSharedContext());
      m.colorNode = fn();
      m.outputNode = output;
      return m;
    };
    this._marchMaterial = mk('Clouds.march', this._marchPass(depthNode, reversed));
    this._resolveMaterial = mk('Clouds.resolve', this._resolvePass(depthNode, reversed));
  }

  /** Called by the pass node once per frame, after the scene pass has rendered. */
  renderPasses(renderer) {
    if (!this._marchMaterial) return;
    const u = this.u;
    const camera = this.camera;
    const size = renderer.getDrawingBufferSize(this._size);
    const mw = Math.max(1, Math.ceil(size.x * this.scale / SUB));
    const mh = Math.max(1, Math.ceil(size.y * this.scale / SUB));
    if (this.marchTarget.width !== mw || this.marchTarget.height !== mh) {
      this.marchTarget.setSize(mw, mh);
      this.history[0].setSize(mw * SUB, mh * SUB);
      this.history[1].setSize(mw * SUB, mh * SUB);
      u.mSize.value.set(mw, mh);
      u.hSize.value.set(mw * SUB, mh * SUB);
      u.reset.value = 1;
    }

    u.camPos.value.copy(camera.position);
    u.camWorld.value.copy(camera.matrixWorld);
    u.projInv.value.copy(camera.projectionMatrixInverse);
    u.prevView.value.copy(this._prevView);
    u.prevProj.value.copy(this._prevProj);
    const b = BAYER[this.frame % 4];
    u.bayer.value.set(b[0], b[1]);
    u.jitter.value = (this.frame * GOLDEN) % 1;

    const write = this.history[this._write];
    const read = this.history[1 - this._write];
    this._histColor.value = read.textures[0];
    this._histAux.value = read.textures[1];

    this._state = THREE.RendererUtils.resetRendererState(renderer, this._state);
    this._quad.material = this._marchMaterial;
    renderer.setRenderTarget(this.marchTarget);
    this._quad.render(renderer);
    this._quad.material = this._resolveMaterial;
    renderer.setRenderTarget(write);
    this._quad.render(renderer);
    THREE.RendererUtils.restoreRendererState(renderer, this._state);

    this.node.colorNode.value = write.textures[0];
    this.node.auxNode.value = write.textures[1];
    this._write = 1 - this._write;
    this._prevView.copy(camera.matrixWorldInverse);
    this._prevProj.copy(camera.projectionMatrix);
    u.reset.value = 0;
    this.frame++;
  }

  /* --------------------------------------------------------------- update */

  /** Per frame, before the frame is rendered: weather, shadow map, probe. */
  update(dt, camera, focus) {
    const renderer = this.renderer;
    const u = this.u;
    this.time += dt;
    const w = this.wind;
    const frac = (x) => x - Math.floor(x);
    u.windShape.value.set(frac(-w.x * this.time / SHAPE_TILE), frac(-18 * this.time / SHAPE_TILE * 0.02), frac(-w.z * this.time / SHAPE_TILE));
    u.windDetail.value.set(frac(-w.x * 1.6 * this.time / DETAIL_TILE), frac(6 * this.time / DETAIL_TILE), frac(-w.z * 1.6 * this.time / DETAIL_TILE));
    u.windWeather.value.set(frac(-w.x * 0.6 * this.time / WEATHER_EXTENT), frac(-w.z * 0.6 * this.time / WEATHER_EXTENT));
    u.windCirrus.value.set(frac(-28 * this.time / CIRRUS_TILE), frac(-9 * this.time / CIRRUS_TILE));

    // Shadow projection needs a sun that is not grazing.
    const s = u.sunDir.value;
    u.shadowSunDir.value.set(s.x, Math.max(s.y, 0.07), s.z).normalize();
    u.probePos.value.copy(camera.position);
    u.focusPos.value.copy(focus);

    this._state2 = THREE.RendererUtils.resetRendererState(renderer, this._state2);
    this._weatherAge += dt;
    if (this._weatherAge > 0.5 || this.weatherDirty) {
      this._weatherAge = 0;
      this.weatherDirty = false;
      this._quad.material = this._weatherMaterial;
      renderer.setRenderTarget(this.weatherRaw);
      this._quad.render(renderer);
      this._quad.material = this._dilateMaterial;
      renderer.setRenderTarget(this.weatherTarget);
      this._quad.render(renderer);
    }
    const texel = SHADOW_EXTENT / this.shadowTarget.width;
    u.shadowCentre.value.set(Math.round(camera.position.x / texel) * texel, Math.round(camera.position.z / texel) * texel);
    this._quad.material = this._shadowMaterial;
    renderer.setRenderTarget(this.shadowTarget);
    this._quad.render(renderer);
    this._quad.material = this._probeMaterial;
    renderer.setRenderTarget(this.probeTarget);
    this._quad.render(renderer);
    THREE.RendererUtils.restoreRendererState(renderer, this._state2);

    if (!this._probePending) {
      this._probePending = true;
      renderer.readRenderTargetPixelsAsync(this.probeTarget, 0, 0, 1, 1).then((px) => {
        this._probeDensity = px[0] / 255;
        this._probeShadow = px[1] / 255;
        this._probePending = false;
      }).catch(() => { this._probePending = false; });
    }
    const k = 1 - Math.exp(-dt * 6);
    this.inCloud += ((this._probeDensity ?? 0) - this.inCloud) * k;
    this.sunVisibility += ((this._probeShadow ?? 1) - this.sunVisibility) * k;
  }

  /** Drop the history (teleports, preset changes). */
  resetHistory() { this.u.reset.value = 1; }

  dispose() {
    for (const t of [this.shapeTarget, this.detailTarget, this.cirrusTarget, this.weatherRaw, this.weatherTarget, this.shadowTarget,
      this.probeTarget, this.marchTarget, ...this.history]) t.dispose();
    this.ridgeTexture.dispose();
    this.blueTexture.dispose();
  }
}

/**
 * Pipeline node: renders the march + resolve once per frame (after the scene
 * pass, whose depth it reads) and exposes the resolved history textures.
 */
class CloudsPassNode extends THREE.Node {
  static get type() { return 'CloudsPassNode'; }

  constructor(clouds, depthNode) {
    super('vec4');
    this.clouds = clouds;
    this.depthNode = depthNode;
    this.updateBeforeType = NodeUpdateType.FRAME;
    this.colorNode = passTexture(this, clouds.history[0].textures[0]);
    this.auxNode = passTexture(this, clouds.history[0].textures[1]);
  }

  updateBefore(frame) {
    this.clouds.renderPasses(frame.renderer);
  }

  setup(builder) {
    if (!this.clouds._marchMaterial) this.clouds._buildPassMaterials(builder, this.depthNode);
    return this.colorNode;
  }
}

/**
 * Blurred, normalised terrain height over the DEM (R8, 128^2): where the high
 * ground is, so convection can be anchored to the ridges.
 */
function makeRidgeTexture(n = 128) {
  const raw = new Float32Array(n * n);
  if (DEM.ready) {
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const x = DEM.minX + (i + 0.5) / n * (DEM.maxX - DEM.minX);
      const z = DEM.minZ + (j + 0.5) / n * (DEM.maxZ - DEM.minZ);
      raw[j * n + i] = terrainHeight(x, z);
    }
  } else raw.fill(3600);
  const blur = new Float32Array(n * n);
  const R = 3;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    let s = 0, c = 0;
    for (let y = -R; y <= R; y++) for (let x = -R; x <= R; x++) {
      const ii = Math.min(n - 1, Math.max(0, i + x));
      const jj = Math.min(n - 1, Math.max(0, j + y));
      s += raw[jj * n + ii]; c++;
    }
    blur[j * n + i] = s / c;
  }
  const bytes = new Uint8Array(n * n * 4);
  for (let k = 0; k < n * n; k++) {
    const v = Math.min(1, Math.max(0, (blur[k] - 3200) / (5300 - 3200)));
    bytes[k * 4] = v * 255; bytes[k * 4 + 3] = 255;
  }
  const t = new THREE.DataTexture(bytes, n, n, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.minFilter = t.magFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.needsUpdate = true;
  return t;
}

export { WEATHER_EXTENT, SHADOW_EXTENT };
