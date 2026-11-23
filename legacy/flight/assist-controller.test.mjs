import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { AssistController } from './AssistController.js';
import { AIRCRAFT, FlightModel } from './FlightModel.js';

const DEG = THREE.MathUtils.degToRad;
const NEUTRAL = Object.freeze({
  turn: 0,
  climb: 0,
  speed: 0,
  boost: false,
  brake: 0,
  throttle: 0.72,
});
const NORMAL = Object.freeze({
  sensitivity: 'normal',
  autoThrottle: true,
  reconActive: false,
});

/**
 * The turn law is a rate command, so bank is an *output*: the aircraft lays
 * over as far as the requested rate needs at the current speed, which at cruise
 * is around 80 degrees. The envelope that matters is the load factor, and
 * FlightModel's structural limit is what bounds it.
 */
test('a sustained turn banks to the load the requested rate needs', () => {
  const result = run({ seconds: 5, intent: { ...NEUTRAL, turn: 1 } });
  assert.ok(
    result.maxBank >= DEG(70),
    `turn only reached ${THREE.MathUtils.radToDeg(result.maxBank).toFixed(2)} degrees of bank`,
  );
  assert.ok(
    result.maxBank <= DEG(87),
    `bank reached ${THREE.MathUtils.radToDeg(result.maxBank).toFixed(2)} degrees`,
  );
  assert.ok(result.maxLoad <= AIRCRAFT.gLimit, `turn pulled ${result.maxLoad.toFixed(2)} G`);
});

/**
 * The headline acceptance criterion. The bank-command controller this replaced
 * measured 3.2 deg/s in flight, so a 360 took ninety seconds and turning was
 * the single worst thing about the game.
 */
test('assisted turn rate is arcade-usable at cruise and orders by sensitivity', () => {
  const rates = ['low', 'normal', 'high'].map((sensitivity) => run({
    seconds: 6,
    intent: { ...NEUTRAL, turn: 1 },
    options: { ...NORMAL, sensitivity },
  }).steadyTurnRate);

  assert.ok(
    rates[1] >= DEG(12),
    `normal sustained only ${THREE.MathUtils.radToDeg(rates[1]).toFixed(1)} deg/s`,
  );
  assert.ok(
    rates[0] < rates[1] && rates[1] < rates[2],
    `turn rates were ${rates.map((r) => THREE.MathUtils.radToDeg(r).toFixed(1)).join(', ')} deg/s`,
  );
});

test('a 180 degree reversal completes within ten seconds at normal sensitivity', () => {
  const assist = new AssistController();
  const flight = makeFlight();
  let turned = 0;
  let previous = heading(flight);
  let elapsed = 0;
  const dt = 1 / 120;
  while (Math.abs(turned) < Math.PI && elapsed < 30) {
    advance(assist, flight, { ...NEUTRAL, turn: 1 }, NORMAL, dt);
    const current = heading(flight);
    turned += Math.atan2(Math.sin(current - previous), Math.cos(current - previous));
    previous = current;
    elapsed += dt;
  }
  assert.ok(elapsed <= 10, `reversal took ${elapsed.toFixed(2)} seconds`);
});

/**
 * Induced drag is what makes the turn a trade rather than a free ride, and it
 * used to be absent: a hard turn held its entry speed all the way round.
 */
test('a hard turn bleeds energy toward corner speed without decaying to a stall', () => {
  const result = run({ seconds: 6, intent: { ...NEUTRAL, turn: 1 } });
  assert.ok(
    result.flight.airspeed < 230,
    `six seconds of full turn left ${result.flight.airspeed.toFixed(0)} m/s`,
  );
  assert.ok(
    result.flight.airspeed > AIRCRAFT.stallSpeed * 1.5,
    `turn decayed to ${result.flight.airspeed.toFixed(0)} m/s, near stall`,
  );
});

