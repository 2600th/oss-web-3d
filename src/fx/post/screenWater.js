import * as THREE from 'three/webgpu';
import {
  Fn, float, vec2, vec3, vec4, uv, uniform, texture, max, min, mix, clamp, smoothstep, length, dot,
  fract, sin, floor, exp, abs, sign, normalize, select, sqrt,
  hash as pcgHash,
} from 'three/tsl';

/**
 * Water on the lens (chase views) or the canopy (cockpit), simulated on the
 * GPU in a small ping-pong target and composited by PostFX's final pass.
 *
 * State texel (rgba16f):
 *   r  water thickness: beads, runs, rivulets (> ~0.15 reads as a drop)
 *   g  wet trail left behind where water moved (thin film; dries)
 *   b  condensation fog film (in cloud; wiped by the airflow and by runs)
 *
 * Each frame: new drops land (hashed per screen cell, rate from waterModel),
 * water above the cling threshold is advected along the local airflow
 * (lens: outward and mostly sideways; canopy: up and back around the
 * frame) or, at low speed, slides with gravity; fast flow stretches runs into
 * streaks; everything evaporates; the fog film builds toward its target and
 * is wiped by speed and by passing water.
 *
 * Runs on both backends (QuadMesh + render targets, no compute).
 */
const hash12 = (p) => fract(sin(dot(p, vec2(127.1, 311.7))).mul(43758.5453));
const hash22 = (p) => fract(sin(vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)))).mul(43758.5453));

export class ScreenWater {
  constructor({ width = 480, height = 270 } = {}) {
    this.width = width;
    this.height = height;
    const opts = { type: THREE.HalfFloatType, depthBuffer: false, magFilter: THREE.LinearFilter, minFilter: THREE.LinearFilter };
    this.rt = [new THREE.RenderTarget(width, height, opts), new THREE.RenderTarget(width, height, opts)];
    this.rt[0].texture.name = 'ScreenWater.a';
    this.rt[1].texture.name = 'ScreenWater.b';
    this.idx = 0;
    this.active = false;
    this._clear = true;
    this._idleTime = 0;

    const u = this.u = {
      dt: uniform(1 / 60),
      seed: uniform(0),
      aspect: uniform(16 / 9),
      rateSmall: uniform(0),
      rateBig: uniform(0),
      flow: uniform(0),
      canopy: uniform(0),
      gravity: uniform(new THREE.Vector2(0, 0.08)),
      stick: uniform(0.5),
      evap: uniform(0.05),
      fogTarget: uniform(0),
      fogRate: uniform(1),
      wipe: uniform(0.2),
      clear: uniform(0),
      texel: uniform(new THREE.Vector2(1 / width, 1 / height)),
    };
    this.prevTex = texture(this.rt[1].texture);
    /** Read by the composite (swapped each frame). */
    this.texture = texture(this.rt[0].texture);

    const material = new THREE.NodeMaterial();
    material.fragmentNode = this._simulate();
    material.depthTest = false;
    material.depthWrite = false;
    this.quad = new THREE.QuadMesh(material);
    this.quad.name = 'ScreenWater.sim';
    this._state = undefined;
  }

  /** Local airflow on the glass, in uv/s at full flow (uv y points down). */
  _flowDir(st) {
    const u = this.u;
    const c = st.sub(0.5).mul(vec2(u.aspect, 1));
    // lens: air parts around the housing — outward, mostly sideways
    // (a gentle wobble so runs meander instead of ruling straight lines)
    const wob = sin(st.x.mul(23.0).add(st.y.mul(41.0))).mul(0.09).add(sin(st.y.mul(17.0).sub(st.x.mul(9.0))).mul(0.07));
    const lens = normalize(vec2(c.x.add(sign(c.x).mul(0.12)), c.y.mul(0.5).add(wob)).add(vec2(1e-4, 0)));
    // canopy: up the windscreen, then back around the curve of the canopy
    const canopy = normalize(vec2(c.x.mul(1.4), float(-1.0).sub(abs(c.x).mul(0.3))));
    return mix(lens, canopy, u.canopy);
  }

