import test from 'node:test';
import assert from 'node:assert/strict';
import { Spotter, pictureCall } from './spotting.js';
import { MissionRunner, testCondition } from './runner.js';
import { missionById } from './data.js';

const truck = (x, z, tags = ['col']) => ({ kind: 'truck', class: 'ground', alive: true, tags, position: { x, y: 3000, z } });
const fighter = (x, z, reheat = 0) => ({ kind: 'fighter', class: 'air', alive: true, tags: ['air'], position: { x, y: 3000, z }, engine: { reheat } });
const clear = () => true;
const run = (sp, seconds, player, los = clear) => { for (let t = 0; t < seconds; t += 0.1) sp.update(0.1, player, los); };

test('spotting: a truck is off the HUD until it is in sight range and line of sight', () => {
  const sp = new Spotter({ tags: ['col'], truck: { lit: 5000, dark: 1500 }, lose: 5 });
  const t = truck(0, 0);
  sp.add(t);
  assert.equal(t.hidden, true);
  assert.equal(t.selectable, false);
  assert.equal(t.lockable, false);
  run(sp, 1, { x: 0, y: 3000, z: 8000 });
  assert.equal(t.hidden, true, 'too far');
  run(sp, 1, { x: 0, y: 3000, z: 4000 }, () => false);
  assert.equal(t.hidden, true, 'behind a ridge');
  run(sp, 1, { x: 0, y: 3000, z: 4000 });
  assert.equal(t.hidden, false);
  assert.equal(t.selectable, undefined, 'its own flags come back');
  assert.equal(t.lockable, undefined);
  // Stays marked a little way out, is lost after `lose` seconds well away.
  run(sp, 3, { x: 0, y: 3000, z: 6500 });
  assert.equal(t.hidden, false);
  run(sp, 6, { x: 0, y: 3000, z: 9000 });
  assert.equal(t.hidden, true);
});

test('spotting: only watched tags; a dead truck gets its flags back', () => {
  const sp = new Spotter({ tags: ['col'] });
  const other = truck(0, 0, ['other']);
  sp.add(other);
  assert.equal(other.hidden, undefined);
  const t = truck(0, 0);
  sp.add(t);
  t.alive = false;
  run(sp, 0.2, { x: 0, y: 3000, z: 50000 });
  assert.equal(t.hidden, false);
  assert.equal(sp.stats().tracked, 0);
});

test('spotting: scatter puts the lights out, drops far marks, speeds the column up and opens it out', () => {
  const sp = new Spotter({ tags: ['col'], truck: { lit: 5000, dark: 1500 }, scatter: { seconds: 10, speed: 1.5, spread: 2 } });
  const near = truck(0, 0), far = truck(0, -3000);
  const lamps = { visible: true };
  far.object3d = { getObjectByName: (n) => (n === 'headlights' ? lamps : null) };
  sp.add(near); sp.add(far);
  const player = { x: 0, y: 3000, z: 1000 };
  run(sp, 0.5, player);
  assert.equal(near.hidden, false);
  assert.equal(far.hidden, false);
  const convoy = { speed: 14, spacing: 55 };
  sp.scatter(convoy, [near, far], player);
  assert.equal(lamps.visible, false);
  assert.equal(far.hidden, true, 'lights out: lost at once');
  assert.equal(near.hidden, false, 'already close: still marked');
  assert.equal(convoy.speed, 21);
  run(sp, 5, player);
  assert.ok(convoy.spacing > 55 && convoy.spacing <= 110, `spacing ${convoy.spacing}`);
  run(sp, 30, player);
  assert.equal(convoy.speed, 14);
  assert.equal(convoy.spacing, 55, 'closes up again');
  assert.equal(lamps.visible, true);
  sp.scatter(convoy, [near, far], player);
  sp.clear();
  assert.equal(convoy.speed, 14);
});

test('spotting: a fighter shows by its burner; firing gives it away', () => {
  const sp = new Spotter({ tags: ['air'], fighter: { lit: 5000, dark: 2000 } });
  const f = fighter(0, 0, 0);
  sp.add(f);
  run(sp, 1, { x: 0, y: 3000, z: 3500 });
  assert.equal(f.hidden, true, 'throttled back at 3.5 km');
  f.engine.reheat = 1;
  run(sp, 1, { x: 0, y: 3000, z: 3500 });
  assert.equal(f.hidden, false, 'burner at 3.5 km');
  const g = fighter(0, 0, 0);
  sp.add(g);
  sp.reveal(g);
  assert.equal(g.hidden, false);
  assert.deepEqual(sp.unseen('fighter'), []);
});

test('picture call: clock code, range and height from the pilot', () => {
  const p = { x: 0, y: 5000, z: 0 };
  assert.equal(pictureCall(p, 0, { x: 0, y: 5000, z: -9000 }), "your 12 o'clock, 9 kilometres, level");
  assert.equal(pictureCall(p, 0, { x: 6000, y: 3000, z: 0 }), "your 3 o'clock, 6 kilometres, low");
  assert.equal(pictureCall(p, Math.PI / 2, { x: 0, y: 7000, z: 800 }), "your 3 o'clock, 1 kilometre, high", 'heading east, south is on the right');
});

test('runner: resupply action and a zone with a height limit', () => {
  const got = [];
  const r = new MissionRunner({ phases: [{ id: 'a', triggers: [{ when: { zone: { x: 0, z: 0, r: 1000, below: 5600 } }, do: [{ resupply: { health: 40 } }, { flag: 'up' }] }], done: { flag: 'up' } }] }, { resupply: (x) => got.push(x) });
  r.start();
  r.update(0.1, { player: { x: 0, y: 6000, z: 0 } });
  assert.equal(got.length, 0, 'above the limit');
  r.update(0.1, { player: { x: 0, y: 5000, z: 0 } });
  assert.deepEqual(got, [{ health: 40 }]);
  assert.equal(r.state, 'complete');
  assert.equal(testCondition({ zone: { x: 0, z: 0, r: 10 } }, { player: { x: 0, y: 9e9, z: 0 } }), true, 'no limit: height ignored');
});

test('Thunderhead: three groups with a regroup before the last, eleven in all, no raised attack cap', () => {
  const m = missionById('storm');
  assert.deepEqual(m.phases.map((p) => p.id), ['first', 'second', 'regroup', 'third']);
  const n = Object.values(m.groups).reduce((a, g) => a + g.count, 0);
  assert.equal(n, 11);
  const regroup = m.phases.find((p) => p.id === 'regroup');
  assert.ok(regroup.triggers.some((t) => t.do.some((a) => a.resupply)), 'regroup tops the player up');
  assert.ok(testCondition(regroup.done, { phaseTime: 80, flags: {} }), 'the gap ends on its own');
  assert.ok(!m.phases.some((p) => (p.enter ?? []).some((a) => a.maxAttackers !== undefined)));
});

test('Black Road: spotting on, guns on the road, a night pair during the search', () => {
  const m = missionById('night');
  assert.ok(m.spotting.tags.includes('night_trucks') && m.spotting.tags.includes('night_air'));
  for (const id of ['road1', 'road2', 'road3']) assert.ok(m.groups[id].units.some((u) => u.type === 'aaa'), id);
  assert.equal(m.groups.prowl.skillOverrides.dark, true);
  const prowlSpawns = m.phases.filter((p) => (p.triggers ?? []).some((t) => t.do.some((a) => a.spawn === 'prowl')));
  assert.equal(prowlSpawns.length, 2, 'whichever column phase is running at 30 s');
  assert.equal(m.phases.find((p) => p.id === 'cap').objective.track.total, 4);
});
