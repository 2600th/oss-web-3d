/**
 * Original score, synthesized. Three cues: sortie, loss, return.
 *
 * Everything here is composed for this project and generated from oscillators
 * and filtered noise at runtime. That is a constraint the brief imposes twice
 * over — no asset files, and nothing borrowed from the series or its music —
 * and it is also why the score can follow the flight instead of looping under
 * it: the sortie cue reads altitude and throttle and thins out when the engine
 * is loud, which a fixed recording cannot do.
 *
 * Tonal material is drawn from Hindustani scale degrees rather than functional
 * Western harmony, because that is what places the music in these mountains.
 * A scale is not anyone's property; the melodies are written here. The sortie
 * cue sits on a Bhairavi-flavoured set (flat 2, 3, 6, 7), which is austere
 * without being mournful. The loss cue keeps the same flat second and lets the
 * line fall. The return cue moves to a major-seventh set closer to Desh and
 * lifts, which is the shape a homecoming wants — arrival, not triumph, since
 * the brief is explicit that remembrance must not be scored like a win.
 *
 * Scheduling uses the standard WebAudio lookahead pattern: a coarse timer wakes
 * a few times a second and books every note that falls inside a short horizon
 * with sample-accurate start times. Sequencing off requestAnimationFrame would
 * put musical timing at the mercy of frame rate, which is exactly what happens
 * to it here — the renderer is the thing under load.
 */

const SEMITONE = 2 ** (1 / 12);
const hz = (semitonesFromA4) => 440 * SEMITONE ** semitonesFromA4;

// Scale degrees as semitone offsets from the tonic.
const BHAIRAVI = [0, 1, 3, 5, 7, 8, 10]; // komal re, ga, dha, ni
const DESH_ISH = [0, 2, 4, 5, 7, 9, 11];

const LOOKAHEAD_MS = 120;
const HORIZON = 0.45; // seconds of music booked ahead of the clock

export class Music {
  constructor(ctx, destination) {
    this.ctx = ctx;
    this.out = ctx.createGain();
    this.out.gain.value = 0;
    this.out.connect(destination);

    // A gentle low-pass across the whole score keeps it behind the engine
    // rather than competing with it in the same band.
    this.tone = ctx.createBiquadFilter();
    this.tone.type = 'lowpass';
    this.tone.frequency.value = 2600;
    this.tone.Q.value = 0.5;
    this.tone.connect(this.out);

    this.cue = null;
    this._timer = null;
    this._next = 0;
    this._step = 0;
    this._volume = 1;
    this._duck = 1;
    // Live voices, so a cue change can silence what the previous one booked.
    this._voices = new Set();
  }

  /**
   * Register a voice's output gain and its sources so the cue can be cut short.
   *
   * Without this, stopping a cue only cancelled the scheduler: notes already
   * scheduled kept playing. The sortie drone runs 26 seconds, so reaching the
   * debrief left it droning underneath the ending, and raising the shared
   * output gain for the new cue made it audible again rather than hiding it.
   */
  _register(amp, sources, endsAt) {
    const entry = { amp, sources };
    this._voices.add(entry);
    setTimeout(() => this._voices.delete(entry), (endsAt - this.ctx.currentTime + 0.5) * 1000);
  }

  /** Fade out and stop everything the previous cue scheduled. */
  _silenceVoices(fade) {
    const now = this.ctx.currentTime;
    for (const v of this._voices) {
      try {
        v.amp.gain.cancelScheduledValues(now);
        v.amp.gain.setTargetAtTime(0.0001, now, Math.max(fade, 0.05) / 3);
        for (const src of v.sources) src.stop(now + fade + 0.2);
      } catch {
        /* already stopped */
      }
    }
    this._voices.clear();
  }

  setVolume(v) {
    this._volume = Math.max(0, Math.min(1, v));
    this._applyGain(0.4);
  }

  _applyGain(time = 0.8) {
    const target = this.cue ? this._volume * this.cue.level * this._duck : 0;
    this.out.gain.setTargetAtTime(target, this.ctx.currentTime, time);
  }

  /**
   * Duck the score under the engine.
   *
   * Full throttle at low level is the loudest the game ever gets and also the
   * moment the player least wants a melody over it, so the sortie cue steps
   * back rather than fighting for the same space.
   */
  setIntensity(engineLoad) {
    if (!this.cue || !this.cue.ducks) return;
    this._duck = 1 - 0.55 * Math.max(0, Math.min(1, engineLoad));
    this._applyGain(0.9);
  }

  play(name) {
    const cue = CUES[name];
    if (!cue || this.cue === cue) return;
    this.stop(name === 'sortie' ? 1.5 : 0.35);
    this.cue = cue;
    this._step = 0;
    this._next = this.ctx.currentTime + 0.15;
    this._duck = 1;
    this._applyGain(cue.fadeIn ?? 1.6);
    if (!this._timer) this._timer = setInterval(() => this._pump(), LOOKAHEAD_MS);
  }

