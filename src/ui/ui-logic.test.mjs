import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatHeading, headingTickLabel, formatClock, formatRange, formatScore, groupThousands,
  formatAccuracy, formatAmmo, wrap180, wrap360, toKnots, formatAltitude,
} from './format.js';
import { projectPoint, edgeClamp, gunLead, pixelsPerDegree, bearingDeg } from './projection.js';
import { worldToRadar, autoRange, nextRange, RADAR_RANGES, bakeRelief, reliefColor } from './radar.js';
import { RadioQueue, Callouts } from './radio.js';
import { computeLayout, hudUnit } from './layout.js';
import { normalizeHud, attitudeFromFlight, deriveWarning } from './hudData.js';
import { resolveTheme, targetColor, isGroundKind, PALETTES } from './theme.js';
import { lonLatToWorld, worldToLonLat } from './geo.js';
import { Settings, validate, migrateLegacy, SETTINGS_KEY } from '../core/Settings.js';

const near = (a, b, eps = 1e-6, msg) => assert.ok(Math.abs(a - b) <= eps, msg ?? `${a} !~ ${b}`);

// ---------------------------------------------------------------- format --

test('heading formats as three digits with 360 for north', () => {
  assert.equal(formatHeading(0), '360');
  assert.equal(formatHeading(7.4), '007');
  assert.equal(formatHeading(-90), '270');
  assert.equal(formatHeading(359.6), '360');
  assert.equal(formatHeading(721), '001');
});

test('heading tape labels use cardinals and two-digit tens', () => {
  assert.equal(headingTickLabel(0), 'N');
  assert.equal(headingTickLabel(90), 'E');
  assert.equal(headingTickLabel(-90), 'W');
  assert.equal(headingTickLabel(30), '03');
  assert.equal(headingTickLabel(350), '35');
});

test('angle wrapping', () => {
  assert.equal(wrap360(-10), 350);
  assert.equal(wrap180(190), -170);
  assert.equal(wrap180(180), 180);
  assert.equal(wrap360(NaN), 0);
});

test('clock, range, score, ammo and accuracy formats', () => {
  assert.equal(formatClock(0), '0:00');
  assert.equal(formatClock(65.9), '1:05');
  assert.equal(formatClock(3725), '1:02:05');
  assert.equal(formatClock(-5), '0:00');
  assert.equal(formatRange(843), '840m');
  assert.equal(formatRange(2449), '2.4km');
  assert.equal(formatRange(18400), '18km');
  assert.equal(formatRange(NaN), '');
  assert.equal(formatScore(12450), '0012450');
  assert.equal(formatScore(-3), '0000000');
  assert.equal(groupThousands(18450, ','), '18,450');
  assert.equal(groupThousands(-1200, ','), '-1,200');
  assert.equal(formatAmmo(Infinity), '∞');
  assert.equal(formatAmmo(12.4), '12');
  assert.equal(formatAccuracy(0.625), '63%');
  assert.equal(formatAccuracy(62.5), '63%');
  assert.equal(formatAccuracy(undefined), '—');
});

test('units: knots and feet', () => {
  near(toKnots(100), 194.3844, 1e-3);
  assert.equal(formatAltitude(5000).replace(/ /g, ' '), '16 400');
});

// ------------------------------------------------------------ projection --

/** Build view + projection like three.js for a camera at the origin looking down -Z. */
function cameraMats(fovDeg = 60, aspect = 16 / 9, near = 0.5, far = 1000) {
  const view = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const top = near * Math.tan((fovDeg * Math.PI) / 360);
  const h = 2 * top;
  const w = aspect * h;
  const x = (2 * near) / w;
  const y = (2 * near) / h;
  const c = -(far + near) / (far - near);
  const d = (-2 * far * near) / (far - near);
  // column-major
  const proj = [x, 0, 0, 0, 0, y, 0, 0, 0, 0, c, -1, 0, 0, d, 0];
  return { view, proj };
}

