import assert from 'node:assert/strict';
import test from 'node:test';
import { NearestFilter, RGBAFormat, UnsignedByteType } from 'three';

import {
  configureDiagnosticDepth,
  describeCloudLifecycleResources,
  releaseReferenceRawDepthTexture,
} from './CloudComparisonHarness.js';
import { CloudLifecycleAuditor } from './CloudBenchmark.js';
import {
  REFERENCE_RAW_FULL_FAR_DEPTH_RESOURCE,
  createReferenceRawFullFarDepthTexture,
  describeReferenceRawFullFarDepthTexture,
} from './ReferenceRawDepthTexture.js';

function diagnosticRuntime({ view, scenario }) {
  const stableDepthTexture = { name: 'stable-scene-depth' };
  const calls = [];
  return {
    backendName: 'takram',
    view,
    scenario,
    engine: { composer: { stableDepthTexture } },
    backend: { setDepthTexture: texture => calls.push(texture) },
    _calls: calls,
    _stableDepthTexture: stableDepthTexture,
    referenceRawDepthTexture: null,
  };
}

test('reference raw diagnostics bind an owned full-far BasicDepthPacking depth texture', () => {
  const texture = createReferenceRawFullFarDepthTexture();
  const descriptor = describeReferenceRawFullFarDepthTexture(texture);

  assert.equal(texture.name, REFERENCE_RAW_FULL_FAR_DEPTH_RESOURCE);
  assert.deepEqual([...texture.image.data], [255, 255, 255, 255]);
  assert.equal(texture.image.width, 1);
  assert.equal(texture.image.height, 1);
  assert.equal(texture.format, RGBAFormat);
  assert.equal(texture.type, UnsignedByteType);
  assert.equal(texture.minFilter, NearestFilter);
  assert.equal(texture.magFilter, NearestFilter);
  assert.equal(texture.generateMipmaps, false);
  assert.deepEqual(descriptor, {
    name: REFERENCE_RAW_FULL_FAR_DEPTH_RESOURCE,
    kind: 'diagnostic-depth-texture',
    source: 'reference-raw-full-far-basic-depth',
    owner: 'comparison-harness',
    width: 1,
    height: 1,
    layers: 1,
    mipLevels: 1,
    samples: 1,
    attachments: 1,
    bytes: 4,
  });
});

test('reference raw uses full-far depth while Himalayan and composite diagnostics retain stable scene depth', () => {
  const referenceRaw = diagnosticRuntime({
    view: 'cloud-alpha',
    scenario: { name: 'reference-sky', terrainDepthPolicy: 'raw-diagnostic-bypass-only' },
  });
  configureDiagnosticDepth(referenceRaw);
  const fullFar = referenceRaw._calls.at(-1);
  assert.notEqual(fullFar, null);
  assert.strictEqual(fullFar, referenceRaw.referenceRawDepthTexture);
  assert.deepEqual([...fullFar.image.data], [255, 255, 255, 255]);
  configureDiagnosticDepth(referenceRaw);
  assert.strictEqual(referenceRaw._calls.at(-1), fullFar);

  const himalayanRaw = diagnosticRuntime({
    view: 'cloud-alpha',
    scenario: { name: 'himalayan-opening', terrainDepthPolicy: 'preserve-terrain-depth' },
  });
  configureDiagnosticDepth(himalayanRaw);
  assert.strictEqual(himalayanRaw._calls.at(-1), himalayanRaw._stableDepthTexture);
  assert.equal(himalayanRaw.referenceRawDepthTexture, null);

  const referenceComposite = diagnosticRuntime({
    view: 'composite',
    scenario: { name: 'reference-sky', terrainDepthPolicy: 'raw-diagnostic-bypass-only' },
  });
  configureDiagnosticDepth(referenceComposite);
  assert.strictEqual(referenceComposite._calls.at(-1), referenceComposite._stableDepthTexture);
  assert.equal(referenceComposite.referenceRawDepthTexture, null);
});

test('owned full-far depth is reported and disposed exactly once across context restoration', () => {
  const runtime = diagnosticRuntime({
    view: 'cloud-color',
    scenario: { name: 'reference-sky', terrainDepthPolicy: 'raw-diagnostic-bypass-only' },
  });
  configureDiagnosticDepth(runtime);
  const first = runtime.referenceRawDepthTexture;
  let firstDisposals = 0;
  first.addEventListener('dispose', () => { firstDisposals += 1; });
  const audit = new CloudLifecycleAuditor(() => describeCloudLifecycleResources(runtime));

  assert.deepEqual(describeCloudLifecycleResources(runtime).map(item => item.key), [
    'reference-raw-full-far-depth',
  ]);
  audit.begin('context-restore');
  releaseReferenceRawDepthTexture(runtime);
  assert.equal(firstDisposals, 1);
  configureDiagnosticDepth(runtime);
  const second = runtime.referenceRawDepthTexture;
  let secondDisposals = 0;
  second.addEventListener('dispose', () => { secondDisposals += 1; });
  audit.markReset('context-restore-recreated');
  audit.completeMutation();
  assert.deepEqual(audit.beforeRender().recreatedKeys, ['reference-raw-full-far-depth']);

  releaseReferenceRawDepthTexture(runtime);
  releaseReferenceRawDepthTexture(runtime);
  assert.equal(secondDisposals, 1);
  audit.dispose();
  audit.dispose();
});
