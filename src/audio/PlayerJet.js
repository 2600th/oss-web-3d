/**
 * The player's MiG-21: a layered, continuously driven engine + airflow model.
 *
 * Layers (all seamless loops, started once and only re-mixed):
 *   whine    compressor/turbine blade-pass tones   pitch ∝ spool (N2)
 *   intake   intake howl / resonance                cockpit-forward
 *   roar     exhaust jet-mixing noise + crackle      external-forward
 *   rumble   low airframe rumble                    cockpit
 *   ab       afterburner roar                        reheat
 *   wind     airflow over canopy/airframe           ∝ dynamic pressure
 *   buffet   low thumps + panel rattle              ∝ AoA / G / stall
 * One-shots: afterburner light-off thump, anti-G strain breaths at high G.
 *
 * Mix "blend" b: 1 = cockpit (canopy-filtered roar, more whine, intake, rumble),
 * 0 = external chase view (roar and burner dominate). Layers go through one
 * panner placed at the jet's exhaust relative to the camera so the chase view
 * hears the aircraft in front of it and the cockpit hears the engine behind.
 */
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const approach = (cur, target, rateUp, rateDown, dt) => {
  const r = target > cur ? rateUp : rateDown;
  return cur + (target - cur) * (1 - Math.exp(-dt * r));
};

export class PlayerJet {
  constructor(engine, voices) {
    this.engine = engine;
    this.voices = voices;
    this.layers = null;
    this.blend = 0;          // 0 external .. 1 cockpit
    this.blendTarget = 0;
    this.spool = 0.6;
    this.ab = 0;
    this.alive = true;
    this.master = 1;
    this._lastReheat = false;
    this._abCooldown = 0;
    this._gTime = 0;
    this._breathCooldown = 0;
    this.state = {};
  }

  start() {
    const e = this.engine;
    const ctx = e.ctx;
    if (!ctx || this.layers) return;
    this.out = ctx.createGain();
    this.out.gain.value = 0;
    this.panner = ctx.createPanner();
    this.panner.panningModel = e.panningModel;
    this.panner.rolloffFactor = 0;
    this.out.connect(this.panner).connect(e.cockpit);
    // canopy filter for the exterior-noise layers in cockpit view
    this.canopy = ctx.createBiquadFilter();
    this.canopy.type = 'lowpass';
    this.canopy.frequency.value = 12000;
    this.canopy.connect(this.out);
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = 'lowpass';
    this.windFilter.frequency.value = 1500;
    this.windFilter.connect(this.out);
    const mk = (id, dest) => this.voices.play(id, { destination: dest, gain: 0, loop: true });
    this.layers = {
      whine: mk('jet_whine', this.out),
      intake: mk('jet_intake', this.out),
      roar: mk('jet_roar', this.canopy),
      rumble: mk('jet_rumble', this.out),
      ab: mk('ab_roar', this.canopy),
      wind: mk('wind', this.windFilter),
      buffet: mk('buffet', this.out),
    };
    this.out.gain.setTargetAtTime(1, ctx.currentTime, 0.4);
  }

  setView(mode) {
    this.blendTarget = mode === 'cockpit' || mode === 'hud' ? 1 : 0;
  }

  kill() {
    this.alive = false;
    if (this.out) this.out.gain.setTargetAtTime(0, this.engine.now, 0.08);
  }

  revive() {
    if (this.alive) return;
    this.alive = true;
    this.spool = 0.3;
    if (this.out) this.out.gain.setTargetAtTime(1, this.engine.now, 0.6);
  }

