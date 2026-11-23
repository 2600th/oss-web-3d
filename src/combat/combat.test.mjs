import test from 'node:test';
import assert from 'node:assert/strict';
import { Vector3 } from 'three';
import { pnAcceleration, steerVelocity, interceptTime, leadPoint, flareDecoys, ballisticImpact, segmentPointDistSq, G } from './guidance.js';
import { LockTracker, lockGeometry, rankTargets, pickTarget, cycleTarget } from './lock.js';
import { CombatWorld } from './CombatWorld.js';
import { WEAPONS, damageAgainst } from './weapons.js';

const v = (x, y, z) => new Vector3(x, y, z);

// ---- guidance ---------------------------------------------------------------

test('PN commands acceleration toward where a crossing target is going', () => {
  const a = pnAcceleration(v(0, 0, 0), v(0, 0, 0), v(300, 0, 0), v(1000, 0, 0), v(0, 100, 0), 4);
  assert.ok(a.y > 0, 'pulls toward the target motion');
  assert.ok(Math.abs(a.x) < 1e-6 && Math.abs(a.z) < 1e-6, 'perpendicular to the line of sight');
});

test('PN commands nothing on a pure collision course', () => {
  const a = pnAcceleration(v(0, 0, 0), v(0, 0, 0), v(300, 0, 0), v(1000, 0, 0), v(-200, 0, 0), 4);
  assert.ok(a.length() < 1e-6);
});

test('steerVelocity respects the G limit and keeps speed', () => {
  const vel = v(400, 0, 0);
  const pulled = steerVelocity(vel, v(0, 5000, 0), 20, 0.1);
  assert.ok(Math.abs(pulled - 20) < 1e-6);
  assert.ok(Math.abs(vel.length() - 400) < 1e-6);
  const turned = Math.atan2(vel.y, vel.x);
  assert.ok(Math.abs(turned - Math.atan((20 * G * 0.1) / 400)) < 1e-3);
});

test('intercept time and lead point for a crossing target', () => {
  // Target 1000 m ahead crossing at 100 m/s, projectile 1000 m/s.
  const t = interceptTime(v(0, 0, 0), v(0, 0, -1000), v(100, 0, 0), 1000);
  assert.ok(Math.abs(t - 1000 / Math.sqrt(1000 ** 2 - 100 ** 2)) < 1e-6);
  const out = v(0, 0, 0);
  const tof = leadPoint(out, v(0, 0, 0), v(0, 0, 0), v(0, 0, -1000), v(100, 0, 0), 1000);
  assert.ok(Math.abs(out.x - 100 * tof) < 1e-6);
  assert.ok(Math.abs(out.length() - 1000 * tof) < 1e-3, 'projectile reaches the aim point at the same time');
});

test('no intercept solution when the target outruns the projectile', () => {
  assert.equal(interceptTime(v(0, 0, 0), v(0, 0, -1000), v(0, 0, -500), 300), Infinity);
});

test('flares decoy only inside the seeker cone and near the target', () => {
  const base = {
    missilePos: v(0, 0, 1500), missileDir: v(0, 0, -1), seekerCos: Math.cos(0.8),
    targetPos: v(0, 0, 0), targetForward: v(0, 0, -1), flarePos: v(20, -10, 30), flareChance: 0.5, roll: 0.1,
  };
  assert.equal(flareDecoys(base), true);
  assert.equal(flareDecoys({ ...base, roll: 0.99 }), false, 'the roll can fail');
  assert.equal(flareDecoys({ ...base, flareChance: 0 }), false, 'radar missiles ignore flares');
  assert.equal(flareDecoys({ ...base, flarePos: v(900, 0, 0) }), false, 'too far from the target');
  assert.equal(flareDecoys({ ...base, missileDir: v(0, 0, 1) }), false, 'outside the seeker cone');
  // Head-on is harder to decoy than a tail chase.
  const roll = 0.3;
  assert.equal(flareDecoys({ ...base, roll }), true);
  assert.equal(flareDecoys({ ...base, roll, targetForward: v(0, 0, 1) }), false);
});

