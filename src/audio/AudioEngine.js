/**
 * Web Audio context, bus graph, valley reverb, listener and volume settings.
 *
 *   music ─► musicDuck ─► musicBus ──┐
 *   world voices ─► worldFilter ─────┤ (cloud / canopy muffle)
 *   reverb send ─► convolver ─► worldFilter
 *   cockpit (player jet, gun, warnings) ─► sfxBus
 *   world ─► sfxBus ─────────────────┤
 *   radio chain ─► radioBus ─────────┤
 *   ui ─► uiBus ─────────────────────┤
 *   ambience ─► ambienceBus ─────────┤
 *                                    ▼
 *                     sum ─► glue compressor ─► master ─► limiter ─► out
 *
 * The context is only created from a user gesture (`unlockOn`), so Chrome's
 * "AudioContext was not allowed to start" warning never fires on load.
 *
 * Volume settings (0..1, persisted in localStorage `safedSagar.audio.v1`):
 *   master, music, sfx, radio, ui, ambience. Gain = v² (perceptual taper).
 */
export const BUSES = ['music', 'sfx', 'ui', 'radio', 'ambience'];
export const STORAGE_KEY = 'safedSagar.audio.v1';
export const DEFAULT_VOLUMES = Object.freeze({ master: 0.85, music: 0.7, sfx: 0.9, radio: 0.9, ui: 0.75, ambience: 0.8 });

function loadVolumes() {
  const v = { ...DEFAULT_VOLUMES };
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (raw) {
      const data = JSON.parse(raw);
      for (const k of Object.keys(v)) if (typeof data[k] === 'number') v[k] = Math.min(1, Math.max(0, data[k]));
    }
  } catch { /* storage blocked: defaults */ }
  return v;
}

const taper = (v) => v * v;

