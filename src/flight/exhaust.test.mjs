import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('./Aircraft.js', import.meta.url), 'utf8');

/**
 * The afterburner plume, as a shape contract.
 *
 * It is three additive cylinders, and the two ways it goes wrong are both
 * silent and both look nothing like a flame:
 *
 *   - With no view-dependent falloff across the tube, the silhouette is a hard
 *     line and the plume renders as a flat translucent plank sticking out of
 *     the tail. It has to fade toward its own silhouette, which is |dot(N, V)|.
 * *   - With the chord squared, the bright band narrows and the mean alpha drops
 *     far enough that the burner looks weak. The plume's *length* is not a bug
 *     — lighting the burner is meant to be dramatic — so this file pins the
 *     shading, not the scale.
 */
test('the plume fades toward its silhouette rather than ending on a hard edge', () => {
  assert.match(
    source,
    /float chord = abs\(dot\(normal, normalize\(vViewDir\)\)\)/,
    'plume alpha must fall off with the view-relative chord through the tube',
  );
  assert.match(source, /vViewNormal = normalMatrix \* normal/, 'the plume needs a view-space normal');
  assert.match(source, /alpha = axial \* cell \* chord \* uOpacity/, 'the chord must reach the alpha');
  assert.doesNotMatch(
    source,
    /chord \*= chord/,
    'squaring the chord dims the plume without improving the silhouette',
  );
  // The old shader keyed its cross-tube term off the angular UV, which is fixed
  // to the geometry and cannot follow the camera.
  assert.doesNotMatch(
    source,
    /rim = mix\([\d.]+, [\d.]+, 1\.0 - abs\(vUv\.x \* 2\.0 - 1\.0\)\)/,
    'cross-tube shading must not come from the angular UV',
  );
});

test('the plume is hottest at the nozzle', () => {
  // sin(pi * v) peaks in the middle and is dark where the gas leaves the
  // engine, which is backwards for an afterburner.
  assert.doesNotMatch(source, /axial = sin\(3\.14159265 \* clamp\(vUv\.y/);
  assert.match(
    source,
    /axial = smoothstep\(0\.0, 0\.08, v\) \* \(1\.0 - v \* v\)/,
    'the plume must rise fast off the nozzle and hold brightness down the tube',
  );
});

test('the burner is a visible event and its diamonds sit inside the flame', () => {
  const peak = (name) => {
    const call = new RegExp(`this\.${name}\.scale\.set\(([^)]*)\)`).exec(source);
    assert.ok(call, `${name} must set a z scale`);
    const args = call[1].split(',');
    assert.equal(args.length, 3, `${name} scale must take three components`);
    // heat and reheat both reach 1 at full throttle.
    return Function('heat', 'reheat', `return ${args[2]};`)(1, 1);
  };
  const dry = (name) => {
    const call = new RegExp(`this\.${name}\.scale\.set\(([^)]*)\)`).exec(source);
    return Function('heat', 'reheat', `return ${call[1].split(',')[2]};`)(1, 0);
  };
  const lengths = {
    flameCore: 1.35 * peak('flameCore'),
    flameMid: 3.0 * peak('flameMid'),
    flameOuter: 5.15 * peak('flameOuter'),
  };
  // Reheat has to be worth reaching for: the plume must grow substantially
  // between full dry thrust and full burner, or the throttle has no payoff.
  assert.ok(
    1.35 * peak('flameCore') > 1.35 * dry('flameCore') * 1.5,
    'lighting the burner must visibly lengthen the core',
  );
  assert.ok(lengths.flameMid > 6, `the burner plume should read from the chase camera: ${lengths.flameMid.toFixed(1)} m`);

  // Shock diamonds have to sit inside the gas they are diamonds in.
  const spacing = /mesh\.position\.z = ([\d.]+) \+ i \* ([\d.]+)/.exec(source);
  assert.ok(spacing, 'shock diamonds must be placed along the plume');
  const lastDiamond = Number(spacing[1]) + 3 * Number(spacing[2]);
  assert.ok(
    lastDiamond < lengths.flameMid,
    `the last shock diamond sits at ${lastDiamond} m, past the ${lengths.flameMid.toFixed(2)} m plume`,
  );
});

console.log('exhaust plume contracts passed');