test('ballistic impact lands ahead of the release point', () => {
  const out = v(0, 0, 0);
  const t = ballisticImpact(out, v(0, 1000, 0), v(0, 0, -200), () => 0);
  assert.ok(Math.abs(t - Math.sqrt(2000 / G)) < 0.12);
  assert.ok(Math.abs(out.z + 200 * t) < 25);
});

test('segment-point distance clamps to the segment', () => {
  assert.equal(segmentPointDistSq(v(0, 0, 0), v(10, 0, 0), v(5, 3, 0)), 9);
  assert.equal(segmentPointDistSq(v(0, 0, 0), v(10, 0, 0), v(14, 3, 0)), 25);
});

// ---- lock -------------------------------------------------------------------

test('lock geometry: range and cone', () => {
  const g = lockGeometry(v(0, 0, 0), v(0, 0, -1), v(0, 0, -3000), 4800, 0.3);
  assert.ok(g.inRange && g.inCone && g.distance === 3000);
  assert.equal(lockGeometry(v(0, 0, 0), v(0, 0, -1), v(3000, 0, -100), 4800, 0.3).inCone, false);
  assert.equal(lockGeometry(v(0, 0, 0), v(0, 0, -1), v(0, 0, -6000), 4800, 0.3).inRange, false);
});

test('lock tracker: acquiring -> locked -> lost, and restarts on a new target', () => {
  const lock = new LockTracker();
  const a = { alive: true }, b = { alive: true };
  assert.deepEqual(lock.update(0.1, a, true, 1), { event: 'acquiring', target: a });
  let ev = null;
  for (let i = 0; i < 12 && !ev; i++) ev = lock.update(0.1, a, true, 1);
  assert.deepEqual(ev, { event: 'locked', target: a });
  assert.equal(lock.state, 'locked');
  assert.equal(lock.update(0.05, a, false, 1), null, 'a brief slip does not drop the lock');
  ev = null;
  for (let i = 0; i < 10 && !ev; i++) ev = lock.update(0.05, a, false, 1);
  assert.equal(ev.event, 'lost');
  // Re-lock, then switch target: lost immediately, progress restarts.
  for (let i = 0; i < 12; i++) lock.update(0.1, a, true, 1);
  assert.equal(lock.state, 'locked');
  assert.deepEqual(lock.update(0.1, b, true, 1), { event: 'lost', target: a });
  assert.equal(lock.target, b);
  assert.ok(lock.progress < 0.2);
  // Target dies.
  for (let i = 0; i < 12; i++) lock.update(0.1, b, true, 1);
  b.alive = false;
  assert.equal(lock.update(0.1, b, true, 1).event, 'lost');
  assert.equal(lock.state, 'none');
});

test('target ranking prefers mission targets near the nose; cycle walks the list', () => {
  const mk = (x, z, extra = {}) => ({ alive: true, team: 'hostile', class: 'ground', position: v(x, 0, z), ...extra });
  const near = mk(0, -2000), objective = mk(300, -4000, { isTarget: true }), behind = mk(0, 1500), friend = mk(0, -500, { team: 'friendly' });
  const list = [near, objective, behind, friend];
  const ranked = rankTargets(list, v(0, 0, 0), v(0, 0, -1)).map((r) => r.target);
  assert.deepEqual(ranked, [objective, near, behind]);
  assert.equal(pickTarget(list, v(0, 0, 0), v(0, 0, -1)), objective);
  assert.equal(cycleTarget(list, objective, v(0, 0, 0), v(0, 0, -1)), near);
  assert.equal(cycleTarget(list, behind, v(0, 0, 0), v(0, 0, -1)), objective, 'wraps');
});

// ---- world ------------------------------------------------------------------

function makeWorld(rng = () => 0.5) {
  const log = [];
  const world = new CombatWorld({ events: { emit: (type, p) => log.push({ type, ...p }) }, terrainHeight: () => 0, rng });
  const player = world.addTarget({ id: 'player', class: 'air', team: 'friendly', position: v(0, 3000, 0), velocity: v(0, 0, -250), health: 100, radius: 9 });
  world.player = player;
  return { world, player, log };
}

