import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { terrainHeight } from '../heightfield.js';
import {
  LakeField,
  LAKE_SPACING,
  LAKE_SURFACE_SEGMENTS,
  lakeInCell,
  lakeRadiusAt,
} from '../lakes.js';
import {
  Water,
  WATER_QUALITY,
  beerLambertSample,
  dielectricFresnel,
  gerstnerSample,
  schlickFresnel,
} from '../Water.js';
import { WATER_FRAGMENT_SHADER, WATER_VERTEX_SHADER } from '../water.glsl.js';

const harnessSource = await readFile(new URL('./harness.html', import.meta.url), 'utf8');

function pointInTriangle2D(x, z, a, b, c) {
  const v0x = c[0] - a[0];
  const v0z = c[1] - a[1];
  const v1x = b[0] - a[0];
  const v1z = b[1] - a[1];
  const v2x = x - a[0];
  const v2z = z - a[1];
  const d00 = v0x * v0x + v0z * v0z;
  const d01 = v0x * v1x + v0z * v1z;
  const d11 = v1x * v1x + v1z * v1z;
  const d20 = v2x * v0x + v2z * v0z;
  const d21 = v2x * v1x + v2z * v1z;
  const denominator = d00 * d11 - d01 * d01;
  const v = (d11 * d20 - d01 * d21) / denominator;
  const w = (d00 * d21 - d01 * d20) / denominator;
  const u = 1 - v - w;
  return u >= -1e-7 && v >= -1e-7 && w >= -1e-7 &&
    a[2] * u + b[2] * v + c[2] * w > 0.025;
}

function renderedAt(water, x, z) {
  const positions = water.geometry.attributes.position;
  const depths = water.geometry.attributes.aDepth;
  const indices = water.geometry.index;
  for (let offset = 0; offset < water.geometry.drawRange.count; offset += 3) {
    const ia = indices.getX(offset);
    const ib = indices.getX(offset + 1);
    const ic = indices.getX(offset + 2);
    if (
      pointInTriangle2D(
        x,
        z,
        [positions.getX(ia), positions.getZ(ia), depths.getX(ia)],
        [positions.getX(ib), positions.getZ(ib), depths.getX(ib)],
        [positions.getX(ic), positions.getZ(ic), depths.getX(ic)],
      )
    ) return true;
  }
  return false;
}

{
  const a = lakeInCell(-1, -10);
  const b = lakeInCell(-1, -10);
  assert.ok(a && b, 'known deterministic basin should produce a lake');
  assert.deepEqual(
    [a.x, a.z, a.floor, a.level, ...a.radii],
    [b.x, b.z, b.floor, b.level, ...b.radii],
    'lake placement and outline must be bit-deterministic',
  );
  const midAngle = Math.PI / 16;
  const radius = lakeRadiusAt(a, Math.cos(midAngle), Math.sin(midAngle));
  assert.ok(radius <= Math.min(a.radii[0], a.radii[1]), 'outline interpolation must remain basin-conservative');
  for (let bearing = 0; bearing < 16; bearing++) {
    const angle = (bearing / 16) * Math.PI * 2;
    const before = lakeRadiusAt(a, Math.cos(angle - 1e-5), Math.sin(angle - 1e-5));
    const after = lakeRadiusAt(a, Math.cos(angle + 1e-5), Math.sin(angle + 1e-5));
    assert.ok(Math.abs(before - after) < 0.1, 'dense shoreline polygon must not jump at survey bearings');
  }
}

{
  const f0 = schlickFresnel(1, 1, 1.33);
  assert.ok(Math.abs(f0 - 0.02006) < 1e-4, 'water normal-incidence Fresnel should be about two percent');
  assert.ok(schlickFresnel(0.05, 1, 1.33) > 0.75, 'grazing water must become strongly reflective');
  assert.ok(Math.abs(dielectricFresnel(1, 1, 1.33) - f0) < 1e-8, 'exact Fresnel must preserve normal-incidence F0');
  assert.ok(
    Math.abs(dielectricFresnel(0.5, 1, 1.33) - 0.0591256) < 1e-5,
    'exact dielectric Fresnel must match the unpolarised reference at sixty degrees',
  );

  const refracted = [0.72, 0.82, 0.9];
  assert.deepEqual(beerLambertSample(refracted, 0), refracted, 'zero path length should not absorb refraction');
  const deep = beerLambertSample(refracted, 30);
  assert.ok(deep[0] < deep[1] && deep[1] < deep[2], 'depth absorption should produce glacial blue-green transmission');
  assert.ok(deep.every((channel) => channel >= 0 && channel <= 1), 'absorption must remain energy bounded');
}

