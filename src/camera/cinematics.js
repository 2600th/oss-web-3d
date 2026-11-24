import * as THREE from 'three/webgpu';
import { clamp, easeInOut, noise1, smoothstep } from './cameraMath.js';
import { terrainHeight } from '../world/terrain/heightfield.js';

const _f = new THREE.Vector3();
const _r = new THREE.Vector3();
const _u = new THREE.Vector3();
const _h = new THREE.Vector3();
const _s = new THREE.Vector3();
const WORLD_UP = new THREE.Vector3(0, 1, 0);

/**
 * Cinematic camera paths for title screens, mission intros and replays.
 * `cameraRig.playCinematic(name, opts)` runs one; each path is
 *   { duration (s, Infinity = loop until stopped), init(ctx, opts) -> state,
 *     pose(t, state, ctx, out) }
 * ctx.focus = { position, orientation, velocity } of the subject (live).
 * out = { position, target, fov, roll, shift, cut, dof } is filled every frame:
 *   shift  horizontal composition offset (fraction of frame width; > 0 puts
 *          the subject right of centre, e.g. clear of a left-hand menu)
 *   cut    true on the frame a new shot starts (post suppresses blur/TAA)
 *   dof    { amount 0..1, focus m, focal m } or null
 */
function axes(focus) {
  _f.set(0, 0, -1).applyQuaternion(focus.orientation);
  _r.set(1, 0, 0).applyQuaternion(focus.orientation);
  _u.set(0, 1, 0).applyQuaternion(focus.orientation);
}

/** Level heading frame (no bank): _h = forward on the horizon, _s = right. */
function levelAxes(focus) {
  if (focus.velocity && focus.velocity.lengthSq() > 25) _h.copy(focus.velocity);
  else _h.set(0, 0, -1).applyQuaternion(focus.orientation);
  _h.y = 0;
  if (_h.lengthSq() < 1e-6) _h.set(0, 0, -1);
  _h.normalize();
  _s.crossVectors(_h, WORLD_UP).normalize();
}

function headingOf(focus) {
  axes(focus);
  return Math.atan2(_f.x, -_f.z);
}

const setDof = (out, amount, focus, focal) => {
  out.dof = out.dof ?? {};
  out.dof.amount = amount;
  out.dof.focus = focus;
  out.dof.focal = focal;
};

/** Keep a camera position clear of the ground. */
const clearGround = (p, margin = 6) => {
  const g = terrainHeight(p.x, p.z) + margin;
  if (p.y < g) p.y = g;
  return p;
};

/**
 * Title shots. Each: dur (s), init(state, focus) on entry, pose(tt, state,
 * focus, out). The sequence cuts between them (out.cut) like a trailer.
 */
