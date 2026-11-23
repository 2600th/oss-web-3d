import test from 'node:test';
import assert from 'node:assert/strict';
import { Input, DEFAULT_BINDINGS, ACTIONS } from './Input.js';
import { AssistController } from '../flight/AssistController.js';
import { FlightModel, AIRCRAFT } from '../flight/FlightModel.js';
import { Vector3 } from 'three';

function fakeTarget() {
  const handlers = {};
  return {
    handlers,
    addEventListener: (t, fn) => { handlers[t] = fn; },
    removeEventListener: (t) => { delete handlers[t]; },
    key(code, down = true, extra = {}) { handlers[down ? 'keydown' : 'keyup']?.({ code, target: { tagName: 'BODY' }, preventDefault() {}, ...extra }); },
    mouse(button, down = true, tag = 'CANVAS') { handlers[down ? 'mousedown' : 'mouseup']?.({ button, target: { tagName: tag } }); },
  };
}

test('one binding table drives every action; defaults match the documented map', () => {
  assert.deepEqual(DEFAULT_BINDINGS.fireMissile.keys, ['Space']);
  assert.deepEqual(DEFAULT_BINDINGS.fireGun.keys, ['KeyF']);
  assert.deepEqual(DEFAULT_BINDINGS.fireGun.mouse, [0]);
  assert.deepEqual(DEFAULT_BINDINGS.targetNext.keys, ['Tab', 'KeyT']);
  for (const a of ['pitchUp', 'pitchDown', 'rollLeft', 'rollRight', 'yawLeft', 'yawRight', 'throttleUp', 'brake', 'switchWeapon', 'flares', 'camera', 'pause', 'optic', 'controlMode']) assert.ok(ACTIONS.includes(a), a);
});

test('held actions, one-frame edges, consume, and axes', () => {
  const t = fakeTarget();
  const input = new Input(t);
  t.key('Space');
  t.key('KeyA');
  input.update(1 / 60);
  assert.equal(input.actions.fireMissile, true);
  assert.equal(input.pressed.fireMissile, true);
  assert.equal(input.consume('fireMissile'), true);
  assert.equal(input.consume('fireMissile'), false, 'consumed once');
  assert.equal(input.pressed.fireMissile, true, 'but still readable by other systems this frame');
  for (let i = 0; i < 60; i++) input.update(1 / 60);
  assert.equal(input.pressed.fireMissile, false, 'edge lasts one frame');
  assert.equal(input.actions.fireMissile, true, 'still held');
  assert.ok(input.roll < -0.95 && input.intent.turn === -1);
  t.key('Space', false); t.key('KeyA', false);
  for (let i = 0; i < 60; i++) input.update(1 / 60);
  assert.equal(input.actions.fireMissile, false);
  assert.ok(Math.abs(input.roll) < 0.01);
});

test('pitch convention, throttle lever, mouse on canvas only, text fields ignored', () => {
  const t = fakeTarget();
  const input = new Input(t);
  t.key('KeyS');
  t.key('ShiftLeft');
  for (let i = 0; i < 90; i++) input.update(1 / 60);
  assert.ok(input.pitch < -0.95, 'S pulls: negative pitch axis = nose up');
  assert.equal(input.intent.climb, 1);
  assert.ok(input.throttle > 0.97 && input.intent.boost, 'hold to accelerate into reheat');
  t.key('ShiftLeft', false); t.key('KeyS', false);
  t.key('ControlLeft');
  for (let i = 0; i < 90; i++) input.update(1 / 60);
  assert.ok(input.throttle < 0.2 && input.brake === 1, 'brake pulls the lever back and opens the airbrake');
  t.key('ControlLeft', false);
  for (let i = 0; i < 120; i++) input.update(1 / 60);
  assert.ok(Math.abs(input.throttle - 0.8) < 0.01, 'released lever returns to cruise');
  input.invertPitch = true;
  t.key('KeyS');
  for (let i = 0; i < 60; i++) input.update(1 / 60);
  assert.ok(input.pitch > 0.9);
  t.key('KeyS', false);

  t.mouse(0, true, 'BUTTON');
  input.update(1 / 60);
  assert.equal(input.actions.fireGun, false, 'clicks on UI do not fire the gun');
  t.mouse(0, true);
  input.update(1 / 60);
  assert.equal(input.actions.fireGun, true);
  t.handlers.keydown({ code: 'KeyF', target: { tagName: 'INPUT' }, preventDefault() {} });
  t.mouse(0, false);
  input.update(1 / 60);
  assert.equal(input.actions.fireGun, false);
});

