import * as THREE from 'three/webgpu';
import { clamp, easeInOut, noise1 } from './cameraMath.js';

const _f = new THREE.Vector3();
const _r = new THREE.Vector3();
const _u = new THREE.Vector3();
const WORLD_UP = new THREE.Vector3(0, 1, 0);

/**
 * Cinematic camera paths for title screens, mission intros and replays.
 * `cameraRig.playCinematic(name, opts)` runs one; each path is
 *   { duration (s, Infinity = loop until stopped), init(ctx) -> state,
 *     pose(t, state, ctx, out) }
 * ctx.focus = { position, orientation, velocity } of the subject (live).
 * out = { position, target, fov, roll } is filled every frame.
 */
function axes(focus) {
  _f.set(0, 0, -1).applyQuaternion(focus.orientation);
  _r.set(1, 0, 0).applyQuaternion(focus.orientation);
  _u.set(0, 1, 0).applyQuaternion(focus.orientation);
}

function headingOf(focus) {
  axes(focus);
  return Math.atan2(_f.x, -_f.z);
}

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
    },
  },

  /** Title screen: long lens, wide slow orbit, the ridge line behind the jet. */
  title: {
    duration: Infinity,
    init: (ctx, o) => ({ a0: headingOf(ctx.focus) + Math.PI * 0.6, radius: o.radius ?? 95, speed: o.speed ?? 0.07 }),
    pose(t, s, ctx, out) {
      const a = s.a0 + t * s.speed;
      const h = 14 + Math.sin(t * 0.11) * 10;
      out.position.set(Math.sin(a) * s.radius, h, -Math.cos(a) * s.radius).add(ctx.focus.position);
      out.target.copy(ctx.focus.position).addScaledVector(WORLD_UP, -2);
      out.fov = 30;
      out.roll = 0;
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
    },
  },
};

export function cinematicDuration(def, state) {
  return state?.duration ?? def.duration;
}
