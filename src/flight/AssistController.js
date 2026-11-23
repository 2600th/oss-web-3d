import { AIRCRAFT } from './FlightModel.js';

const GRAVITY = 9.80665;

// Auto-throttle remains load-driven at normal speed. Inside this recovery
// band, airspeed progressively wins and commands full power before the HUD's
// stall warning can light. Multiples keep the envelope tied to FlightModel's
// authoritative stall speed instead of duplicating a second speed table.
const AUTO_THROTTLE_FULL_SPEED = AIRCRAFT.stallSpeed * 1.25;
const AUTO_THROTTLE_ENTRY_SPEED = AIRCRAFT.stallSpeed * 2.0;
const AUTO_TURN_MIN_SPEED = AIRCRAFT.stallSpeed * 1.25;
const AUTO_TURN_ENTRY_SPEED = AIRCRAFT.stallSpeed * 2.0;
const AUTO_TURN_MIN_AUTHORITY = 0.35;

/**
 * Assisted-flight envelopes.
 *
 * The turn axis is a **rate command**, not a bank command. That is the whole
 * fix. The previous controller mapped the stick to a bank angle (28/38/44
 * degrees) and then held the flight path, which is a coordinated level turn —
 * and a coordinated level turn rate is g·tan(bank)/V, so 38 degrees at 266 m/s
 * is 1.7 deg/s on paper and measured 3.2 deg/s in flight. A 360 took ninety
 * seconds. Nothing downstream of that mapping could have rescued it: at this
 * speed the bank limit *is* the turn rate.
 *
 * So `turnRate` is what the stick asks for, and the load factor and bank angle
 * are *derived* from it: n = sqrt(1 + (omega·V/g)^2), bank = acos(1/n). The
 * aircraft therefore lays over as far as the requested rate actually requires —
 * around 82 degrees at cruise — and the vertical loop's job stays consistent
 * with the roll loop's instead of fighting it, because the load the path-hold
 * needs and the load the turn needs are now the same number by construction.
 *
 * It also makes the turn speed-stable, which is the property that reads as
 * "arcade": the same stick gives the same degrees per second at 180 m/s and at
 * 400 m/s, right up until `turnLoad` (the structural/comfort cap) binds. Above
 * that the rate falls off with speed exactly as a real airframe's does, so a
 * hard turn still rewards bleeding energy down toward corner speed.
 *
 * `climb` was 11-14.5 degrees of flight path, which is not enough to clear a
 * Himalayan ridge that is already filling the canopy. These are still shallow
 * enough that the horizon never leaves the frame.
 */
const SENSITIVITY = {
  low: {
    turnRate: 11 * Math.PI / 180,
    turnLoad: 5.0,
    climb: 26 * Math.PI / 180,
    climbLoad: 3.6,
    response: 0.78,
    verticalResponse: 0.8,
    rollLimit: 0.55,
  },
  normal: {
    turnRate: 18 * Math.PI / 180,
    turnLoad: 7.5,
    climb: 32 * Math.PI / 180,
    climbLoad: 5.0,
    response: 1,
    verticalResponse: 1,
    rollLimit: 0.78,
  },
  high: {
    turnRate: 24 * Math.PI / 180,
    turnLoad: 9.0,
    climb: 38 * Math.PI / 180,
    climbLoad: 6.0,
    response: 1.2,
    verticalResponse: 1.15,
    rollLimit: 0.94,
  },
  /**
   * Standard-mode combat profile: the stick asks for a hard coordinated turn
   * and a steep flight path, enough to fight with. With the airbrake held the
   * `highG*` numbers blend in, so brake + turn is the genre's high-G turn.
   */
  combat: {
    turnRate: 27 * Math.PI / 180,
    turnLoad: 8.8,
    highGTurnRate: 40 * Math.PI / 180,
    highGTurnLoad: 13,
    climb: 68 * Math.PI / 180,
    climbLoad: 7.5,
    response: 1.3,
    verticalResponse: 1.2,
    rollLimit: 1,
    liftVector: true,
  },
};

