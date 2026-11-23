import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  rect, overlap, labelTier, mustLabel, sortForLabels, leaderSlots, placeLabels, foldMarkers, easeAlpha, LEADER_DIRS,
} from './declutter.js';
import { Rumbler, RUMBLE, damageRumble, blastRumble, GUN_PERIOD } from './rumble.js';
import { Callouts } from './radio.js';
import { hitSeverity } from '../camera/cameraMath.js';
import { missileUrgency } from '../audio/physics.js';
import { riseParams } from '../audio/Warnings.js';
import { Input } from '../core/Input.js';

// ------------------------------------------------------------ declutter --

test('labels: rank tiers put the lock, then shooters, then the selected target first', () => {
  const lock = { isLock: true, dist: 3000 };
  const firing = { firing: true, dist: 2500 };
  const sel = { selected: true, dist: 500 };
  const lead = { isAce: true, dist: 400 };
  const tgt = { isTarget: true, dist: 300 };
  const near = { dist: 100 };
  const list = [near, tgt, lead, sel, firing, lock].map((o) => ({ ...o, tier: labelTier(o), ref: o }));
  sortForLabels(list);
  assert.deepEqual(list.map((o) => o.ref), [lock, firing, sel, lead, tgt, near]);
  assert.ok(mustLabel(lock) && mustLabel(firing) && mustLabel(sel));
  assert.ok(!mustLabel(lead) && !mustLabel(tgt) && !mustLabel(near));
});

test('labels: a label that was up last frame keeps its place over a slightly nearer equal', () => {
  const a = { tier: 1, dist: 1000, had: true, id: 'a' };
  const b = { tier: 1, dist: 950, had: false, id: 'b' };
  assert.equal(sortForLabels([b, a])[0].id, 'a', 'hysteresis: 5% nearer does not steal the label');
  const c = { tier: 1, dist: 700, had: false, id: 'c' };
  assert.equal(sortForLabels([a, c])[0].id, 'c', 'but a clearly nearer one does');
});

test('labels: leader slots sit clear of the marker in eight directions at each reach', () => {
  const m = 12;
  const slots = leaderSlots(500, 300, m, 60, 26, [16, 40]);
  assert.equal(slots.length, LEADER_DIRS.length * 2);
  const marker = rect(500 - m, 300 - m, 500 + m, 300 + m);
  for (const sl of slots) {
    assert.equal(overlap(sl.box, marker), 0, 'never over its own marker');
    // the leader runs from the marker edge out to the box
    assert.ok(Math.hypot(sl.ax - 500, sl.ay - 300) >= m * 0.99);
    assert.ok(sl.lx >= sl.box.x0 - 1e-9 && sl.lx <= sl.box.x1 + 1e-9 && sl.ly >= sl.box.y0 - 1e-9 && sl.ly <= sl.box.y1 + 1e-9);
  }
  const up = slots[0];
  assert.ok(up.box.y1 <= 300 - m - 16 + 1e-9 && up.align === 'center');
  assert.ok(slots[3].box.x0 >= 500 + m + 16 - 1e-9 && slots[3].align === 'left', 'right slot aligns left');
});

/** A row of five markers 40 px apart (a convoy at range), each with one stacked label slot that collides with the neighbours'. */
function convoy(n = 5, gap = 40) {
  const items = [];
  for (let i = 0; i < n; i++) {
    const x = 300 + i * gap;
    // slot 0: wide name above (collides with neighbours), slot 1: a leader box above at a per-item height
    const s0 = [rect(x - 30, 270, x + 30, 285)];
    const s1 = [rect(x - 18, 200 - i * 22, x + 18, 215 - i * 22)];
    items.push({ x, cands: [s0, s1], self: rect(x - 10, 290, x + 10, 310) });
  }
  return items;
}

test('labels: a convoy gets the lock and the budget, nothing overlaps, the rest drop', () => {
  const items = convoy();
  items[2].must = true; // the lock is in the middle
  const order = [items[2], items[0], items[1], items[3], items[4]];
  const obstacles = items.map((i) => i.self);
  const picks = placeLabels(order, obstacles, null, { budget: 2 });
  assert.ok(picks[0] >= 0, 'the lock always places');
  const placed = order.filter((_, k) => picks[k] >= 0);
  assert.equal(placed.length, 3, 'lock + a budget of two');
  const boxes = order.flatMap((it, k) => (picks[k] >= 0 ? it.cands[picks[k]] : []));
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) assert.equal(overlap(boxes[i], boxes[j]), 0, 'no two labels overlap');
});