{
  const sample = gerstnerSample(1200, -800, 7.5, 5);
  const repeat = gerstnerSample(1200, -800, 7.5, 5);
  assert.deepEqual(sample, repeat, 'wave field must be deterministic in world coordinates');
  assert.ok(Math.abs(new THREE.Vector3(...sample.normal).length() - 1) < 1e-6, 'analytic wave normal must be unit length');
  assert.ok(Math.abs(sample.height) < 0.5, 'lake displacement must remain below shoreline freeboard');
  assert.ok(Math.hypot(...sample.horizontal) > 1e-4, 'Gerstner waves must displace horizontally as well as vertically');
}

{
  assert.equal(WATER_QUALITY.high.waveCount, 6);
  assert.equal(WATER_QUALITY.phone.waveCount, 2);
  assert.equal(WATER_QUALITY.phone.refraction, false);
  assert.ok(WATER_QUALITY.high.maxLakes > WATER_QUALITY.low.maxLakes);
}

{
  const lake = lakeInCell(-1, -10);
  const field = {
    active: [lake],
    activeCount: 1,
    version: 1,
    update() {},
    prune() {},
  };
  const environment = {
    uniforms: {
      uSunDir: { value: new THREE.Vector3(0.5, 0.7, 0.3).normalize() },
      uSunColor: { value: new THREE.Color(1, 0.94, 0.84) },
      uZenithColor: { value: new THREE.Color(0.03, 0.09, 0.3) },
      uHorizonColor: { value: new THREE.Color(0.56, 0.68, 0.85) },
      uTime: { value: 0 },
    },
  };
  const water = new Water(null, environment, { field, quality: 'high' });
  water.update(0, new THREE.Vector3(lake.x, lake.level + 100, lake.z));
  assert.equal(water.visibleLakeCount, 1);
  assert.ok(water.geometry.drawRange.count > 0, 'active lake must populate the shared batch');
  const indices = water.geometry.index;
  const positions = water.geometry.attributes.position;
  const a = new THREE.Vector3().fromBufferAttribute(positions, indices.getX(0));
  const b = new THREE.Vector3().fromBufferAttribute(positions, indices.getX(1));
  const c = new THREE.Vector3().fromBufferAttribute(positions, indices.getX(2));
  const upward = new THREE.Vector3().crossVectors(b.sub(a), c.sub(a)).y;
  assert.ok(upward > 0, 'water triangles must face upward for default back-face culling');
  const depthAttribute = water.geometry.attributes.aDepth;
  const surfaceSegments = LAKE_SURFACE_SEGMENTS;
  const outerStart = water.geometry.userData.outerRingStart;
  for (let i = outerStart; i < outerStart + surfaceSegments; i++) {
    assert.equal(depthAttribute.getX(i), 0, 'outer lake ring must terminate at zero depth');
    const dx = positions.getX(i) - lake.x;
    const dz = positions.getZ(i) - lake.z;
    assert.ok(
      Math.abs(Math.hypot(dx, dz) - lakeRadiusAt(lake, dx, dz)) < 0.02,
      'every rendered boundary vertex must lie on the exact collision polygon',
    );
  }
  const outerX = positions.getX(outerStart);
  const outerZ = positions.getZ(outerStart);
  const outerDx = outerX - lake.x;
  const outerDz = outerZ - lake.z;
  assert.ok(
    Math.abs(Math.hypot(outerDx, outerDz) - lakeRadiusAt(lake, outerDx, outerDz)) < 0.02,
    'batch boundary must use the same conservative radius rule as collision queries',
  );

  // Exhaust every emitted triangle at vertices, edge midpoints and centroid.
  let outside = 0;
  let dry = 0;
  for (let offset = 0; offset < water.geometry.drawRange.count; offset += 3) {
    const ids = [indices.getX(offset), indices.getX(offset + 1), indices.getX(offset + 2)];
    for (let row = 0; row <= 8; row++) {
      for (let column = 0; column <= 8 - row; column++) {
        const wb = column / 8;
        const wc = row / 8;
        const wa = 1 - wb - wc;
        const x = positions.getX(ids[0]) * wa + positions.getX(ids[1]) * wb + positions.getX(ids[2]) * wc;
        const z = positions.getZ(ids[0]) * wa + positions.getZ(ids[1]) * wb + positions.getZ(ids[2]) * wc;
        const dx = x - lake.x;
        const dz = z - lake.z;
        if (Math.hypot(dx, dz) > lakeRadiusAt(lake, dx, dz) + 0.03) outside++;
        if (terrainHeight(x, z) >= lake.level - 0.03) dry++;
      }
    }
  }
  assert.equal(outside, 0, 'no rendered triangle sample may extend outside collision');
  assert.equal(dry, 0, 'no rendered triangle sample may paint water over dry terrain');

  const color = new THREE.Texture();
  const depth = new THREE.DepthTexture();
  water.setRefractionSource({ colorTexture: color, depthTexture: depth, width: 1920, height: 1080, near: 4, far: 750000 });
  assert.equal(water.hasRefraction, true);
  water.clearRefractionSource();
  assert.equal(water.hasRefraction, false);

  const cachedMesh = water._lakeMeshes.get(lake);
  assert.ok(cachedMesh, 'terrain-safe tessellation should be cached per deterministic lake record');
  field.version++;
  water.update(0, new THREE.Vector3(lake.x, lake.level + 100, lake.z));
  assert.equal(water._lakeMeshes.get(lake), cachedMesh, 'unchanged lakes must not repeat terrain tessellation');

  const oldGeometry = water.geometry;
  const oldMaterial = water.material;
  let geometryDisposed = false;
  let materialDisposed = false;
  oldGeometry.addEventListener('dispose', () => { geometryDisposed = true; });
  oldMaterial.addEventListener('dispose', () => { materialDisposed = true; });
  water.setQuality('phone');
  assert.equal(water.quality, 'phone');
  assert.equal(water.material.defines.WATER_WAVES, 2);
  assert.equal(water.material.defines.WATER_REFRACTION, 0);
  assert.ok(geometryDisposed && materialDisposed, 'tier replacement must release old GPU resources');
  assert.throws(() => water.setQuality('ultra'), /Unknown water quality/);
  water.dispose();
}

