import * as THREE from 'three/webgpu';
import {
  pass, mrt, output, velocity, renderOutput, uniform, vec2, vec3, vec4, uv, float, texture,
  convertToTexture, rtt, Fn, Loop, luminance, log2, max, mix, smoothstep, length, dot,
  positionWorld, int, ivec2, time, select, screenSize,
} from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { fxaa } from 'three/addons/tsl/display/FXAANode.js';
import { smaa } from 'three/addons/tsl/display/SMAANode.js';
import { traa } from 'three/addons/tsl/display/TRAANode.js';
import { postConfig } from '../fx/post/config.js';
import {
  velocityMotionBlur, sunVisibility, sunFlare, sunGlow, agxLook, splitTone, screenStates,
  filmGrain, aspectUV,
} from '../fx/post/nodes.js';
import { EXPOSURE_DEFAULTS, targetExposureEV, adaptLog2, evToMultiplier } from '../fx/post/exposure.js';
import { createLensDirtTexture, createDropletTexture } from '../fx/post/textures.js';

const _v = new THREE.Vector3();
/** Auto-exposure metering interval in frames (15 Hz at 60 fps). */
const METER_EVERY = 4;
const _m = new THREE.Matrix4();

/**
 * Post-processing chain (TSL RenderPipeline), quality-tiered (src/fx/post/config.js).
 *
 *   scene pass (HDR colour + velocity MRT + reversed depth)
 *   -> scene stages (addSceneStage: atmosphere 20, clouds 30, heat haze 60 ...)
 *   -> AA: TRAA (medium+) on HDR
 *   -> depth-aware velocity motion blur (medium+)
 *   -> [meters] auto-exposure (64x36 log-lum -> 1x1, read back, adapted on CPU)
 *               sun occlusion (n x n depth+luminance taps -> 1x1)
 *   -> final pass: droplet refraction, sharpen + chromatic aberration taps,
 *      exposure, bloom, sun flare (ghosts/halo/starburst/streak), lens dirt,
 *      flash, AgX + "Kargil" look, split tone, G/damage screen states,
 *      vignette, sRGB, [FXAA/SMAA on low], film grain
 *
 * Public surface (kept): render(), dispose(), uniforms, scenePass,
 *   addSceneStage(fn, order) — HDR compositing hook, ctx =
 *   { scenePass, depth (reversed-Z texture node), velocity, camera, renderer }.
 * Added: setFrameState(state), notifyCut(), options, debugView, stats.
 */
