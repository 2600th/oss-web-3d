import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Input } from './Input.js';
import { ChaseCamera } from '../flight/ChaseCamera.js';
import { FlightModel } from '../flight/FlightModel.js';
import { terrainHeight } from '../world/heightfield.js';

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
  target.fire('keydown', keyEvent('KeyX'));
  input.update(0.1);
  assert.ok(Math.abs(input.throttle - 0.72) < 1e-12, 'X must preserve the Direct throttle-down rate');
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
    ['KeyX', 'speed', -1],
  ];
  for (const [code, field, expected] of semanticCases) {
    const target = new Target();
    const input = new Input(target);
    target.fire('keydown', keyEvent(code));
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
  const throttleBeforeRelease = input.throttle;
  input.releaseAll();
  assert.deepEqual(
    input.intent,
    { ...NEUTRAL_INTENT, throttle: throttleBeforeRelease },
    'explicit release must immediately neutralize semantic intent without moving throttle',
  );
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

// Releasing touch input must never claim the touch modality. The touch layer
// clears held input on mode change, on blur, and when it disables itself on a
// desktop load, so a release that announced "touch" relabelled the briefing's
// control legend with drag gestures for keyboard players.
withNavigator(() => [], () => {
  const target = new Target();
  const input = new Input(target);
  target.fire('keydown', keyEvent('KeyW'));
  input.update(0.1);
  assert.equal(input.modality, 'keyboard');
  input.setTouchBoost(false);
  input.setTouchAxes(null, null);
  input.releaseTouch();
  assert.equal(input.modality, 'keyboard', 'clearing held touch input must not claim the touch modality');
  input.setTouchBoost(true);
  assert.equal(input.modality, 'touch', 'a real touch press must still claim the modality');
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
  assert.deepEqual(
    input.intent,
    { ...NEUTRAL_INTENT, throttle: input.throttle },
    `${message}: semantic intent must remain neutral`,
  );
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
    input.throttle = 0.43;
    target.fire('blur', {});
    assert.deepEqual(input.intent, { ...NEUTRAL_INTENT, throttle: 0.43 }, 'blur must neutralize held intent');
    assert.deepEqual(
      { pitch: input.pitch, roll: input.roll, yaw: input.yaw },
      { pitch: 0, roll: 0, yaw: 0 },
      'blur must synchronously zero the public Direct axes',
    );
    assert.equal(input.throttle, 0.43, 'blur must preserve the positional Direct throttle');

    target.fire('keydown', keyEvent('KeyD'));
    input.update(0.1);
    input.throttle = 0.51;
    visibilityTarget.hidden = true;
    visibilityTarget.fire('visibilitychange', {});
    assert.deepEqual(input.intent, { ...NEUTRAL_INTENT, throttle: 0.51 }, 'visibility loss must neutralize held intent');
    assert.deepEqual(
      { pitch: input.pitch, roll: input.roll, yaw: input.yaw },
      { pitch: 0, roll: 0, yaw: 0 },
      'visibility loss must synchronously zero the public Direct axes',
    );
    assert.equal(input.throttle, 0.51, 'visibility loss must preserve the positional Direct throttle');

    target.fire('keydown', keyEvent('KeyS'));
    input.update(0.1);
    input.throttle = 0.37;
    input.dispose();
    assert.deepEqual(input.intent, { ...NEUTRAL_INTENT, throttle: 0.37 }, 'disposal must neutralize held intent');
    assert.deepEqual(
      { pitch: input.pitch, roll: input.roll, yaw: input.yaw },
      { pitch: 0, roll: 0, yaw: 0 },
      'disposal must synchronously zero the public Direct axes',
    );
    assert.equal(input.throttle, 0.37, 'disposal must preserve the positional Direct throttle');
    assert.equal(target.listeners.size, 0, 'disposal must remove target listeners');
    assert.equal(visibilityTarget.listeners.size, 0, 'disposal must remove visibility listener');
  } finally {
    Object.defineProperty(globalThis, 'document', { configurable: true, value: oldDocument });
  }
});

withNavigator(() => [], () => {
  const target = new Target();
  const input = new Input(target);
  target.fire('keydown', keyEvent('KeyD'));
  input.update(0.4);
  assert.ok(input.roll > 0.9, 'sustained Direct KeyD must establish smoothed roll authority');
  input.throttle = 0.41;

  input.releaseAll(); // same hard release used by pause and lifecycle cleanup
  assert.equal(input.roll, 0, 'pause cleanup must remove stale Direct roll immediately');
  assert.equal(input.throttle, 0.41, 'pause cleanup must preserve Direct throttle position');
  input.update(1 / 120);
  assert.equal(input.roll, 0, 'resume without a fresh keydown must not restore stale roll authority');

  input.resetForLaunch();
  assert.equal(input.throttle, 0.72, 'explicit sortie launch must restore the desired throttle baseline');
  assert.equal(input.intent.throttle, 0.72);
  input.dispose();
});

