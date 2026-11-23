import {
  SPEED_OF_SOUND, dopplerFactor, propagationDelay, airAbsorptionCutoff, distanceGain,
} from './physics.js';
import { lineOfSight } from '../world/terrain/heightfield.js';

/**
 * Voice manager: plays buffers either flat (to a bus) or as world sources.
 *
 * World voice graph:
 *   src ─► amp (gain × distance) ─► air (lowpass: absorption × occlusion) ─► panner ─► world
 *                                                                    └► send ─► valley reverb
 *
 * Positions are listener-relative (listener sits at the origin, oriented like
 * the camera), so the 90 km map never costs float precision. The panner only
 * spatialises direction (rolloff 0); distance gain, air absorption, the
 * speed-of-sound delay and doppler are computed here so they are testable and
 * independent of each browser's PannerNode distance models (and its long-gone
 * built-in doppler).
 *
 * play(id, opts) options:
 *   bus        'sfx' | 'cockpit' | 'ui' | 'radio' | 'ambience' | 'music'   (flat voices)
 *   position   {x,y,z} fixed world position → world voice
 *   entity     live object with .position (+ .velocity) → moving world voice
 *   gain, rate, loop, when (extra delay s), variant, offset
 *   ref        distance (m) at which gain is 1 (default 40)
 *   maxDistance  audible range (default 6000)
 *   delay      apply speed-of-sound delay to one-shots (default true)
 *   doppler    pitch from relative velocity (default: true for entity voices)
 *   occlusion  terrain line-of-sight lowpass (default true)
 *   reverb     valley send 0..1 (default grows with distance)
 *   priority   higher survives voice stealing (default 1)
 */
const MAX_WORLD = 40;
const OCCLUSION_INTERVAL = 0.25;

export class Voices {
  constructor(engine, bank) {
    this.engine = engine;
    this.bank = bank;
    this.world = new Set();
    this.flat = new Set();
    this._t = 0;
    this.stats = { started: 0, culled: 0, stolen: 0 };
  }

  _dest(bus) {
    const e = this.engine;
    switch (bus) {
      case 'cockpit': return e.cockpit;
      case 'ui': return e.uiIn;
      case 'radio': return e.radioIn;
      case 'ambience': return e.ambienceIn;
      case 'music': return e.musicIn;
      case 'world': return e.worldIn;
      default: return e.bus.sfx;
    }
  }

  /** Returns a handle { stop(fade), setGain(g, tc), setRate(r, tc), source, ended } or null. */
  play(id, opts = {}) {
    const e = this.engine;
    if (!e.ctx) return null;
    const buffer = opts.buffer ?? this.bank.get(id, opts.variant);
    if (!buffer) return null;
    const entry = this.bank.sfxEntry(id) ?? {};
    if (opts.position || opts.entity) return this._playWorld(id, buffer, entry, opts);
    return this._playFlat(buffer, entry, opts);
  }

  _source(buffer, entry, opts) {
    const ctx = this.engine.ctx;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const loop = opts.loop ?? !!entry.loop;
    if (loop) {
      src.loop = true;
      if (entry.loopEnd) { src.loopStart = entry.loopStart ?? 0; src.loopEnd = entry.loopEnd; }
    }
    src.playbackRate.value = opts.rate ?? 1;
    return { src, loop };
  }

  _handle(src, amp, cleanup, loopStartOffset) {
    const ctx = this.engine.ctx;
    const h = {
      source: src, amp, ended: false,
      stop: (fade = 0.05) => {
        if (h.ended) return;
        const t = ctx.currentTime;
        amp.gain.cancelScheduledValues(t);
        amp.gain.setValueAtTime(amp.gain.value, t);
        amp.gain.setTargetAtTime(0, t, Math.max(0.005, fade / 3));
        try { src.stop(t + fade + 0.05); } catch { /* already stopped */ }
      },
      setGain: (g, tc = 0.05) => amp.gain.setTargetAtTime(g, ctx.currentTime, tc),
      setRate: (r, tc = 0.05) => src.playbackRate.setTargetAtTime(r, ctx.currentTime, tc),
    };
    src.onended = () => { h.ended = true; cleanup(); };
    h._loopStartOffset = loopStartOffset;
    return h;
  }