/** Proportional and rate gains on the bank loop. */
const ROLL_P = 1.9;
const ROLL_D = 0.30;

/**
 * Proportional and rate gains on the flight-path loop.
 *
 * PATH_D damps the *flight-path* rate, not the body pitch rate. Damping the
 * body rate looks equivalent and is not: a settled coordinated turn carries a
 * large steady pitch rate while its flight path is perfectly level, so a body
 * rate term subtracts a constant nose-down bias for the whole turn and the
 * aircraft descends out of it. Flight-path rate is zero in that same turn and
 * non-zero exactly when the path is moving, which is the only time damping is
 * wanted.
 */
const PATH_P = 3.2;
const PATH_D = 1.5;

/** How fast the measured flight-path rate is smoothed, in 1/s. */
const PATH_RATE_SMOOTHING = 14;

/**
 * Absolute roll cap while the recon camera is up.
 *
 * A fraction of the profile limit is the wrong shape here. The profile limits
 * tripled to make the aircraft turn, and scaling them by the same 0.52 tripled
 * how far the optic swings for a tap — measured at 6.3 degrees against a 3
 * degree bar. What recon needs is a bound in absolute stick, because what it is
 * protecting is the *image*, and the image does not know what sensitivity the
 * player chose.
 */
const RECON_ROLL_LIMIT = 0.18;

/**
 * Converts semantic arcade intent into bounded inputs for FlightModel.
 *
 * The controller closes its loops around the real bank and flight-path angles,
 * rather than accumulating a second attitude of its own. That makes recovery
 * deterministic after input release and keeps the result insensitive to frame
 * rate. update() mutates one stable output object and allocates nothing.
 *
 * The vertical channel commands a *rate* in radians per second and normalises
 * it by the airframe's live pitch authority, rather than emitting a raw stick
 * fraction. That is what lets the turn term be written as the physics it
 * actually is — the coordinated-level pitch rate g/V·(sec φ − cos φ) plus a
 * deliberate over-pull — instead of as a tuned constant that would have to be
 * re-tuned for every speed the aircraft flies at.
 */
export class AssistController {
  constructor() {
    this.control = { pitch: 0, roll: 0, yaw: 0, throttle: 0.8, brake: 0 };
    /** Smoothed d(flight path)/dt, and whether it has a sample to work from. */
    this._pathRate = 0;
    this._previousPath = 0;
    this._hasPath = false;
    /** Latched: the turn demand is hard enough to fly a dive as a slice. */
    this._slice = false;
  }