  _simulate() {
    const u = this.u;
    const prev = this.prevTex;
    return Fn(() => {
      const st = uv();
      const s0 = prev.sample(st);
      const h = s0.r;
      const k = u.flow;
      const maxStep = min(u.texel.x, u.texel.y).mul(3);
      // per-frame displacement of mobile water at p, in texels: airflow at
      // speed, gravity when slow; capped at ~3 texels so drops stay drops
      const dispAt = (p) => {
        const dir = this._flowDir(p);
        // a forward-facing lens has a stagnation point in the middle: water
        // there lingers and beads, and is flung off faster toward the rim;
        // on the canopy the stream is fast everywhere
        const rr = length(p.sub(0.5).mul(vec2(u.aspect, 1)));
        const lensSpeed = smoothstep(0.04, 0.75, rr).mul(1.7).add(0.35);
        const flowSpeed = mix(lensSpeed, float(2.2), u.canopy);
        const vel = dir.mul(k.mul(k).mul(flowSpeed)).add(u.gravity.mul(float(1).sub(k)));
        const step = vel.mul(u.dt);
        return step.mul(min(float(1), maxStep.div(length(step).max(1e-6)))).div(u.texel);
      };
      const mob = (x) => smoothstep(u.stick, u.stick.mul(1.9).add(0.05), x);
      const m0 = mob(h);
      // Semi-Lagrangian transport of the mobile part: one tap back along the
      // path. (A max over several taps along the path drew nicer streaks but
      // is not conservative: drops grew by the extra path length every frame
      // until the glass was one sheet.) The streak a running drop leaves is
      // the trail channel below.
      // Whole-texel steps: a fractional bilinear shift every frame would
      // diffuse a bead flat within a second. Sub-texel motion (slow creep) is
      // kept by stochastic rounding with one random offset per frame for the
      // whole glass, so every texel of a drop moves together.
      const inTex = dispAt(st);
      const r01 = hash22(vec2(u.seed.mul(0.731), u.seed.mul(0.277).add(1.3)));
      const back = floor(inTex.add(r01)).mul(u.texel);
      // The airflow fans out from the stagnation point (divergent): advected
      // as-is, every drop would be stretched over a growing area at full
      // height, so water would multiply. Thin it by the local stretch instead
      // (volume kept; stretched water drops below bead height and is stripped).
      const tx = vec2(u.texel.x, 0), ty = vec2(0, u.texel.y);
      const div = dispAt(st.add(tx)).x.sub(dispAt(st.sub(tx)).x)
        .add(dispAt(st.add(ty)).y.sub(dispAt(st.sub(ty)).y)).mul(0.5);
      // (never thickened where the flow converges: with whole-texel steps that
      // compression is not exact, and any gain there compounds every frame)
      const keep = clamp(float(1).sub(div), 0.5, 1);
      const inside = (q) => select(q.x.greaterThan(0).and(q.x.lessThan(1)).and(q.y.greaterThan(0)).and(q.y.lessThan(1)), float(1), float(0));
      const q1 = st.sub(back);
      const hq = prev.sample(q1).r;
      const arrive = hq.mul(mob(hq)).mul(inside(q1)).mul(keep);
      // what stays: beads cling; running water thins a little as it goes
      let hn = h.mul(float(1).sub(m0)).add(arrive.mul(0.99));

      // new drops: small (mist / drizzle) and big (rain), one candidate per cell
      const asp = vec2(u.aspect, 1);
      // `rate` is drops/s over the whole glass: per cell = rate / cell count
      const drop = (cells, rate, rMin, rMax, amp) => {
        const g = st.mul(asp).mul(cells);
        rate = rate.div(u.aspect.mul(cells * cells));
        const cell = floor(g);
        // spawn test needs a well-resolved uniform: per-cell odds per frame
        // are ~1e-4, and the sin-hash is quantised (~1/256 steps near 0), so
        // with it every cell spawned at its floor rate and water never dried
        const salt = float(cells * 7.31);
        const r = fract(pcgHash(cell.x.add(cell.y.mul(173)).add(salt)).add(pcgHash(u.seed.add(salt.mul(13)))));
        const spawn = r.lessThan(rate.mul(u.dt));
        const ctr = hash22(cell.add(u.seed.mul(vec2(0.311, 0.173)))).mul(0.6).add(0.2);
        const rad = mix(float(rMin), float(rMax), hash12(cell.add(u.seed.mul(0.0911)).add(7.1)));
        const d = length(g.sub(cell).sub(ctr)).div(rad);
        const prof = sqrt(clamp(float(1).sub(d.mul(d)), 0, 1)).mul(amp);
        return select(spawn, prof, float(0));
      };
      hn = hn.add(drop(22, u.rateSmall, 0.2, 0.4, 0.55));
      hn = hn.add(drop(11, u.rateBig, 0.18, 0.36, 0.95));
      // the airflow strips the thin film below bead height that every
      // moving drop leaves at its edges; otherwise that residue pools into
      // one flat sheet whose edge reads as a contour line on the lens
      const strip = float(1).sub(smoothstep(0.0, u.stick, hn)).mul(k).mul(0.5);
      hn = max(hn.sub(u.evap.add(strip).mul(u.dt)), 0).min(1.6);

      // trail: wet film where water ran, dries over a few seconds
      const moving = max(h.mul(m0), arrive);
      const trail = max(s0.g.mul(exp(u.dt.mul(-0.9))).sub(u.evap.mul(u.dt).mul(0.5)), moving.mul(0.35)).clamp(0, 1);

      // fog film: builds toward the target; airflow wipes it (harder in the
      // middle of the glass), passing water clears a lane through it
      const r = length(st.sub(0.5).mul(asp));
      const fogUp = s0.b.add(u.fogTarget.sub(s0.b).max(0).mul(float(1).sub(exp(u.dt.mul(u.fogRate).negate()))));
      const fogDown = s0.b.mul(exp(u.dt.mul(u.wipe).mul(float(1.25).sub(r)).negate()));
      let fog = select(u.fogTarget.greaterThan(s0.b), mix(fogUp, fogDown, k.mul(0.6)), fogDown);
      fog = fog.mul(float(1).sub(clamp(moving.mul(2.5), 0, 0.9)));

      const out = vec4(hn, trail, fog.clamp(0, 1), 1);
      return select(u.clear.greaterThan(0.5), vec4(0, 0, 0, 1), out);
    })();
  }

