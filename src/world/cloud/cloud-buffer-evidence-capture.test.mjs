import assert from 'node:assert/strict';
import test from 'node:test';

import { captureFrozenCloudCompositeEvidence } from './CloudBufferEvidenceCapture.js';

test('frozen composite evidence preserves the raw output identity and cloud frame', () => {
  const outputBuffer = { name: 'resolved-history' };
  const calls = [];
  const state = { outputBuffer, cloudFrame: 241 };
  const evidence = captureFrozenCloudCompositeEvidence({
    rawReadback: { status: 'MEASURED', pixels: new Uint8Array([1, 2, 3, 4]) },
    getCloudState: () => ({ ...state }),
    installCompositePass() { calls.push('install-composite'); },
    renderComposite() { calls.push('render-composite'); },
    captureComposite() {
      calls.push('capture-composite');
      return { width: 1, height: 1, pixels: new Uint8Array([5, 6, 7, 8]) };
    },
    restoreRawPass() { calls.push('restore-raw'); },
  });

  assert.strictEqual(evidence.rawState.outputBuffer, outputBuffer);
  assert.strictEqual(evidence.compositeState.outputBuffer, outputBuffer);
  assert.equal(evidence.evidence.sameOutputBufferIdentity, true);
  assert.equal(evidence.evidence.sameCloudFrame, true);
  assert.equal(evidence.evidence.diagnosticCloudUpdates, 0);
  assert.deepEqual(calls, [
    'install-composite', 'render-composite', 'capture-composite', 'restore-raw',
  ]);
});

test('frozen composite evidence reports a state mismatch instead of validating overlap', () => {
  const first = { name: 'first' };
  const second = { name: 'second' };
  let capture = false;
  const evidence = captureFrozenCloudCompositeEvidence({
    rawReadback: { status: 'MEASURED' },
    getCloudState: () => capture
      ? { outputBuffer: second, cloudFrame: 8 }
      : { outputBuffer: first, cloudFrame: 7 },
    installCompositePass() {},
    renderComposite() { capture = true; },
    captureComposite: () => ({ width: 1, height: 1, pixels: new Uint8Array(4) }),
    restoreRawPass() {},
  });

  assert.equal(evidence.evidence.sameOutputBufferIdentity, false);
  assert.equal(evidence.evidence.sameCloudFrame, false);
  assert.equal(evidence.evidence.diagnosticCloudUpdates, null);
});