  update(dt, intent, flight, options) {
    const control = this.control;
    if (!hasValidTelemetry(flight)) return setNeutral(control);

    const profile = SENSITIVITY[options?.sensitivity] ?? SENSITIVITY.normal;
    if (profile.liftVector) return this._updateLiftVector(dt, intent, flight, profile, control);
    const reconScale = options?.reconActive === true ? 0.52 : 1;
    const turn = clampSigned(finite(intent?.turn));
    const climb = clampSigned(finite(intent?.climb));

    const speed = safeSpeed(flight);
    const gOverV = GRAVITY / Math.max(speed, 60);

    // Load factor a coordinated turn at the requested rate demands, capped by
    // the profile's structural/comfort limit, and the bank angle that produces
    // exactly that load. This is the whole turn law.
    // Full-power alone cannot protect the high-sensitivity profile indefinitely.
    // Auto-throttle therefore also unloads only the last part of the turn
    // envelope as the warning band approaches. Manual throttle remains fully
    // pilot-owned and receives the selected profile without this protection.
    const turnProtection = options?.autoThrottle === false
      ? 1
      : AUTO_TURN_MIN_AUTHORITY + (1 - AUTO_TURN_MIN_AUTHORITY) * smoothstep(
        AUTO_TURN_MIN_SPEED,
        AUTO_TURN_ENTRY_SPEED,
        speed,
      );
    const requestedRate = Math.abs(turn) * profile.turnRate * turnProtection;
    const rateLoad = Math.hypot(1, requestedRate / Math.max(gOverV, 1e-6));
    const turnLoad = Math.min(rateLoad, profile.turnLoad);
    const targetBank = -Math.sign(turn) * Math.acos(clampSigned(1 / turnLoad));

    const upY = finite(flight?.up?.y, 1);
    const bank = Math.atan2(finite(flight?.right?.y), upY);
    const rollRate = finite(flight?.rates?.z);
    const rollLimit = options?.reconActive === true
      ? Math.min(profile.rollLimit, RECON_ROLL_LIMIT)
      : profile.rollLimit;
    control.roll = clamp(
      ((bank - targetBank) * ROLL_P + rollRate * ROLL_D) * profile.response * reconScale,
      -rollLimit,
      rollLimit,
    );

    const verticalSpeed = finite(flight?.velocity?.y);
    const flightPath = Math.asin(clampSigned(verticalSpeed / Math.max(speed, 1)));
    const targetPath = climb * profile.climb;

    // Measured flight-path rate, smoothed. See PATH_D.
    const stepSeconds = Number.isFinite(dt) && dt > 1e-4 ? Math.min(dt, 0.25) : 1 / 60;
    if (this._hasPath) {
      const measured = (flightPath - this._previousPath) / stepSeconds;
      this._pathRate += (measured - this._pathRate) *
        (1 - Math.exp(-PATH_RATE_SMOOTHING * stepSeconds));
    } else {
      this._pathRate = 0;
      this._hasPath = true;
    }
    this._previousPath = flightPath;
    // Live ceiling, so a rate command means the same thing at 120 m/s and at
    // 550 m/s. Falls back to the airframe's nominal cap for telemetry that
    // predates the field (tests constructing bare flight-like objects).
    const pitchAuthority = Math.max(finite(flight?.pitchAuthority, 1.05), 1e-3);

    // Load the wing must hold to keep the current flight path at the *achieved*
    // bank — floored so a knife-edge cannot divide by zero. Because the bank
    // was derived from the load above, in a settled turn this is the turn load,
    // and the vertical loop is therefore already flying the turn rather than
    // resisting it.
    const cosBank = Math.max(Math.abs(Math.cos(bank)), 0.12);
    const holdingLoad = 1 / cosBank;

    // n·g = omega·V + g·cos φ, so omega = (n − cos φ)·g/V. At the holding load
    // this is the exact coordinated body rate (g/V)(n − 1/n).
    const coordinatedRate = (holdingLoad - cosBank) * gOverV;

    // The flight-path loop trims that toward the commanded path, bounded by its
    // own load budget. Unbounded, a proportional term on a 38-degree path error
    // demands 2 rad/s and simply saturates the stick, so an ordinary climb
    // pulled the structural limit and the G gauge pegged.
    const climbAuthority = (profile.climbLoad - 1) * gOverV;
    const pathTerm = clamp(
      PATH_P * (targetPath - flightPath) - PATH_D * this._pathRate,
      -climbAuthority,
      climbAuthority,
    );

    const commandedRate = coordinatedRate + pathTerm;
    control.pitch = clampSigned(
      (-commandedRate / pitchAuthority) * profile.verticalResponse * reconScale,
    );

    // Rudder follows turn intent at modest authority. The bank loop supplies
    // most of the turn; yaw only keeps the nose from skidding across it.
    control.yaw = clampSigned((turn * 0.28 * profile.response + finite(intent?.yaw)) * reconScale);

    const brake = finite(intent?.brake);
    control.brake = clampUnit(brake);
    if (options?.autoThrottle === false) {
      control.throttle = clampUnit(finite(intent?.throttle, 0.72));
    } else if (intent?.boost === true) {
      control.throttle = 1;
    } else {
      // Auto-throttle leans on the engine through a hard turn, but only part of
      // the way at ordinary speeds: induced drag still wins, so the aircraft
      // bleeds energy before the recovery envelope progressively takes over.
      // Cancelling the bleed entirely would remove the one trade that makes the
      // turn interesting.
      const scheduledThrottle = clampUnit(
        0.82 +
          clampSigned(finite(intent?.speed)) * 0.04 +
          Math.min((turnLoad - 1) / 6, 1) * 0.14,
      );
      const speedRecovery = 1 - smoothstep(
        AUTO_THROTTLE_FULL_SPEED,
        AUTO_THROTTLE_ENTRY_SPEED,
        speed,
      );
      const recoveryThrottle = 0.82 + speedRecovery * 0.18;
      control.throttle = Math.max(scheduledThrottle, recoveryThrottle);
    }

    return control;
  }