const TITLE_SHOTS = [
  {
    // 1. low tracking shot: below and beside the jet, long lens looking up,
    //    the jet against sky with the ridge line under it
    dur: 8,
    init(s, f) { levelAxes(f); s.side = 1; },
    pose(tt, s, f, out) {
      levelAxes(f);
      const drift = tt * 0.9;
      out.position.copy(f.position).addScaledVector(_s, 46 * s.side).addScaledVector(_h, 14 - drift * 2.2).addScaledVector(WORLD_UP, -13);
      clearGround(out.position, 8);
      out.target.copy(f.position).addScaledVector(_h, 6);
      out.fov = 26 - tt * 0.4;
      out.roll = -0.05 * s.side;
      const d = out.position.distanceTo(f.position);
      setDof(out, 0.85, d, d * 6);
    },
  },
  {
    // 2. airshow pass: planted ahead of the flight path, the jet screams by
    dur: 5.5,
    init(s, f) {
      levelAxes(f);
      const speed = Math.max(f.velocity?.length?.() ?? 0, 150);
      s.anchor = f.position.clone().addScaledVector(_h, speed * 2.6).addScaledVector(_s, -30).addScaledVector(WORLD_UP, -9);
      clearGround(s.anchor, 5);
    },
    pose(tt, s, f, out) {
      out.position.copy(s.anchor);
      out.position.x += noise1(tt * 2.5, 1) * 0.12;
      out.position.y += noise1(tt * 2.5, 2) * 0.12;
      out.target.copy(f.position);
      const d = s.anchor.distanceTo(f.position);
      out.fov = clamp(10 + d * 0.05, 14, 58);
      out.roll = 0;
      setDof(out, 0.6, d, Math.max(30, d * 2));
    },
  },
  {
    // 3. high three-quarter orbit: the valley opening below
    dur: 9,
    init(s, f) { s.a0 = headingOf(f) + Math.PI * 0.8; },
    pose(tt, s, f, out) {
      const a = s.a0 + tt * 0.09;
      out.position.set(Math.sin(a) * 70, 26 + tt * 0.8, -Math.cos(a) * 70).add(f.position);
      clearGround(out.position, 10);
      out.target.copy(f.position).addScaledVector(WORLD_UP, -4);
      out.fov = 38;
      out.roll = 0.02;
      setDof(out, 0.35, out.position.distanceTo(f.position), 400);
    },
  },
  {
    // 4. long lens from far behind: compressed ridges stacked behind the jet
    dur: 7,
    init(s) { s.k = 0; },
    pose(tt, s, f, out) {
      levelAxes(f);
      out.position.copy(f.position).addScaledVector(_h, -260 + tt * 6).addScaledVector(_s, 18).addScaledVector(WORLD_UP, 9);
      clearGround(out.position, 8);
      out.target.copy(f.position).addScaledVector(_h, 120);
      out.fov = 9.5;
      out.roll = noise1(tt * 0.6, 3) * 0.01;
      const d = out.position.distanceTo(f.position);
      setDof(out, 0.5, d, d * 3);
    },
  },
];

/** Model-space point (m; nose -Z, up +Y, right +X) on the focus's airframe -> world. */
function bodyPoint(focus, p, out) {
  axes(focus);
  return out.copy(focus.position).addScaledVector(_r, p[0]).addScaledVector(_u, p[1]).addScaledVector(_f, -p[2]);
}

/**
 * A camera bolted to the airframe: `offset` and `look` are model-space points,
 * optionally drifting (m/s per axis) over the shot. The camera rolls with the
 * jet (out.up = the airframe's up), with a little buffet so it reads as
 * mounted, not floating. Wing-rail, over-the-shoulder, tail and nozzle shots.
 */
function mountPose(t, s, focus, out) {
  const o = s.offset, d = s.drift;
  const p = d ? [o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t] : o;
  bodyPoint(focus, p, out.position);
  bodyPoint(focus, s.look, out.target);
  out.up = (s.up ??= new THREE.Vector3()).copy(_u);
  const k = s.shake ?? 0.015;
  if (k) {
    out.position.addScaledVector(_r, noise1(t * 9, 11) * k).addScaledVector(_u, noise1(t * 9, 12) * k);
    out.target.addScaledVector(_u, noise1(t * 4, 13) * k * 6);
  }
  out.fov = s.fov ?? 55;
  out.roll = 0;
  if (s.dof) setDof(out, s.dof, out.position.distanceTo(focus.position), Math.max(20, out.position.distanceTo(out.target)));
}

const mountShot = (dur, opts) => ({
  dur,
  init(st) { Object.assign(st, opts, { up: null }); },
  pose(tt, st, f, out) { mountPose(tt, st, f, out); },
});

/**
 * In-flight cinematic camera (the director): cuts between shots that work
 * whatever the jet is doing, framed live around it. The player keeps flying.
 */
