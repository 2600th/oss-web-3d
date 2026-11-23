import * as THREE from 'three/webgpu';
import {
  Fn, vec2, vec3, vec4, float, uniform, texture, uv, Loop, If, select, mix, clamp, max, min,
  dot, sqrt, exp, acos, cos, sin, floor, fract, normalize, smoothstep, saturate, pow, length,
  positionLocal, getViewPosition,
} from 'three/tsl';
import {
  DEFAULT_ATMOSPHERE, T_LUT_W, T_LUT_H, MS_LUT_SIZE, buildTransmittanceLut, buildMultiScatterLut,
  sampleTransmittance, skyAmbient, toHalfArray,
} from './model.js';

/**
 * GPU side of the physical atmosphere (Hillaire 2020).
 *
 *   transmittance + multi-scatter LUTs   CPU (model.js), uploaded once per haze change
 *   sky-view LUT   192x108, per frame    lat-long around the camera, horizon-warped
 *   aerial-perspective atlas, per frame  32x32 froxels x 32 distance slices, laid
 *                                        out as an 8x4 tile atlas (a plain 2D render
 *                                        target, so the WebGL2 backend runs it too)
 *
 * Everything is stored per unit solar irradiance; `sunIrradiance` (renderer
 * units) scales it at the point of use, so the sun DirectionalLight, sky,
 * haze and clouds stay in one consistent photometric scale.
 *
 * The world is flat (metres, y = altitude ASL); the atmosphere treats the camera
 * as standing at radius Rg + y on the planet's "north pole" with +Y the zenith.
 */

const SKY_W = 192;
const SKY_H = 108;
const AP_TILE = 32;
const AP_TILES_X = 8;
const AP_TILES_Y = 4;
const AP_SLICES = AP_TILES_X * AP_TILES_Y;
const SUN_ANGULAR_RADIUS = 0.0062; // rad; a little larger than the real 0.00465 so the disc survives low-res

const texCoord = (x, n) => x.mul(1 - 1 / n).add(0.5 / n);

export class Atmosphere {
  constructor(renderer, camera, params = {}) {
    this.renderer = renderer;
    this.camera = camera;
    this.params = { ...DEFAULT_ATMOSPHERE, ...params };

    this.u = {
      sunDir: uniform(new THREE.Vector3(0.5, 0.7, 0.5).normalize()),
      /** Solar irradiance at the top of the atmosphere, renderer units. */
      sunIrradiance: uniform(new THREE.Vector3(4.6, 4.6, 4.6)),
      cameraKm: uniform(4), // altitude ASL, km
      cameraPos: uniform(new THREE.Vector3()),
      cameraWorld: uniform(new THREE.Matrix4()),
      projInv: uniform(new THREE.Matrix4()),
      haze: uniform(this.params.haze),
      apMaxDist: uniform(160000), // metres covered by the aerial-perspective slices
      sunDiscGain: uniform(260),
      /** Extra artistic gain on in-scattering (1 = physical). */
      apStrength: uniform(1),
    };

    const mk = (w, h) => {
      const t = new THREE.DataTexture(new Uint16Array(w * h * 4), w, h, THREE.RGBAFormat, THREE.HalfFloatType);
      t.minFilter = t.magFilter = THREE.LinearFilter;
      t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
      t.generateMipmaps = false;
      t.colorSpace = THREE.NoColorSpace;
      return t;
    };
    this.transmittanceTexture = mk(T_LUT_W, T_LUT_H);
    this.multiScatterTexture = mk(MS_LUT_SIZE, MS_LUT_SIZE);
    this.rebuildLuts();

    const rt = (w, h, name) => {
      const t = new THREE.RenderTarget(w, h, { depthBuffer: false, type: THREE.HalfFloatType });
      t.texture.minFilter = t.texture.magFilter = THREE.LinearFilter;
      t.texture.generateMipmaps = false;
      t.texture.name = name;
      return t;
    };
    this.skyViewTarget = rt(SKY_W, SKY_H, 'Atmosphere.skyView');
    this.apTarget = rt(AP_TILE * AP_TILES_X, AP_TILE * AP_TILES_Y, 'Atmosphere.aerial');

    /** Optional TSL Fn(worldPos) -> float sun visibility, marched into the froxels (light shafts). */
    this.shadowFn = null;

    this._quad = new THREE.QuadMesh();
    this._skyViewMaterial = new THREE.NodeMaterial();
    this._skyViewMaterial.name = 'Atmosphere.skyView';
    this._skyViewMaterial.fragmentNode = this._skyViewPass();
    this._apMaterial = new THREE.NodeMaterial();
    this._apMaterial.name = 'Atmosphere.aerial';
    this._apMaterial.fragmentNode = this._aerialPass();

    this.apSample = this._makeApSample();
  }