  /**
   * Combat (Standard mode) law: command the *lift vector*.
   *
   * The stick asks for a horizontal turn rate and a flight-path angle. Those
   * are turned into the acceleration the wing must produce — a horizontal
   * part V·omega for the turn and a vertical part V·gammaDot + g for the
   * path — and the aircraft is rolled so its lift points along that vector
   * and pulled to its magnitude. Bank and load are therefore one decision,
   * not two loops: left + down is an over-banked descending slice, left + up
   * a climbing turn, and neither axis can starve the other (which is what the
   * bank-then-hold-path law above does once the wing is near vertical).
   *
   *   bank = atan2(aH, aV)            may pass 90 degrees when aV < 0
   *   q    = (L - g·cos(bank)·cos(gamma)) / V,   L = aH·sin(bank) + aV·cos(bank)
   *
   * L is the demanded acceleration projected on where the lift points *now*,
   * so the pull builds as the roll arrives instead of ahead of it. With the
   * airbrake held the turn-rate and load ceilings blend to the high-G values.
   */
  _updateLiftVector(dt, intent, flight, profile, control) {
    const turn = clampSigned(finite(intent?.turn));
    const climb = clampSigned(finite(intent?.climb));
    const speed = Math.max(safeSpeed(flight), 60);
    const highG = clampUnit(finite(intent?.brake));
    // Near the stall the turn demand is unloaded so the assist never departs.
    const protection = 0.3 + 0.7 * smoothstep(AIRCRAFT.stallSpeed * 1.05, AIRCRAFT.stallSpeed * 1.7, speed);
    const rate = (profile.turnRate + (profile.highGTurnRate - profile.turnRate) * highG) * protection;
    const loadCap = profile.turnLoad + (profile.highGTurnLoad - profile.turnLoad) * highG;

    const path = Math.asin(clampSigned(finite(flight?.velocity?.y) / speed));
    const stepSeconds = Number.isFinite(dt) && dt > 1e-4 ? Math.min(dt, 0.25) : 1 / 60;
    if (this._hasPath) {
      const measured = (path - this._previousPath) / stepSeconds;
      this._pathRate += (measured - this._pathRate) * (1 - Math.exp(-PATH_RATE_SMOOTHING * stepSeconds));
    } else {
      this._pathRate = 0;
      this._hasPath = true;
    }
    this._previousPath = path;

    const climbAuthority = ((profile.climbLoad - 1) * GRAVITY) / speed;
    const pathRate = clamp(PATH_P * (climb * profile.climb - path) - PATH_D * this._pathRate, -climbAuthority, climbAuthority);
    const cosPath = Math.cos(path);
    // Push no harder than -2.5 g: an assisted dive is a bunt, not a split-S.
    const aV = Math.max(speed * pathRate + GRAVITY * cosPath, -2.5 * GRAVITY);
    // Load limit: the vertical demand is kept, the turn gives way.
    const maxA = loadCap * GRAVITY;
    const aHMax = Math.sqrt(Math.max(maxA * maxA - aV * aV, 0));
    const aH = clamp(-turn * rate * speed * cosPath, -aHMax, aHMax);

    const bank = Math.atan2(finite(flight?.right?.y), finite(flight?.up?.y, 1));
    // Bank along the lift vector. When the path demand is strongly downward
    // that vector points below the horizon and the honest answer is "roll past
    // ninety and pull" — fine in a hard turn (a descending slice), but for a
    // small heading correction it would flip the aircraft on its back. So the
    // bank is capped: level-turn bank for gentle turns (the dive is then flown
    // as a bunt), opening up to ~115 degrees once the turn is a real one.
    const absH = Math.abs(aH);
    // Slice or bunt is one decision with a memory, not a blend. A blended cap
    // has a bank angle at which the pull the turn wants and the push the
    // descent wants cancel exactly: measured, half stick left + stick forward
    // from a 30 degree climb parked the jet at 61 degrees of bank with a
    // centred elevator, climbing straight ahead for as long as the stick was
    // held. So a real turn (latched, with hysteresis) rolls past ninety and
    // pulls; anything gentler levels the wings and bunts, and the heading
    // waits the moment it takes the nose to come down.
    if (absH > 2.6 * GRAVITY) this._slice = true;
    else if (absH < 1.6 * GRAVITY) this._slice = false;
    const descend = smoothstep(-GRAVITY, 0, aV); // 0 = a real push is demanded
    const bankCap = this._slice ? 2.0 : Math.atan2(absH, GRAVITY) * descend;
    const natural = Math.atan2(aH, aV);
    const targetBank = clamp(natural, -bankCap, bankCap);
    let bankError = bank - targetBank;
    if (bankError > Math.PI) bankError -= 2 * Math.PI;
    else if (bankError < -Math.PI) bankError += 2 * Math.PI;
    control.roll = clamp(
      (bankError * ROLL_P + finite(flight?.rates?.z) * ROLL_D) * profile.response,
      -profile.rollLimit,
      profile.rollLimit,
    );

    // Bunting, the turn's share of the lift is dropped rather than summed:
    // "the vertical demand is kept, the turn gives way".
    const turnLift = aH * Math.sin(bank);
    const lift = aV * Math.cos(bank) + (this._slice ? turnLift : Math.max(0, turnLift) * descend + Math.min(0, turnLift));
    const pitchRate = (lift - GRAVITY * Math.cos(bank) * cosPath) / speed;
    const pitchAuthority = Math.max(finite(flight?.pitchAuthority, 1.05), 1e-3);
    control.pitch = clampSigned((-pitchRate / pitchAuthority) * profile.verticalResponse);
    control.yaw = clampSigned(turn * 0.25 + finite(intent?.yaw));
    control.brake = highG;
    control.throttle = clampUnit(finite(intent?.throttle, 0.8));
    return control;
  }

