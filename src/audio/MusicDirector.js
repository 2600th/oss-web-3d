import { MusicState, COMBAT_CUES } from './musicState.js';

/**
 * Adaptive score player.
 *
 * Cues (manifest `music`): menu, briefing, cruise, combat_1/2/3 (group
 * "combat": three full-mix intensity versions of the same 32 bars, started
 * sample-synchronously and crossfaded with sum-to-1 weights from the
 * intensity level), ace, victory, defeat, memorial, plus stingers
 * sting_complete / sting_failed.
 *
 * Cue changes are quantised to the next beat of the outgoing cue (bar for
 * calm → calm changes), fade the old cue out over ~2.5 s and the new one in.
 */
const CUE_FILES = {
  menu: ['menu'], briefing: ['briefing'], cruise: ['cruise'],
  combat: ['combat_1', 'combat_2', 'combat_3'], ace: ['ace'],
  victory: ['victory'], defeat: ['defeat'], memorial: ['memorial'],
};

export class MusicDirector {
  constructor(engine, bank) {
    this.engine = engine;
    this.bank = bank;
    this.state = new MusicState();
    this.playing = null;   // { cue, sources:[{src, gain}], startAt, bpm, beatsPerBar, loopLen, gain }
    this._token = 0;
    this.last = { cue: null, level: 0, weights: [1, 0, 0] };
  }

  request(r, authoritative = true) { this.state.request(r, this._now(), authoritative); }
  heat(a) { this.state.heat(a, this._now()); }
  set autoFlight(v) { this.state.autoFlight = v; }
  _now() { return performance.now() / 1000; }

  async stinger(id, gain = 1) {
    if (!this.engine.ctx) return;
    const buf = await this.bank.music(id);
    if (!buf) return;
    const ctx = this.engine.ctx;
    const e = this.bank.musicEntry(id);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    g.gain.value = gain * (e?.gain ?? 1);
    src.connect(g).connect(this.engine.musicIn);
    src.start(ctx.currentTime + 0.02, e?.start ?? 0);
    // dip the running cue under the stinger
    if (this.playing) {
      const t = ctx.currentTime;
      this.playing.master.gain.setTargetAtTime(0.25, t, 0.1);
      this.playing.master.gain.setTargetAtTime(1, t + Math.min(buf.duration, 4), 0.8);
    }
    src.onended = () => { src.disconnect(); g.disconnect(); };
  }

  update() {
    const o = this.state.update(this._now());
    this.last = o;
    if (!this.engine.ctx) return o;
    if (o.cue !== this._failed) this._failed = undefined;
    if (o.cue !== (this.playing?.cue ?? null) && this._pendingCue !== o.cue && this._failed !== o.cue) {
      this._switch(o.cue);
    }
    // combat stems follow the level continuously
    if (this.playing?.cue === 'combat' && this.playing.sources.length === 3) {
      const t = this.engine.ctx.currentTime;
      this.playing.sources.forEach((s, i) => s.gain.gain.setTargetAtTime(o.weights[i], t, 0.35));
    }
    return o;
  }

  async _switch(cue) {
    const token = ++this._token;
    this._pendingCue = cue;
    const ctx = this.engine.ctx;
    const old = this.playing;
    if (!cue) {
      if (old) this._fadeOut(old, ctx.currentTime, 2.0);
      this.playing = null;
      this._pendingCue = undefined;
      return;
    }
    const ids = CUE_FILES[cue] ?? [cue];
    const bufs = await Promise.all(ids.map((id) => this.bank.music(id)));
    if (token !== this._token) return; // superseded while decoding
    this._pendingCue = undefined;
    if (bufs.some((b) => !b)) { this._failed = cue; console.warn('[audio] missing music for', cue); return; }
    const entry = this.bank.musicEntry(ids[0]);

    // quantise the entry to the next beat (or bar, for calm cues) of the old cue
    let at = ctx.currentTime + 0.05;
    if (old?.bpm && old.loop) {
      const beat = 60 / old.bpm;
      const unit = COMBAT_CUES.has(cue) ? beat : beat * (old.beatsPerBar ?? 4);
      const pos = (ctx.currentTime - old.startAt) % (old.loopLen || Infinity);
      const wait = unit - (pos % unit);
      if (wait < 2.5) at = ctx.currentTime + wait;
    }
    if (old) this._fadeOut(old, at, COMBAT_CUES.has(cue) ? 1.2 : 2.6);

    const master = ctx.createGain();
    master.gain.value = 0;
    master.connect(this.engine.musicIn);
    const fadeIn = COMBAT_CUES.has(cue) ? 0.25 : (cue === 'victory' || cue === 'defeat' ? 0.05 : 1.2);
    master.gain.setValueAtTime(0, at);
    master.gain.setTargetAtTime(entry?.gain ?? 1, at, fadeIn / 3);
    const weights = cue === 'combat' ? this.last.weights : [1];
    const sources = bufs.map((buf, i) => {
      const e = this.bank.musicEntry(ids[i]);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      if (e.loop) { src.loop = true; src.loopStart = e.loopStart; src.loopEnd = e.loopEnd; }
      const g = ctx.createGain();
      g.gain.value = weights[i] ?? 0;
      src.connect(g).connect(master);
      src.start(at, e.loop ? e.loopStart : (e.start ?? 0));
      return { src, gain: g };
    });
    this.playing = {
      cue, sources, master, startAt: at, bpm: entry?.bpm, beatsPerBar: entry?.beatsPerBar,
      loop: !!entry?.loop, loopLen: entry?.loop ? entry.loopEnd - entry.loopStart : 0,
    };
    // prefetch what usually follows
    const next = { menu: ['briefing', 'cruise'], briefing: ['cruise'], cruise: ['combat_1', 'combat_2', 'combat_3'],
      combat: ['ace', 'cruise', 'victory', 'defeat'], ace: ['combat_1', 'combat_2', 'combat_3'] }[cue] ?? [];
    this.bank.prefetchMusic(next);
  }

  _fadeOut(p, at, seconds) {
    const t = Math.max(at, this.engine.ctx.currentTime);
    p.master.gain.cancelScheduledValues(t);
    p.master.gain.setValueAtTime(p.master.gain.value, this.engine.ctx.currentTime);
    p.master.gain.setTargetAtTime(0, t, seconds / 4);
    for (const s of p.sources) { try { s.src.stop(t + seconds + 0.5); } catch { /* */ } }
    setTimeout(() => { p.master.disconnect(); }, (t - this.engine.ctx.currentTime + seconds + 1) * 1000);
  }

  /** Name of what is audible now (for HUD/debug). */
  get cue() { return this.playing?.cue ?? null; }
}
