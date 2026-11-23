import * as THREE from 'three/webgpu';
import {
  Fn, vec2, vec3, vec4, float, uniform, texture, attribute, varying, mrt, normalize, dot, max, mix, pow,
  exp, sin, atan, asin, smoothstep, saturate, clamp, sqrt, step, time,
  cameraProjectionMatrix, cameraViewMatrix, positionGeometry, screenSize,
} from 'three/tsl';
import { milkyWay, moonAlbedo, starColor, decodeStars } from './textures.js';

/**
 * The night half of the sky dome: airglow, the moonlit sky and the moon's
 * aureole, the Milky Way, the moon disc with its phase, and the stars.
 *
 * Everything except the stars is one extra radiance term added to the
 * atmosphere's sky material (`radiance(dir)`), so it costs a handful of
 * instructions and two texture taps per sky pixel and is occluded by terrain
 * and clouds for free. The stars are one instanced draw of camera-facing
 * quads, additive, drawn right after the sky and before any geometry.
 *
 * Photometric scale: renderer units, the same as the day sky. The moon disc
 * is physical (albedo 0.12 under 4.6 of sunlight = 0.18), so it is a pale
 * disc by day and blows out to white at night exposure, like a photograph.
 * All uniforms are written by TimeOfDay.
 */

/** Angular radius of the moon disc, radians (0.26 degrees real; 1.7x for readability). */
export const MOON_RADIUS = 0.0078;
const TWO_PI = Math.PI * 2;

/** Stars drawn per quality tier (the catalogue is sorted brightest first). */
export const STAR_BUDGET = { low: 2200, medium: 5000, high: 8874, ultra: 8874 };

export class NightSky {
  constructor({ tier = 'high', low = false, stars = true, url = './assets/sky/stars.bin' } = {}) {
    this.low = low;
    const v3 = (x = 0, y = 0, z = 0) => uniform(new THREE.Vector3(x, y, z));
    this.u = {
      moonDir: v3(0, 1, 0),
      /** True sun direction (below the horizon at night): lights the moon's phase. */
      solarDir: v3(0, -1, 0),
      /** Moon-fixed axes on the sky (celestial east / north at the moon), for the albedo map. */
      moonRight: v3(1, 0, 0),
      moonUp: v3(0, 0, 1),
      /** Disc radiance at full illumination (albedo x sunlight / pi x transmittance). */
      moonDisc: v3(),
      earthshine: uniform(0),
      /** Moon irradiance reaching the camera: scales the aureole. */
      moonHalo: v3(),
      /** Moonlit sky radiance, zenith and horizon. */
      moonSkyZenith: v3(),
      moonSkyHorizon: v3(),
      /** Airglow radiance at the zenith; the horizon is (1 + airglowHorizon) times that. */
      airglow: v3(),
      airglowHorizon: uniform(2.4),
      galaxyGain: uniform(0),
      starGain: uniform(0),
      /** Star quad half-size multiplier (1 = tuned for 1080 lines; scales with resolution). */
      starScale: uniform(1),
      twinkle: uniform(1),
      eqToWorld: uniform(new THREE.Matrix3()),
      worldToGalactic: uniform(new THREE.Matrix3()),
    };

    const mw = low ? milkyWay(512, 256) : milkyWay(1024, 512);
    this.galaxyTexture = new THREE.DataTexture(mw.data, mw.width, mw.height, THREE.RGBAFormat, THREE.UnsignedByteType);
    this.galaxyTexture.wrapS = THREE.RepeatWrapping;
    this.galaxyTexture.wrapT = THREE.ClampToEdgeWrapping;
    this.galaxyTexture.minFilter = this.galaxyTexture.magFilter = THREE.LinearFilter;
    this.galaxyTexture.generateMipmaps = false;
    this.galaxyTexture.colorSpace = THREE.NoColorSpace;
    this.galaxyTexture.needsUpdate = true;

    const ma = moonAlbedo(low ? 64 : 128);
    this.moonTexture = new THREE.DataTexture(ma.data, ma.width, ma.height, THREE.RedFormat, THREE.UnsignedByteType);
    this.moonTexture.minFilter = this.moonTexture.magFilter = THREE.LinearFilter;
    this.moonTexture.generateMipmaps = false;
    this.moonTexture.colorSpace = THREE.NoColorSpace;
    this.moonTexture.needsUpdate = true;

    this.group = new THREE.Group();
    this.group.name = 'night-sky';
    this.stars = null;
    this.starCount = 0;
    this._budget = STAR_BUDGET[tier] ?? STAR_BUDGET.high;
    this.ready = stars
      ? this._loadStars(url).catch((e) => console.warn('[night] star catalogue unavailable', e))
      : Promise.resolve();
  }

