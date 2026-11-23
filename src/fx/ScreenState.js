/**
 * Screen-state model (pure, no three.js): turns flight state and combat events
 * into the 0..1 drivers the post chain draws.
 *
 *   grey      G-LOC greyout / tunnel vision from sustained positive G
 *   red       redout from sustained negative G
 *   damage    red edge pulse + desaturation on a hit (decays)
 *   smear     brief radial smear + chromatic spike on a hit (decays fast)
 *   lowHealth persistent heartbeat edge pulse below ~35% health
 *   flash     whiteout from a nearby explosion (HDR, decays fast)
 *   wet       droplets on the lens: rises in cloud, dries over a few seconds
 *
 * G tolerance is modelled as a stress reservoir rather than an instantaneous
 * threshold: a 9 G snap for half a second is survivable, 7 G held through a
 * full turn is not. That is what makes greyout feel earned instead of random.
 */
export const SCREEN_DEFAULTS = Object.freeze({
  gOnset: 5.2, // +G at which stress starts to accumulate
  gRate: 0.22, // stress per second per G above onset
  gRecover: 0.45, // stress recovery per second below onset (scaled by margin)
  negOnset: -1.6, // -G at which redout stress builds
  negRate: 0.5,
  negRecover: 0.8,
  damageDecay: 1.1, // 1/s
  smearDecay: 6.0,
  flashDecay: 5.0,
  wetRise: 2.5,
  wetDry: 0.35,
  lowHealth: 0.35,
});

const clamp01 = (x) => Math.min(1, Math.max(0, x));
const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const decay = (v, rate, dt) => v * Math.exp(-rate * dt);

export class ScreenState {
  constructor(options = {}) {
    this.o = { ...SCREEN_DEFAULTS, ...options };
    this.reset();
  }

  reset() {
    this.gStress = 0;
    this.negStress = 0;
    this.grey = 0;
    this.red = 0;
    this.damage = 0;
    this.smear = 0;
    this.lowHealth = 0;
    this.flash = 0;
    this.wet = 0;
    this.time = 0;
  }

  /**
   * A hit on the player, by severity 0..1 (`player:hit` severity: a stray
   * round ~0.2, a missile 1). Scales from zero: there used to be a 0.35
   * floor, so every graze flashed a third of the full red edge and smear,
   * and a burst of small hits strobed the screen. The edge rises a little
   * faster than linear; the smear only shows on the heavy ones.
   */
  hitSeverity(severity = 0.3) {
    const s = clamp01(severity);
    this.damage = Math.max(this.damage, Math.pow(s, 1.25));
    this.smear = Math.max(this.smear, s * s);
  }

  /** A hit as a fraction of max health (0..1); same curve as camera hitSeverity. */
  hit(damage = 0.1) {
    this.hitSeverity(Math.sqrt(Math.max(0, damage) / 0.25));
  }

  /**
   * An explosion at `distance` metres. Size scales the flash radius.
   * Returns the flash amount added (callers use it for shake too).
   */
  explosion(distance, size = 'medium') {
    const radius = { small: 60, medium: 140, large: 300, huge: 600 }[size] ?? 140;
    if (!(distance < radius)) return 0;
    const f = Math.pow(1 - distance / radius, 1.5) * ({ small: 0.5, medium: 0.8, large: 1, huge: 1 }[size] ?? 0.8);
    this.flash = Math.max(this.flash, f);
    return f;
  }

  /**
   * @param {number} dt real (unscaled) seconds
   * @param {{gLoad?:number, health?:number, inCloud?:number, alive?:boolean}} s
   */
  update(dt, s = {}) {
    const o = this.o;
    dt = Math.max(0, Math.min(dt, 0.1));
    this.time += dt;
    const g = Number.isFinite(s.gLoad) ? s.gLoad : 1;
    const alive = s.alive !== false;

    if (alive && g > o.gOnset) this.gStress += (g - o.gOnset) * o.gRate * dt;
    else this.gStress -= o.gRecover * dt * (1 + Math.max(0, o.gOnset - g) * 0.25);
    this.gStress = Math.min(1.15, Math.max(0, this.gStress));

    if (alive && g < o.negOnset) this.negStress += (o.negOnset - g) * o.negRate * dt;
    else this.negStress -= o.negRecover * dt;
    this.negStress = Math.min(1.1, Math.max(0, this.negStress));

    this.grey = smooth(0.15, 1.0, this.gStress);
    this.red = smooth(0.1, 0.9, this.negStress);

    this.damage = decay(this.damage, o.damageDecay, dt);
    this.smear = decay(this.smear, o.smearDecay, dt);
    this.flash = decay(this.flash, o.flashDecay, dt);

    const h = Number.isFinite(s.health) ? s.health : 1;
    const low = alive ? smooth(o.lowHealth, 0.08, h) : 0;
    // heartbeat: two quick beats per ~1.1 s cycle, stronger as health drops
    const ph = (this.time * (0.9 + low * 0.5)) % 1;
    const beat = Math.exp(-Math.pow((ph - 0.05) / 0.05, 2)) + 0.6 * Math.exp(-Math.pow((ph - 0.22) / 0.05, 2));
    this.lowHealth = low * (0.35 + 0.65 * beat);

    const cloud = clamp01(s.inCloud ?? 0);
    if (cloud > this.wet) this.wet += (cloud - this.wet) * (1 - Math.exp(-o.wetRise * dt));
    else this.wet = decay(this.wet, o.wetDry, dt);
    return this;
  }
}