export class PostFX {
  constructor(r) {
    this.r = r;
    const renderer = r.renderer;
    renderer.toneMapping = THREE.AgXToneMapping; // informational; the chain tone maps itself

    const params = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams();
    let prefersReduced = false;
    try { prefersReduced = matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { /* no DOM */ }

    this.options = {
      autoExposure: true,
      exposureCompensation: 0, // EV, user/UI brightness
      motionBlur: 1, // user scale 0..1.5
      reducedMotion: prefersReduced || params.has('reducedMotion'),
      flare: true,
      grain: true,
      exposure: { ...EXPOSURE_DEFAULTS },
    };

    const u = (v) => uniform(v);
    this.uniforms = {
      // applied linear exposure (auto-exposure writes it every frame)
      exposure: u(evToMultiplier(EXPOSURE_DEFAULTS.baseEV)),
      bloomStrength: u(0.06),
      bloomCap: u(40), // pre-exposure; set from bloomCapExposed each frame
      mbStrength: u(0),
      mbMaxPx: u(32),
      speedBlur: u(0), // radial edge streak, uv units at the edge
      near: u(r.camera.near),
      far: u(r.camera.far),
      aspect: u(16 / 9),
      sunUV: u(new THREE.Vector2(0.5, 0.5)),
      sunAmount: u(0),
      sunRefLum: u(20000), // clear-sky HDR peak at the sun's core (measured ~60000)
      flareRot: u(0),
      dirt: u(0.9),
      chromatic: u(1),
      sharpen: u(0.25),
      grain: u(1),
      vignette: u(0.28),
      lookSlope: u(new THREE.Vector3(1.0, 0.99, 0.965)),
      lookPower: u(new THREE.Vector3(1.12, 1.12, 1.14)),
      lookSat: u(1.18),
      shadowTint: u(new THREE.Vector3(0.965, 0.995, 1.05)),
      highlightTint: u(new THREE.Vector3(1.035, 1.0, 0.95)),
      toneBalance: u(0.42),
      grey: u(0), red: u(0), damage: u(0), smear: u(0), lowHealth: u(0), flash: u(0), wet: u(0),
      seed: u(0),
    };

    /** Bloom in *exposed* units (the chain rescales by exposure each frame). */
    this.bloomSettings = { threshold: 1.4, knee: 2.0, cap: 24 };
    this.stages = [];
    this.stats = { avgLog2: NaN, adaptedLog2: NaN, ev: EXPOSURE_DEFAULTS.baseEV, sunVisibility: 0, sunLum: 0 };
    this.debugView = null;
    this._frame = { airspeed: 0, sunDirection: null, sunIntensity: 1 };
    this._cutFrames = 0;
    this._dtAvg = 1 / 60;
    this._last = 0;
    this._reading = false;

    this.lensDirt = createLensDirtTexture();
    this.droplets = createDropletTexture();

    const scenePass = pass(r.scene, r.camera);
    const sceneMRT = mrt({ output, velocity });
    // Blend the velocity target with the material's blending (opaque: none) so
    // a blended surface can opt out of writing velocity (useTransparentVelocity).
    sceneMRT.setBlendMode('velocity', new THREE.BlendMode(THREE.MaterialBlending));
    scenePass.setMRT(sceneMRT);
    this.scenePass = scenePass;

    // Camera-only velocity for static geometry whose vertices are placed by a
    // positionNode (the terrain clipmap): three's VelocityNode reprojects
    // `positionGeometry` for the previous frame, which for a GPU-displaced
    // grid is the flat, undisplaced vertex — garbage velocity, which breaks
    // TRAA history and motion blur. See useStaticVelocity().
    this._curVP = uniform(new THREE.Matrix4());
    this._prevVP = uniform(new THREE.Matrix4());
    this.staticVelocity = Fn(() => {
      const c = this._curVP.mul(vec4(positionWorld, 1));
      const p = this._prevVP.mul(vec4(positionWorld, 1));
      return c.xy.div(c.w).sub(p.xy.div(p.w));
    })();
    this._vpPrimed = false;

    this.pipeline = new THREE.RenderPipeline(renderer);
    this.pipeline.outputColorTransform = false;
    this._build();
  }

  addSceneStage(fn, order = 50) {
    this.stages.push({ fn, order });
    this.stages.sort((a, b) => a.order - b.order);
    this._build();
  }

  /** Give a material whose geometry is displaced in a positionNode correct (camera-only) velocity. */
  useStaticVelocity(material) {
    if (!material || material.mrtNode) return;
    material.mrtNode = mrt({ velocity: this.staticVelocity });
    material.needsUpdate = true;
  }

  /**
   * Blended surfaces (canopy glass, gunsight combiner) must not write velocity:
   * the MRT velocity target is blended like colour, so writing alpha 0 keeps
   * the velocity of whatever is behind the glass (the terrain you look through).
   */
  useTransparentVelocity(material) {
    if (!material || material.mrtNode || !material.transparent) return;
    material.mrtNode = mrt({ velocity: vec4(velocity, 0, 0) });
    material.needsUpdate = true;
  }

  /** Per-frame inputs from the camera/post system (src/camera/system.js). */
  setFrameState(s) { Object.assign(this._frame, s); }

  /** A camera cut happened this frame: suppress motion blur across it. */
  notifyCut(frames = 2) { this._cutFrames = Math.max(this._cutFrames, frames); }

  _build() {
    const cfg = this.cfg = postConfig(this.r.tier);
    this._tier = this.r.tier;
    const u = this.uniforms;
    const sp = this.scenePass;
    const camera = this.r.camera;
    const depth = sp.getTextureNode('depth');
    const vel = sp.getTextureNode('velocity');
    const ctx = { scenePass: sp, depth, velocity: vel, camera, renderer: this.r.renderer };

    let color = sp.getTextureNode('output');
    for (const s of this.stages) color = s.fn(color, ctx);
    const hdr = convertToTexture(color); // no extra pass when there are no stages

    // --- anti-aliasing (HDR, temporal) ------------------------------------
    let aa = hdr;
    this.traa = null;
    if (cfg.aa === 'traa') {
      this.traa = traa(hdr, depth, vel, camera);
      aa = this.traa.getTextureNode();
    }

    // --- motion blur --------------------------------------------------------
    let mb = aa;
    if (cfg.mbSamples > 0) {
      mb = convertToTexture(velocityMotionBlur({
        color: aa, velocity: vel, depth, near: u.near, far: u.far,
        strength: u.mbStrength, maxPx: u.mbMaxPx, samples: cfg.mbSamples, radial: u.speedBlur,
      }));
    }

    // --- meters ------------------------------------------------------------
    const [mw, mh] = cfg.meter;
    const meter1 = rtt(Fn(() => {
      const uv0 = uv();
      const o = vec2(0.25 / mw, 0.25 / mh);
      // clamped log-luminance: the top clamp is the cheap stand-in for a
      // histogram's percentile cut — the sun disc and specular glints must
      // not drag the exposure of the whole frame down
      const tap = (dx, dy) => log2(max(luminance(hdr.sample(uv0.add(o.mul(vec2(dx, dy)))).rgb), 1e-4)).clamp(-10, 4.5);
      const l = tap(-1, -1).add(tap(1, -1)).add(tap(-1, 1)).add(tap(1, 1)).mul(0.25);
      // centre-weighted; the upper (sky) part of the frame counts less
      const cw = mix(0.3, 1.0, smoothstep(0.8, 0.15, length(uv0.sub(0.5).mul(vec2(1.4, 1)))));
      const w = cw.mul(mix(0.55, 1.0, smoothstep(0.15, 0.5, uv0.y)));
      return vec4(l.mul(w), w, 0, 1);
    })(), mw, mh, { type: THREE.HalfFloatType });
    meter1.name = 'ExposureMeter';
    const meter2 = rtt(Fn(() => {
      // keepAlive(meter1): a sampled/loaded clone of an RTT node does not schedule
      // its render; only a direct reference to the base node does.
      const acc = vec2(keepAlive(meter1), 0).toVar();
      Loop(mh, mw, ({ i, j }) => {
        acc.addAssign(meter1.load(ivec2(int(j), int(i))).xy);
      });
      return vec4(acc.x.div(max(acc.y, 1e-4)), 0, 0, 1);
    })(), 1, 1, { type: THREE.FloatType });
    meter2.name = 'ExposureMeterReduce';
    // [engine perf] The meters only feed a CPU readback that adapts over
    // seconds: render them every METER_EVERY frames (render() flags them), not
    // every frame. Saves two passes, and most readback copies/submits.
    meter1.autoUpdate = false;
    meter2.autoUpdate = false;
    this._meter1 = meter1;
    this._meter = meter2;

    const visNode = rtt(sunVisibility({
      color: hdr, depth, sunUV: u.sunUV, aspect: u.aspect, radius: float(0.022),
      refLum: u.sunRefLum, grid: cfg.flareGrid,
    }), 1, 1, { type: THREE.FloatType });
    visNode.name = 'SunVisibility';
    this._vis = visNode;
    const vis = visNode.x; // 1x1 target: the node's own uv() samples the only texel

    // --- final composite ------------------------------------------------------
    const uv0 = uv();
    const aspect = u.aspect;
    const drop = texture(this.droplets, aspectUV(uv0, aspect).mul(2.2).add(vec2(0, time.mul(-0.015))));
    const refr = drop.rg.sub(0.5).mul(drop.b).mul(u.wet).mul(0.02);
    const suv = uv0.add(refr);
    const centred = suv.sub(0.5);
    const rNorm = length(uv0.sub(0.5).mul(vec2(aspect, 1))).div(length(vec2(aspect, 1).mul(0.5)));

    const c0 = mb.sample(suv);
    let rgb = c0.rgb;
    if (cfg.sharpen > 0) {
      // contrast-adaptive (clamped) unsharp mask: restores TAA softness without halos
      const t = vec2(1).div(screenSize);
      const n = mb.sample(suv.add(vec2(0, t.y))).rgb;
      const s = mb.sample(suv.sub(vec2(0, t.y))).rgb;
      const e = mb.sample(suv.add(vec2(t.x, 0))).rgb;
      const w = mb.sample(suv.sub(vec2(t.x, 0))).rgb;
      const mn = n.min(s).min(e).min(w).min(rgb);
      const mx = n.max(s).max(e).max(w).max(rgb);
      const avg = n.add(s).add(e).add(w).mul(0.25);
      rgb = rgb.add(rgb.sub(avg).mul(u.sharpen)).clamp(mn, mx);
    }
    if (cfg.chromatic > 0) {
      // lateral CA grows with r^2; spikes with a hit (smear)
      const amt = u.chromatic.mul(0.0016).add(u.smear.mul(0.012));
      const off = centred.mul(dot(centred, centred).mul(4)).mul(amt);
      const cr = mb.sample(suv.sub(off)).r;
      const cb = mb.sample(suv.add(off)).b;
      rgb = vec3(cr.add(rgb.r.sub(c0.r)), rgb.g, cb.add(rgb.b.sub(c0.b)));
      // radial smear toward the centre on a hit
      const sm = u.smear.mul(0.035);
      const s1 = mb.sample(suv.sub(centred.mul(sm))).rgb;
      const s2 = mb.sample(suv.sub(centred.mul(sm.mul(2)))).rgb;
      rgb = mix(rgb, rgb.add(s1).add(s2).div(3), u.smear.clamp(0, 1));
    }

    let x = rgb.mul(u.exposure);

    let bloomTex = null;
    if (cfg.bloom) {
      // Clamp what feeds the bloom: the sun disc is thousands of times brighter
      // than anything else and would otherwise veil the whole frame.
      const b = bloom(vec4(mb.rgb.min(vec3(u.bloomCap)), 1), 0.1, cfg.bloomRadius, 1.0);
      b.strength = u.bloomStrength;
      this._bloom = b;
      bloomTex = b.getTextureNode ? b.getTextureNode() : b;
      x = x.add(bloomTex.rgb.mul(u.exposure));
    } else {
      this._bloom = null;
    }

    if (cfg.flare) {
      const amount = vis.mul(u.sunAmount);
      x = x.add(sunFlare(uv0, u.sunUV, aspect, amount, u.flareRot));
      if (cfg.dirt) {
        const dirt = texture(this.lensDirt, uv0).rgb;
        const reveal = sunGlow(uv0, u.sunUV, aspect).mul(amount).mul(0.45);
        const fromBloom = bloomTex ? luminance(bloomTex.rgb.mul(u.exposure)).mul(0.6) : float(0);
        x = x.add(dirt.mul(reveal.add(fromBloom)).mul(u.dirt));
      }
    }
    // droplet glints + flash whiteout (HDR, so it rolls off through AgX)
    x = x.add(vec3(drop.a.mul(drop.b).mul(u.wet).mul(0.12)));
    x = x.add(vec3(1.0, 0.95, 0.86).mul(u.flash.mul(u.flash).mul(6)));

    let ldr = agxLook(x, u.lookSlope, u.lookPower, u.lookSat);
    ldr = splitTone(ldr, u.shadowTint, u.highlightTint, u.toneBalance);
    ldr = screenStates(ldr, rNorm, u.grey, u.red, u.damage, u.lowHealth);
    ldr = ldr.mul(mix(1, smoothstep(1.2, 0.3, rNorm), u.vignette));

    // Built first so the base render-to-texture nodes are scheduled (in this
    // order) before anything that samples them: the HDR composite, the meters.
    const keep = keepAlive(hdr).add(keepAlive(mb)).add(keepAlive(meter2));
    let out = renderOutput(vec4(vec3(keep).add(ldr), 1), THREE.NoToneMapping, THREE.SRGBColorSpace);
    if (cfg.aa === 'fxaa') out = fxaa(out);
    else if (cfg.aa === 'smaa') out = smaa(out);
    if (cfg.grain > 0) out = vec4(filmGrain(out.rgb, u.grain.mul(0.022 * cfg.grain), u.seed), 1);

    // dev views: post.debugView = 'velocity' | 'depth' | 'exposure' | 'flare' | 'bloom'
    if (this.debugView === 'velocity') out = vec4(vel.sample(uv0).xy.mul(40).add(0.5), 0.5, 1);
    else if (this.debugView === 'depth') out = vec4(vec3(log2(depth.sample(uv0).x.max(1e-9)).div(-30)), 1);
    else if (this.debugView === 'exposure') out = vec4(vec3(meter1.sample(uv0).x.div(meter1.sample(uv0).y.max(1e-4)).add(8).div(16)), 1);
    else if (this.debugView === 'flare') out = vec4(sunFlare(uv0, u.sunUV, aspect, select(vis.greaterThan(0), float(1), float(0.2)), u.flareRot), 1);
    else if (this.debugView === 'bloom' && bloomTex) out = vec4(bloomTex.rgb.mul(u.exposure), 1);
    // 'passthrough': scene (+ stages) tone-mapped only — the A/B baseline for timing the chain
    else if (this.debugView === 'passthrough') out = renderOutput(vec4(color.rgb.mul(u.exposure), 1), THREE.AgXToneMapping, THREE.SRGBColorSpace);

    this.pipeline.outputNode = out;
    this.pipeline.needsUpdate = true;
  }

  /** Rebuild (e.g. after changing debugView). */
  rebuild() { this._build(); }

  _updateCamera() {
    const cam = this.r.camera;
    const u = this.uniforms;
    u.near.value = cam.near;
    u.far.value = cam.far;
    u.aspect.value = cam.aspect;

    // static-velocity matrices (unjittered: TRAA jitters inside pipeline.render)
    _m.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    if (!this._vpPrimed || this._cutFrames > 0) { this._prevVP.value.copy(_m); this._vpPrimed = true; }
    else this._prevVP.value.copy(this._curVP.value);
    this._curVP.value.copy(_m);

    // sun on screen
    const f = this._frame;
    const sun = f.sunDirection;
    let amount = 0;
    if (sun && this.options.flare) {
      _v.copy(sun).transformDirection(cam.matrixWorldInverse);
      const front = _v.z < 0 ? Math.min(1, -_v.z * 6) : 0; // fade as it swings behind
      _v.copy(cam.position).addScaledVector(sun, 1e4).project(cam);
      const sx = _v.x * 0.5 + 0.5;
      const sy = 0.5 - _v.y * 0.5;
      u.sunUV.value.set(sx, sy);
      const edge = Math.max(Math.abs(_v.x), Math.abs(_v.y));
      const onScreen = 1 - smoothstepJS(0.95, 1.4, edge);
      amount = front * onScreen * (f.sunIntensity ?? 1);
      u.flareRot.value = (sx * 0.9 + sy * 0.5);
    }
    u.sunAmount.value = amount;
  }

  _updateExposure(dt) {
    const o = this.options;
    const s = this.stats;
    if (!o.autoExposure) { s.ev = o.exposure.baseEV + o.exposureCompensation; }
    else {
      if (Number.isFinite(s.avgLog2)) s.adaptedLog2 = adaptLog2(s.adaptedLog2, s.avgLog2, dt, o.exposure);
      s.ev = targetExposureEV(s.adaptedLog2, o.exposure, o.exposureCompensation);
    }
    const e = evToMultiplier(s.ev);
    this.uniforms.exposure.value = e;
    if (this._bloom) {
      // threshold is specified in *exposed* units; the bloom input is pre-exposure
      const b = this.bloomSettings;
      this._bloom.threshold.value = b.threshold / e;
      this._bloom.smoothWidth.value = b.knee / e;
      this.uniforms.bloomCap.value = b.cap / e;
    }
  }

  _updateMotion(dt) {
    const u = this.uniforms;
    const o = this.options;
    this._dtAvg += (dt - this._dtAvg) * 0.1;
    const shutter = Math.min(2, Math.max(0.5, (1 / 90) / Math.max(this._dtAvg, 1e-3)));
    const speed = this._frame.airspeed ?? 0;
    const speedK = 0.3 + 0.7 * smoothstepJS(80, 320, speed);
    let k = shutter * speedK * o.motionBlur;
    if (o.reducedMotion) k = 0;
    // radial speed streaks: from ~750 km/h, more with the burner lit
    let radial = smoothstepJS(200, 340, speed) * 0.014 * (this._frame.reheat ? 1.35 : 1) * o.motionBlur;
    if (o.reducedMotion) radial = 0;
    if (this._cutFrames > 0) { k = 0; radial = 0; this._cutFrames--; }
    u.mbStrength.value = k;
    u.speedBlur.value = radial;
    u.mbMaxPx.value = 36 * (this.r.renderer.getPixelRatio?.() ?? 1);
    u.seed.value = (u.seed.value + 1) % 997;
  }

  _applyScreen() {
    const u = this.uniforms;
    const s = this._frame.screen;
    if (!s) return;
    const rm = this.options.reducedMotion;
    u.grey.value = s.grey ?? 0;
    u.red.value = s.red ?? 0;
    u.damage.value = s.damage ?? 0;
    u.smear.value = rm ? 0 : (s.smear ?? 0);
    u.lowHealth.value = s.lowHealth ?? 0;
    u.flash.value = (s.flash ?? 0) * (rm ? 0.5 : 1);
    u.wet.value = s.wet ?? 0;
  }

  _readMeters() {
    const renderer = this.r.renderer;
    if (!renderer.readRenderTargetPixelsAsync) return;
    this._reading = true;
    const m = this._meter.renderTarget;
    const v = this._vis.renderTarget;
    Promise.all([
      renderer.readRenderTargetPixelsAsync(m, 0, 0, 1, 1),
      renderer.readRenderTargetPixelsAsync(v, 0, 0, 1, 1),
    ]).then(([a, b]) => {
      if (a && Number.isFinite(a[0])) this.stats.avgLog2 = a[0];
      if (b) { this.stats.sunVisibility = b[0]; this.stats.sunPeak = b[1]; this.stats.sunCloud = b[2]; }
    }).catch(() => { /* readback unsupported: stay on fixed exposure */ })
      .finally(() => { this._reading = false; });
  }

  render() {
    const now = performance.now();
    const dt = this._last ? Math.min(0.25, (now - this._last) / 1000) : 1 / 60;
    this._last = now;
    this._frameNo = (this._frameNo ?? 0) + 1;
    if (this.r.tier !== this._tier) this._build();
    this._updateCamera();
    this._updateExposure(dt);
    this._updateMotion(dt);
    this._applyScreen();
    // [engine perf] meter (and read back) on every METER_EVERY-th frame only,
    // and never while the previous readback is still in flight
    const meter = this.options.autoExposure && !this._reading && this._frameNo % METER_EVERY === 0;
    if (meter) { this._meter1.textureNeedsUpdate = true; this._meter.textureNeedsUpdate = true; }
    this.pipeline.render();
    if (meter) this._readMeters();
  }

  dispose() {
    this.pipeline.dispose();
    this.lensDirt.dispose();
    this.droplets.dispose();
  }
}

/** A zero that references a texture node's *base* so its render is scheduled. */
function keepAlive(node) { return node.x.mul(0); }

function smoothstepJS(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
