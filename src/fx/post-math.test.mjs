import test from 'node:test';
import assert from 'node:assert/strict';
import { EXPOSURE_DEFAULTS as E, targetExposureEV, adaptLog2, evToMultiplier } from './post/exposure.js';
import { ScreenState } from './ScreenState.js';
import { motionBlurParams, MOTION_DEFAULTS } from './post/motionParams.js';
import { waterDrivers, rainFrom } from './waterModel.js';

test('exposure: reference scene gets the base EV; metering is partial and clamped', () => {
  assert.equal(targetExposureEV(E.refLog), E.baseEV);
  // a scene 2 stops brighter is only pulled down strength * 2 stops
  assert.ok(Math.abs(targetExposureEV(E.refLog + 2) - (E.baseEV - 2 * E.strength)) < 1e-12);
  // extreme scenes hit the clamps
  assert.equal(targetExposureEV(E.refLog + 50), E.baseEV + E.minEV);
  assert.equal(targetExposureEV(E.refLog - 50), E.baseEV + E.maxEV);
  // compensation adds straight through; garbage metering falls back to base
  assert.equal(targetExposureEV(E.refLog, E, 0.5), E.baseEV + 0.5);
  assert.equal(targetExposureEV(NaN), E.baseEV);
  assert.equal(evToMultiplier(0), 1);
  assert.equal(evToMultiplier(-1), 0.5);
});

test('exposure adaptation: frame-rate independent, faster toward bright', () => {
  let a = 0; for (let i = 0; i < 30; i++) a = adaptLog2(a, 2, 1 / 60);
  let b = 0; for (let i = 0; i < 120; i++) b = adaptLog2(b, 2, 1 / 240);
  assert.ok(Math.abs(a - b) < 1e-9);
  const up = adaptLog2(0, 1, 0.1);
  const down = adaptLog2(1, 0, 0.1);
  assert.ok(up > 1 - down, 'brightening adapts faster');
  assert.equal(adaptLog2(NaN, 3, 0.016), 3);
  assert.equal(adaptLog2(1, NaN, 0.016), 1);
});

test('G-LOC: brief high G is survivable, sustained high G greys out, recovery', () => {
  const s = new ScreenState();
  for (let i = 0; i < 30; i++) s.update(1 / 60, { gLoad: 9 }); // 0.5 s snap
  assert.ok(s.grey < 0.25, `snap pull grey ${s.grey}`);
  for (let i = 0; i < 6 * 60; i++) s.update(1 / 60, { gLoad: 8 }); // 6 s sustained
  assert.ok(s.grey > 0.9, `sustained grey ${s.grey}`);
  for (let i = 0; i < 6 * 60; i++) s.update(1 / 60, { gLoad: 1 });
  assert.ok(s.grey < 0.01, `recovered ${s.grey}`);
});

test('redout from sustained negative G', () => {
  const s = new ScreenState();
  for (let i = 0; i < 4 * 60; i++) s.update(1 / 60, { gLoad: -3 });
  assert.ok(s.red > 0.8);
  assert.equal(s.grey, 0);
});

test('hits, explosions and cloud wetness decay', () => {
  const s = new ScreenState();
  s.hitSeverity(1);
  assert.ok(s.damage > 0.9 && s.smear > 0.9);
  assert.equal(s.explosion(1000, 'large'), 0);
  assert.ok(s.explosion(30, 'large') > 0.7);
  s.update(1 / 60, { inCloud: 1 });
  for (let i = 0; i < 120; i++) s.update(1 / 60, { inCloud: 1 });
  assert.ok(s.wet > 0.9);
  for (let i = 0; i < 180; i++) s.update(1 / 60, { inCloud: 0 });
  assert.ok(s.damage < 0.05 && s.smear < 0.01 && s.flash < 0.01);
  assert.ok(s.wet < 0.5 && s.wet > 0.1, `lens dries over seconds, ${s.wet}`);
});