  /* ------------------------------------------------------------------ CPU */

  rebuildLuts() {
    const a = this.params;
    this.tLut = buildTransmittanceLut(a);
    this.msLut = buildMultiScatterLut(a, this.tLut);
    this.transmittanceTexture.image.data.set(toHalfArray(this.tLut));
    this.multiScatterTexture.image.data.set(toHalfArray(this.msLut));
    this.transmittanceTexture.needsUpdate = true;
    this.multiScatterTexture.needsUpdate = true;
    this.u.haze.value = a.haze;
  }

  setHaze(haze) {
    if (Math.abs(haze - this.params.haze) < 1e-4) return;
    this.params.haze = haze;
    this.rebuildLuts();
  }

  /** Direct solar irradiance (renderer units, RGB array) at altitude y metres. */
  sunIrradianceAt(yMetres, out = [0, 0, 0]) {
    const a = this.params;
    const s = this.u.sunDir.value;
    sampleTransmittance(a, this.tLut, a.Rg + Math.max(yMetres, 0) / 1000, s.y, out);
    const e = this.u.sunIrradiance.value;
    out[0] *= e.x; out[1] *= e.y; out[2] *= e.z;
    return out;
  }

  /** Sky irradiance / zenith / horizon colours (renderer units) at altitude y metres. */
  ambientAt(yMetres) {
    const s = this.u.sunDir.value;
    const amb = skyAmbient(this.params, this.tLut, this.msLut, Math.max(yMetres, 10) / 1000, [s.x, s.y, s.z]);
    const e = this.u.sunIrradiance.value;
    for (const k of ['irradiance', 'zenith', 'horizon']) {
      amb[k][0] *= e.x; amb[k][1] *= e.y; amb[k][2] *= e.z;
    }
    return amb;
  }

  /* ------------------------------------------------------------- TSL core */

