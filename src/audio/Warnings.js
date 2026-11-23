/**
 * Cockpit tones, synthesised live (exact pitches, zero download, instant).
 *
 *   acquire  IR seeker "growl": a gritty FM tone pulsing while the seeker hunts,
 *            rising in pitch and pulse rate as the lock builds
 *   locked   solid, steady high tone
 *   rwr      launch warning: slow two-tone beeps
 *   missile  missile alert: rapid alternating beeps, faster as it closes
 *   lockon   a hostile radar has us locked: slow low beeps
 *   pullup   terrain: rising "whoop" sweeps
 *   stall    low pulsing buzz
 *   damage   slow single beep while critically damaged
 *
 * Square gating LFOs pass through a lowpass before reaching the gain so the
 * beeps have soft 3-5 ms edges instead of clicks.
 */
const DEFS = {
  // `rise` (optional): what `setLevel(name, 0..1)` sweeps. The seeker growl
  // climbs in pitch and pulse rate as the lock builds; the missile alert
  // beeps faster as the missile closes.
  acquire: { type: 'triangle', freq: 640, fm: [27, 38], gate: 5, gain: 0.16, rise: { freq: [640, 920], gate: [5, 13] } },
  locked: { type: 'triangle', freq: 1180, fm: [6, 4], gain: 0.13 },
  rwr: { type: 'square', freq: 1000, alt: 1350, altHz: 1, gate: 4, gain: 0.07, lp: 3500 },
  missile: { type: 'square', freq: 1450, alt: 1080, altHz: 4.5, gate: 9, gain: 0.09, lp: 4000, rise: { gate: [9, 17], altHz: [4.5, 8.5] } },
  // a hostile radar has locked us, nothing in the air yet: slow, low, steady
  lockon: { type: 'square', freq: 820, gate: 2.2, gain: 0.055, lp: 2600 },
  pullup: { type: 'sawtooth', sweep: [480, 1250], sweepHz: 1.4, gate: 1.4, gain: 0.08, lp: 3000 },
  stall: { type: 'square', freq: 360, gate: 3.5, gain: 0.07, lp: 1400 },
  damage: { type: 'triangle', freq: 880, gate: 1.1, gain: 0.08 },
};

/** Parameter values for a tone's `rise` at level `x` (0..1); pure, tested. */
export function riseParams(name, x) {
  const r = DEFS[name]?.rise;
  if (!r) return null;
  const k = Math.min(1, Math.max(0, Number(x) || 0));
  const out = {};
  for (const [key, [a, b]] of Object.entries(r)) out[key] = a + (b - a) * k;
  return out;
}

export class Warnings {
  constructor(engine) {
    this.engine = engine;
    this.active = new Map();
  }

  isOn(name) { return this.active.has(name); }

  set(name, on) {
    if (!this.engine.ctx) return;
    if (on && !this.active.has(name)) this.active.set(name, this._start(name));
    else if (!on && this.active.has(name)) { this._stop(this.active.get(name)); this.active.delete(name); }
  }

  clear() { for (const n of [...this.active.keys()]) this.set(n, false); }

  /** Sweep a playing tone's `rise` parameters (0..1). No-op for tones without one. */
  setLevel(name, x) {
    const v = this.active.get(name);
    const p = v && riseParams(name, x);
    if (!p) return;
    const t = this.engine.ctx.currentTime;
    if (p.freq !== undefined) v.osc.frequency.setTargetAtTime(p.freq, t, 0.05);
    if (p.gate !== undefined && v.gate) v.gate.frequency.setTargetAtTime(p.gate, t, 0.05);
    if (p.altHz !== undefined && v.alt) v.alt.frequency.setTargetAtTime(p.altHz, t, 0.05);
  }

  _start(name) {
    const d = DEFS[name];
    const ctx = this.engine.ctx;
    const t = ctx.currentTime;
    const nodes = [];
    const osc = ctx.createOscillator();
    osc.type = d.type;
    osc.frequency.value = d.freq ?? d.sweep[0];
    nodes.push(osc);
    let src = osc;
    if (d.lp) {
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass'; f.frequency.value = d.lp;
      osc.connect(f); src = f; nodes.push(f);
    }
    const vca = ctx.createGain();
    vca.gain.value = d.gate ? 0.5 : 1;
    const out = ctx.createGain();
    out.gain.value = 0;
    src.connect(vca).connect(out).connect(this.engine.cockpit);
    nodes.push(vca, out);
    const lfo = (type, hz, depth, target, smooth) => {
      const o = ctx.createOscillator();
      o.type = type; o.frequency.value = hz;
      const g = ctx.createGain(); g.gain.value = depth;
      if (smooth) {
        const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = smooth;
        o.connect(f).connect(g); nodes.push(f);
      } else o.connect(g);
      g.connect(target);
      o.start(t);
      nodes.push(o, g);
      return o;
    };
    let gate = null;
    let alt = null;
    if (d.gate) gate = lfo('square', d.gate, 0.5, vca.gain, 120);
    if (d.fm) lfo('sine', d.fm[0], d.fm[1], osc.frequency);
    if (d.alt) {
      osc.frequency.value = (d.freq + d.alt) / 2;
      alt = lfo('square', d.altHz, (d.alt - d.freq) / 2, osc.frequency, 200);
    }
    if (d.sweep) {
      osc.frequency.value = (d.sweep[0] + d.sweep[1]) / 2;
      lfo('sawtooth', d.sweepHz, (d.sweep[1] - d.sweep[0]) / 2, osc.frequency);
    }
    osc.start(t);
    out.gain.setTargetAtTime(d.gain, t, 0.006);
    return { nodes, out, osc, gate, alt };
  }

  _stop(v) {
    const ctx = this.engine.ctx;
    const t = ctx.currentTime;
    v.out.gain.cancelScheduledValues(t);
    v.out.gain.setTargetAtTime(0, t, 0.01);
    for (const n of v.nodes) if (n.stop) { try { n.stop(t + 0.08); } catch { /* */ } }
    setTimeout(() => v.nodes.forEach((n) => n.disconnect()), 200);
  }
}