export class AudioEngine {
  constructor({ tier = 'high' } = {}) {
    this.ctx = null;
    this.tier = tier;
    this.volumes = loadVolumes();
    this.muted = false;
    this.listener = {
      position: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 },
      forward: { x: 0, y: 0, z: -1 }, up: { x: 0, y: 1, z: 0 }, _init: false,
    };
    this._onStart = [];
    this._unlockCleanup = null;
    this.panningModel = tier === 'low' ? 'equalpower' : 'HRTF';
  }

  get running() { return !!this.ctx && this.ctx.state === 'running'; }
  get now() { return this.ctx ? this.ctx.currentTime : 0; }

  /** Register a callback that runs once the graph exists. */
  onStart(fn) { if (this.ctx) fn(this); else this._onStart.push(fn); }

  /** Create (if needed) and resume the context. Call from a user gesture. */
  start() {
    if (!this.ctx) {
      const Ctx = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!Ctx) return null;
      try {
        this.ctx = new Ctx({ latencyHint: 'interactive' });
      } catch (e) {
        console.warn('[audio] AudioContext unavailable', e);
        return null;
      }
      this._build();
      for (const fn of this._onStart.splice(0)) fn(this);
    }
    if (this.ctx.state === 'suspended' && !this._hidden) this.ctx.resume().catch(() => {});
    return this.ctx;
  }

  /** Start on the first pointer / key / touch gesture; resume on tab return. */
  unlockOn(target = globalThis.window) {
    if (!target) return;
    const go = () => {
      this.start();
      if (this.running) cleanup();
    };
    const evs = ['pointerdown', 'keydown', 'touchend', 'mousedown'];
    const cleanup = () => evs.forEach((e) => target.removeEventListener(e, go, true));
    evs.forEach((e) => target.addEventListener(e, go, true));
    this._unlockCleanup = cleanup;
    const doc = globalThis.document;
    if (doc) {
      this._vis = () => this.setHidden(doc.visibilityState === 'hidden');
      doc.addEventListener('visibilitychange', this._vis);
    }
  }

  setHidden(hidden) {
    this._hidden = hidden;
    if (!this.ctx) return;
    if (hidden) this.ctx.suspend().catch(() => {});
    else this.ctx.resume().catch(() => {});
  }

  _build() {
    const ctx = this.ctx;
    const g = (v = 1) => { const n = ctx.createGain(); n.gain.value = v; return n; };

    this.sum = g();
    this.glue = ctx.createDynamicsCompressor();
    Object.assign(this.glue, {});
    this.glue.threshold.value = -16;
    this.glue.knee.value = 10;
    this.glue.ratio.value = 2.5;
    this.glue.attack.value = 0.012;
    this.glue.release.value = 0.25;
    this.master = g(this.muted ? 0 : taper(this.volumes.master));
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -1.5;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.001;
    this.limiter.release.value = 0.12;
    this.sum.connect(this.glue).connect(this.master).connect(this.limiter).connect(ctx.destination);

    this.bus = {};
    for (const b of BUSES) {
      this.bus[b] = g(taper(this.volumes[b]));
      this.bus[b].connect(this.sum);
    }
    // music: input → duck → bus
    this.musicIn = g();
    this.musicDuck = g();
    this.musicIn.connect(this.musicDuck).connect(this.bus.music);
    // sfx: world (muffle-able) and cockpit (direct)
    this.worldIn = g();
    this.worldFilter = ctx.createBiquadFilter();
    this.worldFilter.type = 'lowpass';
    this.worldFilter.frequency.value = 20000;
    this.worldFilter.Q.value = 0.5;
    this.worldGain = g();
    this.worldIn.connect(this.worldFilter).connect(this.worldGain).connect(this.bus.sfx);
    this.cockpit = g();
    this.cockpit.connect(this.bus.sfx);
    // valley reverb
    this.reverbIn = g();
    this.convolver = ctx.createConvolver();
    this.convolver.normalize = true;
    this.convolver.buffer = makeValleyIR(ctx, this.tier === 'low' ? 2.2 : 3.4);
    this.reverbOut = g(0.55);
    this.reverbIn.connect(this.convolver).connect(this.reverbOut).connect(this.worldFilter);
    // ui / radio / ambience inputs are the buses themselves
    this.uiIn = this.bus.ui;
    this.radioIn = this.bus.radio;
    this.ambienceIn = this.bus.ambience;

    // meters (dev/verification): one analyser per bus + master
    this.meters = {};
    for (const b of [...BUSES, 'master']) {
      const a = ctx.createAnalyser();
      a.fftSize = 2048;
      (b === 'master' ? this.limiter : this.bus[b]).connect(a);
      this.meters[b] = a;
    }
    this._meterBuf = new Float32Array(2048);

    // listener orientation is driven per frame; positions are listener-relative
    const L = ctx.listener;
    if (L.positionX) { L.positionX.value = 0; L.positionY.value = 0; L.positionZ.value = 0; }
    else L.setPosition?.(0, 0, 0);
  }

  /** RMS (dBFS) of a bus right now; used by the verification harness. */
  meter(bus = 'master') {
    const a = this.meters?.[bus];
    if (!a) return -Infinity;
    a.getFloatTimeDomainData(this._meterBuf);
    let s = 0;
    for (let i = 0; i < this._meterBuf.length; i++) s += this._meterBuf[i] * this._meterBuf[i];
    const rms = Math.sqrt(s / this._meterBuf.length);
    return rms > 0 ? 20 * Math.log10(rms) : -Infinity;
  }

  // ---------------------------------------------------------------- volume
  setVolume(bus, v) {
    if (!(bus in this.volumes)) throw new Error(`[audio] unknown bus "${bus}"`);
    this.volumes[bus] = Math.min(1, Math.max(0, Number(v) || 0));
    try { globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(this.volumes)); } catch { /* ignore */ }
    if (!this.ctx) return;
    const node = bus === 'master' ? this.master : this.bus[bus];
    const target = bus === 'master' && this.muted ? 0 : taper(this.volumes[bus]);
    node.gain.setTargetAtTime(target, this.ctx.currentTime, 0.03);
  }

  getVolume(bus) { return this.volumes[bus]; }

  setMuted(m) {
    this.muted = !!m;
    if (this.ctx) this.master.gain.setTargetAtTime(this.muted ? 0 : taper(this.volumes.master), this.ctx.currentTime, 0.03);
  }

  /** Music duck amount (0..1 of reduction) with a time constant. */
  duckMusic(amount, tc = 0.15) {
    if (!this.ctx) return;
    this.musicDuck.gain.setTargetAtTime(1 - amount, this.ctx.currentTime, tc);
  }

  /** World muffle: cutoff Hz and gain for cloud / canopy. */
  setWorldMuffle(cutoff, gain) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.worldFilter.frequency.setTargetAtTime(cutoff, t, 0.12);
    this.worldGain.gain.setTargetAtTime(gain, t, 0.12);
  }

  // -------------------------------------------------------------- listener
  /** Follow the render camera (three.js Object3D with an up-to-date matrixWorld). */
  updateListener(camera, dt) {
    const e = camera.matrixWorld.elements;
    const L = this.listener;
    const px = e[12], py = e[13], pz = e[14];
    if (L._init && dt > 1e-4) {
      // velocity from motion, lightly smoothed (camera shake would otherwise
      // read as doppler wobble)
      const k = 1 - Math.exp(-dt * 12);
      const vx = (px - L.position.x) / dt, vy = (py - L.position.y) / dt, vz = (pz - L.position.z) / dt;
      const sp = Math.hypot(vx, vy, vz);
      if (sp < 1500) { // ignore teleports (respawn / camera cut)
        L.velocity.x += (vx - L.velocity.x) * k;
        L.velocity.y += (vy - L.velocity.y) * k;
        L.velocity.z += (vz - L.velocity.z) * k;
      } else {
        L.velocity.x = L.velocity.y = L.velocity.z = 0;
      }
    }
    L.position.x = px; L.position.y = py; L.position.z = pz;
    L._init = true;
    // camera looks down -Z; up is +Y
    const fl = Math.hypot(e[8], e[9], e[10]) || 1;
    const ul = Math.hypot(e[4], e[5], e[6]) || 1;
    L.forward.x = -e[8] / fl; L.forward.y = -e[9] / fl; L.forward.z = -e[10] / fl;
    L.up.x = e[4] / ul; L.up.y = e[5] / ul; L.up.z = e[6] / ul;
    if (!this.ctx) return;
    const al = this.ctx.listener;
    const f = L.forward, u = L.up;
    if (al.forwardX) {
      const t = this.ctx.currentTime;
      al.forwardX.setValueAtTime(f.x, t); al.forwardY.setValueAtTime(f.y, t); al.forwardZ.setValueAtTime(f.z, t);
      al.upX.setValueAtTime(u.x, t); al.upY.setValueAtTime(u.y, t); al.upZ.setValueAtTime(u.z, t);
    } else {
      al.setOrientation?.(f.x, f.y, f.z, u.x, u.y, u.z);
    }
  }

  dispose() {
    this._unlockCleanup?.();
    if (this._vis) globalThis.document?.removeEventListener('visibilitychange', this._vis);
    this.ctx?.close?.().catch?.(() => {});
    this.ctx = null;
  }
}