{
  const oldNavigator = globalThis.navigator;
  let samples = 0;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {
    getGamepads() { samples++; return [{ connected: true, axes: [0, 0, 0], buttons: [] }]; },
  }});
  const target = new Target();
  const input = new Input(target);
  target.fire('keydown', keyEvent('KeyX'));
  input.update(0.1);
  assert.ok(input.throttle < 0.72, 'X must reach the throttle-down binding');
  assert.equal(input.intent.speed, -1, 'X must expose semantic slow-down intent');
  const throttleAfterX = input.throttle;
  target.fire('keyup', keyEvent('KeyX'));

  let prevented = false;
  target.fire('keydown', { code: 'ControlLeft', repeat: false, ctrlKey: true, altKey: false, metaKey: false, preventDefault() { prevented = true; } });
  input.update(0.1);
  assert.equal(input.throttle, throttleAfterX, 'Control must have no flight throttle action');
  assert.equal(input.intent.speed, 0, 'Control must have no semantic flight action');
  assert.equal(prevented, false, 'modifier shortcuts must not be intercepted');
  assert.equal(samples, 2, 'gamepad state must be snapshotted once per frame');
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
  const impactVelocityIdentity = flight.impactVelocity;
  const impactNormalIdentity = flight.impactNormal;
  flight.position.set(0, -10000, 0);
  flight.velocity.set(0, 0, 500);
  const incomingVelocity = flight.velocity.clone();
  assert.equal(flight.checkTerrainCollision(1 / 30), true, 'collision must inspect the segment just travelled');
  assert.equal(flight.velocity.length(), 0, 'impact must stop the simulated aircraft');
  assert.strictEqual(flight.impactVelocity, impactVelocityIdentity);
  assert.deepEqual(flight.impactVelocity.toArray(), incomingVelocity.toArray(), 'impact preserves incoming direction and magnitude');
  assert.ok(flight.impactVelocity.length() > 1, 'impact keeps incoming velocity before stop');
  assert.ok(Math.abs(flight.impactVelocity.length() - flight.impactSpeed) < 1e-6);
  assert.ok(Math.abs(flight.impactNormal.length() - 1) < 1e-6);
  assert.ok(flight.impactNormal.y > 0.2, 'terrain normal points away from terrain');

  const epsilon = 4;
  const { x, z } = flight.impactPoint;
  const expectedNormal = new THREE.Vector3(
    terrainHeight(x - epsilon, z) - terrainHeight(x + epsilon, z),
    epsilon * 2,
    terrainHeight(x, z - epsilon) - terrainHeight(x, z + epsilon),
  ).normalize();
  assert.ok(flight.impactNormal.distanceTo(expectedNormal) < 1e-6, 'impact normal must follow the local heightfield');

  flight.reset(new THREE.Vector3(0, 1000, 0));
  assert.strictEqual(flight.impactVelocity, impactVelocityIdentity, 'reset keeps impact velocity identity stable');
  assert.strictEqual(flight.impactNormal, impactNormalIdentity, 'reset keeps impact normal identity stable');
  assert.deepEqual(flight.impactVelocity.toArray(), [0, 0, 0], 'reset clears prior impact velocity');
  assert.deepEqual(flight.impactNormal.toArray(), [0, 1, 0], 'reset restores the default upward impact normal');
}

{
  const input = new Input(new Target());
  input.setTouchBoost(true);
  input.setTouchAxes(-0.7, 0.5);
  input.releaseAll();
  assert.deepEqual(input.intent, NEUTRAL_INTENT, 'Game lifecycle cleanup may centrally release all semantic controls');
  assert.equal(input.touchBoost, false);
  assert.equal(input.touchActive, false);
  input.dispose();
}

console.log('input, chase and flight lifecycle contracts passed');

// --------------------------------------------------- text fields vs flying --
//
// The keydown listener is on the window, so anything typed into a control in
// the UI layer bubbles up to it. Until the leaderboard there were no text
// fields in the experience at all, and it never mattered; with one, twice.
{
  const target = new Target();
  const input = new Input(target);
  const typed = (code, tagName = 'INPUT', extra = {}) => {
    const event = keyEvent(code, {
      target: { tagName, ...extra },
      prevented: false,
      preventDefault() { this.prevented = true; },
    });
    target.fire('keydown', event);
    return event;
  };

  // Enter in the callsign field must not reach the debrief, which consumes
  // Enter to restart: recording it tore the debrief down in the same frame the
  // time was saved, so the player never saw their rank.
  const enter = typed('Enter');
  assert.equal(input.consumePress('Enter'), false, 'Enter in a text field is text, not a control');
  assert.equal(enter.prevented, false, 'and must not be suppressed');

  // Space is in PREVENT_DEFAULT, which made a callsign containing a space
  // impossible to type even though sanitiseName accepts one.
  const space = typed('Space');
  assert.equal(space.prevented, false, 'a space must reach the field');
  assert.equal(input.keys.has('Space'), false);

  for (const tag of ['TEXTAREA', 'SELECT']) {
    typed('KeyW', tag);
    assert.equal(input.keys.has('KeyW'), false, tag + ' counts as text entry');
  }
  typed('KeyW', 'DIV', { isContentEditable: true });
  assert.equal(input.keys.has('KeyW'), false, 'contenteditable counts as text entry');

  // The same keys away from a field still fly the aircraft.
  const flying = typed('KeyW', 'CANVAS');
  assert.equal(input.keys.has('KeyW'), true, 'flight keys are unaffected');
  assert.equal(input.consumePress('KeyW'), true);
  void flying;

  const bare = keyEvent('Space', { prevented: false, preventDefault() { this.prevented = true; } });
  target.fire('keydown', bare);
  assert.equal(bare.prevented, true, 'Space away from a field is still suppressed');

  input.dispose();
}

console.log('text-entry input contracts passed');

