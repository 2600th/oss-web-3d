export const CLOUD_RENDERER_METHODS = Object.freeze([
  'setSize',
  'setQuality',
  'setDepthTexture',
  'update',
  'resetHistory',
  'getShadowOutput',
  'getResourceReport',
  'dispose',
]);

export function assertCloudRendererBackend(value) {
  for (const method of CLOUD_RENDERER_METHODS) {
    if (typeof value?.[method] !== 'function') {
      throw new TypeError(`Cloud renderer backend is missing required method: ${method}`);
    }
  }
  return value;
}
