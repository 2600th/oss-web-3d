import * as THREE from 'three';

/**
 * Synthesised soundtrack. No audio files ship with this experience.
 *
 * Every sound is built from oscillators and filtered noise at runtime, which
 * keeps the download to nothing, avoids licensing entirely, and — more usefully
 * — means the engine is a genuinely continuous function of throttle and
 * airspeed rather than a loop being crossfaded. A jet you can hear spooling
 * through its whole range does more for the feel of the throttle than any
 * sample set.
 *
 * A Tu­rbojet reads as three layers: a low combustion rumble, the compressor
 * whine an octave stack above it, and broadband efflux noise. Reheat adds a
 * fourth, much rougher low roar.
 */

export class Audio {
  constructor(settings) {
    this.settings = settings;
    this.ctx = null;
    this.ready = false;
    this.muted = false;
    this._pendingStart = false;
  }

  /**
   * Browsers refuse to start audio without a gesture, so this is called from
   * the first key press or click rather than at construction.
   */
  start() {
    if (this.ctx || this._pendingStart) return;
    this._pendingStart = true;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      this.ctx = new Ctx();
      this._build();
      this.ready = true;
    } catch (error) {
      console.warn('[audio] unavailable', error);
    }
  }

  resume() {
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  }

  _noiseBuffer(seconds = 2.5) {
    const ctx = this.ctx;
    const length = Math.floor(ctx.sampleRate * seconds);
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    // Slightly brown-tinted noise; pure white is harsh and sits too high to
    // read as air moving over an airframe.
    let last = 0;
    for (let i = 0; i < length; i++) {
      const white = Math.random() * 2 - 1;
      last = (last + 0.03 * white) / 1.03;
      data[i] = last * 3.2;
    }
    return buffer;
  }

  _build() {
    const ctx = this.ctx;

    this.master = ctx.createGain();
    this.master.gain.value = this.settings.masterVolume ?? 0.8;
    this.master.connect(ctx.destination);

    // Gentle limiter so reheat plus wind plus a warning tone cannot clip.
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -8;
    this.limiter.knee.value = 6;
    this.limiter.ratio.value = 8;
    this.limiter.attack.value = 0.004;
    this.limiter.release.value = 0.18;
    this.limiter.connect(this.master);

    const noise = this._noiseBuffer();

    // ---- engine: rumble ----
    this.rumbleOsc = ctx.createOscillator();
    this.rumbleOsc.type = 'sawtooth';
    this.rumbleOsc.frequency.value = 58;
    this.rumbleFilter = ctx.createBiquadFilter();
    this.rumbleFilter.type = 'lowpass';
    this.rumbleFilter.frequency.value = 220;
    this.rumbleGain = ctx.createGain();
    this.rumbleGain.gain.value = 0;
    this.rumbleOsc.connect(this.rumbleFilter).connect(this.rumbleGain).connect(this.limiter);
    this.rumbleOsc.start();

    // ---- engine: compressor whine ----
    this.whineOsc = ctx.createOscillator();
    this.whineOsc.type = 'sawtooth';
    this.whineOsc.frequency.value = 620;
    this.whineFilter = ctx.createBiquadFilter();
    this.whineFilter.type = 'bandpass';
    this.whineFilter.frequency.value = 1400;
    this.whineFilter.Q.value = 3.4;
    this.whineGain = ctx.createGain();
    this.whineGain.gain.value = 0;
    this.whineOsc.connect(this.whineFilter).connect(this.whineGain).connect(this.limiter);
    this.whineOsc.start();

    // ---- engine: efflux ----
    this.effluxSrc = ctx.createBufferSource();
    this.effluxSrc.buffer = noise;
    this.effluxSrc.loop = true;
    this.effluxFilter = ctx.createBiquadFilter();
    this.effluxFilter.type = 'bandpass';
    this.effluxFilter.frequency.value = 480;
    this.effluxFilter.Q.value = 0.7;
    this.effluxGain = ctx.createGain();
    this.effluxGain.gain.value = 0;
    this.effluxSrc.connect(this.effluxFilter).connect(this.effluxGain).connect(this.limiter);
    this.effluxSrc.start();

    // ---- reheat roar ----
    this.reheatSrc = ctx.createBufferSource();
    this.reheatSrc.buffer = noise;
    this.reheatSrc.loop = true;
    this.reheatFilter = ctx.createBiquadFilter();
    this.reheatFilter.type = 'lowpass';
    this.reheatFilter.frequency.value = 300;
    this.reheatGain = ctx.createGain();
    this.reheatGain.gain.value = 0;
    this.reheatSrc.connect(this.reheatFilter).connect(this.reheatGain).connect(this.limiter);
    this.reheatSrc.start();

    // ---- airflow ----
    this.windSrc = ctx.createBufferSource();
    this.windSrc.buffer = noise;
    this.windSrc.loop = true;
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = 'highpass';
    this.windFilter.frequency.value = 700;
    this.windPeak = ctx.createBiquadFilter();
    this.windPeak.type = 'peaking';
    this.windPeak.frequency.value = 2400;
    this.windPeak.Q.value = 0.8;
    this.windPeak.gain.value = 5;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    this.windSrc
      .connect(this.windFilter)
      .connect(this.windPeak)
      .connect(this.windGain)
      .connect(this.limiter);
    this.windSrc.start();

    // ---- warning tone ----
    this.warnOsc = ctx.createOscillator();
    this.warnOsc.type = 'square';
    this.warnOsc.frequency.value = 880;
    this.warnGain = ctx.createGain();
    this.warnGain.gain.value = 0;
    this.warnOsc.connect(this.warnGain).connect(this.limiter);
    this.warnOsc.start();

    this._noise = noise;
    this._warnPhase = 0;
  }

  setVolume(v) {
    if (!this.ready) return;
    this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
  }

  /**
   * @param {FlightModel} flight
   * @param {number} closingRate  m/s of the camera relative to the aircraft,
   *                              used for a subtle Doppler shift on the engine
   */
  update(dt, flight, closingRate = 0, warning = 'none') {
    if (!this.ready || this.ctx.state !== 'running') return;
    const t = this.ctx.currentTime;
    const smooth = 0.06;

    const throttle = flight.throttleSmoothed;
    const speedT = THREE.MathUtils.clamp(flight.airspeed / 480, 0, 1);
    const reheat = THREE.MathUtils.clamp((throttle - 0.84) / 0.16, 0, 1);

    // Doppler. The chase camera trails the aircraft, so during hard
    // acceleration the gap opens and the engine note drops fractionally — a
    // small effect, but it is the one that makes reheat feel like a shove.
    const doppler = THREE.MathUtils.clamp(1 - closingRate / 900, 0.93, 1.07);

    // Air is thin up here: less mass flow means a quieter, thinner engine.
    const density = Math.exp(-Math.max(flight.altitude, 0) / 8500) / Math.exp(-3000 / 8500);
    const thin = THREE.MathUtils.clamp(density, 0.35, 1.1);

    const base = 52 + 46 * throttle;
    this.rumbleOsc.frequency.setTargetAtTime(base * doppler, t, smooth);
    this.rumbleGain.gain.setTargetAtTime((0.1 + 0.3 * throttle) * thin, t, smooth);

    this.whineOsc.frequency.setTargetAtTime((430 + 780 * throttle) * doppler, t, smooth);
    this.whineFilter.frequency.setTargetAtTime(1100 + 1800 * throttle, t, smooth);
    this.whineGain.gain.setTargetAtTime((0.012 + 0.05 * throttle) * thin, t, smooth);

    this.effluxFilter.frequency.setTargetAtTime(320 + 900 * throttle, t, smooth);
    this.effluxGain.gain.setTargetAtTime((0.03 + 0.13 * throttle) * thin, t, smooth);

    this.reheatFilter.frequency.setTargetAtTime(180 + 260 * reheat, t, smooth);
    this.reheatGain.gain.setTargetAtTime(0.32 * reheat * thin, t, 0.12);

    // Wind rises steeply with airspeed and thins with altitude.
    this.windFilter.frequency.setTargetAtTime(420 + 1500 * speedT, t, smooth);
    this.windGain.gain.setTargetAtTime(Math.pow(speedT, 2.1) * 0.34 * thin, t, smooth);

    // Warning tone: a slow beep for terrain, a lower one for stall.
    if (warning === 'none' || flight.crashed) {
      this.warnGain.gain.setTargetAtTime(0, t, 0.03);
      this._warnPhase = 0;
    } else {
      const rate = warning === 'terrain' ? 3.6 : 2.1;
      this._warnPhase += dt * rate;
      const on = this._warnPhase % 1 < 0.45;
      this.warnOsc.frequency.setTargetAtTime(warning === 'terrain' ? 960 : 610, t, 0.01);
      this.warnGain.gain.setTargetAtTime(on ? 0.055 : 0, t, 0.012);
    }
  }

  /** Camera shutter: a mechanical double click. */
  shutter() {
    if (!this.ready) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    for (const [delay, gain, freq] of [
      [0, 0.5, 2600],
      [0.052, 0.34, 1700],
    ]) {
      const src = ctx.createBufferSource();
      src.buffer = this._noise;
      src.loop = true;
      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = freq;
      filter.Q.value = 1.6;
      const env = ctx.createGain();
      env.gain.setValueAtTime(0, t + delay);
      env.gain.linearRampToValueAtTime(gain, t + delay + 0.004);
      env.gain.exponentialRampToValueAtTime(0.0005, t + delay + 0.07);
      src.connect(filter).connect(env).connect(this.limiter);
      src.start(t + delay);
      src.stop(t + delay + 0.1);
    }
  }

  /** Confirmation chime when an objective is secured. */
  confirm() {
    if (!this.ready) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    [740, 988].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = freq;
      const env = ctx.createGain();
      const at = t + i * 0.09;
      env.gain.setValueAtTime(0, at);
      env.gain.linearRampToValueAtTime(0.09, at + 0.012);
      env.gain.exponentialRampToValueAtTime(0.0005, at + 0.42);
      osc.connect(env).connect(this.limiter);
      osc.start(at);
      osc.stop(at + 0.45);
    });
  }

  /** Impact: a low thud plus a broadband burst, then everything cuts out. */
  impact(force = 1) {
    if (!this.ready) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;

    const src = ctx.createBufferSource();
    src.buffer = this._noise;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(2600, t);
    filter.frequency.exponentialRampToValueAtTime(140, t + 0.9);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(0.85 * force, t + 0.01);
    env.gain.exponentialRampToValueAtTime(0.0005, t + 1.7);
    src.connect(filter).connect(env).connect(this.limiter);
    src.start(t);
    src.stop(t + 1.8);

    const boom = ctx.createOscillator();
    boom.type = 'sine';
    boom.frequency.setValueAtTime(88, t);
    boom.frequency.exponentialRampToValueAtTime(28, t + 0.8);
    const boomEnv = ctx.createGain();
    boomEnv.gain.setValueAtTime(0, t);
    boomEnv.gain.linearRampToValueAtTime(0.6 * force, t + 0.015);
    boomEnv.gain.exponentialRampToValueAtTime(0.0005, t + 1.4);
    boom.connect(boomEnv).connect(this.limiter);
    boom.start(t);
    boom.stop(t + 1.5);

    // Silence the engine — the aircraft is gone.
    for (const g of [this.rumbleGain, this.whineGain, this.effluxGain, this.reheatGain, this.windGain]) {
      g.gain.cancelScheduledValues(t);
      g.gain.setTargetAtTime(0, t, 0.12);
    }
  }

  dispose() {
    if (this.ctx) this.ctx.close();
  }
}
