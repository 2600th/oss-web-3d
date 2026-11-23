import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rect, overlap, inside, instrumentKeepOut, panelKeepOut, chooseSlot, slotCost, pickPlateSlot } from './declutter.js';
import { computeLayout } from './layout.js';

test('declutter: rect overlap and containment', () => {
  const a = rect(0, 0, 10, 10);
  assert.equal(overlap(a, rect(5, 5, 20, 20)), 25);
  assert.equal(overlap(a, rect(10, 0, 20, 10)), 0, 'touching edges do not overlap');
  assert.ok(inside(5, 5, a));
  assert.ok(!inside(12, 5, a));
  assert.ok(inside(12, 5, a, 3));
  assert.deepEqual(rect(10, 10, 0, 0), a, 'corners are normalised');
});

test('declutter: keep-out covers both tapes with their boxes and the heading tape', () => {
  const L = computeLayout({ w: 1920, h: 1080 });
  const s = L.s;
  const [spd, alt, hdg] = instrumentKeepOut(L, s);
  // altitude readout box runs to alt.x + 78 u; speed throttle column at -76 u
  assert.ok(inside(L.alt.x + 60 * s, L.alt.y, alt));
  assert.ok(inside(L.alt.x + 40 * s, L.alt.y + L.tapeH / 2 + 20 * s, alt), 'AGL row');
  assert.ok(inside(L.speed.x - 76 * s, L.speed.y, spd), 'throttle column');
  assert.ok(inside(L.heading.x, L.heading.y + 30 * s, hdg), 'heading readout');
  // the centre field (ladder, FPM) stays open
  for (const r of [spd, alt, hdg]) assert.ok(!inside(L.cx, L.cy, r));
  assert.equal(instrumentKeepOut(L, s, [null, rect(0, 0, 1, 1)]).length, 4);
});

test('declutter: corner panels are label keep-outs on every layout', () => {
  for (const [w, h, touch] of [[1920, 1080, false], [390, 844, true], [844, 390, true]]) {
    const L = computeLayout({ w, h, touch });
    const p = panelKeepOut(L, L.s);
    assert.equal(p.length, 5);
    assert.ok(inside(L.radar.x, L.radar.y, p[0]), 'radar');
    for (const r of p) assert.equal(r.w, 2);
    for (const r of p) assert.ok(!inside(L.cx, L.cy, r), 'centre stays open');
  }
});

test('declutter: a label takes the first clear slot, else the least-bad one', () => {
  const wall = rect(100, 0, 200, 100);
  const cands = [[rect(90, 10, 130, 20)], [rect(40, 10, 80, 20)], [rect(210, 10, 250, 20)]];
  assert.deepEqual(chooseSlot(cands, [wall], null), { i: 1, cost: 0 });
  const blocked = [[rect(90, 10, 130, 20)], [rect(150, 10, 160, 20)]];
  const pick = chooseSlot(blocked, [wall], null);
  assert.equal(pick.i, 1);
  assert.ok(pick.cost > 0);
  // off-screen area counts against a slot
  assert.ok(slotCost([rect(-10, 0, 10, 10)], [], rect(0, 0, 100, 100)) === 100);
});

test('declutter: radio plate moves only when the other slot covers fewer markers', () => {
  const low = rect(0, 500, 300, 560);
  const high = rect(0, 140, 300, 200);
  assert.equal(pickPlateSlot([low, high], []), 0);
  assert.equal(pickPlateSlot([low, high], [rect(100, 520, 120, 540)]), 1);
  assert.equal(pickPlateSlot([low, high], [rect(100, 520, 120, 540), rect(100, 150, 120, 170)]), 0, 'tie keeps the usual slot');
});

test('layout: landscape phone banner clears the tapes and the radio line', () => {
  const L = computeLayout({ w: 844, h: 390, touch: true, safe: { top: 0, bottom: 21, left: 47, right: 47 } });
  const banner = rect(L.cx - 230 * L.s, L.bannerY, L.cx + 230 * L.s, L.bannerY + 52 * L.s);
  assert.ok(L.bannerY >= L.cy + L.tapeH / 2, 'below the tapes');
  // G and radar-altitude rows sit outboard of the banner
  assert.ok(L.speed.x - 8 * L.s < banner.x0 && L.alt.x + 8 * L.s > banner.x1);
  assert.ok(banner.y1 <= L.bounds.B);
});
