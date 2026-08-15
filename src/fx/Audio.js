import * as THREE from 'three';
import { Music } from './Music.js';

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
    this._impactLatched = false;
    this._disposed = false;
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

  /**
   * Two channels of independent brown-tinted noise.
   *
   * The tint first: pure white is harsh and sits too high to read as air moving
   * over an airframe. The second channel matters more than it looks. Every
   * noise bed here — efflux, reheat, airflow — feeds from this one buffer, and
   * while it was mono all three arrived at both ears perfectly correlated,
   * which the ear localises as a point source directly between them. That is
   * why the jet sounded small: not a lack of loudness but a lack of width.
   * Decorrelated channels put the airflow *around* the listener instead, and it
   * costs one extra buffer and no runtime nodes at all.
   */
  _noiseBuffer(seconds = 2.5) {
    const ctx = this.ctx;
    const length = Math.floor(ctx.sampleRate * seconds);
    const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
    for (let channel = 0; channel < 2; channel++) {
      const data = buffer.getChannelData(channel);
      let last = 0;
      for (let i = 0; i < length; i++) {
        const white = Math.random() * 2 - 1;
        last = (last + 0.03 * white) / 1.03;
        data[i] = last * 3.2;
      }
    }
    return buffer;
  }

  /**
   * A synthesised impulse response for the valley.
   *
   * No file ships, so the tail is generated: decorrelated noise under an
   * exponential decay, darkened by a one-pole per channel because rock and snow
   * absorb highs far faster than lows, and with the first 40 ms suppressed so
   * the reflections arrive after the direct sound rather than smearing into it.
   * A long tail on a bare oscillator engine is most of what separates "a synth
   * patch" from "an aircraft in a place".
   */
  _valleyImpulse(seconds) {
    const ctx = this.ctx;
    const length = Math.floor(ctx.sampleRate * seconds);
    const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
    const preDelay = Math.floor(ctx.sampleRate * 0.04);
    for (let channel = 0; channel < 2; channel++) {
      const data = buffer.getChannelData(channel);
      let last = 0;
      for (let i = 0; i < length; i++) {
        const t = i / length;
        const white = Math.random() * 2 - 1;
        last = last * 0.72 + white * 0.28;
        const build = i < preDelay ? i / preDelay : 1;
        data[i] = last * Math.exp(-4.2 * t) * build;
      }
    }
    return buffer;
  }

  /** Tap a node into the reverb at `amount`, if this tier has a reverb at all. */
  _send(node, amount) {
    if (!this.reverbIn) return;
    const gain = this.ctx.createGain();
    gain.gain.value = amount;
    node.connect(gain).connect(this.reverbIn);
  }

  _build() {
    const ctx = this.ctx;

    this.master = ctx.createGain();
    this.master.gain.value = this.settings.masterVolume ?? 0.8;
    this.master.connect(ctx.destination);

    // Everything the player hears passes through the cabin filter, which is
    // wide open in level flight and closes under G. Muffling only the engine
    // would read as the engine changing; muffling the whole mix — score
    // included — reads as the *player* greying out, which is the effect worth
    // having and the reason this sits between the sources and the master.
    this.cabin = ctx.createBiquadFilter();
    this.cabin.type = 'lowpass';
    this.cabin.frequency.value = 20000;
    this.cabin.Q.value = 0.4;
    this.cabin.connect(this.master);

    // Gentle limiter so reheat plus wind plus a warning tone cannot clip.
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -8;
    this.limiter.knee.value = 6;
    this.limiter.ratio.value = 8;
    this.limiter.attack.value = 0.004;
    this.limiter.release.value = 0.18;
    this.limiter.connect(this.cabin);

    // The score still bypasses the limiter — that part has not changed, and for
    // the same reason: routing it through would let every throttle push pump
    // the music, which is the classic game-audio tell. It joins at the cabin
    // filter instead, so it greys out with everything else.
    this.music = new Music(ctx, this.cabin);
    this.music.setVolume(this.settings.musicVolume ?? 0.75);

    // ---- valley reverb ----
    //
    // Convolution is the one genuinely expensive node in this graph, so the two
    // tiers that exist to save CPU do without it and simply run dry. The tail
    // is shorter on 'medium' than 'high' for the same reason.
    const tier = this.settings.tierName ?? 'high';
    if (tier === 'high' || tier === 'medium') {
      this.reverbIn = ctx.createGain();
      this.reverb = ctx.createConvolver();
      this.reverb.buffer = this._valleyImpulse(tier === 'high' ? 1.9 : 1.2);
      this.reverbTone = ctx.createBiquadFilter();
      this.reverbTone.type = 'lowpass';
      this.reverbTone.frequency.value = 2200;
      this.reverbReturn = ctx.createGain();
      this.reverbReturn.gain.value = 0.9;
      this.reverbIn.connect(this.reverb).connect(this.reverbTone)
        .connect(this.reverbReturn).connect(this.cabin);
    }

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
    this._send(this.effluxGain, 0.16);

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
    this._send(this.reheatGain, 0.12);

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
    // A separate trim after the airflow gain, owned entirely by the transonic
    // one-shot. update() rewrites windGain every frame, so a dip automated
    // there would be overwritten before it was audible; this node is touched by
    // nothing else and sits at unity until the moment it is wanted.
    this.machDip = ctx.createGain();
    this.machDip.gain.value = 1;
    this.windSrc
      .connect(this.windFilter)
      .connect(this.windPeak)
      .connect(this.windGain)
      .connect(this.machDip)
      .connect(this.limiter);
    this.windSrc.start();
    this._send(this.machDip, 0.2);

    // ---- airframe under load ----
    //
    // The one sound in here that is about the player rather than the aircraft's
    // settings. A resonant band of noise low in the spectrum, silent in level
    // flight and rising with G, so a hard turn is something you hear the
    // airframe object to. Without it a 7 G reversal and a gentle cruise sound
    // identical, and the new control law made hard turns the whole point.
    this.stressSrc = ctx.createBufferSource();
    this.stressSrc.buffer = noise;
    this.stressSrc.loop = true;
    this.stressFilter = ctx.createBiquadFilter();
    this.stressFilter.type = 'bandpass';
    this.stressFilter.frequency.value = 120;
    this.stressFilter.Q.value = 4.5;
    this.stressGain = ctx.createGain();
    this.stressGain.gain.value = 0;
    this.stressSrc.connect(this.stressFilter).connect(this.stressGain).connect(this.limiter);
    this.stressSrc.start();

    // ---- warning tone ----
    //
    // A bare square wave is a buzzer, not an avionics tone: its odd harmonics
    // run to Nyquist and the ear reads that as cheap. Rolling the top off just
    // above the third harmonic keeps the square's urgency and loses the fizz.
    this.warnOsc = ctx.createOscillator();
    this.warnOsc.type = 'square';
    this.warnOsc.frequency.value = 880;
    this.warnTone = ctx.createBiquadFilter();
    this.warnTone.type = 'lowpass';
    this.warnTone.frequency.value = 3200;
    this.warnTone.Q.value = 0.7;
    this.warnGain = ctx.createGain();
    this.warnGain.gain.value = 0;
    this.warnOsc.connect(this.warnTone).connect(this.warnGain).connect(this.limiter);
    this.warnOsc.start();

    this._noise = noise;
    this._warnPhase = 0;
    // Spool state: core and fan, both lagging the throttle. Started at idle so
    // the first frame does not slam the engine up from silence.
    this._n2 = 0.2;
    this._n1 = 0.2;
    this._gSmoothed = 1;
    this._machArmed = true;
  }

  /**
   * Put the engine back at idle for a new sortie.
   *
   * The spool is stateful by design, so without this a restart inherits the
   * previous run's engine — a sortie that ended in a dive at full reheat began
   * the next one already screaming on the runway.
   */
  resetEngine() {
    this._n2 = 0.2;
    this._n1 = 0.2;
    this._gSmoothed = 1;
    this._machArmed = true;
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
    // impact() owns the final engine automation. Game continues updating for
    // the crash hold, so touching these gains again would immediately undo the
    // fade and make the destroyed aircraft roar until the failure screen.
    if (this._impactLatched) {
      if (flight.crashed) return;
      // A new sortie reuses Audio; the first healthy frame arms it again.
      this._impactLatched = false;
    }
    const t = this.ctx.currentTime;
    const smooth = 0.06;

    const demand = flight.throttleSmoothed;

    // Spool lag, and it is the single strongest cue that this is a jet rather
    // than a siren. A turbofan does not follow the throttle: the core (N2)
    // catches up in a second or so, the fan (N1) — which is most of what you
    // actually hear — takes several, and both run down more slowly than they
    // run up. Certification allows about eight seconds from approach idle to
    // 95% thrust. Tracking the throttle directly, as this did, makes the note
    // move the instant the key does, which reads as a synthesiser.
    const spool = (current, target, tauUp, tauDown) =>
      current + (target - current) * (1 - Math.exp(-dt / (target > current ? tauUp : tauDown)));
    this._n2 = spool(this._n2, demand, 0.9, 1.5);
    this._n1 = spool(this._n1, this._n2, 1.8, 2.7);

    const throttle = this._n1;
    const core = this._n2;
    const speedT = THREE.MathUtils.clamp(flight.airspeed / 480, 0, 1);
    // Reheat is the exception: the burner lights in well under a second, so it
    // follows demand rather than the spooled fan.
    const reheat = THREE.MathUtils.clamp((demand - 0.84) / 0.16, 0, 1);

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

    // Combustion and efflux come off the core, which leads the fan — so a
    // throttle push is heard as the core picking up first and the fan
    // following, rather than as one block of sound changing volume.
    this.effluxFilter.frequency.setTargetAtTime(320 + 900 * core, t, smooth);
    this.effluxGain.gain.setTargetAtTime((0.03 + 0.13 * core) * thin, t, smooth);

    this.reheatFilter.frequency.setTargetAtTime(180 + 260 * reheat, t, smooth);
    this.reheatGain.gain.setTargetAtTime(0.32 * reheat * thin, t, 0.12);

    // Wind rises steeply with airspeed and thins with altitude.
    //
    // Airframe and boundary-layer noise is dipole radiation, so power goes as
    // v^6 and amplitude as v^3. (The v^8 law is Lighthill's, for free-jet
    // quadrupole turbulence — that one belongs to the exhaust, not the
    // airframe, and applying it here is a common error.) Because aeroacoustic
    // spectra scale on Strouhal number the centre frequency scales linearly
    // with speed, which is what stops wind from merely getting louder.
    this.windFilter.frequency.setTargetAtTime(170 + 4.7 * flight.airspeed, t, smooth);
    this.windGain.gain.setTargetAtTime(Math.pow(speedT, 3.0) * 0.40 * thin, t, smooth);

    // ---- G ----
    //
    // Smoothed, because gLoad is computed from acceleration and is noisy enough
    // frame to frame to make an unsmoothed filter cutoff audibly chatter. The
    // knee sits at 3.5 G so ordinary manoeuvring is untouched and only a
    // committed turn greys the mix down; 8 G is the practical ceiling the
    // control law allows, and lands the cabin filter at 2.2 kHz — dull enough
    // to feel like tunnel vision, still open enough to hear a terrain warning.
    const g = Math.abs(flight.gLoad ?? 1);
    this._gSmoothed += (g - this._gSmoothed) * Math.min(1, dt * 6);
    const strain = THREE.MathUtils.clamp((this._gSmoothed - 3.5) / 4.5, 0, 1);
    const squeeze = strain * strain * (3 - 2 * strain);
    this.cabin.frequency.setTargetAtTime(20000 - 17800 * squeeze, t, 0.1);
    this.stressFilter.frequency.setTargetAtTime(112 + 78 * squeeze, t, 0.15);
    this.stressGain.gain.setTargetAtTime(squeeze * 0.15 * thin, t, 0.14);

    // ---- transonic ----
    //
    // Roughly the speed of sound in the thin air this sortie is flown in. It is
    // reachable only in reheat, which is the point: it makes the throttle worth
    // pushing. Latched with a wide hysteresis band so a speed hovering on the
    // threshold cannot machine-gun the one-shot.
    if (this._machArmed && flight.airspeed > 295) {
      this._machArmed = false;
      this._transonic();
    } else if (!this._machArmed && flight.airspeed < 272) {
      this._machArmed = true;
    }

    // Duck the score under the engine. Full reheat at low level is the loudest
    // the game gets and the moment a melody is least wanted, so the music steps
    // back instead of fighting for the same band.
    this.music?.setIntensity(Math.max(throttle * 0.7, reheat) * 0.85 + speedT * 0.15);

    // Warning tone: a slow beep for terrain, a lower one for stall.
    if (warning === 'none' || flight.crashed) {
      this.warnGain.gain.setTargetAtTime(0, t, 0.03);
      this._warnPhase = 0;
    } else {
      const rate = warning === 'terrain' ? 3.6 : 2.1;
      this._warnPhase += dt * rate;
      const phase = this._warnPhase % 1;
      const on = phase < 0.45;
      this.warnOsc.frequency.setTargetAtTime(warning === 'terrain' ? 960 : 610, t, 0.01);
      // Shape the beep instead of gating it. A hard on/off produces a click at
      // both edges — broadband energy the mix reads as a fault rather than an
      // alarm — and the tail is what makes a tone sound like equipment. The
      // attack stays fast because a terrain warning that eases in is useless.
      const level = on ? 0.055 * Math.min(1, (0.45 - phase) / 0.18) : 0;
      this.warnGain.gain.setTargetAtTime(level, t, on ? 0.006 : 0.03);
    }
  }

  /**
   * Crossing the sound barrier.
   *
   * Not a textbook N-wave — that is what an observer on the ground hears, and
   * the camera is flying alongside. From here the event is a pressure step and
   * a moment where the airflow noise falls away behind the aircraft before it
   * catches up, so that is what this plays: a descending thump, a broadband
   * crack, and a short dip in the airflow bed that recovers over half a second.
   */
  _transonic() {
    const ctx = this.ctx;
    const t = ctx.currentTime;

    const crack = ctx.createBufferSource();
    crack.buffer = this._noise;
    crack.loop = true;
    const shape = ctx.createBiquadFilter();
    shape.type = 'lowpass';
    shape.frequency.setValueAtTime(1800, t);
    shape.frequency.exponentialRampToValueAtTime(90, t + 0.55);
    const crackEnv = ctx.createGain();
    crackEnv.gain.setValueAtTime(0, t);
    crackEnv.gain.linearRampToValueAtTime(0.42, t + 0.008);
    crackEnv.gain.exponentialRampToValueAtTime(0.0005, t + 0.9);
    crack.connect(shape).connect(crackEnv).connect(this.limiter);
    this._send(crackEnv, 0.45);
    crack.start(t);
    crack.stop(t + 1);

    const thump = ctx.createOscillator();
    thump.type = 'sine';
    thump.frequency.setValueAtTime(104, t);
    thump.frequency.exponentialRampToValueAtTime(34, t + 0.5);
    const thumpEnv = ctx.createGain();
    thumpEnv.gain.setValueAtTime(0, t);
    thumpEnv.gain.linearRampToValueAtTime(0.5, t + 0.012);
    thumpEnv.gain.exponentialRampToValueAtTime(0.0005, t + 0.8);
    thump.connect(thumpEnv).connect(this.limiter);
    thump.start(t);
    thump.stop(t + 0.85);

    this.machDip.gain.cancelScheduledValues(t);
    this.machDip.gain.setValueAtTime(1, t);
    this.machDip.gain.linearRampToValueAtTime(0.25, t + 0.06);
    this.machDip.gain.linearRampToValueAtTime(1, t + 0.62);
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
      // The shutter is the one sound with nothing else under it — recon holds
      // the aircraft steady and the mix is quiet — so it carries the valley
      // more than anything else does, and it is worth the send for that alone.
      this._send(env, 0.5);
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
      this._send(env, 0.35);
      osc.start(at);
      osc.stop(at + 0.45);
    });
    // The chime says the shutter caught it. The sting says it mattered — see
    // Music.sting, which is the only place the score ever reaches the tonic.
    this.music?.sting?.();
  }

  /** Impact: a low thud plus a broadband burst, then everything cuts out. */
  impact(force = 1) {
    if (!this.ready) return;
    this._impactLatched = true;
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
    this._send(env, 0.6);
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
    this._send(boomEnv, 0.5);
    boom.start(t);
    boom.stop(t + 1.5);

    // Open the cabin filter back up. The last thing before an impact is usually
    // a hard pull, so the mix is very likely muffled at exactly this moment,
    // and leaving it that way robs the impact of its top end.
    this.cabin.frequency.cancelScheduledValues(t);
    this.cabin.frequency.setTargetAtTime(20000, t, 0.08);

    // Silence the engine — the aircraft is gone.
    for (const g of [
      this.rumbleGain,
      this.whineGain,
      this.effluxGain,
      this.reheatGain,
      this.windGain,
      this.warnGain,
      this.stressGain,
    ]) {
      g.gain.cancelScheduledValues(t);
      g.gain.setTargetAtTime(0, t, 0.12);
    }
  }

  /**
   * The sortie is over; hand the mix back.
   *
   * update() stops being called once the debrief is up, so whatever the cabin
   * filter was doing at that instant it keeps doing forever. A sortie completed
   * in a hard turn would play its closing cue through a 2.2 kHz lowpass — the
   * one moment in the whole experience that most needs to be heard clearly.
   */
  /**
   * Spool the flight bed down when the sortie stops being simulated.
   *
   * Every gain here is driven by update(), and update() is only called from the
   * flying path. Pausing and both debriefs leave it uncalled — so the engine,
   * the wind and any live warning tone simply froze at whatever value the last
   * flown frame set and held it indefinitely. Measured at full reheat: 0.204
   * peak in flight, still 0.197 six seconds into the pause menu. An afterburner
   * running under a paused game is wrong on its own, and it buried the menu
   * theme and the closing cue that are supposed to own those screens.
   *
   * Only the gains are touched, never the spool state: _n1 and _n2 keep their
   * values, so resuming brings the engine back up through update()'s normal
   * smoothing in a couple of hundred milliseconds rather than re-spooling from
   * idle, which would sound like the engine had been restarted.
   *
   * @param {number} seconds time constant for the fade
   */
  quietFlightBed(seconds = 0.5) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const tau = Math.max(seconds, 0.05) / 3;
    for (const node of [
      this.rumbleGain, this.whineGain, this.effluxGain,
      this.reheatGain, this.windGain, this.stressGain, this.warnGain,
    ]) {
      node.gain.cancelScheduledValues(t);
      node.gain.setTargetAtTime(0, t, tau);
    }
    this._warnPhase = 0;
    this.cabin.frequency.cancelScheduledValues(t);
    this.cabin.frequency.setTargetAtTime(20000, t, 0.25);
    this._gSmoothed = 1;
  }

  endSortie() {
    if (!this.ready) return;
    // A closing cue over a frozen afterburner is not a closing cue. The fade is
    // slower than the pause one because the aircraft is notionally flying away.
    this.quietFlightBed(1.4);
    this.music?.setTension?.(0);
  }

  /**
   * Mission tension, 0 at the start of a leg and 1 on top of the objective.
   *
   * Passed straight to the score. Keeping the mapping here rather than in Music
   * means the cue does not need to know what a metre is.
   */
  setTension(range, hasTarget) {
    if (!this.ready) return;
    const closeness = hasTarget ? THREE.MathUtils.clamp(1 - (range - 900) / 5200, 0, 1) : 0;
    this.music?.setTension?.(closeness);
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this.ready = false;
    this.music?.dispose?.();
    if (this.ctx) this.ctx.close();
  }
}