test('rebinding, touch/script actions and the legacy touch entry points', () => {
  const t = fakeTarget();
  const input = new Input(t);
  input.rebind('flares', { keys: ['KeyG'] });
  t.key('KeyX'); input.update(1 / 60);
  assert.equal(input.pressed.flares, false);
  t.key('KeyG'); input.update(1 / 60);
  assert.equal(input.pressed.flares, true);
  input.resetBindings();
  assert.deepEqual(input.bindings.flares.keys, ['KeyX']);

  input.setAction('fireGun', true); input.update(1 / 60);
  assert.ok(input.actions.fireGun && input.pressed.fireGun);
  input.setAction('fireGun', false); input.update(1 / 60);
  assert.equal(input.actions.fireGun, false);
  input.pressAction('targetNext'); input.update(1 / 60);
  assert.equal(input.pressed.targetNext, true);
  input.pressTouch('KeyF'); input.update(1 / 60);
  assert.equal(input.pressed.fireGun, true);
  assert.equal(input.consumePress('KeyF'), true);
  input.setTouchAxes(-1, 0.5);
  for (let i = 0; i < 60; i++) input.update(1 / 60);
  assert.ok(input.pitch < -0.9 && input.roll > 0.45 && input.modality === 'touch');
  input.setTouchAxes(null, null);
  input.setTouchThrottle(0.3);
  for (let i = 0; i < 120; i++) input.update(1 / 60);
  assert.ok(Math.abs(input.throttle - 0.3) < 0.02, 'touch lever is absolute');
  assert.equal(input.setMode('expert'), 'expert');
  assert.equal(input.setMode('nonsense'), 'standard');
  input.dispose();
  assert.equal(Object.keys(t.handlers).length, 0);
});

// ---- flight feel (the numbers the control modes are built on) ----------------

function settle(intent, seconds, setup = () => {}) {
  const flight = new FlightModel();
  flight.reset(new Vector3(0, 9000, 0), 0, 250);
  // Flat world for the test: far above anything.
  const assist = new AssistController();
  setup(flight);
  const opts = { sensitivity: 'combat', autoThrottle: false };
  let heading0 = Math.atan2(flight.forward.x, -flight.forward.z);
  let turned = 0, maxG = 0, maxBank = 0;
  for (let t = 0; t < seconds; t += 1 / 120) {
    flight.update(1 / 120, assist.update(1 / 120, intent, flight, opts));
    const h = Math.atan2(flight.forward.x, -flight.forward.z);
    let d = h - heading0; if (d > Math.PI) d -= 2 * Math.PI; if (d < -Math.PI) d += 2 * Math.PI;
    turned += d; heading0 = h;
    maxG = Math.max(maxG, flight.gLoad);
    maxBank = Math.max(maxBank, Math.abs(Math.atan2(flight.right.y, flight.up.y)));
  }
  return { flight, turned, maxG, maxBank };
}

test('Standard mode: full stick is a hard coordinated turn that holds altitude', () => {
  const { flight, turned, maxG } = settle({ turn: 1, climb: 0, brake: 0, throttle: 1 }, 6);
  const rate = (turned / 6) * 180 / Math.PI;
  assert.ok(rate > 14 && rate < 30, `turn rate ${rate.toFixed(1)} deg/s`);
  assert.ok(maxG > 6 && maxG < 10.5, `G ${maxG.toFixed(1)}`);
  assert.ok(Math.abs(flight.position.y - 9000) < 250, `altitude drift ${(flight.position.y - 9000).toFixed(0)} m`);
});

