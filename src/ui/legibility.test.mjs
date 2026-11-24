import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTheme, adaptTheme, daylight, DAY, HALO, HALO_TEXT } from './theme.js';
import { ownJetBox, ownJetRects, OWN_JET_EXTENT, OWN_JET_PARTS } from './ownJet.js';
import { rect, overlap, placeLabels } from './declutter.js';

const alpha = (rgba) => Number(/,\s*([\d.]+)\)$/.exec(rgba)[1]);

// ------------------------------------------------------------- daylight --

test('adaptTheme: k = 0 is exactly the night (pre-change) look', () => {
  const base = resolveTheme({});
  const t = adaptTheme(base, 0);
  assert.equal(t.halo, HALO);
  assert.equal(t.haloText, HALO_TEXT);
  assert.equal(t.dim, base.dim);
  assert.equal(t.faint, base.faint);
  assert.equal(t.haloPad, 2.6);
  assert.equal(t.haloWide, null);
  assert.equal(t.plate, null);
  assert.deepEqual(t.textHalo, [1.25, 2.5, 0.13]);
});

test('adaptTheme: full day reaches the DAY values for every ink', () => {
  for (const hudColor of ['glacier', 'phosphor', 'amber', 'white']) {
    const t = adaptTheme(resolveTheme({ hudColor }), 1);
    assert.equal(alpha(t.halo), DAY.halo);
    assert.equal(alpha(t.haloText), DAY.haloText);
    assert.equal(alpha(t.dim), DAY.dim);
    assert.equal(alpha(t.faint), DAY.faint);
    assert.equal(alpha(t.haloWide), DAY.wide);
    assert.equal(t.haloPad, DAY.haloPad);
    assert.deepEqual(t.textHalo, DAY.textHalo);
    // the ink hue is kept: only alpha moves
    assert.ok(t.dim.startsWith(`rgba(${resolveTheme({ hudColor }).rgb},`));
  }
});

test('adaptTheme: halo strength and ink alpha rise monotonically with k', () => {
  const base = resolveTheme({});
  let prev = adaptTheme(base, 0.05);
  for (let k = 0.1; k <= 1.0001; k += 0.05) {
    const t = adaptTheme(base, k);
    assert.ok(alpha(t.halo) >= alpha(prev.halo));
    assert.ok(alpha(t.haloText) >= alpha(prev.haloText));
    assert.ok(alpha(t.dim) >= alpha(prev.dim));
    assert.ok(t.textHalo[2] >= prev.textHalo[2]);
    prev = t;
  }
});

test('adaptTheme: never narrower or fainter than the night look; out-of-range k clamps', () => {
  const base = resolveTheme({});
  const hi = adaptTheme(base, 7);
  assert.equal(hi.k, 1);
  assert.equal(adaptTheme(base, -2).k, 0);
  assert.equal(adaptTheme(base, NaN).k, 0);
  assert.ok(DAY.haloPad >= 2.6 && DAY.textHalo[0] >= 1.25 && DAY.textHalo[1] >= 2.5);
});

test('daylight: noon and bright cloud are day, night is night, no meter counts as day', () => {
  assert.equal(daylight({ adaptedLog2: -1.98, ev: 0.03 }), 1); // noon over the valley
  assert.equal(daylight({ adaptedLog2: -0.04, ev: -1.14 }), 1); // inside sunlit cloud
  assert.equal(daylight({ adaptedLog2: -6.5, ev: 1.45 }), 0); // night
  assert.equal(daylight(null), 1);
  assert.equal(daylight({ adaptedLog2: null, ev: 0 }), 1);
  const dusk = daylight({ adaptedLog2: -5.5, ev: 1.7 });
  assert.ok(dusk > 0 && dusk < 1);
});

// ---------------------------------------------------------- own-jet box --

