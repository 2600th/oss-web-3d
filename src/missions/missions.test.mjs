import test from 'node:test';
import assert from 'node:assert/strict';
import { Vector3 } from 'three';
import { MissionRunner, testCondition } from './runner.js';
import { accuracy, computeScore, rankFor, recordResult, loadProgress, saveProgress, isUnlocked } from './scoring.js';
import { Radio, lineDuration } from './radio.js';
import { Recon, photoQuality, OPTIC } from './recon.js';
import { MISSIONS, missionById } from './data.js';
import { CAST, ACES, CHATTER } from './cast.js';
import { WEAPONS, SPECIALS } from '../combat/weapons.js';
import { GROUND } from '../ai/ground.js';

// ---- runner -----------------------------------------------------------------

const mission = {
  id: 't', timeLimit: 100,
  groups: { guns: { kind: 'ground', type: 'aaa' }, wave: { kind: 'fighters', count: 2 } },
  phases: [
    { id: 'a', objective: { text: 'Kill the guns', track: { destroyed: 'guns' } },
      enter: [{ spawn: 'guns' }, { radio: ['control', 'go', 1] }, { music: { state: 'combat', level: 0.6 } }],
      triggers: [{ when: { time: 5 }, do: [{ radio: ['fac', 'hurry', 2] }] }, { when: { destroyed: 'guns', count: 1 }, do: [{ flag: 'half' }, { bonus: { label: 'first', score: 100 } }] }],
      done: { destroyed: 'guns' }, exit: [{ radio: ['fac', 'clear', 1] }] },
    { id: 'b', objective: { text: 'Intercept', track: { destroyed: 'wave' } }, enter: [{ spawn: 'wave' }], failWhen: { time: 30 }, failReason: 'overrun',
      done: { all: [{ destroyed: 'wave' }, { zone: { x: 0, z: 0, r: 100 } }] } },
  ],
};

function run(m = mission) {
  const log = [];
  const r = new MissionRunner(m, {
    spawn: (def) => { log.push(`spawn:${def.id}`); return def.id === 'guns' ? [{ tags: ['guns'] }, { tags: ['guns'] }] : [{ tags: ['wave'] }, { tags: ['wave'] }]; },
    radio: (s, t, p) => log.push(`radio:${s}:${t}:${p}`),
    music: (mu) => log.push(`music:${mu.state}`),
    bonus: (b) => log.push(`bonus:${b.score}`),
    phase: (p) => log.push(`phase:${p.id}`),
    end: (s, why) => log.push(`end:${s}:${why}`),
  });
  r.start();
  return { r, log };
}

test('runner: phases, triggers fire once, objective progress, completion', () => {
  const { r, log } = run();
  assert.deepEqual(log, ['phase:a', 'spawn:guns', 'radio:control:go:1', 'music:combat']);
  assert.deepEqual(r.objective(), { text: 'Kill the guns', progress: 0, total: 2, marker: null });
  for (let i = 0; i < 12; i++) r.update(0.5);
  assert.equal(log.filter((l) => l === 'radio:fac:hurry:2').length, 1, 'time trigger fires exactly once');
  r.notifyDestroyed(['guns']);
  r.update(0.1);
  assert.ok(r.flags.half && log.includes('bonus:100'));
  assert.equal(r.objective().progress, 1);
  r.notifyDestroyed(['guns']);
  r.update(0.1);
  assert.equal(r.phase.id, 'b');
  assert.ok(log.includes('radio:fac:clear:1') && log.includes('spawn:wave'));
  assert.ok(r.phaseTime < 0.2, 'phase clock restarts');
  r.notifyDestroyed(['wave']); r.notifyDestroyed(['wave']);
  r.update(0.1, { player: { x: 5000, y: 0, z: 0 } });
  assert.equal(r.state, 'running', 'still needs the zone');
  r.update(0.1, { player: { x: 10, y: 0, z: 10 } });
  assert.equal(r.state, 'complete');
  assert.ok(log.includes('end:complete:null'));
  r.update(1000);
  assert.equal(r.state, 'complete', 'nothing happens after the end');
});

