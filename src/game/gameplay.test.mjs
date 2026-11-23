// Tuning-critical gameplay math: difficulty, hostile gunnery, flares, rocket
// CCIP, weather, onboarding, the unlock chain and the assist's slice/bunt rule.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Vector3 } from 'three';
import { DIFFICULTY, DIFFICULTY_LEVELS, difficultyFor, difficultyList, scaleSkill } from './difficulty.js';
import { flareChanceFor } from '../combat/CombatWorld.js';
import { WEAPONS } from '../combat/weapons.js';
import { rocketImpact } from '../combat/guidance.js';
import { AA, GROUND, aaaBurstError } from '../ai/ground.js';
import { SKILLS } from '../ai/brain.js';
import { WEATHER, TIMES, lightLevel, partOfDay, clock, conditionsLabel, fallbackPreset, resolveConditions, inCloudLayer, applyToEnvironment } from '../missions/conditions.js';
import { Onboarding, HINTS } from '../missions/onboarding.js';
import { computeScore, isUnlocked } from '../missions/scoring.js';
import { MISSIONS } from '../missions/data.js';
import { AssistController } from '../flight/AssistController.js';
import { FlightModel, TURBULENCE, gust } from '../flight/FlightModel.js';

test('difficulty: three levels, normal is the identity, easy < normal < hard on every hostile lever', () => {
  assert.deepEqual(DIFFICULTY_LEVELS, ['easy', 'normal', 'hard']);
  const { easy, normal, hard } = DIFFICULTY;
  for (const k of ['damage', 'accuracy', 'aggression', 'missile', 'score']) {
    assert.equal(normal[k], 1, k);
    assert.ok(easy[k] < 1 && hard[k] > 1, k);
  }
  assert.ok(easy.flare > 0 && normal.flare === 0 && hard.flare < 0);
  assert.ok(easy.attackers < 0 && hard.attackers > 0);
  assert.equal(difficultyFor('nonsense'), normal);
  assert.deepEqual(difficultyList().map((d) => d.id), DIFFICULTY_LEVELS);
});

test('difficulty: pilot skill scales lock, cooldown, reaction and gun error the right way', () => {
  const base = SKILLS.veteran ?? Object.values(SKILLS)[0];
  const e = scaleSkill(base, DIFFICULTY.easy), h = scaleSkill(base, DIFFICULTY.hard);
  assert.deepEqual(scaleSkill(base, DIFFICULTY.normal), base);
  assert.ok(e.lockTime > base.lockTime && h.lockTime < base.lockTime);
  assert.ok(e.mslCooldown > base.mslCooldown && h.mslCooldown < base.mslCooldown);
  assert.ok(e.gunError > base.gunError && h.gunError < base.gunError);
  assert.ok(e.reaction > base.reaction && h.reaction < base.reaction);
});

test('flares: hostile heat-seekers are decoyable but never a sure thing; radar SAMs ignore flares', () => {
  for (const id of ['e_manpads', 'e_aam', 'e_aam_ace']) {
    const n = flareChanceFor(WEAPONS[id], 'hostile', DIFFICULTY.normal);
    assert.ok(n >= 0.3 && n <= 0.6, `${id} ${n}`);
    assert.ok(flareChanceFor(WEAPONS[id], 'hostile', DIFFICULTY.easy) > n);
    assert.ok(flareChanceFor(WEAPONS[id], 'hostile', DIFFICULTY.hard) < n);
    assert.ok(flareChanceFor(WEAPONS[id], 'hostile', DIFFICULTY.hard) >= 0.05);
  }
  // The ace's missile is the hardest to decoy, the shoulder-launched the easiest.
  assert.ok(WEAPONS.e_aam_ace.flareChance < WEAPONS.e_aam.flareChance && WEAPONS.e_aam.flareChance < WEAPONS.e_manpads.flareChance);
  assert.equal(flareChanceFor(WEAPONS.e_sam, 'hostile', DIFFICULTY.easy), WEAPONS.e_sam.flareChance ?? 0);
  assert.ok(!(WEAPONS.e_sam.flareChance > 0));
  // The player's own missiles are not touched by difficulty.
  assert.equal(flareChanceFor(WEAPONS.e_aam, 'friendly', DIFFICULTY.hard), WEAPONS.e_aam.flareChance);
});