  _nodes() {
    if (this._n) return this._n;
    const a = this.params;
    const tTex = this.transmittanceTexture;
    const msTex = this.multiScatterTexture;
    const Rg = a.Rg, Rt = a.Rt;
    const H = Math.sqrt(Rt * Rt - Rg * Rg);
    const haze = this.u.haze;

    const horizonMu = (r) => sqrt(max(float(1).sub(float(Rg * Rg).div(r.mul(r))), 0)).negate();

    const transmittanceUv = (r, mu) => {
      const rho = sqrt(max(r.mul(r).sub(Rg * Rg), 0));
      const d = max(r.mul(mu).negate().add(sqrt(max(r.mul(r).mul(mu.mul(mu).sub(1)).add(Rt * Rt), 0))), 0);
      const dMin = float(Rt).sub(r);
      const dMax = rho.add(H);
      const x = clamp(d.sub(dMin).div(dMax.sub(dMin)), 0, 1);
      return vec2(texCoord(x, T_LUT_W), texCoord(rho.div(H), T_LUT_H));
    };
    /** Transmittance from radius r (km) toward a direction with zenith cosine mu, planet-shadowed. */
    const sunTransmittance = (r, mu) => {
      const rr = clamp(r, Rg + 1e-4, Rt);
      const vis = clamp(mu.sub(horizonMu(rr)).div(0.01).add(0.5), 0, 1);
      return texture(tTex, transmittanceUv(rr, mu), 0).rgb.mul(vis);
    };
    const multiScatter = (r, muS) => texture(msTex, vec2(
      texCoord(clamp(muS.mul(0.5).add(0.5), 0, 1), MS_LUT_SIZE),
      texCoord(clamp(r.sub(Rg).div(Rt - Rg), 0, 1), MS_LUT_SIZE),
    ), 0).rgb;

    const rayleighPhase = (c) => c.mul(c).add(1).mul(3 / (16 * Math.PI));
    const miePhase = (c, g) => {
      const g2 = g * g;
      return c.mul(c).add(1).mul((3 / (8 * Math.PI)) * (1 - g2) / (2 + g2))
        .div(pow(max(float(1 + g2).sub(c.mul(2 * g)), 1e-4), 1.5));
    };

    /**
     * Integrate in-scattering along a ray from the camera (radius camR km, on the
     * +Y axis) for tMax km. Returns { L, T } per unit solar irradiance.
     * `shadow(tKm)` optionally attenuates the direct sun term (cloud shadows).
     */
    const integrate = ({ camR, dir, tMax, steps, sunDir, shadow = null, jitter = 0.3 }) => {
      const L = vec3(0).toVar();
      const T = vec3(1).toVar();
      const dt = tMax.div(steps).toVar();
      const cosV = dot(dir, sunDir).toVar();
      const pR = rayleighPhase(cosV).toVar();
      const pM = miePhase(cosV, a.mieG).toVar();
      Loop(steps, ({ i }) => {
        const t = float(i).add(jitter).mul(dt).toVar();
        const pr = sqrt(t.mul(t).add(camR.mul(dir.y).mul(t).mul(2)).add(camR.mul(camR))).toVar();
        const h = max(pr.sub(Rg), 0).toVar();
        const muS = cosV.mul(t).add(camR.mul(sunDir.y)).div(pr).toVar();
        const dR = exp(h.div(-a.rayleighH));
        const dM = exp(h.div(-a.mieH)).mul(haze);
        const dO = max(float(1).sub(h.sub(a.ozoneCentre).abs().div(a.ozoneHalfWidth)), 0);
        const sR = vec3(...a.rayleigh).mul(dR).toVar();
        const sM = dM.mul(a.mieScattering).toVar();
        const ext = max(sR.add(dM.mul(a.mieScattering + a.mieAbsorption)).add(vec3(...a.ozone).mul(dO)), vec3(1e-9)).toVar();
        let direct = sunTransmittance(pr, muS);
        if (shadow) direct = direct.mul(shadow(t));
        const S = sR.mul(pR).add(sM.mul(pM)).mul(direct).add(sR.add(sM).mul(multiScatter(pr, muS)));
        const stepT = exp(ext.mul(dt).negate()).toVar();
        L.addAssign(T.mul(S).mul(float(1).sub(stepT)).div(ext));
        T.mulAssign(stepT);
      });
      return { L, T };
    };

    this._n = { horizonMu, sunTransmittance, multiScatter, integrate, Rg, Rt };
    return this._n;
  }

  _skyViewPass() {
    const n = this._nodes();
    const u = this.u;
    return Fn(() => {
      const st = uv();
      const camR = u.cameraKm.add(n.Rg).toVar();
      const beta = acos(clamp(sqrt(max(camR.mul(camR).sub(n.Rg * n.Rg), 0)).div(camR), -1, 1)).toVar();
      const zenithHorizon = float(Math.PI).sub(beta).toVar();
      const vza = float(0).toVar();
      If(st.y.lessThan(0.5), () => {
        const c = float(1).sub(st.y.mul(2));
        vza.assign(zenithHorizon.mul(float(1).sub(c.mul(c))));
      }).Else(() => {
        const c = st.y.mul(2).sub(1);
        vza.assign(zenithHorizon.add(beta.mul(c.mul(c))));
      });
      const cu = clamp(st.x.sub(0.5 / SKY_W).div(1 - 1 / SKY_W), 0, 1);
      const lvc = cu.mul(cu).mul(2).sub(1).negate().toVar();
      const cosZ = cos(vza).toVar();
      const sinZ = sin(vza).toVar();
      const dir = vec3(sinZ.mul(lvc), cosZ, sinZ.mul(sqrt(max(float(1).sub(lvc.mul(lvc)), 0)))).toVar();
      const muS = u.sunDir.y;
      const sun = vec3(sqrt(max(float(1).sub(muS.mul(muS)), 0)), muS, 0).toVar();

      const b = camR.mul(cosZ).toVar();
      const discG = b.mul(b).sub(camR.mul(camR)).add(n.Rg * n.Rg).toVar();
      const discT = b.mul(b).sub(camR.mul(camR)).add(n.Rt * n.Rt).toVar();
      const hitG = cosZ.lessThan(0).and(discG.greaterThanEqual(0));
      const tMax = select(hitG, b.negate().sub(sqrt(max(discG, 0))), b.negate().add(sqrt(max(discT, 0)))).toVar();
      const { L } = n.integrate({ camR, dir, tMax: max(tMax, 0), steps: 32, sunDir: sun });
      return vec4(L, 1);
    })();
  }