test('runner: fails on the time limit, on a phase failWhen, and on fail()', () => {
  let { r, log } = run();
  for (let i = 0; i < 101; i++) r.update(1);
  assert.equal(r.state, 'failed'); assert.equal(r.reason, 'time');
  assert.ok(log.includes('end:failed:time'));
  ({ r } = run());
  r.notifyDestroyed(['guns']); r.notifyDestroyed(['guns']);
  r.update(0.1);
  for (let i = 0; i < 31; i++) r.update(1);
  assert.equal(r.reason, 'overrun');
  ({ r } = run());
  r.fail('shot_down');
  assert.equal(r.state, 'failed');
  r.fail('other');
  assert.equal(r.reason, 'shot_down');
});

test('conditions: remaining, arrived, captured, flags, any/not, and nothing-spawned is never "all destroyed"', () => {
  const tags = { a: { total: 3, destroyed: 2, arrived: 1 } };
  const v = {
    time: 50, phaseTime: 10, captured: 2, health: 0.4, flags: { x: true }, player: { x: 0, y: 0, z: 0 },
    total: (t) => tags[t]?.total ?? 0, destroyed: (t) => tags[t]?.destroyed ?? 0,
    alive: (t) => (tags[t] ? tags[t].total - tags[t].destroyed : 0), arrived: (t) => tags[t]?.arrived ?? 0,
  };
  assert.equal(testCondition({ destroyed: 'a' }, v), false);
  assert.equal(testCondition({ destroyed: 'a', count: 2 }, v), true);
  assert.equal(testCondition({ destroyed: 'none' }, v), false);
  assert.equal(testCondition({ remaining: 'a', lte: 1 }, v), true);
  assert.equal(testCondition({ remaining: 'none' }, v), false);
  assert.equal(testCondition({ arrived: 'a' }, v), true);
  assert.equal(testCondition({ captured: 3 }, v), false);
  assert.equal(testCondition({ healthBelow: 0.5, flag: 'x', missionTime: 40 }, v), true);
  assert.equal(testCondition({ any: [{ captured: 9 }, { time: 5 }] }, v), true);
  assert.equal(testCondition({ not: { flag: 'x' } }, v), false);
  assert.equal(testCondition(null, v), false);
});

// ---- campaign data ----------------------------------------------------------

test('campaign: six missions and free flight, all references resolve', () => {
  assert.deepEqual(MISSIONS.map((m) => m.id), ['m1', 'm2', 'night', 'm3', 'storm', 'm4', 'free']);
  const collect = (c, out) => {
    if (!c || typeof c !== 'object') return out;
    for (const k of ['destroyed', 'remaining', 'arrived']) if (c[k]) out.add(c[k]);
    for (const k of ['all', 'any']) for (const x of c[k] ?? []) collect(x, out);
    collect(c.not, out);
    return out;
  };
  for (const m of MISSIONS) {
    assert.ok(m.name && m.briefing.length >= 2 && m.start && m.phases.length >= 1, m.id);
    assert.ok(m.specials.includes(m.special) && m.specials.every((s) => SPECIALS.includes(s)), `${m.id} specials`);
    if (!m.free) assert.ok(m.rank.S > m.rank.A && m.rank.A > m.rank.B && m.rank.B > m.rank.C && m.parTime < m.timeLimit, `${m.id} ranks`);
    const tags = new Set();
    for (const [id, g] of Object.entries(m.groups)) {
      tags.add(id);
      for (const t of g.tags ?? []) tags.add(t);
      for (const u of g.units ?? []) { assert.ok(GROUND[u.type], `${m.id}/${id}: unit ${u.type}`); for (const t of u.tags ?? []) tags.add(t); }
      if (g.kind === 'ground') assert.ok(GROUND[g.type]);
    }
    const spawned = new Set();
    for (const p of m.phases) {
      const actions = [...(p.enter ?? []), ...(p.exit ?? []), ...(p.triggers ?? []).flatMap((t) => t.do)];
      for (const a of actions) {
        if (a.spawn) { assert.ok(m.groups[a.spawn], `${m.id}/${p.id}: spawn ${a.spawn}`); spawned.add(a.spawn); }
        if (a.radio) assert.ok(CAST[a.radio[0]], `${m.id}/${p.id}: speaker ${a.radio[0]}`);
        if (a.goto) assert.ok(m.phases.some((x) => x.id === a.goto));
      }
      const used = collect(p.done, new Set());
      for (const t of p.triggers ?? []) collect(t.when, used);
      collect(p.objective?.track, used);
      for (const t of used) assert.ok(tags.has(t), `${m.id}/${p.id}: tag ${t} is never spawned`);
    }
    assert.deepEqual([...spawned].sort(), Object.keys(m.groups).sort(), `${m.id}: every group is spawned by some phase`);
  }
  assert.equal(missionById('m4').groups.irbisA.aces.length + missionById('m4').groups.irbisB.aces.length, 4);
  assert.equal(missionById('nope'), null);
});

