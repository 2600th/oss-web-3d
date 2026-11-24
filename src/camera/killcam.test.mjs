import test from 'node:test';
import assert from 'node:assert/strict';
import {
  KILL, predictIntercept, predictKill, lastOfGroup, isSpecial, wantsProjectileCam, killShot, projectileScale,
  impactScale, impactDuration, shotScale, AIR_ANGLES, pickAirAngle, airShotPose, groundOrbit, impactOrbit, flyAway,
  pushOutOfSpheres, fovFor, projectileRealTime, realTimeFor,
} from './killCam.js';
import { TimeWarp } from './timeWarp.js';

const v = (x, y, z) => ({ x, y, z });
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

test('intercept: time to go and miss distance of a straight-line closure', () => {
  const head = predictIntercept(v(0, 0, -700), v(0, 0, -700));
  assert.ok(near(head.tgo, 1) && near(head.miss, 0));
  const off = predictIntercept(v(20, 0, -700), v(0, 0, -700));
  assert.ok(near(off.tgo, 1) && near(off.miss, 20));
  // opening, or not moving: never
  assert.equal(predictIntercept(v(0, 0, -700), v(0, 0, 300)).tgo, Infinity);
  assert.equal(predictIntercept(v(0, 0, -700), v(0, 0, 0)).tgo, Infinity);
});

test('a predicted kill needs a hit and enough damage; guided shots get a steering allowance', () => {
  const base = { tgo: 0.3, miss: 30, hitRadius: 23, damage: 62, health: 60 };
  assert.equal(predictKill(base), false, 'unguided miss');
  assert.equal(predictKill({ ...base, guided: true }), true, 'guided, still steering');
  assert.equal(predictKill({ ...base, miss: 5, health: 80 }), false, 'not lethal');
  assert.equal(predictKill({ ...base, miss: 5, tgo: Infinity }), false);
});

test('last of a group: by shared tag, else by class within a radius', () => {
  const t = { team: 'hostile', class: 'air', tags: ['flight1'], position: v(0, 0, 0), alive: true };
  const wing = { team: 'hostile', class: 'air', tags: ['flight1'], position: v(30000, 0, 0), alive: true };
  assert.equal(lastOfGroup(t, [t, wing]), false, 'a tagged wingman anywhere');
  assert.equal(lastOfGroup(t, [t, { ...wing, alive: false }]), true);
  const loner = { ...t, tags: [] };
  const other = { team: 'hostile', class: 'air', tags: [], position: v(2000, 0, 0), alive: true };
  assert.equal(lastOfGroup(loner, [loner, other]), false);
  assert.equal(lastOfGroup(loner, [loner, { ...other, position: v(9000, 0, 0) }]), true);
  assert.equal(lastOfGroup(loner, [loner, { ...other, class: 'ground' }]), true, 'other classes do not count');
  assert.equal(lastOfGroup(loner, [loner, { ...other, team: 'friendly' }]), true);
});

test('special shots: last of group, long range, high off-boresight', () => {
  assert.equal(isSpecial({}), false);
  assert.equal(isSpecial({ last: true }), true);
  assert.equal(isSpecial({ launchRange: KILL.longRange + 1 }), true);
  assert.equal(isSpecial({ offBoresight: 1.0 }), true);
  assert.equal(isSpecial({ weapon: 'lraam', launchRange: KILL.longRange * 0.8 }), true);
  assert.equal(isSpecial({ weapon: 'msl', launchRange: 1500, offBoresight: 0.2 }), false);
});

test('projectile cam gate: never in danger, never without slow motion, cooldown, chance', () => {
  const ok = { special: true, roll: 0.5 };
  assert.equal(wantsProjectileCam(ok), true);
  assert.equal(wantsProjectileCam({ ...ok, danger: true }), false);
  assert.equal(wantsProjectileCam({ ...ok, enabled: false }), false);
  assert.equal(wantsProjectileCam({ ...ok, slowMo: false }), false);
  assert.equal(wantsProjectileCam({ ...ok, reducedMotion: true }), false);
  assert.equal(wantsProjectileCam({ ...ok, sinceLast: KILL.cooldown - 0.1 }), false);
  assert.equal(wantsProjectileCam({ ...ok, roll: 0.95 }), false, 'special kills are not guaranteed');
  // ordinary kills only rarely
  let n = 0;
  for (let i = 0; i < 1000; i++) if (wantsProjectileCam({ roll: i / 1000 })) n++;
  assert.ok(n > 50 && n < 200, `${n}`);
});