  /** uv into the sky-view LUT for a world direction (unit, y up). */
  _skyViewUv(dir, belowHorizon = false) {
    const n = this._nodes();
    const u = this.u;
    const camR = u.cameraKm.add(n.Rg);
    const beta = acos(clamp(sqrt(max(camR.mul(camR).sub(n.Rg * n.Rg), 0)).div(camR), -1, 1)).toVar();
    const zenithHorizon = float(Math.PI).sub(beta).toVar();
    const vza = acos(clamp(dir.y, -1, 1)).toVar();
    const above = vza.lessThan(zenithHorizon);
    const vAbove = min(float(1).sub(sqrt(max(float(1).sub(vza.div(zenithHorizon)), 0))).mul(0.5), 0.5 - 0.5 / SKY_H);
    const vBelow = max(sqrt(max(vza.sub(zenithHorizon).div(beta), 0)).mul(0.5).add(0.5), 0.5 + 0.5 / SKY_H);
    const dh = dir.xz.div(max(length(dir.xz), 1e-5));
    const sh = u.sunDir.xz.div(max(length(u.sunDir.xz), 1e-5));
    const lvc = clamp(dot(dh, sh), -1, 1);
    const x = sqrt(lvc.mul(-0.5).add(0.5));
    // By default directions below the geometric horizon reuse the horizon row:
    // the far terrain fades into exactly that colour through aerial perspective,
    // so there is no seam where the terrain mesh ends.
    return vec2(texCoord(x, SKY_W), belowHorizon ? select(above, vAbove, vBelow) : vAbove);
  }

  /**
   * Sky radiance (renderer units) for a world direction node.
   * disc: include the sun disc. ground: blend the lower hemisphere to this
   * colour node (used for the reflection environment, where the geometric
   * ground is missing).
   */
  skyNode(dirNode, { disc = true, ground = null } = {}) {
    const n = this._nodes();
    const u = this.u;
    return Fn(() => {
      const dir = normalize(dirNode).toVar();
      const col = texture(this.skyViewTarget.texture, this._skyViewUv(dir), 0).rgb.mul(u.sunIrradiance).toVar();
      if (ground) {
        const hz = n.horizonMu(u.cameraKm.add(n.Rg));
        col.assign(mix(col, ground, smoothstep(0.0, -0.06, dir.y.sub(hz))));
      }
      if (disc) {
        const cosS = dot(dir, u.sunDir);
        const ang = acos(clamp(cosS, -1, 1));
        const x = ang.div(SUN_ANGULAR_RADIUS);
        const edge = smoothstep(1.0, 0.86, x);
        const muLimb = sqrt(max(float(1).sub(x.mul(x)), 0));
        const limb = float(1).sub(float(0.6).mul(float(1).sub(muLimb)));
        const T = n.sunTransmittance(u.cameraKm.add(n.Rg), dir.y);
        col.addAssign(u.sunIrradiance.mul(T).mul(edge.mul(limb)).mul(u.sunDiscGain));
      }
      return col;
    })();
  }

  _aerialPass() {
    const n = this._nodes();
    const u = this.u;
    return Fn(() => {
      const st = uv().mul(vec2(AP_TILES_X, AP_TILES_Y)).toVar();
      const tile = floor(st).toVar();
      const tuv = fract(st).toVar();
      const slice = tile.y.mul(AP_TILES_X).add(tile.x);
      const w = slice.add(1).div(AP_SLICES);
      const distM = u.apMaxDist.mul(w).mul(w).toVar();
      const dirV = normalize(getViewPosition(tuv, float(0.5), u.projInv));
      const dir = normalize(u.cameraWorld.mul(vec4(dirV, 0)).xyz).toVar();
      const camR = u.cameraKm.add(n.Rg).toVar();
      const shadow = this.shadowFn
        ? (tKm) => this.shadowFn(u.cameraPos.add(dir.mul(tKm.mul(1000))))
        : null;
      const { L, T } = n.integrate({ camR, dir, tMax: distM.mul(0.001), steps: 14, sunDir: u.sunDir, shadow, jitter: 0.5 });
      return vec4(L, dot(T, vec3(1 / 3)));
    })();
  }