const DIRECTOR_SHOTS = [
  TITLE_SHOTS[0], // low tracking shot, long lens up at the jet
  mountShot(5, { offset: [3.3, -1.15, 4.6], look: [2.1, -1.3, -60], fov: 50, shake: 0.02 }), // under the wing, behind the rail missile
  TITLE_SHOTS[3], // long lens from far behind
  mountShot(5, { offset: [0.55, 0.95, -0.9], look: [0, 0.3, -80], fov: 66, shake: 0.008 }), // over the pilot's shoulder
  TITLE_SHOTS[1], // airshow pass
  mountShot(5, { offset: [-1.6, -0.4, -6.4], look: [0, -0.6, 6], fov: 60, shake: 0.015 }), // off the nose, looking back down the fuselage
  mountShot(5, { offset: [0, -2.4, 17], look: [0, -0.5, -40], fov: 44, shake: 0.03, dof: 0.4 }), // low behind the tail
  TITLE_SHOTS[2], // high three-quarter orbit
];

export const CINEMATICS = {
  /** Close, slow orbit around the jet: hangar-reveal energy. */
  orbit: {
    duration: Infinity,
    init: (ctx, o) => ({ a0: headingOf(ctx.focus) + Math.PI * 0.75, radius: o.radius ?? 26, speed: o.speed ?? 0.22 }),
    pose(t, s, ctx, out) {
      const a = s.a0 + t * s.speed;
      out.position.set(Math.sin(a) * s.radius, 5 + Math.sin(t * 0.3) * 2.5, -Math.cos(a) * s.radius).add(ctx.focus.position);
      out.target.copy(ctx.focus.position);
      out.fov = 48;
      out.roll = Math.sin(t * 0.21) * 0.03;
      setDof(out, 0.5, s.radius, s.radius * 4);
    },
  },

  /**
   * Title screen: a looping trailer of cuts — low tracking shot, airshow
   * pass, high orbit, long-lens tail chase — composed right of centre so the
   * menu on the left never sits on the jet (opts.shift to change).
   */
  title: {
    duration: Infinity,
    init: (ctx, o) => {
      const s = { shot: o.startShot ?? 0, t0: 0, shift: o.shift ?? 0.17, sub: {} };
      TITLE_SHOTS[s.shot].init(s.sub, ctx.focus);
      return s;
    },
    pose(t, s, ctx, out) {
      let shot = TITLE_SHOTS[s.shot];
      out.cut = false;
      if (t - s.t0 >= shot.dur) {
        s.shot = (s.shot + 1) % TITLE_SHOTS.length;
        s.t0 = t;
        s.sub = {};
        shot = TITLE_SHOTS[s.shot];
        shot.init(s.sub, ctx.focus);
        out.cut = true;
      }
      shot.pose(t - s.t0, s.sub, ctx.focus, out);
      out.shift = s.shift;
    },
  },

  /**
   * Airshow flyby: a fixed camera planted ahead of the flight path and a little
   * off to the side; it tracks the jet as it screams past, zooming as it nears.
   */
  flyby: {
    duration: 6,
    init(ctx, o) {
      axes(ctx.focus);
      const speed = Math.max(ctx.focus.velocity.length(), 120);
      const lead = speed * (o.lead ?? 2.6);
      const side = o.side ?? 38;
      const anchor = ctx.focus.position.clone().addScaledVector(_f, lead).addScaledVector(_r, side).addScaledVector(WORLD_UP, o.height ?? -6);
      return { anchor, duration: (lead * 2) / speed };
    },
    pose(t, s, ctx, out) {
      out.position.copy(s.anchor);
      out.position.x += noise1(t * 3, 1) * 0.15;
      out.position.y += noise1(t * 3, 2) * 0.15;
      out.target.copy(ctx.focus.position);
      const d = s.anchor.distanceTo(ctx.focus.position);
      out.fov = clamp(14 + d * 0.06, 16, 60);
      out.roll = 0;
      setDof(out, 0.5, d, Math.max(30, d * 2));
    },
  },

  /**
   * Airframe-mounted camera (see mountPose). opts: offset [x,y,z], look
   * [x,y,z] (model space), drift [dx,dy,dz] m/s, fov, shake (m), dof (0..1),
   * duration (Infinity: until stopped).
   */
  mount: {
    duration: Infinity,
    init: (ctx, o) => ({ offset: o.offset ?? [0, 2.4, 18], look: o.look ?? [0, 0, -40], drift: o.drift ?? null, fov: o.fov ?? 55, shake: o.shake ?? 0.015, dof: o.dof ?? 0, up: null }),
    pose(t, s, ctx, out) { mountPose(t, s, ctx.focus, out); },
  },

  /**
   * Cinematic camera in flight: cuts between DIRECTOR_SHOTS on their own
   * clock until stopped (the camera system toggles it; danger ends it).
   */
  director: {
    duration: Infinity,
    init: (ctx, o) => {
      const s = { shot: o.startShot ?? 0, t0: 0, sub: {} };
      DIRECTOR_SHOTS[s.shot].init(s.sub, ctx.focus);
      return s;
    },
    pose(t, s, ctx, out) {
      let shot = DIRECTOR_SHOTS[s.shot];
      out.cut = false;
      if (t - s.t0 >= shot.dur) {
        s.shot = (s.shot + 1) % DIRECTOR_SHOTS.length;
        s.t0 = t;
        s.sub = {};
        shot = DIRECTOR_SHOTS[s.shot];
        shot.init(s.sub, ctx.focus);
        out.cut = true;
      }
      shot.pose(t - s.t0, s.sub, ctx.focus, out);
      out.shift = 0;
    },
  },

  /** Reveal: start at the nose looking back at the pilot, swing out to the chase position. */
  reveal: {
    duration: 4.5,
    init: () => ({}),
    pose(t, s, ctx, out) {
      axes(ctx.focus);
      const k = easeInOut(t / 4.5);
      const ang = Math.PI * (1 - k); // front -> behind
      const radius = 9 + k * 9;
      const height = 1.2 + k * 2.4;
      out.position.copy(ctx.focus.position)
        .addScaledVector(_f, Math.cos(ang) * -radius)
        .addScaledVector(_r, Math.sin(ang) * radius * 0.6)
        .addScaledVector(_u, height);
      out.target.copy(ctx.focus.position).addScaledVector(_f, k * 40);
      out.fov = 50 + k * 12;
      out.roll = 0;
      setDof(out, 1 - k, radius, radius * 3);
    },
  },

  /**
   * Briefing -> sortie: the jet bursts past a camera planted low off its nose
   * (three-quarter front, long lens opening up), then the rig whips the lens
   * round into the chase position (playCinematic opts.blendOut).
   */
  sortie: {
    duration: 2.6,
    init(ctx) {
      levelAxes(ctx.focus);
      const speed = Math.max(ctx.focus.velocity?.length?.() ?? 0, 150);
      const anchor = ctx.focus.position.clone().addScaledVector(_h, speed * 1.55).addScaledVector(_s, 22).addScaledVector(WORLD_UP, -5);
      clearGround(anchor, 5);
      return { anchor };
    },
    pose(t, s, ctx, out) {
      // the camera pans with the jet and is dragged a little along its path
      levelAxes(ctx.focus);
      const k = smoothstep(1.2, 2.6, t);
      out.position.copy(s.anchor).addScaledVector(_h, k * 60);
      const d = out.position.distanceTo(ctx.focus.position);
      // lead the jet a little, never so much that it leaves the frame as it
      // screams past (the pan is fastest abeam, where d is smallest)
      out.target.copy(ctx.focus.position).addScaledVector(_h, Math.min(8 + k * 40, d * 0.2));
      // frame ~24 m of jet and air around it: long lens far out, wide abeam
      out.fov = clamp((2 * Math.atan(12 / Math.max(d, 1)) * 180) / Math.PI, 14, 60);
      out.roll = -0.04 * (1 - k);
      setDof(out, 0.7 * (1 - k), d, Math.max(25, d * 2));
    },
  },
};

export function cinematicDuration(def, state) {
  return state?.duration ?? def.duration;
}

export { TITLE_SHOTS, DIRECTOR_SHOTS };
