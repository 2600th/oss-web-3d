import * as THREE from 'three/webgpu';
import {
  pass, mrt, output, velocity, renderOutput, uniform, vec2, vec3, vec4, uv, float, texture,
  convertToTexture, rtt, Fn, Loop, luminance, log2, max, mix, smoothstep, length, dot,
  positionWorld, int, ivec2, select, screenSize,
} from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { fxaa } from 'three/addons/tsl/display/FXAANode.js';
import { smaa } from 'three/addons/tsl/display/SMAANode.js';
import { traa } from 'three/addons/tsl/display/TRAANode.js';
import { dof } from 'three/addons/tsl/display/DepthOfFieldNode.js';
import { postConfig } from '../fx/post/config.js';
import {
  sunVisibility, sunFlare, sunGlow, agxLook, splitTone, screenStates, filmGrain, aspectUV,
  reversedDepthToDistance, airflowStreaks, shockOffset,
} from '../fx/post/nodes.js';
import { createMotionBlur } from '../fx/post/motionBlur.js';
import { ScreenWater, waterShading } from '../fx/post/screenWater.js';
import { EXPOSURE_DEFAULTS, targetExposureEV, adaptLog2, evToMultiplier } from '../fx/post/exposure.js';
import { motionBlurParams } from '../fx/post/motionParams.js';
import { createLensDirtTexture, createFrostTexture } from '../fx/post/textures.js';

const _v = new THREE.Vector3();
/** Auto-exposure metering interval in frames (15 Hz at 60 fps). */
const METER_EVERY = 4;
const _m = new THREE.Matrix4();