{
  // CPU collision and the submitted topology are one contract. The half-metre
  // allowance applies only to samples straddling the finite shoreline polygon;
  // internal terrain shoulders and genuinely wet cells receive no tolerance.
  const fixtures = [];
  for (let iz = -24; iz <= 24 && fixtures.length < 3; iz++) {
    for (let ix = -24; ix <= 24 && fixtures.length < 3; ix++) {
      const lake = lakeInCell(ix, iz);
      if (lake) fixtures.push({ ix, iz, lake });
    }
  }
  assert.equal(fixtures.length, 3);
  const environment = { uniforms: { uTime: { value: 0 } } };
  for (const quality of ['high', 'low', 'phone']) {
    for (const { ix, iz, lake } of fixtures) {
      const field = new LakeField(WATER_QUALITY[quality]);
      field.cells.set(field._key(ix, iz), lake);
      field.active[0] = lake;
      field.activeCount = 1;
      field.version = 1;
      field.update = () => 0;
      field.prune = () => 0;
      const water = new Water(null, environment, { field, quality });
      water.update(0, new THREE.Vector3(lake.x, lake.level + 100, lake.z));
      assert.equal(
        water.waterDepthAt(lake.x, lake.z) > 0,
        renderedAt(water, lake.x, lake.z),
        `${quality} centre query must share the rendered fan topology`,
      );
      for (let segment = 0; segment < LAKE_SURFACE_SEGMENTS; segment += 8) {
        const angle = (segment / LAKE_SURFACE_SEGMENTS) * Math.PI * 2;
        const boundary = lakeRadiusAt(lake, Math.cos(angle), Math.sin(angle));
        const x = lake.x + Math.cos(angle) * boundary * 0.99999;
        const z = lake.z + Math.sin(angle) * boundary * 0.99999;
        assert.equal(
          water.waterDepthAt(x, z) > 0,
          renderedAt(water, x, z),
          `${quality} shoreline query must include the fragment depth cutoff`,
        );
      }

      let collisionWithoutRender = 0;
      let renderWithoutCollision = 0;
      let renderedOutside = 0;
      let renderedDry = 0;
      const samples = 36;
      for (let row = 0; row < samples; row++) {
        for (let column = 0; column < samples; column++) {
          const x = lake.x - lake.rMax + ((column + 0.5) / samples) * lake.rMax * 2;
          const z = lake.z - lake.rMax + ((row + 0.5) / samples) * lake.rMax * 2;
          const dx = x - lake.x;
          const dz = z - lake.z;
          const distance = Math.hypot(dx, dz);
          const shorelineGap = lakeRadiusAt(lake, dx, dz) - distance;
          const terrainClearance = lake.level - terrainHeight(x, z);
          const rendered = renderedAt(water, x, z);
          const collision = water.waterDepthAt(x, z) > 0;
          if (collision && !rendered && shorelineGap > 0.5) collisionWithoutRender++;
          if (rendered && !collision && Math.abs(shorelineGap) > 0.5) renderWithoutCollision++;
          if (rendered && shorelineGap < -0.5) renderedOutside++;
          if (rendered && terrainClearance < -0.5) renderedDry++;
        }
      }
      assert.equal(collisionWithoutRender, 0, `${quality} collision must not cover omitted water cells`);
      assert.equal(renderWithoutCollision, 0, `${quality} rendered water must have collision coverage`);
      assert.equal(renderedOutside, 0, `${quality} topology must remain inside the shoreline`);
      assert.equal(renderedDry, 0, `${quality} topology must remain below terrain`);
      water.dispose();
      field.dispose();
    }
  }
}