test('AAA: the first bursts are ranging shots, fire tightens to a floor, and difficulty scales it', () => {
  const e0 = aaaBurstError(0), e1 = aaaBurstError(1), e9 = aaaBurstError(9);
  assert.equal(e0, AA.aaaError);
  assert.ok(e1 < e0 && e9 < e1);
  assert.ok(Math.abs(e9 - AA.aaaError * AA.aaaRangingFloor) < 1e-9, 'never tighter than the floor');
  assert.ok(aaaBurstError(3, DIFFICULTY.hard) < aaaBurstError(3) && aaaBurstError(3, DIFFICULTY.easy) > aaaBurstError(3));
  // A warning before it hurts: the opening burst misses a jet-sized target at range.
  assert.ok(e0 * 1500 > 60, 'opening burst scatter at 1.5 km is wider than an aircraft');
});

test('air defence envelope: shoulder teams carry a few rounds, SAMs out-range and out-wait everything else', () => {
  assert.equal(GROUND.manpads.rounds, 3);
  assert.ok(GROUND.sam.range > GROUND.manpads.range && GROUND.manpads.range > GROUND.aaa.range);
  assert.ok(GROUND.sam.lockTime >= 4, 'time to hear the warning and get below the ridge');
  assert.ok(GROUND.manpads.lockTime >= 2.5);
  assert.ok(GROUND.flak.minRange > 0);
});

test('rocket CCIP: the pipper is where the rocket lands, not where the nose points', () => {
  const w = WEAPONS.rkt;
  const out = new Vector3();
  const flat = () => 0;
  const pos = new Vector3(0, 800, 0);
  const dir = new Vector3(0, -Math.sin(0.35), -Math.cos(0.35));
  const tof = rocketImpact(out, pos, dir, 230, w, flat);
  assert.ok(Number.isFinite(tof) && tof > 1 && tof < w.life);
  const bore = 800 / Math.tan(0.35); // where the nose points
  const range = -out.z;
  assert.equal(out.y, 0);
  assert.ok(range < bore && bore - range > 3, `falls short of the boresight (${range.toFixed(0)} vs ${bore.toFixed(0)})`);
  assert.ok(bore - range < 0.15 * bore, 'but not by much: rockets are fast');
  // Rising ground is hit sooner.
  const slope = (x, z) => Math.max(0, (-z - 1000) * 0.3);
  const out2 = new Vector3();
  rocketImpact(out2, pos, dir, 230, w, slope);
  assert.ok(-out2.z < range && out2.y > 0);
  // Level and high: it does not come down inside its life.
  assert.equal(rocketImpact(out, new Vector3(0, 9000, 0), new Vector3(0, 0, -1), 230, w, flat), Infinity);
});

test('conditions: clock, part of day, label and daylight', () => {
  assert.equal(clock(5.67), '0540');
  assert.equal(clock(22.67), '2240');
  assert.equal(clock(24), '0000');
  assert.equal(partOfDay(5.67), 'Dawn');
  assert.equal(partOfDay(12.5), 'Midday');
  assert.equal(partOfDay(17.6), 'Golden hour');
  assert.equal(partOfDay(19), 'Dusk');
  assert.equal(partOfDay(23), 'Night');
  assert.equal(partOfDay(2), 'Night');
  assert.equal(conditionsLabel(5.67, 'scattered'), '0540 · Dawn · Scattered cloud');
  assert.ok(lightLevel(12) === 1 && lightLevel(0) < 0.15 && lightLevel(23) < 0.15);
  assert.ok(lightLevel(5.67) > lightLevel(5) && lightLevel(5.67) < 1);
  assert.ok(lightLevel(19.4) < lightLevel(18.9), 'dusk darkens');
  for (const t of TIMES) assert.ok(t.time >= 0 && t.time < 24 && t.label);
});

test('conditions: what gameplay reads (visibility, turbulence, cloud layer, IR loss)', () => {
  const day = resolveConditions({ time: 12, weather: 'clear' });
  const night = resolveConditions({ time: 23, weather: 'clear' });
  const storm = resolveConditions({ time: 16.2, weather: 'storm' });
  assert.equal(day.visibility, 1);
  assert.ok(!day.night && night.night);
  assert.ok(night.visibility > 0.45 && night.visibility < 0.6, 'optical gunners see about half as far at night');
  assert.ok(storm.visibility < 0.6 && storm.turbulence === 1 && storm.lightning === true);
  assert.equal(day.cloud, null);
  assert.equal(day.irLoss, 0);
  assert.ok(storm.irLoss > 0 && storm.cloud.top > storm.cloud.base);
  assert.equal(inCloudLayer(storm, 6500), true);
  assert.equal(inCloudLayer(storm, 5000), false);
  assert.equal(inCloudLayer(day, 6500), false);
  // Garbage in: a sane default, not a crash.
  const d = resolveConditions({ time: NaN, weather: 'frogs' });
  assert.equal(d.weather, 'scattered');
  assert.equal(d.time, 10);
  // Every weather has a label and sane numbers.
  for (const [id, w] of Object.entries(WEATHER)) assert.ok(w.label && w.visibility > 0.4 && w.visibility <= 1 && w.turbulence >= 0 && w.turbulence <= 1, id);
});