test('projectPoint: straight ahead lands on the centre', () => {
  const { view, proj } = cameraMats();
  const o = {};
  projectPoint(0, 0, -100, view, proj, 1600, 900, o);
  near(o.x, 800);
  near(o.y, 450);
  assert.equal(o.behind, false);
  assert.equal(o.onScreen, true);
});

test('projectPoint: up is up the screen, right is right', () => {
  const { view, proj } = cameraMats();
  const o = {};
  projectPoint(10, 10, -100, view, proj, 1600, 900, o);
  assert.ok(o.x > 800 && o.y < 450);
});

test('projectPoint: vertical FOV edge maps to the screen edge', () => {
  const { view, proj } = cameraMats(60);
  const o = {};
  const z = -100;
  projectPoint(0, Math.tan((30 * Math.PI) / 180) * 100, z, view, proj, 1600, 900, o);
  near(o.y, 0, 1e-6);
});

test('projectPoint: a point behind is flagged and mirrored outward', () => {
  const { view, proj } = cameraMats();
  const o = {};
  projectPoint(50, 0, 100, view, proj, 1600, 900, o); // behind, to the right
  assert.equal(o.behind, true);
  assert.equal(o.onScreen, false);
  assert.ok(o.x > 800, 'behind-right should point right');
});

test('edgeClamp keeps arrows inside the inset box and preserves direction', () => {
  const e = {};
  edgeClamp(5000, 450, 1600, 900, 40, e);
  near(e.y, 450, 1e-6);
  assert.ok(e.x <= 1600 - 40 + 1e-6 && e.x > 1500);
  near(e.angle, 0);
  edgeClamp(800, -9000, 1600, 900, 40, e);
  near(e.x, 800, 1e-6);
  near(e.y, 40, 1e-6);
  // corner case stays inside the rectangle
  edgeClamp(99999, 99999, 1600, 900, 40, e);
  assert.ok(e.x < 1560 && e.y < 860);
});

test('gunLead: stationary target needs only gravity compensation', () => {
  const o = {};
  gunLead({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1000 }, { x: 0, y: 0, z: 0 }, 1000, o);
  near(o.tof, 1, 1e-6);
  near(o.x, 0);
  near(o.y, 0.5 * 9.81, 1e-6);
});

test('gunLead: crossing target is led in its direction of travel', () => {
  const o = {};
  gunLead({ x: 0, y: 0, z: 0 }, null, { x: 0, y: 0, z: -800 }, { x: 200, y: 0, z: 0 }, 1000, o);
  assert.ok(o.x > 150 && o.x < 200, `lead ${o.x}`);
});

test('pixelsPerDegree and bearing', () => {
  near(pixelsPerDegree(90, 1000), 500 * (Math.PI / 180), 1e-9);
  near(bearingDeg(0, 0, 0, -10), 0);
  near(bearingDeg(0, 0, 10, 0), 90);
  near(bearingDeg(0, 0, 0, 10), 180);
  near(bearingDeg(0, 0, -10, 0), 270);
});

// ----------------------------------------------------------------- radar --

test('radar: heading-up rotation', () => {
  const o = {};
  // heading north: a contact to the north is straight up
  worldToRadar(0, -1000, 0, 2000, o);
  near(o.x, 0);
  near(o.y, -0.5);
  // heading east: a contact to the east is straight up, one to the south is right
  worldToRadar(1000, 0, 90, 2000, o);
  near(o.x, 0, 1e-9);
  near(o.y, -0.5, 1e-9);
  worldToRadar(0, 1000, 90, 2000, o);
  near(o.x, 0.5, 1e-9);
  near(o.y, 0, 1e-9);
  // heading west: north is to the right
  worldToRadar(0, -1000, 270, 2000, o);
  near(o.x, 1 * 0.5, 1e-9);
});

test('radar: contacts beyond range clamp to the rim', () => {
  const o = {};
  worldToRadar(0, -9000, 0, 2000, o);
  assert.equal(o.clamped, true);
  near(Math.hypot(o.x, o.y), 1);
  near(o.dist, 9000);
});