test('default Assisted auto-throttle protects a sustained turn without erasing energy loss', () => {
  const result = run({ seconds: 40, intent: { ...NEUTRAL, turn: 1 } });
  assert.equal(result.everStalled, false, 'default Assisted turn entered the stall warning');
  assert.ok(
    result.flight.airspeed < 230,
    `Assisted protection erased turn-energy loss at ${result.flight.airspeed.toFixed(0)} m/s`,
  );
});

/** The induced-drag term is a feedback loop; it must not be able to run away. */
test('forty seconds of maximum turn stays numerically bounded', () => {
  const result = run({
    seconds: 40,
    intent: { ...NEUTRAL, turn: 1 },
    options: { ...NORMAL, sensitivity: 'high' },
  });
  assert.ok(Number.isFinite(result.flight.airspeed), 'airspeed diverged');
  assert.ok(result.maxLoad <= AIRCRAFT.gLimit + 0.5, `peak load was ${result.maxLoad.toFixed(1)} G`);
  assert.equal(result.everStalled, false, 'high-sensitivity Assisted turn entered the stall warning');
  assert.ok(
    result.flight.airspeed > AIRCRAFT.stallSpeed,
    `airspeed collapsed to ${result.flight.airspeed.toFixed(0)} m/s`,
  );
});

test('releasing turn intent levels the wings within 1.5 seconds', () => {
  const assist = new AssistController();
  const flight = makeFlight();
  step(assist, flight, { ...NEUTRAL, turn: 1 }, NORMAL, 5, 60);

  let elapsed = 0;
  while (elapsed < 2 && Math.abs(bankAngle(flight)) > DEG(5)) {
    advance(assist, flight, NEUTRAL, NORMAL, 1 / 60);
    elapsed += 1 / 60;
  }

  assert.ok(elapsed <= 1.5, `level recovery took ${elapsed.toFixed(3)} seconds`);
});

/**
 * The vertical envelope opened from 14 to 26-38 degrees of flight path. A jet
 * that could only ever change its path by 14 degrees cannot cross a Himalayan
 * ridge that is already filling the canopy, which is the terrain this sortie is
 * flown through. The ceiling still keeps the horizon in frame.
 */
test('full climb and dive stay inside the assisted vertical envelope at every sensitivity', () => {
  const epsilon = DEG(0.01);
  const CEILING = { low: DEG(26), normal: DEG(32), high: DEG(38) };
  for (const sensitivity of ['low', 'normal', 'high']) {
    const options = { ...NORMAL, sensitivity };
    const climb = run({ seconds: 5, intent: { ...NEUTRAL, climb: 1 }, options });
    const dive = run({ seconds: 5, intent: { ...NEUTRAL, climb: -1 }, options });

    assert.ok(climb.maxFlightPathAngle > DEG(15), `${sensitivity} climb did not establish a usable path`);
    assert.ok(dive.minFlightPathAngle < DEG(-15), `${sensitivity} dive did not establish a usable path`);
    // Attitude runs ahead of flight path by the angle of attack, so it is
    // allowed a margin over the commanded path ceiling rather than its own.
    // The path itself gets one degree of settling allowance: full stick is a
    // step input into a damped loop, and the measured transient overshoot is
    // 0.3 degrees. Damping it to exactly zero costs turn rate for nothing.
    const path = CEILING[sensitivity] + DEG(1);
    const attitude = path + DEG(12);
    for (const [maneuver, result] of [['climb', climb], ['dive', dive]]) {
      assertEnvelope(result.minPitchAttitude, result.maxPitchAttitude, attitude, epsilon, `${sensitivity} ${maneuver} attitude`);
      assertEnvelope(result.minFlightPathAngle, result.maxFlightPathAngle, path, epsilon, `${sensitivity} ${maneuver} path`);
    }
  }
});

test('auto-cruise keeps neutral flight out of a stall for 30 seconds', () => {
  const assist = new AssistController();
  const flight = makeFlight();
  step(assist, flight, NEUTRAL, NORMAL, 30, 60, () => {
    assert.equal(flight.stalling, false, 'neutral flight must never enter a transient stall');
  });
});