  /**
   * Night radiance for a world direction node (unit not required).
   * `full: false` leaves out the Milky Way and the moon disc (reflection
   * environment: only the diffuse glow matters there).
   */
  radiance(dirNode, { full = true } = {}) {
    const u = this.u;
    return Fn(() => {
      const d = normalize(dirNode).toVar();
      const y = max(d.y, 0).toVar();
      const h = float(1).sub(y).toVar();
      const h2 = h.mul(h).toVar();
      // airglow: brighter toward the horizon (longer path through the emitting layer)
      const col = u.airglow.mul(h2.mul(h).mul(u.airglowHorizon).add(1)).toVar();
      // sky lit by the moon: the day sky's gradient, scaled; plus the forward-scattering aureole
      col.addAssign(mix(u.moonSkyZenith, u.moonSkyHorizon, h2.mul(h2)));
      const cm = dot(d, u.moonDir).toVar();
      const cp = max(cm, 0).toVar();
      col.addAssign(u.moonHalo.mul(pow(cp, 700).mul(0.5).add(pow(cp, 60).mul(0.035)).add(pow(cp, 6).mul(0.004))));
      if (!full) return col;

      // Milky Way, dimmed toward the horizon by the air it is seen through
      const g = u.worldToGalactic.mul(d).toVar();
      const guv = vec2(atan(g.y, g.x).div(TWO_PI).add(0.5), asin(clamp(g.z, -1, 1)).div(Math.PI).add(0.5));
      const ext = exp(float(1).div(y.add(0.07)).sub(0.9346).mul(-0.16));
      col.addAssign(texture(this.galaxyTexture, guv, 0).rgb.mul(u.galaxyGain).mul(ext));

      // moon disc: a lit sphere, so the phase and the tilt of the terminator are geometric
      const o = d.sub(u.moonDir.mul(cm)).div(MOON_RADIUS).toVar();
      const r2 = dot(o, o).toVar();
      const nz = sqrt(max(float(1).sub(r2), 0));
      const n = o.sub(u.moonDir.mul(nz));
      const lit = saturate(dot(n, u.solarDir));
      const muv = vec2(dot(o, u.moonRight), dot(o, u.moonUp)).mul(0.5).add(0.5);
      const albedo = texture(this.moonTexture, clamp(muv, 0, 1), 0).r;
      const edge = smoothstep(1.0, 0.86, sqrt(r2)).mul(step(0, cm));
      const face = u.moonDisc.mul(albedo).mul(pow(lit, 0.55).add(u.earthshine));
      col.addAssign(face.mul(edge));
      return col;
    })();
  }