test('fast shot choice: air mostly, ground by chance, brief when motion is reduced', () => {
  assert.equal(killShot({ air: true }), 'air');
  assert.equal(killShot({ air: false, roll: 0.1 }), 'ground');
  assert.equal(killShot({ air: false, roll: 0.95 }), null);
  assert.equal(killShot({ air: true, reducedMotion: true }), 'brief');
  assert.equal(killShot({ air: true, danger: true }), null);
  assert.equal(killShot({ air: true, enabled: false }), null);
  assert.equal(killShot({ air: true, sinceLast: 1 }), null);
  assert.equal(killShot({ air: true, distance: 9000 }), null);
});

test('projectile time curve: ramps down smoothly, deepest at the end, bounded in real time', () => {
  assert.ok(near(projectileScale(KILL.trigger, 0), 1), 'starts at real time');
  let prev = 1;
  for (let t = 0; t <= KILL.rampIn; t += 0.01) {
    const s = projectileScale(KILL.trigger, t);
    assert.ok(s <= prev + 1e-9);
    prev = s;
  }
  // at a fixed real time, closer is slower
  assert.ok(projectileScale(0.02, 0.6) < projectileScale(0.3, 0.6));
  assert.ok(near(projectileScale(0.01, 0.6), KILL.projectileLow, 1e-3));
  assert.ok(near(projectileScale(0.1, 0.6), KILL.projectileMid, 1e-9), 'the two legs meet');
  assert.ok(near(projectileScale(0.1 - 1e-6, 0.6), KILL.projectileMid, 1e-4));
  for (let g = 0; g < KILL.trigger; g += 0.005) assert.ok(projectileScale(g, 0.6) <= projectileScale(g + 0.005, 0.6) + 1e-9, 'slower as it closes');
  const real = projectileRealTime();
  assert.ok(real > 0.8 && real <= KILL.projectileMax + 0.05, `projectile phase ${real.toFixed(2)} s`);
  // the cap: a long flight is pushed back to real time
  assert.ok(projectileScale(0.3, KILL.projectileMax + 0.3) > 0.99);
});

test('impact curve: from the near-freeze, a punch through the flash, a slow swing, back to 1; continuous', () => {
  const s0 = KILL.projectileLow;
  assert.ok(s0 <= 0.1, 'the last metres are a near-freeze');
  assert.ok(near(impactScale(0, s0), s0));
  assert.ok(near(impactScale(0.2, s0), KILL.punchScale));
  const swing = impactScale(KILL.punch + 0.5, s0);
  assert.ok(swing > 0.15 && swing < 0.3, `${swing}`);
  // the flash (0.06 game s in the VFX) is gone within the punch
  assert.ok(realTimeFor((t) => impactScale(t, s0), 0.06) < KILL.punch + 0.05);
  assert.equal(impactScale(impactDuration() + 0.01, s0), 1);
  let prev = impactScale(0, s0);
  for (let t = 0.001; t < impactDuration() + 0.1; t += 0.001) {
    const s = impactScale(t, s0);
    assert.ok(Math.abs(s - prev) < 0.02, `jump at ${t.toFixed(3)}: ${prev} -> ${s}`);
    prev = s;
  }
});

test('the whole projectile sequence stays inside about 4 s of real time', () => {
  const total = projectileRealTime() + impactDuration() + 0.55; // + the hand-back blend
  assert.ok(total <= 4.0, `${total.toFixed(2)} s`);
  // and the fast shots are short
  assert.ok(KILL.air + 0.55 <= 2.6 && KILL.ground + 0.55 <= 2.8 && KILL.brief <= 1.5);
});

test('fast shot time curve: a dip, a hold, back to 1 before the end', () => {
  assert.equal(shotScale(0, 2), 1);
  assert.ok(near(shotScale(0.5, 2, 0.45), 0.45));
  assert.ok(shotScale(1.95, 2, 0.45) > 0.95);
  assert.equal(shotScale(2.1, 2), 1);
});

test('air angles never repeat back to back and avoid the low shot near the ground', () => {
  const recent = [];
  for (let i = 0; i < 200; i++) {
    const a = pickAirAngle(recent, (i * 0.618) % 1);
    assert.ok(AIR_ANGLES.includes(a));
    if (recent.length) assert.notEqual(a, recent[recent.length - 1]);
    if (recent.length > 1) assert.notEqual(a, recent[recent.length - 2]);
    recent.push(a);
  }
  for (let i = 0; i < 50; i++) assert.notEqual(pickAirAngle([], i / 50, { agl: 40 }), 'lowSide');
  // every angle gets used
  assert.equal(new Set(recent).size, AIR_ANGLES.length);
});

