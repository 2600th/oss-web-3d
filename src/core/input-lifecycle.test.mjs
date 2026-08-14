import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Input } from './Input.js';
import { ChaseCamera } from '../flight/ChaseCamera.js';
import { FlightModel } from '../flight/FlightModel.js';

class Target {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, fn) { this.listeners.set(type, fn); }
  removeEventListener(type, fn) { if (this.listeners.get(type) === fn) this.listeners.delete(type); }
  fire(type, event) { this.listeners.get(type)?.(event); }
}

const keyEvent = (code, modifiers = {}) => ({
  code,
  repeat: false,
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  preventDefault() {},
  ...modifiers,
});

function withNavigator(getGamepads, run) {
  const oldNavigator = globalThis.navigator;
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { getGamepads },
  });
  try {
    return run();
  } finally {
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: oldNavigator });
  }
}

// Direct-mode characterization: these are the legacy fields consumed by
// FlightModel and must not drift while semantic intent is added alongside.
withNavigator(() => [], () => {
  const cases = [
    ['KeyW', 'pitch', -1],
    ['KeyS', 'pitch', 1],
    ['KeyA', 'roll', -1],
    ['KeyD', 'roll', 1],
    ['KeyQ', 'yaw', -1],
    ['KeyE', 'yaw', 1],
  ];
  for (const [code, field, sign] of cases) {
    const target = new Target();
    const input = new Input(target);
    target.fire('keydown', keyEvent(code));
    input.update(0.1);
    assert.equal(Math.sign(input[field]), sign, `${code} must preserve Direct ${field} polarity`);
    input.dispose();
  }

  const target = new Target();
  const input = new Input(target);
  target.fire('keydown', keyEvent('ShiftLeft'));
  input.update(0.1);
  assert.ok(Math.abs(input.throttle - 0.782) < 1e-12, 'Shift must preserve the Direct throttle-up rate');
  target.fire('keyup', keyEvent('ShiftLeft'));
  target.fire('keydown', keyEvent('ControlLeft', { ctrlKey: true }));
  input.update(0.1);
  assert.ok(Math.abs(input.throttle - 0.72) < 1e-12, 'Ctrl must preserve the Direct throttle-down rate');
  input.dispose();
});

withNavigator(() => [{
  connected: true,
  axes: [0.57, -0.57, 0.57],
  buttons: [],
}], () => {
  const input = new Input(new Target());
  input.update(0.1);
  const shaped = (0.57 - 0.14) / 0.86;
  const response = 1 - Math.exp(-0.7);
  assert.ok(Math.abs(input.roll - shaped * response) < 1e-12, 'gamepad roll must retain deadzone shaping');
  assert.ok(Math.abs(input.pitch + shaped * response) < 1e-12, 'gamepad pitch must retain raw stick polarity');
  assert.ok(Math.abs(input.yaw - shaped * response) < 1e-12, 'gamepad yaw must retain deadzone shaping');
  input.dispose();
});

withNavigator(() => [], () => {
  const input = new Input(new Target());
  input.setTouchAxes(-0.4, 0.6);
  input.update(0.1);
  const response = 1 - Math.exp(-0.7);
  assert.ok(Math.abs(input.pitch - (-0.4 * response)) < 1e-12, 'touch pitch must remain a raw Direct axis');
  assert.ok(Math.abs(input.roll - (0.6 * response)) < 1e-12, 'touch roll must remain a raw Direct axis');
  input.dispose();
});

const NEUTRAL_INTENT = {
  turn: 0,
  climb: 0,
  speed: 0,
  boost: false,
  brake: 0,
  throttle: 0.72,
};

