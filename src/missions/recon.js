// Reconnaissance: photograph observation posts through the nose optic.
// The idea and the numbers' shape come from the legacy game's ReconCamera
// (depressed nose optic, an ideal range band, quality from framing + range,
// auto-shutter once a frame is good enough); rewritten small and pure.
import { Vector3 } from 'three';

const D = Math.PI / 180;

export const OPTIC = {
  depression: 11 * D, // the optic looks below the nose
  halfFov: 7.5 * D,
  fov: 15, // degrees, for the camera owner
  idealMin: 350,
  idealMax: 3400,
  hardMax: 5200,
  threshold: 0.42, // quality needed for a usable frame
  holdTime: 0.75, // seconds a usable frame must be held
};

/** 0..1 quality of a frame of a post. */
export function photoQuality({ range, offAxis, los }, o = OPTIC) {
  if (!los || !(range <= o.hardMax) || offAxis > o.halfFov) return 0;
  const c = offAxis / o.halfFov;
  const centre = 1 - c * c;
  const rangeTerm = range < o.idealMin ? range / o.idealMin
    : range <= o.idealMax ? 1
      : 1 - (range - o.idealMax) / (o.hardMax - o.idealMax);
  return Math.max(0, (0.3 + 0.7 * centre) * rangeTerm);
}

const _to = new Vector3();

/** Optic axis: the nose, rotated down about the right wing. */
export function opticAxis(out, forward, up, o = OPTIC) {
  return out.copy(forward).multiplyScalar(Math.cos(o.depression)).addScaledVector(up, -Math.sin(o.depression)).normalize();
}

export class Recon {
  /** @param {object[]} posts combat entities ({position, id}) */
  constructor(posts = [], optic = OPTIC) {
    this.optic = optic;
    this.posts = posts.map((entity) => ({ entity, captured: false, quality: 0, best: 0, range: 0 }));
    this.active = false;
    this.focus = null;
    this.progress = 0;
    this.axis = new Vector3(0, 0, -1);
  }

  addPost(entity) { this.posts.push({ entity, captured: false, quality: 0, best: 0, range: 0 }); }
  get captured() { return this.posts.reduce((n, p) => n + (p.captured ? 1 : 0), 0); }
  get total() { return this.posts.length; }

  /**
   * @param {number} dt
   * @param {{position, forward, up}} flight
   * @param {boolean} active      optic held
   * @param {(a,b)=>boolean} los  line-of-sight test
   * @param {boolean} shutter     manual shutter pressed this frame
   * @returns {object|null} the post captured this step, if any
   */
  update(dt, flight, active, los, shutter = false) {
    this.active = active;
    opticAxis(this.axis, flight.forward, flight.up, this.optic);
    let best = null;
    for (const p of this.posts) {
      p.quality = 0;
      if (p.captured || !active) continue;
      _to.subVectors(p.entity.position, flight.position);
      p.range = _to.length();
      if (p.range > this.optic.hardMax) continue;
      const offAxis = Math.acos(Math.min(1, Math.max(-1, _to.dot(this.axis) / (p.range || 1))));
      if (offAxis > this.optic.halfFov) continue;
      p.quality = photoQuality({ range: p.range, offAxis, los: los(flight.position, p.entity.position) }, this.optic);
      if (!best || p.quality > best.quality) best = p;
    }
    if (!best || best.quality < this.optic.threshold) {
      this.focus = best;
      this.progress = Math.max(0, this.progress - dt * 2);
      return null;
    }
    if (this.focus !== best) { this.focus = best; this.progress = 0; }
    this.progress += dt / this.optic.holdTime;
    if (this.progress >= 1 || shutter) {
      best.captured = true;
      best.best = best.quality;
      this.progress = 0;
      this.focus = null;
      return best;
    }
    return null;
  }
}