  async _loadStars(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: ${res.status}`);
    const cat = decodeStars(await res.arrayBuffer(), this._budget);
    const n = cat.count;
    const col = new Float32Array(n * 3);
    const aux = new Float32Array(n * 2);
    const c = [0, 0, 0];
    for (let i = 0; i < n; i++) {
      const m = cat.mag[i];
      starColor(cat.bv[i], c);
      // compressed magnitude scale (10^-0.3m instead of 10^-0.4m): the faint
      // stars stay visible next to Sirius without a 1500:1 range
      const flux = Math.pow(10, -0.3 * m);
      col[i * 3] = c[0] * flux; col[i * 3 + 1] = c[1] * flux; col[i * 3 + 2] = c[2] * flux;
      aux[i * 2] = 1.55 + 2.4 * Math.min(1, Math.max(0, (3.5 - m) / 5)); // quad half-size, px at 1080 lines
      aux[i * 2 + 1] = (i * 0.61803398875) % 1;
    }
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    geo.setAttribute('starDir', new THREE.InstancedBufferAttribute(cat.dir, 3));
    geo.setAttribute('starCol', new THREE.InstancedBufferAttribute(col, 3));
    geo.setAttribute('starAux', new THREE.InstancedBufferAttribute(aux, 2));
    geo.instanceCount = n;

    const u = this.u;
    const mat = new THREE.MeshBasicNodeMaterial({
      depthTest: false, depthWrite: false, fog: false, side: THREE.DoubleSide,
      // additive but in the opaque list: drawn after the sky dome (renderOrder)
      // and before the terrain, which then simply covers it
      blending: THREE.AdditiveBlending, transparent: false,
    });
    mat.name = 'NightSky.stars';
    const aAux = attribute('starAux', 'vec2');
    const w = u.eqToWorld.mul(attribute('starDir', 'vec3'));
    const corner = positionGeometry.xy;

    mat.vertexNode = Fn(() => {
      const v = cameraViewMatrix.mul(vec4(w, 0)).xyz;
      const clip = cameraProjectionMatrix.mul(vec4(v, 1)).toVar();
      const px = aAux.x.mul(u.starScale).mul(screenSize.y.div(1080).max(0.75));
      const off = corner.mul(px).mul(2).div(screenSize.xy).mul(clip.w);
      // depth is irrelevant (no depth test): park it mid-range so it is never clipped
      return vec4(clip.xy.add(off), clip.w.mul(0.5), clip.w);
    })();

    const vis = Fn(() => {
      const y = w.y;
      const air = float(1).div(max(y, 0).add(0.06)); // relative air mass, 1 at the zenith, ~17 at the horizon
      const ext = exp(air.sub(0.943).mul(-0.1));
      const above = smoothstep(-0.05, -0.005, y);
      const seed = aAux.y;
      // scintillation: two beating sines per star, stronger through more air
      const tw = sin(time.mul(seed.mul(9).add(6)).add(seed.mul(311))).mul(sin(time.mul(seed.mul(5.3).add(3.1)).add(seed.mul(97))));
      const amp = clamp(air.mul(0.05), 0.05, 0.65).mul(u.twinkle);
      const notMoon = step(dot(w, u.moonDir), Math.cos(MOON_RADIUS * 1.05));
      return u.starGain.mul(ext).mul(above).mul(tw.mul(amp).add(1)).mul(notMoon);
    })();
    const vCol = varying(attribute('starCol', 'vec3').mul(vis), 'vStarCol');
    const vUv = varying(corner, 'vStarUv');
    mat.colorNode = vCol.mul(exp(dot(vUv, vUv).mul(-4.2)));
    // additive into the velocity target too: add nothing
    mat.mrtNode = mrt({ velocity: vec4(0) });

    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'stars';
    mesh.frustumCulled = false;
    mesh.renderOrder = -999; // the sky dome is -1000
    mesh.castShadow = mesh.receiveShadow = false;
    mesh.visible = false;
    this.stars = mesh;
    this.starCount = n;
    this.group.add(mesh);
  }

  /** Per frame: hide the star draw entirely by day. */
  update() {
    if (this.stars) this.stars.visible = this.u.starGain.value > 1e-4;
  }

  dispose() {
    this.galaxyTexture.dispose();
    this.moonTexture.dispose();
    this.stars?.geometry.dispose();
    this.stars?.material.dispose();
  }
}
