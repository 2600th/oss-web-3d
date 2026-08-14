/**
 * Captures a final composite from an already-resolved cloud buffer. The caller
 * installs an aerial-only pass, so the CloudsEffect is never updated between
 * raw readback and composite capture.
 */
export function captureFrozenCloudCompositeEvidence({
  rawReadback,
  getCloudState,
  installCompositePass,
  renderComposite,
  captureComposite,
  restoreRawPass,
}) {
  const rawState = getCloudState();
  let finalComposite;
  let compositeState;
  let restoredDiagnosticRenders = 0;
  let installed = false;
  try {
    installCompositePass();
    installed = true;
    renderComposite();
    finalComposite = captureComposite();
    compositeState = getCloudState();
  } finally {
    if (installed) restoredDiagnosticRenders = restoreRawPass() ?? 0;
  }
  const sameOutputBufferIdentity = rawState.outputBuffer === compositeState.outputBuffer;
  const sameCloudFrame = rawState.cloudFrame === compositeState.cloudFrame;
  return {
    rawReadback,
    finalComposite,
    rawState,
    compositeState,
    evidence: {
      sameOutputBufferIdentity,
      sameCloudFrame,
      diagnosticCloudUpdates: sameCloudFrame ? 0 : null,
      diagnosticRenders: 1 + restoredDiagnosticRenders,
    },
  };
}