withNavigator(() => [], () => {
  const semanticCases = [
    ['KeyW', 'climb', 1],
    ['KeyS', 'climb', -1],
    ['KeyA', 'turn', -1],
    ['KeyD', 'turn', 1],
    ['ControlLeft', 'speed', -1],
  ];
  for (const [code, field, expected] of semanticCases) {
    const target = new Target();
    const input = new Input(target);
    target.fire('keydown', keyEvent(code, code === 'ControlLeft' ? { ctrlKey: true } : {}));
    input.update(0.1, 'upToDive');
    assert.equal(input.intent?.[field], expected, `${code} must expose semantic ${field}`);
    assert.equal(input.modality, 'keyboard');
    input.dispose();
  }

  const target = new Target();
  const input = new Input(target);
  const identity = input.intent;
  target.fire('keydown', keyEvent('ShiftLeft'));
  input.update(0.1);
  assert.equal(input.intent?.boost, true, 'Shift must expose momentary boost intent');
  assert.ok(Math.abs(input.intent?.throttle - 0.782) < 1e-12, 'semantic throttle must follow the Direct lever');
  assert.equal(input.intent, identity, 'intent must retain stable object identity');
  target.fire('keyup', keyEvent('ShiftLeft'));
  input.setTouchBoost(true);
  input.update(0.1);
  assert.equal(input.intent.boost, true, 'touch Boost must share semantic boost intent');
  assert.equal(input.modality, 'touch');
  input.releaseAll();
  assert.deepEqual(input.intent, NEUTRAL_INTENT, 'explicit release must immediately neutralize semantic intent');
  assert.equal(input.reconHeld, false);
  input.dispose();

  const brakeTarget = new Target();
  const braking = new Input(brakeTarget);
  brakeTarget.fire('keydown', keyEvent('KeyZ'));
  braking.update(0.1);
  assert.equal(braking.intent?.brake, 1, 'Z must expose semantic airbrake intent');
  braking.dispose();
});

withNavigator(() => [{
  connected: true,
  axes: [0.13, -0.57, 0],
  buttons: [],
}], () => {
  const input = new Input(new Target());
  input.update(0.1, 'upToClimb');
  assert.equal(input.intent?.turn, 0, 'gamepad centre noise must remain inside the semantic deadzone');
  assert.ok(input.intent?.climb > 0, 'stick up must mean climb in upToClimb mode');
  assert.equal(input.modality, 'gamepad');
  input.update(0.1, 'upToDive');
  assert.ok(input.intent.climb < 0, 'only analogue climb intent must reverse in upToDive mode');
  input.dispose();
});

withNavigator(() => [], () => {
  const input = new Input(new Target());
  input.setTouchAxes(-0.4, 0.6);
  input.update(0.1, 'upToClimb');
  assert.equal(input.intent?.turn, 0.6);
  assert.equal(input.intent?.climb, 0.4);
  input.update(0.1, 'upToDive');
  assert.equal(input.intent.climb, -0.4);
  assert.equal(input.modality, 'touch');
  input.dispose();
});

withNavigator(() => [{
  connected: true,
  axes: [0, 0, 0],
  buttons: Array.from({ length: 6 }, (_, index) => ({ value: index === 5 ? 1 : 0 })),
}], () => {
  const input = new Input(new Target());
  input.update(0.1);
  assert.equal(input.consumePress('Space'), true, 'gamepad recon rising edge must be consumable once');
  assert.equal(input.reconHeld, true, 'Direct recon must remain held while the gamepad button is down');
  input.update(0.1);
  assert.equal(input.consumePress('Space'), false, 'held gamepad recon must not repeat its rising edge');
  assert.equal(input.reconHeld, true);
  input.dispose();
});

function makeHeldPad() {
  return {
    connected: true,
    axes: [0.57, -0.57, 0],
    buttons: Array.from({ length: 8 }, (_, index) => ({
      value: index === 5 || index === 7 ? 1 : 0,
    })),
  };
}

function neutralizePad(pad) {
  pad.axes.fill(0);
  for (const button of pad.buttons) button.value = 0;
}

function assertHeldPadIgnored(input, message) {
  assert.deepEqual(input.intent, NEUTRAL_INTENT, `${message}: semantic intent must remain neutral`);
  assert.equal(input.reconHeld, false, `${message}: held recon must remain released`);
  assert.equal(input.consumePress('Space'), false, `${message}: held recon must not emit another rising edge`);
}

{
  const pad = makeHeldPad();
  withNavigator(() => [pad], () => {
    const input = new Input(new Target());
    input.update(0.1);
    assert.equal(input.consumePress('Space'), true);
    input.releaseAll();

    input.update(0.1);
    assertHeldPadIgnored(input, 'first update after explicit release');
    input.update(0.1);
    assertHeldPadIgnored(input, 'continued hold after explicit release');

    neutralizePad(pad);
    input.update(0.1);
    assertHeldPadIgnored(input, 'neutral frame after explicit release');
    pad.axes[0] = 0.57;
    pad.buttons[5].value = 1;
    input.update(0.1);
    assert.ok(input.intent.turn > 0, 'fresh gamepad input must resume after returning neutral');
    assert.equal(input.consumePress('Space'), true, 'fresh recon press must resume after returning neutral');
    input.dispose();
  });
}