test('a 100 ms turn tap changes heading by no more than 5 degrees', () => {
  const { headingDelta } = run({ seconds: 0.1, intent: { ...NEUTRAL, turn: 1 } });
  assert.ok(headingDelta <= DEG(5), `heading changed ${THREE.MathUtils.radToDeg(headingDelta).toFixed(2)} degrees`);
});

test('recon reduces a 100 ms turn tap to at most 3 degrees of optical motion', () => {
  const normal = run({ seconds: 0.1, intent: { ...NEUTRAL, turn: 1 } });
  const { opticalDelta } = run({
    seconds: 0.1,
    intent: { ...NEUTRAL, turn: 1 },
    options: { ...NORMAL, reconActive: true },
  });
  assert.ok(opticalDelta < normal.opticalDelta, 'recon must reduce optical correction authority');
  assert.ok(opticalDelta <= DEG(3), `optic moved ${THREE.MathUtils.radToDeg(opticalDelta).toFixed(2)} degrees`);
});

test('invalid flight telemetry always produces finite bounded controls', () => {
  const assist = new AssistController();
  const control = assist.update(Number.NaN, {
    turn: Infinity,
    climb: Number.NaN,
    boost: true,
    brake: Infinity,
    throttle: Number.NaN,
  }, {
    forward: { y: Number.NaN },
    up: { y: Number.NaN },
    right: { y: Number.NaN },
    velocity: { x: Infinity, y: Number.NaN, z: -Infinity, length: () => Number.NaN },
    rates: { x: Number.NaN, y: Infinity, z: -Infinity },
    airspeed: Number.NaN,
  }, NORMAL);

  for (const axis of ['pitch', 'roll', 'yaw']) {
    assert.ok(Number.isFinite(control[axis]), `${axis} must be finite`);
    assert.ok(control[axis] >= -1 && control[axis] <= 1, `${axis} must be bounded`);
  }
  for (const axis of ['throttle', 'brake']) {
    assert.ok(Number.isFinite(control[axis]), `${axis} must be finite`);
    assert.ok(control[axis] >= 0 && control[axis] <= 1, `${axis} must be bounded`);
  }
});

test('unavailable or malformed telemetry returns the stable project-neutral output', () => {
  const assist = new AssistController();
  const identity = assist.control;
  const aggressiveIntent = {
    ...NEUTRAL,
    turn: 1,
    climb: -1,
    boost: true,
    brake: 1,
    throttle: 1,
  };
  const malformed = [
    null,
    {},
    {
      forward: { x: 0, y: 0, z: -1 },
      up: { x: 0, y: 1, z: 0 },
      right: { x: 1, y: 0, z: 0 },
      velocity: null,
      rates: { x: 0, y: 0, z: 0 },
      airspeed: 260,
    },
    {
      forward: { x: 0, y: 0, z: -1 },
      up: { x: 0, y: Number.NaN, z: 0 },
      right: { x: 1, y: 0, z: 0 },
      velocity: { x: 0, y: 0, z: -260 },
      rates: { x: 0, y: Infinity, z: 0 },
      airspeed: 260,
    },
  ];

  for (const flight of malformed) {
    const control = assist.update(1 / 60, aggressiveIntent, flight, NORMAL);
    assert.equal(control, identity);
    assert.deepEqual(control, { pitch: 0, roll: 0, yaw: 0, throttle: 0.8, brake: 0 });
  }
});

test('boost is momentary and releasing it immediately leaves reheat', () => {
  const assist = new AssistController();
  const flight = makeFlight();
  const boosted = assist.update(1 / 60, { ...NEUTRAL, boost: true }, flight, NORMAL);
  assert.ok(boosted.throttle > 0.86);
  flight.update(1 / 60, boosted);

  const released = assist.update(1 / 60, NEUTRAL, flight, NORMAL);
  assert.ok(released.throttle <= 0.86, `released throttle remained at ${released.throttle}`);
  flight.update(1 / 60, released);
  assert.equal(flight.reheat, false);
});