  stop(fade = 1.2) {
    if (!this.cue) return;
    this.cue = null;
    this._silenceVoices(fade);
    this.out.gain.setTargetAtTime(0, this.ctx.currentTime, fade / 3);
    clearInterval(this._timer);
    this._timer = null;
  }

  _pump() {
    if (!this.cue || this.ctx.state !== 'running') return;
    const now = this.ctx.currentTime;

    // Resynchronise if the scheduler has fallen behind the audio clock.
    //
    // setInterval is not delivered while the tab is stalled — a long frame, a
    // GC pause, a background tab — but ctx.currentTime keeps advancing. On the
    // next tick _next is in the past, and every voice then books its envelope
    // at a start time that has already gone. WebAudio does not reject that: it
    // collapses the ramp into zero duration, and a filter whose frequency is
    // ramped instantaneously reports "state is bad, probably due to unstable
    // filter caused by fast parameter automation", which is exactly the warning
    // this produced. Skipping ahead drops the missed bars, which is right —
    // this is a score, not a simulation, and nobody wants a stall to be
    // followed by nine bars played at once.
    if (this._next < now) this._next = now + 0.05;

    const until = now + HORIZON;
    let guard = 0;
    while (this._next < until && guard++ < 64) {
      const events = this.cue.at(this._step);
      for (const e of events) this._voice(e, this._next + (e.offset ?? 0));
      this._next += this.cue.stepSeconds;
      this._step++;
    }
  }

  // ------------------------------------------------------------- voices --

  _voice(e, when) {
    switch (e.voice) {
      case 'pluck':
        this._pluck(e, when);
        break;
      case 'flute':
        this._flute(e, when);
        break;
      case 'drone':
        this._drone(e, when);
        break;
      default:
        this._pad(e, when);
    }
  }

  /**
   * Plucked string, Karplus-Strong.
   *
   * A short noise burst recirculated through a delay of one period with a
   * one-pole lowpass in the loop. It is the cheapest way to get a struck-string
   * timbre with a real decaying spectrum — high partials die first, as they do
   * on a santoor — and it needs no wavetable.
   */
  _pluck(e, when) {
    const ctx = this.ctx;
    const freq = hz(e.note);
    const period = 1 / freq;
    const seconds = Math.max(0.3, e.dur ?? 1.4);

    const burst = ctx.createBufferSource();
    const buffer = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * period), ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    burst.buffer = buffer;

    // No filter inside the feedback path — the loop is a pure delay and gain.
    //
    // Textbook Karplus-Strong puts a lowpass in the loop so high partials decay
    // first. With a BiquadFilterNode that is not safe here: a biquad recirculated
    // through a delay accumulates its own state, and Chrome eventually reports
    // "state is bad, probably due to unstable filter caused by fast parameter
    // automation" even with every parameter in range and feedback below unity.
    // Lowering the gain and adding a DC blocker inside the loop both failed to
    // clear it, because both left a filter in the path.
    //
    // A pure comb cannot diverge for gain < 1, so the tone shaping moves
    // *outside* the loop: one lowpass on the output tap whose cutoff falls
    // across the note. That reproduces what the in-loop filter was for — the
    // brightness dying away faster than the fundamental — with no recirculated
    // state at all.
    const delay = ctx.createDelay(0.05);
    delay.delayTime.value = period;

    const feedback = ctx.createGain();
    // Longer strings ring longer, so decay stays roughly constant in seconds
    // rather than in cycles, as it does on a real instrument.
    feedback.gain.value = Math.min(0.955, 0.978 - period * 4);

    const colour = ctx.createBiquadFilter();
    colour.type = 'lowpass';
    colour.frequency.setValueAtTime(4200, when);
    colour.frequency.exponentialRampToValueAtTime(900, when + seconds * 0.85);

    const amp = ctx.createGain();
    amp.gain.setValueAtTime((e.gain ?? 0.5) * 0.5, when);
    amp.gain.exponentialRampToValueAtTime(0.0001, when + seconds);

    burst.connect(delay);
    delay.connect(feedback).connect(delay);
    delay.connect(colour).connect(amp).connect(this.tone);