test('radar: auto range and range ladder', () => {
  assert.equal(autoRange([1200]), 4000);
  assert.equal(autoRange([5000]), 8000);
  assert.equal(autoRange([90000]), 32000);
  assert.equal(autoRange([], 16000), 16000);
  assert.equal(nextRange(32000), RADAR_RANGES[0]);
});

test('relief bake: shape, opacity and shading direction', () => {
  // a ramp rising to the east: the west-facing light (NW sun) should make it darker
  const flat = bakeRelief(() => 4000, { minX: 0, maxX: 1000, minZ: 0, maxZ: 1000 }, 8, { contour: 10000 });
  const ramp = bakeRelief((x) => 3000 + x * 2, { minX: 0, maxX: 1000, minZ: 0, maxZ: 1000 }, 8, { contour: 10000 });
  assert.equal(flat.length, 8 * 8 * 4);
  assert.equal(flat[3], 255);
  const mid = (4 * 8 + 4) * 4;
  const flatLum = flat[mid] + flat[mid + 1] + flat[mid + 2];
  const rampLum = ramp[mid] + ramp[mid + 1] + ramp[mid + 2];
  // sanity: both produce sane colours
  assert.ok(flatLum > 0 && rampLum > 0);
  const [r0] = reliefColor(2500, 1);
  const [r1] = reliefColor(5900, 1);
  assert.ok(r1 > r0, 'snow brighter than valley');
});

// ------------------------------------------------------------ radio queue --

test('radio: FIFO within priority, pre-emption by higher priority', () => {
  const q = new RadioQueue({ minHold: 0.5, fade: 0.2 });
  q.push({ callsign: 'A', text: 'one two three', priority: 1 });
  q.push({ callsign: 'B', text: 'four', priority: 1 });
  q.update(0.01);
  assert.equal(q.current.callsign, 'A');
  q.update(0.6);
  q.push({ callsign: 'C', text: 'missile', priority: 3 });
  // A is cut short, fades, then C (higher) beats B
  q.update(0.25);
  q.update(0.01);
  assert.equal(q.current.callsign, 'C');
  for (let i = 0; i < 100 && q.current?.callsign === 'C'; i++) q.update(0.1);
  assert.equal(q.current.callsign, 'B');
});

test('radio: alpha fades in and out, queue is capped', () => {
  const q = new RadioQueue({ maxQueue: 2 });
  for (let i = 0; i < 5; i++) q.push({ text: `line ${i}` });
  assert.equal(q.queue.length, 2);
  q.update(0.001);
  assert.ok(q.alpha < 0.1);
  q.update(0.5);
  assert.equal(q.alpha, 1);
  assert.ok(RadioQueue.durationFor('a b c d e f g h i j k l m n o p q r s t u v w x y z') <= 9);
});

test('callouts expire and cap', () => {
  const c = new Callouts({ max: 2 });
  c.push('kill', 'A', '', 1);
  c.push('kill', 'B', '', 1);
  c.push('kill', 'C', '', 3);
  assert.deepEqual(c.items.map((i) => i.text), ['C', 'B']);
  c.update(1.5);
  assert.deepEqual(c.items.map((i) => i.text), ['C']);
});

// ---------------------------------------------------------------- layout --

const VIEWPORTS = {
  '1080p': [1920, 1080],
  '1440p': [2560, 1440],
  ultrawide: [3440, 1440],
  superwide: [5120, 1440],
  'phone-portrait': [390, 844],
  'phone-landscape': [844, 390],
  tablet: [1024, 768],
};