test('tone: no real nation, army or person is named anywhere in the script', () => {
  const text = JSON.stringify([MISSIONS, CAST, ACES, CHATTER]).toLowerCase();
  for (const word of ['pakistan', 'india', 'indian', 'china', 'nli', 'f-16', 'kashmir', 'enemy scum', 'die']) {
    assert.ok(!new RegExp(`\\b${word}\\b`).test(text), `script must not contain "${word}"`);
  }
  for (const ace of Object.values(ACES)) for (const k of ['engage', 'fire', 'hit', 'down', 'kill']) assert.ok(ace.lines[k].length > 0, `${ace.id}.${k}`);
});

// ---- scoring ----------------------------------------------------------------

test('accuracy weighs missiles over gun rounds and ignores unused weapons', () => {
  assert.equal(accuracy({}), 0);
  assert.equal(accuracy({ mslFired: 10, mslHits: 5 }), 0.5);
  assert.equal(accuracy({ gunFired: 100, gunHits: 25 }), 1);
  assert.ok(Math.abs(accuracy({ mslFired: 10, mslHits: 10, gunFired: 100, gunHits: 0 }) - 0.7) < 1e-9);
});

test('score: bonuses only on completion, time bonus falls from par to the limit', () => {
  const base = { targetScore: 4000, bonuses: 1000, parTime: 300, timeLimit: 900, accuracy: 0.5, health: 0.8, damageTaken: 20 };
  const failed = computeScore({ ...base, completed: false, time: 200 });
  assert.equal(failed.total, 5000);
  const fast = computeScore({ ...base, completed: true, time: 250 });
  assert.deepEqual(fast.breakdown, { targets: 4000, bonuses: 1000, time: 3000, accuracy: 750, survival: 1200, difficulty: 0 });
  assert.equal(computeScore({ ...base, completed: true, time: 600 }).breakdown.time, 1500);
  assert.equal(computeScore({ ...base, completed: true, time: 900 }).breakdown.time, 0);
  assert.equal(computeScore({ ...base, completed: true, time: 250, health: 1, damageTaken: 0 }).breakdown.survival, 2000);
});

test('rank thresholds S/A/B/C/D, no rank on failure', () => {
  const th = { S: 10000, A: 8000, B: 6000, C: 4000 };
  assert.deepEqual([10000, 9999, 7000, 4000, 10].map((s) => rankFor(s, th)), ['S', 'A', 'B', 'C', 'D']);
  assert.equal(rankFor(99999, th, false), null);
});

test('progress: best results kept, unlock chain, storage round-trip and corruption', () => {
  const mem = new Map();
  const storage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
  let p = loadProgress(storage);
  assert.deepEqual(p, { missions: {} });
  const list = [{ id: 'm1' }, { id: 'm2' }, { id: 'free', free: true }];
  assert.deepEqual(list.map((_, i) => isUnlocked(list, i, p)), [true, false, true]);
  recordResult(p, 'm1', { completed: false, score: 500, rank: null, time: 90 });
  assert.equal(isUnlocked(list, 1, p), false);
  assert.equal(recordResult(p, 'm1', { completed: true, score: 7000, rank: 'B', time: 400 }).newBest, true);
  assert.equal(recordResult(p, 'm1', { completed: true, score: 6000, rank: 'A', time: 350 }).newBest, false);
  assert.deepEqual(p.missions.m1, { completed: true, bestScore: 7000, bestRank: 'A', bestTime: 350, attempts: 3 });
  assert.equal(isUnlocked(list, 1, p), true);
  saveProgress(p, storage);
  assert.deepEqual(loadProgress(storage), p);
  mem.set('safedsagar.v2.progress', '{broken');
  assert.deepEqual(loadProgress(storage), { missions: {} });
  assert.deepEqual(loadProgress(null), { missions: {} });
});

// ---- radio ------------------------------------------------------------------