test('labels: a must label takes the least-bad slot when nothing is clear; others drop', () => {
  const wall = rect(0, 0, 1000, 1000);
  const it = (must) => ({ must, cands: [[rect(10, 10, 50, 20)], [rect(60, 10, 80, 20)]] });
  const obstacles = [wall];
  const picks = placeLabels([it(true), it(false)], obstacles, null, { budget: 5 });
  assert.equal(picks[0], 1, 'smaller overlap wins');
  assert.equal(picks[1], -1, 'an ordinary label with no clear slot is dropped');
});

test('labels: last frame\'s slot is kept while it is still clear (no flip-flopping)', () => {
  const it = { must: false, prev: 1, cands: [[rect(0, 0, 10, 10)], [rect(20, 0, 30, 10)]] };
  assert.deepEqual(placeLabels([it], [], null), [1]);
  const blocked = { ...it, cands: it.cands };
  assert.deepEqual(placeLabels([blocked], [rect(19, 0, 31, 10)], null), [0], 'falls back when it is not');
});

test('labels: own marker rect does not block its own label', () => {
  const self = rect(0, 0, 20, 20);
  const it = { must: false, self, cands: [[rect(5, 5, 15, 15)]] };
  assert.deepEqual(placeLabels([it], [self], null), [0]);
  assert.deepEqual(placeLabels([{ ...it, self: null }], [self], null), [-1]);
});

test('markers: the lock, the selected target and shooters never fold or host; hits pass to the host', () => {
  const lock = { x: 100, y: 100, keep: true, id: 'lock' };
  const shooter = { x: 110, y: 104, keep: true, id: 'shooter' };
  const a = { x: 112, y: 98, id: 'a' };
  const b = { x: 118, y: 100, id: 'b', hit: 0.05 };
  const far = { x: 400, y: 100, id: 'far' };
  const shown = foldMarkers([lock, shooter, a, b, far], 30);
  assert.deepEqual(shown.map((o) => o.id), ['lock', 'shooter', 'a', 'far']);
  assert.equal(lock.extra, 0, 'nothing hides under the lock reticle');
  assert.equal(shooter.extra, 0);
  assert.equal(a.extra, 1);
  assert.equal(a.hit, 0.05, 'a hit on a folded marker ticks its host');
});

test('labels: opacity eases in fast and out slower, frame-rate independent', () => {
  let a = 0;
  for (let i = 0; i < 6; i++) a = easeAlpha(a, 1, 1 / 60);
  let b = 0;
  for (let i = 0; i < 24; i++) b = easeAlpha(b, 1, 1 / 240);
  assert.ok(Math.abs(a - b) < 1e-9);
  assert.ok(a > 0.5 && a < 1, `0.1 s in: ${a}`);
  assert.ok(easeAlpha(1, 0, 0.1) > easeAlpha(0, 1, 0.1) - 1 + 0.01, 'fades down slower than up');
});

// ---------------------------------------------------------------- damage --

test('hit severity: a stray round is light, a missile is full, old payloads still work', () => {
  const bullet = hitSeverity({ damage: 3.5, fraction: 0.035 });
  const missile = hitSeverity({ damage: 30, fraction: 0.3 });
  assert.ok(bullet > 0.3 && bullet < 0.45, `bullet ${bullet}`);
  assert.equal(missile, 1);
  assert.equal(hitSeverity({ severity: 0.6 }), 0.6, 'combat\'s own value wins');
  assert.ok(Math.abs(hitSeverity({ damage: 3.5 }) - bullet) < 1e-9, 'hit points of a 100-point jet');
  assert.ok(hitSeverity({ damage: 9 }) < hitSeverity({ damage: 16 }), 'monotonic');
});

// ---------------------------------------------------------------- rumble --

test('rumble: patterns stay in range and scale with severity and distance', () => {
  for (const p of Object.values(RUMBLE)) {
    assert.ok(p.strong >= 0 && p.strong <= 1 && p.weak >= 0 && p.weak <= 1 && p.ms > 0 && p.ms <= 1000);
  }
  const light = damageRumble(0.37);
  const heavy = damageRumble(1);
  assert.ok(heavy.strong > light.strong && heavy.ms > light.ms);
  assert.equal(blastRumble(5000, 'large'), null, 'far blasts do not rumble');
  const near = blastRumble(50, 'large');
  const mid = blastRumble(400, 'large');
  assert.ok(near.strong > mid.strong);
  assert.ok(RUMBLE.gun.strong < 0.1, 'the gun buzzes, it does not thump');
});