for (const [name, [w, h]] of Object.entries(VIEWPORTS)) {
  for (const touch of [false, true]) {
    test(`layout ${name}${touch ? ' touch' : ''}: anchors inside the safe box, tapes not overlapping`, () => {
      const safe = name.startsWith('phone') ? { top: 47, bottom: 34, left: 0, right: 0 } : {};
      if (name === 'phone-landscape') Object.assign(safe, { top: 0, bottom: 21, left: 47, right: 47 });
      const L = computeLayout({ w, h, safe, touch });
      const { L: l, R, T, B } = L.bounds;
      for (const k of ['speed', 'alt', 'heading', 'score', 'objective', 'radar', 'weapons', 'health', 'radio']) {
        const a = L[k];
        assert.ok(a.x >= l - 1 && a.x <= R + 1, `${k}.x ${a.x} in [${l}, ${R}]`);
        assert.ok(a.y >= T - 1 && a.y <= B + 1, `${k}.y ${a.y} in [${T}, ${B}]`);
      }
      assert.ok(L.speed.x < L.cx && L.alt.x > L.cx, 'tapes either side of centre');
      assert.ok(L.alt.x - L.speed.x > 120 * L.s, 'room for the ladder between the tapes');
      assert.ok(L.radar.x - L.radar.r >= l - 1, 'radar inside left edge');
      // tapes extend outward from their spine by up to 84 units (alt box)
      assert.ok(L.speed.x - 84 * L.s >= l - 1, `speed tape on screen (${L.speed.x - 84 * L.s} >= ${l})`);
      assert.ok(L.alt.x + 84 * L.s <= R + 1, `alt tape on screen (${L.alt.x + 84 * L.s} <= ${R})`);
      // ultrawide: central field never wider than 16:9 of the height
      assert.ok(L.alt.x - L.speed.x <= h * (16 / 9));
    });
  }
}

test('layout: HUD unit clamps and scales', () => {
  assert.equal(hudUnit(10000, 10000), 1.6);
  assert.equal(hudUnit(300, 300), 0.62);
  near(hudUnit(1640, 820, 1.2), 1.2);
});

test('layout: touch portrait keeps instruments out of the thumb band', () => {
  const L = computeLayout({ w: 390, h: 844, touch: true });
  assert.ok(L.cy < 844 * 0.45);
  assert.ok(L.radar.y + L.radar.r < 844 * 0.5);
});

// --------------------------------------------------------------- hudData --

const ident = {
  forward: { x: 0, y: 0, z: -1 }, right: { x: 1, y: 0, z: 0 }, up: { x: 0, y: 1, z: 0 },
  velocity: { x: 0, y: 0, z: -200 }, airspeed: 200, altitude: 4000, agl: 900, gLoad: 1,
  throttleSmoothed: 0.7, reheat: false, stalling: false, angleOfAttack: 0, crashed: false,
};

test('attitude from the flight model axes', () => {
  const o = attitudeFromFlight(ident, {});
  near(o.heading, 0);
  near(o.pitch, 0);
  near(o.roll, 0);
  const east = { forward: { x: 1, y: 0, z: 0 }, right: { x: 0, y: 0, z: 1 }, up: { x: 0, y: 1, z: 0 } };
  near(attitudeFromFlight(east, {}).heading, 90);
  // 30 degree right bank: right wing down
  const a = Math.PI / 6;
  const bank = { forward: { x: 0, y: 0, z: -1 }, right: { x: Math.cos(a), y: -Math.sin(a), z: 0 }, up: { x: Math.sin(a), y: Math.cos(a), z: 0 } };
  near(attitudeFromFlight(bank, {}).roll, 30, 1e-9);
});

test('normalizeHud tolerates an empty snapshot and fills from the flight model', () => {
  const d = normalizeHud({}, ident, {});
  assert.equal(d.speed, 200);
  assert.equal(d.altitude, 4000);
  assert.equal(d.health, 1);
  assert.equal(d.hasHealth, false);
  assert.deepEqual(d.targets, []);
  assert.equal(d.warning, 'none');
  const e = normalizeHud(undefined, null, {});
  assert.equal(e.speed, 0);
  assert.equal(e.heading, 0);
});

test('normalizeHud prefers snapshot values and keeps arrays', () => {
  const d = normalizeHud({ speed: 300, health: 0.4, targets: [{ id: 1 }], warning: 'missile' }, ident, {});
  assert.equal(d.speed, 300);
  assert.equal(d.health, 0.4);
  assert.equal(d.hasHealth, true);
  assert.equal(d.targets.length, 1);
  assert.equal(d.warning, 'missile');
});