  reset() {
    setNeutral(this.control);
    this._pathRate = 0;
    this._previousPath = 0;
    this._hasPath = false;
    this._slice = false;
  }
}

function setNeutral(control) {
    control.pitch = 0;
    control.roll = 0;
    control.yaw = 0;
    control.throttle = 0.8;
    control.brake = 0;
  return control;
}

function hasValidTelemetry(flight) {
  return flight !== null && typeof flight === 'object' &&
    finiteVector(flight.forward) &&
    finiteVector(flight.up) &&
    finiteVector(flight.right) &&
    finiteVector(flight.velocity) &&
    finiteVector(flight.rates) &&
    Number.isFinite(flight.airspeed) && flight.airspeed >= 0;
}

function finiteVector(vector) {
  return vector !== null && typeof vector === 'object' &&
    Number.isFinite(vector.x) && Number.isFinite(vector.y) && Number.isFinite(vector.z);
}

function safeSpeed(flight) {
  const reported = finite(flight?.airspeed, -1);
  if (reported >= 0) return reported;
  const measured = flight?.velocity?.length?.();
  return Math.max(0, finite(measured));
}

function finite(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

function clampSigned(value) {
  return value < -1 ? -1 : value > 1 ? 1 : value;
}

function clampUnit(value) {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

function smoothstep(edge0, edge1, value) {
  const t = clamp((value - edge0) / Math.max(edge1 - edge0, 1e-6), 0, 1);
  return t * t * (3 - 2 * t);
}