test('conditions: every mission states its hour and weather; the campaign covers dawn, day, dusk, night and storm', () => {
  const parts = new Set(), weathers = new Set();
  for (const m of MISSIONS) {
    assert.ok(Number.isFinite(m.conditions?.time) && WEATHER[m.conditions.weather], `${m.id} conditions`);
    parts.add(partOfDay(m.conditions.time));
    weathers.add(m.conditions.weather);
  }
  for (const p of ['Dawn', 'Midday', 'Golden hour', 'Dusk', 'Night']) assert.ok(parts.has(p), p);
  for (const w of ['scattered', 'cumulus', 'overcast', 'storm', 'clear']) assert.ok(weathers.has(w), w);
  assert.equal(MISSIONS.find((m) => m.free).conditions.choose, true);
  // The dusk strike runs into the night.
  const m4 = MISSIONS.find((m) => m.id === 'm4');
  assert.ok(m4.conditions.advance > 0);
  assert.ok(lightLevel(m4.conditions.time + (m4.conditions.advance * m4.parTime) / 60) < 0.5);
});

test('conditions: environment adapter uses the day/night API when present and falls back to presets', () => {
  const c = resolveConditions({ time: 22.67, weather: 'clear' });
  const calls = [];
  const modern = { setTimeOfDay: (h) => calls.push(['tod', h]), weather: { set: (s) => calls.push(['weather', s.type]) }, setPreset: () => calls.push(['preset']) };
  assert.equal(applyToEnvironment(modern, c), 'timeOfDay');
  // the clock sets the sun, then the weather's cloud/haze look (sun untouched), then precipitation
  assert.deepEqual(calls, [['tod', 22.67], ['preset'], ['weather', 'clear']]);
  const old = { setPreset: (name) => calls.push(['preset', name]) };
  calls.length = 0;
  assert.equal(applyToEnvironment(old, resolveConditions({ time: 16, weather: 'storm' })), 'preset');
  assert.deepEqual(calls, [['preset', 'storm']]);
  assert.equal(fallbackPreset(5.67, 'scattered'), 'morning');
  assert.equal(fallbackPreset(12.5, 'cumulus'), 'noon');
  assert.equal(fallbackPreset(17.6, 'overcast'), 'overcast');
  assert.equal(applyToEnvironment(null, c), 'none');
  assert.equal(applyToEnvironment({ setTimeOfDay() { throw new Error('no'); } }, c), 'preset', 'never throws');
});

test('turbulence: gusts are bounded, zero-mean and small next to the pilot', () => {
  let sp = 0, sr = 0, mp = 0, mr = 0;
  const g = { pitch: 0, roll: 0 };
  for (let i = 0; i < 6000; i++) { gust(i / 60, g); sp += g.pitch; sr += g.roll; mp = Math.max(mp, Math.abs(g.pitch)); mr = Math.max(mr, Math.abs(g.roll)); }
  assert.ok(mp <= 1 && mr <= 1);
  assert.ok(Math.abs(sp / 6000) < 0.05 && Math.abs(sr / 6000) < 0.05);
  assert.ok(TURBULENCE.roll < 0.5 && TURBULENCE.pitch < 0.15, 'a storm shakes the aircraft, it does not fly it');
  // In flight: a full storm moves a hands-off jet, but only by a few degrees.
  const fly = (turb) => {
    const f = new FlightModel();
    f.reset(new Vector3(0, 9000, 0), 0, 250);
    f.turbulence = turb;
    const a = new AssistController();
    let maxBank = 0;
    for (let t = 0; t < 20; t += 1 / 60) {
      f.update(1 / 60, a.update(1 / 60, { turn: 0, climb: 0, throttle: 0.8, brake: 0 }, f, { sensitivity: 'combat', autoThrottle: false }));
      maxBank = Math.max(maxBank, Math.abs(Math.atan2(f.right.y, f.up.y)));
    }
    return { maxBank, y: f.position.y };
  };
  const calm = fly(0), rough = fly(1);
  assert.ok(calm.maxBank < 0.01);
  assert.ok(rough.maxBank > 0.01 && rough.maxBank < 0.35, `storm bank excursion ${rough.maxBank.toFixed(3)} rad`);
  assert.ok(Math.abs(rough.y - 9000) < 250, 'holds altitude through it');
});