test('derived warning: pull up on a closing sink, terrain when low', () => {
  const sink = { ...ident, velocity: { x: 0, y: -80, z: -200 } };
  assert.equal(deriveWarning({ agl: 300, stall: false }, sink), 'pullup');
  assert.equal(deriveWarning({ agl: 100, stall: false }, ident), 'terrain');
  assert.equal(deriveWarning({ agl: 900, stall: true }, ident), 'stall');
  assert.equal(deriveWarning({ agl: 900 }, { ...ident, crashed: true }), 'none');
});

// ----------------------------------------------------------------- theme --

test('theme: role colours and colour-blind palettes differ where it matters', () => {
  const t = resolveTheme({ hudColor: 'phosphor', palette: 'standard' });
  assert.equal(targetColor(t, { team: 'friendly' }), t.friendly);
  assert.equal(targetColor(t, { isAce: true, isTarget: true }), t.ace);
  assert.equal(targetColor(t, { isTarget: true }), t.priority);
  assert.equal(targetColor(t, { kind: 'sam' }), t.ground);
  assert.equal(targetColor(t, { kind: 'fighter' }), t.hostile);
  assert.notEqual(PALETTES.deutan.hostile, PALETTES.standard.hostile);
  assert.equal(isGroundKind('fighter'), false);
  assert.equal(isGroundKind('aaa'), true);
  assert.equal(isGroundKind(undefined), false);
  assert.deepEqual(Object.keys(resolveTheme({ hudColor: 'nope' })).sort(), Object.keys(t).sort());
});

// ------------------------------------------------------------------- geo --

test('geo round-trips and the origin is the DEM centre', () => {
  const o = lonLatToWorld(76.09, 34.5);
  near(o.x, 0);
  near(o.z, 0);
  const p = lonLatToWorld(75.8, 34.42);
  assert.ok(p.x < 0 && p.z > 0, 'west and south of centre');
  const b = worldToLonLat(p.x, p.z);
  near(b.lon, 75.8, 1e-9);
  near(b.lat, 34.42, 1e-9);
});

// -------------------------------------------------------------- settings --

class MemStore {
  constructor(init = {}) { this.m = new Map(Object.entries(init)); }
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k, v) { this.m.set(k, String(v)); }
}

test('settings: defaults, validation, clamping and persistence', () => {
  const store = new MemStore();
  const s = new Settings({ store });
  assert.equal(s.hudColor, 'glacier');
  assert.equal(s.set('hudScale', 9), true);
  assert.equal(s.hudScale, 1.3);
  assert.equal(s.set('hudColor', 'neon'), false);
  assert.equal(s.set('invertY', 'yes'), false);
  assert.equal(s.set('tier', 'ultra'), true);
  assert.equal(s.set('tier', null), true);
  const seen = [];
  s.onChange((k, v) => seen.push([k, v]));
  s.set('masterVolume', 0.25);
  assert.deepEqual(seen, [['masterVolume', 0.25]]);
  const again = new Settings({ store });
  assert.equal(again.masterVolume, 0.25);
  assert.equal(again.hudScale, 1.3);
  assert.equal(validate('sensitivity', NaN), undefined);
});

test('settings: corrupt record falls back to defaults; legacy v2 migrates once', () => {
  const bad = new Settings({ store: new MemStore({ [SETTINGS_KEY]: '{not json' }) });
  assert.equal(bad.controlMode, 'standard');
  const legacy = new MemStore({
    'safed-sagar.settings.v2': JSON.stringify({ masterVolume: 0.3, controlMode: 'direct', verticalMode: 'upToDive', controlSensitivity: 'high' }),
  });
  const s = new Settings({ store: legacy });
  assert.equal(s.masterVolume, 0.3);
  assert.equal(s.controlMode, 'expert');
  assert.equal(s.invertY, true);
  assert.equal(s.sensitivity, 1.35);
  assert.ok(legacy.getItem(SETTINGS_KEY), 'migrated record written');
  assert.deepEqual(migrateLegacy(null), {});
});

test('settings: works with no storage at all', () => {
  const s = new Settings({ store: null });
  assert.equal(s.set('subtitles', false), true);
  assert.equal(s.subtitles, false);
});