test('radio: one line at a time, urgent calls jump the queue, chatter is dropped when busy', () => {
  const out = [];
  const radio = new Radio({ emit: (t, p) => out.push(p) }, CAST);
  radio.say('control', 'first line of normal priority', 1);
  radio.say('fac', 'second', 1);
  assert.equal(radio.say('wing', 'chatter', 0), false, 'net is busy: chatter is dropped');
  radio.update(0.1);
  assert.equal(out.length, 1);
  assert.equal(out[0].callsign, 'SHIKHAR');
  assert.ok(out[0].duration === lineDuration('first line of normal priority'));
  radio.update(1.0);
  radio.say('wing', 'MISSILE', 2);
  assert.equal(radio.current, null, 'an urgent call cuts a routine line');
  radio.update(0.5);
  assert.equal(out[1].text, 'MISSILE');
  for (let i = 0; i < 100; i++) radio.update(0.2);
  assert.deepEqual(out.map((l) => l.text), ['first line of normal priority', 'MISSILE', 'second']);
  assert.equal(radio.say('wing', 'idle chatter', 0), true, 'quiet net: chatter goes out');
  for (let i = 0; i < 30; i++) radio.update(0.2);
  radio.say('ace', 'x', 1, { callsign: 'IRBIS 1 "MONSOON"' });
  radio.update(1);
  assert.equal(out.at(-1).callsign, 'IRBIS 1 "MONSOON"');
});

// ---- recon ------------------------------------------------------------------

test('photo quality: needs line of sight, range and framing', () => {
  assert.equal(photoQuality({ range: 2000, offAxis: 0, los: false }), 0);
  assert.equal(photoQuality({ range: 6000, offAxis: 0, los: true }), 0);
  assert.equal(photoQuality({ range: 2000, offAxis: OPTIC.halfFov * 1.1, los: true }), 0);
  assert.equal(photoQuality({ range: 2000, offAxis: 0, los: true }), 1);
  assert.ok(photoQuality({ range: 4300, offAxis: 0, los: true }) < 0.6);
  assert.ok(photoQuality({ range: 2000, offAxis: OPTIC.halfFov * 0.9, los: true }) < OPTIC.threshold + 0.05);
});

test('recon: a post must be held in the optic; captured once; nothing without the optic', () => {
  const post = { position: new Vector3(0, 4000, -2500) };
  const recon = new Recon([post, { position: new Vector3(40000, 4000, 0) }]);
  // Level flight 480 m above: the post sits ~11 degrees below the nose, on the optic axis.
  const flight = { position: new Vector3(0, 4480, 0), forward: new Vector3(0, 0, -1), up: new Vector3(0, 1, 0) };
  const los = () => true;
  for (let i = 0; i < 60; i++) assert.equal(recon.update(1 / 30, flight, false, los), null);
  let shot = null, frames = 0;
  while (!shot && frames < 60) { shot = recon.update(1 / 30, flight, true, los); frames++; }
  assert.equal(shot.entity, post);
  assert.ok(frames >= OPTIC.holdTime * 30 - 1, 'held, not instant');
  assert.ok(shot.best > 0.8);
  assert.equal(recon.captured, 1);
  for (let i = 0; i < 60; i++) assert.equal(recon.update(1 / 30, flight, true, los), null, 'not captured twice');
  // The manual shutter takes a usable frame immediately; a blocked view takes nothing.
  const r2 = new Recon([post]);
  assert.equal(r2.update(1 / 30, flight, true, () => false, true), null);
  assert.equal(r2.update(1 / 30, flight, true, los, true).entity, post);
});

test('weapon table: every mission special is a distinct, armed weapon', () => {
  const types = new Set(SPECIALS.map((id) => `${WEAPONS[id].type}:${WEAPONS[id].guidance ?? ''}:${WEAPONS[id].lockCone ?? 0}`));
  assert.equal(types.size, SPECIALS.length, 'distinct roles');
  for (const id of ['msl', ...SPECIALS]) assert.ok(WEAPONS[id].ammo > 0 && WEAPONS[id].name && WEAPONS[id].reload > 0, id);
  assert.ok(WEAPONS.hobs.lockCone > WEAPONS.msl.lockCone * 2 && WEAPONS.lraam.lockRange > WEAPONS.msl.lockRange * 2);
  assert.equal(WEAPONS.lraam.flareChance, 0);
});