test('screen hit scales from zero with severity (no floor)', () => {
  const at = (sev) => { const s = new ScreenState(); s.hitSeverity(sev); return s; };
  assert.equal(at(0).damage, 0);
  assert.equal(at(0).smear, 0);
  const graze = at(0.1), round = at(0.3), missile = at(1);
  assert.ok(graze.damage < 0.1, `graze edge ${graze.damage}`);
  assert.ok(graze.smear < 0.02, `graze smear ${graze.smear}`);
  assert.ok(graze.damage < round.damage && round.damage < missile.damage);
  assert.ok(round.smear < round.damage, 'smear is reserved for heavy hits');
  // legacy entry point (fraction of health) follows the same curve
  const s = new ScreenState(); s.hit(0.25);
  assert.ok(Math.abs(s.damage - 1) < 1e-9);
});

test('low health heartbeat only when alive and hurt', () => {
  const s = new ScreenState();
  let peak = 0;
  for (let i = 0; i < 120; i++) { s.update(1 / 60, { health: 0.1 }); peak = Math.max(peak, s.lowHealth); }
  assert.ok(peak > 0.6);
  s.update(1 / 60, { health: 0.1, alive: false });
  assert.equal(s.lowHealth, 0);
  s.update(1 / 60, { health: 0.9 });
  assert.equal(s.lowHealth, 0);
});

test('motion blur: fixed shutter time (same streak per second at any frame rate)', () => {
  const a = motionBlurParams({ dt: 1 / 60, airspeed: 300 });
  const b = motionBlurParams({ dt: 1 / 120, airspeed: 300 });
  // strength multiplies the per-frame velocity, which halves at twice the rate
  assert.ok(Math.abs(a.strength / 60 - b.strength / 120) < 1e-9);
  assert.ok(Math.abs(a.strength - (MOTION_DEFAULTS.shutter * 60)) < 1e-9);
  // clamped against hitches
  assert.ok(motionBlurParams({ dt: 0.5, airspeed: 300 }).strength >= 0.5 * 0.99);
});

test('motion blur: off for reduced motion, cuts and the user setting; scales with speed', () => {
  for (const o of [{ reducedMotion: true }, { cut: true }, { user: 0 }]) {
    const p = motionBlurParams({ airspeed: 300, ...o });
    assert.equal(p.strength, 0);
    assert.equal(p.zoom, 0);
  }
  assert.ok(motionBlurParams({ airspeed: 80 }).strength < motionBlurParams({ airspeed: 320 }).strength);
  assert.equal(motionBlurParams({ tile: 32, pixelRatio: 2 }).maxPx, 64);
});

test('speed zoom: fast and low only, a little at Mach 1, never off-board views', () => {
  const low = motionBlurParams({ airspeed: 330, agl: 30 }).zoom;
  const high = motionBlurParams({ airspeed: 330, agl: 3000 }).zoom;
  const slow = motionBlurParams({ airspeed: 120, agl: 30 }).zoom;
  assert.ok(low > 0.003);
  assert.equal(high, 0);
  assert.equal(slow, 0);
  assert.ok(motionBlurParams({ airspeed: 330, agl: 3000, mach: 1 }).zoom > 0);
  assert.equal(motionBlurParams({ airspeed: 330, agl: 30, view: 'kill' }).zoom, 0);
});

test('screen water: dry in clear air, mist in cloud, big drops only in rain', () => {
  const dry = waterDrivers({ airspeed: 250 });
  assert.equal(dry.rateSmall, 0);
  assert.equal(dry.rateBig, 0);
  const cloud = waterDrivers({ inCloud: 1, airspeed: 250 });
  assert.ok(cloud.rateSmall > 0 && cloud.rateBig === 0 && cloud.fogTarget > 0);
  const rain = waterDrivers({ rain: 1, airspeed: 250 });
  assert.ok(rain.rateBig > 0);
  assert.ok(waterDrivers({ rain: 1, airspeed: 250, surface: 'canopy' }).rateBig < rain.rateBig);
  const none = waterDrivers({ rain: 1, inCloud: 1, surface: 'none' });
  assert.equal(none.rateSmall + none.rateBig + none.fogTarget, 0);
});