{
  const pad = makeHeldPad();
  withNavigator(() => [pad], () => {
    const target = new Target();
    const input = new Input(target);
    input.update(0.1);
    input.consumePress('Space');
    target.fire('blur', {});
    input.update(0.1);
    assertHeldPadIgnored(input, 'update after blur cleanup');
    input.update(0.1);
    assertHeldPadIgnored(input, 'continued hold after blur cleanup');
    input.dispose();
  });
}

{
  const oldDocument = globalThis.document;
  const visibilityTarget = new Target();
  visibilityTarget.hidden = false;
  Object.defineProperty(globalThis, 'document', { configurable: true, value: visibilityTarget });
  const pad = makeHeldPad();
  try {
    withNavigator(() => [pad], () => {
      const input = new Input(new Target());
      input.update(0.1);
      input.consumePress('Space');
      visibilityTarget.hidden = true;
      visibilityTarget.fire('visibilitychange', {});
      input.update(0.1);
      assertHeldPadIgnored(input, 'update after visibility cleanup');
      input.update(0.1);
      assertHeldPadIgnored(input, 'continued hold after visibility cleanup');
      input.dispose();
    });
  } finally {
    Object.defineProperty(globalThis, 'document', { configurable: true, value: oldDocument });
  }
}

withNavigator(() => [], () => {
  const oldDocument = globalThis.document;
  const visibilityTarget = new Target();
  visibilityTarget.hidden = false;
  Object.defineProperty(globalThis, 'document', { configurable: true, value: visibilityTarget });
  try {
    const target = new Target();
    const input = new Input(target);
    target.fire('keydown', keyEvent('KeyW'));
    input.update(0.1);
    target.fire('blur', {});
    assert.deepEqual(input.intent, NEUTRAL_INTENT, 'blur must neutralize held intent');

    target.fire('keydown', keyEvent('KeyD'));
    input.update(0.1);
    visibilityTarget.hidden = true;
    visibilityTarget.fire('visibilitychange', {});
    assert.deepEqual(input.intent, NEUTRAL_INTENT, 'visibility loss must neutralize held intent');

    target.fire('keydown', keyEvent('KeyS'));
    input.update(0.1);
    input.dispose();
    assert.deepEqual(input.intent, NEUTRAL_INTENT, 'disposal must neutralize held intent');
    assert.equal(target.listeners.size, 0, 'disposal must remove target listeners');
    assert.equal(visibilityTarget.listeners.size, 0, 'disposal must remove visibility listener');
  } finally {
    Object.defineProperty(globalThis, 'document', { configurable: true, value: oldDocument });
  }
});

{
  const oldNavigator = globalThis.navigator;
  let samples = 0;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {
    getGamepads() { samples++; return [{ connected: true, axes: [0, 0, 0], buttons: [] }]; },
  }});
  const target = new Target();
  const input = new Input(target);
  let prevented = false;
  target.fire('keydown', { code: 'ControlLeft', repeat: false, ctrlKey: true, altKey: false, metaKey: false, preventDefault() { prevented = true; } });
  input.update(0.1);
  assert.ok(input.throttle < 0.72, 'Control must reach the throttle-down binding');
  assert.equal(prevented, false, 'modifier shortcuts must not be intercepted');
  assert.equal(samples, 1, 'gamepad state must be snapshotted once per frame');
  input.dispose();
  assert.equal(target.listeners.size, 0, 'Input must remove all listeners it owns');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: oldNavigator });
}

{
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
  const chase = new ChaseCamera(camera);
  const flight = {
    position: new THREE.Vector3(21000, 7000, 6000),
    forward: new THREE.Vector3(0, 0, -1), right: new THREE.Vector3(1, 0, 0), up: new THREE.Vector3(0, 1, 0),
    velocity: new THREE.Vector3(0, 0, -260), airspeed: 260, agl: 900, gLoad: 1, reheat: false,
  };
  chase.reset(flight);
  assert.ok(chase.lookAt.distanceTo(flight.position) < 100, 'reset must snap aim near the aircraft, not ease from world origin');
  camera.fov = 12;
  chase.update(1 / 60, flight);
  assert.ok(camera.fov > 50, 'repossessing the camera after recon must restore chase FOV in one frame');
}

{
  const flight = new FlightModel();
  flight.position.set(0, -10000, 0);
  flight.velocity.set(0, 0, 500);
  assert.equal(flight.checkTerrainCollision(1 / 30), true, 'collision must inspect the segment just travelled');
  assert.equal(flight.velocity.length(), 0, 'impact must stop the simulated aircraft');
}

console.log('input, chase and flight lifecycle contracts passed');