/**
 * Generated "valley" impulse response: a dense, darkening tail plus discrete
 * early returns spaced like ridge walls a few hundred metres away. Stereo
 * channels are decorrelated so distant explosions bloom around the listener.
 */
export function makeValleyIR(ctx, seconds = 3.4, seed = 1337) {
  const sr = ctx.sampleRate;
  const n = Math.floor(seconds * sr);
  const buf = ctx.createBuffer(2, n, sr);
  let s = seed >>> 0;
  const rand = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 * 2 - 1; };
  const echoes = [[0.13, 0.55], [0.29, 0.42], [0.47, 0.33], [0.71, 0.26], [1.02, 0.18], [1.38, 0.12], [1.85, 0.08]];
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      // damping: one-pole lowpass whose coefficient closes over time (air + rock absorb highs)
      const a = Math.min(0.97, 0.25 + t * 0.32);
      lp = lp * a + rand() * (1 - a);
      const env = Math.exp(-t * 6.9 / (seconds * 0.8)) * Math.min(1, t / 0.02);
      d[i] = lp * env * 2.2;
    }
    for (const [t0, gain] of echoes) {
      const start = Math.floor((t0 + (ch ? 0.011 : 0) + rand() * 0.006) * sr);
      const len = Math.floor(0.045 * sr);
      let l2 = 0;
      for (let i = 0; i < len && start + i < n; i++) {
        l2 = l2 * 0.6 + rand() * 0.4;
        d[start + i] += l2 * gain * Math.exp(-i / (0.012 * sr)) * 3;
      }
    }
  }
  return buf;
}