test('manual throttle and brake pass through without assistance', () => {
  const assist = new AssistController();
  const control = assist.update(1 / 60, { ...NEUTRAL, throttle: 0.37, brake: 0.6 }, makeFlight(), {
    ...NORMAL,
    autoThrottle: false,
  });
  assert.equal(control.throttle, 0.37);
  assert.equal(control.brake, 0.6);
});

test('low, normal, and high sensitivity produce ordered turn and climb authority', () => {
  const outputs = ['low', 'normal', 'high'].map((sensitivity) => {
    const assist = new AssistController();
    const turn = Math.abs(assist.update(1 / 60, { ...NEUTRAL, turn: 0.5 }, makeFlight(), {
      ...NORMAL,
      sensitivity,
    }).roll);
    const climb = Math.abs(assist.update(1 / 60, { ...NEUTRAL, climb: 1 }, makeFlight(), {
      ...NORMAL,
      sensitivity,
    }).pitch);
    return { turn, climb };
  });
  assert.ok(
    outputs[0].turn < outputs[1].turn && outputs[1].turn < outputs[2].turn,
    `turn outputs were ${outputs.map(({ turn }) => turn).join(', ')}`,
  );
  assert.ok(
    outputs[0].climb < outputs[1].climb && outputs[1].climb < outputs[2].climb,
    `climb outputs were ${outputs.map(({ climb }) => climb).join(', ')}`,
  );
});

/**
 * The cap rose from 0.35 to 0.94 because 0.35 of a 3.5 rad/s ceiling put a
 * fighter bank 1.2 s away, and a bank that takes over a second to establish is
 * the difference between aiming the aircraft and asking it. It is still a hard
 * cap: roll authority must never be unbounded, and recon must always damp it.
 */
test('assisted roll output is hard-capped across sensitivity and recon modes', () => {
  for (const sensitivity of ['low', 'normal', 'high']) {
    let unscaled = 0;
    for (const reconActive of [false, true]) {
      const assist = new AssistController();
      const flight = makeFlight();
      const control = assist.update(1 / 60, { ...NEUTRAL, turn: 1 }, flight, {
        ...NORMAL,
        sensitivity,
        reconActive,
      });
      assert.ok(
        Math.abs(control.roll) <= 0.94,
        `${sensitivity}/${reconActive ? 'recon' : 'normal'} roll was ${control.roll}`,
      );
      if (!reconActive) unscaled = Math.abs(control.roll);
      else {
        assert.ok(
          Math.abs(control.roll) < unscaled,
          `${sensitivity} recon roll ${control.roll} was not damped below ${unscaled}`,
        );
      }
    }
  }
});

test('reset clears command history and update reuses one output object', () => {
  const assist = new AssistController();
  const flight = makeFlight();
  const identity = assist.update(0.2, { ...NEUTRAL, turn: 1, climb: 1 }, flight, NORMAL);
  assist.reset();
  assert.equal(assist.control, identity);
  assert.deepEqual(assist.control, { pitch: 0, roll: 0, yaw: 0, throttle: 0.8, brake: 0 });
  const neutral = assist.update(1 / 60, NEUTRAL, flight, NORMAL);

  assert.equal(neutral, identity);
  assert.ok(Math.abs(neutral.pitch) < 1e-12);
  assert.ok(Math.abs(neutral.roll) < 1e-12);
  assert.ok(Math.abs(neutral.yaw) < 1e-12);
});

test('30, 60, and 120 Hz simulations converge on the same assisted turn', () => {
  const results = [30, 60, 120].map((hz) => run({
    seconds: 4,
    hz,
    intent: { ...NEUTRAL, turn: 0.65, climb: 0.2 },
  }));
  const banks = results.map((result) => bankAngle(result.flight));
  const headings = results.map((result) => result.headingDelta);
  assert.ok(spread(banks) <= DEG(2), `bank spread was ${THREE.MathUtils.radToDeg(spread(banks)).toFixed(2)} degrees`);
  assert.ok(spread(headings) <= DEG(3), `heading spread was ${THREE.MathUtils.radToDeg(spread(headings)).toFixed(2)} degrees`);
});

function makeFlight() {
  const flight = new FlightModel();
  flight.reset(new THREE.Vector3(0, 5000, 0), 0, 260);
  return flight;
}