function fly(world, seconds, tick = () => {}) {
  for (let t = 0; t < seconds; t += 1 / 120) { tick(1 / 120); world.step(1 / 120); }
}

test('a guided missile hits a non-manoeuvring target, scores and emits the catalogue events', () => {
  const { world, player, log } = makeWorld();
  const bandit = world.addTarget({ class: 'air', team: 'hostile', kind: 'fighter', position: v(200, 3100, -3000), velocity: v(60, 0, -220), health: 60, score: 400, tags: ['x'] });
  const m = world.fireMissile({ weapon: 'msl', owner: player, target: bandit, position: player.position, direction: v(0, 0, -1), velocity: player.velocity });
  assert.equal(m.kind, 'aam');
  fly(world, 9, (dt) => bandit.position.addScaledVector(bandit.velocity, dt));
  assert.equal(bandit.alive, false);
  const types = log.map((e) => e.type);
  for (const t of ['missile:launch', 'explosion', 'target:destroyed', 'missile:end']) assert.ok(types.includes(t), t);
  const kill = log.find((e) => e.type === 'target:destroyed');
  assert.equal(kill.score, 400);
  assert.equal(kill.killer, player);
  assert.equal(log.find((e) => e.type === 'missile:end').reason, 'hit');
  assert.deepEqual([world.stats.mslFired, world.stats.mslHits, world.stats.airKills], [1, 1, 1]);
});

test('a hostile missile can be beaten: flares decoy it and the player survives', () => {
  const { world, player, log } = makeWorld(() => 0); // every flare roll succeeds
  const sam = world.addTarget({ class: 'ground', team: 'hostile', position: v(0, 0, -2500), health: 50 });
  const m = world.fireMissile({ weapon: 'e_manpads', owner: sam, target: player, position: v(0, 0, -2500), direction: v(0, 0.8, 0.6) });
  assert.equal(m.kind, 'sam');
  let dropped = false;
  fly(world, 9, (dt) => {
    player.position.addScaledVector(player.velocity, dt);
    if (!dropped && m.alive && m.position.distanceTo(player.position) < 1200) {
      dropped = true;
      world.releaseFlare(player, player.position.clone().add(v(0, -5, 20)), v(0, -20, -100));
    }
  });
  assert.ok(dropped);
  assert.equal(m.decoyed, true);
  assert.equal(player.health, 100);
  assert.ok(log.some((e) => e.type === 'flare:release'));
  assert.ok(log.some((e) => e.type === 'missile:end' && e.reason !== 'hit'));
});

test('a hostile missile that is not decoyed hits and emits player:hit', () => {
  const { world, player, log } = makeWorld(() => 0.99);
  const sam = world.addTarget({ class: 'ground', team: 'hostile', position: v(0, 0, -2500), health: 50 });
  world.fireMissile({ weapon: 'e_sam', owner: sam, target: player, position: v(0, 0, -2500), direction: v(0, 0.8, 0.6) });
  fly(world, 9, (dt) => player.position.addScaledVector(player.velocity, dt));
  const hit = log.find((e) => e.type === 'player:hit');
  assert.ok(hit && hit.health < 1);
  assert.ok(player.health < 100 && player.alive);
});

test('a missile loses a target that leaves its seeker cone', () => {
  const { world, player, log } = makeWorld();
  const bandit = world.addTarget({ class: 'air', team: 'hostile', position: v(0, 3000, 2500), velocity: v(0, 0, 250), health: 60 });
  world.fireMissile({ weapon: 'msl', owner: player, target: bandit, position: player.position, direction: v(0, 0, -1), velocity: player.velocity });
  fly(world, 4, (dt) => bandit.position.addScaledVector(bandit.velocity, dt));
  assert.equal(bandit.alive, true);
  assert.equal(log.find((e) => e.type === 'missile:end').reason, 'miss');
});