test('assist: half stick + push from a climb comes down (the old law parked at 61 degrees of bank, climbing)', () => {
  const f = new FlightModel();
  f.reset(new Vector3(0, 9000, 0), 0, 250);
  const a = new AssistController();
  const opts = { sensitivity: 'combat', autoThrottle: false };
  const run = (intent, s) => { for (let t = 0; t < s; t += 1 / 120) f.update(1 / 120, a.update(1 / 120, { throttle: 0.9, brake: 0, ...intent }, f, opts)); };
  run({ turn: 0, climb: 1 }, 2.2);
  assert.ok(f.velocity.y / f.velocity.length() > 0.3, 'set-up: a steep climb');
  run({ turn: -0.5, climb: -1 }, 6);
  assert.ok(f.velocity.y < -10, `descending after 6 s (vy ${f.velocity.y.toFixed(0)})`);
  // And a full-stick descending turn still rolls past ninety and pulls (a slice).
  const h0 = Math.atan2(f.forward.x, -f.forward.z);
  run({ turn: 1, climb: -0.5 }, 3);
  const dh = Math.abs(Math.atan2(Math.sin(Math.atan2(f.forward.x, -f.forward.z) - h0), Math.cos(Math.atan2(f.forward.x, -f.forward.z) - h0)));
  assert.ok(dh > 0.6, `turned ${(dh * 57.3).toFixed(0)} degrees in 3 s`);
});

test('onboarding: prompts once, in context, skips what the player already did, and remembers', () => {
  const mem = new Map();
  const storage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
  const label = (a) => ({ flares: 'X', fireMissile: 'Space', fireGun: 'F', special: 'Q', brake: 'S', camera: 'C', throttleUp: 'W', nextTarget: 'T' }[a] ?? a);
  const ob = new Onboarding({ storage });
  assert.equal(ob.enabled, true);
  assert.equal(ob.update({ time: 1, threats: 0, lockState: 'none' }, label), null, 'nothing to say yet');
  const fire = ob.update({ time: 5, threats: 0, lockState: 'locked', lockable: true }, label);
  assert.equal(fire?.id, 'fire');
  assert.ok(fire.text.includes('Space') && fire.keys[0] === 'Space');
  assert.equal(ob.update({ time: 6, threats: 0, lockState: 'locked', lockable: true }, label), null, 'not twice, and not two in a row');
  // A missile warning jumps the gap between prompts.
  const fl = ob.update({ time: 6.5, threats: 1, lockState: 'none' }, label);
  assert.equal(fl?.id, 'flares');
  assert.equal(fl.urgent, true);
  // What the player did unprompted is never taught.
  const ob2 = new Onboarding({ storage: { getItem: () => null, setItem() {} } });
  ob2.learn('flares');
  assert.equal(ob2.update({ time: 1, threats: 1, lockState: 'none' }, label), null);
  // Remembered across sessions; a veteran is taught nothing.
  const again = new Onboarding({ storage });
  assert.equal(again.update({ time: 50, threats: 1, lockState: 'locked', lockable: true }, label)?.id !== 'fire', true);
  assert.equal(new Onboarding({ veteran: true, storage: { getItem: () => null, setItem() {} } }).enabled, false);
  assert.ok(HINTS.length >= 5 && HINTS.every((h) => h.id && typeof h.when === 'function' && typeof h.text === 'function'));
});

test('score: difficulty scales the total only when the sortie was completed', () => {
  const base = { targetScore: 4000, bonuses: 1000, completed: true, time: 300, parTime: 300, timeLimit: 900, accuracy: 0.5, health: 1 };
  const n = computeScore(base), h = computeScore({ ...base, difficultyScale: 1.2 }), e = computeScore({ ...base, difficultyScale: 0.85 });
  assert.equal(n.breakdown.difficulty, 0);
  assert.ok(h.total > n.total && e.total < n.total);
  assert.equal(h.total, n.total + h.breakdown.difficulty);
});

test('unlock chain: in order; a save from before sorties were inserted keeps what it had', () => {
  const list = MISSIONS;
  const idx = (id) => list.findIndex((m) => m.id === id);
  const fresh = { missions: {} };
  assert.equal(isUnlocked(list, 0, fresh), true);
  assert.equal(isUnlocked(list, idx('m2'), fresh), false);
  assert.equal(isUnlocked(list, idx('free'), fresh), true);
  const old = { missions: { m1: { completed: true }, m2: { completed: true }, m3: { completed: true } } };
  assert.equal(isUnlocked(list, idx('night'), old), true);
  assert.equal(isUnlocked(list, idx('m3'), old), true, 'already flown stays open');
  assert.equal(isUnlocked(list, idx('storm'), old), true);
  assert.equal(isUnlocked(list, idx('m4'), old), false, 'storm is new and comes first');
});