  _makeApSample() {
    const tex = this.apTarget.texture;
    const u = this.u;
    /** (screenUv, distanceMetres) -> vec4(in-scatter per unit irradiance, transmittance). */
    return Fn(([st, distM]) => {
      const w = sqrt(saturate(distM.div(u.apMaxDist))).mul(AP_SLICES).sub(1).toVar();
      const w0 = floor(clamp(w, 0, AP_SLICES - 1)).toVar();
      const w1 = min(w0.add(1), AP_SLICES - 1).toVar();
      const f = clamp(w.sub(w0), 0, 1);
      const tuv = clamp(st, vec2(0.5 / AP_TILE), vec2(1 - 0.5 / AP_TILE)).toVar();
      const inv = vec2(1 / AP_TILES_X, 1 / AP_TILES_Y);
      const at = (k) => texture(tex, vec2(k.mod(AP_TILES_X), floor(k.div(AP_TILES_X))).add(tuv).mul(inv), 0);
      const s = mix(at(w0), at(w1), f).toVar();
      // In front of the first slice: fade to "no atmosphere".
      const near = saturate(w.add(1));
      return vec4(s.rgb.mul(near), mix(float(1), s.a, near));
    });
  }

  /**
   * Scene stage: aerial perspective on opaque geometry.
   * fn(color, ctx) for game.post.addSceneStage(fn, 20).
   */
  aerialStage() {
    const u = this.u;
    return (color, ctx) => Fn(() => {
      const st = uv();
      const depth = ctx.depth.sample(st).r.toVar();
      const background = ctx.renderer.reversedDepthBuffer === true ? depth.lessThanEqual(0) : depth.greaterThanEqual(1);
      const vp = getViewPosition(st, depth, u.projInv);
      const ap = this.apSample(st, length(vp));
      const lit = color.rgb.mul(ap.a).add(ap.rgb.mul(u.sunIrradiance).mul(u.apStrength));
      return vec4(select(background, color.rgb, lit), color.a);
    })();
  }

  /* --------------------------------------------------------------- render */

  makeSkyMesh() {
    const mat = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthTest: false, depthWrite: false, fog: false });
    mat.name = 'Atmosphere.sky';
    mat.colorNode = this.skyNode(positionLocal, { disc: true });
    const mesh = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 5), mat);
    mesh.name = 'sky';
    mesh.frustumCulled = false;
    mesh.renderOrder = -1000;
    mesh.castShadow = mesh.receiveShadow = false;
    return mesh;
  }

  /** A tiny scene to capture into the PMREM reflection environment. */
  makeEnvironmentScene(groundColorUniform, tintUniform) {
    const scene = new THREE.Scene();
    const mat = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthTest: false, depthWrite: false, fog: false });
    mat.colorNode = this.skyNode(positionLocal, { disc: false, ground: groundColorUniform }).mul(tintUniform);
    const mesh = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 4), mat);
    mesh.scale.setScalar(50);
    mesh.frustumCulled = false;
    scene.add(mesh);
    return scene;
  }

  /** Set a shadow function for the froxel march (rebuilds that one material). */
  setShadowFn(fn) {
    this.shadowFn = fn;
    this._apMaterial.fragmentNode = this._aerialPass();
    this._apMaterial.needsUpdate = true;
  }

  syncCamera(camera) {
    const u = this.u;
    u.cameraKm.value = Math.max(camera.position.y, 1) / 1000;
    u.cameraPos.value.copy(camera.position);
    u.cameraWorld.value.copy(camera.matrixWorld);
    u.projInv.value.copy(camera.projectionMatrixInverse);
  }

  /** Render the per-frame LUTs. Call once per frame after the camera has moved. */
  update(camera) {
    const renderer = this.renderer;
    this.syncCamera(camera);
    this._state = THREE.RendererUtils.resetRendererState(renderer, this._state);
    this._quad.material = this._skyViewMaterial;
    renderer.setRenderTarget(this.skyViewTarget);
    this._quad.render(renderer);
    this._quad.material = this._apMaterial;
    renderer.setRenderTarget(this.apTarget);
    this._quad.render(renderer);
    THREE.RendererUtils.restoreRendererState(renderer, this._state);
  }

  dispose() {
    this.transmittanceTexture.dispose();
    this.multiScatterTexture.dispose();
    this.skyViewTarget.dispose();
    this.apTarget.dispose();
    this._skyViewMaterial.dispose();
    this._apMaterial.dispose();
  }
}

export { SUN_ANGULAR_RADIUS };