test('radar SAM guidance drops when its guide function fails (terrain masking / dead radar)', () => {
  const { world, player } = makeWorld();
  const site = world.addTarget({ class: 'ground', team: 'hostile', position: v(0, 0, -4000), health: 90 });
  let radar = true;
  const m = world.fireMissile({ weapon: 'e_sam', owner: site, target: player, position: v(0, 0, -4000), direction: v(0, 0.7, 0.7), guide: () => radar });
  fly(world, 1.5);
  assert.equal(m.target, player);
  radar = false;
  fly(world, 0.1);
  assert.equal(m.target, null);
});

test('bullets hit, armour scales damage, and bunkers shrug off the gun', () => {
  const { world, player, log } = makeWorld();
  const tent = world.addTarget({ class: 'ground', armor: 'soft', team: 'hostile', kind: 'tent', position: v(0, 3000, -600), health: 26, score: 60 });
  const bunker = world.addTarget({ class: 'ground', armor: 'hard', team: 'hostile', kind: 'bunker', position: v(0, 2000, -600), health: 260 });
  for (let i = 0; i < 4; i++) world.fireBullet(player, v(0, 3000, -i), v(0, 0, -1050), 9, 2);
  for (let i = 0; i < 4; i++) world.fireBullet(player, v(0, 2000, -i), v(0, 0, -1050), 9, 2);
  fly(world, 1);
  assert.equal(tent.alive, false, '9 x 1.6 x 2 rounds kills a tent');
  assert.ok(bunker.health > 250);
  assert.equal(world.stats.gunFired, 8);
  assert.ok(world.stats.gunHits >= 6);
  assert.ok(log.some((e) => e.type === 'weapon:gunHit' && e.targetKind === 'tent'));
  assert.ok(damageAgainst(WEAPONS.bomb, 'hard') > 260, 'one bomb kills a bunker');
});

test('a bomb is ballistic, explodes on the ground and splashes neighbours; dumps cook off', () => {
  const { world, player, log } = makeWorld();
  const dump = world.addTarget({ class: 'ground', armor: 'soft', team: 'hostile', kind: 'supply', position: v(0, 2, -1000), health: 70, secondary: { radius: 95, damage: 160 }, explosion: 'huge' });
  const tent = world.addTarget({ class: 'ground', armor: 'soft', team: 'hostile', kind: 'tent', position: v(60, 2, -1000), health: 26 });
  const out = v(0, 0, 0);
  // Release so the bomb lands ~40 m short of the dump.
  const tof = ballisticImpact(out, v(0, 1000, 0), v(0, 0, -200), () => 0, { drag: WEAPONS.bomb.drag });
  player.position.set(0, 1000, -1000 + 40 - out.z);
  player.velocity.set(0, 0, -200);
  const m = world.fireMissile({ weapon: 'bomb', owner: player, position: player.position, direction: v(0, 0, -1), velocity: player.velocity });
  assert.equal(m.kind, 'bomb');
  fly(world, tof + 1);
  assert.equal(dump.alive, false);
  assert.equal(tent.alive, false);
  assert.ok(log.some((e) => e.type === 'explosion' && e.size === 'huge'));
  assert.equal(log.find((e) => e.type === 'missile:end').reason, 'ground');
});

test('player death emits player:destroyed once; god mode and invulnerable targets ignore damage', () => {
  const { world, player, log } = makeWorld();
  const post = world.addTarget({ class: 'ground', team: 'neutral', position: v(0, 0, 0), health: 10, invulnerable: true });
  assert.equal(world.damage(post, 1000), false);
  assert.equal(post.alive, true);
  world.god = true;
  world.damage(player, 500);
  assert.equal(player.health, 100);
  world.god = false;
  assert.equal(world.damage(player, 500, { weapon: WEAPONS.e_sam }), true);
  world.damage(player, 500);
  assert.equal(log.filter((e) => e.type === 'player:destroyed').length, 1);
  assert.equal(log.find((e) => e.type === 'player:destroyed').cause, 'sam');
});