test('screen water: airflow sweeps, stick and drying follow speed and humidity', () => {
  const slow = waterDrivers({ rain: 1, airspeed: 20 });
  const fast = waterDrivers({ rain: 1, airspeed: 300 });
  assert.equal(slow.flow, 0);
  assert.equal(fast.flow, 1);
  assert.ok(slow.stick > fast.stick);
  assert.ok(waterDrivers({ airspeed: 200 }).evap > waterDrivers({ inCloud: 1, airspeed: 200 }).evap);
  assert.ok(fast.wipe > slow.wipe);
});

test('frost: only in cloud, only high and cold', () => {
  assert.equal(waterDrivers({ inCloud: 1, altitude: 3000 }).frost, 0);
  assert.equal(waterDrivers({ inCloud: 0, altitude: 9000 }).frost, 0);
  assert.equal(waterDrivers({ inCloud: 1, altitude: 9000 }).frost, 1);
});

test('rainFrom: override > weather owner > env.rain > storm heuristic under the base', () => {
  const storm = { preset: 'storm', presets: { storm: { storm: 1 } }, clouds: { u: { base: { value: 5000 } } } };
  assert.equal(rainFrom(storm, 2000, { rain: 0.3 }), 0.3);
  assert.equal(rainFrom({ ...storm, weather: { rain: 0.6 } }, 2000), 0.6);
  assert.equal(rainFrom({ rain: 0.4 }, 2000), 0.4);
  assert.equal(rainFrom(storm, 2000), 1);
  assert.equal(rainFrom(storm, 6000), 0);
  assert.equal(rainFrom({ preset: 'default', presets: { default: {} } }, 2000), 0);
  assert.equal(rainFrom(null, 0), 0);
});

test('god rays: overlapping emitter footprints do not depend on sub-pixel alignment', async () => {
  const { emitterTaps, footprintEmission, emitterBlend, EMITTER_BLEND, rayMarchLod, rayTapShare } = await import('./post/godRayMath.js');
  // sixteen taps, each on a source-pixel corner (odd multiples of half a pixel = scale / 2 mask texels)
  const taps = emitterTaps(0.25);
  assert.equal(taps.length, 16);
  for (const [x, y] of taps) {
    for (const v of [x, y]) {
      const px = v / 0.25; // source pixels from the texel centre
      assert.ok(Math.abs(px - Math.round(px)) < 1e-9, `tap ${v} is not on a pixel corner`);
      assert.ok(Math.abs(v) <= 0.5 + 1e-9);
    }
  }
  // a two-pixel feature far brighter than the cap, at two alignments
  const row = (at) => { const r = new Array(12).fill(0); r[at] = 5000; r[at + 1] = 5000; return r; };
  const cap = 4, floor = 1;
  // side by side (the old mask): one footprint or two, a factor of 2 between frames
  assert.equal(footprintEmission(row(4), 2, floor, cap), cap);
  assert.equal(footprintEmission(row(5), 2, floor, cap), 2 * cap);
  // overlapping: the same either way, and equal to the old average
  const a = footprintEmission(row(4), 1, floor, cap), b = footprintEmission(row(5), 1, floor, cap);
  assert.equal(a, b);
  assert.equal(a, 1.5 * cap);
  // accumulation: restart replaces, otherwise the fixed blend
  assert.equal(emitterBlend(true), 1);
  assert.equal(emitterBlend(false), EMITTER_BLEND);
});

test('god rays: reading the mask at the step-length mip collects every emitter along the ray', async () => {
  const { rayMarchLod, rayTapShare } = await import('./post/godRayMath.js');
  assert.equal(rayMarchLod(0.3), 0);
  assert.equal(rayMarchLod(4), 2);
  const step = 4;
  const shares = (lod) => [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875].map((ph) => rayTapShare(step, ph, lod));
  // level 0: a tap hits the emitter or steps over it
  const s0 = shares(0);
  assert.equal(Math.max(...s0), 1);
  assert.equal(Math.min(...s0), 0);
  // matching level: the true share 1 / step wherever the emitter sits
  for (const s of shares(rayMarchLod(step))) assert.ok(Math.abs(s - 1 / step) < 1e-12);
});