function cameraMats(fovDeg = 62, aspect = 16 / 9, near = 0.5, far = 5000) {
  const view = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const top = near * Math.tan((fovDeg * Math.PI) / 360);
  const x = (2 * near) / (aspect * 2 * top);
  const y = (2 * near) / (2 * top);
  const c = -(far + near) / (far - near);
  const d = (-2 * far * near) / (far - near);
  return { view, proj: [x, 0, 0, 0, 0, y, 0, 0, 0, 0, c, -1, 0, 0, d, 0] };
}
/** Aircraft placed `back` m ahead of the camera (camera behind its tail), `down` m below. */
const jetAt = (back, down = 0) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -down, -back, 1];

test('ownJetBox: a jet ahead of the chase camera covers the screen centre, and shrinks with range', () => {
  const { view, proj } = cameraMats();
  const near = ownJetBox(jetAt(20), view, proj, 1920, 1080);
  const far = ownJetBox(jetAt(60), view, proj, 1920, 1080);
  assert.ok(near && far);
  for (const r of [near, far]) assert.ok(r.x0 < 960 && r.x1 > 960 && r.y0 < 540 && r.y1 > 540);
  assert.ok(near.x1 - near.x0 > (far.x1 - far.x0) * 2);
  // symmetric about the centre line
  assert.ok(Math.abs(960 - near.x0 - (near.x1 - 960)) < 1e-6);
});

test('ownJetBox: inside the airframe (first person) or behind the camera gives null', () => {
  const { view, proj } = cameraMats();
  assert.equal(ownJetBox(jetAt(0), view, proj, 1920, 1080), null);
  assert.equal(ownJetBox(jetAt(-30), view, proj, 1920, 1080), null);
});

test('ownJetBox: pad grows the rect on every side', () => {
  const { view, proj } = cameraMats();
  const a = ownJetBox(jetAt(25), view, proj, 1920, 1080, OWN_JET_EXTENT, {}, 0);
  const b = ownJetBox(jetAt(25), view, proj, 1920, 1080, OWN_JET_EXTENT, {}, 5);
  assert.deepEqual([b.x0, b.y0, b.x1, b.y1], [a.x0 - 5, a.y0 - 5, a.x1 + 5, a.y1 + 5]);
});

test('ownJetRects: the part boxes sit inside the whole-jet box and cover less of it', () => {
  const { view, proj } = cameraMats();
  const m = jetAt(22, 3);
  const all = ownJetBox(m, view, proj, 1920, 1080);
  const out = [];
  const n = ownJetRects(m, view, proj, 1920, 1080, out);
  assert.equal(n, OWN_JET_PARTS.length);
  let area = 0;
  for (let i = 0; i < n; i++) {
    const r = out[i];
    assert.ok(r.x0 >= all.x0 - 1e-6 && r.x1 <= all.x1 + 1e-6 && r.y0 >= all.y0 - 1e-6 && r.y1 <= all.y1 + 1e-6);
    area += (r.x1 - r.x0) * (r.y1 - r.y0);
  }
  // the parts overlap one another, but the open corners of the whole box stay free
  const corner = rect(all.x0, all.y0, all.x0 + (all.x1 - all.x0) * 0.2, all.y0 + (all.y1 - all.y0) * 0.2);
  for (let i = 0; i < n; i++) assert.equal(overlap(out[i], corner), 0);
  assert.ok(area > 0);
  // reuses the rect objects on the next frame
  const first = out[0];
  ownJetRects(m, view, proj, 1920, 1080, out);
  assert.equal(out[0], first);
});

test('labels: an ordinary label keeps off the jet rect, taking a clear slot instead', () => {
  const jet = rect(800, 500, 1100, 700);
  jet.w = 1.5;
  const onJet = [rect(900, 560, 980, 580)];
  const clear = [rect(900, 420, 980, 440)];
  const picks = placeLabels([{ must: false, cands: [onJet, clear], prev: -1 }], [jet], rect(0, 0, 1920, 1080));
  assert.deepEqual(picks, [1]);
  // with nowhere clear an ordinary label drops, a must-label still places
  const none = placeLabels([{ must: false, cands: [onJet], prev: -1 }], [jet], rect(0, 0, 1920, 1080));
  assert.deepEqual(none, [-1]);
  const must = placeLabels([{ must: true, cands: [onJet], prev: -1 }], [jet], rect(0, 0, 1920, 1080));
  assert.deepEqual(must, [0]);
});