{
  const environment = {
    uniforms: {
      uSunDir: { value: new THREE.Vector3(0.5, 0.7, 0.3).normalize() },
      uSunColor: { value: new THREE.Color(1, 0.94, 0.84) },
      uZenithColor: { value: new THREE.Color(0.03, 0.09, 0.3) },
      uHorizonColor: { value: new THREE.Color(0.56, 0.68, 0.85) },
      uTime: { value: 0 },
    },
  };
  const water = new Water(null, environment, { quality: 'phone' });
  water.setQuality('high');
  assert.equal(water.field._span, Math.ceil(WATER_QUALITY.high.drawDistance / LAKE_SPACING));
  assert.equal(water.field._offsets.length / 2, (water.field._span * 2 + 1) ** 2);
  assert.equal(water.field.radialRings, WATER_QUALITY.high.radialRings);
  water.setQuality('phone');
  assert.equal(water.field._span, Math.ceil(WATER_QUALITY.phone.drawDistance / LAKE_SPACING));
  assert.equal(water.field._offsets.length / 2, (water.field._span * 2 + 1) ** 2);
  assert.equal(water.field.radialRings, WATER_QUALITY.phone.radialRings);
  water.dispose();
}

{
  // Population probe: a single friendly basin is not enough to validate the
  // radial tessellator. These first sixteen deterministic lakes include narrow
  // saddles, central shoulders and sub-cell terrain spikes that previously
  // slipped between otherwise-wet triangle vertices.
  const lakes = [];
  for (let iz = -22; iz <= 22 && lakes.length < 16; iz++) {
    for (let ix = -22; ix <= 22 && lakes.length < 16; ix++) {
      const lake = lakeInCell(ix, iz);
      if (lake) lakes.push(lake);
    }
  }
  assert.equal(lakes.length, 16, 'population fixture must retain sixteen deterministic lakes');
  const field = {
    active: lakes,
    activeCount: lakes.length,
    version: 1,
    update() {},
    prune() {},
  };
  const water = new Water(null, { uniforms: { uTime: { value: 0 } } }, { field, quality: 'high' });
  water.update(0, new THREE.Vector3());
  const indices = water.geometry.index;
  const positions = water.geometry.attributes.position;
  const verticesPerLake = water.geometry.userData.verticesPerLake;
  let outside = 0;
  let dry = 0;
  for (let offset = 0; offset < water.geometry.drawRange.count; offset += 3) {
    const ids = [indices.getX(offset), indices.getX(offset + 1), indices.getX(offset + 2)];
    const lake = lakes[Math.floor(ids[0] / verticesPerLake)];
    for (let row = 0; row <= 8; row++) {
      for (let column = 0; column <= 8 - row; column++) {
        const wb = column / 8;
        const wc = row / 8;
        const wa = 1 - wb - wc;
        const x = positions.getX(ids[0]) * wa + positions.getX(ids[1]) * wb + positions.getX(ids[2]) * wc;
        const z = positions.getZ(ids[0]) * wa + positions.getZ(ids[1]) * wb + positions.getZ(ids[2]) * wc;
        const dx = x - lake.x;
        const dz = z - lake.z;
        if (Math.hypot(dx, dz) > lakeRadiusAt(lake, dx, dz) + 0.03) outside++;
        if (terrainHeight(x, z) >= lake.level - 0.03) dry++;
      }
    }
  }
  assert.equal(outside, 0, 'population triangles must remain inside the exact collision outline');
  assert.equal(dry, 0, 'population triangles must not bridge dry terrain spikes');
  water.dispose();
}