  /** flight: FlightModel; aircraftPos: exhaust world position (optional). */
  update(dt, flight, extras = {}) {
    if (!this.layers || !flight) return;
    const e = this.engine;
    const ctx = e.ctx;
    const t = ctx.currentTime;

    if (flight.crashed && this.alive) this.kill();
    else if (!flight.crashed && !this.alive) this.revive();

    this.blend = approach(this.blend, this.blendTarget, 8, 8, dt);
    const b = this.blend;
    const thr = clamp(flight.throttleSmoothed ?? flight.throttle ?? 0.7);
    // spool: idle N2 ~55 %, spools up faster than it winds down
    this.spool = approach(this.spool, 0.55 + 0.45 * thr, 1.6, 0.9, dt);
    const rpm = this.spool;
    const reheat = !!flight.reheat;
    this.ab = approach(this.ab, reheat ? 1 : 0, 5, 1.6, dt);
    this._abCooldown -= dt;
    if (reheat && !this._lastReheat && this._abCooldown <= 0 && this.alive) {
      this.voices.play('ab_lightoff', { destination: this.canopy, gain: 0.9 - 0.3 * b });
      this._abCooldown = 1.2;
    }
    this._lastReheat = reheat;

    const v = Math.max(0, flight.airspeed ?? 0);
    const q = clamp((v / 280) ** 2, 0, 1.8);           // dynamic pressure, 1 at 280 m/s
    const aoa = Math.abs(flight.angleOfAttack ?? 0);
    const g = flight.gLoad ?? 1;
    const buffet = clamp((aoa - 0.17) / 0.22) * clamp(v / 120) + clamp((g - 5.5) / 3.5) * 0.7 + (flight.stallFactor ?? 0) * 0.8;

    const ext = 1 - b;
    const rpm2 = rpm * rpm;
    const L = this.layers;
    const set = (h, gain, rate) => {
      h.amp.gain.setTargetAtTime(gain, t, 0.06);
      if (rate !== undefined) h.source.playbackRate.setTargetAtTime(rate, t, 0.08);
    };
    set(L.whine, (0.18 + 0.5 * rpm2) * (0.55 * b + 0.3 * ext), 0.62 + 0.55 * rpm);
    set(L.intake, (0.1 + 0.5 * rpm2) * (0.55 * b + 0.12 * ext) * (0.6 + 0.4 * clamp(v / 250)), 0.8 + 0.3 * rpm);
    set(L.roar, (0.2 + 0.8 * rpm2) * (0.85 * ext + 0.35 * b), 0.88 + 0.18 * rpm);
    set(L.rumble, (0.25 + 0.5 * rpm) * (0.7 * b + 0.25 * ext) + 0.25 * this.ab * b, 0.9 + 0.15 * rpm);
    set(L.ab, this.ab * (1.0 * ext + 0.55 * b), 0.95 + 0.06 * this.ab);
    set(L.wind, q * (0.55 * b + 0.45 * ext), 0.75 + 0.45 * clamp(v / 450));
    set(L.buffet, clamp(buffet, 0, 1.2) * (0.9 * b + 0.45 * ext), 0.9 + 0.2 * clamp(g / 9));
    this.canopy.frequency.setTargetAtTime(12000 * ext + 1100 * b, t, 0.08);
    this.windFilter.frequency.setTargetAtTime((350 + v * 14) * (b ? 0.55 + 0.45 * ext : 1), t, 0.1);

    // panner at the exhaust, relative to the listener
    const P = extras.exhaust;
    if (P) {
      const Lp = e.listener.position;
      let dx = P.x - Lp.x, dy = P.y - Lp.y, dz = P.z - Lp.z;
      const d = Math.hypot(dx, dy, dz) || 1;
      dx /= d; dy /= d; dz /= d;
      if (this.panner.positionX) {
        this.panner.positionX.setTargetAtTime(dx, t, 0.03);
        this.panner.positionY.setTargetAtTime(dy, t, 0.03);
        this.panner.positionZ.setTargetAtTime(dz, t, 0.03);
      } else this.panner.setPosition(dx, dy, dz);
    }

    // anti-G straining breaths: sustained > 6 G, a breath every ~2.6 s
    if (g > 6.2 && this.alive) this._gTime += dt; else this._gTime = Math.max(0, this._gTime - dt * 2);
    this._breathCooldown -= dt;
    if (this._gTime > 0.7 && this._breathCooldown <= 0) {
      this.voices.play('g_breath', { bus: 'cockpit', gain: (0.22 + 0.12 * clamp((g - 6) / 3)) * (0.35 + 0.65 * b) });
      this._breathCooldown = 2.3 + Math.random() * 0.8;
    }

    this.state = { rpm, ab: this.ab, q, buffet, blend: b, g };
  }

  dispose() {
    if (!this.layers) return;
    for (const h of Object.values(this.layers)) h?.stop(0.05);
    this.layers = null;
  }
}