    burst.start(when);
    burst.stop(when + period * 1.5);
    this._register(amp, [burst], when + seconds);
    setTimeout(() => {
      try {
        delay.disconnect();
        colour.disconnect();
        feedback.disconnect();
        amp.disconnect();
      } catch {
        /* already torn down */
      }
    }, (when - ctx.currentTime + seconds + 0.4) * 1000);
  }

  /**
   * Bansuri-like line: a sine with a little odd harmonic, breath noise, and a
   * vibrato that arrives late. The delayed vibrato is what stops a sine from
   * sounding like a test tone — players do not start a note with it.
   */
  _flute(e, when) {
    const ctx = this.ctx;
    const freq = hz(e.note);
    const seconds = e.dur ?? 1.6;

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, when);
    // Slur into the note from just below, as a breath attack does.
    osc.frequency.setValueAtTime(freq * 0.985, when);
    osc.frequency.exponentialRampToValueAtTime(freq, when + 0.09);

    const colour = ctx.createOscillator();
    colour.type = 'triangle';
    colour.frequency.setValueAtTime(freq * 3, when);
    const colourGain = ctx.createGain();
    colourGain.gain.value = 0.06;

    const vibrato = ctx.createOscillator();
    vibrato.frequency.value = 4.8;
    const vibratoDepth = ctx.createGain();
    vibratoDepth.gain.setValueAtTime(0, when);
    vibratoDepth.gain.setValueAtTime(0, when + seconds * 0.35);
    vibratoDepth.gain.linearRampToValueAtTime(freq * 0.006, when + seconds * 0.75);
    vibrato.connect(vibratoDepth).connect(osc.frequency);

    const breath = ctx.createBufferSource();
    breath.buffer = this._noiseBuffer();
    breath.loop = true;
    const breathBand = ctx.createBiquadFilter();
    breathBand.type = 'bandpass';
    breathBand.frequency.value = freq * 2;
    breathBand.Q.value = 1.2;
    const breathGain = ctx.createGain();
    breathGain.gain.setValueAtTime(0.0001, when);
    breathGain.gain.exponentialRampToValueAtTime((e.gain ?? 0.5) * 0.05, when + 0.06);
    breathGain.gain.exponentialRampToValueAtTime(0.0001, when + seconds);

    const amp = ctx.createGain();
    const peak = (e.gain ?? 0.5) * 0.30;
    amp.gain.setValueAtTime(0.0001, when);
    amp.gain.exponentialRampToValueAtTime(peak, when + 0.14);
    amp.gain.setValueAtTime(peak, when + seconds * 0.6);
    amp.gain.exponentialRampToValueAtTime(0.0001, when + seconds);

    osc.connect(amp);
    colour.connect(colourGain).connect(amp);
    breath.connect(breathBand).connect(breathGain).connect(amp);
    amp.connect(this.tone);

    const voices = [osc, colour, vibrato, breath];
    for (const node of voices) {
      node.start(when);
      node.stop(when + seconds + 0.1);
    }
    this._register(amp, voices, when + seconds);
    osc.onended = () => {
      try {
        amp.disconnect();
        colourGain.disconnect();
        breathGain.disconnect();
      } catch {
        /* already torn down */
      }
    };
  }

  /** Tanpura-ish drone: two detuned saws, heavily filtered, very slow swell. */
  _drone(e, when) {
    const ctx = this.ctx;
    const seconds = e.dur ?? 8;
    const amp = ctx.createGain();
    amp.gain.setValueAtTime(0.0001, when);
    amp.gain.exponentialRampToValueAtTime((e.gain ?? 0.3) * 0.14, when + seconds * 0.35);
    amp.gain.exponentialRampToValueAtTime(0.0001, when + seconds);

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 700;
    filter.Q.value = 0.8;

    const voices = [];
    for (const detune of [-4, 4]) {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = hz(e.note);
      osc.detune.value = detune;
      osc.connect(filter);
      voices.push(osc);
    }
    filter.connect(amp).connect(this.tone);

    for (const v of voices) {
      v.start(when);
      v.stop(when + seconds + 0.1);
    }
    this._register(amp, voices, when + seconds);
    voices[0].onended = () => {
      try {
        filter.disconnect();
        amp.disconnect();
      } catch {
        /* already torn down */
      }
    };
  }

  /** Sustained bed for the endings. */
  _pad(e, when) {
    const ctx = this.ctx;
    const seconds = e.dur ?? 4;
    const amp = ctx.createGain();
    amp.gain.setValueAtTime(0.0001, when);
    amp.gain.exponentialRampToValueAtTime((e.gain ?? 0.4) * 0.16, when + seconds * 0.3);
    amp.gain.exponentialRampToValueAtTime(0.0001, when + seconds);

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(500, when);
    filter.frequency.linearRampToValueAtTime(1500, when + seconds * 0.5);

    const voices = [];
    for (const [mult, detune] of [[1, -6], [1, 7], [2, 0]]) {
      const osc = ctx.createOscillator();
      osc.type = mult === 2 ? 'sine' : 'sawtooth';
      osc.frequency.value = hz(e.note) * mult;
      osc.detune.value = detune;
      osc.connect(filter);
      voices.push(osc);
    }
    filter.connect(amp).connect(this.tone);
    for (const v of voices) {
      v.start(when);
      v.stop(when + seconds + 0.1);
    }
    this._register(amp, voices, when + seconds);
    voices[0].onended = () => {
      try {
        filter.disconnect();
        amp.disconnect();
      } catch {
        /* already torn down */
      }
    };
  }

  _noiseBuffer() {
    if (this._noise) return this._noise;
    const len = this.ctx.sampleRate * 2;
    const buffer = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    this._noise = buffer;
    return buffer;
  }

  dispose() {
    this.stop(0.05);
    clearInterval(this._timer);
    this._timer = null;
  }
}

