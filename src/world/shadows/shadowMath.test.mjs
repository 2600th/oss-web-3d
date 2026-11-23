// Sun / moon shadow numbers: penumbra from the light's angular size, cascade
// splits, per-texel bias, tier configs, the cloud shadow path cap and the
// terrain sweep's reach.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SUN_ANGULAR_DIAMETER, MOON_ANGULAR_DIAMETER, penumbraSlope, penumbraWidth, umbraLength,
  cascadeSplits, SUN_SHADOW_TIERS, sunShadowConfig, texelWorld, cascadeBias, fallbackRadius,
  FALLBACK_SEPARATION, CLOUD_SHADOW_PATH, cloudShadowSpan, SWEEP_REACH, sweepReach,
} from './shadowMath.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

test('penumbra grows with distance at the sun angular size', () => {
  near(penumbraSlope(SUN_ANGULAR_DIAMETER), Math.tan((0.533 * Math.PI) / 360));
  // a caster 10 m above the ground: ~9.3 cm penumbra
  near(penumbraWidth(10), 0.0930, 1e-4);
  assert.equal(penumbraWidth(-3), 0);
  assert.ok(penumbraSlope(MOON_ANGULAR_DIAMETER) < penumbraSlope(SUN_ANGULAR_DIAMETER));
});

test('umbra of a thin caster vanishes ~107 widths away', () => {
  near(umbraLength(1) , 107.5, 0.1);
  // a 0.2 m mast: ~21 m; a 3 cm guy wire: ~3 m
  near(umbraLength(0.2), 21.5, 0.05);
  near(umbraLength(0.03), 3.22, 0.01);
  // at the umbra length the penumbra is exactly as wide as the caster
  near(penumbraWidth(umbraLength(0.2)), 0.2);
});

test('cascade splits are increasing, end at 1, and lie between uniform and log', () => {
  for (const [count, n, f, lambda] of [[2, 0.5, 260, 0.7], [3, 0.5, 520, 0.8], [4, 0.3, 900, 0.82]]) {
    const s = cascadeSplits(count, n, f, lambda);
    assert.equal(s.length, count);
    assert.equal(s[count - 1], 1);
    for (let i = 1; i < count; i++) assert.ok(s[i] > s[i - 1]);
    for (let i = 0; i < count - 1; i++) {
      const fr = (i + 1) / count;
      const uni = (n + (f - n) * fr) / f;
      const log = (n * (f / n) ** fr) / f;
      assert.ok(s[i] >= log - 1e-12 && s[i] <= uni + 1e-12);
    }
  }
  // fills and truncates the target array (CSMShadowNode reuses it)
  const target = [9, 9, 9, 9, 9, 9];
  assert.equal(cascadeSplits(3, 1, 100, 0.5, target), target);
  assert.equal(target.length, 3);
});

test('tier configs: PCSS on WebGPU only, Quality overrides apply', () => {
  const high = sunShadowConfig({ name: 'high' }, 'webgpu');
  assert.equal(high.pcss, true);
  assert.equal(high.cascades, SUN_SHADOW_TIERS.high.cascades);
  assert.equal(sunShadowConfig({ name: 'high' }, 'webgl2').pcss, false);
  assert.equal(sunShadowConfig({ name: 'low' }, 'webgpu').pcss, false);
  const o = sunShadowConfig({ name: 'medium', shadowCascades: 2, shadowMapSize: 1024 });
  assert.equal(o.cascades, 2);
  assert.equal(o.mapSize, 1024);
  assert.deepEqual(sunShadowConfig({ name: 'nope' }).far, SUN_SHADOW_TIERS.high.far);
  for (const t of Object.values(SUN_SHADOW_TIERS)) assert.ok(t.taps > 0);
});

test('bias scales with the cascade texel', () => {
  const t = texelWorld(60, 2048);
  near(t, 60 / 2048);
  const b = cascadeBias(t);
  near(b.normal, 1.5 * t);
  near(b.depth, 0.5 * t);
  assert.ok(cascadeBias(2 * t).normal > b.normal);
});

test('fallback disc radius is the penumbra half-width at the reference separation', () => {
  near(fallbackRadius(), FALLBACK_SEPARATION * penumbraSlope());
  assert.ok(fallbackRadius() > 0.1 && fallbackRadius() < 0.2);
});

test('cloud shadow span is capped at grazing sun', () => {
  // high sun: the whole layer, unchanged
  const hi = cloudShadowSpan(1500, 4500, 0.8, 0);
  near(hi.t0, 1875);
  near(hi.t1, 5625);
  near(hi.ds, (5625 - 1875) / 16);
  // 1 deg sun: the layer is 170 km of ray; only CLOUD_SHADOW_PATH of it is integrated
  const lo = cloudShadowSpan(1500, 4500, Math.sin(Math.PI / 180), 0);
  near(lo.t1 - lo.t0, CLOUD_SHADOW_PATH);
  near(lo.ds, CLOUD_SHADOW_PATH / 16);
  // sun below the horizon does not divide by zero
  assert.ok(Number.isFinite(cloudShadowSpan(1500, 4500, -0.1, 0).t1));
});

test('sweep reach: full near the ground, none where the 8-bit sweep saturates', () => {
  assert.equal(sweepReach(0), 1);
  assert.equal(sweepReach(SWEEP_REACH.full), 1);
  assert.equal(sweepReach(SWEEP_REACH.none), 0);
  assert.equal(sweepReach(500), 0);
  near(sweepReach((SWEEP_REACH.full + SWEEP_REACH.none) / 2), 0.5);
  let prev = 1;
  for (let a = 30; a <= 50; a += 0.5) { const r = sweepReach(a); assert.ok(r <= prev); prev = r; }
  assert.ok(SWEEP_REACH.none < 47.75);
});