test('rumble: off switch, no weaker effect cutting a stronger one short, gun re-arms', () => {
  let t = 0;
  const log = [];
  let on = true;
  const r = new Rumbler({ play: (s, w, ms) => { log.push([s, w, ms]); return true; }, enabled: () => on, now: () => t });
  assert.ok(r.pulse(RUMBLE.kill));
  t = 50;
  assert.equal(r.pulse(RUMBLE.hit), false, 'a hit tick does not cut the kill thump');
  t = 210;
  assert.ok(r.pulse(RUMBLE.hit), 'after it ends it plays');
  assert.equal(r.pulse(RUMBLE.hit), false, 'a second equal pulse in the same frame is folded into it');
  t = 255;
  assert.ok(r.pulse(RUMBLE.hit), 'and re-arms after the minimum gap');
  assert.ok(r.pulse(RUMBLE.kill), 'a stronger one always plays');
  // gun: re-arms every GUN_PERIOD while held
  log.length = 0;
  t = 1000;
  for (let i = 0; i < 10; i++, t += GUN_PERIOD / 3) r.update(true);
  assert.ok(log.length >= 3 && log.length <= 4, `gun pulses ${log.length}`);
  r.update(false);
  // off switch
  on = false;
  t = 5000;
  assert.equal(r.pulse(RUMBLE.destroyed), false);
});

test('rumble: Input drives the pad actuator (dual-rumble) and tolerates pads without one', () => {
  const target = { addEventListener() {}, removeEventListener() {} };
  const input = new Input(target);
  const calls = [];
  input._pad = { vibrationActuator: { playEffect: (type, p) => { calls.push([type, p]); return Promise.resolve('complete'); }, reset: () => Promise.resolve() } };
  assert.equal(input.rumble(1.4, 0.3, 120), true);
  assert.equal(calls[0][0], 'dual-rumble');
  assert.equal(calls[0][1].strongMagnitude, 1, 'clamped');
  assert.equal(calls[0][1].weakMagnitude, 0.3);
  assert.equal(calls[0][1].duration, 120);
  input._pad = { };
  assert.equal(input.rumble(0.5, 0.5, 100), false);
  input.stopRumble();
});

// ---------------------------------------------------------------- audio --

test('audio: missile alert urgency rises as time to impact falls', () => {
  assert.equal(missileUrgency([]), 0);
  const far = missileUrgency([{ distance: 4000, missile: { speed: 600 } }]);
  const near = missileUrgency([{ distance: 900, missile: { speed: 600 } }]);
  assert.ok(far < near, `${far} < ${near}`);
  assert.equal(missileUrgency([{ distance: 300, missile: { speed: 600 } }]), 1);
  assert.equal(missileUrgency([{ distance: 9000, missile: { speed: 600 } }]), 0);
  assert.equal(missileUrgency([{ distance: 4000, missile: { speed: 600 } }, { distance: 600, missile: { speed: 600 } }]), 1, 'the closest one sets it');
});

test('audio: the seeker growl and the missile alert sweep up with their level', () => {
  const a0 = riseParams('acquire', 0);
  const a1 = riseParams('acquire', 1);
  assert.ok(a1.freq > a0.freq && a1.gate > a0.gate);
  const m0 = riseParams('missile', 0);
  const m1 = riseParams('missile', 1);
  assert.ok(m1.gate > m0.gate && m1.altHz > m0.altHz);
  assert.equal(riseParams('locked', 1), null, 'a steady tone has no sweep');
  assert.deepEqual(riseParams('acquire', 7), a1, 'clamped');
});

// -------------------------------------------------------------- callouts --

test('callouts: a burst of hits refreshes one line instead of stacking', () => {
  const c = new Callouts();
  c.push('kill', 'SPLASH', '+100', 2.2);
  c.update(0.5);
  c.push('hit', 'STRUCK', '', 1.1);
  c.update(0.3);
  c.push('hit', 'STRUCK', '', 1.1);
  c.push('hit', 'STRUCK', '', 1.1);
  assert.equal(c.items.length, 2);
  assert.equal(c.items[0].text, 'STRUCK');
  assert.ok(c.items[0].age <= 0.12, 'refreshed');
  assert.equal(c.items[1].text, 'SPLASH', 'the kill is not pushed off');
  c.push('kill', 'SPLASH', '+100');
  assert.deepEqual(c.items.map((i) => i.kind), ['kill', 'hit', 'kill'], 'kills still stack: each one counts');
});