test('air shot poses: finite, clear of the airframe, mirrored by side', () => {
  for (const a of AIR_ANGLES) {
    for (let t = 0; t <= KILL.air; t += 0.05) {
      const p = airShotPose(a, t, KILL.air, 1);
      const d = Math.hypot(p.off.f, p.off.r, p.off.u);
      assert.ok(Number.isFinite(d) && d > 12, `${a} at ${t.toFixed(2)}: ${d.toFixed(1)} m`);
      assert.ok(p.fov >= 25 && p.fov <= 60);
      const m = airShotPose(a, t, KILL.air, -1);
      assert.ok(near(m.off.r, -p.off.r) && near(m.off.f, p.off.f));
    }
  }
  assert.ok(airShotPose('lowSide', 0.5, KILL.air).off.u < 0, 'the low shot looks up');
  assert.ok(airShotPose('topDown', 0.5, KILL.air).off.u > 20, 'the top shot looks down');
  assert.ok(airShotPose('frontQuarter', 0.5, KILL.air).off.f > 20, 'the front shot is ahead');
});

test('ground orbit and impact swing keep their distance and turn the right way', () => {
  for (let t = 0; t <= KILL.ground; t += 0.1) {
    const o = groundOrbit(t, KILL.ground, 0, 1, 60);
    const r = Math.hypot(o.x, o.z);
    assert.ok(r > 40 && r < 70 && o.y > 15);
  }
  const start = v(0, 2, 20);
  const a = impactOrbit(start, 0, 1, 1.2, 50);
  assert.ok(near(a.x, 0) && near(a.z, 20) && near(a.y, 2));
  const b = impactOrbit(start, 1, 1, 1.2, 50);
  assert.ok(Math.hypot(b.x, b.y, b.z) >= 50 - 1e-6);
  assert.ok(b.x > 0, 'positive swing turns +x for an offset on +z');
  // a steep (top-down) start on a ground target ends low, at the asked elevation
  const steep = impactOrbit(v(5, 60, 10), 1, 1, 1, 40, 0.42);
  assert.ok(near(Math.atan2(steep.y, Math.hypot(steep.x, steep.z)), 0.42, 1e-9));
  assert.ok(near(Math.hypot(steep.x, steep.y, steep.z), 40, 1e-9));
  const overhead = impactOrbit(v(0, 50, 0), 0.5, 1, 1, 40, 0.42);
  assert.ok(Number.isFinite(overhead.x + overhead.y + overhead.z));
});

test('fly-away accelerates and reports its rate', () => {
  const dir = v(0, 0, 1);
  assert.equal(flyAway(0.5, 2, 0.4, dir).z, 0);
  const mid = flyAway(1.8, 2, 0.4, dir, 40);
  const end = flyAway(2, 2, 0.4, dir, 40);
  assert.ok(mid.z > 0 && end.z > mid.z && near(end.z, 40));
  assert.ok(end.rate > mid.rate && near(end.rate, 300));
});

test('keep-out spheres push the lens out of meshes', () => {
  const p = v(1, 0, 0);
  assert.equal(pushOutOfSpheres(p, [{ x: 0, y: 0, z: 0, r: 10 }]), true);
  assert.ok(near(Math.hypot(p.x, p.y, p.z), 10));
  const q = v(0, 0, 0);
  pushOutOfSpheres(q, [{ x: 0, y: 0, z: 0, r: 5 }]);
  assert.ok(near(q.y, 5));
  const far = v(50, 0, 0);
  assert.equal(pushOutOfSpheres(far, [{ x: 0, y: 0, z: 0, r: 10 }]), false);
});

test('framing FOV and real-time lookup', () => {
  assert.ok(fovFor(8, 30) > fovFor(8, 300));
  assert.ok(fovFor(8, 1e6) >= 18 && fovFor(8, 0.1) <= 75);
  assert.ok(near(realTimeFor(() => 1, 0.5), 0.5, 0.01));
  assert.ok(near(realTimeFor(() => 0.25, 0.5), 2, 0.01));
});

test('TimeWarp drive, release and its watchdog', () => {
  const g = { timeScale: 1 };
  const w = new TimeWarp(g);
  w.drive(0.2);
  assert.ok(near(g.timeScale, 0.2));
  w.drive(0.1);
  assert.ok(near(g.timeScale, 0.1) && near(w.scale, 0.1));
  w.release(0.5);
  w.update(0.25);
  assert.ok(g.timeScale > 0.1 && g.timeScale < 1);
  w.update(0.3);
  assert.equal(g.timeScale, 1);
  assert.equal(w.active, null);
  // a caller that stops driving: the warp lets go by itself
  const h = { timeScale: 2 };
  const x = new TimeWarp(h);
  x.drive(0.1);
  assert.ok(near(h.timeScale, 0.2));
  for (let i = 0; i < 60; i++) x.update(1 / 60);
  assert.equal(h.timeScale, 2, 'base restored');
});