test('Standard mode: airbrake + turn is the high-G turn — more rate, costs speed', () => {
  const normal = settle({ turn: 1, climb: 0, brake: 0, throttle: 1 }, 4);
  const highG = settle({ turn: 1, climb: 0, brake: 1, throttle: 1 }, 4);
  assert.ok(highG.turned > normal.turned * 1.15, `${highG.turned.toFixed(2)} vs ${normal.turned.toFixed(2)} rad`);
  assert.ok(highG.maxG > normal.maxG + 1.5);
  assert.ok(highG.flight.airspeed < normal.flight.airspeed - 12, `bleeds speed: ${highG.flight.airspeed.toFixed(0)} vs ${normal.flight.airspeed.toFixed(0)}`);
});

test('Standard mode: turn + dive is a descending turn (neither axis starves the other), wings stay upright for small corrections', () => {
  const slice = settle({ turn: 1, climb: -0.6, brake: 0, throttle: 0.8 }, 5);
  assert.ok(slice.turned > 0.9, `turned ${slice.turned.toFixed(2)} rad`);
  assert.ok(slice.flight.position.y < 9000 - 200, `descended ${(9000 - slice.flight.position.y).toFixed(0)} m`);
  const nudge = settle({ turn: 0.05, climb: -0.5, brake: 0, throttle: 0.8 }, 5);
  assert.ok(nudge.maxBank < 1.2, `bank ${(nudge.maxBank * 57.3).toFixed(0)} deg — a dive with a small correction must not roll inverted`);
  assert.ok(nudge.flight.velocity.y < -60);
  const climb = settle({ turn: 0, climb: 1, brake: 0, throttle: 1 }, 5);
  assert.ok(climb.flight.velocity.y > 120);
});

test('flight model: reheat accelerates hard, damage costs handling, a destroyed aircraft falls', () => {
  const dry = new FlightModel(); dry.reset(new Vector3(0, 6000, 0), 0, 220);
  const wet = new FlightModel(); wet.reset(new Vector3(0, 6000, 0), 0, 220);
  const level = { pitch: 0, roll: 0, yaw: 0, brake: 0 };
  for (let t = 0; t < 6; t += 1 / 120) { dry.update(1 / 120, { ...level, throttle: 0.8 }); wet.update(1 / 120, { ...level, throttle: 1 }); }
  assert.ok(wet.airspeed - dry.airspeed > 20, `reheat gain ${(wet.airspeed - dry.airspeed).toFixed(0)} m/s in 6 s`);
  assert.equal(wet.reheat, true);

  const pull = { pitch: -1, roll: 0, yaw: 0, throttle: 1, brake: 0 };
  const ok = new FlightModel(); ok.reset(new Vector3(0, 6000, 0), 0, AIRCRAFT.cornerSpeed);
  const hurt = new FlightModel(); hurt.reset(new Vector3(0, 6000, 0), 0, AIRCRAFT.cornerSpeed); hurt.damage = 1;
  ok.update(1 / 120, pull); hurt.update(1 / 120, pull);
  assert.ok(hurt.pitchAuthority < ok.pitchAuthority * 0.8);
  const hg = new FlightModel(); hg.reset(new Vector3(0, 6000, 0), 0, AIRCRAFT.cornerSpeed);
  hg.update(1 / 120, { ...pull, brake: 1 });
  assert.ok(hg.pitchAuthority > ok.pitchAuthority * 1.3 && hg.highG > 0.9);

  const dead = new FlightModel(); dead.reset(new Vector3(0, 6000, 0), 0, 250); dead.destroyed = true;
  for (let t = 0; t < 8; t += 1 / 120) dead.update(1 / 120, { pitch: -1, roll: 0, yaw: 0, throttle: 1, brake: 0 });
  assert.ok(dead.position.y < 5800 && dead.velocity.y < -40, 'no thrust, no authority: it comes down');
});