function run({ seconds, intent, hz = 60, options = NORMAL }) {
  const assist = new AssistController();
  const flight = makeFlight();
  const initialHeading = heading(flight);
  const initialOrientation = flight.orientation.clone();
  let maxBank = 0;
  let maxLoad = 0;
  let minPitchAttitude = Infinity;
  let maxPitchAttitude = -Infinity;
  let minFlightPathAngle = Infinity;
  let maxFlightPathAngle = -Infinity;
  let everStalled = false;

  // Heading is unwrapped so a turn past 180 degrees still accumulates, and the
  // last second is sampled separately: the interesting figure is the *settled*
  // rate, not one diluted by the roll-in.
  let unwrappedHeading = 0;
  let previousHeading = initialHeading;
  const finalSecond = [];
  const totalSteps = Math.round(seconds * hz);
  let stepIndex = 0;

  step(assist, flight, intent, options, seconds, hz, () => {
    maxBank = Math.max(maxBank, Math.abs(bankAngle(flight)));
    maxLoad = Math.max(maxLoad, flight.gLoad);
    const pitchAttitude = Math.asin(clamp(flight.forward.y, -1, 1));
    const flightPathAngle = Math.asin(clamp(flight.velocity.y / Math.max(flight.velocity.length(), 1), -1, 1));
    minPitchAttitude = Math.min(minPitchAttitude, pitchAttitude);
    maxPitchAttitude = Math.max(maxPitchAttitude, pitchAttitude);
    minFlightPathAngle = Math.min(minFlightPathAngle, flightPathAngle);
    maxFlightPathAngle = Math.max(maxFlightPathAngle, flightPathAngle);
    everStalled ||= flight.stalling;

    const current = heading(flight);
    const delta = Math.atan2(Math.sin(current - previousHeading), Math.cos(current - previousHeading));
    unwrappedHeading += delta;
    previousHeading = current;
    stepIndex++;
    if (stepIndex > totalSteps - hz) finalSecond.push(delta * hz);
  });

  const steadyTurnRate = finalSecond.length
    ? Math.abs(finalSecond.reduce((a, v) => a + v, 0) / finalSecond.length)
    : 0;

  return {
    flight,
    maxBank,
    maxLoad,
    minPitchAttitude,
    maxPitchAttitude,
    minFlightPathAngle,
    maxFlightPathAngle,
    everStalled,
    steadyTurnRate,
    totalHeadingChange: Math.abs(unwrappedHeading),
    flightPathAngle: Math.asin(clamp(flight.velocity.y / Math.max(flight.velocity.length(), 1), -1, 1)),
    headingDelta: angleDistance(initialHeading, heading(flight)),
    opticalDelta: initialOrientation.angleTo(flight.orientation),
  };
}

function step(assist, flight, intent, options, seconds, hz, observe = () => {}) {
  const dt = 1 / hz;
  const count = Math.round(seconds * hz);
  for (let i = 0; i < count; i++) {
    advance(assist, flight, intent, options, dt);
    observe();
  }
}

function advance(assist, flight, intent, options, dt) {
  flight.update(dt, assist.update(dt, intent, flight, options));
}

function bankAngle(flight) {
  return Math.atan2(flight.right.y, flight.up.y);
}

function heading(flight) {
  return Math.atan2(-flight.forward.x, -flight.forward.z);
}

function angleDistance(a, b) {
  return Math.abs(Math.atan2(Math.sin(b - a), Math.cos(b - a)));
}

function spread(values) {
  return Math.max(...values) - Math.min(...values);
}

function assertEnvelope(minimum, maximum, ceiling, epsilon, label) {
  assert.ok(
    minimum >= -ceiling - epsilon,
    `${label} fell to ${THREE.MathUtils.radToDeg(minimum).toFixed(2)} degrees`,
  );
  assert.ok(
    maximum <= ceiling + epsilon,
    `${label} reached ${THREE.MathUtils.radToDeg(maximum).toFixed(2)} degrees`,
  );
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