// ---------------------------------------------------------------- cues --

const TONIC = -9; // C below A440

/**
 * Sortie: sparse and unresolved.
 *
 * Deliberately not a tune. A melody you can hum competes with the engine and
 * wears out over a long flight, so this is a slow drone with a plucked phrase
 * every few bars that never lands on the tonic. It should register as weather
 * rather than as music, and it ducks whenever the throttle is up.
 */
const sortie = {
  level: 0.5,
  ducks: true,
  fadeIn: 3.2,
  stepSeconds: 1.6,
  at(step) {
    const out = [];
    const bar = step % 16;
    if (bar === 0) {
      out.push({ voice: 'drone', note: TONIC - 12, dur: 26, gain: 0.55 });
      out.push({ voice: 'drone', note: TONIC - 5, dur: 26, gain: 0.32 });
    }
    // A phrase every fourth step, wandering the scale, avoiding the tonic so
    // nothing ever feels finished while the sortie is still running.
    if (bar % 4 === 2) {
      const degrees = [4, 2, 5, 3, 6, 2, 4, 1];
      const d = degrees[(step / 2 | 0) % degrees.length];
      out.push({
        voice: 'pluck',
        note: TONIC + 12 + BHAIRAVI[d],
        dur: 2.6,
        gain: 0.42,
      });
      if (bar === 10) {
        out.push({
          voice: 'pluck',
          note: TONIC + BHAIRAVI[(d + 2) % 7],
          dur: 3.4,
          gain: 0.3,
          offset: 0.42,
        });
      }
    }
    return out;
  },
};

/**
 * Loss: restrained, and short.
 *
 * The brief is explicit that failure must stay respectful and must not lean on
 * real sacrifice for weight, so this is not a lament. A falling line over a
 * single held chord, no percussion, and it stops rather than resolving.
 */
const loss = {
  level: 0.62,
  ducks: false,
  fadeIn: 0.9,
  stepSeconds: 2.1,
  at(step) {
    const out = [];
    if (step === 0) {
      out.push({ voice: 'pad', note: TONIC - 12, dur: 15, gain: 0.6 });
      out.push({ voice: 'pad', note: TONIC - 12 + 3, dur: 15, gain: 0.34 });
    }
    const line = [5, 4, 3, 1, 0, -2];
    if (step < line.length) {
      const d = line[step];
      const note = TONIC + (d >= 0 ? BHAIRAVI[d] : -12 + BHAIRAVI[d + 7]);
      out.push({ voice: 'flute', note: note + 12, dur: 2.6, gain: 0.5 });
    }
    if (step === line.length + 1) {
      out.push({ voice: 'pluck', note: TONIC, dur: 5, gain: 0.32 });
    }
    return out;
  },
};

/**
 * Return: warm and rising, and still not a fanfare.
 *
 * Brass and drums would turn the closing screen into a scoreboard, and the
 * remembrance card shares that moment. This lifts instead — a major-seventh
 * set, a flute line that climbs to the octave, and a pad that opens underneath.
 */
const ret = {
  level: 0.66,
  ducks: false,
  fadeIn: 1.1,
  stepSeconds: 1.9,
  at(step) {
    const out = [];
    if (step === 0) {
      out.push({ voice: 'pad', note: TONIC - 12, dur: 20, gain: 0.6 });
      out.push({ voice: 'pad', note: TONIC - 5, dur: 20, gain: 0.4 });
    }
    if (step === 4) out.push({ voice: 'pad', note: TONIC - 12 + 4, dur: 14, gain: 0.36 });

    const line = [0, 2, 4, 3, 4, 6, 7];
    if (step < line.length) {
      const d = line[step];
      const note = TONIC + 12 + (d < 7 ? DESH_ISH[d] : 12);
      out.push({ voice: 'flute', note, dur: 2.4, gain: 0.55 });
      out.push({ voice: 'pluck', note: note - 12, dur: 2.8, gain: 0.26, offset: 0.1 });
    }
    if (step === line.length + 1) {
      out.push({ voice: 'pluck', note: TONIC + 12, dur: 6, gain: 0.4 });
      out.push({ voice: 'flute', note: TONIC + 24, dur: 5, gain: 0.4, offset: 0.25 });
    }
    return out;
  },
};

const CUES = { sortie, loss, return: ret };