{
  assert.match(WATER_VERTEX_SHADER, /horizontal/, 'vertex shader must apply horizontal Gerstner displacement');
  assert.match(WATER_FRAGMENT_SHADER, /dielectricFresnel/, 'high-tier shader must provide exact dielectric Fresnel');
  assert.match(WATER_FRAGMENT_SHADER, /mat3\(viewMatrix\)/, 'refraction direction must be transformed into view space');
  assert.match(WATER_FRAGMENT_SHADER, /fwidth/, 'subpixel water detail must use derivative filtering');
  assert.match(WATER_FRAGMENT_SHADER, /0\.017/, 'high tier needs a true gravity-capillary crossover band');
  assert.match(WATER_FRAGMENT_SHADER, /capillaryWeight/, 'capillary normals must fade by derivative footprint');
  assert.match(WATER_FRAGMENT_SHADER, /voronoiEdge/, 'caustics must use a cellular edge distance');
  assert.match(WATER_FRAGMENT_SHADER, /min\(causticA, causticB\)/, 'dual caustic layers must combine conservatively');
  assert.match(WATER_FRAGMENT_SHADER, /validRefraction/, 'foreground depth rejection must gate refracted colour');
}

{
  const allocationGuard = harnessSource.match(
    /if \(water\.profile\.refraction\) \{([\s\S]*?)\n  \}/,
  )?.[1] ?? '';
  assert.match(allocationGuard, /new THREE\.WebGLRenderTarget\(/, 'only refraction tiers may allocate a target');
  assert.match(
    harnessSource,
    /if \(target\) \{[\s\S]*?target\.setSize\(/,
    'resize must not touch an absent low/phone target',
  );
  assert.match(
    harnessSource,
    /if \(target\) \{[\s\S]*?renderer\.setRenderTarget\(target\)/,
    'render loop must skip the refraction prepass without a target',
  );
  assert.match(harnessSource, /new THREE\.Timer\(\)/, 'harness animation must retain Three Timer timing');
}

{
  const field = new LakeField({ drawDistance: 4000, maxLakes: 4 });
  field.update(-1293, -23713, 4);
  field.clear();
  assert.equal(field.cells.size, 0);
  assert.equal(field.activeCount, 0);
}

console.log('water contracts passed');