/**
 * Post-processing chain (TSL RenderPipeline), quality-tiered (src/fx/post/config.js).
 *
 *   scene pass (HDR colour + velocity MRT + reversed depth)
 *   -> scene stages (addSceneStage: atmosphere 20, clouds 30, VFX 55, heat 60 ...)
 *   -> AA: TRAA (medium+) on HDR
 *   -> reconstruction motion blur (medium+; src/fx/post/motionBlur.js):
 *      tile-max / neighbour-max, jittered depth-aware gather, player shutter,
 *      speed zoom near the ground
 *   -> [cinematic only] bokeh depth of field (three DepthOfFieldNode, gated)
 *   -> [meters] auto-exposure (64x36 log-lum -> 1x1, read back, adapted on CPU)
 *               sun occlusion (n x n depth+luminance taps -> 1x1)
 *   -> final pass: screen water (lens / canopy drops, runs, fog film; GPU sim
 *      in src/fx/post/screenWater.js), frost rim, sonic shock ripple,
 *      sharpen + chromatic aberration, exposure, bloom, airflow streaks,
 *      sun flare (ghosts/halo/starburst/anamorphic streak), lens dirt, flash,
 *      AgX + "Kargil" look, split tone, G/damage screen states, vignette,
 *      sRGB, [FXAA/SMAA on low], film grain
 *
 * Public surface (kept): render(), dispose(), uniforms, scenePass,
 *   addSceneStage(fn, order) — HDR compositing hook, ctx =
 *   { scenePass, depth (reversed-Z texture node), velocity, camera, renderer }.
 *   setFrameState(state), notifyCut(), options, debugView, stats.
 * Added: usePlayerVelocity(material), water (ScreenWater).
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
      /** screen water (droplets, runs, fog film, frost) */
      screenWater: true,
      /** airflow streaks at transonic speed */
      speedStreaks: true,
      /** depth of field in cinematic / kill cams (camera system drives the amount) */
      dof: true,
      exposure: { ...EXPOSURE_DEFAULTS },
    };

    const u = (v) => uniform(v);
    this.uniforms = {
      // applied linear exposure (auto-exposure writes it every frame)
      exposure: u(evToMultiplier(EXPOSURE_DEFAULTS.baseEV)),
      bloomStrength: u(0.05),
      bloomCap: u(40), // pre-exposure; set from bloomCapExposed each frame
      // motion blur
      mbStrength: u(0),
      mbMaxPx: u(32),
      playerShutter: u(0.12),
      nearShell: u(0),
      zoom: u(0),
      focus: u(new THREE.Vector2(0.5, 0.5)),
      res: u(new THREE.Vector2(1920, 1080)),
      frameOffset: u(new THREE.Vector2(0, 0)),
      speedBlur: u(0), // legacy name, kept: mirrors `zoom`
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
      vignette: u(0.22),
      lookSlope: u(new THREE.Vector3(1.0, 0.99, 0.965)),
      lookPower: u(new THREE.Vector3(1.12, 1.12, 1.14)),
      lookSat: u(1.18),
      shadowTint: u(new THREE.Vector3(0.965, 0.995, 1.05)),
      highlightTint: u(new THREE.Vector3(1.035, 1.0, 0.95)),
      toneBalance: u(0.42),
      grey: u(0), red: u(0), damage: u(0), smear: u(0), lowHealth: u(0), flash: u(0), wet: u(0),
      // water / frost / speed
      waterOn: u(0), waterMinDist: u(0), frost: u(0),
      streaks: u(0), streakTime: u(0), shock: u(new THREE.Vector2(0, 0)),
      // depth of field
      dofAmount: u(0), dofFocus: u(50), dofFocal: u(30), dofBokeh: u(1.5),
      seed: u(0),
    };

    /** Bloom in *exposed* units (the chain rescales by exposure each frame). */
    this.bloomSettings = { threshold: 1.25, knee: 1.6, cap: 20 };
    this.stages = [];
    this.stats = { avgLog2: NaN, adaptedLog2: NaN, ev: EXPOSURE_DEFAULTS.baseEV, sunVisibility: 0, sunLum: 0 };
    this.debugView = null;
    this._frame = { airspeed: 0, sunDirection: null, sunIntensity: 1 };
    this._cutFrames = 0;
    this._dtAvg = 1 / 60;
    this._last = 0;
    this._reading = false;

    this.lensDirt = createLensDirtTexture();
    this.frostTex = createFrostTexture();
    this.water = null; // ScreenWater, created per tier in _build

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

  /**
   * Tag an opaque material as the player's airframe: velocity MRT .z = 1. The
   * motion blur gives tagged pixels the short "player shutter" (the jet rides
   * with the camera; only its own rotation against the lens should smear,
   * and only a little). TRAA reads .xy only, so reprojection is unaffected.
   */
  usePlayerVelocity(material) {
    if (!material || material.mrtNode || material.transparent) return;
    material.mrtNode = mrt({ velocity: vec4(velocity, 1, 1) });
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
    const keepList = []; // render-to-texture bases, in dependency order

    let color = sp.getTextureNode('output');
    for (const s of this.stages) color = s.fn(color, ctx);
    const hdr = convertToTexture(color); // no extra pass when there are no stages
    keepList.push(hdr);

    // --- anti-aliasing (HDR, temporal) ------------------------------------
    let aa = hdr;
    this.traa = null;
    if (cfg.aa === 'traa') {
      this.traa = traa(hdr, depth, vel, camera);
      aa = this.traa.getTextureNode();
    }

    // --- motion blur --------------------------------------------------------
    let mb = aa;
    this._mb = null;
    if (cfg.mbSamples > 0) {
      const m = createMotionBlur({
        color: aa, velocity: vel, depth, near: u.near, far: u.far, samples: cfg.mbSamples, tile: cfg.mbTile,
        u: {
          strength: u.mbStrength, maxPx: u.mbMaxPx, playerShutter: u.playerShutter, nearShell: u.nearShell,
          zoom: u.zoom, focus: u.focus, res: u.res, frameOffset: u.frameOffset,
        },
      });
      this._mb = m;
      keepList.push(m.prep, m.tile4, m.tileMax, m.neighbor, m.output);
      mb = m.output;
    }

    // --- depth of field (cinematic / kill cam only; passes skipped when off) --
    this._dof = null;
    let dofTex = null;
    if (cfg.dof) {
      const viewZ = reversedDepthToDistance(depth.sample(uv()).x, u.near, u.far).negate();
      const d = dof(mb, viewZ, u.dofFocus, u.dofFocal, u.dofBokeh);
      const run = d.updateBefore.bind(d);
      d.updateBefore = (frame) => { if (u.dofAmount.value > 0.001) run(frame); };
      this._dof = d;
      dofTex = d.getTextureNode();
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
    keepList.push(meter2);

    const visNode = rtt(sunVisibility({
      color: hdr, depth, sunUV: u.sunUV, aspect: u.aspect, radius: float(0.022),
      refLum: u.sunRefLum, grid: cfg.flareGrid,
    }), 1, 1, { type: THREE.FloatType });
    visNode.name = 'SunVisibility';
    this._vis = visNode;
    const vis = visNode.x; // 1x1 target: the node's own uv() samples the only texel

    // --- screen water (GPU sim, updated in render() before the pipeline) ---
    if (cfg.water) {
      const [ww, wh] = cfg.water;
      if (!this.water || this.water.width !== ww) {
        this.water?.dispose();
        this.water = new ScreenWater({ width: ww, height: wh });
      }
    } else if (this.water) { this.water.dispose(); this.water = null; }

    // --- final composite ------------------------------------------------------
    const uv0 = uv();
    const aspect = u.aspect;
    const rNorm = length(uv0.sub(0.5).mul(vec2(aspect, 1))).div(length(vec2(aspect, 1).mul(0.5)));
    const px = vec2(1).div(screenSize);

    let suv = uv0;
    let ws = null;
    let waterMask = float(0);
    if (this.water) {
      ws = waterShading(this.water.texture, uv0, this.water.u.texel, aspect);
      // canopy water sits on the glass: never over the cockpit interior
      const dist = reversedDepthToDistance(depth.sample(uv0).x, u.near, u.far);
      waterMask = u.waterOn.mul(smoothstep(u.waterMinDist, u.waterMinDist.mul(1.15).add(0.01), dist));
      const wuv = suv.add(ws.offset.mul(waterMask));
      // a drop on the canopy must not refract the cockpit frame into the sky:
      // if the bent ray lands on the interior, look straight through instead
      const dBent = reversedDepthToDistance(depth.sample(wuv).x, u.near, u.far);
      suv = select(dBent.lessThan(u.waterMinDist.mul(1.1)), suv, wuv);
    }
    // sonic shock: a single expanding ripple from the flight-path focus
    suv = suv.add(shockOffset(uv0, u.focus, aspect, u.shock));

    const centred = suv.sub(0.5);
    const c0 = mb.sample(suv);
    let rgb = c0.rgb;
    if (cfg.sharpen > 0) {
      // contrast-adaptive (clamped) unsharp mask on luminance: restores TAA
      // softness without halos or colour fringes
      const n = mb.sample(suv.add(vec2(0, px.y))).rgb;
      const s = mb.sample(suv.sub(vec2(0, px.y))).rgb;
      const e = mb.sample(suv.add(vec2(px.x, 0))).rgb;
      const w = mb.sample(suv.sub(vec2(px.x, 0))).rgb;
      const lc = luminance(rgb);
      const ln = luminance(n), ls = luminance(s), le = luminance(e), lw = luminance(w);
      const mn = ln.min(ls).min(le).min(lw).min(lc);
      const mx = ln.max(ls).max(le).max(lw).max(lc);
      const sharp = lc.add(lc.sub(ln.add(ls).add(le).add(lw).mul(0.25)).mul(u.sharpen)).clamp(mn, mx);
      rgb = rgb.mul(sharp.div(max(lc, 1e-5)));
    }
    if (cfg.chromatic > 0) {
      // lateral CA grows with r^2 (only really visible in the corners);
      // spikes with a hit (smear)
      const amt = u.chromatic.mul(0.0011).add(u.smear.mul(0.012));
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
    if (dofTex) rgb = mix(rgb, dofTex.sample(suv).rgb, u.dofAmount);

    if (ws) {
      // out-of-focus scene behind drops and fog (4-tap disc, ~6 px)
      const rr = px.mul(6);
      const blurred = mb.sample(suv.add(vec2(rr.x, rr.y))).rgb
        .add(mb.sample(suv.add(vec2(rr.x.negate(), rr.y.mul(0.4)))).rgb)
        .add(mb.sample(suv.add(vec2(rr.x.mul(0.4), rr.y.negate()))).rgb)
        .add(mb.sample(suv.sub(vec2(rr.x.mul(0.8), rr.y.mul(0.9)))).rgb)
        .mul(0.25);
      const fog = ws.fog.mul(waterMask);
      const soft = ws.mask.mul(0.55).add(fog.mul(0.9)).add(ws.trail.mul(0.25)).mul(waterMask).clamp(0, 1);
      rgb = mix(rgb, blurred, soft);
      // the film scatters: lifts and greys what is behind it
      const veil = vec3(luminance(blurred)).mul(vec3(0.97, 1.0, 1.04)).mul(1.12);
      rgb = mix(rgb, veil, fog.mul(0.45));
      rgb = rgb.mul(float(1).sub(ws.rim.mul(waterMask)).add(ws.body.mul(waterMask)));
      // frost rim: rime creeps in from the frame edge (cold cloud, altitude)
      const fn = texture(this.frostTex, aspectUV(uv0, aspect).mul(1.7)).r;
      const edge = smoothstep(float(1).sub(u.frost.mul(0.6)), float(1.15).sub(u.frost.mul(0.45)), rNorm.add(fn.sub(0.5).mul(0.3)));
      const rime = edge.mul(u.frost).mul(mix(0.55, 1.0, fn));
      rgb = mix(rgb, blurred.mul(vec3(1.02, 1.08, 1.16)).add(vec3(luminance(blurred).mul(0.25))), rime.clamp(0, 0.85));
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

    // airflow streaks: faint condensation lines whipping past at transonic
    // speed, lit by the scene behind them (never a fixed white overlay)
    if (cfg.streaks) {
      const st = airflowStreaks(uv0, u.focus, aspect, u.streakTime);
      x = x.add(vec3(luminance(x).mul(0.22).add(0.015)).mul(st).mul(u.streaks));
    }

    if (cfg.flare) {
      const amount = vis.mul(u.sunAmount);
      x = x.add(sunFlare(uv0, u.sunUV, aspect, amount, u.flareRot));
      if (cfg.dirt) {
        const dirt = texture(this.lensDirt, uv0).rgb;
        // dirt lights only under bright sources: the sun's glow and the
        // part of the bloom above a floor (a bright sky alone does not)
        const reveal = sunGlow(uv0, u.sunUV, aspect).mul(amount).mul(0.45);
        const fromBloom = bloomTex ? max(luminance(bloomTex.rgb.mul(u.exposure)).sub(0.04), 0).mul(0.7) : float(0);
        x = x.add(dirt.mul(reveal.add(fromBloom)).mul(u.dirt));
      }
    }
    // water glints + flash whiteout (HDR, so it rolls off through AgX)
    if (ws) x = x.add(vec3(ws.spec.mul(waterMask).mul(luminance(x).mul(0.8).add(0.08))));
    x = x.add(vec3(1.0, 0.95, 0.86).mul(u.flash.mul(u.flash).mul(6)));

    let ldr = agxLook(x, u.lookSlope, u.lookPower, u.lookSat);
    ldr = splitTone(ldr, u.shadowTint, u.highlightTint, u.toneBalance);
    ldr = screenStates(ldr, rNorm, u.grey, u.red, u.damage, u.lowHealth);
    // natural (cos^4-like) lens falloff, mostly in the corners
    ldr = ldr.mul(float(1).sub(u.vignette.mul(smoothstep(0.45, 1.25, rNorm).pow(1.5))));

    // Built first so the base render-to-texture nodes are scheduled (in this
    // order) before anything that samples them: the HDR composite, the meters.
    let keep = float(0);
    for (const k of keepList) keep = keep.add(keepAlive(k));
    if (this._dof) keep = keep.add(keepAlive(this._dof));
    let out = renderOutput(vec4(vec3(keep).add(ldr), 1), THREE.NoToneMapping, THREE.SRGBColorSpace);
    if (cfg.aa === 'fxaa') out = fxaa(out);
    else if (cfg.aa === 'smaa') out = smaa(out);
    if (cfg.grain > 0) out = vec4(filmGrain(out.rgb, u.grain.mul(0.014 * cfg.grain), u.seed), 1);

    // dev views: post.debugView = 'velocity' | 'depth' | 'exposure' | 'flare' | 'bloom'
    //            | 'mbTiles' | 'player' | 'water'
    if (this.debugView === 'velocity') out = vec4(vel.sample(uv0).xy.mul(40).add(0.5), 0.5, 1);
    else if (this.debugView === 'player') out = vec4(vel.sample(uv0).z, this._mb ? this._mb.prep.sample(uv0).w : 0, 0, 1);
    else if (this.debugView === 'mbTiles' && this._mb) out = vec4(this._mb.neighbor.sample(uv0).xy.div(u.mbMaxPx).mul(0.5).add(0.5), 0.5, 1);
    else if (this.debugView === 'water' && this.water) out = vec4(this.water.texture.sample(uv0).rgb, 1);
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
    const renderer = this.r.renderer;
    const size = renderer.getDrawingBufferSize?.(_size) ?? _size.set(1920, 1080);
    u.res.value.set(size.x, size.y);

    // static-velocity matrices (unjittered: TRAA jitters inside pipeline.render)
    _m.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    if (!this._vpPrimed || this._cutFrames > 0) { this._prevVP.value.copy(_m); this._vpPrimed = true; }
    else this._prevVP.value.copy(this._curVP.value);
    this._curVP.value.copy(_m);

    // flight-path focus on screen (speed zoom, streaks, shock): the point the
    // world streams out of. Falls back to the centre when it is off-screen.
    const f = this._frame;
    let fx = 0.5, fy = 0.5;
    if (f.flightDir) {
      _v.copy(f.flightDir).transformDirection(cam.matrixWorldInverse);
      if (_v.z < -0.2) {
        _v.copy(cam.position).addScaledVector(f.flightDir, 1e4).project(cam);
        fx = Math.min(0.85, Math.max(0.15, _v.x * 0.5 + 0.5));
        fy = Math.min(0.85, Math.max(0.15, 0.5 - _v.y * 0.5));
      }
    }
    const fu = u.focus.value;
    fu.x += (fx - fu.x) * 0.25;
    fu.y += (fy - fu.y) * 0.25;

    // sun on screen
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
    const f = this._frame;
    this._dtAvg += (dt - this._dtAvg) * 0.1;
    const cut = this._cutFrames > 0;
    if (cut) this._cutFrames--;
    const p = motionBlurParams({
      dt: this._dtAvg, airspeed: f.airspeed ?? 0, agl: f.agl ?? 1e4, mach: f.mach ?? 0, reheat: !!f.reheat,
      user: o.motionBlur, reducedMotion: o.reducedMotion, cut, view: f.view ?? 'chase', tile: this.cfg?.mbTile ?? 32,
      pixelRatio: this.r.renderer.getPixelRatio?.() ?? 1,
    });
    u.mbStrength.value = p.strength;
    u.mbMaxPx.value = p.maxPx;
    u.zoom.value = p.zoom;
    u.speedBlur.value = p.zoom;
    u.playerShutter.value = p.playerShutter;
    u.nearShell.value = f.nearShell ?? 0;
    this._frameIdx = ((this._frameIdx ?? 0) + 1) % 8;
    u.frameOffset.value.set(this._frameIdx * 5.588238, this._frameIdx * 5.588238);
    u.seed.value = (u.seed.value + 1) % 997;

    // airflow streaks + sonic shock ripple
    u.streaks.value = o.speedStreaks && !o.reducedMotion ? (f.streaks ?? 0) : 0;
    u.streakTime.value = (u.streakTime.value + dt) % 1000;
    const sh = f.shock ?? 0; // 0..1 phase of the ripple (camera system)
    u.shock.value.set(sh, o.reducedMotion ? 0 : (f.shockAmp ?? 0));
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

  _applyLens(dt) {
    const u = this.uniforms;
    const f = this._frame;
    // depth of field: cinematic and kill cams only
    const d = this.options.dof ? f.dof : null;
    const target = d?.amount ?? 0;
    u.dofAmount.value += (target - u.dofAmount.value) * Math.min(1, dt * 5);
    if (u.dofAmount.value < 0.002 && target === 0) u.dofAmount.value = 0;
    if (d) {
      u.dofFocus.value = d.focus ?? u.dofFocus.value;
      u.dofFocal.value = d.focal ?? Math.max(4, (d.focus ?? 50) * 0.6);
      u.dofBokeh.value = d.bokeh ?? 1.5;
    }
    // screen water
    const w = this.water;
    if (w) {
      const on = this.options.screenWater ? (f.water ?? null) : null;
      if (f.waterSurface !== this._waterSurface) {
        if (this._waterSurface && f.waterSurface && f.waterSurface !== 'none') w.clear();
        this._waterSurface = f.waterSurface;
      }
      w.update(this.r.renderer, dt, on && { ...on, aspect: u.aspect.value });
      u.waterOn.value = on && w.active ? 1 : 0;
      u.waterMinDist.value = f.waterSurface === 'canopy' ? 2.4 : 0;
      u.frost.value = on ? (on.frost ?? 0) : 0;
    } else {
      u.waterOn.value = 0;
    }
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
    this._applyLens(dt);
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
    this.frostTex.dispose();
    this.water?.dispose();
  }
}

const _size = new THREE.Vector2();

/** A zero that references a texture node's *base* so its render is scheduled. */
function keepAlive(node) { return node.x.mul(0); }

function smoothstepJS(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
