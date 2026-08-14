import assert from 'node:assert/strict';
import test from 'node:test';
import { DataUtils, HalfFloatType } from 'three';

import {
  assessRawCloudDiagnosticEligibility,
  measureCloudBufferPixels,
  readCloudOutputBuffer,
} from './CloudBufferDiagnostics.js';

test('half-float readback decodes a positively validated output target', () => {
  const output = { type: HalfFloatType };
  const target = { width: 1, height: 1, texture: output };
  const renderer = {
    getContext: () => ({ NO_ERROR: 0, getError: () => 0 }),
    readRenderTargetPixels(actualTarget, _x, _y, _width, _height, pixels) {
      assert.strictEqual(actualTarget, target);
      pixels.set([
        DataUtils.toHalfFloat(0.1), DataUtils.toHalfFloat(0.2),
        DataUtils.toHalfFloat(0.3), DataUtils.toHalfFloat(0.4),
      ]);
    },
  };
  const readback = readCloudOutputBuffer(renderer, {
    cloudsPass: { outputBuffer: output, historyRenderTarget: target },
  });

  assert.equal(readback.status, 'MEASURED');
  assert.ok(Math.abs(readback.pixels[3] - 0.4) < 0.001);
});

test('silent readback returns UNVERIFIED rather than treating an unwritten buffer as empty cloud alpha', () => {
  const output = { type: HalfFloatType };
  const target = { width: 1, height: 1, texture: output };
  const renderer = {
    getContext: () => ({ NO_ERROR: 0, getError: () => 0 }),
    readRenderTargetPixels() {},
  };
  const readback = readCloudOutputBuffer(renderer, {
    cloudsPass: { outputBuffer: output, historyRenderTarget: target },
  });

  assert.deepEqual(readback, {
    status: 'UNVERIFIED',
    reason: 'cloud-buffer-readback-no-buffer-write',
  });
});

test('raw metrics and eligibility retain fixed thresholds and reject mismatched evidence', () => {
  const metrics = measureCloudBufferPixels({
    pixels: new Uint8Array([0, 0, 0, 255]), width: 1, height: 1,
  });
  const eligibility = assessRawCloudDiagnosticEligibility({
    cloudAssetMode: 'official-pinned',
    stbnMode: 'official-pinned',
    nearestLayerBoundaryDistance: 750,
    rawMetrics: metrics,
    captureEvidence: { sameOutputBufferIdentity: false, sameCloudFrame: true },
  });

  assert.equal(metrics.alphaThreshold, 0.05);
  assert.deepEqual(eligibility, {
    eligible: false,
    reason: 'cloud-buffer-state-mismatch',
    reasons: ['cloud-buffer-state-mismatch'],
  });
});

test('raw diagnostics reject a missing or invalid official STBN volume', () => {
  const metrics = measureCloudBufferPixels({
    pixels: new Uint8Array([0, 0, 0, 255]), width: 1, height: 1,
  });

  assert.deepEqual(assessRawCloudDiagnosticEligibility({
    cloudAssetMode: 'official-pinned',
    stbnMode: 'fallback-unverified',
    nearestLayerBoundaryDistance: 750,
    rawMetrics: metrics,
  }), {
    eligible: false,
    reason: 'official-stbn-unavailable',
    reasons: ['official-stbn-unavailable'],
  });
});