  /**
   * @param renderer WebGPURenderer
   * @param {number} dt real seconds
   * @param {object} d drivers from waterModel.waterDrivers + { surface, gravity:[x,y], aspect }
   */
  update(renderer, dt, d) {
    const u = this.u;
    const wetNow = d && (d.rateSmall > 0 || d.rateBig > 0 || d.fogTarget > 0);
    // Skip the pass entirely once the glass has been dry for a while.
    if (wetNow) this._idleTime = 0; else this._idleTime += dt;
    this.active = this._idleTime < 30;
    if (!this.active && !this._clear) return;
    u.dt.value = Math.min(dt, 1 / 20);
    u.seed.value = (u.seed.value + 1) % 4096;
    u.aspect.value = d?.aspect ?? 16 / 9;
    u.rateSmall.value = d?.rateSmall ?? 0;
    u.rateBig.value = d?.rateBig ?? 0;
    u.flow.value = d?.flow ?? 0;
    u.canopy.value += ((d?.surface === 'canopy' ? 1 : 0) - u.canopy.value) * Math.min(1, dt * 6);
    if (d?.gravity) u.gravity.value.set(d.gravity[0], d.gravity[1]);
    u.stick.value = d?.stick ?? 0.5;
    u.evap.value = d?.evap ?? 0.3;
    u.fogTarget.value = d?.fogTarget ?? 0;
    u.fogRate.value = d?.fogRate ?? 1;
    u.wipe.value = d?.wipe ?? 1;
    u.clear.value = this._clear ? 1 : 0;
    this._clear = false;

    const src = this.rt[this.idx];
    const dst = this.rt[1 - this.idx];
    this.prevTex.value = src.texture;
    this._state = THREE.RendererUtils.resetRendererState(renderer, this._state);
    renderer.setRenderTarget(dst);
    this.quad.render(renderer);
    THREE.RendererUtils.restoreRendererState(renderer, this._state);
    this.idx = 1 - this.idx;
    this.texture.value = dst.texture;
  }

  /** Wipe the glass (view change between lens and canopy, respawn). */
  clear() { this._clear = true; this._idleTime = 0; }

  dispose() {
    for (const r of this.rt) r.dispose();
    this.quad.material.dispose();
  }
}

/**
 * Composite helpers (TSL), used by PostFX's final pass.
 * `w` = water texture node, `st` = screen uv. Returns { offset, mask, spec,
 * rim, fog, trail } — refraction offset (uv) and shading terms.
 */
export function waterShading(w, st, texel, aspect) {
  const c = w.sample(st);
  const e = texel.mul(1.5);
  const sx1 = w.sample(st.add(vec2(e.x, 0)));
  const sx0 = w.sample(st.sub(vec2(e.x, 0)));
  const sy1 = w.sample(st.add(vec2(0, e.y)));
  const sy0 = w.sample(st.sub(vec2(0, e.y)));
  const hx1 = sx1.r, hx0 = sx0.r, hy1 = sy1.r, hy0 = sy0.r;
  const grad = vec2(hx1.sub(hx0), hy1.sub(hy0));
  // the wet trail a running drop leaves is a thin rivulet: it bends light a
  // little along its edges (its own gradient) and catches a glint
  const tgrad = vec2(sx1.g.sub(sx0.g), sy1.g.sub(sy0.g));
  const h = c.r.add(hx1).add(hx0).add(hy1).add(hy0).div(5);
  const mask = smoothstep(0.1, 0.26, h);
  // a drop is a small fish-eye lens: it inverts and shrinks what is behind
  // it (offset toward the drop's own gradient)
  const offset = grad.mul(-0.065).mul(mask).add(tgrad.mul(-0.03));
  const n = normalize(vec3(grad.add(tgrad.mul(0.5)).mul(vec2(-6, 6)), 1));
  const L = normalize(vec3(-0.35, 0.6, 0.72));
  const spec = max(dot(n, L), 0).pow(28).mul(max(mask, smoothstep(0.05, 0.2, c.g).mul(0.5)));
  // a thin dark meniscus only at the very edge of a bead (where it is
  // thin and steep); the body of the drop gathers light and reads brighter
  const g = length(grad);
  const rim = smoothstep(0.06, 0.22, g).mul(float(1).sub(smoothstep(0.18, 0.42, h))).mul(mask).mul(0.16);
  const body = mask.mul(smoothstep(0.2, 0.5, h)).mul(0.07);
  return { offset, mask, spec, rim, body, fog: c.b, trail: c.g, aspect };
}

