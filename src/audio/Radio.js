/**
 * Radio: squelch open → voice (or synthesised "radio chatter" when a message
 * has only text) → squelch close, all through a band-limited, lightly
 * overdriven comms chain with a static bed. Music ducks while a channel is
 * open. Messages queue; a higher `priority` pre-empts the current one.
 *
 * Text-only messages get a formant "babble": syllable-rate pitch and vowel
 * changes under the radio band-pass, read as speech cadence without words, at
 * a length proportional to the text so the subtitle and the sound end together.
 */
function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

const VOWELS = [[730, 1090], [530, 1840], [270, 2290], [570, 840], [440, 1020], [660, 1720], [390, 1990]];

export class Radio {
  constructor(engine, voices, bank) {
    this.engine = engine;
    this.voices = voices;
    this.bank = bank;
    this.queue = [];
    this.current = null;
    this.babbleLevel = 0.11;
  }

  _chain() {
    if (this.input) return;
    const ctx = this.engine.ctx;
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 380; hp.Q.value = 0.8;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3100; lp.Q.value = 0.9;
    const pk = ctx.createBiquadFilter(); pk.type = 'peaking'; pk.frequency.value = 1700; pk.gain.value = 5; pk.Q.value = 1.1;
    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(1024);
    for (let i = 0; i < curve.length; i++) { const x = i / 511.5 - 1; curve[i] = Math.tanh(x * 2.2) / Math.tanh(2.2); }
    shaper.curve = curve;
    shaper.oversample = '2x';
    this.input = ctx.createGain();
    this.input.connect(hp).connect(pk).connect(shaper).connect(lp).connect(this.engine.radioIn);
  }

  /** payload: { speaker, callsign, text, priority, voice? } */
  say(msg) {
    if (!this.engine.ctx) return;
    this._chain();
    const m = { priority: 0, ...msg };
    if (this.current && m.priority > (this.current.priority ?? 0)) {
      this._end(true);
    }
    this.queue.push(m);
    this.queue.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
    if (!this.current) this._next();
  }

  get busy() { return !!this.current; }

  async _next() {
    const m = this.queue.shift();
    if (!m) { this.engine.duckMusic(0, 0.4); return; }
    this.current = m;
    const ctx = this.engine.ctx;
    this.engine.duckMusic(0.55, 0.08);
    this.voices.play('radio_open', { destination: this.input, gain: 0.45 });
    this._static = this.voices.play('radio_static', { destination: this.input, gain: 0.0, loop: true });
    this._static?.setGain(0.16, 0.03);
    let dur;
    if (m.voice) {
      try {
        const res = await fetch(m.voice);
        const buf = await ctx.decodeAudioData(await res.arrayBuffer());
        if (this.current !== m) return;
        this._voice = this.voices.play(null, { buffer: buf, destination: this.input, gain: 1, when: 0.08 });
        dur = buf.duration + 0.1;
      } catch { dur = null; }
    }
    if (!dur) dur = this._babble(m, ctx.currentTime + 0.1);
    this._timer = setTimeout(() => this._end(false), (dur + 0.15) * 1000);
  }

  _babble(m, t0) {
    const ctx = this.engine.ctx;
    const text = String(m.text ?? '');
    const words = text.split(/\s+/).filter(Boolean);
    const seed = hash(String(m.callsign ?? m.speaker ?? 'x'));
    let s = seed;
    const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
    const f0 = 92 + (seed % 90);              // voice pitch per callsign
    const syllables = Math.max(3, Math.min(60, Math.round(text.replace(/[^a-z0-9]/gi, '').length / 2.6)));
    const rate = 5.2 + (seed % 5) * 0.35;     // syllables / s
    const dur = Math.min(7, syllables / rate + words.length * 0.035);

    const osc = ctx.createOscillator(); osc.type = 'sawtooth';
    const nz = ctx.createBufferSource();
    const nb = ctx.createBuffer(1, ctx.sampleRate * 0.5, ctx.sampleRate);
    const d = nb.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    nz.buffer = nb; nz.loop = true;
    const nzg = ctx.createGain(); nzg.gain.value = 0.12;
    const vca = ctx.createGain(); vca.gain.value = 0;
    const f1 = ctx.createBiquadFilter(); f1.type = 'bandpass'; f1.Q.value = 6;
    const f2 = ctx.createBiquadFilter(); f2.type = 'bandpass'; f2.Q.value = 9;
    const out = ctx.createGain(); out.gain.value = this.babbleLevel;
    osc.connect(vca); nz.connect(nzg).connect(vca);
    vca.connect(f1).connect(out);
    vca.connect(f2).connect(out);
    out.connect(this.input);

    let t = t0;
    const end = t0 + dur;
    vca.gain.setValueAtTime(0, t0);
    osc.frequency.setValueAtTime(f0, t0);
    let wordLeft = 1 + Math.floor(rnd() * 3);
    while (t < end - 0.05) {
      const len = (0.6 + rnd() * 0.8) / rate;
      const [a, b] = VOWELS[Math.floor(rnd() * VOWELS.length)];
      f1.frequency.setTargetAtTime(a, t, 0.012);
      f2.frequency.setTargetAtTime(b, t, 0.012);
      osc.frequency.setTargetAtTime(f0 * (0.9 + rnd() * 0.3), t, 0.03);
      vca.gain.setTargetAtTime(0.9 + rnd() * 0.3, t, 0.008);
      vca.gain.setTargetAtTime(0.15, t + len * 0.7, 0.01);
      t += len;
      if (--wordLeft <= 0) { // word gap
        vca.gain.setTargetAtTime(0, t, 0.01);
        t += 0.04 + rnd() * 0.07;
        wordLeft = 1 + Math.floor(rnd() * 3);
      }
    }
    vca.gain.setTargetAtTime(0, end, 0.02);
    osc.start(t0); nz.start(t0);
    osc.stop(end + 0.2); nz.stop(end + 0.2);
    osc.onended = () => { osc.disconnect(); nz.disconnect(); vca.disconnect(); out.disconnect(); };
    this._babbleNodes = { osc, nz };
    return dur;
  }

  _end(preempted) {
    clearTimeout(this._timer);
    if (!this.current) return;
    this.current = null;
    this._voice?.stop(0.03); this._voice = null;
    if (this._babbleNodes) { try { this._babbleNodes.osc.stop(); this._babbleNodes.nz.stop(); } catch { /* */ } this._babbleNodes = null; }
    this._static?.stop(0.06); this._static = null;
    this.voices.play('radio_close', { destination: this.input, gain: 0.45 });
    if (preempted) return;
    setTimeout(() => this._next(), 250);
  }
}
