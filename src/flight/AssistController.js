const SENSITIVITY = {
  low: { bank: 28 * Math.PI / 180, climb: 11 * Math.PI / 180, response: 0.72, verticalResponse: 0.72, rollLimit: 0.28 },
  normal: { bank: 38 * Math.PI / 180, climb: 14 * Math.PI / 180, response: 1, verticalResponse: 1, rollLimit: 0.32 },
  high: { bank: 44 * Math.PI / 180, climb: 14.5 * Math.PI / 180, response: 1.25, verticalResponse: 1, rollLimit: 0.35 },
};

/**
 * Converts semantic arcade intent into bounded inputs for FlightModel.
 *
 * The controller closes its loops around the real bank and flight-path angles,
 * rather than accumulating a second attitude of its own. That makes recovery
 * deterministic after input release and keeps the result insensitive to frame
 * rate. update() mutates one stable output object and allocates nothing.
 */
export class AssistController {
  constructor() {
    this.control = { pitch: 0, roll: 0, yaw: 0, throttle: 0.8, brake: 0 };
  }

  update(dt, intent, flight, options) {
    const control = this.control;
    if (!hasValidTelemetry(flight)) return setNeutral(control);

    const profile = SENSITIVITY[options?.sensitivity] ?? SENSITIVITY.normal;
    const reconScale = options?.reconActive === true ? 0.52 : 1;
    const turn = clampSigned(finite(intent?.turn));
    const climb = clampSigned(finite(intent?.climb));

    const upY = finite(flight?.up?.y, 1);
    const bank = Math.atan2(finite(flight?.right?.y), upY);
    const targetBank = -turn * profile.bank;
    const rollRate = finite(flight?.rates?.z);
    control.roll = clamp(
      ((bank - targetBank) * 1.7 + rollRate * 0.28) * profile.response * reconScale,
      -profile.rollLimit,
      profile.rollLimit,
    );

    const speed = safeSpeed(flight);
    const verticalSpeed = finite(flight?.velocity?.y);
    const flightPath = Math.asin(clampSigned(verticalSpeed / Math.max(speed, 1)));
    const targetPath = climb * profile.climb;
    const pitchRate = finite(flight?.rates?.x);
    control.pitch = clampSigned((-(targetPath - flightPath) * 2.5 + pitchRate * 0.34) * profile.verticalResponse * reconScale);

    // Rudder follows turn intent at modest authority. The bank loop supplies
    // most of the turn; yaw only keeps the nose from skidding across it.
    control.yaw = clampSigned(turn * 0.28 * profile.response * reconScale);

    const brake = finite(intent?.brake);
    control.brake = clampUnit(brake);
    if (options?.autoThrottle === false) {
      control.throttle = clampUnit(finite(intent?.throttle, 0.72));
    } else if (intent?.boost === true) {
      control.throttle = 1;
    } else {
      control.throttle = clampUnit(0.82 + clampSigned(finite(intent?.speed)) * 0.04);
    }

    return control;
  }

  reset() {
    setNeutral(this.control);
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
