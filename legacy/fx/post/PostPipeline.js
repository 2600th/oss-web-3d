/** Make output ownership explicit; disabled passes never inherit the canvas. */
export function configureFinalOutput(passes, finalPass, target = null) {
  for (const pass of passes) pass.renderToScreen = false;
  finalPass.enabled = true;
  finalPass.outputTarget = target;
  finalPass.renderToScreen = target === null;
}

export function setPassEnabled(pass, enabled) {
  pass.enabled = Boolean(enabled);
}

export function normalizeRenderOptions(cameraOrOptions, defaults) {
  if (cameraOrOptions?.isCamera) return { ...defaults, camera: cameraOrOptions };
  return { ...defaults, ...(cameraOrOptions ?? {}) };
}