  _playFlat(buffer, entry, opts) {
    const ctx = this.engine.ctx;
    const { src, loop } = this._source(buffer, entry, opts);
    const amp = ctx.createGain();
    amp.gain.value = opts.gain ?? 1;
    let tail = amp;
    if (opts.filter) { // optional per-voice lowpass (e.g. radio voice, cockpit canopy)
      const f = ctx.createBiquadFilter();
      f.type = opts.filter.type ?? 'lowpass';
      f.frequency.value = opts.filter.frequency ?? 20000;
      f.Q.value = opts.filter.Q ?? 0.7;
      amp.connect(f);
      tail = f;
    }
    src.connect(amp);
    tail.connect(opts.destination ?? this._dest(opts.bus));
    const offset = loop ? (opts.offset ?? (entry.loopStart ?? 0)) : (opts.offset ?? 0);
    src.start(ctx.currentTime + (opts.when ?? 0), offset);
    this.stats.started++;
    const h = this._handle(src, amp, () => { this.flat.delete(h); src.disconnect(); tail.disconnect(); }, offset);
    h.filter = tail !== amp ? tail : null;
    this.flat.add(h);
    return h;
  }

  _rel(p) {
    const L = this.engine.listener.position;
    return { x: p.x - L.x, y: p.y - L.y, z: p.z - L.z };
  }

  _playWorld(id, buffer, entry, opts) {
    const e = this.engine;
    const ctx = e.ctx;
    const pos = opts.entity ? opts.entity.position : opts.position;
    const rel = this._rel(pos);
    const dist = Math.hypot(rel.x, rel.y, rel.z);
    const ref = opts.ref ?? 40;
    const maxD = opts.maxDistance ?? 6000;
    const baseGain = opts.gain ?? 1;
    const dg = distanceGain(dist, ref, maxD);
    const loop = opts.loop ?? !!entry.loop;
    if (!loop && dg * baseGain < 0.0015) { this.stats.culled++; return null; }

    // voice stealing: drop the quietest low-priority one-shot
    if (this.world.size >= MAX_WORLD) {
      let victim = null;
      for (const v of this.world) {
        if (v.loop) continue;
        const score = (v.priority ?? 1) * v.lastGain;
        if (!victim || score < victim._score) { victim = v; v._score = score; }
      }
      if (!victim || (opts.priority ?? 1) * dg * baseGain < victim._score) { this.stats.culled++; return null; }
      victim.handle.stop(0.03);
      this.world.delete(victim);
      this.stats.stolen++;
    }

    const { src, loop: isLoop } = this._source(buffer, entry, opts);
    const amp = ctx.createGain();
    const air = ctx.createBiquadFilter();
    air.type = 'lowpass';
    air.Q.value = 0.6;
    const panner = ctx.createPanner();
    panner.panningModel = e.panningModel;
    panner.distanceModel = 'inverse';
    panner.refDistance = 1;
    panner.rolloffFactor = 0;
    const send = ctx.createGain();
    src.connect(amp).connect(air).connect(panner).connect(e.worldIn);
    air.connect(send).connect(e.reverbIn);

    const v = {
      id, src, amp, air, panner, send, loop: isLoop,
      entity: opts.entity ?? null,
      position: opts.entity ? null : { x: pos.x, y: pos.y, z: pos.z },
      velocity: opts.velocity ?? null,
      baseGain, ref, maxD,
      baseRate: opts.rate ?? 1,
      doppler: opts.doppler ?? !!opts.entity,
      occlusion: opts.occlusion ?? true,
      reverb: opts.reverb,
      priority: opts.priority ?? 1,
      occluded: 0, occTarget: 0, _occT: Math.random() * OCCLUSION_INTERVAL,
      lastGain: dg * baseGain,
    };
    // initial state (no smoothing on first frame)
    this._applyWorld(v, rel, dist, 0, true);

    let when = ctx.currentTime + (opts.when ?? 0);
    if (!isLoop && (opts.delay ?? true)) when += propagationDelay(dist);
    v.startAt = when;
    const offset = isLoop ? (opts.offset ?? (entry.loopStart ?? 0)) : (opts.offset ?? 0);
    src.start(when, offset);
    this.stats.started++;
    v.handle = this._handle(src, amp, () => {
      this.world.delete(v);
      src.disconnect(); amp.disconnect(); air.disconnect(); panner.disconnect(); send.disconnect();
    }, offset);
    v.handle.voice = v;
    v.handle.setGain = (g) => { v.baseGain = g; };
    v.handle.setRate = (r) => { v.baseRate = r; };
    this.world.add(v);
    return v.handle;
  }

