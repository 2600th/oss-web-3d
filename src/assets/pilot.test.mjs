import test from 'node:test';
import assert from 'node:assert/strict';
import { headAim, turnLook, PilotRig, HEAD_LIMITS } from './pilot.js';

const near = (a, b, e = 1e-6) => assert.ok(Math.abs(a - b) < e, `${a} != ${b}`);

test('headAim: straight ahead is neutral, left is +yaw, up is +pitch', () => {
  const a = headAim({ x: 0, y: 0, z: -1 });
  near(a.yaw, 0);
  near(a.pitch, 0);
  assert.ok(headAim({ x: -1, y: 0, z: -1 }).yaw > 0.7);
  assert.ok(headAim({ x: 1, y: 0, z: -1 }).yaw < -0.7);
  assert.ok(headAim({ x: 0, y: 0.3, z: -1 }).pitch > 0.2);
});

test('headAim: clamps to the neck limits, also for targets behind', () => {
  near(headAim({ x: -0.1, y: 0, z: 1 }).yaw, HEAD_LIMITS.yaw);
  near(headAim({ x: 0, y: 1, z: -0.01 }).pitch, HEAD_LIMITS.up);
  near(headAim({ x: 0, y: -1, z: -0.01 }).pitch, HEAD_LIMITS.down);
  // turned fully round, the head cannot also look far up
  assert.ok(headAim({ x: -1, y: 1, z: 0.5 }).pitch <= HEAD_LIMITS.up * 0.5 + 1e-9);
});

test('turnLook: looks into the bank, more under G', () => {
  assert.ok(turnLook(0.8, 1).yaw < 0, 'right bank looks right (-yaw)');
  assert.ok(turnLook(-0.8, 1).yaw > 0, 'left bank looks left');
  assert.ok(Math.abs(turnLook(1, 6).yaw) > Math.abs(turnLook(1, 1).yaw));
  near(turnLook(0, 1).yaw, 0);
});

test('PilotRig: hides only the head in first person and turns it rate-limited', () => {
  const head = { visible: true, rotation: { x: 0, y: 0, set(x, y) { this.x = x; this.y = y; } } };
  const rig = new PilotRig({ getObjectByName: (n) => (n === 'pilot_head' ? head : null) });
  rig.update(1 / 60, { firstPerson: true });
  assert.equal(head.visible, false);
  rig.update(1 / 60, { target: { x: -1, y: 0, z: 0 } });
  assert.equal(head.visible, true);
  assert.ok(head.rotation.y > 0 && head.rotation.y <= HEAD_LIMITS.rate / 60 + 1e-9, 'rate limited');
  for (let i = 0; i < 400; i++) rig.update(1 / 60, { target: { x: -1, y: 0, z: 0 } });
  near(head.rotation.y, Math.min(Math.PI / 2, HEAD_LIMITS.yaw), 1e-3);
  // no head node: no throw
  new PilotRig({ getObjectByName: () => null }).update(0.016, {});
});