  _applyWorld(v, rel, dist, dt, immediate = false) {
    const ctx = this.engine.ctx;
    const t = ctx.currentTime;
    const tc = immediate ? 0 : 0.06;
    const set = (param, value) => {
      if (immediate) param.setValueAtTime(value, t);
      else param.setTargetAtTime(value, t, tc);
    };
    // direction only
    const inv = dist > 1e-3 ? 1 / dist : 0;
    const dx = dist > 1e-3 ? rel.x * inv : 0, dy = dist > 1e-3 ? rel.y * inv : 0, dz = dist > 1e-3 ? rel.z * inv : -1;
    if (v.panner.positionX) { set(v.panner.positionX, dx); set(v.panner.positionY, dy); set(v.panner.positionZ, dz); }
    else v.panner.setPosition(dx, dy, dz);
    // gain: inverse distance, occlusion
    const occ = v.occluded;
    const g = v.baseGain * distanceGain(dist, v.ref, v.maxD) * (1 - 0.45 * occ);
    v.lastGain = g;
    set(v.amp.gain, g);
    // air absorption (+ occlusion: diffraction over a ridge keeps only the lows)
    const cutoff = airAbsorptionCutoff(dist) * (1 - 0.82 * occ);
    set(v.air.frequency, Math.max(180, cutoff));
    // reverb: far and occluded sounds arrive mostly via the valley
    const rv = v.reverb ?? Math.min(0.9, 0.12 + dist / 4000 + 0.4 * occ);
    set(v.send.gain, rv * Math.max(0.15, Math.min(1, g * 3)));
    // doppler
    if (v.doppler) {
      const L = this.engine.listener;
      const src = { x: rel.x + L.position.x, y: rel.y + L.position.y, z: rel.z + L.position.z };
      const vel = v.entity?.velocity ?? v.velocity;
      const f = dopplerFactor(src, vel, L.position, L.velocity, SPEED_OF_SOUND);
      set(v.src.playbackRate, v.baseRate * f);
      v.dopplerFactor = f;
    } else if (!immediate) {
      set(v.src.playbackRate, v.baseRate);
    }
  }

  /** Per frame, after the listener moved. */
  update(dt) {
    if (!this.engine.ctx) return;
    this._t += dt;
    const L = this.engine.listener.position;
    for (const v of this.world) {
      if (v.entity && v.entity.alive === false && v.loop) { v.handle.stop(0.15); this.world.delete(v); continue; }
      const p = v.entity ? v.entity.position : v.position;
      const rel = { x: p.x - L.x, y: p.y - L.y, z: p.z - L.z };
      const dist = Math.hypot(rel.x, rel.y, rel.z);
      if (v.occlusion && dist > 120) {
        v._occT -= dt;
        if (v._occT <= 0) {
          v._occT = OCCLUSION_INTERVAL;
          const a = { x: L.x, y: L.y, z: L.z };
          const b = { x: p.x, y: p.y + 6, z: p.z };
          const samples = Math.min(48, 8 + Math.floor(dist / 200));
          v.occTarget = lineOfSight(a, b, samples) ? 0 : 1;
        }
      } else v.occTarget = 0;
      v.occluded += (v.occTarget - v.occluded) * (1 - Math.exp(-dt * 5));
      this._applyWorld(v, rel, dist, dt);
    }
  }

  stopAll(fade = 0.1) {
    for (const v of this.world) v.handle.stop(fade);
    for (const h of this.flat) h.stop(fade);
  }
}
